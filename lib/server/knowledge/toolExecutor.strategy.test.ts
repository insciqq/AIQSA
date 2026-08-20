import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  createKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyPassageItemV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  materializeKnowledgeStrategyStepRequestV1,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeMeasuredStrategy,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1,
  type KnowledgeStrategyStepTemplateV1
} from "./knowledgeStrategyExecution";
import { prepareKnowledgeStrategyExecutionV1 } from "./knowledgeStrategyPlan";
import {
  createKnowledgeStrategyMapOutputDependencyInputV2,
  hashKnowledgeStrategyMapOutputDependencyInputV2,
  type KnowledgeStrategyMapOutputReceiptV2
} from "./knowledgeStrategyMapOutput";
import {
  createDeterministicKnowledgeStrategyMapArtifactsV2,
  knowledgeStrategyPassageStepReceiptV1
} from "./knowledgeStrategyRuntime";
import type {
  PrismaKnowledgeStrategyRepository,
  StoredKnowledgeStrategyExecution,
  StoredKnowledgeStrategyMapOutput,
  StoredKnowledgeStrategyStep
} from "./knowledgeStrategyRepository";
import {
  createKnowledgeToolExecutor,
  type KnowledgeAcceptedEmbeddingRuntime,
  type KnowledgeRetrievalStore,
  type KnowledgeScopeAlias
} from "./toolExecutor";
import {
  decodeKnowledgeRetrievalEvidence,
  knowledgeEvidenceFromToolResult
} from "./toolResult";
import {
  type KnowledgeAcceptedBinding,
  type KnowledgeHybridPassage,
  type KnowledgeRetrievalEvidence,
  type KnowledgeStrategyPassagePage
} from "./retrievalTypes";
import type { KnowledgePlannerPlanV2, KnowledgePlannerStrategy } from "./planner";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";

const RUN_ID = "run-strategy-executor";
const TOOL_CALL_ID = "tool-call-strategy";
const USER_ID = "owner-strategy-executor";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32_768,
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
    nativeDimension: 1_024,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_024
  },
  modelClass: "embedding",
  upstreamModelId: "embedding-v1"
} as const;

const embeddingSnapshot = {
  connection: {
    allowPrivateNetwork: false,
    apiRoot: "https://embedding.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 300_000
  },
  connectionDisplayName: "Embedding endpoint",
  connectionId: "connection-strategy",
  credentialId: "credential-strategy",
  credentialVersionId: "credential-version-strategy",
  model: embeddingConfiguration,
  modelDisplayName: "Embedding model",
  providerFamily: "openai_compatible",
  providerModelId: "embedding-deployment-strategy",
  version: 1
} as const;

const vectorPin = createKnowledgeVectorSpacePin({
  configuration: embeddingConfiguration,
  deploymentId: embeddingSnapshot.providerModelId
})!;

function binding(): KnowledgeAcceptedBinding {
  return {
    baseContentRevision: 1,
    baseName: "Strategy base",
    embeddingConnectionId: embeddingSnapshot.connectionId,
    embeddingCredentialId: embeddingSnapshot.credentialId,
    embeddingCredentialSource: "default",
    embeddingCredentialVersionId: embeddingSnapshot.credentialVersionId,
    embeddingExecutionSnapshot: embeddingSnapshot,
    embeddingProviderModelId: embeddingSnapshot.providerModelId,
    executionScope: "profile",
    indexedContentRevision: 1,
    indexGenerationId: "generation-strategy",
    includeWholeBase: true,
    knowledgeBaseId: "base-strategy",
    knowledgeBaseSnapshotId: "snapshot-strategy",
    ordinal: 0,
    profileRevisionId: "profile-strategy",
    selectedSourceIds: [],
    targetDimension: 1024,
    vectorSpaceFingerprint: vectorPin.fingerprint
  };
}

function source(ordinal: number, passageCount: number): KnowledgeAcceptedSourceTupleV1 {
  return {
    bindingId: `source-binding-${ordinal}`,
    hierarchicalArtifactId: `hierarchy-${ordinal}`,
    hierarchicalChecksum: digest(`hierarchy-${ordinal}`),
    ordinal,
    passageCount,
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: `source-artifact-${ordinal}`,
    sourceId: `source-${ordinal}`,
    sourceVersionId: `source-version-${ordinal}`,
    sourceVersionNumber: 1,
    version: 1
  };
}

function aliases(sources: readonly KnowledgeAcceptedSourceTupleV1[]): KnowledgeScopeAlias[] {
  return sources.map((entry) => ({
    alias: entry.sourceAlias,
    bindingOrdinal: 0,
    bindingOrdinals: [0],
    kind: "source",
    label: `Source ${entry.ordinal + 1}`,
    sourceArtifactId: entry.sourceArtifactId,
    sourceId: entry.sourceId,
    sourceVersionId: entry.sourceVersionId
  }));
}

function plannerPlan(
  strategy: KnowledgePlannerStrategy,
  expectedPassageCount: number
): KnowledgePlannerPlanV2 {
  return {
    automaticRetrieval: true,
    coverage: {
      expectedPassageCount,
      mode: strategy === "corpus_summary" ? "partial" : "verified_only",
      namedTargets: []
    },
    evidenceMode: "compact",
    intent: strategy === "corpus_summary"
      ? "corpus_summary"
      : strategy === "exhaustive" ? "exhaustive_corpus_search" : "fact_lookup",
    originalQuery: "Inspect every selected passage",
    rewrite: { exactTerms: [], query: "Inspect every selected passage" },
    status: "ready",
    strategy,
    subqueries: [{
      exact: null,
      exactTerms: [],
      lanes: ["lexical"],
      operation: "automatic_search",
      ordinal: 0,
      purpose: strategy === "corpus_summary"
        ? "summary"
        : strategy === "exhaustive" ? "coverage" : "answer",
      query: "Inspect every selected passage",
      targetNames: [],
      targetResolution: null,
      targetSourceIds: []
    }],
    targetResolution: null,
    targetSourceIds: [],
    version: 2
  };
}

function automaticArguments(
  strategy: Exclude<KnowledgePlannerStrategy, "none">,
  expectedPassageCount: number
) {
  return {
    coverage: {
      expectedPassageCount,
      mode: strategy === "corpus_summary" ? "partial" as const : "verified_only" as const
    },
    exactTerms: [],
    lanes: ["lexical"],
    operation: "automatic_search",
    phaseOrdinal: 0,
    plannerVersion: 2,
    purpose: strategy === "corpus_summary"
      ? "summary" as const
      : strategy === "exhaustive" ? "coverage" as const : "answer" as const,
    query: "Inspect every selected passage",
    strategy,
    subqueryOrdinal: 0,
    targetNames: [],
    targetResolution: null,
    targetSourceIds: []
  };
}

function comparisonArguments(input: Readonly<{
  query: string;
  source: KnowledgeAcceptedSourceTupleV1;
  subqueryOrdinal: number;
}>) {
  const target = {
    candidateSourceIds: [input.source.sourceId],
    matchKind: "alias" as const,
    outcome: "resolved" as const,
    targetName: input.source.sourceAlias
  };
  return {
    ...automaticArguments("comparison", 2),
    coverage: { expectedPassageCount: 2, mode: "partial" as const },
    purpose: "compare_target" as const,
    query: input.query,
    subqueryOrdinal: input.subqueryOrdinal,
    targetNames: [input.source.sourceAlias],
    targetResolution: {
      outcome: "resolved" as const,
      targetSourceIds: [input.source.sourceId],
      targets: [target]
    },
    targetSourceIds: [input.source.sourceId]
  };
}

function comparisonFixture() {
  const sources = [0, 1].map((ordinal) => ({
    ...source(ordinal, 1),
    sourceId: `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`
  }));
  const targets = sources.map((entry) => ({
    candidateSourceIds: [entry.sourceId],
    matchKind: "alias" as const,
    outcome: "resolved" as const,
    targetName: entry.sourceAlias
  }));
  const queries = sources.map((entry) => `Compare facts for ${entry.sourceAlias}`);
  const plan: KnowledgePlannerPlanV2 = {
    ...plannerPlan("comparison", 2),
    coverage: { expectedPassageCount: 2, mode: "partial", namedTargets: [] },
    intent: "multi_source_comparison",
    subqueries: sources.map((entry, ordinal) => ({
      exact: null,
      exactTerms: [],
      lanes: ["lexical"],
      operation: "automatic_search",
      ordinal,
      purpose: "compare_target",
      query: queries[ordinal]!,
      targetNames: [entry.sourceAlias],
      targetResolution: {
        outcome: "resolved",
        targetSourceIds: [entry.sourceId],
        targets: [targets[ordinal]!]
      },
      targetSourceIds: [entry.sourceId]
    })),
    targetResolution: {
      outcome: "resolved_many",
      targetSourceIds: sources.map(({ sourceId }) => sourceId),
      targets
    },
    targetSourceIds: sources.map(({ sourceId }) => sourceId)
  };
  const prepared = prepareKnowledgeStrategyExecutionV1({
    calls: [{ id: TOOL_CALL_ID, ordinal: 0 }, {
      id: "tool-call-strategy-comparison-2",
      ordinal: 1
    }],
    executionId: "execution-comparison",
    modelRunId: RUN_ID,
    plan,
    sources
  });
  if (!prepared) throw new Error("strategy_test_plan_unavailable");
  const initial = storedExecution({
    dependencies: prepared.dependencies,
    execution: prepared.execution,
    steps: prepared.steps.map((planned, ordinal) => storedStep({
      executionId: prepared.execution.executionId,
      modelRunToolCallId: planned.modelRunToolCallId,
      request: directRequest(planned.template),
      ...(ordinal === 0 ? {} : { state: "pending" as const }),
      template: planned.template
    }))
  });
  return { initial, queries, sources };
}

function passage(
  acceptedSource: KnowledgeAcceptedSourceTupleV1,
  passageOrdinal: number
): KnowledgeHybridPassage {
  return {
    annRank: null,
    baseName: "Strategy base",
    bindingOrdinal: 0,
    chunkId: `passage-${acceptedSource.ordinal}-${passageOrdinal}`,
    chunkIndex: passageOrdinal,
    contentHash: digest(`content-${acceptedSource.ordinal}-${passageOrdinal}`),
    documentId: acceptedSource.sourceId,
    documentVersionId: acceptedSource.sourceVersionId,
    documentVersionNumber: acceptedSource.sourceVersionNumber,
    fileName: `source-${acceptedSource.ordinal + 1}.txt`,
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    knowledgeBaseId: "base-strategy",
    page: 1,
    rerankScore: null,
    sectionId: null,
    sourceArtifactId: acceptedSource.sourceArtifactId,
    sourceName: `Source ${acceptedSource.ordinal + 1}`,
    text: `whole-passage-${acceptedSource.ordinal + 1}-${passageOrdinal + 1}`,
    vectorDistance: null,
    vectorScore: null
  };
}

function passagePage(input: Readonly<{
  cursor: KnowledgeStrategyStepRequestV1["cursor"];
  executionId: string;
  limit: number;
  source: KnowledgeAcceptedSourceTupleV1;
  streamId: string;
}>): KnowledgeStrategyPassagePage {
  const startOrdinal = input.cursor?.nextPassageOrdinal ?? 0;
  const endOrdinal = Math.min(input.source.passageCount, startOrdinal + input.limit);
  const passages = Array.from(
    { length: endOrdinal - startOrdinal },
    (_, index) => passage(input.source, startOrdinal + index)
  );
  const items = passages.map((entry, index) => ({
    contentHash: entry.contentHash!,
    passageId: entry.chunkId,
    passageOrdinal: startOrdinal + index,
    sourceArtifactId: input.source.sourceArtifactId,
    sourceBindingId: input.source.bindingId,
    sourceOrdinal: input.source.ordinal,
    version: 1 as const
  }));
  const complete = endOrdinal === input.source.passageCount;
  const last = items.at(-1);
  return {
    complete,
    items,
    nextCursor: complete || !last
      ? null
      : {
          executionId: input.executionId,
          nextPassageOrdinal: endOrdinal,
          pageOrdinal: (input.cursor?.pageOrdinal ?? 0) + 1,
          previousItemHash: hashKnowledgeStrategyPassageItemV1(last),
          sourceBindingId: input.source.bindingId,
          sourceOrdinal: input.source.ordinal,
          streamId: input.streamId,
          version: 1
        },
    passages,
    source: input.source
  };
}

function substantiveStrategyPage(page: KnowledgeStrategyPassagePage): KnowledgeStrategyPassagePage {
  const passages = page.passages.map((entry) => {
    const text = `substantive-source-${page.source.ordinal + 1} ` +
      "bounded evidence for a realistic corpus summary. ".repeat(32);
    return { ...entry, contentHash: digest(text), text };
  });
  return {
    ...page,
    items: page.items.map((item, index) => ({
      ...item,
      contentHash: passages[index]!.contentHash!
    })),
    passages
  };
}

function sectionedSubstantiveStrategyPage(
  page: KnowledgeStrategyPassagePage
): KnowledgeStrategyPassagePage {
  const substantive = substantiveStrategyPage(page);
  return {
    ...substantive,
    passages: substantive.passages.map((entry) => ({
      ...entry,
      sectionId: `section-${entry.chunkIndex}`
    }))
  };
}

function directRequest(template: KnowledgeStrategyStepTemplateV1): KnowledgeStrategyStepRequestV1 {
  const request = materializeKnowledgeStrategyStepRequestV1(template, [], []);
  if (!request) throw new Error("strategy_test_request_unavailable");
  return request;
}

function reduceRequest(input: Readonly<{
  execution: NonNullable<StoredKnowledgeStrategyExecution["execution"]>;
  receipts: readonly KnowledgeStrategyMapOutputReceiptV2[];
  template: KnowledgeStrategyStepTemplateV1;
}>): KnowledgeStrategyStepRequestV1 {
  const dependency = createKnowledgeStrategyMapOutputDependencyInputV2({
    dependentStepId: input.template.stepId,
    execution: input.execution,
    receipts: input.receipts
  });
  const { materializationMode: _materializationMode, ...request } = input.template;
  return createKnowledgeStrategyStepRequestV1({
    ...request,
    evidenceInputHash: hashKnowledgeStrategyMapOutputDependencyInputV2(dependency)
  });
}

function storedStep(input: Readonly<{
  executionId: string;
  modelRunToolCallId: string | null;
  request: KnowledgeStrategyStepRequestV1 | null;
  state?: StoredKnowledgeStrategyStep["lifecycle"]["state"];
  stateVersion?: number;
  template: KnowledgeStrategyStepTemplateV1;
  receipt?: KnowledgeStrategyStepReceiptV1 | null;
  irreversibleDispatch?: boolean;
}>): StoredKnowledgeStrategyStep {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const state = input.state ?? "running";
  const stateVersion = input.stateVersion ?? 1;
  const receipt = input.receipt ?? null;
  return {
    createdAt: now,
    cursor: receipt?.nextCursor ?? null,
    includedPassageCount: 0,
    lifecycle: {
      attemptCount: state === "pending" ? 0 : 1,
      executionId: input.executionId,
      failureCode: null,
      irreversibleDispatch: input.irreversibleDispatch ?? false,
      leaseExpiresAt: state === "running" ? "2026-08-20T01:00:00.000Z" : null,
      leaseToken: state === "running" ? "strategy-test-lease" : null,
      receiptHash: receipt ? hashKnowledgeStrategyStepReceiptV1(receipt) : null,
      state,
      stateVersion,
      stepId: input.template.stepId,
      version: 1
    },
    materializedAt: input.request ? now : null,
    modelRunToolCallId: input.modelRunToolCallId,
    processedPassageCount: receipt?.processedItemCount ?? 0,
    processedSourceCount: receipt && receipt.processedItemCount > 0 ? 1 : 0,
    providerAttemptId: null,
    purgedAt: null,
    receipt,
    request: input.request,
    settledAt: receipt ? now : null,
    template: input.template,
    updatedAt: now
  };
}

function storedExecution(input: Readonly<{
  dependencies: StoredKnowledgeStrategyExecution["dependencies"];
  execution: NonNullable<StoredKnowledgeStrategyExecution["execution"]>;
  mapOutputs?: readonly StoredKnowledgeStrategyMapOutput[];
  steps: readonly StoredKnowledgeStrategyStep[];
}>): StoredKnowledgeStrategyExecution {
  const now = new Date("2026-08-20T00:00:00.000Z");
  return {
    coverage: null,
    createdAt: now,
    dependencies: input.dependencies,
    dispatchManifestHash: null,
    execution: input.execution,
    failureCode: null,
    includedPassageCount: 0,
    mapOutputs: input.mapOutputs ?? [],
    modelRunId: input.execution.modelRunId,
    processedPassageCount: input.steps.reduce((total, step) =>
      total + step.processedPassageCount, 0),
    processedSourceCount: new Set(input.steps.flatMap((step) =>
      step.processedSourceCount > 0 && step.request?.sourceBindingId
        ? [step.request.sourceBindingId]
        : [])).size,
    purgedAt: null,
    retrievalSessionId: "retrieval-session-strategy",
    state: "running",
    steps: input.steps,
    updatedAt: now
  };
}

function strategyRepository(initial: StoredKnowledgeStrategyExecution) {
  let current = initial;
  const claimToolCallStep = vi.fn(async () => ({
    execution: current,
    kind: "claimed" as const,
    leaseToken: "strategy-test-lease",
    step: current.steps.find(({ modelRunToolCallId }) =>
      modelRunToolCallId === TOOL_CALL_ID)!
  }));
  const markStepDispatched = vi.fn(async () => {
    const claimed = current.steps.find(({ modelRunToolCallId }) =>
      modelRunToolCallId === TOOL_CALL_ID)!;
    const step = {
      ...claimed,
      lifecycle: {
        ...claimed.lifecycle,
        irreversibleDispatch: true,
        stateVersion: claimed.lifecycle.stateVersion + 1
      }
    } satisfies StoredKnowledgeStrategyStep;
    current = { ...current, steps: current.steps.map((candidate) =>
      candidate.lifecycle.stepId === step.lifecycle.stepId ? step : candidate) };
    return { execution: current, kind: "transitioned" as const, step };
  });
  const markStepAmbiguous = vi.fn(async () => {
    const step = current.steps.find(({ modelRunToolCallId }) =>
      modelRunToolCallId === TOOL_CALL_ID)!;
    return { execution: current, kind: "transitioned" as const, step };
  });
  const releaseStep = vi.fn(async () => {
    const step = current.steps.find(({ modelRunToolCallId }) =>
      modelRunToolCallId === TOOL_CALL_ID)!;
    return { execution: current, kind: "transitioned" as const, step };
  });
  const failStep = vi.fn(async () => {
    const step = current.steps.find(({ modelRunToolCallId }) =>
      modelRunToolCallId === TOOL_CALL_ID)!;
    return { execution: current, kind: "transitioned" as const, step };
  });
  const finalizeExecution = vi.fn();
  const repository = {
    claimToolCallStep,
    failStep,
    finalizeExecution,
    loadExecution: vi.fn(async () => current),
    loadMapOutputs: vi.fn(async () => current.mapOutputs),
    markStepAmbiguous,
    markStepDispatched,
    releaseStep
  } as unknown as PrismaKnowledgeStrategyRepository;
  return {
    failStep,
    finalizeExecution,
    markStepAmbiguous,
    markStepDispatched,
    releaseStep,
    replaceExecution(value: StoredKnowledgeStrategyExecution) {
      current = value;
    },
    repository
  };
}

function executionHarness(input: Readonly<{
  initial: StoredKnowledgeStrategyExecution;
  onPersist?: (value: Parameters<KnowledgeRetrievalStore["persistReceipt"]>[0]) => void;
  retrievalFailure?: Error;
  sources: readonly KnowledgeAcceptedSourceTupleV1[];
  transformStrategyPage?: (
    page: KnowledgeStrategyPassagePage
  ) => KnowledgeStrategyPassagePage;
}>) {
  const strategies = strategyRepository(input.initial);
  const embed = vi.fn(async () => ({
    model: "embedding-v1",
    requestId: "embedding-request-strategy",
    usage: { inputTokens: 1, totalTokens: 1 },
    vectors: [Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)]
  }));
  const embeddingRuntime: KnowledgeAcceptedEmbeddingRuntime = {
    adapter: { embed },
    configuration: embeddingConfiguration,
    provider: "openai_compatible",
    providerModelId: embeddingSnapshot.providerModelId
  };
  const persisted = vi.fn(async (
    value: Parameters<KnowledgeRetrievalStore["persistReceipt"]>[0]
  ): Promise<KnowledgeRetrievalEvidence> => {
    input.onPersist?.(value);
    if (!value.strategyStep) return value.evidence;
    const request = input.initial.steps.find(({ lifecycle }) =>
      lifecycle.stepId === value.strategyStep!.stepId)?.request;
    if (!request) throw new Error("strategy_test_request_unavailable");
    const receipt = value.strategyStep.receipt as KnowledgeStrategyStepReceiptV1;
    return {
      ...value.evidence,
      strategyStepEvidence: {
        executionId: request.executionId,
        kind: request.kind,
        ordinal: request.ordinal,
        requestHash: hashKnowledgeStrategyStepRequestV1(request),
        resultHash: hashKnowledgeStrategyStepReceiptV1(receipt),
        stepId: request.stepId,
        version: 1
      }
    };
  });
  const loadStrategyPassagePage = vi.fn(async (request) => {
    const page = passagePage(request);
    return input.transformStrategyPage?.(page) ?? page;
  });
  const hybridSearch = vi.fn(async () => {
    if (input.retrievalFailure) throw input.retrievalFailure;
    return {
      bindingCount: 1,
      candidateCount: 0,
      candidateCounts: { 0: 0 },
      passages: []
    };
  });
  const store: KnowledgeRetrievalStore = {
    hybridSearch,
    invocationOrdinal: vi.fn(async () => 1),
    loadBindings: vi.fn(async () => [binding()]),
    loadScopeAliases: vi.fn(async () => aliases(input.sources)),
    loadStrategyPassagePage,
    loadStrategySources: vi.fn(async () => input.sources),
    persistReceipt: persisted,
    prepareStrategySession: vi.fn(async () => ({ id: "retrieval-session-strategy" }))
  };
  const executor = createKnowledgeToolExecutor({
    embeddingRuntime: { resolve: vi.fn(async () => embeddingRuntime) },
    store,
    strategies: strategies.repository
  });
  return {
    embed,
    executor,
    hybridSearch,
    loadStrategyPassagePage,
    persisted,
    strategies
  };
}

async function execute(
  harness: ReturnType<typeof executionHarness>,
  strategy: Exclude<KnowledgePlannerStrategy, "none">,
  expectedPassageCount: number
) {
  return executeWithArguments(
    harness,
    automaticArguments(strategy, expectedPassageCount)
  );
}

async function executeWithArguments(
  harness: ReturnType<typeof executionHarness>,
  argumentsValue: Record<string, unknown>
) {
  return harness.executor.execute({
    arguments: argumentsValue,
    id: "provider-call-strategy",
    name: "retrieve_knowledge"
  }, {
    persistedToolCallId: TOOL_CALL_ID,
    request: {} as never,
    runId: RUN_ID,
    userId: USER_ID
  });
}

function preparedExecution(
  strategy: Extract<KnowledgeMeasuredStrategy, "full_context" | "exhaustive">,
  acceptedSource: KnowledgeAcceptedSourceTupleV1,
  pageSize: number
) {
  const prepared = prepareKnowledgeStrategyExecutionV1({
    calls: [{ id: TOOL_CALL_ID, ordinal: 0 }],
    executionId: `execution-${strategy}`,
    modelRunId: RUN_ID,
    pageSize,
    plan: plannerPlan(strategy, acceptedSource.passageCount),
    sources: [acceptedSource]
  });
  if (!prepared) throw new Error("strategy_test_plan_unavailable");
  return prepared;
}

describe("H4 strategy executor evidence bounds", () => {
  it("dispatches every whole full-context passage through the exact bounded path", async () => {
    const acceptedSource = source(0, 8);
    const prepared = preparedExecution("full_context", acceptedSource, 8);
    const plannedStep = prepared.steps[0]!;
    const request = directRequest(plannedStep.template);
    const initial = storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      steps: [storedStep({
        executionId: prepared.execution.executionId,
        modelRunToolCallId: TOOL_CALL_ID,
        request,
        template: plannedStep.template
      })]
    });
    const harness = executionHarness({ initial, sources: [acceptedSource] });

    const result = await execute(harness, "full_context", 8);
    const evidence = knowledgeEvidenceFromToolResult(result)!;

    expect(result.status).toBe("complete");
    expect(evidence.results).toHaveLength(8);
    expect(evidence.results.map(({ includedText, textTruncated }) => ({
      includedText,
      textTruncated
    }))).toEqual(Array.from({ length: 8 }, (_, ordinal) => ({
      includedText: `whole-passage-1-${ordinal + 1}`,
      textTruncated: false
    })));
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("whole-passage-1-8"),
      type: "text"
    });
    expect(harness.loadStrategyPassagePage.mock.calls.map(([value]) => value.limit))
      .toEqual([8]);
    expect(harness.embed).not.toHaveBeenCalled();
    expect(harness.hybridSearch).not.toHaveBeenCalled();
  });

  it.each([9, 100])(
    "accepts an exhaustive page with %i whole results under its strategy marker",
    async (passageCount) => {
      const acceptedSource = source(0, passageCount);
      const prepared = preparedExecution("exhaustive", acceptedSource, 100);
      const plannedStep = prepared.steps[0]!;
      const request = directRequest(plannedStep.template);
      const initial = storedExecution({
        dependencies: prepared.dependencies,
        execution: prepared.execution,
        steps: [storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: TOOL_CALL_ID,
          request,
          template: plannedStep.template
        })]
      });
      const harness = executionHarness({ initial, sources: [acceptedSource] });

      const result = await execute(harness, "exhaustive", passageCount);
      const evidence = knowledgeEvidenceFromToolResult(result)!;

      expect(result.status).toBe("complete");
      expect(evidence.results).toHaveLength(passageCount);
      expect(evidence.resultLimit).toBe(passageCount);
      expect(evidence.strategyStepEvidence?.kind).toBe("exhaustive_page");
      expect(decodeKnowledgeRetrievalEvidence(evidence)?.results).toHaveLength(passageCount);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(`whole-passage-1-${passageCount}`),
        type: "text"
      });
      expect(harness.loadStrategyPassagePage.mock.calls[0]?.[0].limit).toBe(100);
      expect(harness.embed).not.toHaveBeenCalled();
      expect(harness.hybridSearch).not.toHaveBeenCalled();
    }
  );

  it("caps provider-visible exhaustive evidence at 100 and refuses verified coverage above it", async () => {
    const acceptedSource = source(0, 101);
    const prepared = preparedExecution("exhaustive", acceptedSource, 100);
    const first = prepared.steps[0]!;
    const second = prepared.steps[1]!;
    const firstRequest = directRequest(first.template);
    const firstReceipt = knowledgeStrategyPassageStepReceiptV1(
      firstRequest,
      passagePage({
        cursor: firstRequest.cursor,
        executionId: firstRequest.executionId,
        limit: 100,
        source: acceptedSource,
        streamId: firstRequest.streamId
      })
    );
    const secondRequest = materializeKnowledgeStrategyStepRequestV1(
      second.template,
      prepared.dependencies,
      [{ receipt: firstReceipt, request: firstRequest }]
    );
    if (!secondRequest) throw new Error("strategy_test_cursor_request_unavailable");
    const initial = storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      steps: [
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: null,
          receipt: firstReceipt,
          request: firstRequest,
          state: "settled",
          stateVersion: 2,
          template: first.template
        }),
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: TOOL_CALL_ID,
          request: secondRequest,
          template: second.template
        })
      ]
    });
    let settledFinalReceipt: KnowledgeStrategyStepReceiptV1 | null = null;
    const harness = executionHarness({
      initial,
      onPersist(value) {
        settledFinalReceipt = value.strategyStep?.receipt as KnowledgeStrategyStepReceiptV1;
      },
      sources: [acceptedSource]
    });

    const result = await execute(harness, "exhaustive", 101);
    const evidence = knowledgeEvidenceFromToolResult(result)!;
    expect(evidence.results).toHaveLength(100);
    expect(settledFinalReceipt).toMatchObject({
      cursorExhausted: true,
      processedItemCount: 1
    });
    harness.strategies.replaceExecution(storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      steps: [
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: null,
          receipt: firstReceipt,
          request: firstRequest,
          state: "settled",
          stateVersion: 2,
          template: first.template
        }),
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: TOOL_CALL_ID,
          receipt: settledFinalReceipt!,
          request: secondRequest,
          state: "settled",
          stateVersion: 2,
          template: second.template
        })
      ]
    }));
    const draft = packKnowledgeEvidenceDispatchManifest({
      candidates: evidence.results.map((entry, ordinal) => ({
        ambiguity: "none",
        evidenceId: `evidence-${ordinal + 1}`,
        exactExcerpt: entry.includedText,
        fileName: entry.fileName,
        handle: entry.handle,
        locator: `passage:${entry.chunkId}`,
        operationOrdinal: 0,
        resultOrdinal: ordinal + 1,
        sourceAlias: entry.sourceAlias!,
        sourceLabel: entry.sourceName!,
        sourceTruncated: entry.textTruncated,
        sourceVersionNumber: entry.documentVersionNumber,
        state: "available"
      })),
      coverageStatement: "",
      footer: "End evidence",
      header: "Evidence",
      maximumBytes: 1_000_000,
      maximumTokens: 1_000_000,
      plannerVersion: 2,
      profileId: "strategy-test",
      promptFragmentVersion: 1
    });

    await expect(harness.executor.finalizeStrategyCoverage!({
      draft,
      executionId: prepared.execution.executionId,
      requireVerified: true
    })).resolves.toEqual({ kind: "requires_unverified" });
    expect(harness.strategies.finalizeExecution).not.toHaveBeenCalled();
  });

  it("fails closed before persistence when an exact page omits a frozen passage", async () => {
    const acceptedSource = source(0, 8);
    const prepared = preparedExecution("full_context", acceptedSource, 8);
    const plannedStep = prepared.steps[0]!;
    const request = directRequest(plannedStep.template);
    const initial = storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      steps: [storedStep({
        executionId: prepared.execution.executionId,
        modelRunToolCallId: TOOL_CALL_ID,
        request,
        template: plannedStep.template
      })]
    });
    const harness = executionHarness({
      initial,
      sources: [acceptedSource],
      transformStrategyPage(page) {
        return {
          ...page,
          items: page.items.slice(0, -1),
          passages: page.passages.slice(0, -1)
        };
      }
    });

    await expect(execute(harness, "full_context", 8))
      .rejects.toThrow("knowledge_strategy_dispatch_lineage_invalid");
    expect(harness.persisted).not.toHaveBeenCalled();
  });

  it("dispatches a comparison target only through its frozen Source binding", async () => {
    const fixture = comparisonFixture();
    const harness = executionHarness({
      initial: fixture.initial,
      sources: fixture.sources
    });

    const result = await executeWithArguments(harness, comparisonArguments({
      query: fixture.queries[0]!,
      source: fixture.sources[0]!,
      subqueryOrdinal: 0
    }));

    expect(result.status).toBe("complete");
    expect(harness.hybridSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: fixture.queries[0],
      sourceIds: [fixture.sources[0]!.sourceId]
    }));
    expect(harness.strategies.markStepDispatched).toHaveBeenCalledOnce();
    expect(harness.strategies.releaseStep).not.toHaveBeenCalled();
    expect(harness.persisted).toHaveBeenCalledOnce();
  });

  it("releases a comparison step when the ToolCall targets another Source", async () => {
    const fixture = comparisonFixture();
    const harness = executionHarness({
      initial: fixture.initial,
      sources: fixture.sources
    });

    const result = await executeWithArguments(harness, comparisonArguments({
      query: fixture.queries[0]!,
      source: fixture.sources[1]!,
      subqueryOrdinal: 0
    }));

    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain(fixture.sources[0]!.sourceId);
    expect(JSON.stringify(result)).not.toContain(fixture.sources[1]!.sourceId);
    expect(harness.strategies.releaseStep).toHaveBeenCalledWith(expect.objectContaining({
      executionId: fixture.initial.execution!.executionId,
      stepId: fixture.initial.steps[0]!.lifecycle.stepId
    }));
    expect(harness.strategies.markStepDispatched).not.toHaveBeenCalled();
    expect(harness.hybridSearch).not.toHaveBeenCalled();
    expect(harness.persisted).not.toHaveBeenCalled();
  });

  it("globally bounds 50 substantive Source maps without collapsing to top eight", async () => {
    const sources = Array.from({ length: 50 }, (_, ordinal) => source(ordinal, 1));
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: TOOL_CALL_ID, ordinal: 0 }],
      executionId: "execution-corpus-summary",
      modelRunId: RUN_ID,
      pageSize: 64,
      plan: plannerPlan("corpus_summary", 50),
      sources
    });
    if (!prepared) throw new Error("strategy_test_plan_unavailable");
    const mapFixtures = prepared.steps.filter(({ template }) =>
      template.kind === "corpus_summary_map").map((planned, ordinal) => {
      const request = directRequest(planned.template);
      const page = substantiveStrategyPage(passagePage({
        cursor: request.cursor,
        executionId: request.executionId,
        limit: 64,
        source: sources[ordinal]!,
        streamId: request.streamId
      }));
      const receipt = knowledgeStrategyPassageStepReceiptV1(request, page);
      const artifacts = createDeterministicKnowledgeStrategyMapArtifactsV2({
        execution: prepared.execution,
        pages: [page],
        source: sources[ordinal]!,
        stepReceipts: [receipt],
        stepRequests: [request]
      });
      return { artifacts, planned, receipt, request };
    });
    const reduce = prepared.steps.find(({ template }) =>
      template.kind === "corpus_summary_reduce")!;
    const request = reduceRequest({
      execution: prepared.execution,
      receipts: mapFixtures.map(({ artifacts }) => artifacts.receipt),
      template: reduce.template
    });
    const at = new Date("2026-08-20T00:00:00.000Z");
    const mapOutputs: StoredKnowledgeStrategyMapOutput[] = mapFixtures.map((fixture) => ({
      createdAt: at,
      executionId: prepared.execution.executionId,
      id: `map-output-${fixture.artifacts.output.sourceOrdinal}`,
      modelRunId: RUN_ID,
      output: fixture.artifacts.output,
      purgedAt: null,
      receipt: fixture.artifacts.receipt,
      settledAt: at,
      sourceOrdinal: fixture.artifacts.output.sourceOrdinal,
      state: "available",
      terminalStepId: fixture.request.stepId,
      updatedAt: at
    }));
    const initial = storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      mapOutputs,
      steps: [
        ...mapFixtures.map(({ planned, receipt, request: mapRequest }) => storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: null,
          receipt,
          request: mapRequest,
          state: "settled",
          stateVersion: 2,
          template: planned.template
        })),
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: TOOL_CALL_ID,
          request,
          template: reduce.template
        })
      ]
    });
    const harness = executionHarness({
      initial,
      sources,
      transformStrategyPage: substantiveStrategyPage
    });

    const result = await execute(harness, "corpus_summary", 50);
    const evidence = knowledgeEvidenceFromToolResult(result)!;
    const providerText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(result.status).toBe("complete");
    expect(evidence.results).toHaveLength(50);
    expect(evidence.strategySummaryEvidence).toMatchObject({
      sourceCount: 50,
      version: 2
    });
    expect(evidence.results.map(({ sourceAlias }) => sourceAlias))
      .toEqual(sources.map(({ sourceAlias }) => sourceAlias));
    expect(evidence.results.at(-1)).toMatchObject({
      handle: "K50",
      includedText: expect.stringContaining("substantive-source-50"),
      textTruncated: false
    });
    expect(providerText).toContain("<corpus_summary_evidence version=\"2\">");
    expect(providerText).toContain("substantive-source-50");
    expect(providerText.match(/substantive-source-/gu)).toHaveLength(50);
    expect(Buffer.byteLength(providerText, "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(evidence.results).not.toHaveLength(8);
    expect(harness.loadStrategyPassagePage).toHaveBeenCalledTimes(50);
    expect(harness.embed).not.toHaveBeenCalled();
    expect(harness.hybridSearch).not.toHaveBeenCalled();
  });

  it("fails closed when 50 multi-section maps exceed the bounded support set", async () => {
    const sources = Array.from({ length: 50 }, (_, ordinal) => source(ordinal, 3));
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: TOOL_CALL_ID, ordinal: 0 }],
      executionId: "execution-corpus-summary-support-limit",
      modelRunId: RUN_ID,
      pageSize: 64,
      plan: plannerPlan("corpus_summary", 150),
      sources
    });
    if (!prepared) throw new Error("strategy_test_plan_unavailable");
    const mapFixtures = prepared.steps.filter(({ template }) =>
      template.kind === "corpus_summary_map").map((planned, ordinal) => {
      const request = directRequest(planned.template);
      const page = sectionedSubstantiveStrategyPage(passagePage({
        cursor: request.cursor,
        executionId: request.executionId,
        limit: 64,
        source: sources[ordinal]!,
        streamId: request.streamId
      }));
      const receipt = knowledgeStrategyPassageStepReceiptV1(request, page);
      const artifacts = createDeterministicKnowledgeStrategyMapArtifactsV2({
        execution: prepared.execution,
        pages: [page],
        source: sources[ordinal]!,
        stepReceipts: [receipt],
        stepRequests: [request]
      });
      return { artifacts, planned, receipt, request };
    });
    const reduce = prepared.steps.find(({ template }) =>
      template.kind === "corpus_summary_reduce")!;
    const request = reduceRequest({
      execution: prepared.execution,
      receipts: mapFixtures.map(({ artifacts }) => artifacts.receipt),
      template: reduce.template
    });
    const at = new Date("2026-08-20T00:00:00.000Z");
    const mapOutputs: StoredKnowledgeStrategyMapOutput[] = mapFixtures.map((fixture) => ({
      createdAt: at,
      executionId: prepared.execution.executionId,
      id: `map-output-${fixture.artifacts.output.sourceOrdinal}`,
      modelRunId: RUN_ID,
      output: fixture.artifacts.output,
      purgedAt: null,
      receipt: fixture.artifacts.receipt,
      settledAt: at,
      sourceOrdinal: fixture.artifacts.output.sourceOrdinal,
      state: "available",
      terminalStepId: fixture.request.stepId,
      updatedAt: at
    }));
    const initial = storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      mapOutputs,
      steps: [
        ...mapFixtures.map(({ planned, receipt, request: mapRequest }) => storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: null,
          receipt,
          request: mapRequest,
          state: "settled",
          stateVersion: 2,
          template: planned.template
        })),
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: TOOL_CALL_ID,
          request,
          template: reduce.template
        })
      ]
    });
    const harness = executionHarness({
      initial,
      sources,
      transformStrategyPage: sectionedSubstantiveStrategyPage
    });

    const result = await execute(harness, "corpus_summary", 150);
    const evidence = knowledgeEvidenceFromToolResult(result)!;

    expect(result.status).toBe("complete");
    expect(evidence).toMatchObject({
      candidateCount: 0,
      failureCode: "knowledge_strategy_summary_support_limit_exceeded",
      outcome: "base_empty",
      results: []
    });
    expect(evidence.strategySummaryEvidence).toBeUndefined();
    expect(harness.strategies.failStep).toHaveBeenCalledOnce();
    expect(harness.persisted).toHaveBeenCalledWith(expect.not.objectContaining({
      strategyStep: expect.anything()
    }));
    expect(harness.loadStrategyPassagePage).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
    expect(harness.hybridSearch).not.toHaveBeenCalled();
  });

  it("marks provider-backed strategy work dispatched and ambiguous on retrieval failure", async () => {
    const acceptedSource = source(0, 1);
    const multiHopPlan: KnowledgePlannerPlanV2 = {
      ...plannerPlan("multi_pass", 1),
      intent: "multi_hop_reasoning",
      strategy: "multi_pass",
      subqueries: [{
        exact: null,
        exactTerms: [],
        lanes: ["lexical"],
        operation: "automatic_search",
        ordinal: 0,
        purpose: "answer",
        query: "Find the first fact",
        targetNames: [],
        targetResolution: null,
        targetSourceIds: []
      }, {
        exact: null,
        exactTerms: [],
        lanes: ["lexical"],
        operation: "automatic_search",
        ordinal: 1,
        purpose: "follow_up",
        query: "Use it for the second fact",
        targetNames: [],
        targetResolution: null,
        targetSourceIds: []
      }]
    };
    const prepared = prepareKnowledgeStrategyExecutionV1({
      calls: [{ id: TOOL_CALL_ID, ordinal: 0 }, {
        id: "tool-call-strategy-follow-up",
        ordinal: 1
      }],
      executionId: "execution-multi-hop",
      modelRunId: RUN_ID,
      plan: multiHopPlan,
      sources: [acceptedSource]
    });
    if (!prepared) throw new Error("strategy_test_plan_unavailable");
    const root = prepared.steps[0]!;
    const followUp = prepared.steps[1]!;
    const rootRequest = directRequest(root.template);
    const initial = storedExecution({
      dependencies: prepared.dependencies,
      execution: prepared.execution,
      steps: [
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: TOOL_CALL_ID,
          request: rootRequest,
          template: root.template
        }),
        storedStep({
          executionId: prepared.execution.executionId,
          modelRunToolCallId: "tool-call-strategy-follow-up",
          request: null,
          state: "pending",
          template: followUp.template
        })
      ]
    });
    const harness = executionHarness({
      initial,
      retrievalFailure: new Error("provider_transport_failed"),
      sources: [acceptedSource]
    });

    await expect(execute(harness, "multi_pass", 1)).rejects.toThrow("provider_transport_failed");
    expect(harness.strategies.markStepDispatched).toHaveBeenCalledOnce();
    expect(harness.strategies.markStepAmbiguous).toHaveBeenCalledWith(expect.objectContaining({
      executionId: prepared.execution.executionId,
      receipt: expect.objectContaining({
        reasonCode: "knowledge_strategy_dispatch_ambiguous",
        status: "ambiguous"
      }),
      stateVersion: 2,
      stepId: rootRequest.stepId
    }));
    expect(harness.strategies.releaseStep).not.toHaveBeenCalled();
    expect(harness.hybridSearch).toHaveBeenCalledOnce();
  });
});
