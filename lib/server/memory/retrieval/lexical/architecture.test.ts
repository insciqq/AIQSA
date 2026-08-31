import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_RETRIEVAL_LANE_ORDER } from
  "../../../../domain/memory/retrieval/config";
import { analyzeMemoryLexicalQuery } from
  "../../../../domain/memory/retrieval/lexical";
import { MEMORY_LEXICAL_ANALYSIS_PROFILE } from "../../persistence/lexical";

const activeLexicalOwners = [
  "lib/domain/memory/retrieval/config.ts",
  "lib/domain/memory/retrieval/lexical.ts",
  "lib/server/memory/persistence/lexical.ts",
  "lib/server/memory/retrieval/localRepository.ts",
  "lib/server/memory/retrieval/lexical/postgresUnicodeProvider.ts",
  "lib/server/memory/retrieval/runAdmission.ts"
] as const;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Memory language-neutral lexical architecture", () => {
  it("keeps language and script classification out of active retrieval owners", () => {
    const activeSource = activeLexicalOwners.map(source).join("\n");
    expect(activeSource).not.toMatch(/Script=(?:Latin|Cyrillic)/u);
    expect(activeSource).not.toMatch(/(?:FACT|HISTORY_RECALL)_FTS_(?:ENGLISH|RUSSIAN)/u);
    expect(activeSource).not.toMatch(/searchVector(?:English|Russian)/u);
    expect(activeSource).not.toMatch(/'(?:english|russian)'::regconfig/u);
    expect(activeSource).not.toMatch(/aiqsa_memory_transliterate_[a-z]+/u);
    expect(activeSource).not.toContain("MEMORY_LEXICAL_LANGUAGE_PROFILE");
  });

  it("exposes one generic active profile and lane family for every script", () => {
    expect(MEMORY_LEXICAL_ANALYSIS_PROFILE).toBe("UNICODE_ICU_NGRAM_V1");
    expect(MEMORY_RETRIEVAL_LANE_ORDER.filter((lane) =>
      lane.includes("LEXICAL"))).toEqual([
      "FACT_LEXICAL_UNICODE",
      "FACT_LEXICAL_NGRAM",
      "HISTORY_RECALL_LEXICAL_UNICODE",
      "HISTORY_RECALL_LEXICAL_NGRAM"
    ]);
    for (const query of [
      "mañana", "ћирилица", "Καλημέρα", "مرحبا עולם", "नमस्ते", "東京", "สวัสดี",
      "Qwen3 東京 модель"
    ]) {
      expect(Object.keys(analyzeMemoryLexicalQuery(query)).sort()).toEqual([
        "analysisVersion", "logicalTerms", "ngramTerms", "normalized"
      ]);
    }
  });

  it("confines language-specific PostgreSQL behavior to the rollback adapter", () => {
    const legacy = source(
      "lib/server/memory/retrieval/lexical/postgresLegacyProvider.ts"
    );
    expect(legacy).toContain("PostgresLegacyMemoryLexicalCandidateProvider");
    expect(legacy).toMatch(/FACT_FTS_ENGLISH/u);
    expect(legacy).toMatch(/FACT_FTS_RUSSIAN/u);
    expect(legacy).toContain("aiqsa_memory_transliterate_ru");
  });
});
