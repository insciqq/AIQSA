import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_PROCESSING_NOTES,
  knowledgeProcessingNote
} from "./knowledgeProcessingWarnings";

describe("Knowledge processing notes", () => {
  it("selects one bounded note in canonical priority order", () => {
    expect(knowledgeProcessingNote([
      "table_extraction_degraded",
      "partial_parse",
      "unreadable_pages"
    ])).toBe("Part of the file could not be read. The rest is searchable.");
  });

  it("uses sentences without raw codes or an unavailable recovery promise", () => {
    expect(knowledgeProcessingNote([])).toBeNull();
    for (const note of Object.values(KNOWLEDGE_PROCESSING_NOTES)) {
      expect(note).toMatch(/[.!?]$/u);
      expect(note).not.toMatch(/(?:partial_parse|table_extraction|parser|profile|reprocess|revision)/iu);
    }
  });
});
