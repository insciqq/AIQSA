import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION,
  KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION,
  isCurrentKnowledgeProfilePolicy,
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "./knowledgeProfile";

const embeddingProviderModelId = "embedding-model-1";

function operationRoles(value: unknown): Record<string, unknown>[] {
  return (value as { operationRoles: unknown[] }).operationRoles as Record<string, unknown>[];
}

describe("Knowledge Profile", () => {
  it("writes only the embedding role and no obsolete runtime configuration", () => {
    const configuration = knowledgeProfileConfiguration({
      candidateLimit: 12,
      embeddingProviderModelId,
      resultLimit: 4,
      scoreThreshold: 0.75,
      visionDestination: {
        providerModelId: "obsolete-vision-selection"
      }
    });
    const roles = operationRoles(configuration);

    expect(configuration).toEqual({
      operationRoles: roles,
      pdfProcessingMode: "local",
      rolePolicyVersion: KNOWLEDGE_PROFILE_ROLE_POLICY_VERSION,
      schemaVersion: 6
    });
    expect(roles.map(({ mode, operation }) => ({ mode, operation }))).toEqual([
      { mode: "external", operation: "embeddings" }
    ]);
    expect(roles[0]).toMatchObject({
      allowedRepresentations: ["document_text_chunks", "search_queries"],
      mode: "external",
      providerModelId: embeddingProviderModelId,
      rawPrivateText: true,
      retention: "provider_policy"
    });
    expect(JSON.stringify(configuration)).not.toMatch(
      /vision_analysis|query_planning|reranking|grounding_validation|citation_repair|answer_citation_retry/u
    );
    expect(JSON.stringify(configuration)).not.toMatch(
      /executionBudgets|retrievalBudgets|visualAnalysis/u
    );
    expect(JSON.stringify(configuration)).not.toContain("semanticValidator");
    expect(JSON.stringify(configuration)).not.toContain("selectionFreeze");
  });

  it("writes an embedding-only egress policy", () => {
    const policy = knowledgeProfileEgressPolicy({
      embeddingProviderModelId,
      visionDestination: { providerModelId: "obsolete-vision-selection" }
    });
    const operations = policy.operations as unknown as Record<string, unknown>[];

    expect(policy.policyVersion).toBe(KNOWLEDGE_PROFILE_EGRESS_POLICY_VERSION);
    expect(operations).toEqual(operationRoles(knowledgeProfileConfiguration({
      embeddingProviderModelId
    })));
    expect(operations.filter((role) => role.mode === "external").map((role) => role.operation))
      .toEqual(["embeddings"]);
    expect(operations).toHaveLength(1);
    expect(isCurrentKnowledgeProfilePolicy({
      egressPolicy: policy,
      embeddingProviderModelId,
      profileConfiguration: knowledgeProfileConfiguration({ embeddingProviderModelId })
    })).toBe(true);
    expect(isCurrentKnowledgeProfilePolicy({
      egressPolicy: policy,
      embeddingProviderModelId,
      profileConfiguration: { schemaVersion: 4 }
    })).toBe(false);
  });
});
