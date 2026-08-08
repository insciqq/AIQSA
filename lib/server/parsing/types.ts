export type SidecarParserEngine = "docling" | "tika";

export type DocumentParserEngine = "inline" | SidecarParserEngine;

export type DocumentParseInput = Readonly<{
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  signal?: AbortSignal;
}>;

/**
 * A structure-aware superset of uploads/PdfTextChunk. Consumers that only
 * understand index/page/text can use these blocks without translation.
 */
export type ParsedDocumentBlock = Readonly<{
  headingPath: readonly string[];
  index: number;
  isTable: boolean;
  page: number;
  text: string;
}>;

export type ParsedDocument = Readonly<{
  blocks: readonly ParsedDocumentBlock[];
  engine: DocumentParserEngine;
  mediaType: string;
  pageCount: number;
  status: "complete" | "partial";
  text: string;
}>;

export type ParserProbeResult = Readonly<{
  available: boolean;
  configured: boolean;
  engine: SidecarParserEngine;
  error?: "parser_invalid_output" | "parser_timeout" | "parser_unavailable";
}>;

export type DocumentParserProbe = Readonly<Record<SidecarParserEngine, ParserProbeResult>>;

export type SidecarParseInput = DocumentParseInput & Readonly<{
  mediaType: string;
}>;

/** Injection boundary used by deterministic tests and later service adapters. */
export interface DocumentParserEngineAdapter {
  parse(input: SidecarParseInput): Promise<ParsedDocument>;
  probe(signal?: AbortSignal): Promise<ParserProbeResult>;
}
