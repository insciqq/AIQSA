import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER,
  KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY,
  knowledgeTokenizerEvidenceLabel,
  knowledgeTokenizerIdentityFor,
  requireKnowledgeTokenCounter
} from "./knowledgeTokenCounter";
import {
  conservativeQwen2TokenUpperBound,
  createQwen2BpeTokenCounterFromAsset,
  KNOWLEDGE_QWEN2_BPE_ASSET_SHA256,
  KNOWLEDGE_QWEN2_BPE_IDENTITY,
  qwen2BpeTokenCounter
} from "./qwen2BpeTokenizer";
import { QWEN2_BPE_MERGES_GZ_BASE64 } from "./qwen2BpeMergesData";
import { knowledgeTokenizerIdentityLabel } from "./types";

/**
 * Expected counts were produced by the official HuggingFace `tokenizers`
 * 0.23.1 runtime loading the exact pinned tokenizer.json of
 * Qwen/Qwen3-Embedding-8B @ 1d8ad4ca9b3dd8059ad90a75d4983776a23d44af
 * (sha256 83cdf8c3a34f68862319cb1810ee7b1e2c0a44e0864ae930194ddb76bb7feb8d),
 * with add_special_tokens=false.
 */
const REFERENCE_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ["hello world", 2],
  ["Hello, world!", 4],
  ["The quarterly revenue was 4,821,904.55 USD.", 19],
  ["привет мир", 4],
  ["Договор аренды помещения от 2024-03-15 вступает в силу немедленно.", 29],
  ["Сума ПДВ становить 1 250,00 грн за договором №47-K.", 25],
  ["Қазақстан Республикасының заңнамасына сәйкес құжат жарамды.", 32],
  ["Уговор о закупу ступа на снагу 1. јануара 2025. године.", 32],
  ["Смета по проекту Falcon-9X: итого 12 500 USD (см. Appendix B).", 29],
  ["ID: INV-2024-00317, amount 4200.50 EUR", 25],
  ["naïve café résumé", 7],
  ["\u{1F44D}\u{1F3FD} emoji test \u{1F680}\u{1F525}", 8],
  ["汉字テスト한국어", 5],
  ["line1\nline2\r\nline3\ttabbed", 10],
  ["   leading and trailing   ", 5],
  ["it's we're I'll you'd THEY'RE", 10],
  ["x", 1],
  ["2024-03-15", 10],
  ["00000000000000000000", 20],
  ["a".repeat(100), 13],
  ["ы".repeat(50), 50],
  ["\u0000\u0001\u0002 control", 4],
  ["cafe\u0301 nfc-test", 5],
  ["A\u0085B\u00a0C\ufeffD", 8],
  ["Evidence layout: table_row_v1\nSource: report.pdf", 12]
];

describe("Qwen2 byte-level BPE token counter", () => {
  it("matches the official tokenizer on exact reference counts", () => {
    const counter = qwen2BpeTokenCounter();
    const results = REFERENCE_COUNTS.map(([text, expected]) => ({
      actual: counter.countTokens(text),
      expected,
      text: text.slice(0, 24)
    }));
    expect(results.filter((entry) => entry.actual !== entry.expected)).toEqual([]);
  });

  it("is deterministic and returns zero only for empty input", () => {
    const counter = qwen2BpeTokenCounter();
    expect(counter.countTokens("")).toBe(0);
    for (const [text] of REFERENCE_COUNTS) {
      expect(counter.countTokens(text)).toBe(counter.countTokens(text));
      expect(counter.countTokens(text)).toBeGreaterThan(0);
    }
  });

  it("carries the pinned asset identity", () => {
    expect(qwen2BpeTokenCounter().identity).toEqual(KNOWLEDGE_QWEN2_BPE_IDENTITY);
    expect(KNOWLEDGE_QWEN2_BPE_IDENTITY.assetSha256)
      .toBe(KNOWLEDGE_QWEN2_BPE_ASSET_SHA256);
    expect(KNOWLEDGE_QWEN2_BPE_ASSET_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("provides a conservative byte-level fallback bound", () => {
    const counter = qwen2BpeTokenCounter();
    for (const [text] of REFERENCE_COUNTS) {
      expect(conservativeQwen2TokenUpperBound(text))
        .toBeGreaterThanOrEqual(counter.countTokens(text));
    }
    expect(conservativeQwen2TokenUpperBound("")).toBe(0);
  });

  it("fails closed when the asset fingerprint does not match", () => {
    expect(() => createQwen2BpeTokenCounterFromAsset({
      expectedSha256: "0".repeat(64),
      gzBase64Parts: QWEN2_BPE_MERGES_GZ_BASE64,
      identity: KNOWLEDGE_QWEN2_BPE_IDENTITY
    })).toThrowError(expect.objectContaining({
      code: "knowledge_tokenizer_asset_invalid"
    }));
  });

  it("fails closed on malformed asset bytes even with a matching fingerprint shape", () => {
    expect(() => createQwen2BpeTokenCounterFromAsset({
      expectedSha256: KNOWLEDGE_QWEN2_BPE_ASSET_SHA256,
      gzBase64Parts: ["not-base64-gzip"],
      identity: KNOWLEDGE_QWEN2_BPE_IDENTITY
    })).toThrowError(expect.objectContaining({
      code: "knowledge_tokenizer_asset_invalid"
    }));
  });
});

describe("Knowledge token counter resolution", () => {
  it("selects the model-native tokenizer only for the built-in Qwen3 embedding profile", () => {
    expect(knowledgeTokenizerIdentityFor("qwen/qwen3-embedding-8b"))
      .toBe(KNOWLEDGE_QWEN2_BPE_IDENTITY);
    expect(knowledgeTokenizerIdentityFor(" Qwen/Qwen3-Embedding-8B "))
      .toBe(KNOWLEDGE_QWEN2_BPE_IDENTITY);
    expect(knowledgeTokenizerIdentityFor("google/gemini-embedding-2"))
      .toBe(KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY);
    expect(knowledgeTokenizerIdentityFor("baai/bge-m3"))
      .toBe(KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY);
    expect(knowledgeTokenizerIdentityFor(""))
      .toBe(KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY);
    expect(requireKnowledgeTokenCounter("qwen/qwen3-embedding-8b").identity)
      .toBe(KNOWLEDGE_QWEN2_BPE_IDENTITY);
    expect(requireKnowledgeTokenCounter("custom/embedding"))
      .toBe(KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER);
  });

  it("labels tokenizer identity for evidence without content", () => {
    expect(knowledgeTokenizerEvidenceLabel("qwen/qwen3-embedding-8b"))
      .toBe(`qwen2-bpe:1:${KNOWLEDGE_QWEN2_BPE_ASSET_SHA256.slice(0, 16)}`);
    expect(knowledgeTokenizerEvidenceLabel("custom/embedding"))
      .toBe("unicode-estimator:1");
    expect(knowledgeTokenizerIdentityLabel(KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY))
      .toBe("unicode-estimator:1");
  });

  it("keeps the generic estimator language-neutral and non-zero", () => {
    const samples = ["hello", "привет", "құжат", "јануар", "汉字"];
    for (const text of samples) {
      expect(KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER.countTokens(text)).toBeGreaterThan(0);
    }
    expect(KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER.countTokens("")).toBe(0);
  });
});
