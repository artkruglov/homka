/**
 * Секреты в журнале.
 *
 * Проверяется: точное значение из окружения вырезается где угодно, включая чужое сообщение;
 * форма секрета ловит значение, которого в окружении нет; короткое значение журнал не портит;
 * подмена console возвращается обратно.
 */
import { describe, expect, it, vi } from "vitest";

import { installSecretRedaction, redactSecrets, REDACTED } from "./redact-secrets.js";

describe("redactSecrets", () => {
  it("cuts an exact value out of any message, whoever wrote it", () => {
    const environment = { MODEL_API_KEY: "super-secret-model-key" } as NodeJS.ProcessEnv;
    expect(redactSecrets('{"error":"401 for super-secret-model-key"}', environment))
      .toBe(`{"error":"401 for ${REDACTED}"}`);
  });

  it("cuts a value this process never had in its environment", () => {
    const empty = {} as NodeJS.ProcessEnv;
    expect(redactSecrets("webhook 123456789:AAH1bcDefGhIjKlMnOpQrStUvWxYz0123456", empty))
      .toBe(`webhook ${REDACTED}`);
    expect(redactSecrets("key sk-abcdefghijklmnopqrstuvwx", empty)).toBe(`key ${REDACTED}`);
    expect(redactSecrets("postgres://osinara:hunter2secret@postgres:5432/osinara", empty))
      .toBe(`postgres://osinara:${REDACTED}@postgres:5432/osinara`);
  });

  it("leaves a short value alone, because a four-letter secret does not exist", () => {
    const environment = { GROQ_API_KEY: "short" } as NodeJS.ProcessEnv;
    expect(redactSecrets("value short stays", environment)).toBe("value short stays");
  });

  it("cuts the longer value first so a shorter one cannot split it", () => {
    const environment = {
      MODEL_API_KEY: "abcdefghijklmnop",
      POSTGRES_PASSWORD: "abcdefghijklmnopqrstuvwxyz",
    } as NodeJS.ProcessEnv;
    expect(redactSecrets("pass abcdefghijklmnopqrstuvwxyz here", environment))
      .toBe(`pass ${REDACTED} here`);
  });

  it("wraps the console and puts it back", () => {
    const written: unknown[][] = [];
    const target = {
      debug: (...args: unknown[]) => written.push(args),
      error: (...args: unknown[]) => written.push(args),
      info: (...args: unknown[]) => written.push(args),
      log: (...args: unknown[]) => written.push(args),
      warn: (...args: unknown[]) => written.push(args),
    } as unknown as Console;
    const restore = installSecretRedaction(target);
    target.error("token 123456789:AAH1bcDefGhIjKlMnOpQrStUvWxYz0123456", { untouched: true });
    expect(written[0]).toEqual([`token ${REDACTED}`, { untouched: true }]);
    restore();
    target.error("token 123456789:AAH1bcDefGhIjKlMnOpQrStUvWxYz0123456");
    expect(written[1]).toEqual(["token 123456789:AAH1bcDefGhIjKlMnOpQrStUvWxYz0123456"]);
  });
});
