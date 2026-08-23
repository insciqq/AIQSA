import { extractTextDocument } from "../uploads/textDocuments";
import {
  finalizeParsedDocument,
  parsedDocumentNeedsFallback,
  parsedDocumentQualityScore,
  parsedLanguageHints,
  withParserEvidence
} from "./assessment";
import { HttpDocumentParserEngineAdapter } from "./client";
import { getDocumentParserConfig, type DocumentParserConfig } from "./config";
import {
  DocumentParserError,
  isDocumentParserError,
  type DocumentParserErrorCode
} from "./errors";
import {
  parseNativeTextPdf,
  type NativePdfParserOptions
} from "./nativePdf";
import { resolveDocumentParserRoute } from "./routing";
import { parseSpreadsheetDocument } from "./spreadsheet";
import type {
  DocumentParseInput,
  DocumentParserEngine,
  DocumentParserEngineAdapter,
  DocumentParserProbe,
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedDocumentParserAttempt,
  ParserProbeResult,
  SidecarParserEngine
} from "./types";

export type DocumentParserBoundaryOptions = Readonly<{
  adapters?: Partial<Record<SidecarParserEngine, DocumentParserEngineAdapter>>;
  config?: DocumentParserConfig;
  fetch?: typeof fetch;
  inlineMaxChars?: number;
  nativePdfLimits?: Omit<NativePdfParserOptions, "createWorker">;
  nativePdfParser?: typeof parseNativeTextPdf;
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
        assetIds: Object.freeze([]),
        boundingBoxes: Object.freeze([]),
        headingPath: Object.freeze([]),
        index: 0,
        isTable: extracted.kind === "csv",
        languageHints: parsedLanguageHints(extracted.text),
        page: 1,
        pageEnd: 1,
        readingOrder: 0,
        table: null,
        text: extracted.text,
        type: extracted.kind === "csv"
          ? "table"
          : extracted.kind === "json"
            ? "code"
            : "paragraph"
      })]
    : [];

  const status = extracted.truncated ? "partial" : "complete";
  return finalizeParsedDocument({
    attempts: [{
      engine: "inline",
      errorCode: null,
      outcome: status
    }],
    blocks,
    engine: "inline",
    mediaType,
    pageCount: 1,
    status,
    text: extracted.text,
    warnings: extracted.truncated ? ["truncated_oversized_section"] : []
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

function attemptForError(
  engine: DocumentParserEngine,
  error: DocumentParserError
): ParsedDocumentParserAttempt {
  return Object.freeze({
    engine,
    errorCode: error.code,
    outcome: error.code === "parser_unavailable" || error.code === "parser_timeout"
      ? "retryable_failure"
      : "rejected"
  });
}

export class DocumentParserBoundary {
  readonly #adapters: Partial<Record<SidecarParserEngine, DocumentParserEngineAdapter>>;
  readonly #inlineMaxChars: number | undefined;
  readonly #nativePdfLimits: Omit<NativePdfParserOptions, "createWorker"> | undefined;
  readonly #nativePdfParser: typeof parseNativeTextPdf;
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
    this.#nativePdfLimits = options.nativePdfLimits;
    this.#nativePdfParser = options.nativePdfParser ?? parseNativeTextPdf;
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
    if (route.kind === "spreadsheet") {
      return parseSpreadsheetDocument({ ...input, mimeType: route.mediaType }, {
        maxCharacters: this.#inlineMaxChars
      });
    }

    const errors: DocumentParserError[] = [];
    const attempts: ParsedDocumentParserAttempt[] = [];
    const candidates: ParsedDocument[] = [];
    if (route.mediaType === "application/pdf" && this.#nativePdfLimits) {
      try {
        const native = await this.#nativePdfParser({
          ...input,
          mimeType: route.mediaType
        }, this.#nativePdfLimits);
        if (native.document) return native.document;
        attempts.push(Object.freeze({
          engine: "native_pdf",
          errorCode: null,
          outcome: "quality_failure"
        }));
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        const normalized = isDocumentParserError(error)
          ? error
          : new DocumentParserError("parser_unavailable", "native_pdf");
        if (normalized.code === "parser_output_too_large") throw normalized;
        errors.push(normalized);
        attempts.push(attemptForError("native_pdf", normalized));
      }
    }
    const engines = this.#sidecarFallback ? route.engines : route.engines.slice(0, 1);
    for (const engine of engines) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      const adapter = this.#adapters[engine];
      if (!adapter) {
        const error = unavailable(engine);
        errors.push(error);
        attempts.push(attemptForError(engine, error));
        continue;
      }

      try {
        const parsed = await adapter.parse({ ...input, mediaType: route.mediaType });
        const qualityFailure = parsedDocumentNeedsFallback(parsed);
        attempts.push(Object.freeze({
          engine,
          errorCode: null,
          outcome: parsed.quality.usableBlockCount === 0 || !parsed.quality.encodingValid
            ? "quality_failure"
            : parsed.status === "partial"
              ? "partial"
              : qualityFailure
                ? "quality_failure"
                : "complete"
        }));
        if (parsed.quality.usableBlockCount > 0 && parsed.quality.encodingValid) {
          candidates.push(parsed);
        } else {
          errors.push(new DocumentParserError("parser_rejected", engine));
        }
        if (!qualityFailure) return withParserEvidence(parsed, attempts);
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        const normalized = isDocumentParserError(error) ? error : unavailable(engine);
        errors.push(normalized);
        attempts.push(attemptForError(engine, normalized));
        if (normalized.code === "parser_output_too_large") throw normalized;
      }
    }

    if (candidates.length > 0) {
      const best = [...candidates].sort((left, right) =>
        parsedDocumentQualityScore(right) - parsedDocumentQualityScore(left)
      )[0]!;
      const selectedAttemptIndex = attempts.findIndex((attempt) =>
        attempt.engine === best.engine &&
        (attempt.outcome === "complete" || attempt.outcome === "partial" ||
          attempt.outcome === "quality_failure")
      );
      const fallbackFailedAfterSelectedResult = selectedAttemptIndex >= 0 &&
        attempts.slice(selectedAttemptIndex + 1).some((attempt) =>
          attempt.outcome === "quality_failure" || attempt.outcome === "rejected" ||
          attempt.outcome === "retryable_failure"
        );
      return withParserEvidence(best, attempts, {
        additionalWarnings: fallbackFailedAfterSelectedResult ? ["parser_fallback_failed"] : [],
        forcePartial: parsedDocumentNeedsFallback(best)
      });
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
