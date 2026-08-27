import { describe, expect, it } from "vitest";
import { MAX_RERANK_DOCUMENT_CHARACTERS } from "../providers/rerank";
import { qwen2BpeTokenCounter } from "./tokenizer/qwen2BpeTokenizer";
import {
  formatKnowledgeRerankCandidate,
  KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION,
  KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS
} from "./rerankCandidateFormatter";

describe("Knowledge rerank candidate formatter", () => {
  it("is versioned with a bounded model-token budget", () => {
    expect(KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION).toBe(2);
    expect(KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS).toBe(768);
  });

  it("renders newline-separated title, heading path, and passage without labels", () => {
    const formatted = formatKnowledgeRerankCandidate({
      headingPath: ["Договоры", "Раздел 2"],
      sourceName: "Годовой отчёт.pdf",
      text: "Сумма контракта составляет 1 250 000 ₽."
    });
    expect(formatted).toBe([
      "Годовой отчёт.pdf",
      "Договоры / Раздел 2",
      "Сумма контракта составляет 1 250 000 ₽."
    ].join("\n"));
    expect(formatted).not.toMatch(/Source:|Location:|Evidence layout:/u);
  });

  it("is deterministic and skips empty heading paths without extra separators", () => {
    const input = {
      headingPath: [],
      sourceName: "policy.md",
      text: "Refunds are processed in 14 days."
    };
    const first = formatKnowledgeRerankCandidate(input);
    expect(first).toBe("policy.md\nRefunds are processed in 14 days.");
    expect(formatKnowledgeRerankCandidate(input)).toBe(first);
    expect(formatKnowledgeRerankCandidate({
      headingPath: ["", "  "],
      sourceName: "policy.md",
      text: "Refunds are processed in 14 days."
    })).toBe(first);
  });

  it("strips control characters and never emits NUL", () => {
    const formatted = formatKnowledgeRerankCandidate({
      headingPath: ["A\u0000B"],
      sourceName: "name\u0007.txt",
      text: "line one\nline\u0000two"
    });
    expect(formatted).not.toContain("\u0000");
    expect(formatted).not.toContain("\u0007");
    expect(formatted).toContain("line one\nline two");
  });

  it("bounds one candidate to the 768 model-token budget", () => {
    const formatted = formatKnowledgeRerankCandidate({
      headingPath: ["Раздел ".repeat(60)],
      sourceName: "Very long source title ".repeat(50),
      text: "слово word 词 ".repeat(2_000)
    });
    expect(qwen2BpeTokenCounter().countTokens(formatted))
      .toBeLessThanOrEqual(KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS);
    expect(formatted.length).toBeLessThanOrEqual(MAX_RERANK_DOCUMENT_CHARACTERS);
    expect(formatted.length).toBeGreaterThan(0);
    // The atomic passage yields before title or heading identity is lost.
    expect(formatted.startsWith("Very long source title")).toBe(true);
  });

  it("survives hostile title-only input while staying non-empty", () => {
    const formatted = formatKnowledgeRerankCandidate({
      headingPath: [],
      sourceName: "x".repeat(100_000),
      text: " "
    });
    expect(qwen2BpeTokenCounter().countTokens(formatted))
      .toBeLessThanOrEqual(KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS);
    expect(formatted.trim().length).toBeGreaterThan(0);
  });
});
