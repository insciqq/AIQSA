import { describe, expect, it, vi } from "vitest";
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
      findFirst: vi.fn(async () => input.normalizedRequest === undefined
        ? null
        : { normalizedRequest: input.normalizedRequest })
    }
  } as never;
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
