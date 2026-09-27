import { describe, expect, it } from "vitest";
import {
  MEMORY_UTILITY_TEXT_MAX_CODE_UNITS,
  sanitizeMemoryUtilityText
} from "./querySafety";

describe("Memory read query safety boundary", () => {
  it("retains safe multilingual text around a recognized token", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = sanitizeMemoryUtilityText(
      `Я переехал в Хельсинки, token ${secret}; где я живу?`
    );

    expect(result.safeText).toBe(
      "Я переехал в Хельсинки, token [REDACTED:TOKEN]; где я живу?"
    );
    expect(result.eligible).toBe(true);
    expect(result.safeText).not.toContain(secret);
    expect(result.findingCounts).toMatchObject({ KNOWN_TOKEN: 1 });
  });

  it("fails closed on provider-invalid controls without changing ordinary whitespace", () => {
    expect(sanitizeMemoryUtilityText("alpha\u0000beta\n gamma")).toMatchObject({
      eligible: false,
      safeText: ""
    });
    expect(sanitizeMemoryUtilityText("alpha\n gamma")).toMatchObject({
      eligible: true,
      safeText: "alpha\n gamma"
    });
  });

  it.each(["key", "ключ", "鍵", "clé"])(
    "preserves sanitized query labels without semantic filtering (%#)", (label) => {
      expect(sanitizeMemoryUtilityText(`${label}: sk-abcdefghijklmnopqrstuvwxyz123456`))
        .toMatchObject({ eligible: true, safeText: `${label}: [REDACTED:TOKEN]` });
    }
  );

  it.each(["[REDACTED:TOKEN]", "[REDACTED_SECRET]"])(
    "does not query for a marker alone (%#)", (value) => {
      expect(sanitizeMemoryUtilityText(value)).toMatchObject({ eligible: false, safeText: "" });
    }
  );

  it("reports text beyond the local budget as too long and returns none of it", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const tail = ` token ${secret}; which bakery did I like?`;
    const oversized = "x".repeat(MEMORY_UTILITY_TEXT_MAX_CODE_UNITS) + tail;
    expect(sanitizeMemoryUtilityText(oversized)).toMatchObject({
      eligible: false,
      safeText: "",
      tooLong: true
    });
    const withinBudget = `${"y".repeat(MEMORY_UTILITY_TEXT_MAX_CODE_UNITS - tail.length)}${tail}`;
    const safe = sanitizeMemoryUtilityText(withinBudget);
    expect(safe).toMatchObject({ eligible: true, redacted: true, tooLong: false });
    expect(safe.safeText).not.toContain(secret);
    expect(safe.safeText.endsWith("[REDACTED:TOKEN]; which bakery did I like?")).toBe(true);
  });

  it("makes a secret-only query ineligible and leaves high entropy audit-only", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    expect(sanitizeMemoryUtilityText(token)).toMatchObject({
      eligible: false,
      redacted: true,
      safeText: ""
    });
    const opaque = "opaqueBuildA1B2C3D4E5F6G7H8I9J0K1L2M3N4";
    expect(sanitizeMemoryUtilityText(opaque)).toMatchObject({
      eligible: true,
      redacted: false,
      safeText: opaque
    });
  });
});
