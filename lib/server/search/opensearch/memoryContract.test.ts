import { describe, expect, it } from "vitest";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  assertMemoryOpenSearchDocument,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchDocumentId,
  memoryOpenSearchIndexDefinition,
  memoryOpenSearchIntegrityFingerprintMaterial,
  memoryOpenSearchProjectionFingerprint,
  memoryOpenSearchUserScope,
  type MemoryOpenSearchDocument
} from "./memoryContract";

const routingKey = Buffer.alloc(32, 7).toString("base64");

function configuration(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return memoryOpenSearchConfigurationFromEnv({
    AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: routingKey,
    ...overrides
  });
}

describe("Memory OpenSearch projection contract", () => {
  it("accepts only bounded code-owned index, alias, routing and budget settings", () => {
    expect(configuration()).toMatchObject({
      bulkMaxBytes: 2 * 1024 * 1024,
      bulkMaxDocuments: 100,
      physicalIndexName: "aiqsa-memory-lexical-v1-20260831a",
      readAlias: "aiqsa-memory-lexical-read",
      replicas: 0,
      routingKeyId: "v1",
      shards: 1,
      writeAlias: "aiqsa-memory-lexical-write"
    });
    expect(() => configuration({
      AIQSA_MEMORY_OPENSEARCH_READ_ALIAS: "other-index"
    })).toThrow("memory_opensearch_configuration_invalid");
    expect(() => configuration({
      AIQSA_MEMORY_OPENSEARCH_BULK_MAX_DOCUMENTS: "101"
    })).toThrow("memory_opensearch_configuration_invalid");
    expect(() => memoryOpenSearchConfigurationFromEnv({
      AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: Buffer.alloc(16).toString("base64")
    })).toThrow("memory_opensearch_routing_key_invalid");
  });

  it("derives opaque stable routing and document identities", () => {
    const config = configuration();
    const scope = memoryOpenSearchUserScope("private-user-id", config);
    expect(scope).toMatch(/^[a-f0-9]{64}$/u);
    expect(scope).toBe(memoryOpenSearchUserScope("private-user-id", config));
    expect(scope).not.toBe(memoryOpenSearchUserScope("other-user-id", config));
    expect(scope).not.toContain("private-user-id");

    const documentId = memoryOpenSearchDocumentId("private-search-entry-id");
    expect(documentId).toMatch(/^[a-f0-9]{64}$/u);
    expect(documentId).not.toContain("private-search-entry-id");
  });

  it("uses one validated content-free integrity fingerprint framing", () => {
    expect(memoryOpenSearchIntegrityFingerprintMaterial({
      safeContentHash: "a".repeat(64),
      searchEntryId: "entry-1"
    })).toBe(`entry-1\0${"a".repeat(64)}\n`);
    expect(() => memoryOpenSearchIntegrityFingerprintMaterial({
      safeContentHash: "invalid",
      searchEntryId: "entry-1"
    })).toThrow("memory_opensearch_integrity_entry_invalid");
  });

  it("owns one strict routed Unicode mapping without language-selected fields", () => {
    const definition = memoryOpenSearchIndexDefinition(configuration());
    expect(definition).toMatchObject({
      mappings: {
        _meta: {
          analysis_profile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
          mapping_version: MEMORY_OPENSEARCH_MAPPING_VERSION,
          normalization_version: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
          retrieval_pipeline_version: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION
        },
        _routing: { required: true },
        _source: { enabled: false },
        dynamic: "strict",
        properties: {
          lexical_text: {
            analyzer: "memory_unicode",
            fields: {
              folded: { analyzer: "memory_folded", type: "text" },
              ngram: { analyzer: "memory_ngram", type: "text" },
              transliterated: { analyzer: "memory_transliterated", type: "text" }
            },
            type: "text"
          },
          safe_content_hash: { store: true, type: "keyword" },
          search_entry_id: { store: true, type: "keyword" }
        }
      }
    });
    expect(Object.keys(definition.mappings.properties).join(" ")).not.toMatch(
      /english|russian|spanish|serbian|cyrillic|latin_field/iu
    );
  });

  it("validates the minimal safe document and projection sequence", () => {
    const config = configuration();
    const document: MemoryOpenSearchDocument = {
      analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
      generationId: "generation-1",
      itemType: "RECALL_ROUND" as const,
      lexicalText: "safe normalized projection",
      mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
      normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
      projectionSequence: 17n,
      retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
      safeContentHash: "a".repeat(64),
      searchEntryId: "entry-1",
      sourceChatId: "chat-1",
      userScope: memoryOpenSearchUserScope("user-1", config)
    };
    expect(() => assertMemoryOpenSearchDocument(document)).not.toThrow();
    expect(() => assertMemoryOpenSearchDocument({
      ...document,
      projectionSequence: 0n
    })).toThrow("memory_opensearch_document_invalid");
    expect(() => assertMemoryOpenSearchDocument({
      ...document,
      lexicalText: " safe projection"
    })).toThrow("memory_opensearch_document_invalid");
  });

  it("binds readiness to every index and routing contract version", () => {
    const first = configuration();
    const second = configuration({
      AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID: "replacement"
    });
    expect(memoryOpenSearchProjectionFingerprint(first)).toMatch(/^[a-f0-9]{64}$/u);
    expect(memoryOpenSearchProjectionFingerprint(first)).not.toBe(
      memoryOpenSearchProjectionFingerprint(second)
    );
  });
});
