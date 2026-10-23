import {
  DEFAULT_DOCUMENT_PARSER_LIMITS,
  getDocumentParserConfig,
  PARSER_RESPONSE_MAX_BYTES_CEILING,
  PARSER_TIMEOUT_MS_CEILING
} from "./config";
import { resolveDocumentParserRoute } from "./routing";

describe("document parser configuration", () => {
  it("leaves engines disabled when their endpoint is absent or unsafe", () => {
    expect(getDocumentParserConfig({})).toEqual({ tika: undefined });
    expect(getDocumentParserConfig({ AIQSA_TIKA_URL: "file:///tmp/parser" })).toEqual({ tika: undefined });
    expect(getDocumentParserConfig({
      AIQSA_TIKA_URL: "http://user:secret@tika:9998"
    })).toEqual({ tika: undefined });
  });

  it("normalizes the endpoint and applies bounded limits", () => {
    const defaults = getDocumentParserConfig({
      AIQSA_TIKA_REQUEST_MAX_BYTES: "",
      AIQSA_TIKA_URL: "https://parsers.example/tika/"
    });
    expect(defaults.tika).toMatchObject(DEFAULT_DOCUMENT_PARSER_LIMITS.tika);
    expect(defaults.tika?.baseUrl.toString()).toBe("https://parsers.example/tika/");

    const config = getDocumentParserConfig({
      AIQSA_TIKA_REQUEST_MAX_BYTES: "1234",
      AIQSA_TIKA_RESPONSE_MAX_BYTES: String(PARSER_RESPONSE_MAX_BYTES_CEILING),
      AIQSA_TIKA_TIMEOUT_MS: String(PARSER_TIMEOUT_MS_CEILING),
      AIQSA_TIKA_URL: "http://tika:9998/base"
    });
    expect(config.tika).toMatchObject({
      requestMaxBytes: 1234,
      responseMaxBytes: PARSER_RESPONSE_MAX_BYTES_CEILING,
      timeoutMs: PARSER_TIMEOUT_MS_CEILING
    });
    expect(config.tika?.baseUrl.toString()).toBe("http://tika:9998/base/");
  });

  it.each([
    ["AIQSA_TIKA_REQUEST_MAX_BYTES", "0"],
    ["AIQSA_TIKA_RESPONSE_MAX_BYTES", String(PARSER_RESPONSE_MAX_BYTES_CEILING + 1)],
    ["AIQSA_TIKA_TIMEOUT_MS", "1.5"],
    ["AIQSA_TIKA_TIMEOUT_MS", String(PARSER_TIMEOUT_MS_CEILING + 1)],
    ["AIQSA_TIKA_RESPONSE_MAX_BYTES", " 4"]
  ])("rejects %s=%j instead of silently applying the default", (name, value) => {
    expect(() => getDocumentParserConfig({
      AIQSA_TIKA_URL: "http://tika:9998",
      [name]: value
    })).toThrow(expect.objectContaining({
      code: "document_parser_config_invalid",
      message: expect.stringContaining(name),
      setting: name
    }));
  });

  it("inherits the effective upload cap unless an engine override is explicit", () => {
    const inherited = getDocumentParserConfig({
      AIQSA_TIKA_URL: "http://tika:9998",
      AIQSA_UPLOAD_MAX_BYTES: "50000000"
    });

    expect(inherited.tika?.requestMaxBytes).toBe(50_000_000);

    const overridden = getDocumentParserConfig({
      AIQSA_TIKA_REQUEST_MAX_BYTES: "40000000",
      AIQSA_TIKA_URL: "http://tika:9998",
      AIQSA_UPLOAD_MAX_BYTES: "50000000"
    });

    expect(overridden.tika?.requestMaxBytes).toBe(40_000_000);

    const consumerSpecific = getDocumentParserConfig({
      AIQSA_TIKA_URL: "http://tika:9998",
      AIQSA_UPLOAD_MAX_BYTES: "25000000"
    }, { requestMaxBytesDefault: 60_000_000 });

    expect(consumerSpecific.tika?.requestMaxBytes).toBe(60_000_000);
  });
});

describe("document parser routing", () => {
  it.each([
    ["notes.txt", "text/plain", "text"],
    ["notes.md", "text/plain; charset=utf-8", "markdown"],
    ["data.json", "application/json", "json"]
  ])("keeps %s in process", (fileName, mimeType, format) => {
    expect(resolveDocumentParserRoute(fileName, mimeType)).toMatchObject({
      format,
      kind: "inline"
    });
  });

  it.each([
    ["rows.csv", "text/csv", "csv"],
    ["legacy.xls", "application/vnd.ms-excel", "xls"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
    ["sheet.ods", "application/vnd.oasis.opendocument.spreadsheet", "ods"]
  ])("routes %s to the bounded spreadsheet parser", (fileName, mimeType, format) => {
    expect(resolveDocumentParserRoute(fileName, mimeType)).toMatchObject({
      format,
      kind: "spreadsheet"
    });
  });

  it.each([
    ["paper.pdf", "application/pdf"],
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["page.html", "text/html"],
    ["scan.png", "image/png"],
    ["sample.doc", "application/msword"],
    ["letter.rtf", "application/rtf"],
    ["book.epub", "application/epub+zip"],
    ["mail.eml", "message/rfc822"],
    ["mail.msg", "application/vnd.ms-outlook"],
    ["letter.odt", "application/vnd.oasis.opendocument.text"]
  ])("routes %s to Tika alone", (fileName, mimeType) => {
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
