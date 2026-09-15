/**
 * Provider catalog error factories.
 *
 * Exports:
 * - `providerCatalogError`: creates stable Russian `AppError` instances for this boundary.
 * - `ProviderCatalogErrorKind`: closed set of catalog failure categories.
 */
import { AppError } from "../app-error.js";
import type { ProviderId } from "./provider-catalog-types.js";

export type ProviderCatalogErrorKind =
  | "auth-required"
  | "http-failed"
  | "request-failed"
  | "response-invalid"
  | "metadata-http-failed"
  | "metadata-request-failed"
  | "metadata-response-invalid"
  | "timeout";

/** Centralizing messages keeps transport and parsers on one stable user-facing contract. */
export function providerCatalogError(
  kind: ProviderCatalogErrorKind,
  providerId: ProviderId,
): AppError {
  switch (kind) {
    case "auth-required":
      return new AppError(
        "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
        `Для загрузки каталога ${providerId} нужен API-ключ`,
      );
    case "http-failed":
      return new AppError(
        "AGENT_PROVIDER_CATALOG_HTTP_FAILED",
        `Не удалось загрузить каталог ${providerId}. Проверьте API-ключ и доступ к провайдеру`,
      );
    case "request-failed":
      return new AppError(
        "AGENT_PROVIDER_CATALOG_REQUEST_FAILED",
        `Не удалось получить каталог ${providerId}. Проверьте подключение и попробуйте ещё раз`,
      );
    case "response-invalid":
      return new AppError(
        "AGENT_PROVIDER_CATALOG_RESPONSE_INVALID",
        `Провайдер ${providerId} вернул каталог моделей в неподдерживаемом формате`,
      );
    case "metadata-http-failed":
      return new AppError(
        "AGENT_PROVIDER_METADATA_HTTP_FAILED",
        "Не удалось загрузить метаданные моделей. Попробуйте ещё раз",
      );
    case "metadata-request-failed":
      return new AppError(
        "AGENT_PROVIDER_METADATA_REQUEST_FAILED",
        "Не удалось получить метаданные моделей. Проверьте подключение и попробуйте ещё раз",
      );
    case "metadata-response-invalid":
      return new AppError(
        "AGENT_PROVIDER_METADATA_RESPONSE_INVALID",
        "Сервис метаданных вернул каталог моделей в неподдерживаемом формате",
      );
    case "timeout":
      return new AppError(
        "AGENT_PROVIDER_CATALOG_TIMEOUT",
        `Каталог ${providerId} не ответил за отведённое время. Попробуйте ещё раз`,
      );
  }
}
