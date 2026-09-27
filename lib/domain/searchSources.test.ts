import { describe, expect, it } from "vitest";
import { decodeThreadSearchSource } from "../contracts/searchSources";
import { collectThreadSearchSources, projectThreadSearchSources } from "./searchSources";

describe("Search source projection", () => {
  it("keeps only bounded safe source fields", () => {
    expect(projectThreadSearchSources([{
      description: "Useful context",
      href: "https://example.com/source",
      publishedAt: "2026-08-15",
      title: "Example"
    }])).toEqual([{
      date: "2026-08-15",
      rank: 1,
      snippet: "Useful context",
      title: "Example",
      url: "https://example.com/source"
    }]);
  });

  it("rejects unsafe and credential-bearing links", () => {
    expect(projectThreadSearchSources([
      { title: "Script", url: "javascript:alert(1)" },
      { title: "Credentials", url: "https://user:secret@example.com/private" }
    ])).toEqual([]);
  });

  it("deduplicates URLs and does not scan arbitrary nested objects", () => {
    expect(projectThreadSearchSources({
      nested: { title: "Private", url: "https://private.example/trace" },
      sources: [
        { title: "First", url: "https://example.com/source" },
        { title: "Duplicate", url: "https://example.com/source" }
      ]
    })).toEqual([]);
    expect(projectThreadSearchSources([
      { title: "First", url: "https://example.com/source" },
      { title: "Duplicate", url: "https://example.com/source" }
    ])).toHaveLength(1);
  });

  it("keeps only what the source contract accepts: URL length and a bounded title fallback", () => {
    const atLimit = "https://example.com/".padEnd(2_048, "a");
    const longBare = `https://docs.example.org/${"p".repeat(600)}`;
    const sources = projectThreadSearchSources([
      { url: atLimit },
      { title: "Over the limit", url: `${atLimit}b` },
      { title: "x".repeat(501), url: longBare },
      { title: "  Trimmed title  ", url: "https://example.net/t" }
    ]);
    expect(sources).toEqual([
      { rank: 1, title: "example.com", url: atLimit },
      { rank: 2, title: "docs.example.org", url: longBare },
      { rank: 3, title: "Trimmed title", url: "https://example.net/t" }
    ]);
    for (const source of sources) expect(decodeThreadSearchSource(source)).toEqual(source);
  });

  it("accumulates sources across results and reports anything left beyond the bound", () => {
    const round = (name: string) => Array.from({ length: 20 }, (_, index) => ({ url: `https://${name}.example/${index}` }));
    const repeated = collectThreadSearchSources([round("a"), round("b"), round("a")], 100);
    expect(repeated.sources.map(({ rank }) => rank)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(repeated.truncated).toBe(false);
    const bounded = collectThreadSearchSources([round("a"), round("b")], 30);
    expect(bounded.sources).toHaveLength(30);
    expect(bounded.truncated).toBe(true);
    expect(collectThreadSearchSources([round("a"), round("a")], 20).truncated).toBe(false);
  });
});
