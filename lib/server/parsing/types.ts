import type {
  SidecarParserEngine as RegistrySidecarParserEngine
} from "../../domain/uploadFormats";
import type { KnowledgeProcessingWarningCode } from "../../domain/knowledgeProcessingWarnings";
import type { DocumentParserErrorCode } from "./errors";

export type SidecarParserEngine = RegistrySidecarParserEngine;
export type DocumentParserEngine =
  | "inline"
  | "native_pdf"
  | "spreadsheet"
  | "system_model_direct_pdf"
  | "system_model_vision"
  | SidecarParserEngine;

export type DocumentParseInput = Readonly<{
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  signal?: AbortSignal;
}>;

export type ParsedDocumentWarningCode = KnowledgeProcessingWarningCode;

export type ParsedDocumentBlockType =
  | "caption"
  | "code"
  | "footnote"
  | "heading"
  | "image"
  | "list_item"
  | "paragraph"
  | "table"
  | "title";

export type ParsedBoundingBox = Readonly<{
  bottom: number;
  coordinateOrigin: "bottom_left" | "top_left";
  left: number;
  page: number;
  right: number;
  top: number;
}>;

export type ParsedFieldCellLabel =
  | "checkbox"
  | "key"
  | "unspecified"
  | "value";

export type ParsedFieldLinkLabel =
  | "to_child"
  | "to_key"
  | "to_parent"
  | "to_value"
  | "unspecified";

/**
 * One parser-authored cell inside a form or key/value graph. Cell IDs are
 * local to their group and links are the only authority for relationships;
 * array order and geometry never imply a pairing.
 */
export type ParsedFieldCell = Readonly<{
  boundingBoxes: readonly ParsedBoundingBox[];
  confidence: number | null;
  id: number;
  itemRef: string | null;
  label: ParsedFieldCellLabel;
  order: number;
  originalText: string;
  text: string;
}>;

export type ParsedFieldLink = Readonly<{
  confidence: number | null;
  label: ParsedFieldLinkLabel;
  order: number;
  sourceCellId: number;
  targetCellId: number;
}>;

/**
 * A lossless bounded projection of one parser-authored form/key-value graph.
 * `readingOrder` is the insertion point in the parser block array: the group
 * occurred before that block index, or after the last block when equal to the
 * block count. Equal insertion points retain field-group array order.
 */
export type ParsedFieldGroup = Readonly<{
  boundingBoxes: readonly ParsedBoundingBox[];
  cells: readonly ParsedFieldCell[];
  confidence: number | null;
  kind: "form" | "key_value";
  links: readonly ParsedFieldLink[];
  page: number;
  pageEnd: number;
  readingOrder: number;
  sourceRef: string;
}>;

export type ParsedTableCell = Readonly<{
  column: number;
  columnSpan: number;
  row: number;
  rowSpan: number;
  text: string;
}>;

export type ParsedTable = Readonly<{
  cells: readonly ParsedTableCell[];
  columnCount: number;
  rowCount: number;
}>;

export type ParsedWorkbookCellType =
  | "blank"
  | "boolean"
  | "date"
  | "error"
  | "number"
  | "string";

export type ParsedWorkbookCell = Readonly<{
  address: string;
  column: number;
  display: string;
  formula: string | null;
  numberFormat: string | null;
  row: number;
  type: ParsedWorkbookCellType;
  value: boolean | number | string | null;
}>;

export type ParsedWorkbookRange = Readonly<{
  a1: string;
  columnEnd: number;
  columnStart: number;
  rowEnd: number;
  rowStart: number;
}>;

export type ParsedWorkbookRegion = ParsedWorkbookRange & Readonly<{
  columnLabels: readonly string[];
  headerRow: number | null;
  rowLabelColumns: readonly number[];
}>;

export type ParsedWorkbookSheet = Readonly<{
  cells: readonly ParsedWorkbookCell[];
  columnCount: number;
  hidden: "hidden" | "very_hidden" | "visible";
  hiddenColumns: readonly number[];
  hiddenRows: readonly number[];
  index: number;
  merges: readonly ParsedWorkbookRange[];
  name: string;
  regions: readonly ParsedWorkbookRegion[];
  rowCount: number;
  truncated: boolean;
}>;

export type ParsedWorkbookWarningCode =
  | "duplicate_headers"
  | "external_links_ignored"
  | "formula_like_text"
  | "formula_without_cached_value"
  | "hidden_data_present"
  | "macros_ignored"
  | "spreadsheet_cells_truncated"
  | "spreadsheet_rows_truncated"
  | "unsupported_cell_type";

export type ParsedWorkbook = Readonly<{
  dateSystem: "1900" | "1904";
  sheets: readonly ParsedWorkbookSheet[];
  warnings: readonly ParsedWorkbookWarningCode[];
}>;

export type ParsedDocumentAsset = Readonly<{
  boundingBoxes: readonly ParsedBoundingBox[];
  caption: string | null;
  id: string;
  kind: "chart" | "diagram" | "image";
  page: number;
}>;

/**
 * A structure-aware superset of the old uploads/PdfTextChunk projection.
 * `page`, `isTable`, and `text` stay explicit for compatibility while v2
 * consumers retain exact structure and locators.
 */
export type ParsedDocumentBlock = Readonly<{
  assetIds: readonly string[];
  boundingBoxes: readonly ParsedBoundingBox[];
  headingPath: readonly string[];
  index: number;
  isTable: boolean;
  languageHints: readonly string[];
  page: number;
  pageEnd: number;
  readingOrder: number;
  table: ParsedTable | null;
  text: string;
  type: ParsedDocumentBlockType;
}>;

export type ParsedDocumentQuality = Readonly<{
  characterCount: number;
  coveredPageCount: number;
  duplicateFurnitureRatio: number;
  emptyPageRatio: number;
  encodingValid: boolean;
  headingCount: number;
  ocrConfidence: number | null;
  pageCoverage: number;
  tableCount: number;
  usableBlockCount: number;
}>;

export type ParserAttemptOutcome =
  | "complete"
  | "partial"
  | "quality_failure"
  | "rejected"
  | "retryable_failure";

export type ParsedDocumentParserAttempt = Readonly<{
  engine: DocumentParserEngine;
  errorCode: DocumentParserErrorCode | null;
  outcome: ParserAttemptOutcome;
}>;

export type ParsedDocument = Readonly<{
  assets: readonly ParsedDocumentAsset[];
  attempts: readonly ParsedDocumentParserAttempt[];
  blocks: readonly ParsedDocumentBlock[];
  engine: DocumentParserEngine;
  fieldGroups: readonly ParsedFieldGroup[];
  languages: readonly string[];
  mediaType: string;
  pageCount: number;
  quality: ParsedDocumentQuality;
  status: "complete" | "partial";
  text: string;
  warnings: readonly ParsedDocumentWarningCode[];
  workbook: ParsedWorkbook | null;
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

/** Injection boundary used by deterministic tests and service adapters. */
export interface DocumentParserEngineAdapter {
  parse(input: SidecarParseInput): Promise<ParsedDocument>;
  probe(signal?: AbortSignal): Promise<ParserProbeResult>;
}
