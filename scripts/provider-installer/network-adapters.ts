/**
 * Concrete read-only installer network adapters.
 *
 * Exports:
 * - `createPublicIpv4Sources`: independent bounded HTTPS public IPv4 observers.
 * - `createTelegramGetMe`: bounded Telegram Bot API getMe transport.
 */
import type { GetTelegramMe, PublicIpv4Source, TelegramGetMeResponse } from "./contracts.ts";
import { InstallerError } from "./errors.ts";

const NETWORK_TIMEOUT_MILLISECONDS = 10_000;
const PUBLIC_IPV4_ENDPOINTS = [
  { id: "ipify", url: "https://api.ipify.org" },
  { id: "aws-checkip", url: "https://checkip.amazonaws.com" },
  { id: "icanhazip", url: "https://ipv4.icanhazip.com" },
] as const;

async function requireSuccessfulText(
  fetchImplementation: typeof fetch,
  id: string,
  url: string,
): Promise<string> {
  const response = await fetchImplementation(url, {
    headers: { Accept: "text/plain" },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    throw new InstallerError(
      "OSINARA_INSTALL_PUBLIC_IP_SOURCE_FAILED",
      `Источник ${id} отклонил запрос определения публичного IPv4`,
    );
  }
  return response.text();
}

export function createPublicIpv4Sources(
  fetchImplementation: typeof fetch = fetch,
): readonly PublicIpv4Source[] {
  // Distinct operators reduce the chance that one service failure or stale answer decides installation.
  return PUBLIC_IPV4_ENDPOINTS.map(({ id, url }) => ({
    id,
    observe: () => requireSuccessfulText(fetchImplementation, id, url),
  }));
}

function isTelegramGetMeResponse(value: unknown): value is TelegramGetMeResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const response = value as Record<string, unknown>;
  if (response.ok === false) {
    return response.description === undefined || typeof response.description === "string";
  }
  if (response.ok !== true || typeof response.result !== "object" || response.result === null) {
    return false;
  }
  const result = response.result as Record<string, unknown>;
  return (
    typeof result.id === "number" &&
    typeof result.is_bot === "boolean" &&
    (result.username === undefined || typeof result.username === "string")
  );
}

export function createTelegramGetMe(
  fetchImplementation: typeof fetch = fetch,
): GetTelegramMe {
  return async (token) => {
    let response: Response;
    try {
      response = await fetchImplementation(`https://api.telegram.org/bot${token}/getMe`, {
        method: "GET",
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) {
        throw new Error(`Telegram returned HTTP ${response.status}`);
      }
      const decoded: unknown = await response.json();
      if (!isTelegramGetMeResponse(decoded)) {
        throw new Error("Telegram returned an invalid getMe payload");
      }
      return decoded;
    } catch (error) {
      throw new InstallerError(
        "OSINARA_INSTALL_TELEGRAM_REQUEST_FAILED",
        "Не удалось получить корректный ответ Telegram getMe. Проверьте сеть и токен",
        { cause: error },
      );
    }
  };
}
