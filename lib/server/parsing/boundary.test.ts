import { createDocumentParserBoundary } from "./boundary";
import { finalizeParsedDocument } from "./assessment";
import { getDocumentParserConfig, type ParserEngineConfig } from "./config";
import { DocumentParserError } from "./errors";
import {
  PDF_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION,
  PDF_SEGMENTED_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION
} from "./ocrSupplement";
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

const doclingEnvelope = {
  document: {
    json_content: {
      body: { children: [{ $ref: "#/texts/0" }] },
      groups: [],
      pages: { "1": { page_no: 1 } },
      schema_name: "DoclingDocument",
      tables: [],
      texts: [{ content_layer: "body", label: "paragraph", prov: [{ page_no: 1 }], text: "fixture text" }]
    }
  },
  status: "success"
};

describe("document parser boundary", () => {
  it("keeps plain text in process without consulting a sidecar", async () => {
    const doclingParse = vi.fn<DocumentParserEngineAdapter["parse"]>();
    const boundary = createDocumentParserBoundary({
      adapters: { docling: fakeAdapter({ engine: "docling", parse: doclingParse }) }
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
    expect(doclingParse).not.toHaveBeenCalled();
  });

  it("replaces a hostile private basename in the Docling multipart filename", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://docling:5001/v1/convert/file");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("to_formats")).toBe("json");
      expect(form.get("table_mode")).toBe("accurate");
      expect(form.get("do_ocr")).toBe("true");
      expect(form.get("force_ocr")).toBe("false");
      expect(form.get("ocr_preset")).toBe("easyocr");
      expect(form.getAll("ocr_lang")).toEqual(["ru", "en"]);
      const file = form.get("files");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("document.pdf");
      return new Response(JSON.stringify(doclingEnvelope), {
        headers: { "content-type": "application/json" }
      });
    });
    const boundary = createDocumentParserBoundary({
      config: { docling: engineConfig("http://docling:5001/") },
      fetch: fetchImpl
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: 'SYNTHETIC_PRIVATE"; filename="leak.PDF',
      mimeType: "application/pdf"
    })).resolves.toMatchObject({
      blocks: [{ page: 1, text: "fixture text" }],
      engine: "docling"
    });
  });

  it("does not send Docling OCR fields or a private basename to Tika", async () => {
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
      config: { docling: engineConfig("http://docling:5001/") },
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
      config: { docling: engineConfig("http://docling:5001/") },
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

  it("falls back from a rejected Docling parse to Tika", async () => {
    const doclingParse = vi.fn<DocumentParserEngineAdapter["parse"]>(async () => {
      throw new DocumentParserError("parser_rejected", "docling");
    });
    const tikaParse = vi.fn<DocumentParserEngineAdapter["parse"]>(async () => parsed("tika", "fallback"));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: doclingParse }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      }
    });

    const result = await boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    });
    expect(result).toMatchObject({
      attempts: [
        { engine: "docling", outcome: "rejected" },
        { engine: "tika", outcome: "complete" }
      ],
      engine: "tika",
      text: "fallback"
    });
    expect(result.warnings).not.toContain("parser_fallback_failed");
    expect(doclingParse).toHaveBeenCalledOnce();
    expect(tikaParse).toHaveBeenCalledOnce();
  });

  it("returns native-text PDF output without consulting a sidecar", async () => {
    const nativeDocument = parsed("native_pdf", "Metric\t6.7");
    const nativePdfParser = vi.fn(async () => ({
      classification: "native_text" as const,
      document: nativeDocument,
      reasonCode: null
    }));
    const doclingParse = vi.fn<DocumentParserEngineAdapter["parse"]>();
    const boundary = createDocumentParserBoundary({
      adapters: { docling: fakeAdapter({ engine: "docling", parse: doclingParse }) },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toBe(nativeDocument);
    expect(nativePdfParser).toHaveBeenCalledOnce();
    expect(doclingParse).not.toHaveBeenCalled();
  });

  it("routes image-only PDFs to Docling with native quality evidence", async () => {
    const nativePdfParser = vi.fn(async () => ({
      classification: "image_only" as const,
      document: null,
      reasonCode: "native_pdf_image_heavy_low_text" as const
    }));
    const doclingParse = vi.fn(async () => parsed("docling", "ocr output"));
    const boundary = createDocumentParserBoundary({
      adapters: { docling: fakeAdapter({ engine: "docling", parse: doclingParse }) },
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
        { engine: "docling", errorCode: null, outcome: "complete" }
      ],
      engine: "docling",
      text: "ocr output"
    });
    expect(nativePdfParser).toHaveBeenCalledOnce();
    expect(doclingParse).toHaveBeenCalledOnce();
  });

  it("supplements image-heavy Docling structure with materially novel Tika OCR", async () => {
    const nativePdfParser = vi.fn(async () => ({
      classification: "image_only" as const,
      document: null,
      reasonCode: "native_pdf_image_heavy_low_text" as const
    }));
    const doclingParse = vi.fn(async () => parsed("docling", "Category alpha 10 Category beta"));
    const tikaParse = vi.fn(async () => parsed("tika", "Category alpha 10 Category beta 20"));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: doclingParse }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf",
      parserProfileVersion: PDF_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION
    })).resolves.toMatchObject({
      attempts: [
        { engine: "native_pdf", outcome: "quality_failure" },
        { engine: "docling", outcome: "complete" },
        { engine: "tika", outcome: "complete" }
      ],
      blocks: [
        { index: 0, text: "Category alpha 10 Category beta" },
        { index: 1, page: 1, text: "Category alpha 10 Category beta 20" }
      ],
      engine: "docling"
    });
    expect(doclingParse).toHaveBeenCalledOnce();
    expect(tikaParse).toHaveBeenCalledOnce();
  });

  it("keeps an older immutable parser profile on its original single-parser behavior", async () => {
    const nativePdfParser = vi.fn(async () => ({
      classification: "image_only" as const,
      document: null,
      reasonCode: "native_pdf_image_heavy_low_text" as const
    }));
    const doclingParse = vi.fn(async () => parsed("docling", "profile-seven output"));
    const tikaParse = vi.fn(async () => parsed("tika", "newer OCR output"));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: doclingParse }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf",
      parserProfileVersion: PDF_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION - 1
    })).resolves.toMatchObject({ engine: "docling", text: "profile-seven output" });
    expect(doclingParse).toHaveBeenCalledOnce();
    expect(tikaParse).not.toHaveBeenCalled();
  });

  it("segments fallback OCR only in parser profile 9", async () => {
    const nativePdfParser = vi.fn(async () => ({
      classification: "image_only" as const,
      document: null,
      reasonCode: "native_pdf_image_heavy_low_text" as const
    }));
    const doclingParse = vi.fn(async () => parsed("docling", "Revenue 10 percent"));
    const tikaParse = vi.fn(async () => parsed(
      "tika",
      "Revenue — 10 percent\n\nCategory gamma 20"
    ));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: doclingParse }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf",
      parserProfileVersion: PDF_SEGMENTED_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION
    })).resolves.toMatchObject({
      blocks: [
        { text: "Revenue 10 percent" },
        { text: "Category gamma 20" }
      ],
      engine: "docling"
    });
  });

  it("does not hide a native PDF output bound behind a sidecar", async () => {
    const nativePdfParser = vi.fn(async () => {
      throw new DocumentParserError("parser_output_too_large", "native_pdf");
    });
    const doclingParse = vi.fn(async () => parsed("docling"));
    const boundary = createDocumentParserBoundary({
      adapters: { docling: fakeAdapter({ engine: "docling", parse: doclingParse }) },
      nativePdfLimits: { maxBlocks: 100, maxCharacters: 1_000, maxPages: 10 },
      nativePdfParser
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_output_too_large", engine: "native_pdf" });
    expect(doclingParse).not.toHaveBeenCalled();
  });

  it("keeps a usable partial result when the bounded fallback is unavailable", async () => {
    const primary = finalizeParsedDocument({
      ...parsed("docling", "usable partial text"),
      status: "partial"
    });
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: async () => primary }),
        tika: fakeAdapter({
          engine: "tika",
          parse: async () => { throw new DocumentParserError("parser_unavailable", "tika"); }
        })
      }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({
      attempts: [
        { engine: "docling", outcome: "partial" },
        { engine: "tika", outcome: "retryable_failure" }
      ],
      engine: "docling",
      status: "partial",
      warnings: expect.arrayContaining(["partial_parse", "parser_fallback_failed"])
    });
  });

  it("falls back from unusable output and never invokes an engine twice", async () => {
    const doclingParse = vi.fn(async () => finalizeParsedDocument({
      blocks: [],
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 2,
      status: "complete",
      text: ""
    }));
    const tikaParse = vi.fn(async () => parsed("tika", "useful fallback text"));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: doclingParse }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({ engine: "tika", status: "complete" });
    expect(doclingParse).toHaveBeenCalledOnce();
    expect(tikaParse).toHaveBeenCalledOnce();
  });

  it("does not hide a hard output bound behind another parser", async () => {
    const tikaParse = vi.fn(async () => parsed("tika"));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({
          engine: "docling",
          parse: async () => { throw new DocumentParserError("parser_output_too_large", "docling"); }
        }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      }
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_output_too_large", engine: "docling" });
    expect(tikaParse).not.toHaveBeenCalled();
  });

  it("can pin Knowledge parsing to the first code-owned engine without fallback", async () => {
    const doclingParse = vi.fn<DocumentParserEngineAdapter["parse"]>(async () => {
      throw new DocumentParserError("parser_unavailable", "docling");
    });
    const tikaParse = vi.fn<DocumentParserEngineAdapter["parse"]>(async () => parsed("tika", "fallback"));
    const boundary = createDocumentParserBoundary({
      adapters: {
        docling: fakeAdapter({ engine: "docling", parse: doclingParse }),
        tika: fakeAdapter({ engine: "tika", parse: tikaParse })
      },
      sidecarFallback: false
    });

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).rejects.toMatchObject({ code: "parser_unavailable", engine: "docling" });
    expect(doclingParse).toHaveBeenCalledOnce();
    expect(tikaParse).not.toHaveBeenCalled();
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
      config: { docling: engineConfig("http://docling:5001/", { requestMaxBytes: 3 }) },
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
      JSON.stringify(doclingEnvelope),
      { headers: { "content-type": "application/json" } }
    ));
    const boundary = createDocumentParserBoundary({
      config: getDocumentParserConfig({
        AIQSA_DOCLING_URL: "http://docling:5001",
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
    })).resolves.toMatchObject({ engine: "docling", text: "fixture text" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stops reading an oversized response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("12345", {
      headers: { "content-length": "5" }
    }));
    const boundary = createDocumentParserBoundary({
      config: { docling: engineConfig("http://docling:5001/", { responseMaxBytes: 4 }) },
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
      config: { docling: engineConfig("http://docling:5001/", { timeoutMs: 5 }) },
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

  it("probes configured engines without parsing a document", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/health")
      ? new Response('{"status":"ok"}')
      : new Response("This is Tika Server. Please PUT"));
    const boundary = createDocumentParserBoundary({
      config: {
        docling: engineConfig("http://docling:5001/"),
        tika: engineConfig("http://tika:9998/")
      },
      fetch: fetchImpl
    });

    await expect(boundary.probe()).resolves.toEqual({
      docling: { available: true, configured: true, engine: "docling" },
      tika: { available: true, configured: true, engine: "tika" }
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://docling:5001/health",
      "http://tika:9998/tika"
    ]);
  });
});
