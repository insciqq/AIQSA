import { createHash } from "node:crypto";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import {
  createDocumentParserBoundary,
  extractHtmlTextInIsolation,
  isDocumentParserError,
  type DocumentParserBoundary
} from "../parsing";
import { getAttachmentTextConfig } from "./attachmentTextConfig";
import { extractImageMetadata } from "./imageMetadata";
import { extractPdfTextChunks, isPdfExtractionError } from "./pdf";
import { getPdfExtractionConfig } from "./pdfConfig";
import { isStoredObjectTooLargeError, type StorageAdapter } from "./storage";

export type AttachmentProcessingErrorCode =
  | "animated_gif_not_supported"
  | "attachment_checksum_mismatch"
  | "attachment_object_read_failed"
  | "attachment_object_size_mismatch"
  | "attachment_processing_attempts_exhausted"
  | "attachment_processing_failed"
  | "parser_invalid_output"
  | "parser_output_too_large"
  | "parser_rejected"
  | "parser_timeout"
  | "parser_unavailable"
  | "pdf_extraction_failed"
  | "pdf_extraction_timeout"
  | "pdf_invalid"
  | "pdf_page_limit_exceeded"
  | "pdf_password_required";

export type AttachmentProcessingRecord = Readonly<{
  attemptCount: number;
  byteSize: number;
  checksum: string | null;
  claimToken: string;
  fileName: string;
  id: string;
  jobId: string;
  kind: string;
  mimeType: string;
  storageKey: string;
}>;

export type AttachmentProcessingResult = Readonly<{
  extractedText: string | null;
  metadata: Record<string, unknown>;
}>;

export class AttachmentProcessingError extends Error {
  readonly code: AttachmentProcessingErrorCode;
  readonly retryable: boolean;

  constructor(code: AttachmentProcessingErrorCode, retryable = false) {
    super(code);
    this.name = "AttachmentProcessingError";
    this.code = code;
    this.retryable = retryable;
  }
}

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: takeUtf16SafePrefix(text, maxChars), truncated: true }
    : { text, truncated: false };
}

function processingError(error: unknown): AttachmentProcessingError {
  if (error instanceof AttachmentProcessingError) return error;
  if (isDocumentParserError(error)) {
    return new AttachmentProcessingError(
      error.code,
      error.code === "parser_timeout" || error.code === "parser_unavailable"
    );
  }
  if (isPdfExtractionError(error)) {
    return new AttachmentProcessingError(
      error.code,
      error.code === "pdf_extraction_timeout" || error.code === "pdf_extraction_failed"
    );
  }
  return new AttachmentProcessingError("attachment_processing_failed", true);
}

type HtmlTextExtractor = typeof extractHtmlTextInIsolation;

async function htmlFallback(
  record: AttachmentProcessingRecord,
  bytes: Buffer,
  maxChars: number,
  signal: AbortSignal | undefined,
  extractHtmlText: HtmlTextExtractor
): Promise<AttachmentProcessingResult | null> {
  if (!/\.html?$/iu.test(record.fileName)) return null;
  const extracted = await extractHtmlText({ bytes, maxChars, ...(signal ? { signal } : {}) });
  return {
    extractedText: extracted.text || null,
    metadata: {
      document: {
        characterCount: extracted.text.length,
        engine: "inline",
        extractedTextMaxChars: maxChars,
        kind: extracted.kind,
        status: extracted.truncated ? "partial" : "complete",
        truncated: extracted.truncated
      }
    }
  };
}

async function processPdfFallback(
  bytes: Buffer,
  signal: AbortSignal | undefined
): Promise<AttachmentProcessingResult> {
  const extraction = await extractPdfTextChunks(bytes, {
    config: getPdfExtractionConfig(),
    signal
  });
  return {
    extractedText: extraction.text || null,
    metadata: {
      pdf: {
        chunks: extraction.chunks,
        extractedCharacterCount: extraction.extractedCharacterCount,
        extractedTextMaxChars: getPdfExtractionConfig().extractedTextMaxChars,
        pageCount: extraction.pageCount,
        pagesProcessed: extraction.pagesProcessed,
        parserEngine: "unpdf",
        status: extraction.status,
        ...(extraction.truncationReason
          ? { truncationReason: extraction.truncationReason }
          : {})
      }
    }
  };
}

async function parseDocument(
  parser: Pick<DocumentParserBoundary, "parse">,
  extractHtmlText: HtmlTextExtractor,
  record: AttachmentProcessingRecord,
  bytes: Buffer,
  signal: AbortSignal | undefined
): Promise<AttachmentProcessingResult> {
  const maxChars = getAttachmentTextConfig().extractedTextMaxChars;
  try {
    const parsed = await parser.parse({
      bytes,
      fileName: record.fileName,
      mimeType: record.mimeType,
      ...(signal ? { signal } : {})
    });
    if (record.kind === "pdf" && parsed.pageCount > getPdfExtractionConfig().maxPages) {
      throw new AttachmentProcessingError("pdf_page_limit_exceeded");
    }
    const capped = capText(parsed.text, maxChars);
    const pdfStatus = capped.truncated ? "partial" :
      capped.text ? "complete" : "no_text";
    // Inline and spreadsheet extraction stop at the same cap before this one
    // and report it as `truncated_oversized_section`; a parser-side partial
    // result is incomplete even when its text fits.
    const truncated = capped.truncated ||
      parsed.warnings.includes("truncated_oversized_section");
    const details = {
      characterCount: capped.text.length,
      engine: parsed.engine,
      extractedTextMaxChars: maxChars,
      pageCount: parsed.pageCount,
      parserStatus: parsed.status,
      status: truncated ? "partial" : !capped.text ? "no_text" :
        parsed.status === "partial" ? "partial" : "complete",
      truncated,
      warnings: [...parsed.warnings]
    };
    return {
      extractedText: capped.text || null,
      metadata: record.kind === "pdf"
        ? {
            pdf: {
              extractedCharacterCount: capped.text.length,
              extractedTextMaxChars: maxChars,
              pageCount: parsed.pageCount,
              pagesProcessed: parsed.pageCount,
              parserEngine: parsed.engine,
              status: pdfStatus,
              ...(capped.truncated ? { truncationReason: "text_limit" } : {})
            }
          }
        : { document: details }
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (
      isDocumentParserError(error) &&
      (error.code === "parser_unavailable" || error.code === "parser_timeout")
    ) {
      if (record.kind === "pdf") {
        return processPdfFallback(bytes, signal);
      }
      const fallback = await htmlFallback(record, bytes, maxChars, signal, extractHtmlText);
      if (fallback) return fallback;
    }
    throw error;
  }
}

export function createAttachmentProcessor(input: Readonly<{
  htmlTextExtractor?: HtmlTextExtractor;
  parser?: Pick<DocumentParserBoundary, "parse">;
  storage: Pick<StorageAdapter, "getObject">;
}>) {
  // Invalid operator limits fail processor startup visibly, not each job.
  getAttachmentTextConfig();
  const parser = input.parser ?? createDocumentParserBoundary();
  const extractHtmlText = input.htmlTextExtractor ?? extractHtmlTextInIsolation;

  return async function processAttachment(
    record: AttachmentProcessingRecord,
    signal?: AbortSignal
  ): Promise<AttachmentProcessingResult> {
    try {
      let object: Awaited<ReturnType<StorageAdapter["getObject"]>>;
      try {
        object = await input.storage.getObject(record.storageKey, {
          maxBytes: record.byteSize,
          ...(signal ? { signal } : {})
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new AttachmentProcessingError(
          isStoredObjectTooLargeError(error)
            ? "attachment_object_size_mismatch"
            : "attachment_object_read_failed",
          !isStoredObjectTooLargeError(error)
        );
      }
      if (object.body.byteLength !== record.byteSize) {
        throw new AttachmentProcessingError("attachment_object_size_mismatch");
      }
      if (record.checksum && checksum(object.body) !== record.checksum) {
        throw new AttachmentProcessingError("attachment_checksum_mismatch");
      }

      if (record.kind === "image") {
        const image = extractImageMetadata(object.body, record.mimeType);
        if (image.format === "gif" && image.animated) {
          throw new AttachmentProcessingError("animated_gif_not_supported");
        }
        return { extractedText: null, metadata: { image } };
      }
      if (record.kind !== "document" && record.kind !== "pdf") {
        throw new AttachmentProcessingError("parser_rejected");
      }
      return await parseDocument(parser, extractHtmlText, record, object.body, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw processingError(error);
    }
  };
}
