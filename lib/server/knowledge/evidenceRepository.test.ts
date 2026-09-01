import { describe, expect, it, vi } from "vitest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import {
  toolLoopCheckpoint,
  toolLoopPersistenceLimits
} from "../runs/toolLoopPersistence";
import {
  groundKnowledgeRunAnswer,
  groundKnowledgeRunAnswerV21,
  knowledgeEvidencePackageForGroundingDispatch,
  loadKnowledgeFullContextDispatchRecovery,
  loadKnowledgeEvidencePackage,
  settleKnowledgeGrounding
} from "./evidenceRepository";
import { knowledgeEvidenceReceiptHash } from "./evidencePackage";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import {
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  knowledgeAnswerHash,
  knowledgeSelectorEvidenceFromManifest
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
  buildKnowledgeSupportedAnswerViewV1,
  createKnowledgeAnswerOperationRequestSnapshotV21,
  decodeKnowledgeAnswerDraftSupplementV21,
  decodeKnowledgeAnswerDraftV21,
  knowledgeAnswerDraftPromptV21,
  mergeKnowledgeAnswerDraftsV21,
  type KnowledgeAnswerOperationRequestSnapshotV21,
  type KnowledgeAnswerOperationV21
} from "./answerGroundingV21";
import {
  knowledgeAnswerTargetedSupplementSchemaV3,
  decodeKnowledgeTargetedSupplementV4,
  mergeKnowledgeTargetedSupplementV2
} from "./answerGroundingCorrectionV21";
import {
  knowledgeAnswerTargetedSupplementPromptV7,
  knowledgeGroundedDeltaSelectorPromptV6,
  knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1
} from "./answerGroundingAnswerLevelCompressionV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
  KNOWLEDGE_COVERAGE_SCOPE_V6_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
  decodeKnowledgeCoverageScopeV6,
  knowledgeCoverageEvidenceFromManifestV6
} from "./coverageScopeV6";
import { KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2 } from "./coverageScopeV4";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1
} from "./coverageScopeCompletenessV1";
import {
  knowledgeCoverageScopeCompletenessPromptV4,
  knowledgeCoverageScopePromptV6AnswerGranularityV2
} from "./coverageScopeAnswerGranularityV2";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_CONTRACT_VERSION,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_MAX_OUTPUT_TOKENS,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V1,
  knowledgeCoverageScopeClosurePromptV1
} from "./coverageScopeClosureV1";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
  KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
  decodeKnowledgeGroundedSelectorV21,
  knowledgeCoverageMissingDimensionsV6
} from "./answerGroundingSelectorV21";
import { knowledgeFullContextDispatchPresentation } from "./fullContext";
import {
  groundKnowledgeAnswer,
  groundSettledKnowledgeAnswerV5,
  groundSettledKnowledgeAnswerV11,
  groundSettledKnowledgeAnswerV14,
  groundSettledKnowledgeAnswerV15,
  groundSettledKnowledgeAnswerV16,
  groundSettledKnowledgeAnswerV17,
  groundSettledKnowledgeAnswerV19
} from "./grounding";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeRetrievalEvidence
} from "./retrievalTypes";
import { knowledgeToolResultContent, knowledgeToolResultText } from "./toolResult";

function row(overrides: Record<string, unknown> = {}) {
  return {
    citationContract: { format: "K{ordinal}", legacyRead: true, maximum: 2048, version: 2 },
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
          operation: "automatic_search",
          resultLimit: 8
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
    originalIntent: {
      kind: "focused_v1",
      request: {
        candidateLimit: 40,
        fusion: "weighted_rrf_v2",
        neighborWindow: 1,
        originalQuery: "How long are exports retained?",
        resultLimit: 8,
        retrievalQuery: "How long are exports retained?",
        version: 1
      }
    },
    readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 1 },
    scopeSnapshot: {
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      selection: { mode: "explicit" }
    },
    version: 2,
    ...overrides
  };
}

function client(value: unknown, input: Readonly<{
  attempts?: readonly unknown[];
  currentOperation?: unknown;
  modelRun?: unknown;
  normalizedRequest?: unknown;
  providerExecutionSnapshot?: unknown;
  toolLoopRun?: unknown;
}> = {}) {
  return {
    knowledgeProviderAttempt: {
      findMany: vi.fn(async (args?: Readonly<{
        orderBy?: Readonly<{ ordinal?: "asc" | "desc" }>;
        take?: number;
        where?: Readonly<{ purpose?: Readonly<{ in?: readonly string[] }> }>;
      }>) => {
        const purposes = args?.where?.purpose?.in
          ? new Set(args.where.purpose.in)
          : null;
        const attempts = [...(input.attempts ?? [])].filter((attempt) =>
          !purposes || typeof attempt === "object" && attempt !== null &&
            "purpose" in attempt && purposes.has(String(attempt.purpose)));
        if (args?.orderBy?.ordinal) {
          attempts.sort((left, right) => {
            const leftOrdinal = typeof left === "object" && left !== null &&
              "ordinal" in left ? Number(left.ordinal) : 0;
            const rightOrdinal = typeof right === "object" && right !== null &&
              "ordinal" in right ? Number(right.ordinal) : 0;
            return args.orderBy?.ordinal === "asc"
              ? leftOrdinal - rightOrdinal
              : rightOrdinal - leftOrdinal;
          });
        }
        return args?.take === undefined ? attempts : attempts.slice(0, args.take);
      })
    },
    knowledgeRetrievalSession: {
      findFirst: vi.fn(async () => value)
    },
    knowledgeRun: {
      findFirst: vi.fn(async () => input.currentOperation ?? null)
    },
    modelRun: {
      findFirst: vi.fn(async () => input.modelRun ?? input.toolLoopRun ?? (
        input.normalizedRequest === undefined
          ? null
          : { normalizedRequest: input.normalizedRequest }
      ))
    },
    providerRunBinding: {
      findUnique: vi.fn(async () => input.providerExecutionSnapshot === undefined
        ? null
        : { executionSnapshot: input.providerExecutionSnapshot })
    }
  } as never;
}

function toolLoopRetrieval(): KnowledgeRetrievalEvidence {
  const includedText = "Completed Atlas exports are retained for 30 days after completion.";
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Policies",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-private-id",
      ordinal: 0,
      state: "ready",
      targetDimension: 1_024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 3,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 1,
      inputTokens: 2,
      modelId: "embedding-v1",
      provider: "test",
      providerModelId: "embedding-deployment-1",
      requestId: null,
      status: "complete",
      totalTokens: 2
    }],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    outcome: "complete",
    providerText: "pending",
    query: "Atlas retention",
    resultLimit: 8,
    results: [{
      annRank: 1,
      baseName: "Policies",
      bindingOrdinal: 0,
      chunkId: "passage-private-id",
      chunkIndex: 0,
      documentId: "document-private-id",
      documentVersionId: "document-version-private-id",
      documentVersionNumber: 3,
      fileName: "retention.md",
      ftsRank: 1,
      ftsScore: 0.5,
      fusedScore: 2 / 61,
      handle: "K1",
      includedText,
      includedTextBytes: Buffer.byteLength(includedText, "utf8"),
      knowledgeBaseId: "base-private-id",
      page: 2,
      sourceAlias: "S1",
      sourceArtifactId: "artifact-private-id",
      sourceName: "Atlas retention",
      sourceTextBytes: Buffer.byteLength(includedText, "utf8"),
      textTruncated: false,
      vectorDistance: 0.1,
      vectorScore: 0.9
    }],
    scopeAliases: [{ alias: "S1", kind: "source", label: "Atlas retention" }],
    version: KNOWLEDGE_RESULT_VERSION
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function persistedToolLoopKnowledgeResult(evidence: KnowledgeRetrievalEvidence) {
  const persisted = snapshotToolExecutionResult({
    callId: "knowledge-provider-call-1",
    content: knowledgeToolResultContent(evidence),
    name: KNOWLEDGE_SEARCH_TOOL_NAME,
    rawPreview: {
      knowledgeResultVersion: evidence.version,
      knowledgeRetrieval: evidence,
      providerCall: true
    },
    status: "complete"
  }, toolLoopPersistenceLimits.resultBytes);
  if (!persisted) throw new Error("tool_loop_knowledge_result_fixture_invalid");
  return persisted;
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
          operation: "find_exact",
          resultLimit: 100
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
      acceptedRequest: null,
      acceptedResult: null,
      actualUsage: usage,
      ambiguousAt: null,
      checkpointHash: "b".repeat(64),
      contractVersion: null,
      dispatchedAt: new Date("2026-08-19T10:01:00.000Z"),
      evidenceReceiptHash: null,
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
      resultAcceptedAt: null,
      resultHash: null,
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

function v21AttemptRow(input: Readonly<{
  acceptedRequest: KnowledgeAnswerOperationRequestSnapshotV21;
  acceptedResult: Readonly<Record<string, unknown>>;
  draft: ReturnType<typeof packKnowledgeEvidenceDispatchManifest>;
  ordinal: number;
  purpose: KnowledgeAnswerOperationV21;
}>) {
  const createdAt = new Date("2026-08-31T00:00:00.000Z");
  const dispatchedAt = new Date("2026-08-31T00:00:01.000Z");
  const settledAt = new Date("2026-08-31T00:00:02.000Z");
  const usage = {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    estimatedCostMicros: null,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    totalTokens: 15
  };
  const manifestId = `manifest-v21-${input.ordinal}`;
  const attemptId = `attempt-v21-${input.ordinal}`;
  const items = input.draft.items.map((item, index) => {
    if ("kind" in item) throw new Error("v21_test_manifest_must_be_atomic");
    return {
      contextBoundaries: {
        expandedContext: item.expandedContext,
        expandedContextOriginalBytes: item.expandedContextOriginalBytes,
        expandedContextOriginalHash: item.expandedContextOriginalHash,
        expandedContextState: item.expandedContextState
      },
      createdAt,
      evidenceItemId: "evidence-private-id",
      exactExcerpt: item.exactExcerpt,
      excerptBytes: item.exactExcerptBytes,
      excerptHash: item.exactExcerptHash,
      handle: item.handle,
      id: `manifest-v21-${input.ordinal}-item-${index + 1}`,
      manifestId,
      ordinal: item.dispatchOrdinal,
      renderedBlock: item.text,
      renderedBlockHash: item.itemHash,
      renderedBytes: item.itemBytes,
      renderedTokens: item.itemTokens,
      representation: item.representation === "full" ? "full" : "shortened",
      safeMetadata: {
        ambiguity: item.ambiguity,
        fileName: item.fileName,
        locator: item.locator,
        sourceLabel: item.sourceLabel,
        sourceTruncated: item.sourceTruncated,
        sourceVersionNumber: item.sourceVersionNumber
      },
      sourceAlias: item.sourceAlias,
      sourceArtifactId: "artifact-private-id",
      sourceVersionId: "source-version-private-id"
    };
  });
  const coverage = {
    exclusions: input.draft.exclusions.map((exclusion) => ({
      duplicateOfEvidenceId: exclusion.duplicateOfEvidenceId,
      evidenceId: exclusion.evidenceId,
      operationOrdinal: exclusion.operationOrdinal,
      resultOrdinal: exclusion.resultOrdinal
    })),
    items: input.draft.items.map((item) => ({
      dispatchOrdinal: item.dispatchOrdinal,
      evidenceId: item.evidenceId,
      operationOrdinal: item.operationOrdinal,
      resultOrdinal: item.resultOrdinal
    })),
    root: {
      coverageStatement: input.draft.coverageStatement,
      footer: input.draft.footer,
      header: input.draft.header,
      limits: input.draft.limits,
      manifestHash: input.draft.manifestHash,
      profileId: input.draft.profileId,
      ...("runtimeVersion" in input.draft
        ? { runtimeVersion: input.draft.runtimeVersion }
        : {}),
      shorteningPolicy: input.draft.shorteningPolicy
    },
    version: 2
  };
  return {
    acceptedRequest: input.acceptedRequest,
    acceptedResult: input.acceptedResult,
    actualUsage: usage,
    ambiguousAt: null,
    checkpointHash: String(input.ordinal).repeat(64),
    contractVersion: input.acceptedRequest.contractVersion,
    createdAt,
    dispatchedAt,
    evidenceReceiptHash: input.draft.manifestHash,
    estimatedUsage: usage,
    failureCode: null,
    id: attemptId,
    idempotencyKey: `knowledge-v21-attempt-${input.ordinal}`,
    leaseExpiresAt: null,
    leaseToken: null,
    manifest: {
      coverage,
      createdAt,
      excludedCount: input.draft.exclusions.length,
      exclusions: [],
      id: manifestId,
      itemCount: items.length,
      items,
      messageHash: input.draft.messageHash,
      messageText: input.draft.message,
      modelRunId: "run-1",
      packingVersion: input.draft.packingVersion,
      profileRevisionIds: ["profile-revision-1"],
      promptFragmentVersion: String(input.draft.promptFragmentVersion),
      providerAttemptId: attemptId,
      purgedAt: null,
      retrievalSessionId: "session-1",
      sealedAt: createdAt,
      shortenedCount: input.draft.items.filter(
        ({ representation }) => representation !== "full"
      ).length,
      totalBytes: input.draft.messageBytes,
      totalTokens: input.draft.messageTokens,
      version: input.draft.version
    },
    modelRunId: "run-1",
    ordinal: input.ordinal,
    providerBindingKey: "answer",
    providerResponseId: `provider-response-v21-${input.ordinal}`,
    purpose: input.purpose,
    releasedAt: null,
    requestHash: knowledgeAnswerHash(input.acceptedRequest),
    resultAcceptedAt: settledAt,
    resultHash: knowledgeAnswerHash(input.acceptedResult),
    roundIndex: 0,
    settledAt,
    state: "settled",
    updatedAt: settledAt
  };
}

function fakeProviderExecutionSnapshot() {
  return {
    connection: {
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1",
      authenticationMode: "none",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "Fake",
    connectionId: "fake-connection",
    credentialId: null,
    credentialVersionId: null,
    model: {
      adapterKind: "fake",
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      defaultParams: {},
      upstreamModelId: "fake-qsa"
    },
    modelDisplayName: "Fake QSA",
    providerFamily: "fake",
    providerModelId: "fake-model",
    version: 1
  };
}

describe("Knowledge Evidence v2 repository projection", () => {
  it("loads an exact bounded focused package with structural-only coverage", async () => {
    const evidence = await loadKnowledgeEvidencePackage(client(row()), {
      runId: "run-1",
      userId: "user-1"
    });
    expect(evidence).toMatchObject({
      citationContract: { format: "K{ordinal}", version: 2 },
      coverage: { expectedPassageCount: null, mode: "partial", verified: false },
      items: [{
        handle: "K1",
        locator: { page: 2 },
        provenance: [{ confidenceBucket: "high", postRerankRank: 1 }],
        state: "available"
      }],
      originalIntent: { kind: "focused_v1" },
      version: 2
    });
  });

  it("loads full-context evidence without synthetic retrieval provenance and verifies its final dispatch", async () => {
    const fixture = row();
    const evidenceRow = fixture.evidenceItems[0]!;
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{ ...evidenceRow, operationLinks: [] }],
      originalIntent: { kind: "full_context_v1" }
    })), { runId: "run-1", userId: "user-1" });
    expect(evidence).toMatchObject({
      coverage: { expectedPassageCount: 1, mode: "verified_only", verified: true },
      items: [{ handle: "K1", provenance: [] }],
      originalIntent: { kind: "full_context_v1" }
    });
    expect(evidence).not.toBeNull();

    const draft = packKnowledgeEvidenceDispatchManifest({
      allowExpandedContextOmission: false,
      candidates: [{
        ambiguity: "none",
        evidenceId: "full-context-evidence-1:result:1",
        exactExcerpt: evidenceRow.excerpt,
        fileName: evidenceRow.fileName,
        handle: "K1",
        locator: "page=2; heading=Retention",
        operationOrdinal: 0,
        resultOrdinal: 1,
        sourceAlias: "S1",
        sourceLabel: evidenceRow.sourceName,
        sourceTruncated: false,
        sourceVersionNumber: 3,
        state: "available"
      }],
      coverageStatement: "The full admitted corpus is included with no passage omitted.",
      footer: "</private_knowledge_evidence>",
      header: '<private_knowledge_evidence version="4" coverage="full_admitted_corpus">',
      maximumBytes: 8_192,
      maximumTokens: 2_048,
      runtimeVersion: 2,
      profileId: "test:answer-model",
      promptFragmentVersion: 4
    });
    const narrowed = knowledgeEvidencePackageForGroundingDispatch(
      evidence!,
      settledDispatch({ draft })
    );
    expect(narrowed.coverage.verified).toBe(true);
    expect(groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nAtlas retains exports for 30 days citeK1.",
      evidence: narrowed
    }).finalText).toBe("Atlas retains exports for 30 days [K1].");
  });

  it("rebuilds the canonical full-context manifest only from persisted accepted evidence", async () => {
    const fixture = row();
    const evidenceRow = fixture.evidenceItems[0]!;
    const recovery = await loadKnowledgeFullContextDispatchRecovery(client(row({
      evidenceItems: [{ ...evidenceRow, operationLinks: [] }],
      originalIntent: { kind: "full_context_v1" }
    }), {
      modelRun: {
        knowledgeRunSourceBindings: [{
          sourceAlias: "S1",
          sourceArtifactId: evidenceRow.sourceArtifactId,
          sourceVersionId: evidenceRow.sourceVersionId,
          tombstonedAt: null
        }]
      }
    }), {
      maximumTokens: 2_048,
      modelId: "answer-model",
      provider: "test",
      runId: "run-1",
      userId: "user-1"
    });

    expect(recovery).toMatchObject({
      draft: {
        exclusions: [],
        profileId: "test:answer-model",
        promptFragmentVersion: 18,
        runtimeVersion: 2,
        version: 2
      },
      evidenceBindings: [{
        dispatchEvidenceId: "full-context-evidence-private-id:result:1",
        evidenceItemId: "evidence-private-id"
      }]
    });
    expect(recovery?.draft.items[0]).toMatchObject({
      evidenceId: "full-context-evidence-private-id:result:1",
      exactExcerpt: evidenceRow.excerpt,
      locator: "page=2; heading=Retention; source-passage=1",
      sourceAlias: "S1"
    });
    expect(recovery?.draft.message).toContain(
      '<private_knowledge_evidence version="11" coverage="full_admitted_corpus">'
    );
  });

  it("rebuilds the same bounded table presentation from persisted atomic evidence", async () => {
    const template = row().evidenceItems[0]!;
    const evidenceItems = Array.from({ length: 6 }, (_, index) => {
      const excerpt = index % 3 === 0
        ? `Record ${String.fromCharCode(65 + index)}`
        : index % 3 === 1
          ? `Attribute ${index}`
          : `Value ${index}`;
      return {
        ...template,
        contentHash: (index + 1).toString(16).padStart(64, "0"),
        contextBoundaries: {
          documentContext: createKnowledgeTableDocumentContext({
            blockId: "private-recovery-table",
            cells: [{ columnEnd: 1, columnStart: 0, text: excerpt }],
            headerLineage: [],
            rowIndex: index
          }),
          expanded: false,
          excerptBytes: Buffer.byteLength(excerpt, "utf8"),
          sourceTextBytes: Buffer.byteLength(excerpt, "utf8")
        },
        excerpt,
        handle: `K${index + 1}`,
        id: `table-evidence-${index + 1}`,
        operationLinks: [],
        ordinal: index + 1,
        passageId: `table-passage-${index + 1}`
      };
    });
    const recovery = await loadKnowledgeFullContextDispatchRecovery(client(row({
      evidenceItems,
      originalIntent: { kind: "full_context_v1" }
    }), {
      modelRun: {
        knowledgeRunSourceBindings: [{
          sourceAlias: "S1",
          sourceArtifactId: template.sourceArtifactId,
          sourceVersionId: template.sourceVersionId,
          tombstonedAt: null
        }]
      }
    }), {
      maximumTokens: 8_192,
      modelId: "answer-model",
      provider: "test",
      runId: "run-1",
      userId: "user-1"
    });
    const expected = knowledgeFullContextDispatchPresentation(evidenceItems.map((item) => ({
      documentContext: item.contextBoundaries.documentContext,
      exactExcerpt: item.excerpt,
      handle: item.handle,
      headingPath: item.headingPath,
      page: item.locator.page,
      sourceAlias: "S1"
    })));

    expect(recovery?.draft.items.map((item) => item.expandedContext)).toEqual(
      expected.expandedContexts
    );
    expect(recovery?.draft.items[3]).toMatchObject({
      expandedContextState: "included",
      handle: "K4"
    });
    expect(recovery?.draft.items[3]?.expandedContext).toContain("handle=K1; table=T1");
    expect(recovery?.draft.items[3]?.expandedContext).toContain("handle=K6; table=T1");
    expect(recovery && knowledgeSelectorEvidenceFromManifest(recovery.draft)
      .map((item) => item.handle)).toEqual(["K1", "K2", "K3", "K4", "K5", "K6"]);
    expect(recovery?.draft.message).not.toContain("private-recovery-table");
  });

  it("keeps partial readiness unverified", async () => {
    const evidence = await loadKnowledgeEvidencePackage(client(row({
      readinessSummary: { excludedResources: 1, readyBases: 1, readySources: 1 }
    })), { runId: "run-1", userId: "user-1" });
    expect(evidence?.coverage.verified).toBe(false);
  });

  it("grounds a tool-loop handle only after its exact result reached a provider checkpoint", async () => {
    const evidence = toolLoopRetrieval();
    const persisted = persistedToolLoopKnowledgeResult(evidence);
    const toolCall = {
      knowledgeRun: {
        evidenceLinks: [{ evidenceItemId: "evidence-private-id" }],
        providerText: evidence.providerText,
        retrievalSessionId: "session-1"
      },
      providerCallId: "knowledge-provider-call-1",
      result: persisted,
      roundIndex: 1,
      state: "complete",
      toolName: KNOWLEDGE_SEARCH_TOOL_NAME
    };
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: { responseId: "response-after-tools" },
      roundIndex: 2
    });
    if (!checkpoint) throw new Error("tool_loop_checkpoint_fixture_invalid");
    const toolLoopRow = row({ originalIntent: { kind: "tool_loop_v1" } });

    await expect(groundKnowledgeRunAnswer(client(toolLoopRow, {
      toolLoopRun: { toolCalls: [toolCall], toolLoopState: checkpoint }
    }), {
      answer: "Atlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toMatchObject({
      grounding: {
        finalText: "Atlas retains completed exports for 30 days [K1].",
        outcome: "answered",
        sessionId: "session-1"
      }
    });

    const undispatched = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 1
    });
    if (!undispatched) throw new Error("tool_loop_checkpoint_fixture_invalid");
    await expect(groundKnowledgeRunAnswer(client(toolLoopRow, {
      toolLoopRun: { toolCalls: [toolCall], toolLoopState: undispatched }
    }), {
      answer: "Undispatched claim [K1].",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("outside the final evidence manifest");
  });

  it("accepts Search-only Markdown when a selected Knowledge session delivered no handles", async () => {
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 1
    });
    if (!checkpoint) throw new Error("tool_loop_checkpoint_fixture_invalid");
    const answer = "See [Kubernetes docs](https://example.test/kubernetes) for current details.";

    await expect(groundKnowledgeRunAnswer(client(row({
      evidenceItems: [],
      originalIntent: { kind: "tool_loop_v1" }
    }), {
      toolLoopRun: { toolCalls: [], toolLoopState: checkpoint }
    }), {
      answer,
      runId: "run-1",
      userId: "user-1"
    })).resolves.toMatchObject({ grounding: { finalText: answer, outcome: "answered" } });
  });

  it("fails tool-loop grounding when the persisted result and receipt text diverge", async () => {
    const evidence = toolLoopRetrieval();
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 2
    });
    if (!checkpoint) throw new Error("tool_loop_checkpoint_fixture_invalid");
    await expect(groundKnowledgeRunAnswer(client(row({
      originalIntent: { kind: "tool_loop_v1" }
    }), {
      toolLoopRun: {
        toolCalls: [{
          knowledgeRun: {
            evidenceLinks: [{ evidenceItemId: "evidence-private-id" }],
            providerText: "tampered provider text",
            retrievalSessionId: "session-1"
          },
          providerCallId: "knowledge-provider-call-1",
          result: persistedToolLoopKnowledgeResult(evidence),
          roundIndex: 1,
          state: "complete",
          toolName: KNOWLEDGE_SEARCH_TOOL_NAME
        }],
        toolLoopState: checkpoint
      }
    }), {
      answer: "Tampered claim [K1].",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_evidence_dispatch_grounding_mismatch");
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

  it("accepts a bounded neighbor rank beyond the legacy single-lane window", async () => {
    const fixture = row();
    const item = fixture.evidenceItems[0]!;
    const operation = item.operationLinks[0]!;
    const loaded = await loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...item,
        operationLinks: [{
          ...operation,
          retrievalProvenance: {
            ...operation.retrievalProvenance,
            signals: [
              ...operation.retrievalProvenance.signals,
              {
                exactKind: null,
                lane: "neighbor",
                rank: 242,
                rawScore: 0.001,
                vectorDistance: null,
                vectorMode: null
              }
            ]
          }
        }]
      }]
    })), { runId: "run-1", userId: "user-1" });

    expect(loaded?.items[0]?.provenance[0]?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: "neighbor", rank: 242 })
    ]));
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

  it("rehydrates historical calculation receipts for immutable citation reads", async () => {
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

  it("rehydrates historical visual receipts for immutable citation reads", async () => {
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

  it("feeds only the private package into structural grounding", async () => {
    const result = await groundKnowledgeRunAnswer(client(row()), {
      answer: "AIQSA_KB_STATUS=ANSWERED\nAtlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    });
    expect(result).toMatchObject({ grounding: { outcome: "answered" } });
    expect(result?.grounding.finalText).toBe(
      "Atlas retains completed exports for 30 days [K1]."
    );
    expect(result?.grounding.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reconstructs answer-level compression into Evidence V47", async () => {
    const evidenceRow = row().evidenceItems[0]!;
    const request =
      "How long are completed Atlas exports retained, and when does retention start?";
    const dispatchDraft = packKnowledgeEvidenceDispatchManifest({
      candidates: [{
        ambiguity: "none",
        evidenceId: "provider-call-1:result:1",
        exactExcerpt: evidenceRow.excerpt,
        fileName: evidenceRow.fileName,
        handle: "K1",
        locator: "page=2; heading=Retention",
        operationOrdinal: 1,
        resultOrdinal: 1,
        sourceAlias: "S1",
        sourceLabel: evidenceRow.sourceName,
        sourceTruncated: false,
        sourceVersionNumber: 3,
        state: "available"
      }],
      coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
      footer: "</private_knowledge_evidence>",
      header: '<private_knowledge_evidence version="4">',
      maximumBytes: 16_384,
      maximumTokens: 4_096,
      profileId: "fake:fake-qsa",
      promptFragmentVersion: 1,
      runtimeVersion: 1
    });
    const rawDraft = {
      claims: [{
        citationHints: ["K1"],
        text: "Completed Atlas exports are retained for 30 days."
      }],
      version: 1
    };
    const acceptedDraft = decodeKnowledgeAnswerDraftV21(rawDraft, {
      availableHandles: ["K1"]
    });
    expect(acceptedDraft).not.toBeNull();
    const selectorEvidence = knowledgeCoverageEvidenceFromManifestV6(dispatchDraft);
    const rawScope = {
      evidenceUnits: [{
        findings: [{
          description: "State the retention duration for completed Atlas exports.",
          evidenceAtomIds: ["A1"],
          requestAnchor: "How long"
        }, {
          description: "State when the retention period starts.",
          evidenceAtomIds: ["A1"],
          requestAnchor: "when does retention start"
        }],
        handle: "K1"
      }],
      jointFindings: [],
      unsupportedDimensions: [],
      version: 6
    } as const;
    const acceptedScope = decodeKnowledgeCoverageScopeV6(rawScope, {
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence: selectorEvidence,
      request
    });
    expect(acceptedScope).not.toBeNull();
    const rawSelector = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    const acceptedSelector = decodeKnowledgeGroundedSelectorV21(rawSelector, {
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      draft: acceptedDraft!,
      evidence: selectorEvidence,
      request,
      scope: acceptedScope!,
      scopeProtocol: "append_only_completeness_v1"
    });
    expect(acceptedSelector).not.toBeNull();
    const executionPolicy = {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "low",
      supplementReasoningEffort: "low",
      version: 1
    } as const;
    const draftPrompt = knowledgeAnswerDraftPromptV21({
      draftPass: "primary",
      evidenceManifest: dispatchDraft.message,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    });
    const initialScopePrompt = knowledgeCoverageScopePromptV6AnswerGranularityV2({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence: selectorEvidence,
      evidenceManifest: dispatchDraft.message,
      repairBaseHash: null,
      request,
      scopePass: "initial"
    });
    const completenessPrompt = knowledgeCoverageScopeCompletenessPromptV4({
      acceptedScope: acceptedScope!,
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      completenessPass: "initial",
      evidence: selectorEvidence,
      evidenceManifest: dispatchDraft.message,
      request
    });
    const selectorPrompt = knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      draft: acceptedDraft!,
      evidence: selectorEvidence,
      evidenceManifest: dispatchDraft.message,
      request,
      scope: acceptedScope!,
      scopeProtocol: "append_only_completeness_v1",
      selectorPass: "initial"
    });
    const commonRequest = {
      evidenceReceiptHash: dispatchDraft.manifestHash,
      executionPolicy,
      protocol:
        KNOWLEDGE_ANSWER_SCOPE_V6_ANSWER_LEVEL_COMPRESSION_PROTOCOL_V1,
      transport: "native_strict" as const
    };
    const draftRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: 21,
      maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
      systemPrompt: draftPrompt.systemPrompt,
      userPrompt: draftPrompt.userPrompt
    });
    const initialScopeRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: KNOWLEDGE_COVERAGE_SCOPE_V6_CONTRACT_VERSION,
      maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_V6_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
      systemPrompt: initialScopePrompt.systemPrompt,
      userPrompt: initialScopePrompt.userPrompt
    });
    const coverageScopePayloadHash = knowledgeAnswerHash(acceptedScope);
    const completenessRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_CONTRACT_VERSION,
      coverageScopePayloadHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      schema: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1,
      systemPrompt: completenessPrompt.systemPrompt,
      userPrompt: completenessPrompt.userPrompt
    });
    const selectorRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
      coverageScopePayloadHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
      systemPrompt: selectorPrompt.systemPrompt,
      userPrompt: selectorPrompt.userPrompt
    });
    const supportedView = buildKnowledgeSupportedAnswerViewV1({
      draft: acceptedDraft!,
      evidence: selectorEvidence,
      selector: {
        claims: acceptedSelector!.claims,
        extractIds: acceptedSelector!.extractIds,
        insufficientReason: acceptedSelector!.insufficientReason,
        version: acceptedSelector!.version
      }
    });
    const closurePrompt = knowledgeCoverageScopeClosurePromptV1({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      closurePass: "initial",
      evidence: selectorEvidence,
      request,
      scope: acceptedScope!,
      selector: acceptedSelector!,
      supportedView
    });
    const closureRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_CONTRACT_VERSION,
      coverageScopePayloadHash,
      maxOutputTokens: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      schema: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V1,
      systemPrompt: closurePrompt.systemPrompt,
      userPrompt: closurePrompt.userPrompt
    });
    const rawClosure = {
      decisions: [{ id: "D1", status: "closed" }],
      version: 1
    } as const;
    const missingDimensions = knowledgeCoverageMissingDimensionsV6(acceptedSelector!);
    const rawSupplement = {
      targets: {
        D2: ["The retention period starts after completion."]
      },
      version: 2
    };
    const acceptedSupplement = decodeKnowledgeTargetedSupplementV4(rawSupplement, {
      availableHandles: ["K1"],
      missingDimensions,
      primaryDraft: acceptedDraft!
    });
    expect(acceptedSupplement).not.toBeNull();
    const merged = mergeKnowledgeTargetedSupplementV2({
      primaryDraft: acceptedDraft!,
      supplement: acceptedSupplement!
    });
    const mergedDraft = merged.draft;
    const supplementPrompt = knowledgeAnswerTargetedSupplementPromptV7({
      auditDimensions: missingDimensions,
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence: selectorEvidence,
      primaryClaimCount: acceptedDraft!.claims.length,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    });
    const finalPrompt = knowledgeGroundedDeltaSelectorPromptV6({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      bindings: merged.bindings,
      draft: mergedDraft,
      evidence: selectorEvidence,
      initialSelector: acceptedSelector!,
      request,
      scope: acceptedScope!
    });
    const finalRepairPrompt = knowledgeGroundedDeltaSelectorPromptV6({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      bindings: merged.bindings,
      draft: mergedDraft,
      evidence: selectorEvidence,
      initialSelector: acceptedSelector!,
      repairReason: "selector_coverage_invalid",
      request,
      scope: acceptedScope!
    });
    const supplementRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: 21,
      coverageScopePayloadHash,
      maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      schema: knowledgeAnswerTargetedSupplementSchemaV3({
        primaryClaimCount: acceptedDraft!.claims.length,
        targetDimensions: missingDimensions
      }),
      systemPrompt: supplementPrompt.systemPrompt,
      userPrompt: supplementPrompt.userPrompt
    });
    const finalRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
      coverageScopePayloadHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
      schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
      systemPrompt: finalPrompt.systemPrompt,
      userPrompt: finalPrompt.userPrompt
    });
    const finalRepairRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      ...commonRequest,
      contractVersion: KNOWLEDGE_GROUNDED_SELECTOR_V21_CONTRACT_VERSION,
      coverageScopePayloadHash,
      maxOutputTokens: KNOWLEDGE_GROUNDED_SELECTOR_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
      schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
      systemPrompt: finalRepairPrompt.systemPrompt,
      userPrompt: finalRepairPrompt.userPrompt
    });
    const rawFinalSelector = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
        id: "C2",
        supportHandles: ["K1"],
        verdict: "supported"
      }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "covered",
        supportIds: ["C2"]
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    const attempts = [
      v21AttemptRow({
        acceptedRequest: draftRequest,
        acceptedResult: rawDraft,
        draft: dispatchDraft,
        ordinal: 1,
        purpose: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
      }),
      v21AttemptRow({
        acceptedRequest: initialScopeRequest,
        acceptedResult: rawScope,
        draft: dispatchDraft,
        ordinal: 2,
        purpose: KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
      }),
      v21AttemptRow({
        acceptedRequest: completenessRequest,
        acceptedResult: { additions: [], version: 1 },
        draft: dispatchDraft,
        ordinal: 3,
        purpose: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
      }),
      v21AttemptRow({
        acceptedRequest: selectorRequest,
        acceptedResult: rawSelector,
        draft: dispatchDraft,
        ordinal: 4,
        purpose: KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
      }),
      v21AttemptRow({
        acceptedRequest: closureRequest,
        acceptedResult: rawClosure,
        draft: dispatchDraft,
        ordinal: 5,
        purpose: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
      }),
      v21AttemptRow({
        acceptedRequest: supplementRequest,
        acceptedResult: rawSupplement,
        draft: dispatchDraft,
        ordinal: 6,
        purpose: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
      }),
      v21AttemptRow({
        acceptedRequest: finalRequest,
        acceptedResult: {
          kind: "selector_failed",
          reason: "selector_coverage_invalid"
        },
        draft: dispatchDraft,
        ordinal: 7,
        purpose: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
      }),
      v21AttemptRow({
        acceptedRequest: finalRepairRequest,
        acceptedResult: rawFinalSelector,
        draft: dispatchDraft,
        ordinal: 8,
        purpose: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
      })
    ];

    const result = await groundKnowledgeRunAnswerV21(client(row(), {
      attempts,
      providerExecutionSnapshot: fakeProviderExecutionSnapshot()
    }), { runId: "run-1", userId: "user-1" });

    expect(result.grounding).toMatchObject({
      coverage: {
        coveredDimensionCount: 1,
        excludedDimensionCount: 0,
        missingDimensionCount: 1,
        status: "accepted"
      },
      coverageScope: {
        dimensionCount: 2,
        status: "accepted"
      },
      contracts: {
        coverageAuditorContractVersion: 6,
        draftContractVersion: 21,
        selectorContractVersion: 21,
        settlementVersion: 6
      },
      correctionAttempted: true,
      correctionSucceeded: true,
      closure: {
        initialCoveredDimensionCount: 1,
        payloadHash: knowledgeAnswerHash(rawClosure),
        reopenedDimensionCount: 0
      },
      closureRepairAttempted: false,
      closureRepairSucceeded: false,
      completeness: {
        addedDimensionCount: 0,
        initialDimensionCount: 2,
        status: "accepted"
      },
      finalText: [
        "- Completed Atlas exports are retained for 30 days. [K1]",
        "- The retention period starts after completion. [K1]"
      ].join("\n"),
      requestCoverage: "complete",
      scopeRepairAttempted: false,
      scopeRepairSucceeded: false,
      supportedClaimCount: 2,
      version: 47
    });
    expect(result.grounding).toMatchObject({
      answerBindingFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      draftClaimCount: 2,
      executionPolicy,
      executionPolicyFingerprint: knowledgeAnswerHash(executionPolicy)
    });
    expect("operations" in result.grounding &&
      result.grounding.operations.map(({ role }) => role)).toEqual([
      "primary",
      "scope",
      "scope_completeness",
      "initial",
      "scope_closure",
      "supplement",
      "final",
      "final"
    ]);
    const conflictingCompletenessRequest = {
      ...completenessRequest,
      userPrompt: "{}"
    };
    await expect(groundKnowledgeRunAnswerV21(client(row(), {
      attempts: attempts.map((attempt, index) => index === 2
        ? {
            ...attempt,
            acceptedRequest: conflictingCompletenessRequest,
            requestHash: knowledgeAnswerHash(conflictingCompletenessRequest)
          }
        : attempt),
      providerExecutionSnapshot: fakeProviderExecutionSnapshot()
    }), { runId: "run-1", userId: "user-1" })).rejects.toThrow(
      "knowledge_answer_operation_snapshot_conflict"
    );
  });

  it("rejects focused Knowledge finalization when its evidence receipt is missing", async () => {
    await expect(groundKnowledgeRunAnswer(client(null, {
      normalizedRequest: {
        knowledgeFocusedRequest: {
          candidateLimit: 40,
          fusion: "weighted_rrf_v2",
          neighborWindow: 1,
          originalQuery: "How long are exports retained?",
          resultLimit: 8,
          retrievalQuery: "How long are exports retained?",
          version: 1
        }
      }
    }), {
      answer: "AIQSA_KB_STATUS=ANSWERED\nUnverified answer.",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_evidence_receipt_invalid");
  });

  it("loads and grounds exact evidence beyond the legacy eight-result bound", async () => {
    const evidenceItems = exactItems(10);
    const exactRow = row({
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
      answer: "AIQSA_KB_STATUS=ANSWERED\nExact marker 10 [K10].",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toMatchObject({ grounding: { outcome: "answered" } });
  });

  it("allows fusion none only for exact operations and binds ordinals to the stored result limit", async () => {
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
          operation: "automatic_search"
        },
        retrievalProvenance: {
          ...exact!.operationLinks[0]!.retrievalProvenance,
          operation: "automatic_search"
        }
      }]
    };
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [nonExactFusion]
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();

    const broadNonExact = {
      ...row().evidenceItems[0]!,
      operationLinks: [{
        ...row().evidenceItems[0]!.operationLinks[0]!,
        knowledgeRun: {
          ...row().evidenceItems[0]!.operationLinks[0]!.knowledgeRun,
          resultLimit: 16
        },
        resultOrdinal: 15
      }]
    };
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [broadNonExact]
    })), { runId: "run-1", userId: "user-1" })).resolves.toMatchObject({
      items: [{ provenance: [{ resultOrdinal: 15 }] }]
    });
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [{
        ...broadNonExact,
        operationLinks: [{
          ...broadNonExact.operationLinks[0]!,
          resultOrdinal: 16
        }]
      }]
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();

    const scopedOverflow = {
      ...row().evidenceItems[0]!,
      operationLinks: [{
        ...row().evidenceItems[0]!.operationLinks[0]!,
        resultOrdinal: 8
      }]
    };
    await expect(loadKnowledgeEvidencePackage(client(row({
      evidenceItems: [scopedOverflow]
    })), { runId: "run-1", userId: "user-1" })).resolves.toBeNull();
  });

  it("never lets evidence excluded from the final settled manifest support an answer", async () => {
    const fixture = row();
    const first = fixture.evidenceItems[0]!;
    const poison = `${"poison ".repeat(600)}Launch date 2026-09-10.`;
    const evidence = await loadKnowledgeEvidencePackage(client(row({
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
      runtimeVersion: 1,
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
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nThe launch date is 2026-09-10 [K2].",
      evidence: narrowed
    })).toThrow("The Knowledge answer cited a handle outside the final evidence manifest");
  });

  it("fails closed when a current receipt has no compatible dispatch manifest", async () => {
    await expect(groundKnowledgeRunAnswer(client(row(), {
      currentOperation: { id: "current-operation-1" }
    }), {
      answer: "AIQSA_KB_STATUS=ANSWERED\nAtlas retains exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_evidence_dispatch_stored_manifest_invalid");

    await expect(groundKnowledgeRunAnswer(client(row(), {
      attempts: [{ manifest: null, modelRunId: "run-1", ordinal: 1 }]
    }), {
      answer: "AIQSA_KB_STATUS=ANSWERED\nAtlas retains exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_evidence_dispatch_stored_manifest_invalid");
  });

  it("persists content-free Grounding Evidence V7 idempotently and rejects replay drift", async () => {
    const evidenceRow = row({ originalIntent: { kind: "tool_loop_v1" } });
    const acceptedEvidence = await loadKnowledgeEvidencePackage(client(evidenceRow), {
      runId: "run-1",
      userId: "user-1"
    });
    expect(acceptedEvidence).not.toBeNull();
    const retrieval = toolLoopRetrieval();
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: { responseId: "response-after-tools" },
      roundIndex: 2
    });
    if (!checkpoint) throw new Error("tool_loop_checkpoint_fixture_invalid");
    const toolLoopRun = {
      toolCalls: [{
        knowledgeRun: {
          evidenceLinks: [{ evidenceItemId: "evidence-private-id" }],
          providerText: retrieval.providerText,
          retrievalSessionId: "session-1"
        },
        providerCallId: "knowledge-provider-call-1",
        result: persistedToolLoopKnowledgeResult(retrieval),
        roundIndex: 1,
        state: "complete",
        toolName: KNOWLEDGE_SEARCH_TOOL_NAME
      }],
      toolLoopState: checkpoint
    };
    const usage = {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 14
    };
    const grounding = groundSettledKnowledgeAnswerV5({
      contracts: {
        draftContractVersion: 11,
        selectorContractVersion: 7
      },
      draft: {
        claimCount: 1,
        durationMs: 12,
        hash: "a".repeat(64),
        operationId: "draft-operation-v4",
        providerRequestId: "draft-response-v4",
        usage
      },
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "c".repeat(64),
      selector: {
        durationMs: 8,
        hash: "b".repeat(64),
        operationId: "selector-operation-v1",
        providerRequestId: "selector-response-v1",
        usage
      },
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Atlas retains completed exports for 30 days. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });
    let acceptedAt: Date | null = null;
    let receiptHash: string | null = null;
    let existing: Record<string, unknown> | null = null;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      existing = { ...data };
      return data;
    });
    const transaction = {
      $queryRaw: vi.fn(async () => [{
        acceptedAt,
        id: "session-1",
        receiptHash
      }]),
      knowledgeGroundingResult: {
        create,
        findUnique: vi.fn(async () => existing)
      },
      knowledgeProviderAttempt: { findMany: vi.fn(async () => []) },
      knowledgeRetrievalSession: {
        findFirst: vi.fn(async () => evidenceRow),
        findUnique: vi.fn(async () => ({
          modelRun: { userId: "user-1" },
          modelRunId: "run-1"
        })),
        update: vi.fn(async ({ data }: { data: { acceptedAt: Date; receiptHash: string } }) => {
          acceptedAt = data.acceptedAt;
          receiptHash = data.receiptHash;
          return { id: "session-1" };
        })
      },
      knowledgeRun: { findFirst: vi.fn(async () => null) },
      modelRun: { findFirst: vi.fn(async () => toolLoopRun) }
    };

    await expect(settleKnowledgeGrounding(transaction as never, { grounding }))
      .resolves.toBeUndefined();
    await expect(settleKnowledgeGrounding(transaction as never, { grounding }))
      .resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    const storedEvidence = (existing as { evidence?: unknown } | null)?.evidence;
    expect(storedEvidence).toMatchObject({
      draftContractVersion: 11,
      evidenceReceiptHash: "c".repeat(64),
      selectorContractVersion: 7,
      version: 7
    });
    expect(JSON.stringify(storedEvidence)).not.toContain("finalText");
    expect(JSON.stringify(storedEvidence)).not.toContain("Completed Atlas exports");

    existing = {
      ...(existing as Record<string, unknown> | null ?? {}),
      evidence: {
        ...(storedEvidence as Record<string, unknown>),
        selectorHash: "f".repeat(64)
      }
    };
    await expect(settleKnowledgeGrounding(transaction as never, { grounding }))
      .rejects.toThrow("knowledge_grounding_result_conflict");

    existing = null;
    create.mockClear();
    const groundingV11 = groundSettledKnowledgeAnswerV11({
      contracts: { draftContractVersion: 15, selectorContractVersion: 11 },
      draftClaimCount: 1,
      drafts: [{
        claimCount: 1,
        durationMs: 12,
        hash: "d".repeat(64),
        operationId: "draft-operation-v15",
        providerRequestId: "draft-response-v15",
        role: "primary",
        usage
      }],
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "e".repeat(64),
      selectors: [{
        claimCount: null,
        durationMs: 8,
        hash: "f".repeat(64),
        operationId: "selector-operation-v11",
        providerRequestId: "selector-response-v11",
        role: "initial",
        usage
      }],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Atlas retains completed exports for 30 days. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });
    await expect(settleKnowledgeGrounding(transaction as never, {
      grounding: groundingV11
    })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect((existing as { evidence?: unknown } | null)?.evidence).toMatchObject({
      draftContractVersion: 15,
      selectorContractVersion: 11,
      selectorValidationRepairApplied: false,
      version: 11
    });

    existing = null;
    create.mockClear();
    const groundingV14 = groundSettledKnowledgeAnswerV14({
      contracts: { draftContractVersion: 18, selectorContractVersion: 14 },
      draftClaimCount: 2,
      drafts: [{
        claimCount: 2,
        durationMs: 12,
        hash: "1".repeat(64),
        operationId: "draft-operation-v18",
        providerRequestId: "draft-response-v18",
        role: "primary",
        usage
      }],
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "2".repeat(64),
      selectors: [{
        claimCount: null,
        durationMs: 8,
        hash: "3".repeat(64),
        operationId: "selector-operation-v14",
        providerRequestId: "selector-response-v14",
        role: "initial",
        usage
      }],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Both co-equal results are supported. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });
    await expect(settleKnowledgeGrounding(transaction as never, {
      grounding: groundingV14
    })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect((existing as { evidence?: unknown } | null)?.evidence).toMatchObject({
      draftContractVersion: 18,
      selectorContractVersion: 14,
      selectorValidationRepairApplied: false,
      version: 14
    });

    existing = null;
    create.mockClear();
    const groundingV15 = groundSettledKnowledgeAnswerV15({
      contracts: { draftContractVersion: 19, selectorContractVersion: 15 },
      draftClaimCount: 2,
      drafts: [{
        claimCount: 2,
        durationMs: 12,
        hash: "4".repeat(64),
        operationId: "draft-operation-v19",
        providerRequestId: "draft-response-v19",
        role: "primary",
        usage
      }],
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "5".repeat(64),
      selectors: [{
        claimCount: null,
        durationMs: 8,
        hash: "6".repeat(64),
        operationId: "selector-operation-v15",
        providerRequestId: "selector-response-v15",
        role: "initial",
        usage
      }],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Both phased results are supported. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });
    await expect(settleKnowledgeGrounding(transaction as never, {
      grounding: groundingV15
    })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect((existing as { evidence?: unknown } | null)?.evidence).toMatchObject({
      draftContractVersion: 19,
      selectorContractVersion: 15,
      selectorValidationRepairApplied: false,
      version: 15
    });

    existing = null;
    create.mockClear();
    const groundingV16 = groundSettledKnowledgeAnswerV16({
      contracts: { draftContractVersion: 20, selectorContractVersion: 16 },
      coveragePlanner: {
        claimCount: null,
        durationMs: 4,
        hash: "7".repeat(64),
        operationId: "coverage-planner-operation-v20",
        providerRequestId: "coverage-planner-response-v20",
        role: "planner",
        usage
      },
      draftClaimCount: 2,
      drafts: [{
        claimCount: 2,
        durationMs: 12,
        hash: "8".repeat(64),
        operationId: "draft-operation-v20",
        providerRequestId: "draft-response-v20",
        role: "primary",
        usage
      }],
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "9".repeat(64),
      selectors: [{
        claimCount: null,
        durationMs: 8,
        hash: "a".repeat(64),
        operationId: "selector-operation-v16",
        providerRequestId: "selector-response-v16",
        role: "initial",
        usage
      }],
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Both planned results are supported. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 2,
        unsupportedClaimCount: 0
      }
    });
    await expect(settleKnowledgeGrounding(transaction as never, {
      grounding: groundingV16
    })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect((existing as { evidence?: unknown } | null)?.evidence).toMatchObject({
      coveragePlanner: { claimCount: null, role: "planner" },
      draftContractVersion: 20,
      selectorContractVersion: 16,
      selectorValidationRepairApplied: false,
      version: 16
    });

    existing = null;
    create.mockClear();
    const auditPayloadHash = "b".repeat(64);
    const groundingV17 = groundSettledKnowledgeAnswerV17({
      audit: {
        coveredDimensionCount: 1,
        dimensionCount: 1,
        missingDimensionCount: 0,
        payloadHash: auditPayloadHash
      },
      contracts: {
        coverageAuditorContractVersion: 2,
        draftContractVersion: 21,
        selectorContractVersion: 17,
        settlementVersion: 6
      },
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "c".repeat(64),
      modelPinFingerprint: "d".repeat(64),
      operations: [{
        acceptedRequestHash: "e".repeat(64),
        acceptedResultHash: "f".repeat(64),
        contractVersion: 21,
        durationMs: 12,
        operationId: "draft-operation-v21",
        ordinal: 1,
        providerRequestId: "draft-response-v21",
        purpose: "knowledge_answer_draft_v21",
        role: "primary",
        usage
      }, {
        acceptedRequestHash: "1".repeat(64),
        acceptedResultHash: "2".repeat(64),
        contractVersion: 17,
        durationMs: 8,
        operationId: "selector-operation-v17",
        ordinal: 2,
        providerRequestId: "selector-response-v17",
        purpose: "knowledge_grounded_selector_v17",
        role: "initial",
        usage
      }, {
        acceptedRequestHash: "3".repeat(64),
        acceptedResultHash: auditPayloadHash,
        contractVersion: 2,
        durationMs: 6,
        operationId: "auditor-operation-v2",
        ordinal: 3,
        providerRequestId: "auditor-response-v2",
        purpose: "knowledge_coverage_auditor_v2",
        role: "auditor",
        usage
      }],
      providerPinFingerprint: "4".repeat(64),
      selectorRepairSucceeded: false,
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Private V21 final answer must not be persisted. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });
    await expect(settleKnowledgeGrounding(transaction as never, {
      grounding: groundingV17
    })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    const storedV17 = (existing as { evidence?: unknown } | null)?.evidence;
    expect(storedV17).toMatchObject({
      audit: { payloadHash: auditPayloadHash, status: "accepted" },
      contracts: {
        coverageAuditorContractVersion: 2,
        draftContractVersion: 21,
        selectorContractVersion: 17,
        settlementVersion: 6
      },
      operations: [{ role: "primary" }, { role: "initial" }, { role: "auditor" }],
      version: 17
    });
    expect(JSON.stringify(storedV17)).not.toContain("finalText");
    expect(JSON.stringify(storedV17)).not.toContain("Private V21 final answer");
    expect(JSON.stringify(storedV17)).not.toContain("Completed Atlas exports");

    existing = null;
    create.mockClear();
    const scopePayloadHash = "5".repeat(64);
    const selectorPayloadHash = "6".repeat(64);
    const currentPolicy = {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "low",
      supplementReasoningEffort: "low",
      version: 1
    } as const;
    const groundingV19 = groundSettledKnowledgeAnswerV19({
      answerBindingFingerprint: "7".repeat(64),
      contracts: {
        coverageAuditorContractVersion: 3,
        draftContractVersion: 21,
        selectorContractVersion: 18,
        settlementVersion: 6
      },
      coverage: {
        coveredDimensionCount: 1,
        missingDimensionCount: 0,
        selectorPayloadHash
      },
      coverageScope: { dimensionCount: 1, payloadHash: scopePayloadHash },
      draftClaimCount: 1,
      evidence: acceptedEvidence!,
      evidenceReceiptHash: "8".repeat(64),
      executionPolicy: currentPolicy,
      executionPolicyFingerprint: knowledgeAnswerHash(currentPolicy),
      modelPinFingerprint: "9".repeat(64),
      operations: [{
        acceptedRequestHash: "a".repeat(64),
        acceptedResultHash: "b".repeat(64),
        contractVersion: 21,
        durationMs: 12,
        operationId: "draft-operation-v21-scope-v3",
        ordinal: 1,
        providerRequestId: "draft-response-v21-scope-v3",
        purpose: "knowledge_answer_draft_v21",
        role: "primary",
        usage
      }, {
        acceptedRequestHash: "c".repeat(64),
        acceptedResultHash: scopePayloadHash,
        contractVersion: 3,
        durationMs: 6,
        operationId: "scope-operation-v3",
        ordinal: 2,
        providerRequestId: "scope-response-v3",
        purpose: "knowledge_coverage_scope_v3",
        role: "scope",
        usage
      }, {
        acceptedRequestHash: "d".repeat(64),
        acceptedResultHash: selectorPayloadHash,
        contractVersion: 18,
        durationMs: 8,
        operationId: "selector-operation-v18",
        ordinal: 3,
        providerRequestId: "selector-response-v18",
        purpose: "knowledge_grounded_selector_v18",
        role: "initial",
        usage
      }],
      providerPinFingerprint: "e".repeat(64),
      scopeRepairSucceeded: false,
      selectorRepairSucceeded: false,
      settlement: {
        contradictedClaimCount: 0,
        fallbackReason: null,
        finalText: "Private V19 final answer must not be persisted. [K1]",
        finalizationMode: "selected_claims",
        groundingStatus: "verified",
        outcome: "answered",
        requestCoverage: "complete",
        supportedClaimCount: 1,
        unsupportedClaimCount: 0
      }
    });
    await expect(settleKnowledgeGrounding(transaction as never, {
      grounding: groundingV19
    })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    const storedV19 = (existing as { evidence?: unknown } | null)?.evidence;
    expect(storedV19).toMatchObject({
      contracts: {
        coverageAuditorContractVersion: 3,
        draftContractVersion: 21,
        selectorContractVersion: 18,
        settlementVersion: 6
      },
      coverage: { selectorPayloadHash, status: "accepted" },
      coverageScope: { payloadHash: scopePayloadHash, status: "accepted" },
      operations: [{ role: "primary" }, { role: "scope" }, { role: "initial" }],
      version: 19
    });
    expect(JSON.stringify(storedV19)).not.toContain("finalText");
    expect(JSON.stringify(storedV19)).not.toContain("Private V19 final answer");
  });

});
