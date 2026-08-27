import { describe, expect, it } from "vitest";
import {
  analyzeMemoryLexicalQuery,
  normalizeMemoryLexicalProjection
} from "./lexical";

describe("Memory multilingual lexical query analysis", () => {
  it("folds Russian yo only in the search projection", () => {
    const display = "Моя ёлка — зелёная";
    expect(normalizeMemoryLexicalProjection(display)).toBe("моя елка — зеленая");
    expect(display).toBe("Моя ёлка — зелёная");
  });

  it("routes mixed Cyrillic and Latin terms independently and retains identifiers", () => {
    expect(analyzeMemoryLexicalQuery("Qwen3-Модель X7 2025")).toEqual({
      englishTerms: ["qwen3", "x7"],
      hasCyrillic: true,
      hasLatin: true,
      normalized: "qwen3-модель x7 2025",
      russianTerms: ["модель"],
      simpleTerms: ["qwen3", "модель", "x7", "2025"],
      trigramTerms: ["модель", "qwen3", "2025"]
    });
  });

  it("does not invent English or Russian routing for neutral identifiers", () => {
    expect(analyzeMemoryLexicalQuery("2025-08-27 1536")).toMatchObject({
      englishTerms: [],
      hasCyrillic: false,
      hasLatin: false,
      russianTerms: [],
      simpleTerms: ["2025", "08", "27", "1536"]
    });
  });
});
