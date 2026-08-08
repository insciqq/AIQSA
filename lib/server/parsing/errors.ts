import type { SidecarParserEngine } from "./types";

export type DocumentParserErrorCode =
  | "parser_unavailable"
  | "parser_timeout"
  | "parser_rejected"
  | "parser_output_too_large"
  | "parser_invalid_output";

export class DocumentParserError extends Error {
  readonly code: DocumentParserErrorCode;
  readonly engine?: SidecarParserEngine;

  constructor(code: DocumentParserErrorCode, engine?: SidecarParserEngine) {
    super(code);
    this.name = "DocumentParserError";
    this.code = code;
    this.engine = engine;
  }
}

export function isDocumentParserError(error: unknown): error is DocumentParserError {
  return error instanceof DocumentParserError;
}
