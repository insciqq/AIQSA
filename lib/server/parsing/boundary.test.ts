import { createDocumentParserBoundary } from "./boundary";
import type { ParserEngineConfig } from "./config";
import { DocumentParserError } from "./errors";
import type {
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

function parsed(engine: SidecarParserEngine, text = "parsed"): ParsedDocument {
  return {
    blocks: [{ headingPath: [], index: 0, isTable: false, page: 1, text }],
    engine,
    mediaType: "application/pdf",
    pageCount: 1,
    status: "complete",
    text
  };
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

  it("calls Docling with bounded multipart JSON output", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://docling:5001/v1/convert/file");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("to_formats")).toBe("json");
      expect(form.get("table_mode")).toBe("fast");
      expect(form.get("files")).toBeInstanceOf(Blob);
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
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({
      blocks: [{ page: 1, text: "fixture text" }],
      engine: "docling"
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

    await expect(boundary.parse({
      bytes: Buffer.from("%PDF-fixture"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    })).resolves.toMatchObject({ engine: "tika", text: "fallback" });
    expect(doclingParse).toHaveBeenCalledOnce();
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
