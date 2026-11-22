import { describe, expect, it } from "vitest";
import {
  SEARCH_QUERY_MAX_CODE_UNITS,
  redactSearchQuery
} from "./searchQuery";

describe("search query redaction boundary", () => {
  it("retains safe multilingual text around a recognized token", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSearchQuery(
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
    expect(redactSearchQuery("alpha\u0000beta\n gamma")).toMatchObject({
      eligible: false,
      safeText: ""
    });
    expect(redactSearchQuery("alpha\n gamma")).toMatchObject({
      eligible: true,
      safeText: "alpha\n gamma"
    });
  });

  it.each(["key", "ключ", "鍵", "clé"])(
    "preserves sanitized query labels without semantic filtering (%#)", (label) => {
      expect(redactSearchQuery(`${label}: sk-abcdefghijklmnopqrstuvwxyz123456`))
        .toMatchObject({ eligible: true, safeText: `${label}: [REDACTED:TOKEN]` });
    }
  );

  it.each(["[REDACTED:TOKEN]", "[REDACTED_SECRET]"])(
    "does not query for a marker alone (%#)", (value) => {
      expect(redactSearchQuery(value)).toMatchObject({ eligible: false, safeText: "" });
    }
  );

  it("reports text beyond the local budget as too long and returns none of it", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const tail = ` token ${secret}; which bakery did I like?`;
    const oversized = "x".repeat(SEARCH_QUERY_MAX_CODE_UNITS) + tail;
    expect(redactSearchQuery(oversized)).toMatchObject({
      eligible: false,
      safeText: "",
      tooLong: true
    });
    const withinBudget = `${"y".repeat(SEARCH_QUERY_MAX_CODE_UNITS - tail.length)}${tail}`;
    const safe = redactSearchQuery(withinBudget);
    expect(safe).toMatchObject({ eligible: true, redacted: true, tooLong: false });
    expect(safe.safeText).not.toContain(secret);
    expect(safe.safeText.endsWith("[REDACTED:TOKEN]; which bakery did I like?")).toBe(true);
  });

  it("makes a secret-only query ineligible and leaves high entropy audit-only", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    expect(redactSearchQuery(token)).toMatchObject({
      eligible: false,
      redacted: true,
      safeText: ""
    });
    const opaque = "opaqueBuildA1B2C3D4E5F6G7H8I9J0K1L2M3N4";
    expect(redactSearchQuery(opaque)).toMatchObject({
      eligible: true,
      redacted: false,
      safeText: opaque
    });
  });
});
