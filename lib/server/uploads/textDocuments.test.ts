import { describe, expect, it } from "vitest";
import { extractTextDocument, textDocumentKind } from "./textDocuments";

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
});
