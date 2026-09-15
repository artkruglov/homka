/**
 * Проверка снаружи: жив ли сервис и не кончается ли сертификат.
 *
 * Экспорт:
 * - `OutsideObservation`: то, что видно чужой машине.
 * - `evaluateOutsideCheck`: список проблем со стабильными кодами.
 *
 * Дайджест владельца читает базу изнутри той же установки: полный простой сервера он не заметит
 * по определению — его просто некому отправить. Поэтому нужна проверка с другой машины, и её
 * итог — не текст, а коды: по ним внешний монитор решает, звонить ли человеку.
 *
 * Сертификат проверяется вместе с доступностью, потому что истёкший сертификат выглядит как
 * простой и наступает по календарю, то есть предсказуем заранее.
 */
export const CERTIFICATE_WARNING_DAYS = 14;

export interface OutsideObservation {
  /** Сколько дней осталось сертификату; `null`, если рукопожатие не состоялось. */
  readonly certificateDaysLeft: number | null;
  /** HTTP-код health-маршрута; `null`, если ответа не было. */
  readonly healthStatus: number | null;
  /** Ответ health-маршрута как текст, обрезанный вызывающим. */
  readonly healthBody: string | null;
}

export type OutsideProblem =
  | "AGENT_OUTSIDE_UNREACHABLE"
  | "AGENT_OUTSIDE_HEALTH_FAILED"
  | "AGENT_OUTSIDE_HEALTH_UNEXPECTED"
  | "AGENT_OUTSIDE_CERTIFICATE_EXPIRING"
  | "AGENT_OUTSIDE_CERTIFICATE_EXPIRED";

export function evaluateOutsideCheck(observation: OutsideObservation): OutsideProblem[] {
  const problems: OutsideProblem[] = [];
  if (observation.healthStatus === null) problems.push("AGENT_OUTSIDE_UNREACHABLE");
  else if (observation.healthStatus >= 400) problems.push("AGENT_OUTSIDE_HEALTH_FAILED");
  else if (observation.healthBody !== null && !/\bok\b|"status"\s*:\s*"(?:ok|healthy)"/iu.test(observation.healthBody)) {
    // Двести с непонятным телом это не здоровье: между сервисом и монитором мог встать кто угодно.
    problems.push("AGENT_OUTSIDE_HEALTH_UNEXPECTED");
  }
  if (observation.certificateDaysLeft !== null) {
    if (observation.certificateDaysLeft <= 0) problems.push("AGENT_OUTSIDE_CERTIFICATE_EXPIRED");
    else if (observation.certificateDaysLeft <= CERTIFICATE_WARNING_DAYS) {
      problems.push("AGENT_OUTSIDE_CERTIFICATE_EXPIRING");
    }
  }
  return problems;
}
