import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay, resolveConnectDestination } from './relay.mjs';

const secret = 'test-webhook-secret-0123456789012345';
const password = 'test-proxy-password-0123456789012345';
async function withRelay(upstream, fn) {
  const server = createRelay({ webhookSecret: secret, proxyPassword: password,
    upstream: 'https://origin.example/eve/v1/telegram', fetch: upstream });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('untrusted webhook requests never reach the origin', async () => {
  await withRelay(() => assert.fail('origin called'), async base => {
    assert.equal((await fetch(base+'/eve/v1/telegram', {method:'POST',body:'{}'})).status,401);
    assert.equal((await fetch(base+'/other', {method:'POST',body:'{}'})).status,404);
  });
});
test('preserves verified header/body and origin failure instead of acknowledging delivery', async () => {
  let calls=0;
  await withRelay(async (url, request) => {
    calls++;
    assert.equal(url, 'https://origin.example/eve/v1/telegram');
    assert.equal(request.headers['X-Telegram-Bot-Api-Secret-Token'], secret);
    assert.equal(request.headers['Proxy-Authorization'], undefined);
    assert.equal(request.body.toString(), '{"update_id":12}');
    return new Response('not persisted', {status:503});
  }, async base => {
    const r=await fetch(base+'/eve/v1/telegram',{method:'POST',body:'{"update_id":12}',
      headers:{'X-Telegram-Bot-Api-Secret-Token':secret}});
    assert.equal(r.status,503); assert.equal(await r.text(),'not persisted'); assert.equal(calls,1);
  });
});
test('rejects oversized bodies before forwarding', async () => {
  await withRelay(() => assert.fail('origin called'), async base => {
    const r=await fetch(base+'/eve/v1/telegram',{method:'POST',body:'x'.repeat(1048577),
      headers:{'X-Telegram-Bot-Api-Secret-Token':secret}});
    assert.equal(r.status,413);
  });
});
test('CONNECT requires credentials and only permits the Telegram TLS endpoint', async () => {
  await withRelay(() => assert.fail('origin called'), async base => {
    async function probe(target,auth) {
      return new Promise((resolve,reject) => {
        const r=http.request(base,{method:'CONNECT',path:target,headers:auth?{'Proxy-Authorization':auth}:{} });
        r.on('connect',(response,socket)=>{socket.destroy();resolve(response.statusCode);});
        r.on('error',reject);r.end();
      });
    }
    assert.equal(await probe('api.telegram.org:443'),407);
    const auth='Basic '+Buffer.from('osinara:'+password).toString('base64');
    assert.equal(await probe('127.0.0.1:443',auth),403);
    assert.equal(await probe('api.telegram.org:80',auth),403);
    assert.equal(await probe('api.telegram.org.evil.example:443',auth),403);
  });
});

test('does not acknowledge a verified update before its origin commits', async () => {
  let commit;
  let started;
  const entered = new Promise(resolve => { started=resolve; });
  await withRelay(async () => {
    started();
    await new Promise(resolve => { commit=resolve; });
    return new Response('stored', {status:200});
  }, async base => {
    let acknowledged=false;
    const request=fetch(base+'/eve/v1/telegram',{method:'POST',body:'{}',
      headers:{'X-Telegram-Bot-Api-Secret-Token':secret}}).then(r=>{acknowledged=true;return r;});
    await entered;
    assert.equal(acknowledged,false);
    commit();
    assert.equal(await (await request).text(),'stored');
  });
});

test('origin transport failure is not acknowledged or retried', async () => {
  let calls=0;
  await withRelay(async () => {calls++;throw new Error('transport failed');}, async base => {
    const r=await fetch(base+'/eve/v1/telegram',{method:'POST',body:'{}',
      headers:{'X-Telegram-Bot-Api-Secret-Token':secret}});
    assert.equal(r.status,502);
    assert.equal(calls,1);
  });
});

 test('only exact public provider authorities resolve', () => {
  assert.deepEqual(resolveConnectDestination('api.telegram.org:443'), {host:'api.telegram.org',port:443,timeout:120000});
  assert.deepEqual(resolveConnectDestination('openrouter.ai:443'), {host:'openrouter.ai',port:443,timeout:360000});
  for (const host of ['openrouter.ai:80','openrouter.ai.evil.example:443','user@openrouter.ai:443','169.254.169.254:443','openrouter.ai:443/']) assert.equal(resolveConnectDestination(host),null);
});
