import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgePlannerPlanV2 } from "./planner";
import type { KnowledgeRetrievalEvidence, KnowledgeStrategyPassagePage } from "./retrievalTypes";
import {
  createKnowledgeStrategyNextCursorV1,
  createKnowledgeStrategyStepReceiptV1,
  createKnowledgeStrategyStepRequestV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyPassageItemV1,
  hashKnowledgeStrategyPassageItemsV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  materializeKnowledgeStrategyStepRequestV1,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeStrategyPassageItemV1,
  type KnowledgeStrategyStepRequestV1
} from "./knowledgeStrategyExecution";
import {
  createKnowledgeStrategyMapOutputDependencyInputV2,
  decodeKnowledgeStrategyMapOutputReceiptV2,
  decodeKnowledgeStrategyMapOutputV2,
  hashKnowledgeStrategyMapOutputDependencyInputV2,
  type KnowledgeStrategyMapOutputReceiptV2,
  type KnowledgeStrategyMapOutputV2
} from "./knowledgeStrategyMapOutput";
import { prepareKnowledgeStrategyExecutionV1 } from "./knowledgeStrategyPlan";
import type {
  PrismaKnowledgeStrategyRepository,
  StoredKnowledgeStrategyExecution,
  StoredKnowledgeStrategyStep
} from "./knowledgeStrategyRepository";
import {
  createDeterministicKnowledgeStrategyMapArtifactsV2,
  drainKnowledgeStrategyInternalSteps,
  knowledgeStrategyEvidenceStepReceiptV1,
  knowledgeStrategyPassageStepReceiptV1
} from "./knowledgeStrategyRuntime";
import type { KnowledgeRetrievalStore } from "./toolExecutor";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8"
  ).digest("hex");
}

function source(passageCount = 65): KnowledgeAcceptedSourceTupleV1 {
  return {
    bindingId: "binding-0",
    hierarchicalArtifactId: "hierarchy-0",
    hierarchicalChecksum: digest("hierarchy-0"),
    ordinal: 0,
    passageCount,
    sourceAlias: "S1",
    sourceArtifactId: "artifact-0",
    sourceId: "source-0",
    sourceVersionId: "version-0",
    sourceVersionNumber: 1,
    version: 1
  };
}

function passageItem(
  passageOrdinal: number,
  sourceValue: KnowledgeAcceptedSourceTupleV1 = source()
): KnowledgeStrategyPassageItemV1 {
  return {
    contentHash: digest(`content-${passageOrdinal}`),
    passageId: `passage-${passageOrdinal}`,
    passageOrdinal,
    sourceArtifactId: sourceValue.sourceArtifactId,
    sourceBindingId: sourceValue.bindingId,
    sourceOrdinal: sourceValue.ordinal,
    version: 1
  };
}

function passageFor(
  item: KnowledgeStrategyPassageItemV1,
  sourceValue: KnowledgeAcceptedSourceTupleV1 = source()
): KnowledgeStrategyPassagePage["passages"][number] {
  return {
    annRank: null,
    baseName: "Pinned source",
    bindingOrdinal: sourceValue.ordinal,
    chunkId: item.passageId,
    chunkIndex: item.passageOrdinal,
    contentHash: item.contentHash,
    documentId: sourceValue.sourceId,
    documentVersionId: sourceValue.sourceVersionId,
    documentVersionNumber: sourceValue.sourceVersionNumber,
    fileName: `source-${sourceValue.ordinal}.txt`,
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    headingPath: ["Shared section"],
    knowledgeBaseId: `profile-${sourceValue.ordinal}`,
    page: item.passageOrdinal + 1,
    sectionId: `section-${sourceValue.ordinal}`,
    sourceArtifactId: item.sourceArtifactId,
    sourceName: `Source ${sourceValue.ordinal + 1}`,
    text: `Exact passage ${item.passageOrdinal}`,
    vectorDistance: null,
    vectorScore: null
  };
}

function sectionedPassageFor(
  item: KnowledgeStrategyPassageItemV1,
  sourceValue: KnowledgeAcceptedSourceTupleV1 = source()
): KnowledgeStrategyPassagePage["passages"][number] {
  return {
    ...passageFor(item, sourceValue),
    headingPath: [`Section ${item.passageOrdinal}`],
    sectionId: `section-${item.passageOrdinal}`
  };
}

function pageRequest(): KnowledgeStrategyStepRequestV1 {
  const sourceValue = source();
  return createKnowledgeStrategyStepRequestV1({
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: null,
    executionId: "execution-page",
    inputHash: digest("full-context-input"),
    kind: "full_context_page",
    ordinal: 0,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: sourceValue.bindingId,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1([sourceValue]),
    stepId: "step-page-0",
    strategy: "full_context",
    streamId: "stream-page",
    targetOrdinal: null,
    version: 1
  });
}

function evidenceRequest(): KnowledgeStrategyStepRequestV1 {
  return createKnowledgeStrategyStepRequestV1({
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: null,
    executionId: "execution-evidence",
    inputHash: digest("multi-hop-root-input"),
    kind: "multi_hop_root",
    ordinal: 0,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: null,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1([source(1)]),
    stepId: "step-evidence-0",
    strategy: "multi_hop",
    streamId: "stream-evidence",
    targetOrdinal: null,
    version: 1
  });
}

function evidenceResult(overrides: Readonly<Record<string, unknown>> = {}): KnowledgeRetrievalEvidence {
  return {
    providerText: "private provider text",
    query: "private query",
    results: [{
      contentHash: digest("evidence-content"),
      documentId: "document-1",
      documentVersionId: "document-version-1",
      handle: "K1",
      sourceArtifactId: "artifact-0",
      ...overrides
    }]
  } as unknown as KnowledgeRetrievalEvidence;
}

function summaryPlan(): KnowledgePlannerPlanV2 {
  return {
    automaticRetrieval: true,
    coverage: { expectedPassageCount: null, mode: "partial", namedTargets: [] },
    evidenceMode: "compact",
    intent: "corpus_summary",
    originalQuery: "Summarize the corpus",
    rewrite: { exactTerms: [], query: "Summarize the corpus" },
    status: "ready",
    strategy: "corpus_summary",
    subqueries: [{
      exact: null,
      exactTerms: [],
      lanes: ["lexical"],
      operation: "automatic_search",
      ordinal: 0,
      purpose: "answer",
      query: "Summarize the corpus",
      targetNames: [],
      targetResolution: null,
      targetSourceIds: []
    }],
    targetResolution: null,
    targetSourceIds: [],
    version: 2
  };
}

function exhaustivePlan(): KnowledgePlannerPlanV2 {
  return {
    automaticRetrieval: true,
    coverage: { expectedPassageCount: 201, mode: "verified_only", namedTargets: [] },
    evidenceMode: "fuller",
    intent: "exhaustive_corpus_search",
    originalQuery: "Find every matching passage",
    rewrite: { exactTerms: [], query: "Find every matching passage" },
    status: "ready",
    strategy: "exhaustive",
    subqueries: [{
      exact: null,
      exactTerms: [],
      lanes: ["lexical"],
      operation: "automatic_search",
      ordinal: 0,
      purpose: "coverage",
      query: "Find every matching passage",
      targetNames: [],
      targetResolution: null,
      targetSourceIds: []
    }],
    targetResolution: null,
    targetSourceIds: [],
    version: 2
  };
}

function pendingStep(
  executionId: string,
  planned: NonNullable<ReturnType<typeof prepareKnowledgeStrategyExecutionV1>>["steps"][number],
  dependencies: NonNullable<ReturnType<typeof prepareKnowledgeStrategyExecutionV1>>["dependencies"],
  at: Date
): StoredKnowledgeStrategyStep {
  const request = materializeKnowledgeStrategyStepRequestV1(
    planned.template,
    dependencies,
    []
  );
  return {
    createdAt: at,
    cursor: null,
    includedPassageCount: 0,
    lifecycle: {
      attemptCount: 0,
      executionId,
      failureCode: null,
      irreversibleDispatch: false,
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: null,
      state: "pending",
      stateVersion: 0,
      stepId: planned.template.stepId,
      version: 1
    },
    materializedAt: request ? at : null,
    modelRunToolCallId: planned.modelRunToolCallId,
    processedPassageCount: 0,
    processedSourceCount: 0,
    providerAttemptId: null,
    purgedAt: null,
    receipt: null,
    request,
    settledAt: null,
    template: planned.template,
    updatedAt: at
  };
}

describe("knowledge strategy runtime receipts", () => {
  it("builds a bounded extractive map summary from every exact page, including late evidence", () => {
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: "tool-call-reduce", ordinal: 0 }],
      executionId: "execution-summary-map",
      modelRunId: "run-summary-map",
      plan: summaryPlan(),
      sources: [source()]
    });
    if (!prepared) throw new Error("strategy_fixture_invalid");
    const mapPlans = prepared.steps.filter(({ template }) =>
      template.kind === "corpus_summary_map");
    const firstRequest = materializeKnowledgeStrategyStepRequestV1(
      mapPlans[0]!.template,
      prepared.dependencies,
      []
    );
    if (!firstRequest) throw new Error("strategy_fixture_invalid");
    const firstItems = Array.from({ length: 64 }, (_, ordinal) => passageItem(ordinal));
    const firstPage = {
      complete: false,
      items: firstItems,
      nextCursor: createKnowledgeStrategyNextCursorV1(firstRequest, firstItems.at(-1)!),
      passages: firstItems.map((item) => passageFor(item)),
      source: source()
    } satisfies KnowledgeStrategyPassagePage;
    const firstReceipt = knowledgeStrategyPassageStepReceiptV1(firstRequest, firstPage);
    const secondRequest = materializeKnowledgeStrategyStepRequestV1(
      mapPlans[1]!.template,
      prepared.dependencies,
      [{ receipt: firstReceipt, request: firstRequest }]
    );
    if (!secondRequest) throw new Error("strategy_fixture_invalid");
    const lastItem = passageItem(64);
    const lastPage = {
      complete: true,
      items: [lastItem],
      nextCursor: null,
      passages: [passageFor(lastItem)],
      source: source()
    } satisfies KnowledgeStrategyPassagePage;
    const lastReceipt = knowledgeStrategyPassageStepReceiptV1(secondRequest, lastPage);

    const artifacts = createDeterministicKnowledgeStrategyMapArtifactsV2({
      execution: prepared.execution,
      pages: [lastPage, firstPage],
      source: source(),
      stepReceipts: [lastReceipt, firstReceipt],
      stepRequests: [secondRequest, firstRequest]
    });

    expect(artifacts.output).toMatchObject({
      inputPageReceiptCount: 2,
      inputPassageCount: 65,
      processedPassageCount: 65,
      summaryItemCount: 1
    });
    expect(artifacts.receipt).toMatchObject({
      processedPassageCount: 65,
      sourceBindingId: "binding-0",
      summaryItemCount: 1
    });
    expect(artifacts.output.summaries[0]!.supportingPassages.map(({ passageOrdinal }) =>
      passageOrdinal)).toEqual([0, 9, 18, 27, 36, 45, 54, 64]);
    expect(artifacts.output.summaries[0]!.summaryText).toContain("Exact passage 64");
    expect(Buffer.byteLength(artifacts.output.summaries[0]!.summaryText, "utf8"))
      .toBeLessThanOrEqual(8 * 1024);
  });

  it("binds a passage receipt to the exact request, ordered items, and continuation cursor", () => {
    const request = pageRequest();
    const items = [passageItem(0), passageItem(1)];
    const nextCursor = createKnowledgeStrategyNextCursorV1(request, items[1]!);
    const receipt = knowledgeStrategyPassageStepReceiptV1(request, {
      complete: false,
      items,
      nextCursor,
      passages: items.map((item) => passageFor(item)),
      source: source()
    });

    expect(receipt).toEqual(createKnowledgeStrategyStepReceiptV1({
      cursorExhausted: false,
      executionId: request.executionId,
      lastItemHash: hashKnowledgeStrategyPassageItemV1(items[1]),
      nextCursor,
      processedItemCount: 2,
      processedItemsHash: hashKnowledgeStrategyPassageItemsV1(items),
      reasonCode: null,
      requestHash: hashKnowledgeStrategyStepRequestV1(request),
      status: "succeeded",
      stepId: request.stepId,
      version: 1
    }));
  });

  it("rejects a continuation cursor or item sequence that drifts from the requested page", () => {
    const request = pageRequest();
    const items = [passageItem(0), passageItem(1)];
    const nextCursor = createKnowledgeStrategyNextCursorV1(request, items[1]!);
    const page = {
      complete: false,
      items,
      nextCursor,
      passages: items.map((item) => passageFor(item)),
      source: source()
    } satisfies KnowledgeStrategyPassagePage;

    expect(() => knowledgeStrategyPassageStepReceiptV1(request, {
      ...page,
      nextCursor: { ...nextCursor, sourceBindingId: "binding-forged" }
    })).toThrow("knowledge_strategy_page_result_invalid");
    expect(() => knowledgeStrategyPassageStepReceiptV1(request, {
      ...page,
      nextCursor: { ...nextCursor, nextPassageOrdinal: 3 }
    })).toThrow("knowledge_strategy_page_result_invalid");
    const driftedItems = [passageItem(1), passageItem(2)];
    expect(() => knowledgeStrategyPassageStepReceiptV1(request, {
      ...page,
      items: driftedItems,
      nextCursor: createKnowledgeStrategyNextCursorV1(request, driftedItems[1]!),
      passages: driftedItems.map((item) => passageFor(item))
    })).toThrow("knowledge_strategy_page_result_invalid");
  });

  it("seals evidence identity while excluding query and provider text from the receipt", () => {
    const request = evidenceRequest();
    const evidence = evidenceResult();
    const receipt = knowledgeStrategyEvidenceStepReceiptV1(request, evidence);
    const identity = {
      contentHash: evidence.results[0]!.contentHash,
      documentId: evidence.results[0]!.documentId,
      documentVersionId: evidence.results[0]!.documentVersionId,
      evidenceHandle: evidence.results[0]!.handle,
      sourceArtifactId: evidence.results[0]!.sourceArtifactId
    };
    const itemHash = digest(identity);

    expect(receipt).toMatchObject({
      cursorExhausted: true,
      executionId: request.executionId,
      lastItemHash: itemHash,
      processedItemCount: 1,
      processedItemsHash: digest([itemHash]),
      requestHash: hashKnowledgeStrategyStepRequestV1(request),
      status: "succeeded",
      stepId: request.stepId
    });
    expect(knowledgeStrategyEvidenceStepReceiptV1(request, {
      ...evidence,
      providerText: "changed private text",
      query: "changed private query"
    })).toEqual(receipt);
    expect(knowledgeStrategyEvidenceStepReceiptV1(
      request,
      evidenceResult({ contentHash: digest("different-content") })
    ).processedItemsHash).not.toBe(receipt.processedItemsHash);
    expect(() => knowledgeStrategyEvidenceStepReceiptV1(pageRequest(), evidence))
      .toThrow("knowledge_strategy_page_receipt_required");
  });
});

describe("drainKnowledgeStrategyInternalSteps", () => {
  it("drains all three exhaustive pages with the 100-item runtime page size", async () => {
    const exhaustiveSource = source(201);
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: "tool-call-exhaustive", ordinal: 0 }],
      executionId: "execution-exhaustive-runtime",
      modelRunId: "run-exhaustive",
      pageSize: 100,
      plan: exhaustivePlan(),
      sources: [exhaustiveSource]
    });
    if (!prepared) throw new Error("strategy_fixture_invalid");
    const at = new Date("2026-08-20T00:00:00.000Z");
    let stored: StoredKnowledgeStrategyExecution = {
      coverage: null,
      createdAt: at,
      dependencies: prepared.dependencies,
      dispatchManifestHash: null,
      execution: prepared.execution,
      failureCode: null,
      includedPassageCount: 0,
      mapOutputs: [],
      modelRunId: "run-exhaustive",
      processedPassageCount: 0,
      processedSourceCount: 0,
      purgedAt: null,
      retrievalSessionId: "retrieval-session-exhaustive",
      state: "planned",
      steps: prepared.steps.map((planned) => ({
        ...pendingStep(
          prepared.execution.executionId,
          planned,
          prepared.dependencies,
          at
        ),
        // Production binds the terminal exhaustive page to the tool call.
        // Making every page internal isolates the drain branch and its page size.
        modelRunToolCallId: null
      })),
      updatedAt: at
    };
    const replaceStep = (
      stepId: string,
      update: (step: StoredKnowledgeStrategyStep) => StoredKnowledgeStrategyStep
    ) => {
      stored = {
        ...stored,
        state: "running",
        steps: stored.steps.map((step) =>
          step.lifecycle.stepId === stepId ? update(step) : step),
        updatedAt: new Date()
      };
    };
    const loadExecution = vi.fn(async () => stored);
    const materializeStepRequest = vi.fn(async (input: Readonly<{ stepId: string }>) => {
      const step = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId);
      if (!step?.template) throw new Error("step_fixture_missing");
      const prerequisites = stored.dependencies.filter(({ dependentStepId }) =>
        dependentStepId === input.stepId).map(({ prerequisiteStepId }) => {
        const prerequisite = stored.steps.find(({ lifecycle }) =>
          lifecycle.stepId === prerequisiteStepId);
        if (!prerequisite?.request || !prerequisite.receipt) {
          throw new Error("prerequisite_fixture_missing");
        }
        return { receipt: prerequisite.receipt, request: prerequisite.request };
      });
      const request = materializeKnowledgeStrategyStepRequestV1(
        step.template,
        stored.dependencies,
        prerequisites
      );
      if (!request) throw new Error("materialization_fixture_invalid");
      replaceStep(input.stepId, (current) => ({
        ...current,
        materializedAt: new Date(),
        request,
        updatedAt: new Date()
      }));
      const updated = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId)!;
      return { execution: stored, kind: "transitioned" as const, step: updated };
    });
    const claimNextStep = vi.fn(async (input: Readonly<{
      leaseExpiresAt: Date;
      leaseToken: string;
    }>) => {
      const successful = new Set(stored.steps.filter((step) =>
        step.lifecycle.state === "settled" && step.receipt?.status === "succeeded")
        .map(({ lifecycle }) => lifecycle.stepId));
      const next = stored.steps.find((step) => step.modelRunToolCallId === null &&
        step.lifecycle.state === "pending" && step.request !== null &&
        stored.dependencies.filter(({ dependentStepId }) =>
          dependentStepId === step.lifecycle.stepId).every(({ prerequisiteStepId }) =>
          successful.has(prerequisiteStepId)));
      if (!next) return { execution: stored, kind: "none" as const };
      replaceStep(next.lifecycle.stepId, (current) => ({
        ...current,
        lifecycle: {
          ...current.lifecycle,
          attemptCount: current.lifecycle.attemptCount + 1,
          leaseExpiresAt: input.leaseExpiresAt.toISOString(),
          leaseToken: input.leaseToken,
          state: "running",
          stateVersion: current.lifecycle.stateVersion + 1
        }
      }));
      const claimed = stored.steps.find(({ lifecycle }) =>
        lifecycle.stepId === next.lifecycle.stepId)!;
      return {
        execution: stored,
        kind: "claimed" as const,
        leaseToken: input.leaseToken,
        step: claimed
      };
    });
    const settleStep = vi.fn(async (input: Readonly<{
      includedPassageCount?: number;
      receipt: unknown;
      stepId: string;
    }>) => {
      const receipt = createKnowledgeStrategyStepReceiptV1(input.receipt);
      replaceStep(input.stepId, (current) => ({
        ...current,
        cursor: receipt.nextCursor,
        includedPassageCount: input.includedPassageCount ?? 0,
        lifecycle: {
          ...current.lifecycle,
          leaseExpiresAt: null,
          leaseToken: null,
          receiptHash: hashKnowledgeStrategyStepReceiptV1(receipt),
          state: "settled",
          stateVersion: current.lifecycle.stateVersion + 1
        },
        processedPassageCount: receipt.processedItemCount,
        processedSourceCount: receipt.processedItemCount > 0 ? 1 : 0,
        receipt,
        settledAt: new Date(),
        updatedAt: new Date()
      }));
      const updated = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId)!;
      return { execution: stored, kind: "transitioned" as const, step: updated };
    });
    const repository = {
      claimNextStep,
      loadExecution,
      materializeStepRequest,
      settleStep
    } as unknown as PrismaKnowledgeStrategyRepository;
    const loadStrategyPassagePage = vi.fn(async (input: Readonly<{
      cursor: KnowledgeStrategyStepRequestV1["cursor"];
      limit: number;
      streamId: string;
    }>): Promise<KnowledgeStrategyPassagePage> => {
      const start = input.cursor?.nextPassageOrdinal ?? 0;
      const request = stored.steps.find((step) => step.request?.streamId === input.streamId &&
        (step.request.cursor?.nextPassageOrdinal ?? 0) === start)?.request;
      if (!request) throw new Error("strategy_page_request_missing");
      const count = Math.min(input.limit, exhaustiveSource.passageCount - start);
      const items = Array.from({ length: count }, (_, index) =>
        passageItem(start + index, exhaustiveSource));
      const complete = start + items.length === exhaustiveSource.passageCount;
      return {
        complete,
        items,
        nextCursor: complete
          ? null
          : createKnowledgeStrategyNextCursorV1(request, items.at(-1)!),
        passages: items.map((item) => passageFor(item, exhaustiveSource)),
        source: exhaustiveSource
      };
    });
    const store = { loadStrategyPassagePage } as unknown as KnowledgeRetrievalStore;

    const result = await drainKnowledgeStrategyInternalSteps({
      executionId: prepared.execution.executionId,
      repository,
      runId: "run-exhaustive",
      store,
      userId: "owner-1"
    });
    const replayed = await drainKnowledgeStrategyInternalSteps({
      executionId: prepared.execution.executionId,
      repository,
      runId: "run-exhaustive",
      store,
      userId: "owner-1"
    });

    expect(result.steps).toHaveLength(3);
    expect(result.steps.map(({ lifecycle, receipt, request }) => ({
      cursorExhausted: receipt?.cursorExhausted,
      processedItemCount: receipt?.processedItemCount,
      start: request?.cursor?.nextPassageOrdinal ?? 0,
      state: lifecycle.state
    }))).toEqual([
      { cursorExhausted: false, processedItemCount: 100, start: 0, state: "settled" },
      { cursorExhausted: false, processedItemCount: 100, start: 100, state: "settled" },
      { cursorExhausted: true, processedItemCount: 1, start: 200, state: "settled" }
    ]);
    expect(result.steps.reduce((sum, step) =>
      sum + (step.receipt?.processedItemCount ?? 0), 0)).toBe(201);
    expect(loadStrategyPassagePage.mock.calls.map(([input]) => input.limit))
      .toEqual([100, 100, 100]);
    expect(replayed).toBe(result);
    expect(claimNextStep).toHaveBeenCalledTimes(3);
    expect(materializeStepRequest).toHaveBeenCalledTimes(2);
    expect(settleStep).toHaveBeenCalledTimes(3);
  });

  it("drains dependent internal pages and stops before the tool-call-bound reduce step", async () => {
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: "tool-call-reduce", ordinal: 0 }],
      executionId: "execution-summary-runtime",
      modelRunId: "run-1",
      plan: summaryPlan(),
      sources: [source()]
    });
    if (!prepared) throw new Error("strategy_fixture_invalid");
    const at = new Date("2026-08-20T00:00:00.000Z");
    let stored: StoredKnowledgeStrategyExecution = {
      coverage: null,
      createdAt: at,
      dependencies: prepared.dependencies,
      dispatchManifestHash: null,
      execution: prepared.execution,
      failureCode: null,
      includedPassageCount: 0,
      mapOutputs: [],
      modelRunId: "run-1",
      processedPassageCount: 0,
      processedSourceCount: 0,
      purgedAt: null,
      retrievalSessionId: "retrieval-session-1",
      state: "planned",
      steps: prepared.steps.map((step) =>
        pendingStep(prepared.execution.executionId, step, prepared.dependencies, at)),
      updatedAt: at
    };
    const replaceStep = (
      stepId: string,
      update: (step: StoredKnowledgeStrategyStep) => StoredKnowledgeStrategyStep
    ) => {
      stored = {
        ...stored,
        steps: stored.steps.map((step) =>
          step.lifecycle.stepId === stepId ? update(step) : step),
        updatedAt: new Date()
      };
    };
    const loadExecution = vi.fn(async () => stored);
    const materializeStepRequest = vi.fn(async (input: Readonly<{ stepId: string }>) => {
      const step = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId);
      if (!step?.template) throw new Error("step_fixture_missing");
      const prerequisites = stored.dependencies.filter(({ dependentStepId }) =>
        dependentStepId === input.stepId).map(({ prerequisiteStepId }) => {
        const prerequisite = stored.steps.find(({ lifecycle }) =>
          lifecycle.stepId === prerequisiteStepId);
        if (!prerequisite?.request || !prerequisite.receipt) {
          throw new Error("prerequisite_fixture_missing");
        }
        return { receipt: prerequisite.receipt, request: prerequisite.request };
      });
      const request = materializeKnowledgeStrategyStepRequestV1(
        step.template,
        stored.dependencies,
        prerequisites
      );
      if (!request) throw new Error("materialization_fixture_invalid");
      replaceStep(input.stepId, (current) => ({
        ...current,
        materializedAt: new Date(),
        request,
        updatedAt: new Date()
      }));
      const updated = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId)!;
      return { execution: stored, kind: "transitioned" as const, step: updated };
    });
    const claimNextStep = vi.fn(async (input: Readonly<{
      leaseExpiresAt: Date;
      leaseToken: string;
    }>) => {
      const successful = new Set(stored.steps.filter((step) =>
        step.lifecycle.state === "settled" && step.receipt?.status === "succeeded")
        .map(({ lifecycle }) => lifecycle.stepId));
      const next = stored.steps.find((step) => step.modelRunToolCallId === null &&
        step.lifecycle.state === "pending" && step.request !== null &&
        stored.dependencies.filter(({ dependentStepId }) =>
          dependentStepId === step.lifecycle.stepId).every(({ prerequisiteStepId }) =>
          successful.has(prerequisiteStepId)));
      if (!next) return { execution: stored, kind: "none" as const };
      replaceStep(next.lifecycle.stepId, (current) => ({
        ...current,
        lifecycle: {
          ...current.lifecycle,
          attemptCount: current.lifecycle.attemptCount + 1,
          leaseExpiresAt: input.leaseExpiresAt.toISOString(),
          leaseToken: input.leaseToken,
          state: "running",
          stateVersion: current.lifecycle.stateVersion + 1
        }
      }));
      stored = { ...stored, state: "running" };
      const claimed = stored.steps.find(({ lifecycle }) =>
        lifecycle.stepId === next.lifecycle.stepId)!;
      return {
        execution: stored,
        kind: "claimed" as const,
        leaseToken: input.leaseToken,
        step: claimed
      };
    });
    const settleStep = vi.fn(async (input: Readonly<{
      includedPassageCount?: number;
      receipt: unknown;
      stepId: string;
    }>) => {
      const receipt = createKnowledgeStrategyStepReceiptV1(input.receipt);
      replaceStep(input.stepId, (current) => ({
        ...current,
        cursor: receipt.nextCursor,
        includedPassageCount: input.includedPassageCount ?? 0,
        lifecycle: {
          ...current.lifecycle,
          leaseExpiresAt: null,
          leaseToken: null,
          receiptHash: hashKnowledgeStrategyStepReceiptV1(receipt),
          state: "settled",
          stateVersion: current.lifecycle.stateVersion + 1
        },
        processedPassageCount: receipt.processedItemCount,
        processedSourceCount: receipt.processedItemCount > 0 ? 1 : 0,
        receipt,
        settledAt: new Date(),
        updatedAt: new Date()
      }));
      const updated = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId)!;
      return { execution: stored, kind: "transitioned" as const, step: updated };
    });
    const mapOutputs: Array<Readonly<{
      output: KnowledgeStrategyMapOutputV2;
      receipt: KnowledgeStrategyMapOutputReceiptV2;
    }>> = [];
    const settleMapStep = vi.fn(async (input: Parameters<
      PrismaKnowledgeStrategyRepository["settleMapStep"]
    >[0]) => {
      const mutation = await settleStep(input);
      const output = decodeKnowledgeStrategyMapOutputV2(input.mapOutput);
      const receipt = decodeKnowledgeStrategyMapOutputReceiptV2(input.mapOutputReceipt);
      if (!output || !receipt) throw new Error("map_output_fixture_invalid");
      mapOutputs.push({ output, receipt });
      return mutation;
    });
    const loadMapOutputs = vi.fn(async () => Object.freeze([...mapOutputs]));
    const materializeReduceStepRequest = vi.fn(async (input: Readonly<{
      stepId: string;
    }>) => {
      const step = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId);
      if (!step?.template || !stored.execution) throw new Error("step_fixture_missing");
      const dependency = createKnowledgeStrategyMapOutputDependencyInputV2({
        dependentStepId: input.stepId,
        execution: stored.execution,
        receipts: mapOutputs.map(({ receipt }) => receipt)
      });
      const { materializationMode: _materializationMode, ...requestShape } = step.template;
      const request = createKnowledgeStrategyStepRequestV1({
        ...requestShape,
        evidenceInputHash: hashKnowledgeStrategyMapOutputDependencyInputV2(dependency)
      });
      replaceStep(input.stepId, (current) => ({
        ...current,
        materializedAt: new Date(),
        request,
        updatedAt: new Date()
      }));
      const updated = stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId)!;
      return { execution: stored, kind: "transitioned" as const, step: updated };
    });
    const repository = {
      claimNextStep,
      loadExecution,
      loadMapOutputs,
      materializeReduceStepRequest,
      materializeStepRequest,
      settleMapStep,
      settleStep
    } as unknown as PrismaKnowledgeStrategyRepository;
    const loadStrategyPassagePage = vi.fn(async (input: Readonly<{
      cursor: KnowledgeStrategyStepRequestV1["cursor"];
    }>): Promise<KnowledgeStrategyPassagePage> => {
      const mapSteps = stored.steps.filter(({ template }) =>
        template?.kind === "corpus_summary_map");
      if (input.cursor === null) {
        const request = mapSteps[0]!.request!;
        const items = Array.from({ length: 64 }, (_, ordinal) => passageItem(ordinal));
        return {
          complete: false,
          items,
          nextCursor: createKnowledgeStrategyNextCursorV1(request, items.at(-1)!),
          passages: items.map((item) => passageFor(item)),
          source: source()
        };
      }
      const item = passageItem(64);
      return {
        complete: true,
        items: [item],
        nextCursor: null,
        passages: [passageFor(item)],
        source: source()
      };
    });
    const store = { loadStrategyPassagePage } as unknown as KnowledgeRetrievalStore;

    const result = await drainKnowledgeStrategyInternalSteps({
      executionId: prepared.execution.executionId,
      repository,
      runId: "run-1",
      store,
      userId: "owner-1"
    });
    const recovered = await drainKnowledgeStrategyInternalSteps({
      executionId: prepared.execution.executionId,
      repository,
      runId: "run-1",
      store,
      userId: "owner-1"
    });

    const maps = result.steps.filter(({ template }) =>
      template?.kind === "corpus_summary_map");
    const reduce = result.steps.find(({ template }) =>
      template?.kind === "corpus_summary_reduce");
    expect(maps.map(({ lifecycle, request }) => ({
      cursorPage: request?.cursor?.pageOrdinal ?? null,
      state: lifecycle.state
    }))).toEqual([
      { cursorPage: null, state: "settled" },
      { cursorPage: 1, state: "settled" }
    ]);
    expect(reduce).toMatchObject({
      lifecycle: { state: "pending" },
      modelRunToolCallId: "tool-call-reduce",
      receipt: null
    });
    expect(recovered).toBe(result);
    expect(loadStrategyPassagePage).toHaveBeenCalledTimes(4);
    expect(loadStrategyPassagePage.mock.calls[0]?.[0]).toMatchObject({
      cursor: null,
      executionId: prepared.execution.executionId,
      limit: 64,
      runId: "run-1",
      streamId: maps[0]!.request!.streamId,
      userId: "owner-1"
    });
    expect(loadStrategyPassagePage.mock.calls[1]?.[0].cursor).toEqual(
      maps[0]!.receipt!.nextCursor
    );
    expect(claimNextStep).toHaveBeenCalledTimes(2);
    expect(settleStep.mock.calls.map(([input]) => ({
      includedPassageCount: input.includedPassageCount,
      stepId: input.stepId
    }))).toEqual(maps.map(({ lifecycle }) => ({
      includedPassageCount: 0,
      stepId: lifecycle.stepId
    })));
    expect(settleMapStep).toHaveBeenCalledOnce();
    expect(settleMapStep).toHaveBeenCalledWith(expect.objectContaining({
      mapOutput: expect.objectContaining({ processedPassageCount: 65 }),
      mapOutputReceipt: expect.objectContaining({ processedPassageCount: 65 }),
      stepId: maps[1]!.lifecycle.stepId
    }));
    expect(loadMapOutputs).toHaveBeenCalledOnce();
    expect(materializeStepRequest).toHaveBeenCalledOnce();
    expect(materializeReduceStepRequest).toHaveBeenCalledOnce();
    expect(reduce?.request?.evidenceInputHash).toBe(
      hashKnowledgeStrategyMapOutputDependencyInputV2(
        createKnowledgeStrategyMapOutputDependencyInputV2({
          dependentStepId: reduce!.lifecycle.stepId,
          execution: prepared.execution,
          receipts: mapOutputs.map(({ receipt }) => receipt)
        })
      )
    );
  });

  it("records an honest failed map step when a Source exceeds the section bound", async () => {
    const manySectionSource = source(65);
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: "tool-call-reduce-section-limit", ordinal: 0 }],
      executionId: "execution-summary-section-limit",
      modelRunId: "run-summary-section-limit",
      pageSize: 64,
      plan: summaryPlan(),
      sources: [manySectionSource]
    });
    if (!prepared) throw new Error("strategy_fixture_invalid");
    const mapPlans = prepared.steps.filter(({ template }) =>
      template.kind === "corpus_summary_map");
    const firstRequest = materializeKnowledgeStrategyStepRequestV1(
      mapPlans[0]!.template,
      prepared.dependencies,
      []
    );
    if (!firstRequest) throw new Error("strategy_fixture_invalid");
    const firstItems = Array.from({ length: 64 }, (_, ordinal) =>
      passageItem(ordinal, manySectionSource));
    const firstPage = {
      complete: false,
      items: firstItems,
      nextCursor: createKnowledgeStrategyNextCursorV1(firstRequest, firstItems.at(-1)!),
      passages: firstItems.map((item) => sectionedPassageFor(item, manySectionSource)),
      source: manySectionSource
    } satisfies KnowledgeStrategyPassagePage;
    const firstReceipt = knowledgeStrategyPassageStepReceiptV1(firstRequest, firstPage);
    const secondRequest = materializeKnowledgeStrategyStepRequestV1(
      mapPlans[1]!.template,
      prepared.dependencies,
      [{ receipt: firstReceipt, request: firstRequest }]
    );
    if (!secondRequest) throw new Error("strategy_fixture_invalid");
    const at = new Date("2026-08-20T00:00:00.000Z");
    const firstBase = pendingStep(
      prepared.execution.executionId,
      mapPlans[0]!,
      prepared.dependencies,
      at
    );
    const firstStored: StoredKnowledgeStrategyStep = {
      ...firstBase,
      cursor: firstReceipt.nextCursor,
      lifecycle: {
        ...firstBase.lifecycle,
        attemptCount: 1,
        receiptHash: hashKnowledgeStrategyStepReceiptV1(firstReceipt),
        state: "settled",
        stateVersion: 2
      },
      processedPassageCount: firstReceipt.processedItemCount,
      processedSourceCount: 0,
      receipt: firstReceipt,
      request: firstRequest,
      settledAt: at
    };
    const secondBase = pendingStep(
      prepared.execution.executionId,
      mapPlans[1]!,
      prepared.dependencies,
      at
    );
    const secondStored: StoredKnowledgeStrategyStep = {
      ...secondBase,
      materializedAt: at,
      request: secondRequest
    };
    const reducePlan = prepared.steps.find(({ template }) =>
      template.kind === "corpus_summary_reduce")!;
    let stored: StoredKnowledgeStrategyExecution = {
      coverage: null,
      createdAt: at,
      dependencies: prepared.dependencies,
      dispatchManifestHash: null,
      execution: prepared.execution,
      failureCode: null,
      includedPassageCount: 0,
      mapOutputs: [],
      modelRunId: prepared.execution.modelRunId,
      processedPassageCount: firstReceipt.processedItemCount,
      processedSourceCount: 0,
      purgedAt: null,
      retrievalSessionId: "retrieval-session-section-limit",
      state: "running",
      steps: [
        firstStored,
        secondStored,
        pendingStep(
          prepared.execution.executionId,
          reducePlan,
          prepared.dependencies,
          at
        )
      ],
      updatedAt: at
    };
    const replaceStep = (
      stepId: string,
      update: (step: StoredKnowledgeStrategyStep) => StoredKnowledgeStrategyStep
    ) => {
      stored = {
        ...stored,
        steps: stored.steps.map((step) =>
          step.lifecycle.stepId === stepId ? update(step) : step),
        updatedAt: new Date()
      };
    };
    const claimNextStep = vi.fn(async (input: Readonly<{
      leaseExpiresAt: Date;
      leaseToken: string;
    }>) => {
      replaceStep(secondRequest.stepId, (step) => ({
        ...step,
        lifecycle: {
          ...step.lifecycle,
          attemptCount: 1,
          leaseExpiresAt: input.leaseExpiresAt.toISOString(),
          leaseToken: input.leaseToken,
          state: "running",
          stateVersion: 1
        }
      }));
      return {
        execution: stored,
        kind: "claimed" as const,
        leaseToken: input.leaseToken,
        step: stored.steps.find(({ lifecycle }) =>
          lifecycle.stepId === secondRequest.stepId)!
      };
    });
    const failStep = vi.fn(async (input: Readonly<{
      receipt: unknown;
      stepId: string;
    }>) => {
      const receipt = createKnowledgeStrategyStepReceiptV1(input.receipt);
      replaceStep(input.stepId, (step) => ({
        ...step,
        lifecycle: {
          ...step.lifecycle,
          failureCode: receipt.reasonCode,
          leaseExpiresAt: null,
          leaseToken: null,
          state: "failed",
          stateVersion: step.lifecycle.stateVersion + 1
        },
        processedPassageCount: receipt.processedItemCount,
        receipt
      }));
      return {
        execution: stored,
        kind: "transitioned" as const,
        step: stored.steps.find(({ lifecycle }) => lifecycle.stepId === input.stepId)!
      };
    });
    const settleMapStep = vi.fn();
    const repository = {
      claimNextStep,
      failStep,
      loadExecution: vi.fn(async () => stored),
      settleMapStep
    } as unknown as PrismaKnowledgeStrategyRepository;
    const loadStrategyPassagePage = vi.fn(async (input: Readonly<{
      cursor: KnowledgeStrategyStepRequestV1["cursor"];
    }>): Promise<KnowledgeStrategyPassagePage> => {
      const start = input.cursor?.nextPassageOrdinal ?? 0;
      const request = start === 0 ? firstRequest : secondRequest;
      const count = Math.min(64, manySectionSource.passageCount - start);
      const items = Array.from({ length: count }, (_, index) =>
        passageItem(start + index, manySectionSource));
      const complete = start + count === manySectionSource.passageCount;
      return {
        complete,
        items,
        nextCursor: complete
          ? null
          : createKnowledgeStrategyNextCursorV1(request, items.at(-1)!),
        passages: items.map((item) => sectionedPassageFor(item, manySectionSource)),
        source: manySectionSource
      };
    });

    const result = await drainKnowledgeStrategyInternalSteps({
      executionId: prepared.execution.executionId,
      repository,
      runId: prepared.execution.modelRunId,
      store: { loadStrategyPassagePage } as unknown as KnowledgeRetrievalStore,
      userId: "owner-1"
    });

    expect(result.steps.find(({ lifecycle }) =>
      lifecycle.stepId === secondRequest.stepId)).toMatchObject({
      lifecycle: {
        failureCode: "knowledge_strategy_map_section_count_invalid",
        state: "failed"
      },
      receipt: {
        cursorExhausted: false,
        reasonCode: "knowledge_strategy_map_section_count_invalid",
        status: "failed"
      }
    });
    expect(failStep).toHaveBeenCalledOnce();
    expect(settleMapStep).not.toHaveBeenCalled();
    expect(result.steps.find(({ template }) =>
      template?.kind === "corpus_summary_reduce")?.lifecycle.state).toBe("pending");
  });
});
