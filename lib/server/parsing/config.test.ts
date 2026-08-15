import {
  DEFAULT_DOCUMENT_PARSER_LIMITS,
  getDocumentParserConfig,
  PARSER_RESPONSE_MAX_BYTES_CEILING,
  PARSER_TIMEOUT_MS_CEILING
} from "./config";
import { resolveDocumentParserRoute } from "./routing";

describe("document parser configuration", () => {
  it("leaves engines disabled when their endpoint is absent or unsafe", () => {
    expect(getDocumentParserConfig({})).toEqual({ docling: undefined, tika: undefined });
    expect(getDocumentParserConfig({
      AIQSA_DOCLING_URL: "file:///tmp/parser",
      AIQSA_TIKA_URL: "http://user:secret@tika:9998"
    })).toEqual({ docling: undefined, tika: undefined });
  });

  it("normalizes endpoints and applies independent bounded limits", () => {
    const config = getDocumentParserConfig({
      AIQSA_DOCLING_REQUEST_MAX_BYTES: "1234",
      AIQSA_DOCLING_RESPONSE_MAX_BYTES: String(PARSER_RESPONSE_MAX_BYTES_CEILING),
      AIQSA_DOCLING_TIMEOUT_MS: String(PARSER_TIMEOUT_MS_CEILING),
      AIQSA_DOCLING_URL: "http://docling:5001/base",
      AIQSA_TIKA_REQUEST_MAX_BYTES: "0",
      AIQSA_TIKA_RESPONSE_MAX_BYTES: "999999999",
      AIQSA_TIKA_TIMEOUT_MS: "1.5",
      AIQSA_TIKA_URL: "https://parsers.example/tika/"
    });

    expect(config.docling).toMatchObject({
      requestMaxBytes: 1234,
      responseMaxBytes: PARSER_RESPONSE_MAX_BYTES_CEILING,
      timeoutMs: PARSER_TIMEOUT_MS_CEILING
    });
    expect(config.docling?.baseUrl.toString()).toBe("http://docling:5001/base/");
    expect(config.tika).toMatchObject(DEFAULT_DOCUMENT_PARSER_LIMITS.tika);
    expect(config.tika?.baseUrl.toString()).toBe("https://parsers.example/tika/");
  });

  it("inherits the effective upload cap unless an engine override is explicit", () => {
    const inherited = getDocumentParserConfig({
      AIQSA_DOCLING_URL: "http://docling:5001",
      AIQSA_TIKA_URL: "http://tika:9998",
      AIQSA_UPLOAD_MAX_BYTES: "50000000"
    });

    expect(inherited.docling?.requestMaxBytes).toBe(50_000_000);
    expect(inherited.tika?.requestMaxBytes).toBe(50_000_000);

    const overridden = getDocumentParserConfig({
      AIQSA_DOCLING_REQUEST_MAX_BYTES: "30000000",
      AIQSA_DOCLING_URL: "http://docling:5001",
      AIQSA_TIKA_REQUEST_MAX_BYTES: "40000000",
      AIQSA_TIKA_URL: "http://tika:9998",
      AIQSA_UPLOAD_MAX_BYTES: "50000000"
    });

    expect(overridden.docling?.requestMaxBytes).toBe(30_000_000);
    expect(overridden.tika?.requestMaxBytes).toBe(40_000_000);

    const consumerSpecific = getDocumentParserConfig({
      AIQSA_DOCLING_URL: "http://docling:5001",
      AIQSA_TIKA_URL: "http://tika:9998",
      AIQSA_UPLOAD_MAX_BYTES: "25000000"
    }, { requestMaxBytesDefault: 60_000_000 });

    expect(consumerSpecific.docling?.requestMaxBytes).toBe(60_000_000);
    expect(consumerSpecific.tika?.requestMaxBytes).toBe(60_000_000);
  });
});

describe("document parser routing", () => {
  it.each([
    ["notes.txt", "text/plain", "text"],
    ["notes.md", "text/plain; charset=utf-8", "markdown"],
    ["rows.csv", "text/csv", "csv"],
    ["data.json", "application/json", "json"]
  ])("keeps %s in process", (fileName, mimeType, format) => {
    expect(resolveDocumentParserRoute(fileName, mimeType)).toMatchObject({
      format,
      kind: "inline"
    });
  });

  it.each([
    ["paper.pdf", "application/pdf"],
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["page.html", "text/html"],
    ["scan.png", "image/png"]
  ])("routes %s to Docling with Tika fallback", (fileName, mimeType) => {
    expect(resolveDocumentParserRoute(fileName, mimeType)).toMatchObject({
      engines: ["docling", "tika"],
      kind: "sidecar"
    });
  });

  it.each([
    ["sample.doc", "application/msword"],
    ["letter.rtf", "application/rtf"],
    ["book.epub", "application/epub+zip"],
    ["mail.eml", "message/rfc822"],
    ["mail.msg", "application/vnd.ms-outlook"],
    ["letter.odt", "application/vnd.oasis.opendocument.text"]
  ])("routes %s directly to Tika", (fileName, mimeType) => {
    expect(resolveDocumentParserRoute(fileName, mimeType)).toMatchObject({
      engines: ["tika"],
      kind: "sidecar"
    });
  });

  it("rejects mismatched declarations and path-like filenames", () => {
    expect(resolveDocumentParserRoute("paper.pdf", "text/plain")).toBeUndefined();
    expect(resolveDocumentParserRoute("../paper.pdf", "application/pdf")).toBeUndefined();
    expect(resolveDocumentParserRoute("paper", "application/pdf")).toBeUndefined();
    expect(resolveDocumentParserRoute("paper.svg", "image/svg+xml")).toBeUndefined();
  });
});
