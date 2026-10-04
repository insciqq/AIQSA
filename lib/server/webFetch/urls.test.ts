import { describe, expect, it } from "vitest";
import {
  extractFetchUrls,
  fetchUrlDigest,
  fetchUrlDigestsOf,
  fetchUrlDisplayTarget,
  isFetchUrlDigest,
  normalizeFetchUrl
} from "./urls";

describe("fetch_url address normalization", () => {
  it("lowercases scheme and host, applies IDNA, drops the default port and the fragment", () => {
    expect(normalizeFetchUrl("HTTPS://Example.COM:443/Path?q=1#section")).toBe("https://example.com/Path?q=1");
    expect(normalizeFetchUrl("http://пример.рф/статья")).toBe(
      "http://xn--e1afmkfd.xn--p1ai/%D1%81%D1%82%D0%B0%D1%82%D1%8C%D1%8F");
    expect(normalizeFetchUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeFetchUrl("https://example.com/a%2fb")).toBe("https://example.com/a%2Fb");
  });

  it("keeps userinfo and other ports for the transport to refuse, and rejects other schemes", () => {
    expect(normalizeFetchUrl("https://user:pw@example.com/")).toBe("https://user:pw@example.com/");
    expect(normalizeFetchUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
    expect(normalizeFetchUrl("ftp://example.com/")).toBeNull();
    expect(normalizeFetchUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeFetchUrl("example.com/page")).toBeNull();
    expect(normalizeFetchUrl(`https://example.com/${"a".repeat(2_100)}`)).toBeNull();
    expect(normalizeFetchUrl(42)).toBeNull();
  });

  it("maps equivalent spellings to one digest", () => {
    const left = normalizeFetchUrl("https://EXAMPLE.com/a b?x=%c3%a9#frag")!;
    const right = normalizeFetchUrl("https://example.com:443/a%20b?x=%C3%A9")!;
    expect(fetchUrlDigest(left)).toBe(fetchUrlDigest(right));
    expect(isFetchUrlDigest(fetchUrlDigest(left))).toBe(true);
    expect(isFetchUrlDigest("not-a-digest")).toBe(false);
  });
});

describe("URLs written in text", () => {
  it("finds explicit http(s) links in prose and Markdown, trimming punctuation and unbalanced brackets", () => {
    expect(extractFetchUrls("Summarize https://example.com/a. Also (see https://example.org/b), " +
      "[docs](https://docs.example.net/x_(y)) and <https://angle.example/>, «https://ru.example/путь»!")).toEqual([
      "https://example.com/a",
      "https://example.org/b",
      "https://docs.example.net/x_(y)",
      "https://angle.example/",
      "https://ru.example/%D0%BF%D1%83%D1%82%D1%8C"
    ]);
  });

  it("ignores bare domains and deduplicates equivalent links", () => {
    expect(extractFetchUrls("read habr.com/ru/articles/1 and HTTPS://A.example/x#1 https://a.example/x")).toEqual([
      "https://a.example/x"
    ]);
  });

  it("bounds the digests of many texts", () => {
    const digests = fetchUrlDigestsOf(["https://a.example/1 https://a.example/2", "https://a.example/3"], 2);
    expect(digests).toEqual([
      fetchUrlDigest("https://a.example/1"),
      fetchUrlDigest("https://a.example/2")
    ]);
  });
});

describe("activity display target", () => {
  it("shows the Unicode host and decoded path without scheme, query or fragment", () => {
    expect(fetchUrlDisplayTarget("https://xn--e1afmkfd.xn--p1ai/%D1%81%D1%82%D0%B0%D1%82%D1%8C%D1%8F?token=secret#x"))
      .toBe("пример.рф/статья");
    expect(fetchUrlDisplayTarget("https://example.com/?q=1")).toBe("example.com");
    expect(fetchUrlDisplayTarget("http://example.com:8080/a")).toBe("example.com:8080/a");
    expect(fetchUrlDisplayTarget(`https://example.com/${"a".repeat(200)}`)).toHaveLength(96);
    expect(fetchUrlDisplayTarget("not a url")).toBeNull();
  });
});
