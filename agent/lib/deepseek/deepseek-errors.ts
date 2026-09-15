/**
 * DeepSeek HTTP error contract (api-docs.deepseek.com/quick_start/error_codes).
 *
 * Export:
 * - `describeDeepSeekHttpError`: stable application code, Russian explanation and retryability
 *   for every documented status; undocumented statuses fall back to the generic transport error.
 */
export interface DeepSeekHttpErrorDescription {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

const DOCUMENTED: Readonly<Record<number, DeepSeekHttpErrorDescription>> = {
  400: { code: "AGENT_MODEL_REQUEST_INVALID", message: "DeepSeek отклонил формат запроса", retryable: false },
  401: { code: "AGENT_MODEL_API_KEY_INVALID", message: "DeepSeek не принял ключ доступа", retryable: false },
  402: { code: "AGENT_MODEL_BALANCE_EXHAUSTED", message: "На счёте DeepSeek закончились средства, пополните баланс", retryable: false },
  422: { code: "AGENT_MODEL_PARAMETERS_INVALID", message: "DeepSeek отклонил параметры запроса", retryable: false },
  429: { code: "AGENT_MODEL_RATE_LIMITED", message: "DeepSeek ограничил частоту запросов, повторите позже", retryable: true },
  500: { code: "AGENT_MODEL_PROVIDER_ERROR", message: "Сбой на стороне DeepSeek, повторите позже", retryable: true },
  503: { code: "AGENT_MODEL_PROVIDER_OVERLOADED", message: "DeepSeek перегружен, повторите чуть позже", retryable: true },
};

export function describeDeepSeekHttpError(status: number): DeepSeekHttpErrorDescription | null {
  return DOCUMENTED[status] ?? null;
}
