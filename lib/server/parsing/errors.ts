import type { DocumentParserEngine } from "./types";

export type DocumentParserErrorCode =
  | "parser_unavailable"
  | "parser_timeout"
  | "parser_rejected"
  | "parser_output_too_large"
  | "parser_invalid_output";

export class DocumentParserError extends Error {
  readonly code: DocumentParserErrorCode;
  readonly engine?: DocumentParserEngine;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    code: DocumentParserErrorCode,
    engine?: DocumentParserEngine,
    options: Readonly<{ httpStatus?: number; retryAfterMs?: number | null }> = {}
  ) {
    super(code);
    this.name = "DocumentParserError";
    this.code = code;
    this.engine = engine;
    this.httpStatus = Number.isSafeInteger(options.httpStatus) &&
      Number(options.httpStatus) >= 100 && Number(options.httpStatus) <= 599
      ? Number(options.httpStatus)
      : null;
    this.retryAfterMs = Number.isSafeInteger(options.retryAfterMs) &&
      Number(options.retryAfterMs) > 0
      ? Number(options.retryAfterMs)
      : null;
  }
}

export function isDocumentParserError(error: unknown): error is DocumentParserError {
  return error instanceof DocumentParserError;
}
