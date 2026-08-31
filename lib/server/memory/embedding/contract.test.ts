import { describe, expect, it } from "vitest";
import {
  MEMORY_EMBEDDING_BATCH_VERSIONS,
  MEMORY_EMBEDDING_PROFILE,
  MEMORY_EMBEDDING_PROFILE_FINGERPRINT,
  memoryItemEmbeddingGenerationMatchesPin,
  renderMemoryQueryEmbeddingText
} from "./contract";
import { MEMORY_QUERY_EMBEDDING_VERSIONS } from "../retrieval/runUtilities";
import { MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT } from
  "../retrieval/vector";

describe("Memory embedding language-neutral contract", () => {
  it("versions a language- and script-neutral query instruction", () => {
    expect(MEMORY_EMBEDDING_PROFILE.queryInstructionVersion)
      .toBe("memory-query-instruction-v3");
    expect(MEMORY_EMBEDDING_PROFILE.queryInstruction)
      .toContain("regardless of language, script, or writing system");
    expect(MEMORY_EMBEDDING_PROFILE.queryInstruction).not.toMatch(
      /\b(?:English|Russian|Spanish|Serbian)\b/iu
    );
    expect(MEMORY_EMBEDDING_PROFILE_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/u);
    expect(MEMORY_QUERY_EMBEDDING_VERSIONS.promptVersion)
      .toBe(MEMORY_EMBEDDING_PROFILE.queryInstructionVersion);
  });

  it.each([
    "mañana 東京",
    "ћирилица Καλημέρα",
    "مرحبا עולם",
    "नमस्ते สวัสดี"
  ])("preserves arbitrary safe query text in one instruction profile: %s", (query) => {
    const rendered = renderMemoryQueryEmbeddingText(query);
    expect(rendered).toContain(`Query: ${query}`);
    expect(rendered).toContain(MEMORY_EMBEDDING_PROFILE.queryInstruction);
  });

  it("binds batch and query execution to the v3 profile", () => {
    expect(MEMORY_EMBEDDING_BATCH_VERSIONS.retrievalConfigFingerprint)
      .toContain("profile-v3");
    expect(MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT).toContain("profile-v3");
    expect(MEMORY_QUERY_EMBEDDING_VERSIONS.retrievalConfigFingerprint)
      .toBe(MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT);
  });

  it("keeps transport-only revisions in the same vector space", () => {
    const generation = {
      embeddingConfigurationFingerprint: "a".repeat(64),
      embeddingConnectionId: "connection-1",
      embeddingDimension: 1_536,
      embeddingProviderModelId: "embedding-model-1",
      id: "generation-1",
      indexMode: "HYBRID" as const,
      retrievalPipelineVersion: "retrieval-v1",
      vectorSpaceFingerprint: "b".repeat(64)
    };
    const pin = {
      configurationFingerprint: "c".repeat(64),
      connectionId: "connection-1",
      dimension: 1_536,
      providerModelId: "embedding-model-1",
      vectorSpaceFingerprint: "b".repeat(64)
    };

    expect(memoryItemEmbeddingGenerationMatchesPin(generation, pin)).toBe(true);
    expect(memoryItemEmbeddingGenerationMatchesPin(generation, {
      ...pin,
      vectorSpaceFingerprint: "d".repeat(64)
    })).toBe(false);
  });
});
