import { describe, expect, it } from "vitest";
import {
  extractTextDocument,
  HTML_TEXT_MAX_INPUT_CHARS,
  textDocumentKind
} from "./textDocuments";

function htmlText(source: string, maxChars?: number) {
  return extractTextDocument(Buffer.from(source), {
    fileName: "page.html",
    ...(maxChars === undefined ? {} : { maxChars }),
    mimeType: "text/html"
  });
}

function fastestMs(run: () => void): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("text document extraction", () => {
  it("classifies supported text document types by MIME and extension", () => {
    expect(textDocumentKind("notes.md", "text/plain")).toBe("markdown");
    expect(textDocumentKind("table.csv", "text/csv")).toBe("csv");
    expect(textDocumentKind("payload.json", "application/json")).toBe("json");
    expect(textDocumentKind("page.htm", "text/html")).toBe("html");
    expect(textDocumentKind("notes.txt", "text/plain")).toBe("text");
  });

  it("preserves normalized text for plain text and markdown documents", () => {
    expect(
      extractTextDocument(Buffer.from("\uFEFF# Title\r\nBody\r\n"), {
        fileName: "notes.md",
        mimeType: "text/plain"
      })
    ).toEqual({
      kind: "markdown",
      text: "# Title\nBody\n",
      truncated: false
    });
  });

  it("pretty-prints valid JSON and preserves invalid JSON as decoded text", () => {
    expect(
      extractTextDocument(Buffer.from("{\"name\":\"AIQSA\",\"enabled\":true}"), {
        fileName: "config.json",
        mimeType: "application/json"
      })
    ).toEqual({
      kind: "json",
      text: "{\n  \"name\": \"AIQSA\",\n  \"enabled\": true\n}\n",
      truncated: false
    });

    expect(
      extractTextDocument(Buffer.from("{invalid"), {
        fileName: "config.json",
        mimeType: "application/json"
      })
    ).toEqual({
      kind: "json",
      text: "{invalid",
      truncated: false
    });
  });

  it("caps persisted text and avoids pretty-printing oversized JSON", () => {
    expect(
      extractTextDocument(Buffer.from("{\"long\":\"abcdef\"}"), {
        fileName: "config.json",
        maxChars: 8,
        mimeType: "application/json"
      })
    ).toEqual({
      kind: "json",
      text: "{\"long\":",
      truncated: true
    });
  });

  it("caps text at a complete UTF-16 character and leaves exact-limit text unchanged", () => {
    expect(
      extractTextDocument(Buffer.from("ab😀cd"), {
        fileName: "notes.txt",
        maxChars: 3,
        mimeType: "text/plain"
      })
    ).toEqual({
      kind: "text",
      text: "ab",
      truncated: true
    });

    expect(
      extractTextDocument(Buffer.from("ab😀"), {
        fileName: "notes.txt",
        maxChars: 4,
        mimeType: "text/plain"
      })
    ).toEqual({
      kind: "text",
      text: "ab😀",
      truncated: false
    });
  });

  it("extracts readable HTML text without scripts or styles", () => {
    expect(
      extractTextDocument(
        Buffer.from("<h1>Report &amp; Notes</h1><script>alert(1)</script><style>body{}</style><p>A&nbsp;B</p>"),
        {
          fileName: "report.html",
          mimeType: "text/html"
        }
      )
    ).toEqual({
      kind: "html",
      text: "Report & Notes\n\nA B",
      truncated: false
    });
  });

  it("keeps HTML text semantics for case, attributes, inline tags, comments and literals", () => {
    expect(htmlText(
      "<DIV class=\"a\"><B>Bold</B> text</DIV><!-- hidden -->" +
      "<SCRIPT type=\"x\">alert(1)</SCRIPT ><P>&lt;d&gt; &#x41;&#66;</P>"
    ).text).toBe("Bold text\n\n<d> AB");
    expect(htmlText("a < b").text).toBe("a < b");
    expect(htmlText("x<>y").text).toBe("x<>y");
    expect(htmlText("<br/>One<h7>Two</h7><scripts>Three</scripts>").text).toBe("One Two Three");
    expect(htmlText("x &#x110000; &#99999999999999999999; y").text)
      .toBe("x &#x110000; &#99999999999999999999; y");
  });

  it("keeps unclosed tags as text and discards unclosed raw-text elements once", () => {
    expect(htmlText("Text <a href").text).toBe("Text <a href");
    expect(htmlText("Text <p class").text).toBe("Text <p class");
    expect(htmlText("Before<script>alert(1)<p>after").text).toBe("Before");
    expect(htmlText("Before<style>p{}</styles><p>after").text).toBe("Before");
    expect(htmlText("Before<script>x</script").text).toBe("Before");
  });

  it.each(["<a", "<p ", "<script>", "<style>"])(
    "extracts runs of unclosed %j in linear time",
    (token) => {
      const source = (length: number) => Buffer.from(token.repeat(Math.ceil(length / token.length)));
      const small = source(256 * 1_024);
      const large = source(1_024 * 1_024);
      const extract = (bytes: Buffer) => () => {
        extractTextDocument(bytes, { fileName: "page.html", mimeType: "text/html" });
      };
      const smallMs = fastestMs(extract(small));
      const largeMs = fastestMs(extract(large));
      expect(smallMs).toBeLessThan(2_000);
      // Quadratic scanning grows sixteenfold for fourfold input.
      expect(largeMs).toBeLessThan(Math.max(8 * smallMs, 250));
    }
  );

  it("bounds HTML input before extraction and reports the result as partial", () => {
    const words = "a".repeat(HTML_TEXT_MAX_INPUT_CHARS - 2);
    expect(htmlText(`${words}<p class="tail">tail</p>`, HTML_TEXT_MAX_INPUT_CHARS))
      .toEqual({ kind: "html", text: words, truncated: true });
    expect(htmlText(`<p>${words}`, HTML_TEXT_MAX_INPUT_CHARS)).toEqual({
      kind: "html",
      text: "a".repeat(HTML_TEXT_MAX_INPUT_CHARS - 3),
      truncated: true
    });
  });
});
