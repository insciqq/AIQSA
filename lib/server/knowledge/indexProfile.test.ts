import { describe, expect, it } from "vitest";
import {
  createKnowledgeVectorSpacePin,
  isKnowledgeIndexDimension,
  KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION
} from "./indexProfile";
import type { ProviderModelConfiguration } from "../providers/providerConfiguration";

function embeddingConfiguration(
  targetDimension = 1536,
  queryInstructionTemplate: string | null = "Query: {text}"
): ProviderModelConfiguration {
  return {
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 4096,
      providerFamily: "openrouter",
      queryInstructionTemplate,
      supportsMrl: true,
      targetDimension
    },
    modelClass: "embedding",
    upstreamModelId: "qwen/qwen3-embedding-8b"
  };
}

describe("Knowledge vector-space profiles", () => {
  it("activates document context in profile 4 without changing profile-3 layout reconstruction", () => {
    expect(KNOWLEDGE_CHUNKING_PROFILE_VERSION).toBe(4);
    expect(KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION).toBe(3);
  });

  it("accepts only committed dimensions and fingerprints exact vector inputs", () => {
    expect(isKnowledgeIndexDimension(1024)).toBe(true);
    expect(isKnowledgeIndexDimension(1536)).toBe(true);
    expect(isKnowledgeIndexDimension(768)).toBe(false);

    const first = createKnowledgeVectorSpacePin({
      configuration: embeddingConfiguration(),
      deploymentId: "embedding-deployment"
    });
    const same = createKnowledgeVectorSpacePin({
      configuration: embeddingConfiguration(),
      deploymentId: "embedding-deployment"
    });
    const changed = createKnowledgeVectorSpacePin({
      configuration: embeddingConfiguration(1536, "Represent this query: {text}"),
      deploymentId: "embedding-deployment"
    });

    expect(first).toEqual(same);
    expect(first?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(changed?.fingerprint).not.toBe(first?.fingerprint);
    expect(first?.configuration).toMatchObject({
      deploymentId: "embedding-deployment",
      schemaVersion: 1,
      targetDimension: 1536
    });
  });

  it("keeps a valid but unindexed dimension distinguishable from an invalid model class", () => {
    expect(createKnowledgeVectorSpacePin({
      configuration: embeddingConfiguration(768),
      deploymentId: "embedding-deployment"
    })).toMatchObject({ indexSupported: false, targetDimension: 768 });

    expect(createKnowledgeVectorSpacePin({
      configuration: {
        ...embeddingConfiguration(),
        adapterKind: "openai_responses_native",
        embedding: undefined,
        modelClass: "answer"
      },
      deploymentId: "answer-deployment"
    })).toBeNull();
  });
});
