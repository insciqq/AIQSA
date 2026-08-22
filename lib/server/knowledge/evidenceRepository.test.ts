import { describe, expect, it, vi } from "vitest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import {
  toolLoopCheckpoint,
  toolLoopPersistenceLimits
} from "../runs/toolLoopPersistence";
import {
  groundKnowledgeRunAnswer,
  knowledgeEvidencePackageForGroundingDispatch,
  loadKnowledgeEvidencePackage
} from "./evidenceRepository";
import { knowledgeEvidenceReceiptHash } from "./evidencePackage";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { groundKnowledgeAnswer } from "./grounding";
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
  normalizedRequest?: unknown;
  toolLoopRun?: unknown;
}> = {}) {
  return {
    knowledgeProviderAttempt: {
      findMany: vi.fn(async () => input.attempts ?? [])
    },
    knowledgeRetrievalSession: {
      findFirst: vi.fn(async () => value)
    },
    knowledgeRun: {
      findFirst: vi.fn(async () => input.currentOperation ?? null)
    },
    modelRun: {
      findFirst: vi.fn(async () => input.toolLoopRun ?? (
        input.normalizedRequest === undefined
          ? null
          : { normalizedRequest: input.normalizedRequest }
      ))
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

});
