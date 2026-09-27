import { describe, expect, it } from "vitest";
import {
  boundedEngineSearchSources,
  MAX_SEARCH_FINDINGS_BYTES,
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  searchSourcesFromCitationArtifacts
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

  it.each(["url", "href"])("rejects an overlong %s without changing the cited address", (field) => {
    const atLimit = "https://example.com/".padEnd(2_048, "a");

    expect(normalizeSearchSources([{ [field]: atLimit, title: "Exact source" }])).toEqual([{
      rank: 1,
      title: "Exact source",
      url: atLimit
    }]);
    expect(normalizeSearchSources([{ [field]: `${atLimit}b`, title: "Overlong source" }])).toEqual([]);
  });

  it("names an untitled source by its host and cuts titles at a code point", () => {
    const longBare = `https://reports.example.com/${"r".repeat(600)}`;
    expect(normalizeSearchSources([
      { url: longBare },
      { title: `${"t".repeat(499)}😀 rest`, url: "https://example.com/emoji" },
      { title: `${"s".repeat(499)} x`, url: "https://example.com/space" }
    ])).toEqual([
      { rank: 1, title: "reports.example.com", url: longBare },
      { rank: 2, title: "t".repeat(499), url: "https://example.com/emoji" },
      { rank: 3, title: "s".repeat(499), url: "https://example.com/space" }
    ]);
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

  it("admits the agreed 1 MiB of findings, including beyond the former 128 KiB bound", () => {
    expect(MAX_SEARCH_FINDINGS_BYTES).toBe(1_024 * 1_024);
    const formerBoundPlusOne = "x".repeat(128 * 1_024 + 1);
    expect(normalizeSearchFindings(formerBoundPlusOne)).toBe(formerBoundPlusOne);
    // A four-byte code point may end exactly at the bound but never cross it.
    const emojiAt = `${"x".repeat(MAX_SEARCH_FINDINGS_BYTES - 4)}😀`;
    expect(Buffer.byteLength(emojiAt, "utf8")).toBe(MAX_SEARCH_FINDINGS_BYTES);
    expect(normalizeSearchFindings(emojiAt)).toBe(emojiAt);
    expect(() => normalizeSearchFindings(`${"x".repeat(MAX_SEARCH_FINDINGS_BYTES - 3)}😀`))
      .toThrow("search_findings_invalid");
  });

  it("enforces the ASCII findings boundary one character below, at, and above it", () => {
    const below = "x".repeat(MAX_SEARCH_FINDINGS_CHARACTERS - 1);
    const at = "x".repeat(MAX_SEARCH_FINDINGS_CHARACTERS);
    const above = "x".repeat(MAX_SEARCH_FINDINGS_CHARACTERS + 1);

    expect(normalizeSearchFindings(below)).toBe(below);
    expect(normalizeSearchFindings(at)).toBe(at);
    expect(() => normalizeSearchFindings(above)).toThrow("search_findings_invalid");
  });

  it("keeps a provider citation number and ranks positionally", () => {
    expect(normalizeSearchSources([
      { citation: 15, title: "Cited", url: "https://example.com/15" },
      ...[0, 1.5, "3", 10_001, -1].map((citation, index) => ({ citation, title: `Invalid ${index}`, url: `https://example.com/invalid/${index}` }))
    ])).toEqual([
      { citation: 15, rank: 1, title: "Cited", url: "https://example.com/15" },
      ...[0, 1, 2, 3, 4].map((index) => ({ rank: index + 2, title: `Invalid ${index}`, url: `https://example.com/invalid/${index}` }))
    ]);
    expect(searchSourcesFromCitationArtifacts([
      { data: { artifactType: "citation", payload: { index: 7, title: "Numbered", url: "https://example.com/7" } }, type: "artifact" },
      { data: { artifactType: "citation", payload: { title: "Unnumbered", url: "https://example.com/second" } }, type: "artifact" }
    ]).map(({ citation, rank }) => ({ citation, rank }))).toEqual([{ citation: 7, rank: 1 }, { citation: 2, rank: 2 }]);
  });

  it("bounds only browsed sources by maxResults and keeps every cited source first", () => {
    const browsed = Array.from({ length: 10 }, (_, index) => ({ title: `Browsed ${index}`, url: `https://example.com/b/${index}` }));
    const cited = Array.from({ length: 12 }, (_, index) => ({ citation: index + 1, title: `Cited ${index}`, url: `https://example.com/c/${index}` }));
    const kept = boundedEngineSearchSources([...browsed.slice(0, 2), ...cited, ...browsed.slice(2)], 8);
    expect(kept.map((source) => source.title)).toEqual([
      ...cited.map((source) => source.title),
      ...browsed.slice(0, 8).map((source) => source.title)
    ]);
    expect(kept.map((source) => source.rank)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    // The adapter ceiling of twenty sources still bounds the whole list.
    expect(boundedEngineSearchSources([...browsed, ...cited, ...cited.map((source, index) => ({
      ...source, citation: index + 13, url: `${source.url}/more`
    }))], 8).map((source) => source.citation)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });
});
