import { describe, expect, it } from "vitest";
import { declaredPageContentKind, decodePageBytes, extractPage, truncatePageText } from "./extract";

const encoder = new TextEncoder();

function cp1251(text: string): Uint8Array {
  // windows-1251 for the Cyrillic letters used below, ASCII otherwise.
  const table = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
  return Uint8Array.from(Array.from(text, (character) => {
    const index = table.indexOf(character);
    if (index >= 0) return 0xc0 + index;
    const code = character.charCodeAt(0);
    if (code > 0x7f) throw new Error(`unmapped ${character}`);
    return code;
  }));
}

const article = (body: string, head = "") => `<!doctype html><html><head>${head}<title>Page title</title>
<script>window.secret = "never";</script><style>p { color: red }</style></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>${body}</article><footer>Footer links</footer></body></html>`;

const paragraph = "This paragraph has enough words to look like real article content for the reader. ".repeat(8);

describe("accepted media types", () => {
  it("reads HTML, XHTML, plain text, Markdown and JSON and refuses everything else", () => {
    expect(declaredPageContentKind("text/html; charset=utf-8")).toBe("html");
    expect(declaredPageContentKind("application/xhtml+xml")).toBe("html");
    expect(declaredPageContentKind("text/plain")).toBe("text");
    expect(declaredPageContentKind("text/markdown")).toBe("markdown");
    expect(declaredPageContentKind("application/ld+json")).toBe("json");
    expect(declaredPageContentKind(null)).toBe("sniff");
    for (const refused of ["application/pdf", "image/png", "application/octet-stream", "text/csv", "application/zip"]) {
      expect(declaredPageContentKind(refused)).toBeNull();
    }
  });

  it("sniffs a missing media type and refuses binary bodies", () => {
    expect(extractPage({ body: encoder.encode("<html><body><p>Hello sniffed</p></body></html>"), contentType: null,
      finalUrl: "https://example.com/" })?.kind).toBe("html");
    expect(extractPage({ body: encoder.encode("{\"a\":1}"), contentType: null, finalUrl: "https://example.com/" })?.text)
      .toBe("{\n  \"a\": 1\n}");
    expect(extractPage({ body: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]), contentType: null,
      finalUrl: "https://example.com/" })).toBeNull();
  });
});

describe("charset decoding", () => {
  it("decodes windows-1251 from the header or from a meta declaration", () => {
    const bytes = cp1251("Привет, мир");
    expect(decodePageBytes(bytes, "text/plain; charset=windows-1251", "text")).toBe("Привет, мир");
    const html = cp1251("<html><head><meta charset=\"windows-1251\"></head><body>Привет</body></html>");
    expect(decodePageBytes(html, "text/html", "html")).toContain("Привет");
    const legacy = cp1251("<meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1251\"><p>Мир</p>");
    expect(decodePageBytes(legacy, "text/html", "html")).toContain("Мир");
  });

  it("prefers a byte order mark, falls back from unknown labels, and reads invalid UTF-8 as windows-1252", () => {
    expect(decodePageBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]), "text/plain; charset=windows-1251", "text")).toBe("A");
    expect(decodePageBytes(encoder.encode("Grüße"), "text/plain; charset=x-unknown", "text")).toBe("Grüße");
    expect(decodePageBytes(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "text/plain", "text")).toBe("café");
  });

  it("extracts a windows-1251 article end to end", () => {
    const page = extractPage({
      body: cp1251(article(`<h1>Заголовок</h1><p>${"Это длинный абзац текста статьи для читателя. ".repeat(12)}</p>`,
        "<meta charset=\"windows-1251\">")),
      contentType: "text/html",
      finalUrl: "https://example.ru/news"
    });
    expect(page?.text).toContain("Это длинный абзац");
    expect(page?.truncated).toBe(false);
  });
});

describe("HTML main content", () => {
  it("keeps headings, lists, links and code from the main content and drops scripts and navigation", () => {
    const page = extractPage({
      body: encoder.encode(article(`<h2>Section</h2><p>${paragraph}</p>
        <ul><li>First item</li><li>Second <a href="/docs/guide?x=1">guide link</a></li></ul>
        <ol><li>Step one</li><li>Step two</li></ol>
        <p>${paragraph} <a href="javascript:alert(1)">bad link</a></p>
        <pre><code>const value = 1;</code></pre>
        <table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>`)),
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/blog/post"
    })!;
    expect(page.title).toBe("Page title");
    expect(page.text).toContain("## Section");
    expect(page.text).toContain("- First item");
    expect(page.text).toContain("[guide link](https://example.com/docs/guide?x=1)");
    expect(page.text).toContain("1. Step one");
    expect(page.text).toContain("```\nconst value = 1;\n```");
    expect(page.text).toContain("| Name | Value |");
    expect(page.text).toContain("bad link");
    expect(page.text).not.toContain("javascript:");
    expect(page.text).not.toContain("window.secret");
    expect(page.text).not.toContain("color: red");
  });

  it("reads fragments and pages that omit the html, head and body tags", () => {
    for (const html of ["<p>Fresh news for the reader.</p>", "<title>Bare</title><p>Fresh news for the reader.</p>",
      "<html><p>Fresh news for the reader.</p></html>"]) {
      const page = extractPage({ body: encoder.encode(html), contentType: "text/html", finalUrl: "https://example.com/" });
      expect(page?.text, html).toBe("Fresh news for the reader.");
    }
    expect(extractPage({ body: encoder.encode("<title>Bare</title><p>x</p>"), contentType: "text/html",
      finalUrl: "https://example.com/" })?.title).toBe("Bare");
  });

  it("falls back to the page body when Readability finds no article", () => {
    const page = extractPage({ body: encoder.encode("<html><body><div>Short note</div></body></html>"),
      contentType: "text/html", finalUrl: "https://example.com/" });
    expect(page?.text).toBe("Short note");
  });

  it("returns empty text for a script-only page", () => {
    const page = extractPage({ body: encoder.encode("<html><body><script>render()</script></body></html>"),
      contentType: "text/html", finalUrl: "https://example.com/app" });
    expect(page?.text).toBe("");
  });

  it("truncates long pages to the fixed bound and marks them", () => {
    const page = extractPage({ body: encoder.encode(article(`<p>${paragraph.repeat(60)}</p>`)),
      contentType: "text/html", finalUrl: "https://example.com/long", maxCharacters: 2_000 })!;
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(2_000);
  });
});

describe("hostile pages", () => {
  const html = (body: string) => extractPage({ body: encoder.encode(`<html><body>${body}</body></html>`), contentType: "text/html",
    finalUrl: "https://example.com/" });

  it("reads deeply nested and unclosed markup within the render bound", () => {
    expect(html(`${"<div>".repeat(20_000)}deep text${"</div>".repeat(20_000)}`)?.text).toContain("deep text");
    expect(html(`${"<b><i>".repeat(5_000)}unclosed text`)?.text).toContain("unclosed text");
  });

  it("reads a document beyond the element bound as bounded plain text, skipping Readability", () => {
    const page = html("<p>Paragraph text for a very long page.</p>".repeat(80_000))!;
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(24_000);
    expect(page.text).toContain("Paragraph text for a very long page.");
  });

  it("reads megabytes of nested tags in one linear pass without building a DOM", () => {
    const started = performance.now();
    const page = html(`<title>Deep &amp; wide</title>${"<div><span>".repeat(200_000)}deep&nbsp;text &#x41;&#66;` +
      `<script>var s = "<div>".repeat(9)</script>`)!;
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(page.title).toBe("Deep & wide");
    expect(page.text).toContain("deep text AB");
    expect(page.text).not.toContain("repeat");
  });

  it("keeps markup, entities and control characters inert text", () => {
    const page = html("<p>&lt;script&gt;alert(1)&lt;/script&gt; \u0000\u0007 <img src=x onerror=alert(1)> [x](javascript:alert(1))</p>")!;
    expect(page.text).toBe("<script>alert(1)</script> [x](javascript:alert(1))");
  });
});

describe("text truncation", () => {
  it("cuts at a boundary near the bound and never splits a surrogate pair", () => {
    expect(truncatePageText("short", 10)).toEqual({ text: "short", truncated: false });
    expect(truncatePageText("alpha beta gamma delta", 15)).toEqual({ text: "alpha beta", truncated: true });
    const emoji = `${"a".repeat(9)}😀tail`;
    expect(truncatePageText(emoji, 10).text).toBe("a".repeat(9));
  });
});
