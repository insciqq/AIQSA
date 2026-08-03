import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_FINDINGS_BYTES,
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources
} from "./evidence";

describe("Search source evidence normalization", () => {
  it("rejects provider URLs carrying username or password credentials", () => {
    const sources = normalizeSearchSources([
      { title: "Safe source", url: "https://example.com/evidence" },
      { title: "Username", url: "https://PRIVATE_USER@example.com/private" },
      { title: "Password", url: "https://user:PRIVATE_PASSWORD@example.com/private" }
    ]);

    expect(sources).toEqual([{
      rank: 1,
      title: "Safe source",
      url: "https://example.com/evidence"
    }]);
    expect(JSON.stringify(sources)).not.toMatch(/PRIVATE_USER|PRIVATE_PASSWORD/u);
  });

  it("accepts only an explicit flat source list instead of crawling provider payloads", () => {
    expect(normalizeSearchSources([{
      nested: { title: "Hidden", url: "https://example.com/hidden" },
      title: "Visible",
      url: "https://example.com/visible"
    }])).toEqual([{
      rank: 1,
      title: "Visible",
      url: "https://example.com/visible"
    }]);
    expect(normalizeSearchSources({
      citations: [{ title: "Hidden", url: "https://example.com/hidden" }]
    })).toEqual([]);
  });

  it("bounds and canonicalizes adapter findings", () => {
    expect(normalizeSearchFindings("  grounded result  ")).toBe("grounded result");
    expect(() => normalizeSearchFindings(" ")).toThrow("search_findings_invalid");
    expect(() => normalizeSearchFindings("unsafe\u001bcontrol"))
      .toThrow("search_findings_invalid");
    expect(() => normalizeSearchFindings("x".repeat(
      MAX_SEARCH_FINDINGS_CHARACTERS + 1
    ))).toThrow("search_findings_invalid");
  });

  it("enforces the findings UTF-8 byte boundary one byte below, at, and above it", () => {
    const below = `${"é".repeat((MAX_SEARCH_FINDINGS_BYTES - 2) / 2)}a`;
    const at = "é".repeat(MAX_SEARCH_FINDINGS_BYTES / 2);
    const above = `${at}a`;

    expect(Buffer.byteLength(below, "utf8")).toBe(MAX_SEARCH_FINDINGS_BYTES - 1);
    expect(Buffer.byteLength(at, "utf8")).toBe(MAX_SEARCH_FINDINGS_BYTES);
    expect(Buffer.byteLength(above, "utf8")).toBe(MAX_SEARCH_FINDINGS_BYTES + 1);
    expect(normalizeSearchFindings(below)).toBe(below);
    expect(normalizeSearchFindings(at)).toBe(at);
    expect(() => normalizeSearchFindings(above)).toThrow("search_findings_invalid");
  });

  it("enforces the ASCII findings boundary one character below, at, and above it", () => {
    const below = "x".repeat(MAX_SEARCH_FINDINGS_CHARACTERS - 1);
    const at = "x".repeat(MAX_SEARCH_FINDINGS_CHARACTERS);
    const above = "x".repeat(MAX_SEARCH_FINDINGS_CHARACTERS + 1);

    expect(normalizeSearchFindings(below)).toBe(below);
    expect(normalizeSearchFindings(at)).toBe(at);
    expect(() => normalizeSearchFindings(above)).toThrow("search_findings_invalid");
  });
});
