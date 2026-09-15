import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function equal(actual, expected) {
  const a=Buffer.from(typeof actual==='string'?actual:'');
  const b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
}

export function resolveConnectDestination(authority) {
  if (authority==='api.telegram.org:443') return {host:'api.telegram.org',port:443,timeout:120000};
  if (authority==='openrouter.ai:443') return {host:'openrouter.ai',port:443,timeout:360000};
  return null;
}

// Infrastructure only: no Telegram parsing, storage, retries or application identity.
export function createRelay(config) {
  const proxyAuth='Basic '+Buffer.from('osinara:'+config.proxyPassword).toString('base64');
  const upstreamFetch=config.fetch ?? fetch;
  const server=http.createServer(async (req,res) => {
    if(req.method==='GET' && req.url==='/healthz') { res.end('ok');return; }
    if(req.method!=='POST' || req.url!=='/eve/v1/telegram') {res.writeHead(404).end();return;}
    if(!equal(req.headers['x-telegram-bot-api-secret-token'],config.webhookSecret)) {
      res.writeHead(401).end();return;
    }
    try {
      let size=0;const chunks=[];
      for await (const chunk of req) {
        size+=chunk.length;
        if(size>1048576) {res.writeHead(413).end();return;}
        chunks.push(chunk);
      }
      const response=await upstreamFetch(config.upstream,{method:'POST',
        headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':config.webhookSecret},
        body:Buffer.concat(chunks),redirect:'manual',signal:AbortSignal.timeout(20000)});
      const body=Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(body);
    } catch { if(!res.headersSent) res.writeHead(502);res.end(); }
  });
  server.on('connect',(req,socket,head) => {
    socket.on('error',()=>{});
    if(!equal(req.headers['proxy-authorization'],proxyAuth)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="osinara"\r\nConnection: close\r\n\r\n');return;
    }
    // Fixed public targets prevent access to arbitrary hosts or private metadata endpoints.
    const target=resolveConnectDestination(req.url);
    if(!target) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
    }
    const remote=net.connect({host:target.host,port:target.port});
    let established=false;
    remote.setTimeout(target.timeout,()=>remote.destroy());
    socket.setTimeout(target.timeout,()=>socket.destroy());
    remote.once('connect',()=>{
      established=true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)remote.write(head);
      socket.pipe(remote);remote.pipe(socket);
    });
    remote.on('error',()=>{
      if(!established)socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    remote.on('close',()=>socket.destroy());
    socket.on('close',()=>remote.destroy());
  });
  server.maxConnections=256;
  server.headersTimeout=15000;
  server.requestTimeout=30000;
  return server;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {WEBHOOK_SECRET,PROXY_PASSWORD,UPSTREAM_URL}=process.env;
  if(!WEBHOOK_SECRET || WEBHOOK_SECRET.length<32 || !PROXY_PASSWORD || PROXY_PASSWORD.length<32)
    throw new Error('Relay secrets missing');
  const upstream=new URL(UPSTREAM_URL);
  if(upstream.protocol!=='https:' || upstream.pathname!=='/eve/v1/telegram' || upstream.username || upstream.password || upstream.search || upstream.hash)
    throw new Error('Invalid upstream URL');
  const server=createRelay({webhookSecret:WEBHOOK_SECRET,proxyPassword:PROXY_PASSWORD,upstream:upstream.href});
  server.listen(Number(process.env.PORT ?? 8080),'0.0.0.0');
  process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),10000).unref();});
}
