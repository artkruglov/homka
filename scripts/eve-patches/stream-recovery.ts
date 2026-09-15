/** Version-pinned seams: preserve event wire format and native writer coalescing; bound reader SQL. */
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";

export async function patchStreamRecovery(replace: (path: string, before: string, after: string) => Promise<void>) {
  const world = resolve("node_modules/@workflow/world-postgres");
  const pkg = JSON.parse(await readFile(`${world}/package.json`, "utf8"));
  if (pkg.version !== "5.0.0-beta.35") throw new Error("AGENT_WORKFLOW_PATCH_VERSION_UNSUPPORTED: Expected world-postgres 5.0.0-beta.35");
  await writeFile(`${world}/dist/osinara-paged-stream.js`, stripTypeScriptTypes(await readFile("scripts/eve-runtime/paged-stream.ts", "utf8")));
  const emission = resolve("node_modules/eve/dist/src/harness/emission.js");
  await writeFile(resolve("node_modules/eve/dist/src/harness/osinara-delta-pacing.js"), stripTypeScriptTypes(await readFile("scripts/eve-runtime/delta-pacing.ts", "utf8")));
  await replace(emission, "import{createOrderedStreamEmitter}from\"#harness/ordered-stream-emitter.js\";",
    "import{createOrderedStreamEmitter}from\"#harness/ordered-stream-emitter.js\";import{paceDeltaSink}from\"./osinara-delta-pacing.js\";");
  await replace(emission, "let i=createOrderedStreamEmitter(e),", "let i=createOrderedStreamEmitter(paceDeltaSink(e)),");
  await writeFile(resolve("node_modules/eve/dist/src/execution/osinara-ndjson-stream.js"), stripTypeScriptTypes(await readFile("scripts/eve-runtime/ndjson-stream.ts", "utf8")));
  await replace(resolve("node_modules/eve/dist/src/execution/ndjson-stream.js"), OLD_NDJSON,
    'export{parseNdjsonStream}from"./osinara-ndjson-stream.js";');
  const streamer = `${world}/dist/streamer.js`;
  await replace(streamer, "import { Mutex } from './util.js';",
    "import { createPagedStream } from './osinara-paged-stream.js';");
  await replace(streamer, OLD_RC, "// Stream notifications carry wake-ups only; no per-stream SQL queue is retained.");
  await replace(streamer, OLD_LISTENER, `    const STREAM_TOPIC = 'workflow_event_chunk';
    const listenSubscription = listenChannel(pool, STREAM_TOPIC, async (msg) => {
        const parsed = StreamPublishMessage.parse(JSON.parse(msg));
        events.emit(\`strm:\${parsed.streamId}\`);
    });`);
  await replace(streamer, OLD_GET, NEW_GET);
}

const OLD_RC = `class Rc {
    resource;
    refCount = 0;
    constructor(resource) {
        this.resource = resource;
    }
    acquire() {
        this.refCount++;
        return {
            ...this.resource,
            [Symbol.dispose]: () => {
                this.release();
            },
        };
    }
    release() {
        this.refCount--;
        if (this.refCount <= 0) {
            this.resource.drop();
        }
    }
}`;

const OLD_LISTENER = `    const mutexes = new Map();
    const getMutex = (key) => {
        let mutex = mutexes.get(key);
        if (!mutex) {
            mutex = new Rc({
                mutex: new Mutex(),
                drop: () => mutexes.delete(key),
            });
            mutexes.set(key, mutex);
        }
        return mutex.acquire();
    };
    const STREAM_TOPIC = 'workflow_event_chunk';
    const listenSubscription = listenChannel(pool, STREAM_TOPIC, async (msg) => {
        const parsed = StreamPublishMessage.parse(JSON.parse(msg));
        const key = \`strm:\${parsed.streamId}\`;
        if (!events.listenerCount(key)) {
            return;
        }
        const resource = getMutex(key);
        await resource.mutex.andThen(async () => {
            const [value] = await drizzle
                .select({ eof: streams.eof, data: streams.chunkData })
                .from(streams)
                .where(and(eq(streams.streamId, parsed.streamId), eq(streams.chunkId, parsed.chunkId)))
                .limit(1);
            if (!value)
                return;
            const { data, eof } = value;
            events.emit(key, { id: parsed.chunkId, data, eof });
        });
    });`;

const OLD_NDJSON = 'function parseNdjsonStream(e){let t=new TextDecoder,n=``,r,i=!1;return new ReadableStream({async start(a){r=e().getReader();try{for(;;){let{value:e,done:i}=await r.read();if(i)break;n+=t.decode(e,{stream:!0});for(let e=n.indexOf(`\n`);e!==-1;e=n.indexOf(`\n`)){let t=n.slice(0,e).trim();n=n.slice(e+1),t.length>0&&a.enqueue(JSON.parse(t))}}if(i)return;n+=t.decode();let e=n.trim();e.length>0&&a.enqueue(JSON.parse(e)),a.close()}catch(e){i||a.error(e)}finally{r.releaseLock()}},async cancel(e){i=!0,await r?.cancel(e)}})}export{parseNdjsonStream};';

const NEW_GET = `            async get(_runId, name, startIndex) {
                return createPagedStream({
                    async initialize(index) {
                        if (index === 0) return { after: null, skip: 0 };
                        const [result] = await drizzle.select({ count: sql\`count(*)\` }).from(streams)
                            .where(and(eq(streams.streamId, name), eq(streams.eof, false)));
                        const count = Number(result.count);
                        const target = index < 0 ? Math.max(0, count + index) : index;
                        const position = Math.min(target, count);
                        if (position === 0) return { after: null, skip: target };
                        const [anchor] = await drizzle.select({ id: streams.chunkId }).from(streams)
                            .where(and(eq(streams.streamId, name), eq(streams.eof, false)))
                            .orderBy(asc(streams.chunkId)).offset(position - 1).limit(1);
                        if (!anchor) throw new Error('AGENT_WORKFLOW_STREAM_CURSOR_LOST: Stream changed during cursor initialization');
                        return { after: anchor.id, skip: target - position };
                    },
                    async page(after) {
                        return drizzle.select({ id: streams.chunkId, eof: streams.eof, data: streams.chunkData })
                            .from(streams).where(and(eq(streams.streamId, name), ...(after ? [gt(streams.chunkId, after)] : [])))
                            .orderBy(asc(streams.chunkId)).limit(16);
                    },
                    subscribe(wake) {
                        const key = \`strm:\${name}\`;
                        events.on(key, wake);
                        return () => events.off(key, wake);
                    },
                }, startIndex);
            },`;

const OLD_GET = `            async get(_runId, name, startIndex) {
                const cleanups = [];
                return new ReadableStream({
                    async start(controller) {
                        // an empty string is always < than any string,
                        // so \`'' < ulid()\` and \`ulid() < ulid()\` (maintaining order)
                        let lastChunkId = '';
                        let offset = startIndex ?? 0;
                        let buffer = [];
                        function enqueue(msg) {
                            if (lastChunkId >= msg.id) {
                                // already sent or out of order
                                return;
                            }
                            if (offset > 0) {
                                offset--;
                                return;
                            }
                            if (msg.data.byteLength) {
                                controller.enqueue(new Uint8Array(msg.data));
                            }
                            if (msg.eof) {
                                controller.close();
                            }
                            lastChunkId = msg.id;
                        }
                        function onData(data) {
                            if (buffer) {
                                buffer.push(data);
                                return;
                            }
                            enqueue(data);
                        }
                        events.on(\`strm:\${name}\`, onData);
                        cleanups.push(() => {
                            events.off(\`strm:\${name}\`, onData);
                        });
                        const chunks = await drizzle
                            .select({
                            id: streams.chunkId,
                            eof: streams.eof,
                            data: streams.chunkData,
                        })
                            .from(streams)
                            .where(and(eq(streams.streamId, name)))
                            .orderBy(streams.chunkId);
                        // Resolve negative offset relative to the data chunk count
                        // (excluding the trailing EOF marker, if present)
                        if (typeof offset === 'number' && offset < 0) {
                            const dataCount = chunks.length > 0 && chunks[chunks.length - 1].eof
                                ? chunks.length - 1
                                : chunks.length;
                            offset = Math.max(0, dataCount + offset);
                        }
                        for (const chunk of [...chunks, ...(buffer ?? [])]) {
                            enqueue(chunk);
                        }
                        buffer = null;
                    },
                    cancel() {
                        cleanups.forEach((fn) => void fn());
                    },
                });
            },`;
