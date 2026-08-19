import {
  KNOWLEDGE_PROCESSING_WARNING_CODES,
  type KnowledgeProcessingWarningCode
} from "../contracts/knowledge";

export { KNOWLEDGE_PROCESSING_WARNING_CODES };
export type { KnowledgeProcessingWarningCode };

export const KNOWLEDGE_PROCESSING_WARNING_LABELS: Readonly<
  Record<KnowledgeProcessingWarningCode, string>
> = Object.freeze({
  embedded_object_unsupported: "Some embedded objects could not be read",
  low_ocr_confidence: "Some scanned text may be inaccurate",
  low_page_coverage: "Only part of the document could be read",
  low_text_density: "Very little searchable text was found",
  parser_fallback_failed: "The backup parser could not improve the result",
  partial_parse: "The usable part is searchable",
  repeated_header_footer: "Repeated page furniture was filtered",
  table_extraction_degraded: "Some table structure was simplified",
  truncated_oversized_section: "An oversized section was truncated",
  unreadable_pages: "Some pages could not be read"
});
