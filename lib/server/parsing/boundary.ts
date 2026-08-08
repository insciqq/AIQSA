import { extractTextDocument } from "../uploads/textDocuments";
import { HttpDocumentParserEngineAdapter } from "./client";
import { getDocumentParserConfig, type DocumentParserConfig } from "./config";
import {
  DocumentParserError,
  isDocumentParserError,
  type DocumentParserErrorCode
} from "./errors";
import { resolveDocumentParserRoute } from "./routing";
import type {
  DocumentParseInput,
  DocumentParserEngineAdapter,
  DocumentParserProbe,
  ParsedDocument,
  ParsedDocumentBlock,
  ParserProbeResult,
  SidecarParserEngine
} from "./types";

export type DocumentParserBoundaryOptions = Readonly<{
  adapters?: Partial<Record<SidecarParserEngine, DocumentParserEngineAdapter>>;
  config?: DocumentParserConfig;
  fetch?: typeof fetch;
  inlineMaxChars?: number;
  sidecarFallback?: boolean;
}>;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function inlineDocument(
  input: DocumentParseInput,
  mediaType: string,
  maxChars: number | undefined
): ParsedDocument {
  const extracted = extractTextDocument(input.bytes, {
    fileName: input.fileName,
    ...(maxChars === undefined ? {} : { maxChars }),
    mimeType: mediaType
  });
  const blocks: ParsedDocumentBlock[] = extracted.text
    ? [Object.freeze({
        headingPath: Object.freeze([]),
        index: 0,
        isTable: extracted.kind === "csv",
        page: 1,
        text: extracted.text
      })]
    : [];

  return Object.freeze({
    blocks: Object.freeze(blocks),
    engine: "inline",
    mediaType,
    pageCount: 1,
    status: extracted.truncated ? "partial" : "complete",
    text: extracted.text
  });
}

function unavailable(engine: SidecarParserEngine): DocumentParserError {
  return new DocumentParserError("parser_unavailable", engine);
}

const errorPriority: readonly DocumentParserErrorCode[] = [
  "parser_output_too_large",
  "parser_timeout",
  "parser_rejected",
  "parser_invalid_output",
  "parser_unavailable"
];

function terminalError(errors: DocumentParserError[]): DocumentParserError {
  for (const code of errorPriority) {
    const error = errors.find((candidate) => candidate.code === code);
    if (error) return error;
  }
  return new DocumentParserError("parser_unavailable");
}

export class DocumentParserBoundary {
  readonly #adapters: Partial<Record<SidecarParserEngine, DocumentParserEngineAdapter>>;
  readonly #inlineMaxChars: number | undefined;
  readonly #sidecarFallback: boolean;

  constructor(options: DocumentParserBoundaryOptions = {}) {
    const config = options.config ?? getDocumentParserConfig();
    this.#adapters = {
      ...(config.docling ? {
        docling: new HttpDocumentParserEngineAdapter({
          config: config.docling,
          engine: "docling",
          fetch: options.fetch
        })
      } : {}),
      ...(config.tika ? {
        tika: new HttpDocumentParserEngineAdapter({
          config: config.tika,
          engine: "tika",
          fetch: options.fetch
        })
      } : {}),
      ...options.adapters
    };
    this.#inlineMaxChars = options.inlineMaxChars;
    this.#sidecarFallback = options.sidecarFallback ?? true;
  }

  async parse(input: DocumentParseInput): Promise<ParsedDocument> {
    if (input.signal?.aborted) throw abortReason(input.signal);
    if (input.bytes.byteLength === 0) throw new DocumentParserError("parser_rejected");

    const route = resolveDocumentParserRoute(input.fileName, input.mimeType);
    if (!route) throw new DocumentParserError("parser_rejected");
    if (route.kind === "inline") {
      return inlineDocument(input, route.mediaType, this.#inlineMaxChars);
    }

    const errors: DocumentParserError[] = [];
    const engines = this.#sidecarFallback ? route.engines : route.engines.slice(0, 1);
    for (const engine of engines) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      const adapter = this.#adapters[engine];
      if (!adapter) {
        errors.push(unavailable(engine));
        continue;
      }

      try {
        return await adapter.parse({ ...input, mediaType: route.mediaType });
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        errors.push(isDocumentParserError(error) ? error : unavailable(engine));
      }
    }

    throw terminalError(errors);
  }

  async probe(signal?: AbortSignal): Promise<DocumentParserProbe> {
    const probeEngine = async (engine: SidecarParserEngine): Promise<ParserProbeResult> => {
      const adapter = this.#adapters[engine];
      if (!adapter) {
        return { available: false, configured: false, engine, error: "parser_unavailable" };
      }
      try {
        return await adapter.probe(signal);
      } catch {
        if (signal?.aborted) throw abortReason(signal);
        return { available: false, configured: true, engine, error: "parser_unavailable" };
      }
    };

    const [docling, tika] = await Promise.all([
      probeEngine("docling"),
      probeEngine("tika")
    ]);
    return Object.freeze({ docling: Object.freeze(docling), tika: Object.freeze(tika) });
  }
}

export function createDocumentParserBoundary(
  options: DocumentParserBoundaryOptions = {}
): DocumentParserBoundary {
  return new DocumentParserBoundary(options);
}

export async function parseDocument(
  input: DocumentParseInput,
  options: DocumentParserBoundaryOptions = {}
): Promise<ParsedDocument> {
  return createDocumentParserBoundary(options).parse(input);
}

export async function probeDocumentParsers(
  options: DocumentParserBoundaryOptions = {},
  signal?: AbortSignal
): Promise<DocumentParserProbe> {
  return createDocumentParserBoundary(options).probe(signal);
}
