import { describe, expect, it } from "vitest";
import { sanitizeMemoryUtilityText } from "./querySafety";

describe("Memory read query safety boundary", () => {
  it("retains safe multilingual text around a recognized token", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = sanitizeMemoryUtilityText(
      `Я переехал в Хельсинки, token ${secret}; где я живу?`
    );

    expect(result.safeText).toBe(
      "Я переехал в Хельсинки, token [REDACTED_SECRET]; где я живу?"
    );
    expect(result.safeText).not.toContain(secret);
    expect(result.findingCounts).toMatchObject({ KNOWN_TOKEN: 1 });
  });

  it("removes provider-invalid controls without changing ordinary whitespace", () => {
    expect(sanitizeMemoryUtilityText("alpha\u0000beta\n gamma").safeText)
      .toBe("alpha beta\n gamma");
  });
});
