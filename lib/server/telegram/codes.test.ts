import { describe, expect, it } from "vitest";
import { TELEGRAM_REASON_CODES } from "../../contracts/telegram";
import failureCodes from "../observability/failureCodes.json";
import { serializeEvent } from "../observability/runtime.cjs";
import { TELEGRAM_LOG_CODES, telegramFailureCode } from "./codes";

describe("Telegram log codes", () => {
  it("registers every reason and transport code in order among its sorted neighbours, not in the unsorted tail", () => {
    const registry = failureCodes as string[];
    for (const code of [...TELEGRAM_REASON_CODES, ...TELEGRAM_LOG_CODES]) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });

  it("logs a telegram subsystem record with its code instead of dropping either", () => {
    for (const code of ["telegram_poll_conflict", telegramFailureCode("network_after_send"), telegramFailureCode("telegram", 429)]) {
      const record = JSON.parse(serializeEvent("service_operation", {
        subsystem: "telegram", stage: "dispatch", outcome: "failed", action: "retry", code, httpStatus: 409
      })!) as Record<string, unknown>;
      expect(record).toMatchObject({ subsystem: "telegram", code, level: "warn" });
    }
    expect(telegramFailureCode("telegram", 429)).toBe("telegram_rate_limited");
    expect(telegramFailureCode("telegram", 400)).toBe("telegram_api_error");
  });
});
