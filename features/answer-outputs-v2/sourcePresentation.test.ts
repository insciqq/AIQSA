import { describe, expect, it } from "vitest";
import {
  normalizedSourceUrlKeyV2,
  presentSearchSourcesV2,
  sourceDomainV2
} from "./sourcePresentation";

describe("answer source presentation", () => {
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

  it("keeps source titles and replaces URL-shaped titles with the domain", () => {
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

  it("labels a Google grounding redirect by the site its title names, not the redirect host", () => {
    const presented = presentSearchSourcesV2([
      { rank: 1, title: "reuters.com", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC1" },
      { rank: 2, title: "www.Example.org", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/XyZ2" },
      { rank: 3, title: "A story without a site name", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/Q3" }
    ]);

    expect(presented.sources[0]).toMatchObject({ domain: "reuters.com", title: "reuters.com" });
    expect(presented.sources[1]).toMatchObject({ domain: "example.org", title: "example.org" });
    expect(presented.sources[2]).toMatchObject({ domain: null, title: "A story without a site name" });
    expect(JSON.stringify(presented.sources.map(({ domain, title }) => ({ domain, title }))))
      .not.toContain("vertexaisearch");
  });

  it("shows a title that only repeats the site once", () => {
    const presented = presentSearchSourcesV2([
      { rank: 1, title: "www.BBC.com", url: "https://www.bbc.com/news/world-1" },
      { rank: 2, title: "bbc.com.", url: "https://bbc.com/news/world-2" },
      { rank: 3, title: "other.example", url: "https://bbc.com/news/world-3" }
    ]);

    expect(presented.sources[0]).toMatchObject({ domain: "bbc.com", title: "bbc.com" });
    expect(presented.sources[1]).toMatchObject({ domain: "bbc.com", title: "bbc.com" });
    expect(presented.sources[2]).toMatchObject({ domain: "bbc.com", title: "other.example" });
  });
});
