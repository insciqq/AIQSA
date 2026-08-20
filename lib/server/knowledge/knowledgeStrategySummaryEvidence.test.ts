import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  KnowledgeEvidencePackage,
  KnowledgeEvidencePackageItem
} from "./evidencePackage";
import {
  decodeKnowledgeEvidenceDispatchManifestDraft,
  packKnowledgeEvidenceDispatchManifest
} from "./evidenceDispatchManifest";
import {
  KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
  KNOWLEDGE_STRATEGY_MAX_ITEMS,
  KNOWLEDGE_STRATEGY_MAX_SOURCES,
  createKnowledgeStrategyStepRequestV1,
  hashKnowledgeAcceptedSourceSetV1,
  sealKnowledgeStrategyExecutionRequestV1,
  type KnowledgeAcceptedSourceTupleV1
} from "./knowledgeStrategyExecution";
import {
  createKnowledgeStrategyMapOutputV2,
  createKnowledgeStrategyMapSectionSummaryV2,
  deriveKnowledgeStrategyMapInputV2
} from "./knowledgeStrategyMapOutput";
import { knowledgeStrategyPassageStepReceiptV1 } from "./knowledgeStrategyRuntime";
import {
  buildKnowledgeStrategySummaryEvidenceV2,
  buildKnowledgeStrategySummaryResultEvidenceV2,
  createKnowledgeStrategySummaryDispatchCandidatesV2,
  createKnowledgeStrategySummaryDispatchItemV2,
  decodeKnowledgeStrategySummaryDispatchItemV2,
  decodeKnowledgeStrategySummaryResultEvidenceV2,
  decodeKnowledgeStrategySummarySupportBindingV2,
  deriveKnowledgeStrategySummaryDispatchBindingsV2,
  knowledgeEvidencePackageForSummaryGroundingV2,
  renderKnowledgeStrategySummaryResultProviderTextV2,
  verifyKnowledgeStrategySummaryDispatchItemV2
} from "./knowledgeStrategySummaryEvidence";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import type {
  KnowledgeHybridPassage,
  KnowledgeRetrievalEvidence,
  KnowledgeSourceBoundRetrievedPassageEvidence,
  KnowledgeStrategyPassagePage
} from "./retrievalTypes";
import { KNOWLEDGE_RESULT_VERSION } from "./retrievalTypes";
import { knowledgeToolResultText } from "./toolResult";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(ordinal: number): KnowledgeAcceptedSourceTupleV1 {
  return Object.freeze({
    bindingId: `binding-${ordinal}`,
    hierarchicalArtifactId: `hierarchy-${ordinal}`,
    hierarchicalChecksum: digest(`hierarchy-${ordinal}`),
    ordinal,
    passageCount: 2,
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: `artifact-${ordinal}`,
    sourceId: `source-${ordinal}`,
    sourceVersionId: `version-${ordinal}`,
    sourceVersionNumber: ordinal + 1,
    version: 1
  });
}

function passage(sourceValue: KnowledgeAcceptedSourceTupleV1, ordinal: number):
KnowledgeHybridPassage {
  return Object.freeze({
    annRank: null,
    baseName: "Pinned source",
    bindingOrdinal: sourceValue.ordinal,
    chunkId: `passage-${sourceValue.ordinal}-${ordinal}`,
    chunkIndex: ordinal,
    contentHash: digest(`content-${sourceValue.ordinal}-${ordinal}`),
    documentId: sourceValue.sourceId,
    documentVersionId: sourceValue.sourceVersionId,
    documentVersionNumber: sourceValue.sourceVersionNumber,
    fileName: `document-${sourceValue.ordinal}.txt`,
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    headingPath: [`Section ${ordinal + 1}`],
    knowledgeBaseId: `profile-${sourceValue.ordinal}`,
    page: ordinal + 1,
    sectionId: `section-${sourceValue.ordinal}-${ordinal}`,
    sourceArtifactId: sourceValue.sourceArtifactId,
    sourceName: `Source ${sourceValue.ordinal + 1}`,
    text: `Exact supporting text ${sourceValue.ordinal}.${ordinal}`,
    vectorDistance: null,
    vectorScore: null
  });
}

function fixture(
  sources: readonly KnowledgeAcceptedSourceTupleV1[] = Object.freeze([source(0), source(1)])
) {
  const expectedPassageCount = sources.reduce((sum, value) => sum + value.passageCount, 0);
  const sourceSetHash = hashKnowledgeAcceptedSourceSetV1(sources);
  const execution = sealKnowledgeStrategyExecutionRequestV1({
    config: {
      expectedPassageCount,
      kind: "corpus_summary",
      mapInputHash: digest("map-input"),
      reduceInputHash: digest("reduce-input")
    },
    executionId: "execution-summary-evidence",
    modelRunId: "run-summary-evidence",
    plannerVersion: 2,
    sourceSet: sources,
    sourceSetHash,
    strategy: "corpus_summary",
    version: 1
  });
  let handleOrdinal = 1;
  const outputs = [];
  const results: KnowledgeSourceBoundRetrievedPassageEvidence[] = [];
  const packageItems: KnowledgeEvidencePackageItem[] = [];
  for (const sourceValue of sources) {
    const passages = Object.freeze([passage(sourceValue, 0), passage(sourceValue, 1)]);
    const page: KnowledgeStrategyPassagePage = Object.freeze({
      complete: true,
      items: Object.freeze(passages.map((value) => ({
        contentHash: value.contentHash!,
        passageId: value.chunkId,
        passageOrdinal: value.chunkIndex,
        sourceArtifactId: sourceValue.sourceArtifactId,
        sourceBindingId: sourceValue.bindingId,
        sourceOrdinal: sourceValue.ordinal,
        version: 1 as const
      }))),
      nextCursor: null,
      passages,
      source: sourceValue
    });
    const step = createKnowledgeStrategyStepRequestV1({
      comparisonDimensionHash: null,
      cursor: null,
      evidenceInputHash: null,
      executionId: execution.executionId,
      inputHash: execution.config.kind === "corpus_summary"
        ? execution.config.mapInputHash
        : digest("unreachable"),
      kind: "corpus_summary_map",
      ordinal: sourceValue.ordinal,
      pageOrdinal: 0,
      phaseOrdinal: 0,
      required: true,
      sourceBindingId: sourceValue.bindingId,
      sourceSetHash,
      stepId: `map-step-${sourceValue.ordinal}`,
      strategy: "corpus_summary",
      streamId: `stream-${sourceValue.ordinal}`,
      targetOrdinal: null,
      version: 1
    });
    const receipt = knowledgeStrategyPassageStepReceiptV1(step, page);
    const mapInput = deriveKnowledgeStrategyMapInputV2({
      execution,
      pages: [page],
      source: sourceValue,
      stepReceipts: [receipt],
      stepRequests: [step]
    });
    const summaries = mapInput.passageItems.map((support, ordinal) =>
      createKnowledgeStrategyMapSectionSummaryV2({
        ordinal,
        sectionHash: support.sectionHash,
        summaryText: `Bounded summary ${sourceValue.ordinal}.${ordinal}`,
        supportingPassages: [support]
      }));
    outputs.push(createKnowledgeStrategyMapOutputV2({ mapInput, summaries }));
    for (const value of passages) {
      const handle = `K${handleOrdinal}`;
      const result: KnowledgeSourceBoundRetrievedPassageEvidence = Object.freeze({
        ...value,
        handle,
        includedText: value.text,
        includedTextBytes: Buffer.byteLength(value.text, "utf8"),
        sourceAlias: sourceValue.sourceAlias,
        sourceArtifactId: sourceValue.sourceArtifactId,
        sourceName: value.sourceName!,
        sourceTextBytes: Buffer.byteLength(value.text, "utf8"),
        textTruncated: false
      });
      results.push(result);
      packageItems.push(Object.freeze({
        baseName: value.baseName,
        contentHash: value.contentHash!,
        contextBoundaries: {
          expanded: false,
          excerptBytes: Buffer.byteLength(value.text, "utf8"),
          sourceTextBytes: Buffer.byteLength(value.text, "utf8")
        },
        documentId: value.documentId,
        documentVersionId: value.documentVersionId,
        excerpt: value.text,
        fileName: value.fileName,
        handle,
        headingPath: value.headingPath!,
        id: `evidence-${handleOrdinal}`,
        knowledgeBaseId: value.knowledgeBaseId,
        locator: { page: value.page },
        ordinal: handleOrdinal,
        passageId: value.chunkId,
        provenance: [],
        sectionId: value.sectionId!,
        sourceArtifactId: sourceValue.sourceArtifactId,
        sourceId: sourceValue.sourceId,
        sourceName: value.sourceName!,
        sourceVersionId: sourceValue.sourceVersionId,
        sourceVersionNumber: sourceValue.sourceVersionNumber,
        state: "available",
        textTruncated: false
      }));
      handleOrdinal += 1;
    }
  }
  const evidence: KnowledgeEvidencePackage = Object.freeze({
    citationContract: {
      format: "K{ordinal}" as const,
      legacyRead: true as const,
      maximum: 999,
      version: 2 as const
    },
    coverage: {
      expectedPassageCount,
      mode: "verified_only" as const,
      namedTargets: [],
      verified: false
    },
    degradedFlags: [],
    items: Object.freeze(packageItems),
    originalIntent: {
      intent: "corpus_summary" as const,
      query: "Summarize every Source"
    },
    readiness: { excludedResources: 0, readyBases: 0, readySources: sources.length },
    runId: execution.modelRunId,
    scopeSnapshot: {},
    sessionId: "session-summary-evidence",
    strategy: "corpus_summary" as const,
    version: 2
  });
  return Object.freeze({ evidence, execution, outputs: Object.freeze(outputs), results });
}

describe("Knowledge corpus-summary provider and grounding evidence", () => {
  it("shares the S999 and ten-million-passage boundaries with the strategy codecs", () => {
    const value = fixture([source(KNOWLEDGE_STRATEGY_MAX_SOURCES - 1)]);
    const item = createKnowledgeStrategySummaryDispatchItemV2({
      evidence: value.evidence,
      output: value.outputs[0],
      sourceLabel: "Boundary Source"
    });
    const support = item.supportBindings[0]!;
    const maximumPassageSupport = {
      ...support,
      passageOrdinal: KNOWLEDGE_STRATEGY_MAX_ITEMS - 1
    };

    expect(item).toMatchObject({ sourceAlias: "S999", sourceOrdinal: 998 });
    expect(decodeKnowledgeStrategySummaryDispatchItemV2(item)).toEqual(item);
    expect(decodeKnowledgeStrategySummaryDispatchItemV2({
      ...item,
      sourceOrdinal: KNOWLEDGE_STRATEGY_MAX_SOURCES
    })).toBeNull();
    expect(decodeKnowledgeStrategySummarySupportBindingV2(maximumPassageSupport))
      .toEqual(maximumPassageSupport);
    expect(decodeKnowledgeStrategySummarySupportBindingV2({
      ...maximumPassageSupport,
      passageOrdinal: KNOWLEDGE_STRATEGY_MAX_ITEMS
    })).toBeNull();
  });

  it("builds one explicit provider-safe summary envelope per Source", () => {
    const value = fixture();
    const summaries = buildKnowledgeStrategySummaryEvidenceV2({
      outputs: value.outputs,
      results: value.results
    });

    expect(summaries).toHaveLength(2);
    expect(summaries.map(({ sourceAlias }) => sourceAlias)).toEqual(["S1", "S2"]);
    expect(summaries[0]!.summaries.map(({ supportingHandles }) => supportingHandles))
      .toEqual([["K1"], ["K2"]]);

    const resultEvidence = buildKnowledgeStrategySummaryResultEvidenceV2({
      outputs: value.outputs,
      results: value.results
    });
    expect(decodeKnowledgeStrategySummaryResultEvidenceV2(resultEvidence)).toEqual(resultEvidence);
    expect(renderKnowledgeStrategySummaryResultProviderTextV2({
      evidence: resultEvidence,
      results: value.results
    })).toContain('"type":"source_summary_evidence"');
    const candidates = createKnowledgeStrategySummaryDispatchCandidatesV2({
      callId: "automatic-knowledge-1",
      evidence: resultEvidence,
      operationOrdinal: 1,
      results: value.results
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.map(({ evidenceId }) => evidenceId)).toEqual([
      "automatic-knowledge-1:result:1",
      "automatic-knowledge-1:result:3"
    ]);
    expect(candidates[0]!.supportBindings.map(({ handle }) => handle)).toEqual(["K1", "K2"]);
    const draft = packKnowledgeEvidenceDispatchManifest({
      candidates: candidates.map((summary) => ({
        evidenceId: summary.evidenceId,
        handle: summary.supportBindings[0]!.handle,
        kind: "source_summary" as const,
        operationOrdinal: summary.operationOrdinal,
        resultOrdinal: summary.supportBindings[0]!.resultOrdinal,
        state: "available" as const,
        summary
      })),
      coverageStatement: "Coverage verified: no.",
      footer: "</private_knowledge_evidence>",
      header: "<private_knowledge_evidence version=\"2\">",
      maximumBytes: 48 * 1_024,
      maximumTokens: 12 * 1_024,
      plannerVersion: 2,
      profileId: "test:model",
      promptFragmentVersion: 2
    });
    expect(draft.items).toHaveLength(2);
    expect(draft.items.every((entry) => "kind" in entry &&
      entry.kind === "source_summary")).toBe(true);
    expect(draft.message).toContain('"type":"source_summary_evidence"');
    expect(draft.message).not.toContain(value.outputs[0]!.sourceBindingId);
    expect(decodeKnowledgeEvidenceDispatchManifestDraft(draft)).toEqual(draft);
    expect(deriveKnowledgeStrategySummaryDispatchBindingsV2({
      evidence: resultEvidence,
      manifest: draft
    })).toEqual(candidates.map((candidate) => ({
      evidenceHash: candidate.evidenceHash,
      evidenceId: candidate.evidenceId,
      itemHash: candidate.itemHash,
      outputHash: candidate.mapOutputHash,
      sourceBindingId: candidate.sourceBindingId,
      sourceOrdinal: candidate.sourceOrdinal,
      version: 2
    })));

    const item = createKnowledgeStrategySummaryDispatchItemV2({
      evidence: value.evidence,
      output: value.outputs[0],
      sourceLabel: "Source 1"
    });
    expect(item.providerBlock.type).toBe("source_summary_evidence");
    expect(item.providerBlock.summaries).toEqual([
      { ordinal: 0, summaryText: "Bounded summary 0.0", supportingCitations: ["[K1]"] },
      { ordinal: 1, summaryText: "Bounded summary 0.1", supportingCitations: ["[K2]"] }
    ]);
    expect(item.providerText).not.toContain(value.outputs[0]!.sourceBindingId);
    expect(item.providerText).not.toContain(value.outputs[0]!.sourceArtifactId);
    expect(item.providerText).not.toContain(value.outputs[0]!.outputHash);
    expect(decodeKnowledgeStrategySummaryDispatchItemV2(item)).toEqual(item);
    expect(verifyKnowledgeStrategySummaryDispatchItemV2({
      evidence: value.evidence,
      item,
      output: value.outputs[0]
    })).toBe(true);
  });

  it("grounds only against the exact raw supporting passages, never summary prose", () => {
    const value = fixture();
    const dispatchItems = value.outputs.map((output, ordinal) =>
      createKnowledgeStrategySummaryDispatchItemV2({
        evidence: value.evidence,
        output,
        sourceLabel: `Source ${ordinal + 1}`
      }));
    const projected = knowledgeEvidencePackageForSummaryGroundingV2({
      evidence: value.evidence,
      items: dispatchItems
    });

    expect(projected.items.map(({ handle }) => handle)).toEqual(["K1", "K2", "K3", "K4"]);
    expect(projected.items.map(({ excerpt }) => excerpt)).toEqual(
      value.results.map(({ includedText }) => includedText)
    );
    expect(projected.items.some(({ excerpt }) => excerpt?.includes("Bounded summary"))).toBe(false);
  });

  it("fails closed for mutated, deleted, missing, or surplus supporting evidence", () => {
    const value = fixture();
    const item = createKnowledgeStrategySummaryDispatchItemV2({
      evidence: value.evidence,
      output: value.outputs[0],
      sourceLabel: "Source 1"
    });
    const mutatedEvidence = {
      ...value.evidence,
      items: value.evidence.items.map((entry, ordinal) => ordinal === 0
        ? { ...entry, excerpt: "mutated exact evidence" }
        : entry)
    } as KnowledgeEvidencePackage;
    expect(verifyKnowledgeStrategySummaryDispatchItemV2({
      evidence: mutatedEvidence,
      item,
      output: value.outputs[0]
    })).toBe(false);
    expect(() => knowledgeEvidencePackageForSummaryGroundingV2({
      evidence: mutatedEvidence,
      items: [item]
    })).toThrow("knowledge_strategy_summary_grounding_support_mismatch");

    const deletedEvidence = {
      ...value.evidence,
      items: value.evidence.items.map((entry, ordinal) => ordinal === 0
        ? { ...entry, state: "deleted", excerpt: null }
        : entry)
    } as KnowledgeEvidencePackage;
    expect(() => createKnowledgeStrategySummaryDispatchItemV2({
      evidence: deletedEvidence,
      output: value.outputs[0],
      sourceLabel: "Source 1"
    })).toThrow("knowledge_strategy_summary_package_support_mismatch");

    expect(() => buildKnowledgeStrategySummaryEvidenceV2({
      outputs: value.outputs,
      results: [...value.results, {
        ...value.results[0]!,
        chunkId: "surplus-passage",
        contentHash: digest("surplus-passage"),
        handle: "K99"
      }]
    })).toThrow("knowledge_strategy_summary_unbound_result");
    expect(decodeKnowledgeStrategySummaryDispatchItemV2({ ...item, extra: true })).toBeNull();
  });

  it("rebuilds the strict summary envelope from durable map outputs on Prisma receipt replay",
    async () => {
      const value = fixture();
      const marker = {
        executionId: value.execution.executionId,
        kind: "corpus_summary_reduce" as const,
        ordinal: 2,
        requestHash: digest("reduce-request"),
        resultHash: digest("reduce-result"),
        stepId: "reduce-step",
        version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
      };
      const summaryEvidence = buildKnowledgeStrategySummaryResultEvidenceV2({
        outputs: value.outputs,
        results: value.results
      });
      const draft: Omit<KnowledgeRetrievalEvidence, "providerText"> = {
        bases: value.execution.sourceSet.map((sourceValue) => ({
          baseContentRevision: 1,
          baseName: "Pinned source",
          candidateCount: 2,
          indexedContentRevision: 1,
          indexGenerationId: `generation-${sourceValue.ordinal}`,
          knowledgeBaseId: `profile-${sourceValue.ordinal}`,
          ordinal: sourceValue.ordinal,
          state: "ready" as const,
          targetDimension: 1_024,
          vectorSpaceFingerprint: digest(`vector-${sourceValue.ordinal}`)
        })),
        budget: {
          noveltyRatio: 1,
          operation: "automatic_search",
          stopReason: null,
          usage: {
            cumulativeCandidates: 4,
            estimatedCostMicros: 0,
            followUpOperations: 0,
            latencyMs: 1,
            lowNoveltyStreak: 0,
            operations: 1,
            queryEmbeddingCalls: 0,
            rerankerCalls: 0,
            retrievedTokens: 16,
            searchPhases: 1,
            subqueriesInCurrentPhase: 1
          },
          version: 1
        },
        candidateCount: 4,
        candidateLimit: 100,
        durationMs: 1,
        embeddingExecutions: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        operation: "automatic_search",
        outcome: "complete",
        postRerankOrder: null,
        preRerankOrder: null,
        query: "Summarize every Source",
        rerankerBinding: null,
        resultLimit: 100,
        results: value.results,
        scopeAliases: [
          ...value.execution.sourceSet.map((sourceValue) => ({
            alias: `B${sourceValue.ordinal + 1}`,
            kind: "base" as const,
            label: `Base ${sourceValue.ordinal + 1}`
          })),
          ...value.execution.sourceSet.map((sourceValue) => ({
            alias: sourceValue.sourceAlias,
            kind: "source" as const,
            label: `Source ${sourceValue.ordinal + 1}`
          }))
        ],
        strategyStepEvidence: marker,
        strategySummaryEvidence: summaryEvidence,
        threshold: 0,
        version: KNOWLEDGE_RESULT_VERSION
      };
      const pending = { ...draft, providerText: "pending" };
      const evidence = { ...pending, providerText: knowledgeToolResultText(pending) };
      let storedRun: Record<string, unknown> | null = null;
      let nextEvidenceOrdinal = 41;
      let durableOutputs = value.outputs;
      const tx = {
        $queryRaw: vi.fn(async () => [{ id: value.execution.modelRunId }]),
        knowledgeEvidenceItem: {
          create: vi.fn(async ({ data }: Readonly<{ data: Record<string, unknown> }>) => ({
            ...data,
            evidenceKey: data.evidenceKey,
            handle: data.handle,
            id: data.id
          })),
          findMany: vi.fn(async () => [])
        },
        knowledgeRetrievalSession: {
          findUnique: vi.fn(async () => ({
            acceptedAt: null,
            degradedFlags: [],
            id: "session-summary-evidence",
            nextEvidenceOrdinal,
            receiptHash: null,
            strategySnapshot: { strategy: "corpus_summary" }
          })),
          update: vi.fn(async ({ data }: Readonly<{
            data: Readonly<{ nextEvidenceOrdinal: number }>;
          }>) => {
            nextEvidenceOrdinal = data.nextEvidenceOrdinal;
            return { id: "session-summary-evidence" };
          })
        },
        knowledgeRun: {
          create: vi.fn(async ({ data }: Readonly<{ data: Record<string, unknown> }>) => {
            storedRun = data;
            return { id: data.id };
          }),
          findUnique: vi.fn(async () => null)
        },
        knowledgeRunEvidence: { createMany: vi.fn(async () => ({ count: 4 })) },
        knowledgeSourceIndexArtifact: {
          findMany: vi.fn(async () => value.execution.sourceSet.map((sourceValue) => ({
            id: sourceValue.sourceArtifactId,
            sourceVersion: {
              id: sourceValue.sourceVersionId,
              sourceId: sourceValue.sourceId,
              versionNumber: sourceValue.sourceVersionNumber
            }
          })))
        },
        modelRun: {
          findUnique: vi.fn(async () => ({
            knowledgeRunScope: {
              budgetPolicy: {},
              exclusions: [],
              resolvedBaseCount: 2,
              resolvedSourceCount: 2,
              selection: {}
            },
            normalizedRequest: null
          }))
        },
        modelRunToolCall: { findFirst: vi.fn(async () => ({ id: "tool-call-reduce" })) }
      };
      const store = createPrismaKnowledgeRetrievalStore({
        ...tx,
        $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx)),
        knowledgeRun: {
          ...tx.knowledgeRun,
          findFirst: vi.fn(async () => {
            if (!storedRun) return null;
            return {
              baseEvidence: storedRun.baseEvidence,
              budgetEvidence: storedRun.budgetEvidence,
              candidateCount: storedRun.candidateCount,
              candidateLimit: storedRun.candidateLimit,
              durationMs: storedRun.durationMs,
              embeddingUsage: storedRun.embeddingUsage,
              failureCode: storedRun.failureCode ?? null,
              fusion: storedRun.fusion,
              invocationOrdinal: storedRun.invocationOrdinal,
              operation: storedRun.operation,
              outcome: storedRun.outcome,
              postRerankOrder: null,
              preRerankOrder: null,
              providerText: storedRun.providerText,
              query: storedRun.query,
              readReceipt: null,
              rerankerBinding: null,
              resultLimit: storedRun.resultLimit,
              results: storedRun.results,
              strategyStepEvidence: storedRun.strategyStepEvidence,
              threshold: storedRun.threshold
            };
          })
        },
        knowledgeStrategyExecution: {
          findFirst: vi.fn(async () => ({
            expectedSourceCount: 2,
            purgedAt: null,
            strategy: "corpus_summary"
          }))
        },
        knowledgeStrategyMapOutput: {
          findMany: vi.fn(async () => durableOutputs.map((output, sourceOrdinal) => ({
            output,
            sourceOrdinal
          })))
        }
      } as never);

      const persisted = await store.persistReceipt({
        evidence,
        modelRunToolCallId: "tool-call-reduce",
        runId: value.execution.modelRunId,
        userId: "user-summary"
      });
      if (!persisted) throw new Error("expected persisted Knowledge receipt");
      expect(persisted.results.map(({ handle }) => handle)).toEqual(["K41", "K42", "K43", "K44"]);
      expect(persisted.strategySummaryEvidence?.summaries[0]?.summaries[0]
        ?.supportingHandles).toEqual(["K41"]);

      const replayed = await store.loadReceipt!({
        modelRunToolCallId: "tool-call-reduce",
        runId: value.execution.modelRunId,
        userId: "user-summary"
      });
      expect(replayed?.strategySummaryEvidence).toEqual(persisted.strategySummaryEvidence);
      expect(replayed?.providerText).toBe(persisted.providerText);
      expect(replayed?.results.map(({ handle }) => handle)).toEqual([
        "K41", "K42", "K43", "K44"
      ]);
      durableOutputs = value.outputs.slice(0, 1);
      await expect(store.loadReceipt!({
        modelRunToolCallId: "tool-call-reduce",
        runId: value.execution.modelRunId,
        userId: "user-summary"
      })).resolves.toBeNull();
    });
});
