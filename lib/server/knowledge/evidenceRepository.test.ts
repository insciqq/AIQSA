import { describe, expect, it, vi } from "vitest";
import {
  groundKnowledgeRunAnswer,
  knowledgeEvidencePackageForGroundingDispatch,
  knowledgeGroundingProfileRevisionIds,
  loadKnowledgeEvidencePackage
} from "./evidenceRepository";
import { knowledgeEvidenceReceiptHash } from "./evidencePackage";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { groundKnowledgeAnswer } from "./grounding";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy,
  type KnowledgeSemanticValidatorDeploymentV1
} from "./knowledgeProfile";
import {
  KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
  sealKnowledgeStrategyCoverageReceiptV1,
  type KnowledgeStrategyCoverageReceiptV1
} from "./knowledgeStrategyExecution";
import type { KnowledgeSemanticLocalValidatorExecutor } from "./semanticShadow";

function row(overrides: Record<string, unknown> = {}) {
  return {
    citationContract: { format: "K{ordinal}", legacyRead: true, maximum: 2048, version: 2 },
    coverageRequirements: {
      expectedPassageCount: 1,
      mode: "verified_only",
      namedTargets: [],
      verified: false
    },
    degradedFlags: [],
    evidenceItems: [{
      baseName: "Policies",
      contentHash: "a".repeat(64),
      contextBoundaries: { expanded: false, excerptBytes: 66, sourceTextBytes: 66 },
      documentId: "document-private-id",
      documentVersionId: "document-version-private-id",
      excerpt: "Completed Atlas exports are retained for 30 days after completion.",
      fileName: "retention.md",
      handle: "K1",
      headingPath: ["Retention"],
      id: "evidence-private-id",
      knowledgeBaseId: "base-private-id",
      locator: { page: 2 },
      operationLinks: [{
        knowledgeRun: {
          fusion: "weighted_rrf_v2",
          invocationOrdinal: 1,
          operation: "automatic_search"
        },
        knowledgeRunId: "knowledge-operation-1",
        resultOrdinal: 0,
        retrievalProvenance: {
          confidence: 0.72,
          confidenceBucket: "high",
          fusion: "weighted_rrf_v2",
          invocationOrdinal: 1,
          operation: "automatic_search",
          postRerankRank: 1,
          preRerankRank: 2,
          rerankScore: 0.72,
          signals: [{
            exactKind: null,
            lane: "passage_semantic",
            rank: 1,
            rawScore: 0.91,
            vectorDistance: 0.09,
            vectorMode: "ann"
          }],
          version: 1
        }
      }],
      ordinal: 1,
      page: 2,
      passageId: "passage-private-id",
      sectionId: "section-private-id",
      sourceArtifactId: "artifact-private-id",
      sourceId: "source-private-id",
      sourceName: "Atlas retention",
      sourceVersionId: "source-version-private-id",
      sourceVersionNumber: 3,
      state: "available",
      textTruncated: false
    }],
    id: "session-1",
    modelRunId: "run-1",
    originalIntent: { intent: "fact_lookup", query: "How long are exports retained?" },
    readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 1 },
    scopeSnapshot: {
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      selection: { mode: "explicit" }
    },
    strategySnapshot: { strategy: "focused" },
    version: 2,
    ...overrides
  };
}

function client(value: unknown, input: Readonly<{
  attempts?: readonly unknown[];
  currentOperation?: unknown;
  profileBindings?: readonly unknown[];
}> = {}) {
  return {
    knowledgeProviderAttempt: {
      findMany: vi.fn(async () => input.attempts ?? [])
    },
    knowledgeRetrievalSession: {
      findFirst: vi.fn(async () => value)
    },
    knowledgeRunProfileBinding: {
      findMany: vi.fn(async () => input.profileBindings ?? [])
    },
    knowledgeRun: {
      findFirst: vi.fn(async () => input.currentOperation ?? null)
    }
  } as never;
}

function authorizedProfileBinding(profileRevisionId = "profile-revision-1") {
  const embeddingProviderModelId = "embedding-model-1";
  return {
    profileRevision: {
      egressPolicy: knowledgeProfileEgressPolicy({ embeddingProviderModelId }),
      embeddingProviderModelId,
      executionAuthority: "installation",
      profileConfiguration: knowledgeProfileConfiguration({
        candidateLimit: 40,
        embeddingProviderModelId,
        resultLimit: 8,
        scoreThreshold: 0.01
      })
    },
    profileRevisionId
  };
}

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
  selectionManifestSha256: "c".repeat(64),
  semanticProof: true,
  validatorVersion: 4,
  version: 1
});

function selectedSemanticProfileBinding(
  deployment = semanticDeployment,
  profileRevisionId = "profile-revision-1",
  executionAuthority: "installation" | "legacy_user" = "installation"
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
    profileRevision: {
      egressPolicy: {
        ...egressPolicy,
        operations: withDeployment(egressPolicy.operations),
        policyVersion: "knowledge-profile-egress-v4"
      },
      embeddingProviderModelId,
      executionAuthority,
      profileConfiguration: {
        ...configuration,
        operationRoles: withDeployment(configuration.operationRoles),
        rolePolicyVersion: 2,
        schemaVersion: 4
      }
    },
    profileRevisionId
  };
}

function exactItems(count: number) {
  const template = row().evidenceItems[0]!;
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const excerpt = `Exact marker ${ordinal}.`;
    return {
      ...template,
      contentHash: ordinal.toString(16).padStart(64, "0"),
      contextBoundaries: {
        expanded: false,
        excerptBytes: Buffer.byteLength(excerpt, "utf8"),
        sourceTextBytes: Buffer.byteLength(excerpt, "utf8")
      },
      documentId: `exact-document-${ordinal}`,
      documentVersionId: `exact-document-version-${ordinal}`,
      excerpt,
      handle: `K${ordinal}`,
      id: `exact-evidence-${ordinal}`,
      operationLinks: [{
        knowledgeRun: {
          fusion: "none",
          invocationOrdinal: 1,
          operation: "find_exact"
        },
        knowledgeRunId: "exact-operation-1",
        resultOrdinal: index % 100,
        retrievalProvenance: {
          confidence: null,
          confidenceBucket: "unavailable",
          fusion: "none",
          invocationOrdinal: 1,
          operation: "find_exact",
          postRerankRank: Math.min(ordinal, 1_000),
          preRerankRank: Math.min(ordinal, 1_000),
          rerankScore: null,
          signals: [],
          version: 1
        }
      }],
      ordinal,
      passageId: `exact-passage-${ordinal}`,
      sourceArtifactId: `exact-artifact-${ordinal}`,
      sourceId: `exact-source-${ordinal}`,
      sourceName: `Exact source ${ordinal}`,
      sourceVersionId: `exact-source-version-${ordinal}`
    };
  });
}

function structuredAnalysis() {
  const plan = {
    aggregate: "sum",
    filters: [],
    groupBy: [],
    includeHidden: false,
    limit: 20,
    operation: "aggregate",
    select: [],
    target: { range: "A1:B3", sheet: "Sales" },
    valueColumn: "Revenue",
    version: 1
  };
  return {
    columns: ["sum Revenue"],
    receipt: {
      formulaCellsUsed: 0,
      hiddenRowsExcluded: 0,
      inputRanges: [{ range: "B2:B3", role: "value", sheet: "Sales", sheetIndex: 0 }],
      operation: "aggregate",
      operationSummary: "sum Revenue",
      outputRows: 1,
      plan,
      rowsMatched: 2,
      rowsScanned: 2,
      warnings: []
    },
    rows: [[300]]
  };
}

function visualAnalysis() {
  return {
    assetId: "asset-private-id",
    blockId: "block-private-id",
    boundingBoxes: [{
      bottom: 160,
      coordinateOrigin: "top_left",
      left: 20,
      page: 2,
      right: 280,
      top: 40
    }],
    caption: "Quarterly revenue",
    description: "The north series increases while the south series remains level.",
    headingPath: ["Results"],
    kind: "chart",
    label: "Quarterly revenue",
    page: 2,
    provider: {
      modelId: "vision-upstream",
      profileRevisionId: "profile-revision-private-id",
      provider: "deterministic-fake",
      providerModelId: "vision-model-private-id",
      usage: { inputTokens: 20, outputTokens: 11, reasoningTokens: 0, totalTokens: 31 }
    },
    status: "available",
    version: 1,
    warnings: []
  };
}

function settledDispatch(input: Readonly<{
  draft: ReturnType<typeof packKnowledgeEvidenceDispatchManifest>;
  excludedEvidenceItemId?: string;
}>): StoredKnowledgeEvidenceDispatch {
  const usage = {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    estimatedCostMicros: 0,
    inputTokens: 20,
    outputTokens: 5,
    reasoningTokens: 0,
    totalTokens: 25
  };
  return {
    attempt: {
      actualUsage: usage,
      ambiguousAt: null,
      checkpointHash: "b".repeat(64),
      dispatchedAt: new Date("2026-08-19T10:01:00.000Z"),
      estimatedUsage: usage,
      failureCode: null,
      id: "provider-attempt-1",
      idempotencyKey: "knowledge-answer-attempt-1",
      leaseExpiresAt: null,
      leaseToken: "knowledge-answer-lease-1",
      modelRunId: "run-1",
      ordinal: 1,
      providerBindingKey: "answer",
      providerResponseId: "provider-response-1",
      purpose: "answer",
      releasedAt: null,
      requestHash: "c".repeat(64),
      roundIndex: 0,
      settledAt: new Date("2026-08-19T10:02:00.000Z"),
      state: "settled"
    },
    draft: input.draft,
    exclusions: input.draft.exclusions.map((exclusion) => ({
      dispatchEvidenceId: exclusion.evidenceId,
      evidenceItemId: input.excludedEvidenceItemId ?? null,
      handle: exclusion.handle,
      reason: exclusion.reason
    })),
    manifestId: "dispatch-manifest-1",
    items: input.draft.items.map((item) => ({
      dispatchEvidenceId: item.evidenceId,
      evidenceItemId: "evidence-private-id",
      handle: item.handle,
      sourceArtifactId: "artifact-private-id",
      sourceVersionId: "source-version-private-id"
    })),
    profileRevisionIds: ["profile-revision-1"],
    retrievalSessionId: "session-1"
  };
}

function strategyCoverageReceipt(
  dispatchManifestHash: string
): KnowledgeStrategyCoverageReceiptV1 {
  const exactItemsHash = "d".repeat(64);
  return sealKnowledgeStrategyCoverageReceiptV1({
    dispatchExpectedItemCount: 1,
    dispatchIncludedItemCount: 1,
    dispatchManifestHash,
    executionHash: "e".repeat(64),
    executionId: "strategy-execution-1",
    expectedItemsHash: exactItemsHash,
    includedItemsHash: exactItemsHash,
    observedSourceSetHash: "f".repeat(64),
    processedItemsHash: "1".repeat(64),
    processedPassageCount: 1,
    processedSourceCount: 1,
    reasonCodes: [],
    requiredStepCount: 1,
    settledTargetCount: 0,
    sourceSetHash: "f".repeat(64),
    status: "verified",
    strategy: "full_context",
    terminalRequiredStepCount: 1,
    totalPassageCount: 1,
    totalSourceCount: 1,
    totalTargetCount: 0,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function strategyExecution(receipt: KnowledgeStrategyCoverageReceiptV1) {
  return {
    coverageReceipt: receipt,
    coverageReceiptHash: receipt.receiptHash,
    coverageStatus: receipt.status,
    executionHash: receipt.executionHash,
    id: receipt.executionId,
    modelRunId: "run-1",
    purgedAt: null,
    retrievalSessionId: "session-1",
    state: "settled",
    strategy: receipt.strategy
  };
}

describe("Knowledge Evidence v2 repository projection", () => {
  it("loads an exact bounded package without treating matching counts as measured coverage", async () => {
    const evidence = await loadKnowledgeEvidencePackage(client(row()), {
      runId: "run-1",
      userId: "user-1"
    });
    expect(evidence).toMatchObject({
      citationContract: { format: "K{ordinal}", version: 2 },
      coverage: { expectedPassageCount: 1, verified: false },
      items: [{
        handle: "K1",
        locator: { page: 2 },
        provenance: [{ confidenceBucket: "high", postRerankRank: 1 }],
        state: "available"
      }],
      originalIntent: { intent: "fact_lookup" },
      version: 2
    });
  });

  it("keeps partial readiness unverified and never trusts a stored verified flag", async () => {
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      coverageRequirements: {
        expectedPassageCount: 1,
        mode: "verified_only",
        namedTargets: [],
        verified: true
      },
      readinessSummary: { excludedResources: 1, readyBases: 1, readySources: 1 }
    })), { runId: "run-1", userId: "user-1" });
    expect(evidence?.coverage.verified).toBe(false);
  });

  it("verifies measured coverage only against the exact final dispatch manifest", async () => {
    const first = row().evidenceItems[0]!;
    const draft = packKnowledgeEvidenceDispatchManifest({
      allowExpandedContextOmission: true,
      candidates: [{
        ambiguity: "none",
        evidenceId: "provider-call-1:result:1",
        exactExcerpt: first.excerpt,
        fileName: first.fileName,
        handle: first.handle,
        locator: "page=2; heading=Retention",
        operationOrdinal: 1,
        resultOrdinal: 1,
        sourceAlias: "S1",
        sourceLabel: first.sourceName,
        sourceTruncated: false,
        sourceVersionNumber: 3,
        state: "available"
      }],
      coverageStatement: "Coverage verified: yes.",
      footer: "</private_knowledge_evidence>",
      header: "<private_knowledge_evidence version=\"2\">",
      maximumBytes: 8_192,
      maximumTokens: 2_048,
      plannerVersion: 2,
      profileId: "test:answer-model",
      promptFragmentVersion: 2
    });
    const receipt = strategyCoverageReceipt(draft.manifestHash);
    const loaded = await loadKnowledgeEvidencePackage(client(row({
      strategyExecution: strategyExecution(receipt),
      strategySnapshot: { strategy: "full_context" }
    })), { runId: "run-1", userId: "user-1" });

    expect(loaded).toMatchObject({
      coverage: { verified: false },
      strategyCoverage: { dispatchManifestHash: draft.manifestHash, status: "verified" }
    });
    const narrowed = knowledgeEvidencePackageForGroundingDispatch(
      loaded!,
      settledDispatch({ draft })
    );
    expect(narrowed.coverage.verified).toBe(true);
    expect(knowledgeEvidencePackageForGroundingDispatch({
      ...loaded!,
      strategyCoverage: strategyCoverageReceipt("9".repeat(64))
    }, settledDispatch({ draft })).coverage.verified).toBe(false);
  });

  it("fails closed on malformed or identity-bearing tombstones", async () => {
    const malformed = row({
      evidenceItems: [{
        ...row().evidenceItems[0],
        excerpt: null,
        state: "deleted"
      }]
    });
    await expect(loadKnowledgeEvidencePackage(client(malformed), {
      runId: "run-1",
      userId: "user-1"
    })).resolves.toBeNull();
  });

  it("includes operation provenance in the immutable receipt hash", async () => {
    const first = await loadKnowledgeEvidencePackage(client(row()), {
      runId: "run-1",
      userId: "user-1"
    });
    const changedRow = row();
    const changedItem = changedRow.evidenceItems[0]!;
    const changedLink = changedItem.operationLinks[0]!;
    const changed = await loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...changedItem,
        operationLinks: [{
          ...changedLink,
          retrievalProvenance: {
            ...changedLink.retrievalProvenance,
            confidence: 0.55,
            confidenceBucket: "medium"
          }
        }]
      }]
    })), { runId: "run-1", userId: "user-1" });
    expect(first).not.toBeNull();
    expect(changed).not.toBeNull();
    expect(knowledgeEvidenceReceiptHash(first!)).not.toBe(
      knowledgeEvidenceReceiptHash(changed!)
    );
  });

  it("hashes strict strategy coverage and rejects a tampered sealed receipt", async () => {
    const firstReceipt = strategyCoverageReceipt("2".repeat(64));
    const secondReceipt = strategyCoverageReceipt("3".repeat(64));
    const first = await loadKnowledgeEvidencePackage(client(row({
      strategyExecution: strategyExecution(firstReceipt),
      strategySnapshot: { strategy: "full_context" }
    })), { runId: "run-1", userId: "user-1" });
    const second = await loadKnowledgeEvidencePackage(client(row({
      strategyExecution: strategyExecution(secondReceipt),
      strategySnapshot: { strategy: "full_context" }
    })), { runId: "run-1", userId: "user-1" });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(knowledgeEvidenceReceiptHash(first!)).not.toBe(
      knowledgeEvidenceReceiptHash(second!)
    );
    await expect(loadKnowledgeEvidencePackage(client(row({
      strategyExecution: strategyExecution({
        ...firstReceipt,
        dispatchManifestHash: "4".repeat(64)
      }),
      strategySnapshot: { strategy: "full_context" }
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();
  });

  it("drops purged strategy payloads while retaining a usable tombstone package", async () => {
    const receipt = strategyCoverageReceipt("2".repeat(64));
    const purged = {
      ...strategyExecution(receipt),
      coverageReceipt: null,
      coverageReceiptHash: null,
      executionHash: null,
      purgedAt: new Date("2026-08-20T00:00:00.000Z")
    };
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      strategyExecution: purged,
      strategySnapshot: { strategy: "full_context" }
    })), { runId: "run-1", userId: "user-1" });

    expect(evidence).not.toBeNull();
    expect(evidence).not.toHaveProperty("strategyCoverage");
    expect(evidence?.coverage.verified).toBe(false);
  });

  it("validates stored canonical Base provenance without projecting it to readers", async () => {
    const fixture = row();
    const item = fixture.evidenceItems[0]!;
    const link = item.operationLinks[0]!;
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...item,
        operationLinks: [{
          ...link,
          retrievalProvenance: {
            ...link.retrievalProvenance,
            source: {
              artifactId: "artifact-private-id",
              bindings: [{
                baseName: "Policies",
                bindingOrdinal: 0,
                knowledgeBaseId: "base-private-id"
              }, {
                baseName: "Reused policies",
                bindingOrdinal: 1,
                knowledgeBaseId: "second-base-private-id"
              }],
              primaryBindingOrdinal: 0,
              sourceId: "source-private-id",
              sourceVersionId: "source-version-private-id"
            },
            version: 2
          }
        }]
      }]
    })), { runId: "run-1", userId: "user-1" });

    expect(evidence?.items[0]?.provenance[0]).toMatchObject({ version: 1 });
    expect(evidence?.items[0]?.provenance[0]).not.toHaveProperty("source");
    expect(JSON.stringify(evidence?.items[0]?.provenance))
      .not.toContain("second-base-private-id");
  });

  it("rehydrates strict calculation receipts and cited input ranges", async () => {
    const fixture = row();
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...fixture.evidenceItems[0],
        contextBoundaries: {
          expanded: false,
          excerptBytes: 66,
          sourceTextBytes: 66,
          structuredAnalysis: structuredAnalysis()
        },
        locator: {
          page: 2,
          ranges: structuredAnalysis().receipt.inputRanges
        }
      }]
    })), { runId: "run-1", userId: "user-1" });

    expect(evidence).toMatchObject({
      items: [{
        contextBoundaries: {
          structuredAnalysis: {
            receipt: { inputRanges: [{ range: "B2:B3", role: "value" }] },
            rows: [[300]]
          }
        },
        locator: { ranges: [{ range: "B2:B3", role: "value" }] }
      }]
    });
  });

  it("rehydrates strict visual locators and attributable bounded analysis", async () => {
    const fixture = row();
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...fixture.evidenceItems[0],
        contextBoundaries: {
          expanded: false,
          excerptBytes: 66,
          sourceTextBytes: 66,
          visualAnalysis: visualAnalysis()
        }
      }]
    })), { runId: "run-1", userId: "user-1" });

    expect(evidence).toMatchObject({
      items: [{
        contextBoundaries: {
          visualAnalysis: {
            blockId: "block-private-id",
            boundingBoxes: [{ page: 2, left: 20, right: 280 }],
            provider: {
              profileRevisionId: "profile-revision-private-id",
              usage: { totalTokens: 31 }
            },
            status: "available"
          }
        }
      }]
    });
  });

  it("feeds only the private package into deterministic grounding", async () => {
    const result = await groundKnowledgeRunAnswer(client(row(), {
      profileBindings: [authorizedProfileBinding()]
    }), {
      answer: "Atlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    });
    expect(result).toMatchObject({ grounding: { outcome: "passed", repairCount: 0 } });
    expect(result?.grounding.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result?.semanticShadow).toMatchObject({
      contentFreeMetrics: {
        blockingApplied: false,
        egress: "none",
        executionStatus: "complete",
        semanticProof: false,
        usage: { requests: 0 }
      },
      diagnostic: {
        attemptId: null,
        blockingApplied: false,
        executionStatus: "complete",
        runId: "run-1",
        sessionId: "session-1"
      },
      profileRevisionIds: ["profile-revision-1"]
    });
  });

  it("keeps finalization non-blocking when one claim exceeds semantic receipt bounds", async () => {
    const evidenceItems = exactItems(1_001);
    const answer = `All markers are present ${evidenceItems
      .map(({ handle }) => `[${handle}]`).join(" ")}.`;
    const validate = vi.fn(async () => []);
    const result = await groundKnowledgeRunAnswer(client(row({
      evidenceItems,
      readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 1_001 }
    }), {
      profileBindings: [authorizedProfileBinding()]
    }), {
      answer,
      runId: "run-1",
      userId: "user-1"
    }, {
      semanticShadowExecutor: { deployment: semanticDeployment, validate }
    });

    expect(result?.grounding.finalText).toBe(answer);
    expect(result?.semanticShadow.contentFreeMetrics).toMatchObject({
      claimCount: 0,
      egress: "none",
      executionStatus: "unavailable",
      failureReasonCode: "citation_limit_exceeded",
      semanticProof: false
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps an unreleased local selection unavailable without changing answer bytes", async () => {
    const answer = "Atlas retains completed exports for 30 days [K1].";
    const validate = vi.fn(async (
      { request }: Parameters<KnowledgeSemanticLocalValidatorExecutor["validate"]>[0]
    ) => request.claims.map((claim) => ({
      attributableHandles: [...claim.citationHandles],
      claimOrdinal: claim.ordinal,
      confidence: 0.97,
      decision: "supported",
      reasonFamily: "entailed",
      validatorProfile: semanticDeployment.profileId,
      validatorVersion: semanticDeployment.validatorVersion,
      version: 1
    })));
    const result = await groundKnowledgeRunAnswer(client(row(), {
      profileBindings: [selectedSemanticProfileBinding()]
    }), {
      answer,
      runId: "run-1",
      userId: "user-1"
    }, {
      semanticShadowExecutor: { deployment: semanticDeployment, validate }
    });

    expect(result?.grounding.finalText).toBe(answer);
    expect(validate).not.toHaveBeenCalled();
    expect(result?.semanticShadow).toMatchObject({
      contentFreeMetrics: {
        egress: "none",
        executionStatus: "unavailable",
        failureReasonCode: "profile_authorization_unavailable",
        semanticProof: false,
        usage: {
          estimatedCostMicros: null,
          requests: 0,
          totalTokens: null
        },
        validatorProfile: "structural-baseline-v1",
        validatorVersion: 1
      },
      diagnostic: {
        attemptId: null,
        blockingApplied: false,
        latencyMs: null,
        validator: {
          egress: "none",
          semanticProof: false
        }
      }
    });
  });

  it("keeps legacy-user semantic staging unavailable", async () => {
    const validate = vi.fn(async () => []);
    const result = await groundKnowledgeRunAnswer(client(row(), {
      profileBindings: [selectedSemanticProfileBinding(
        semanticDeployment,
        "profile-revision-1",
        "legacy_user"
      )]
    }), {
      answer: "Atlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    }, {
      semanticShadowExecutor: { deployment: semanticDeployment, validate }
    });

    expect(result?.semanticShadow.contentFreeMetrics).toMatchObject({
      egress: "none",
      executionStatus: "unavailable",
      failureReasonCode: "profile_authorization_unavailable",
      semanticProof: false,
      validatorProfile: "structural-baseline-v1"
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects mixed run-bound semantic selections before executor dispatch", async () => {
    const validate = vi.fn(async () => []);
    const driftedDeployment = {
      ...semanticDeployment,
      selectionManifestSha256: "9".repeat(64)
    };
    const result = await groundKnowledgeRunAnswer(client(row(), {
      profileBindings: [
        selectedSemanticProfileBinding(semanticDeployment, "profile-revision-1"),
        selectedSemanticProfileBinding(driftedDeployment, "profile-revision-2")
      ]
    }), {
      answer: "Atlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    }, {
      semanticShadowExecutor: { deployment: semanticDeployment, validate }
    });

    expect(result?.semanticShadow.contentFreeMetrics).toMatchObject({
      egress: "none",
      executionStatus: "unavailable",
      failureReasonCode: "profile_authorization_unavailable",
      semanticProof: false,
      validatorProfile: "structural-baseline-v1"
    });
    expect(result?.semanticShadow.profileRevisionIds).toEqual([
      "profile-revision-1",
      "profile-revision-2"
    ]);
    expect(validate).not.toHaveBeenCalled();
  });

  it("records truthful unavailability when the accepted Profile lacks local authority", async () => {
    const malformed = authorizedProfileBinding();
    const result = await groundKnowledgeRunAnswer(client(row(), {
      profileBindings: [{
        ...malformed,
        profileRevision: { ...malformed.profileRevision, egressPolicy: {} }
      }]
    }), {
      answer: "Atlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({
      grounding: { outcome: "passed" },
      semanticShadow: {
        contentFreeMetrics: {
          blockingApplied: false,
          executionStatus: "unavailable",
          failureReasonCode: "profile_authorization_unavailable"
        },
        diagnostic: {
          attemptId: null,
          claims: [],
          executionStatus: "unavailable",
          failureReasonCode: "profile_authorization_unavailable"
        }
      }
    });
  });

  it("never substitutes run bindings for an empty current dispatch lineage", () => {
    const draft = packKnowledgeEvidenceDispatchManifest({
      allowExpandedContextOmission: true,
      candidates: [],
      coverageStatement: "Coverage verified: no.",
      footer: "</private_knowledge_evidence>",
      header: "<private_knowledge_evidence version=\"2\">",
      maximumBytes: 8_192,
      maximumTokens: 2_048,
      plannerVersion: 2,
      profileId: "test:answer-model",
      promptFragmentVersion: 2
    });
    const current = settledDispatch({ draft });

    expect(knowledgeGroundingProfileRevisionIds({
      dispatch: { ...current, profileRevisionIds: [] },
      kind: "current"
    }, ["profile-revision-1"])).toEqual([]);
    expect(knowledgeGroundingProfileRevisionIds({ kind: "legacy" }, [
      "profile-revision-2",
      "profile-revision-1",
      "profile-revision-2"
    ])).toEqual(["profile-revision-1", "profile-revision-2"]);
  });

  it("loads and grounds exact evidence beyond the legacy eight-result bound", async () => {
    const evidenceItems = exactItems(10);
    const exactRow = row({
      coverageRequirements: {
        expectedPassageCount: 10,
        mode: "verified_only",
        namedTargets: [],
        verified: false
      },
      evidenceItems,
      readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 10 }
    });
    const evidence = await loadKnowledgeEvidencePackage(client(exactRow), {
      runId: "run-1",
      userId: "user-1"
    });

    expect(evidence?.items).toHaveLength(10);
    expect(evidence?.items[9]?.provenance).toEqual([
      expect.objectContaining({ fusion: "none", operation: "find_exact", resultOrdinal: 9 })
    ]);
    await expect(groundKnowledgeRunAnswer(client(exactRow), {
      answer: "Exact marker 10 [K10].",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toMatchObject({ grounding: { outcome: "passed" } });
  });

  it("allows fusion none and wide ordinals only for exact operations", async () => {
    const [exact] = exactItems(1);
    expect(exact).toBeDefined();
    const exactBoundary = {
      ...exact!,
      operationLinks: [{
        ...exact!.operationLinks[0]!,
        resultOrdinal: 99,
        retrievalProvenance: {
          ...exact!.operationLinks[0]!.retrievalProvenance,
          postRerankRank: 100,
          preRerankRank: 100
        }
      }]
    };
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [exactBoundary]
    })), { runId: "run-1", userId: "user-1" })).resolves.toMatchObject({
      items: [{ provenance: [{ resultOrdinal: 99 }] }]
    });

    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...exactBoundary,
        operationLinks: [{
          ...exactBoundary.operationLinks[0]!,
          resultOrdinal: 100
        }]
      }]
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();

    const nonExactFusion = {
      ...exact!,
      operationLinks: [{
        ...exact!.operationLinks[0]!,
        knowledgeRun: {
          ...exact!.operationLinks[0]!.knowledgeRun,
          operation: "search_knowledge"
        },
        retrievalProvenance: {
          ...exact!.operationLinks[0]!.retrievalProvenance,
          operation: "search_knowledge"
        }
      }]
    };
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [nonExactFusion]
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();

    const wideNonExact = {
      ...row().evidenceItems[0]!,
      operationLinks: [{
        ...row().evidenceItems[0]!.operationLinks[0]!,
        resultOrdinal: 8
      }]
    };
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [wideNonExact]
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();
  });

  it("never lets evidence excluded from the final settled manifest support an answer", async () => {
    const fixture = row();
    const first = fixture.evidenceItems[0]!;
    const poison = `${"poison ".repeat(600)}Launch date 2026-09-10.`;
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      coverageRequirements: {
        expectedPassageCount: 2,
        mode: "verified_only",
        namedTargets: [],
        verified: false
      },
      evidenceItems: [first, {
        ...first,
        contentHash: "d".repeat(64),
        contextBoundaries: {
          expanded: false,
          excerptBytes: Buffer.byteLength(poison, "utf8"),
          sourceTextBytes: Buffer.byteLength(poison, "utf8")
        },
        documentId: "poison-document-private-id",
        documentVersionId: "poison-document-version-private-id",
        excerpt: poison,
        fileName: "poison.txt",
        handle: "K2",
        id: "evidence-poison-id",
        operationLinks: [{
          ...first.operationLinks[0]!,
          resultOrdinal: 1,
          retrievalProvenance: {
            ...first.operationLinks[0]!.retrievalProvenance,
            postRerankRank: 2,
            preRerankRank: 2
          }
        }],
        ordinal: 2,
        passageId: "poison-passage-private-id",
        sourceArtifactId: "poison-artifact-private-id",
        sourceId: "poison-source-private-id",
        sourceName: "Poison source",
        sourceVersionId: "poison-source-version-private-id"
      }]
    })), { runId: "run-1", userId: "user-1" });
    expect(evidence).not.toBeNull();
    const draft = packKnowledgeEvidenceDispatchManifest({
      candidates: [{
        ambiguity: "none",
        evidenceId: "provider-call-1:result:1",
        exactExcerpt: first.excerpt,
        fileName: first.fileName,
        handle: "K1",
        locator: "page=2; heading=Retention",
        operationOrdinal: 1,
        resultOrdinal: 1,
        sourceAlias: "S1",
        sourceLabel: first.sourceName,
        sourceTruncated: false,
        sourceVersionNumber: 3,
        state: "available"
      }, {
        ambiguity: "none",
        evidenceId: "provider-call-1:result:2",
        exactExcerpt: poison,
        fileName: "poison.txt",
        handle: "K2",
        locator: "page=2; heading=Retention",
        operationOrdinal: 1,
        resultOrdinal: 2,
        sourceAlias: "S2",
        sourceLabel: "Poison source",
        sourceTruncated: false,
        sourceVersionNumber: 3,
        state: "available"
      }],
      coverageStatement: "Coverage verified: no.",
      footer: "</private_knowledge_evidence>",
      header: "<private_knowledge_evidence version=\"2\">",
      maximumBytes: 1_200,
      maximumTokens: 1_200,
      plannerVersion: 1,
      profileId: "test:answer-model",
      promptFragmentVersion: 2
    });
    expect(draft.items.map(({ handle }) => handle)).toEqual(["K1"]);
    expect(draft.exclusions).toEqual([
      expect.objectContaining({ handle: "K2", reason: "budget" })
    ]);

    const dispatch = settledDispatch({ draft, excludedEvidenceItemId: "evidence-poison-id" });
    expect(() => knowledgeEvidencePackageForGroundingDispatch(evidence!, {
      ...dispatch,
      retrievalSessionId: "incompatible-session"
    })).toThrow("knowledge_evidence_dispatch_grounding_mismatch");
    const narrowed = knowledgeEvidencePackageForGroundingDispatch(evidence!, dispatch);
    const result = groundKnowledgeAnswer({
      answer: "The launch date is 2026-09-10 [K2].",
      evidence: narrowed
    });

    expect(narrowed.items.map(({ handle }) => handle)).toEqual(["K1"]);
    expect(narrowed.coverage.verified).toBe(false);
    expect(narrowed.groundingDispatch).toMatchObject({
      manifestHash: draft.manifestHash,
      providerAttemptOrdinal: 1
    });
    expect(knowledgeEvidenceReceiptHash({
      ...narrowed,
      groundingDispatch: {
        ...narrowed.groundingDispatch!,
        manifestHash: "e".repeat(64)
      }
    })).not.toBe(knowledgeEvidenceReceiptHash(narrowed));
    expect(result).toMatchObject({
      diagnostics: { issueCodes: expect.arrayContaining(["invalid_handle"]) },
      outcome: "no_answer",
      repairCount: 1
    });
    expect(result.finalText).not.toContain("2026-09-10");
  });

  it("fails closed when a current receipt has no compatible dispatch manifest", async () => {
    await expect(groundKnowledgeRunAnswer(client(row(), {
      currentOperation: { id: "current-operation-1" }
    }), {
      answer: "Atlas retains exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_evidence_dispatch_stored_manifest_invalid");

    await expect(groundKnowledgeRunAnswer(client(row(), {
      attempts: [{ manifest: null, modelRunId: "run-1", ordinal: 1 }]
    }), {
      answer: "Atlas retains exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_evidence_dispatch_stored_manifest_invalid");
  });

  it("rehydrates a bounded structured clarification for deterministic finalization", async () => {
    const question = "Уточните лист: Sales или Forecast?";
    const result = await groundKnowledgeRunAnswer(client(row({
      coverageRequirements: {
        expectedPassageCount: null,
        mode: "partial",
        namedTargets: [],
        verified: false
      },
      degradedFlags: ["retrieval_structured_clarification_required"],
      evidenceItems: [],
      originalIntent: { intent: "fact_lookup", query: "Покажи итог по таблице" },
      strategySnapshot: {
        strategy: "focused",
        structuredClarifications: [question]
      }
    })), {
      answer: "I guessed Sales.",
      runId: "run-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ grounding: {
      finalText: question,
      outcome: "repaired",
      repairCount: 1
    }});
  });
});
