import { describe, expect, it } from "vitest";
import {
  normalizedSourceUrlKeyV2,
  presentSearchSourcesV2,
  sourceDomainV2
} from "./sourcePresentation";

describe("normalizedSourceUrlKeyV2", () => {
  it("treats scheme, www, trailing slash, and fragment as insignificant", () => {
    const expected = "nodejs.org/en/download";
    expect(normalizedSourceUrlKeyV2("https://nodejs.org/en/download")).toBe(expected);
    expect(normalizedSourceUrlKeyV2("http://nodejs.org/en/download/")).toBe(expected);
    expect(normalizedSourceUrlKeyV2("https://www.nodejs.org/en/download#current")).toBe(expected);
    expect(normalizedSourceUrlKeyV2("https://NodeJS.org/en/download///")).toBe(expected);
  });

  it("keeps query strings significant and falls back to raw text for non-URLs", () => {
    expect(normalizedSourceUrlKeyV2("https://nodejs.org/en?page=1"))
      .not.toBe(normalizedSourceUrlKeyV2("https://nodejs.org/en?page=2"));
    expect(normalizedSourceUrlKeyV2(" Not a URL ")).toBe("not a url");
  });
});

describe("sourceDomainV2", () => {
  it("maps http(s) URLs to a readable domain and refuses other schemes", () => {
    expect(sourceDomainV2("https://www.nodejs.org/en/download")).toBe("nodejs.org");
    expect(sourceDomainV2("http://docs.example.com/a")).toBe("docs.example.com");
    expect(sourceDomainV2("javascript:alert(1)")).toBeNull();
    expect(sourceDomainV2("not a url")).toBeNull();
  });
});

describe("presentSearchSourcesV2", () => {
  it("merges near-duplicate URLs, keeping the first provider-ranked occurrence", () => {
    const presented = presentSearchSourcesV2([
      { rank: 1, title: "Node.js downloads", url: "https://nodejs.org/en/download" },
      { rank: 2, title: "Node.js downloads (www)", url: "https://www.nodejs.org/en/download/" },
      { rank: 3, title: "Node.js downloads (anchor)", url: "https://nodejs.org/en/download#current" },
      { rank: 4, title: "Release notes", url: "https://nodejs.org/en/blog/release" }
    ]);

    expect(presented.sources.map((source) => source.title)).toEqual([
      "Node.js downloads",
      "Release notes"
    ]);
    expect(presented.sources.map((source) => source.rank)).toEqual([1, 4]);
    expect(presented.mergedDuplicateCount).toBe(2);
  });

  it("keeps receipt titles and replaces URL-shaped titles with the domain", () => {
    const presented = presentSearchSourcesV2([
      {
        rank: 1,
        snippet: "Официальные сборки.",
        title: "Download Node.js",
        url: "https://nodejs.org/en/download"
      },
      { rank: 2, title: "https://nodejs.org/en/blog", url: "https://nodejs.org/en/blog" },
      { rank: 3, title: "   ", url: "https://example.com/docs" }
    ]);

    expect(presented.sources[0]).toMatchObject({
      domain: "nodejs.org",
      snippet: "Официальные сборки.",
      title: "Download Node.js"
    });
    expect(presented.sources[1]).toMatchObject({ domain: "nodejs.org", title: "nodejs.org" });
    expect(presented.sources[2]).toMatchObject({ domain: "example.com", title: "example.com" });
  });
});
