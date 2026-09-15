/**
 * Shared provider catalog test fixtures.
 *
 * Exports:
 * - `REQUEST_TIMEOUT_MS`: bounded deadline used by deterministic tests.
 * - `jsonResponse`: creates a real Fetch API JSON response.
 * - `createFetch`: creates an injected fetch spy returning one response.
 * - `expectAppError`: verifies the stable public `AppError` contract.
 */
import { expect, vi } from "vitest";

import { AppError } from "../app-error.js";
import type { ProviderCatalogFetch } from "./provider-catalog.js";

export const REQUEST_TIMEOUT_MS = 1_000;

/** Builds a real Fetch API response so tests exercise body parsing as well as schemas. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** Captures one request while keeping each provider test independent of global fetch state. */
export function createFetch(
  response: Response,
): ProviderCatalogFetch & ReturnType<typeof vi.fn> {
  return vi.fn(async () => response);
}

/** Asserts the public error contract without coupling tests to internal parsing details. */
export async function expectAppError(
  promise: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code, message: `${code}: ${message}` });
}
