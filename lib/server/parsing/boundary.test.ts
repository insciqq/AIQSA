import { createDocumentParserBoundary } from "./boundary";
import { finalizeParsedDocument } from "./assessment";
import { getDocumentParserConfig, type ParserEngineConfig } from "./config";
import { DocumentParserError } from "./errors";
import type {
  DocumentParserEngine,
  DocumentParserEngineAdapter,
  ParsedDocument,
  ParserProbeResult,
  SidecarParserEngine
} from "./types";

function engineConfig(baseUrl: string, overrides: Partial<ParserEngineConfig> = {}): ParserEngineConfig {
  return {
    baseUrl: new URL(baseUrl),
    requestMaxBytes: 1_024,
    responseMaxBytes: 64 * 1_024,
    timeoutMs: 1_000,
    ...overrides
  };
}

function parsed(engine: DocumentParserEngine, text = "parsed"): ParsedDocument {
  return finalizeParsedDocument({
    blocks: [{
      assetIds: [],
      boundingBoxes: [],
      headingPath: [],
      index: 0,
      isTable: false,
      languageHints: ["und-Latn"],
      page: 1,
      pageEnd: 1,
      readingOrder: 0,
      table: null,
      text,
      type: "paragraph"
    }],
    engine,
    mediaType: "application/pdf",
    pageCount: 1,
    status: "complete",
    text
  });
}

function fakeAdapter(input: Readonly<{
  engine: SidecarParserEngine;
  parse?: DocumentParserEngineAdapter["parse"];
  probe?: DocumentParserEngineAdapter["probe"];
}>): DocumentParserEngineAdapter {
  return {
    parse: input.parse ?? (async () => parsed(input.engine)),
    probe: input.probe ?? (async (): Promise<ParserProbeResult> => ({
      available: true,
      configured: true,
      engine: input.engine
    }))
  };
}

const tikaEnvelope = [{
  "Content-Type": "application/pdf",
  "X-TIKA:content": "<html><body><p>fixture text</p></body></html>"
}];

describe("document parser boundary", () => {
  it("keeps plain text in process without consulting a sidecar", async () => {
    const tikaParse = vi.fn<DocumentParserEngineAdapter["parse"]>();
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("hello"),
      fileName: "notes.txt",
      mimeType: "text/plain"
    })).resolves.toMatchObject({
      blocks: [{ index: 0, page: 1, text: "hello" }],
      engine: "inline",
      status: "complete"
    });
    expect(tikaParse).not.toHaveBeenCalled();
  });

  it("preserves GFM tables as atomic inline Markdown blocks", async () => {
    const tikaParse = vi.fn<DocumentParserEngineAdapter["parse"]>();
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) }
    });

    const document = await boundary.parse({
      bytes: Buffer.from([
        "# Quarterly report",
        "",
        "Opening context.",
        "| period | value |",
        "| --- | ---: |",
        "| 2027 | 41 |",
        "| 2026 | 37 |",
        "Closing context."
      ].join("\n")),
      fileName: "quarterly-report.md",
      mimeType: "text/markdown"
    });

    expect(document.blocks.map(({ text, type }) => [type, text])).toEqual([
      ["title", "Quarterly report"],
      ["paragraph", "Opening context."],
      ["table", "period\tvalue\n2027\t41\n2026\t37"],
      ["paragraph", "Closing context."]
    ]);
    expect(document.blocks[2]).toMatchObject({
      headingPath: ["Quarterly report"],
      isTable: true,
      table: { columnCount: 2, rowCount: 3 }
    });
    expect(tikaParse).not.toHaveBeenCalled();
  });

  it("recognizes borderless and ragged GFM tables without losing escaped pipes", async () => {
    const boundary = createDocumentParserBoundary();

    const document = await boundary.parse({
      bytes: Buffer.from([
        "## Metrics",
        "label | value | note",
        ": --- | ---: | :--- :",
        String.raw`gross \| net | 42`,
        "operating | 37 | audited | retained"
      ].join("\r\n")),
      fileName: "metrics.markdown",
      mimeType: "text/markdown"
    });

    expect(document.blocks.map(({ headingPath, text, type }) => ({
      headingPath,
      text,
      type
    }))).toEqual([
      { headingPath: [], text: "Metrics", type: "heading" },
      {
        headingPath: ["Metrics"],
        text: "label\tvalue\tnote\ngross | net\t42\noperating\t37\taudited\tretained",
        type: "table"
      }
    ]);
    expect(document.blocks[1]?.table).toMatchObject({
      columnCount: 4,
      rowCount: 3
    });
  });

  it("keeps Markdown table examples inside fenced code as one code block", async () => {
    const boundary = createDocumentParserBoundary();

    const document = await boundary.parse({
      bytes: Buffer.from([
        "````md | example",
        "left | right",
        "--- | ---",
        "one | two",
        "```",
        "still fenced",
        "````"
      ].join("\n")),
      fileName: "syntax.md",
      mimeType: "text/markdown"
    });

    expect(document.blocks.map(({ text, type }) => [type, text])).toEqual([[
      "code",
      "left | right\n--- | ---\none | two\n```\nstill fenced"
    ]]);
  });

  it("sends Tika the raw bytes without the private basename", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://tika:9998/rmeta");
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBeInstanceOf(Blob);
      expect(init?.body).not.toBeInstanceOf(FormData);
      expect(new Headers(init?.headers).get("content-disposition")).toBe(
        'attachment; filename="document.doc"'
      );
      expect(new Headers(init?.headers).get("x-tika-ocrlanguage")).toBe("rus+eng");
      return new Response(JSON.stringify([{
        "Content-Type": "application/msword",
        "X-TIKA:content": "<html><body><p>binary document fixture</p></body></html>"
      }]), {
        headers: { "content-type": "application/json" }
      });
    });
    const boundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/") },
      fetch: fetchImpl
    });

    await expect(boundary.parse({
      bytes: Buffer.from("binary-doc"),
      fileName: 'SYNTHETIC_PRIVATE"; filename="leak.DOC',
      mimeType: "application/msword"
    })).resolves.toMatchObject({ engine: "tika", text: "binary document fixture" });
  });

  it("classifies parser rate limiting as retryable and preserves a bounded retry delay", async () => {
    const boundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/") },
      fetch: vi.fn<typeof fetch>(async () => new Response("private overload body", {
        headers: { "retry-after": "75" },
        status: 429
      })),
      sidecarFallback: false
    });

    await expect(boundary.parse({
      bytes: Buffer.from("docx-fixture"),
      fileName: "fixture.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    })).rejects.toMatchObject({
      code: "parser_unavailable",
      httpStatus: 429,
      retryAfterMs: 75_000
    });
  });

  it("classifies a parser invalid request as permanent", async () => {
    const boundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/") },
      fetch: vi.fn<typeof fetch>(async () => new Response("private rejection body", {
        status: 422
      })),
      sidecarFallback: false
    });

    await expect(boundary.parse({
      bytes: Buffer.from("corrupt-docx-fixture"),
      fileName: "fixture.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    })).rejects.toMatchObject({
      code: "parser_rejected",
      httpStatus: 422,
      retryAfterMs: null
    });
  });

  it("returns native-text PDF output without consulting a sidecar", async () => {
    const nativeDocument = parsed("native_pdf", "Metric\t6.7");
    const nativePdfParser = vi.fn(async () => ({
      classification: "native_text" as const,
      document: nativeDocument,
      reasonCode: null
    }));
    const tikaParse = vi.fn<DocumentParserEngineAdapter["parse"]>();
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toBe(nativeDocument);
    expect(nativePdfParser).toHaveBeenCalledOnce();
    expect(tikaParse).not.toHaveBeenCalled();
  });

  it("routes image-only PDFs to Tika with native quality evidence", async () => {
    const nativePdfParser = vi.fn(async () => ({
      classification: "image_only" as const,
      document: null,
      reasonCode: "native_pdf_image_heavy_low_text" as const
    }));
    const tikaParse = vi.fn(async () => parsed("tika", "ocr output"));
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) },
      config: {},
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({
      attempts: [
        {
          engine: "native_pdf",
          errorCode: null,
          outcome: "quality_failure",
          reasonCode: "native_pdf_image_heavy_low_text"
        },
        { engine: "tika", errorCode: null, outcome: "complete" }
      ],
      engine: "tika",
      text: "ocr output"
    });
    expect(nativePdfParser).toHaveBeenCalledOnce();
    expect(tikaParse).toHaveBeenCalledOnce();
  });

  it("does not hide a native PDF output bound behind a sidecar", async () => {
    const nativePdfParser = vi.fn(async () => {
      throw new DocumentParserError("parser_output_too_large", "native_pdf");
    });
    const tikaParse = vi.fn(async () => parsed("tika"));
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_output_too_large", engine: "native_pdf" });
    expect(tikaParse).not.toHaveBeenCalled();
  });

  it("keeps a usable partial result as partial", async () => {
    const primary = finalizeParsedDocument({
      ...parsed("tika", "usable partial text"),
      status: "partial"
    });
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: async () => primary }) }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({
      attempts: [{ engine: "tika", outcome: "partial" }],
      engine: "tika",
      status: "partial",
      warnings: expect.arrayContaining(["partial_parse"])
    });
  });

  it("rejects unusable output and never invokes the engine twice", async () => {
    const tikaParse = vi.fn(async () => finalizeParsedDocument({
      blocks: [],
      engine: "tika",
      mediaType: "application/pdf",
      pageCount: 2,
      status: "complete",
      text: ""
    }));
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_rejected", engine: "tika" });
    expect(tikaParse).toHaveBeenCalledOnce();
  });

  it("reports a hard output bound as such", async () => {
    const tikaParse = vi.fn(async () => { throw new DocumentParserError("parser_output_too_large", "tika"); });
    const boundary = createDocumentParserBoundary({
      adapters: { tika: fakeAdapter({ engine: "tika", parse: tikaParse }) }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_output_too_large", engine: "tika" });
    expect(tikaParse).toHaveBeenCalledOnce();
  });

  it("returns stable unavailable and rejection errors without configured parsers", async () => {
    const boundary = createDocumentParserBoundary({ config: {} });
    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_unavailable" });
    await expect(boundary.parse({
      bytes: Buffer.from("not a PDF"),
      fileName: "fixture.pdf",
      mimeType: "text/plain"
    })).rejects.toMatchObject({ code: "parser_rejected" });
  });

  it("rejects oversized input before transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const boundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/", { requestMaxBytes: 3 }) },
      fetch: fetchImpl
    });
    await expect(boundary.parse({
      bytes: Buffer.from("1234"),
      fileName: "fixture.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    })).rejects.toMatchObject({ code: "parser_rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes accepted input above the default cap when the upload cap is raised", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(tikaEnvelope),
      { headers: { "content-type": "application/json" } }
    ));
    const boundary = createDocumentParserBoundary({
      config: getDocumentParserConfig({
        AIQSA_TIKA_URL: "http://tika:9998",
        AIQSA_UPLOAD_MAX_BYTES: "50000000"
      }),
      fetch: fetchImpl
    });
    const bytes = Buffer.alloc(30_000_000);
    bytes.write("%PDF-");

    await expect(boundary.parse({
      bytes,
      fileName: "large.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({ engine: "tika", text: "fixture text" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stops reading an oversized response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("12345", {
      headers: { "content-length": "5" }
    }));
    const boundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/", { responseMaxBytes: 4 }) },
      fetch: fetchImpl
    });
    await expect(boundary.parse({
      bytes: Buffer.from("x"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_output_too_large" });
  });

  it("distinguishes parser timeouts from caller cancellation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const timeoutBoundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/", { timeoutMs: 5 }) },
      fetch: fetchImpl
    });
    await expect(timeoutBoundary.parse({
      bytes: Buffer.from("x"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_timeout" });

    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const cancelled = timeoutBoundary.parse({
      bytes: Buffer.from("x"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf",
      signal: controller.signal
    });
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
  });

  it("probes the configured engine without parsing a document", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("This is Tika Server. Please PUT"));
    const boundary = createDocumentParserBoundary({
      config: { tika: engineConfig("http://tika:9998/") },
      fetch: fetchImpl
    });

    await expect(boundary.probe()).resolves.toEqual({
      tika: { available: true, configured: true, engine: "tika" }
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(["http://tika:9998/tika"]);
  });
});
