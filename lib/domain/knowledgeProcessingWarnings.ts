import {
  KNOWLEDGE_PROCESSING_WARNING_CODES,
  type KnowledgeProcessingWarningCode
} from "../contracts/knowledge";

export { KNOWLEDGE_PROCESSING_WARNING_CODES };
export type { KnowledgeProcessingWarningCode };

export const KNOWLEDGE_PROCESSING_NOTES: Readonly<
  Record<KnowledgeProcessingWarningCode, string>
> = Object.freeze({
  embedded_object_unsupported: "Some embedded objects could not be read.",
  low_ocr_confidence: "Scanned text may contain recognition errors.",
  low_page_coverage: "Only part of the pages could be read.",
  low_text_density: "Very little searchable text was found.",
  parser_fallback_failed: "Some content could not be read. The available text is searchable.",
  partial_parse: "Part of the file could not be read. The rest is searchable.",
  repeated_header_footer: "Repeated headers and footers were skipped.",
  table_extraction_degraded: "Some table structure was simplified. Its text is searchable.",
  truncated_oversized_section: "An oversized section was shortened.",
  unreadable_pages: "Some pages could not be read. Other available text is searchable."
});

/** One bounded user-facing note in canonical warning priority order. */
export function knowledgeProcessingNote(
  warningCodes: readonly KnowledgeProcessingWarningCode[]
): string | null {
  const present = new Set(warningCodes);
  const code = KNOWLEDGE_PROCESSING_WARNING_CODES.find((candidate) => present.has(candidate));
  return code ? KNOWLEDGE_PROCESSING_NOTES[code] : null;
}
