import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeSemanticValidatorDeployment,
  decodeKnowledgeProfileOperationRoles,
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy,
  knowledgeSemanticValidatorDeploymentFromSelectionFreeze,
  knowledgeSemanticValidatorDeploymentReleased,
  knowledgeVisionEgressApproved,
  knowledgeVisionProfileFromConfiguration,
  type KnowledgeSemanticValidatorDeploymentV1,
  type KnowledgeVisionProfileDestination
} from "./knowledgeProfile";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function selectionFreeze(candidateId = "local_multilingual_nli_v1") {
  const body = {
    aggregateOnly: true,
    artifactScope: "semantic_candidate_selection_only",
    artifactType: "knowledge_semantic_selection_freeze",
    artifactVersion: "knowledge-semantic-selection-freeze-v1",
    benchmarkReportSha256: "1".repeat(64),
    evaluationArtifacts: {
      calibrationFreezeManifestSha256: "2".repeat(64),
      candidateFreezeManifestSha256: "3".repeat(64),
      candidateSetDigest: "4".repeat(64),
      corpusSha256: "5".repeat(64),
      finalPredictionFreezeManifestSha256: "6".repeat(64),
      poolSha256: "7".repeat(64)
    },
    finalReview: {
      adjudicationSha256: "8".repeat(64),
      mappingSha256: "9".repeat(64),
      packetSha256: "a".repeat(64),
      reviewScope: "final",
      reviewerSubmissionSha256s: ["b".repeat(64), "c".repeat(64)]
    },
    humanTrust: {
      adjudicatorAttestationSha256: "d".repeat(64),
      anchorSetSha256: "e".repeat(64),
      evidenceSha256: "f".repeat(64),
      operatorAttestationSha256: "0".repeat(64),
      provenanceVerification: "operator_anchored_ed25519_verified",
      reviewerAttestationSha256s: ["1".repeat(64), "2".repeat(64)],
      verificationContextSha256: "3".repeat(64),
      version: "knowledge-semantic-human-trust-v1"
    },
    labelsIncluded: false,
    privateContentIncluded: false,
    releaseGatePassed: false,
    selectedCandidate: {
      authorization: "profile_authorized",
      calibrationOutputSha256: "d".repeat(64),
      candidateId,
      candidateIdentitySha256: "a".repeat(64),
      candidateImplementationSha256: "b".repeat(64),
      executionClass: "real_model",
      finalOutputSha256: "e".repeat(64),
      qualityEvidenceSha256: "f".repeat(64)
    },
    selectionEligible: true,
    semanticProof: true
  } as const;
  return {
    ...body,
    manifestSha256: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")
  };
}

const vision: KnowledgeVisionProfileDestination = {
  connectionDisplayName: "Vision provider",
  modelDisplayName: "Document vision",
  provider: "openai",
  providerModelId: "vision-model-1",
  supportsNativePdf: true
};

const semanticSelectionFreeze = selectionFreeze();

const semanticDeployment: KnowledgeSemanticValidatorDeploymentV1 = Object.freeze({
  authorization: "profile_authorized",
  calibrationOutputSha256: "d".repeat(64),
  candidateId: "local_multilingual_nli_v1",
  candidateIdentitySha256: "a".repeat(64),
  candidateImplementationSha256: "b".repeat(64),
  egress: "local",
  executionClass: "real_model",
  finalOutputSha256: "e".repeat(64),
  profileId: "local-nli-v1",
  qualityEvidenceSha256: "f".repeat(64),
  recoveryMode: "deterministic_replay",
  selectionFreezeVersion: "knowledge-semantic-selection-freeze-v1",
  selectionManifestSha256: semanticSelectionFreeze.manifestSha256,
  semanticProof: true,
  validatorVersion: 4,
  version: 1
});

function stagedSemanticProfileDocuments(
  deployment: KnowledgeSemanticValidatorDeploymentV1 = semanticDeployment
) {
  const embeddingProviderModelId = "embedding-model-1";
  const configuration = knowledgeProfileConfiguration({
    candidateLimit: 40,
    embeddingProviderModelId,
    resultLimit: 8,
    scoreThreshold: 0.01
  }) as Record<string, unknown>;
  const egressPolicy = knowledgeProfileEgressPolicy({
    embeddingProviderModelId
  }) as Record<string, unknown>;
  const withDeployment = (roles: unknown) => (roles as Record<string, unknown>[]).map((role) =>
    role.operation === "grounding_validation"
      ? { ...role, semanticValidator: deployment }
      : role);
  return {
    configuration: {
      ...configuration,
      operationRoles: withDeployment(configuration.operationRoles),
      rolePolicyVersion: 2,
      schemaVersion: 4
    },
    egressPolicy: {
      ...egressPolicy,
      operations: withDeployment(egressPolicy.operations),
      policyVersion: "knowledge-profile-egress-v4"
    }
  };
}

describe("Knowledge visual profile policy", () => {
  it("pins an optional exact destination and matching egress operation", () => {
    const configuration = knowledgeProfileConfiguration({
      candidateLimit: 40,
      embeddingProviderModelId: "embedding-model-1",
      resultLimit: 8,
      scoreThreshold: 0.01,
      visionDestination: vision
    });
    const egress = knowledgeProfileEgressPolicy({
      embeddingProviderModelId: "embedding-model-1",
      visionDestination: vision
    });

    expect(knowledgeVisionProfileFromConfiguration(configuration)).toEqual({
      destination: vision,
      kind: "configured"
    });
    expect(knowledgeVisionEgressApproved(egress, "vision-model-1")).toBe(true);
    expect(knowledgeVisionEgressApproved(egress, "different-model")).toBe(false);
    expect(knowledgeVisionEgressApproved({
      ...egress,
      operations: (egress.operations as unknown[]).map((role) =>
        (role as Record<string, unknown>).operation === "query_planning"
          ? {
              ...(role as Record<string, unknown>),
              mode: "external",
              providerModelId: "planner-model",
              rawPrivateText: true
            }
          : role)
    }, "vision-model-1")).toBe(false);
    const roles = decodeKnowledgeProfileOperationRoles({
      configuration,
      egressPolicy: egress,
      embeddingProviderModelId: "embedding-model-1"
    });
    expect(roles?.map(({ mode, operation }) => ({ mode, operation }))).toEqual([
      { mode: "external", operation: "embeddings" },
      { mode: "external", operation: "vision_analysis" },
      { mode: "disabled", operation: "query_planning" },
      { mode: "local", operation: "reranking" },
      { mode: "local", operation: "grounding_validation" },
      { mode: "local", operation: "citation_repair" },
      { mode: "disabled", operation: "answer_citation_retry" }
    ]);
    expect(roles?.slice(2).every((role) =>
      role.providerModelId === null && role.rawPrivateText === false &&
      role.maxCostMicros === 0 && role.retention === "none" &&
      role.logging === "content_free")).toBe(true);
    expect(roles?.every((role) => Number.isSafeInteger(role.timeoutMs) &&
      Number.isSafeInteger(role.maxInputBytes) &&
      Number.isSafeInteger(role.maxInputTokens))).toBe(true);
  });

  it("treats legacy and explicit null profiles as asset-only and rejects malformed approval", () => {
    expect(knowledgeVisionProfileFromConfiguration({ schemaVersion: 1 })).toEqual({
      kind: "asset_only"
    });
    expect(knowledgeVisionProfileFromConfiguration(knowledgeProfileConfiguration({
      candidateLimit: 40,
      embeddingProviderModelId: "embedding-model-1",
      resultLimit: 8,
      scoreThreshold: 0.01,
      visionDestination: null
    }))).toEqual({ kind: "asset_only" });
    expect(knowledgeVisionProfileFromConfiguration({
      schemaVersion: 2,
      visualAnalysis: { ...vision, providerModelId: "bad\nmodel" }
    })).toEqual({ kind: "invalid" });
    expect(knowledgeVisionEgressApproved({
      operations: [{
        operation: "vision_analysis",
        providerModelId: "vision-model-1",
        representations: ["visual_queries", "visual_source_bytes"]
      }],
      policyVersion: "knowledge-profile-egress-v2"
    }, "vision-model-1")).toBe(false);
  });

  it("decodes immutable v1/v2 revisions to the same local and disabled H2 defaults", () => {
    const v1Roles = decodeKnowledgeProfileOperationRoles({
      configuration: { schemaVersion: 1 },
      egressPolicy: {
        operations: [{
          operation: "embeddings",
          representations: ["document_text_chunks", "search_queries"]
        }],
        policyVersion: "knowledge-profile-egress-v1"
      },
      embeddingProviderModelId: "embedding-model-1"
    });
    const v2Roles = decodeKnowledgeProfileOperationRoles({
      configuration: { schemaVersion: 2, visualAnalysis: vision },
      egressPolicy: {
        operations: [{
          operation: "embeddings",
          representations: ["document_text_chunks", "search_queries"]
        }, {
          operation: "vision_analysis",
          providerModelId: "vision-model-1",
          representations: ["visual_source_bytes", "visual_queries"]
        }],
        policyVersion: "knowledge-profile-egress-v2"
      },
      embeddingProviderModelId: "embedding-model-1"
    });

    expect(v1Roles?.find(({ operation }) => operation === "vision_analysis")?.mode)
      .toBe("disabled");
    expect(v2Roles?.find(({ operation }) => operation === "vision_analysis")?.mode)
      .toBe("external");
    for (const roles of [v1Roles, v2Roles]) {
      expect(roles?.find(({ operation }) => operation === "query_planning")?.mode)
        .toBe("disabled");
      expect(roles?.find(({ operation }) => operation === "reranking")?.mode)
        .toBe("local");
      expect(roles?.find(({ operation }) => operation === "grounding_validation")?.mode)
        .toBe("local");
      expect(roles?.find(({ operation }) => operation === "citation_repair")?.mode)
        .toBe("local");
      expect(roles?.find(({ operation }) => operation === "answer_citation_retry")?.mode)
        .toBe("disabled");
    }
    expect(knowledgeVisionEgressApproved({
      operations: [{
        operation: "vision_analysis",
        providerModelId: "vision-model-1",
        representations: ["visual_source_bytes", "visual_queries"]
      }],
      policyVersion: "knowledge-profile-egress-v2"
    }, "vision-model-1")).toBe(true);
  });

  it("rejects role drift that could silently enable external private-text egress", () => {
    const configuration = knowledgeProfileConfiguration({
      candidateLimit: 40,
      embeddingProviderModelId: "embedding-model-1",
      resultLimit: 8,
      scoreThreshold: 0.01,
      visionDestination: null
    });
    const egress = knowledgeProfileEgressPolicy({
      embeddingProviderModelId: "embedding-model-1",
      visionDestination: null
    });
    const roles = (configuration.operationRoles as unknown[]).map((role) => ({
      ...(role as Record<string, unknown>)
    }));
    roles[2] = {
      ...roles[2],
      maxCostMicros: 50_000,
      maxInputBytes: 50_000,
      maxInputTokens: 10_000,
      mode: "external",
      providerModelId: "planner-model",
      rawPrivateText: true,
      retention: "provider_policy",
      timeoutMs: 30_000
    };

    expect(decodeKnowledgeProfileOperationRoles({
      configuration: { ...configuration, operationRoles: roles },
      egressPolicy: egress,
      embeddingProviderModelId: "embedding-model-1"
    })).toBeNull();
    expect(decodeKnowledgeProfileOperationRoles({
      configuration,
      egressPolicy: {
        ...egress,
        operations: (egress.operations as unknown[]).slice(0, 6)
      },
      embeddingProviderModelId: "embedding-model-1"
    })).toBeNull();
  });

  it("keeps the structural default and refuses an unreleased semantic deployment", () => {
    const structural = knowledgeProfileConfiguration({
      candidateLimit: 40,
      embeddingProviderModelId: "embedding-model-1",
      resultLimit: 8,
      scoreThreshold: 0.01
    });

    expect(structural).toMatchObject({ rolePolicyVersion: 1, schemaVersion: 3 });
    expect(JSON.stringify(structural)).not.toContain("semanticValidator");
    expect(decodeKnowledgeSemanticValidatorDeployment(semanticDeployment))
      .toEqual(semanticDeployment);
    expect(knowledgeSemanticValidatorDeploymentReleased(semanticDeployment)).toBe(false);
    expect(() => knowledgeProfileConfiguration({
      candidateLimit: 40,
      embeddingProviderModelId: "embedding-model-1",
      resultLimit: 8,
      scoreThreshold: 0.01,
      semanticValidatorDeployment: semanticDeployment
    })).toThrow("knowledge_semantic_validator_deployment_unreleased");
    expect(() => knowledgeProfileEgressPolicy({
      embeddingProviderModelId: "embedding-model-1",
      semanticValidatorDeployment: semanticDeployment
    })).toThrow("knowledge_semantic_validator_deployment_unreleased");
  });

  it("derives deployment authority only from an exact self-hashed selection freeze", () => {
    const freeze = semanticSelectionFreeze;
    const deployment = knowledgeSemanticValidatorDeploymentFromSelectionFreeze({
      profileId: "local-nli-v1",
      selectionFreeze: freeze,
      validatorVersion: 4
    });

    expect(deployment).toBeNull();
    expect(knowledgeSemanticValidatorDeploymentFromSelectionFreeze({
      profileId: "local-nli-v1",
      selectionFreeze: {
        ...freeze,
        selectedCandidate: {
          ...freeze.selectedCandidate,
          finalOutputSha256: "0".repeat(64)
        }
      },
      validatorVersion: 4
    })).toBeNull();
    expect(knowledgeSemanticValidatorDeploymentFromSelectionFreeze({
      profileId: "local-nli-v1",
      selectionFreeze: { ...freeze, labelsIncluded: true },
      validatorVersion: 4
    })).toBeNull();
    expect(knowledgeSemanticValidatorDeploymentFromSelectionFreeze({
      profileId: "local-nli-v1",
      selectionFreeze: selectionFreeze("system_model_semantic_v1"),
      validatorVersion: 4
    })).toBeNull();
  });

  it("fails closed on semantic deployment drift or external egress", () => {
    const { configuration, egressPolicy } = stagedSemanticProfileDocuments();
    const operations = (egressPolicy.operations as unknown[]).map((role) => {
      const decoded = role as Record<string, unknown>;
      return decoded.operation === "grounding_validation"
        ? {
            ...decoded,
            semanticValidator: { ...semanticDeployment, egress: "external" }
          }
        : decoded;
    });

    expect(decodeKnowledgeProfileOperationRoles({
      configuration,
      egressPolicy: { ...egressPolicy, operations },
      embeddingProviderModelId: "embedding-model-1"
    })).toBeNull();
    expect(decodeKnowledgeSemanticValidatorDeployment({
      ...semanticDeployment,
      candidateIdentitySha256: "not-a-hash"
    })).toBeNull();
    expect(decodeKnowledgeSemanticValidatorDeployment({
      ...semanticDeployment,
      egress: "external"
    })).toBeNull();
  });
});
