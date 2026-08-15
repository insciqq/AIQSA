import { describe, expect, it } from "vitest";
import { projectThreadSearchSources } from "./searchSources";

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
});
