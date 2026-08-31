import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MemoryLexicalSearchRequest } from
  "../../memory/retrieval/lexical/contract";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchUserScope,
  type MemoryOpenSearchDocument
} from "./memoryContract";
import { StrictMemoryOpenSearchClient } from "./memoryClient";

function request(input: Readonly<{
  generationId: string;
  terms: readonly string[];
  userId: string;
}>): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: input.generationId,
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 3_000,
    finalLimit: 12,
    itemFamily: "FACT",
    memoryRevisionSnapshot: 0,
    userId: input.userId,
    variants: [{
      logicalTerms: input.terms.map((value, ordinal) => ({
        characterLength: Array.from(value).length,
        ordinal,
        value
      })),
      normalizedText: input.terms.join(" ").normalize("NFKC"),
      ordinal: 0
    }]
  };
}

describe("Memory OpenSearch live lexical contract", () => {
  it("round-trips Unicode, folded, transliterated, and n-gram candidates", async () => {
    const buildId = `it-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID: buildId,
      AIQSA_MEMORY_OPENSEARCH_READ_ALIAS: `aiqsa-memory-it-${buildId}-read`,
      AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY:
        "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
      AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID: "integration-v1",
      AIQSA_MEMORY_OPENSEARCH_WRITE_ALIAS: `aiqsa-memory-it-${buildId}-write`,
      NODE_ENV: "test"
    };
    const configuration = memoryOpenSearchConfigurationFromEnv(env);
    const client = new StrictMemoryOpenSearchClient(env);
    const userId = randomUUID();
    const generationId = randomUUID();
    const routing = memoryOpenSearchUserScope(userId, configuration);
    const texts = [
      "Café mañana 東京計画",
      "Александар пројекат",
      "database migrations"
    ];
    const documents: MemoryOpenSearchDocument[] = texts.map((lexicalText, index) => ({
      analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
      generationId,
      itemType: "FACT_VERSION",
      lexicalText,
      mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
      normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
      projectionSequence: BigInt(index + 1),
      retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
      safeContentHash: String.fromCharCode(97 + index).repeat(64),
      searchEntryId: `entry-${index + 1}`,
      sourceChatId: null,
      userScope: routing
    }));
    try {
      await client.ensureIndex();
      await client.applyMutations(documents.map((document) => ({
        document,
        operation: "UPSERT" as const,
        routing,
        sequence: document.projectionSequence
      })), "WAIT_FOR");

      const primary = await client.searchLexical({
        phase: "PRIMARY",
        request: request({
          generationId,
          terms: ["mañana", "東京計画"],
          userId
        })
      });
      expect(primary.candidates).toEqual([
        expect.objectContaining({
          matchedTermCount: 2,
          searchEntryId: "entry-1"
        })
      ]);
      expect(["UNICODE", "FOLDED"]).toContain(primary.candidates[0]?.matchMode);

      const fallback = await client.searchLexical({
        phase: "FALLBACK",
        request: request({
          generationId,
          terms: ["Aleksandar", "migratoin"],
          userId
        })
      });
      expect(fallback.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          matchMode: "TRANSLITERATED",
          searchEntryId: "entry-2"
        }),
        expect.objectContaining({
          matchMode: "NGRAM",
          searchEntryId: "entry-3"
        })
      ]));
    } finally {
      const root = new URL(env.AIQSA_OPENSEARCH_URL ?? "http://opensearch:9200");
      root.pathname = `${root.pathname.replace(/\/+$/u, "")}/`;
      const response = await fetch(new URL(configuration.physicalIndexName, root), {
        method: "DELETE"
      });
      if (response.status !== 200 && response.status !== 404) {
        throw new Error("memory_opensearch_integration_cleanup_failed");
      }
    }
  });
});
