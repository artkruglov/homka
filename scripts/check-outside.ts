/**
 * Проверка установки снаружи.
 *
 * `npm run check:outside -- --url https://example.org [--json]`
 *
 * Запускать **с другой машины**: дайджест владельца читает базу изнутри той же установки и полный
 * простой не заметит по определению — его некому будет отправить. Здесь наоборот: ничего своего,
 * только публичный адрес, рукопожатие TLS и health-маршрут.
 *
 * Код выхода 1 — есть проблема; коды проблем стабильны, чтобы внешний монитор или cron на другом
 * хосте решал по ним, будить ли человека.
 */
import { connect } from "node:tls";

import {
  evaluateOutsideCheck,
  type OutsideObservation,
} from "../agent/lib/health/outside-check.ts";

const HEALTH_PATH = "/eve/v1/health";
const TIMEOUT_MS = 15_000;
const BODY_LIMIT = 500;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const raw = argument("url") ?? process.env.PUBLIC_BASE_URL;
if (!raw) {
  process.stderr.write(JSON.stringify({ code: "AGENT_OUTSIDE_URL_MISSING" }) + "\n");
  process.exit(1);
}
const url = new URL(raw);

/** Дней до конца сертификата. Рукопожатие отдельно от HTTP: истёкший сертификат роняет запрос. */
async function certificateDaysLeft(): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 443),
      // Сертификат читается даже когда он невалиден: срок нужен именно в этом случае.
      rejectUnauthorized: false,
      servername: url.hostname,
      timeout: TIMEOUT_MS,
    }, () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      const validTo = certificate.valid_to ? Date.parse(certificate.valid_to) : Number.NaN;
      resolve(Number.isNaN(validTo)
        ? null
        : Math.floor((validTo - Date.now()) / 86_400_000));
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

async function health(): Promise<{ body: string | null; status: number | null }> {
  try {
    const response = await fetch(new URL(HEALTH_PATH, url), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { body: (await response.text()).slice(0, BODY_LIMIT), status: response.status };
  } catch {
    return { body: null, status: null };
  }
}

const [days, answer] = await Promise.all([certificateDaysLeft(), health()]);
const observation: OutsideObservation = {
  certificateDaysLeft: days,
  healthBody: answer.body,
  healthStatus: answer.status,
};
const problems = evaluateOutsideCheck(observation);
process.stdout.write(JSON.stringify({
  certificateDaysLeft: observation.certificateDaysLeft,
  healthStatus: observation.healthStatus,
  host: url.host,
  problems,
}, null, 2) + "\n");
if (problems.length > 0) process.exitCode = 1;
