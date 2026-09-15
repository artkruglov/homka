/**
 * Проверка снаружи.
 *
 * Проверяется: молчание сети это недоступность; пятисотый ответ это сбой; двести с чужим телом
 * не считается здоровьем; сертификат предупреждает заранее и отдельно сообщает об истёкшем.
 */
import { describe, expect, it } from "vitest";

import { CERTIFICATE_WARNING_DAYS, evaluateOutsideCheck } from "./outside-check.js";

const healthy = { certificateDaysLeft: 60, healthBody: '{"status":"ok"}', healthStatus: 200 };

describe("evaluateOutsideCheck", () => {
  it("reports nothing when the service answers and the certificate is young", () => {
    expect(evaluateOutsideCheck(healthy)).toEqual([]);
  });

  it("calls silence unreachable and a refusal a failure", () => {
    expect(evaluateOutsideCheck({ ...healthy, healthBody: null, healthStatus: null }))
      .toEqual(["AGENT_OUTSIDE_UNREACHABLE"]);
    expect(evaluateOutsideCheck({ ...healthy, healthStatus: 502 }))
      .toEqual(["AGENT_OUTSIDE_HEALTH_FAILED"]);
  });

  it("does not take any two hundred for health", () => {
    // Между сервисом и монитором мог встать кто угодно и ответить своей страницей.
    expect(evaluateOutsideCheck({ ...healthy, healthBody: "<html>captive portal</html>" }))
      .toEqual(["AGENT_OUTSIDE_HEALTH_UNEXPECTED"]);
  });

  it("warns before the certificate expires and states it plainly after", () => {
    expect(evaluateOutsideCheck({ ...healthy, certificateDaysLeft: CERTIFICATE_WARNING_DAYS }))
      .toEqual(["AGENT_OUTSIDE_CERTIFICATE_EXPIRING"]);
    expect(evaluateOutsideCheck({ ...healthy, certificateDaysLeft: 0 }))
      .toEqual(["AGENT_OUTSIDE_CERTIFICATE_EXPIRED"]);
    // Несостоявшееся рукопожатие уже названо недоступностью: второй раз о нём не сообщают.
    expect(evaluateOutsideCheck({ certificateDaysLeft: null, healthBody: null, healthStatus: null }))
      .toEqual(["AGENT_OUTSIDE_UNREACHABLE"]);
  });
});
