/**
 * Turn inputs for prompt evals from an exported Eve stream.
 *
 * Usage:
 *   psql ... -tA -F'|' -c "select stream_id, to_char(created_at,'MM-DD HH24:MI:SS'), encode(data,'hex')
 *     from workflow.workflow_stream_chunks where stream_id like '%<wrun>%' order by created_at" > streams.hex
 *   npx tsx stress/prompt-evals/extract-turns.ts streams.hex .tmp/evals/<name>-inputs.json [--addressed-only]
 *
 * Each input is one real turn: the envelope the model saw (`message.received`) and the answer it
 * gave (`message.completed`). Turns that only called tools are skipped. Inputs hold real chat text
 * and never enter git: keep them under `.tmp/evals/`.
 */
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

interface TurnInput { actual: string | null; at: string; message: string; turn: string }

const [source, target, ...flags] = process.argv.slice(2);
if (!source || !target) throw new Error("usage: extract-turns.ts <streams.hex> <inputs.json> [--addressed-only]");
const addressedOnly = flags.includes("--addressed-only");

const turns = new Map<string, TurnInput & { completed: boolean }>();
let current: string | null = null;
const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
for await (const line of lines) {
  const [run, at, hex] = line.split("|");
  if (!hex) continue;
  const raw = Buffer.from(hex, "hex").toString("latin1");
  const match = raw.match(/devl\[\["Uint8Array",1\],"([A-Za-z0-9+/=]+)"/);
  if (!match) continue;
  let event: { data?: Record<string, unknown>; type?: string };
  try { event = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")); } catch { continue; }
  if (event.type === "turn.started") current = `${run!.slice(-8)}:${String(event.data?.turnId ?? "")}`;
  if (current === null) continue;
  if (event.type === "message.received") {
    const message = String(event.data?.message ?? "");
    if (!message.includes("<current_telegram_message>")) continue;
    if (addressedOnly && !/[Мм]и[яию]\b/u.test(message.match(/<current_telegram_message>([\s\S]*?)<\/current_telegram_message>/)?.[1] ?? "")) continue;
    turns.set(current, { actual: null, at: at!, completed: false, message, turn: current });
  }
  if (event.type === "message.completed") {
    const turn = turns.get(current);
    if (turn) { turn.actual = String(event.data?.message ?? ""); turn.completed = true; }
  }
}
const inputs = [...turns.values()].filter((turn) => turn.completed).map(({ completed: _c, ...turn }) => turn);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(inputs, null, 1));
console.error(`turns ${turns.size}, with answers ${inputs.length} → ${target}`);
