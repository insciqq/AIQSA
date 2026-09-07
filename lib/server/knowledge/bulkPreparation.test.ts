import { describe, expect, it } from "vitest";
import { knowledgeSourceNormalizedTextStorageKey } from "./sourceArtifactKeys";
import {
  assertKnowledgeBulkPreparedSources,
  KnowledgeBulkPreparationError,
  type KnowledgeBulkPreparedSource
} from "./bulkPreparation";

const ownerUserId = "owner-1";
const sourceId = "11111111-1111-8111-8111-111111111111";
const sourceVersionId = "22222222-2222-8222-8222-222222222222";
const artifactId = "33333333-3333-8333-8333-333333333333";

function source(
  overrides: Partial<KnowledgeBulkPreparedSource> = {}
): KnowledgeBulkPreparedSource {
  return {
    artifactId,
    byteSize: 12,
    checksum: "a".repeat(64),
    fileName: "document.txt",
    mimeType: "text/plain",
    normalizedTextByteSize: 100,
    normalizedTextChecksum: "b".repeat(64),
    normalizedTextStorageKey: knowledgeSourceNormalizedTextStorageKey({
      artifactId,
      ownerUserId,
      sourceId,
      sourceVersionId
    }),
    sourceId,
    sourceName: "Prepared source",
    sourceVersionId,
    ...overrides
  };
}

describe("Knowledge held bulk preparation", () => {
  it("accepts an exact normalized-object identity", () => {
    expect(() => assertKnowledgeBulkPreparedSources(ownerUserId, [source()]))
      .not.toThrow();
  });

  it("rejects duplicate identities and storage-key drift", () => {
    expect(() => assertKnowledgeBulkPreparedSources(ownerUserId, [source(), source()]))
      .toThrow(KnowledgeBulkPreparationError);
    expect(() => assertKnowledgeBulkPreparedSources(ownerUserId, [source({
      normalizedTextStorageKey: "knowledge-sources/wrong/normalized-v2.json"
    })])).toThrow("knowledge_bulk_preparation_input_invalid");
  });

  it("rejects malformed hashes, identifiers, and empty batches", () => {
    expect(() => assertKnowledgeBulkPreparedSources(ownerUserId, []))
      .toThrow("knowledge_bulk_preparation_input_invalid");
    expect(() => assertKnowledgeBulkPreparedSources(ownerUserId, [source({
      checksum: "not-a-checksum"
    })])).toThrow("knowledge_bulk_preparation_input_invalid");
    expect(() => assertKnowledgeBulkPreparedSources(ownerUserId, [source({
      sourceId: "not-a-source-id"
    })])).toThrow("knowledge_bulk_preparation_input_invalid");
  });
});
