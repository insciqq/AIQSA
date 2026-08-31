import { describe, expect, it } from "vitest";
import {
  analyzeMemoryLexicalQuery,
  MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION,
  normalizeMemoryLexicalProjection
} from "./lexical";

describe("Memory language-neutral lexical query analysis", () => {
  it("preserves language-specific letters in primary lexical identity", () => {
    const display = "Моя ёлка — зелёная";
    expect(normalizeMemoryLexicalProjection(display)).toBe("моя ёлка — зелёная");
    expect(normalizeMemoryLexicalProjection("Елка")).not.toBe(
      normalizeMemoryLexicalProjection("Ёлка")
    );
    expect(display).toBe("Моя ёлка — зелёная");
  });

  it("emits one versioned term contract for mixed text and identifiers", () => {
    expect(analyzeMemoryLexicalQuery("Qwen3-Модель X7 2025")).toEqual({
      analysisVersion: MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION,
      logicalTerms: ["qwen3", "модель", "x7", "2025"],
      ngramTerms: ["модель", "qwen3", "2025", "x7"],
      normalized: "qwen3-модель x7 2025",
    });
  });

  it.each([
    ["Latin", "mañana café", ["mañana", "café"]],
    ["Cyrillic", "ћирилица їжак", ["ћирилица", "їжак"]],
    ["Greek", "Καλημέρα κόσμε", ["καλημέρα", "κόσμε"]],
    ["Arabic and Hebrew", "مرحبا עולם", ["مرحبا", "עולם"]],
    ["Indic", "नमस्ते दुनिया", ["नमस्ते", "दुनिया"]],
    ["CJK", "東京計画", ["東京計画"]],
    ["Thai", "สวัสดีโลก", ["สวัสดีโลก"]]
  ])("uses the same generic fields for %s input", (_label, query, terms) => {
    const analysis = analyzeMemoryLexicalQuery(query);
    expect(Object.keys(analysis).sort()).toEqual([
      "analysisVersion", "logicalTerms", "ngramTerms", "normalized"
    ]);
    expect(analysis.logicalTerms).toEqual(terms);
  });

  it("retains bounded neutral numeric identifiers", () => {
    expect(analyzeMemoryLexicalQuery("2025-08-27 1536").logicalTerms).toEqual([
      "2025", "08", "27", "1536"
    ]);
  });
});
