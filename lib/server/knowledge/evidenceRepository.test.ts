import { describe, expect, it, vi } from "vitest";
import {
  groundKnowledgeRunAnswer,
  loadKnowledgeEvidencePackage
} from "./evidenceRepository";
import { knowledgeEvidenceReceiptHash } from "./evidencePackage";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";

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

function client(value: unknown) {
  return {
    knowledgeRetrievalSession: {
      findFirst: vi.fn(async () => value)
    }
  } as never;
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

describe("Knowledge Evidence v2 repository projection", () => {
  it("loads an exact bounded package and verifies only measured full coverage", async () => {
    const evidence = await loadKnowledgeEvidencePackage(client(row()), {
      runId: "run-1",
      userId: "user-1"
    });
    expect(evidence).toMatchObject({
      citationContract: { format: "K{ordinal}", version: 2 },
      coverage: { expectedPassageCount: 1, verified: true },
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
    const result = await groundKnowledgeRunAnswer(client(row()), {
      answer: "Atlas retains completed exports for 30 days [K1].",
      runId: "run-1",
      userId: "user-1"
    });
    expect(result).toMatchObject({ outcome: "passed", repairCount: 0 });
    expect(result?.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
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

    expect(result).toMatchObject({
      finalText: question,
      outcome: "repaired",
      repairCount: 1
    });
  });
});
