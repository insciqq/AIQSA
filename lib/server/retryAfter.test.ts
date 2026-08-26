import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "./retryAfter";

describe("Retry-After parsing", () => {
  it("accepts delta seconds and a future HTTP date", () => {
    const now = Date.parse("2026-08-26T06:00:00.000Z");
    expect(parseRetryAfterMs("75", now)).toBe(75_000);
    expect(parseRetryAfterMs("Wed, 26 Aug 2026 06:02:00 GMT", now)).toBe(120_000);
  });

  it.each([
    null,
    "",
    "0",
    "-1",
    "1.5",
    "not-a-delay",
    "Wed, 26 Aug 2026 05:59:59 GMT",
    `1${"0".repeat(128)}`,
    "75\nprivate"
  ])("rejects invalid or non-future value %j", (value) => {
    expect(parseRetryAfterMs(value, Date.parse("2026-08-26T06:00:00.000Z"))).toBeNull();
  });
});
