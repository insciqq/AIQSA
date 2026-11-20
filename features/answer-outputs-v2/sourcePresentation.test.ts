import { describe, expect, it } from "vitest";
import type { ThreadSearchSource } from "@/lib/contracts/chats";
import {
  answerCitedUrlsV2,
  answerTextUrlsV2,
  filterSourcesV2,
  groupSourcesBySiteV2,
  normalizedSourceUrlKeyV2,
  presentSearchSourcesV2,
  sourceDomainV2,
  splitCitedSourcesV2
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

/** 1600 search results over 40 sites: ten sites of 80, ten of 40, twenty of 20. */
function largeRun(): ThreadSearchSource[] {
  const sizes = Array.from({ length: 40 }, (_, site) => site < 10 ? 80 : site < 20 ? 40 : 20);
  return sizes.flatMap((size, site) => Array.from({ length: size }, (_, page) => ({
    rank: page + 1,
    title: `Result ${page} on site ${site}`,
    url: `https://www.site-${String(site).padStart(2, "0")}.example/page-${page}`
  })));
}

describe("answerTextUrlsV2", () => {
  it("reads Markdown targets and bare links in order, without trailing punctuation", () => {
    const text = [
      "See [the guide](https://example.com/guide \"Guide\") and https://example.org/a.",
      "Also <https://example.net/b>, **https://example.com/bold**, and",
      "[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) (https://example.com/in-parens).",
      "Not links: ftp://example.com/x, javascript:alert(1), https://"
    ].join("\n");
    expect(answerTextUrlsV2(text)).toEqual([
      "https://example.com/guide",
      "https://example.org/a",
      "https://example.net/b",
      "https://example.com/bold",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://example.com/in-parens"
    ]);
  });

  it("returns nothing for text without links", () => {
    expect(answerTextUrlsV2("No links here, only example.com as a word.")).toEqual([]);
  });
});

describe("answerCitedUrlsV2", () => {
  it("puts the provider's citations first by index, then the text's links", () => {
    expect(answerCitedUrlsV2([
      { index: 2, url: "https://example.com/second" },
      { index: 1, url: "https://example.com/first" }
    ], "Read https://example.com/text.")).toEqual([
      "https://example.com/first",
      "https://example.com/second",
      "https://example.com/text"
    ]);
  });
});

describe("splitCitedSourcesV2", () => {
  const { sources } = presentSearchSourcesV2([
    { rank: 1, title: "Alpha", url: "https://alpha.example/a" },
    { rank: 2, title: "Beta", url: "https://www.beta.example/b/" },
    { rank: 3, title: "Gamma", url: "https://gamma.example/c?page=1" }
  ]);

  it("matches cited links by the normalized key, once each, in order of first mention", () => {
    const split = splitCitedSourcesV2(sources, [
      "http://beta.example/b#top",
      "https://unlisted.example/x",
      "https://alpha.example/a/",
      "https://www.beta.example/b"
    ]);
    expect(split.cited.map((source) => source.title)).toEqual(["Beta", "Alpha"]);
    expect(split.uncited.map((source) => source.title)).toEqual(["Gamma"]);
  });

  it("keeps a query string significant and leaves everything uncited when nothing matches", () => {
    const split = splitCitedSourcesV2(sources, ["https://gamma.example/c?page=2", "https://unlisted.example"]);
    expect(split.cited).toEqual([]);
    expect(split.uncited).toEqual(sources);
  });

  it("matches a link and a source when only one of them carries OpenAI's search attribution", () => {
    // A source stored before 2026-11-20 keeps the attribution; a text link written after has none, and the other way round.
    const stored = presentSearchSourcesV2([
      { rank: 1, title: "Old", url: "https://old.example/a?utm_source=openai" },
      { rank: 2, title: "New", url: "https://new.example/b?id=2" }
    ]).sources;
    expect(stored.map((source) => source.url)).toEqual(["https://old.example/a", "https://new.example/b?id=2"]);
    const split = splitCitedSourcesV2(stored, ["https://new.example/b?utm_source=openai&id=2", "https://old.example/a"]);
    expect(split.cited.map((source) => source.title)).toEqual(["New", "Old"]);
    expect(normalizedSourceUrlKeyV2("https://x.example/p?utm_source=openai")).toBe(normalizedSourceUrlKeyV2("https://x.example/p"));
    // Only that exact parameter: another value still selects another page.
    expect(normalizedSourceUrlKeyV2("https://x.example/p?utm_source=other")).not.toBe(normalizedSourceUrlKeyV2("https://x.example/p"));
  });

  it("merges a cited source with the same page the search listed without the attribution", () => {
    const { mergedDuplicateCount, sources: merged } = presentSearchSourcesV2([
      { rank: 1, title: "Listed", url: "https://shop.example/item?id=7" },
      { rank: 1, title: "Cited", url: "https://shop.example/item?id=7&utm_source=openai" }
    ]);
    expect(merged.map((source) => source.title)).toEqual(["Listed"]);
    expect(mergedDuplicateCount).toBe(1);
  });
});

describe("groupSourcesBySiteV2", () => {
  it("groups by site, largest first, ties by name, sources without a site last", () => {
    const { sources } = presentSearchSourcesV2([
      { rank: 1, title: "B one", url: "https://b.example/1" },
      { rank: 2, title: "No site", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/Q" },
      { rank: 3, title: "A one", url: "https://www.a.example/1" },
      { rank: 4, title: "C one", url: "https://c.example/1" },
      { rank: 5, title: "C two", url: "https://c.example/2" },
      { rank: 6, title: "B two", url: "https://b.example/2" },
      { rank: 7, title: "A two", url: "https://a.example/2" }
    ]);
    expect(groupSourcesBySiteV2(sources).map((group) => [group.site, group.sources.map((source) => source.title)]))
      .toEqual([
        ["a.example", ["A one", "A two"]],
        ["b.example", ["B one", "B two"]],
        ["c.example", ["C one", "C two"]],
        ["", ["No site"]]
      ]);
  });
});

describe("filterSourcesV2", () => {
  const { sources } = presentSearchSourcesV2([
    { rank: 1, title: "Release notes", url: "https://nodejs.org/en/blog/release" },
    { rank: 2, title: "Download", url: "https://www.python.org/downloads/" },
    { rank: 3, title: "Changelog", url: "https://example.com/Path/CHANGES" }
  ]);

  it("matches title, site or address ignoring case, and keeps everything for a blank query", () => {
    expect(filterSourcesV2(sources, "RELEASE").map((source) => source.title)).toEqual(["Release notes"]);
    expect(filterSourcesV2(sources, "python.org").map((source) => source.title)).toEqual(["Download"]);
    expect(filterSourcesV2(sources, "path/changes").map((source) => source.title)).toEqual(["Changelog"]);
    expect(filterSourcesV2(sources, "  ")).toHaveLength(3);
    expect(filterSourcesV2(sources, "nothing-like-this")).toEqual([]);
  });
});

describe("a run with 1600 sources", () => {
  it("cites 14 through Markdown links and groups the other 1586 into 40 sites", () => {
    const { sources } = presentSearchSourcesV2(largeRun());
    expect(sources).toHaveLength(1600);
    const citedUrls = Array.from({ length: 14 }, (_, index) => `https://site-${String(index * 2).padStart(2, "0")}.example/page-${index}/`);
    const text = citedUrls.map((url, index) => `Point ${index} [source](${url}).`).join("\n");
    const split = splitCitedSourcesV2(sources, answerCitedUrlsV2([], text));
    expect(split.cited.map((source) => source.title)).toEqual(
      Array.from({ length: 14 }, (_, index) => `Result ${index} on site ${index * 2}`)
    );
    expect(split.uncited).toHaveLength(1586);
    const groups = groupSourcesBySiteV2(split.uncited);
    expect(groups).toHaveLength(40);
    expect(groups.reduce((sum, group) => sum + group.sources.length, 0)).toBe(1586);
    expect(groups[0]).toMatchObject({ site: "site-01.example" });
    expect(groups[0]!.sources).toHaveLength(80);
    // Sites that lost a cited page sort after the full ones of their size.
    expect(groups.at(-1)).toMatchObject({ site: "site-26.example" });
    expect(groups.at(-1)!.sources).toHaveLength(19);
    expect(filterSourcesV2(split.uncited, "site 7")).toHaveLength(80);
  });
});
