import { createHash, randomUUID } from "node:crypto";
import type { EmbeddingAdapter } from "../providers/embeddings";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type {
  ModelToolCall,
  RunTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutor
} from "../tools/types";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  isKnowledgeRetrievalPolicy,
  type KnowledgeRetrievalPolicyResolver
} from "./knowledgePolicy";
import {
  aggregateKnowledgeUsage,
  knowledgeToolResultContent,
  knowledgeToolResultText
} from "./toolResult";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_EXECUTION_TOOL_NAMES,
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SCORE_THRESHOLD,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_TOOL_NAME,
  type KnowledgeAcceptedBinding,
  type KnowledgeBaseRetrievalEvidence,
  type KnowledgeEmbeddingExecutionEvidence,
  type KnowledgeExactSearchRequest,
  type KnowledgeExactSearchResult,
  type KnowledgeHybridSearchResult,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeRetrievedPassageEvidence,
  type KnowledgeSourceBoundRetrievedPassageEvidence,
  type KnowledgeSourceDiscoveryRequest,
  type KnowledgeSourceDiscoveryResult,
  type KnowledgeStrategyPassagePage,
  type KnowledgeVectorSearchEvidence
} from "./retrievalTypes";
import type {
  KnowledgeAcceptedSourceTupleV1,
  KnowledgeMeasuredStrategy,
  KnowledgeStrategyCoverageReceiptV1,
  KnowledgeStrategyCursorV1,
  KnowledgeStrategyStepReceiptV1
} from "./knowledgeStrategyExecution";
import {
  createKnowledgeStrategyStepReceiptV1,
  deriveKnowledgeStrategyCoverageReceiptV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  sealKnowledgeStrategyStepEvidenceV1
} from "./knowledgeStrategyExecution";
import { verifyKnowledgeStrategyDispatchLineageV1 } from "./knowledgeStrategyDispatchLineage";
import type { KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import { knowledgeStrategyCoverageVerifiedForDispatch } from "./evidencePackage";
import type { KnowledgePlannerPlanV2 } from "./planner";
import {
  KNOWLEDGE_STRATEGY_PAGE_SIZE,
  prepareKnowledgeStrategyExecutionV1
} from "./knowledgeStrategyPlan";
import type {
  PrismaKnowledgeStrategyRepository,
  StoredKnowledgeStrategyExecution
} from "./knowledgeStrategyRepository";
import {
  KnowledgeStrategyRepositoryError,
  type KnowledgeStrategyStepClaim
} from "./knowledgeStrategyRepository";
import {
  drainKnowledgeStrategyInternalSteps,
  knowledgeStrategyCorpusSummaryReduceReceiptV2,
  knowledgeStrategyCoverageRequestForDispatchV1,
  knowledgeStrategyEvidenceStepReceiptV1,
  knowledgeStrategyPassageStepReceiptV1
} from "./knowledgeStrategyRuntime";
import {
  decodeKnowledgeStrategyMapOutputReceiptV2,
  decodeKnowledgeStrategyMapOutputV2,
  type KnowledgeStrategyMapOutputV2,
  type KnowledgeStrategyMapSupportingPassageV2
} from "./knowledgeStrategyMapOutput";
import {
  buildKnowledgeStrategySummaryResultEvidenceV2
} from "./knowledgeStrategySummaryEvidence";
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  estimatedKnowledgeEmbeddingCostMicros,
  knowledgeBudgetStopReason,
  type KnowledgeBudgetPolicy,
  type KnowledgeBudgetStopReason,
  type KnowledgeBudgetUsage,
  type KnowledgeOperationKind
} from "./knowledgeBudget";
import type {
  KnowledgeBudgetOperationRequestInput,
  KnowledgeBudgetResourceActual,
  KnowledgeBudgetReservationRepository,
  StoredKnowledgeBudgetReservation
} from "./knowledgeBudgetReservationRepository";
import type { KnowledgeBudgetReservationStopReason } from "./knowledgeBudgetReservation";
import type {
  KnowledgeOperationPlanProjectionV2,
  KnowledgeOperationPurpose,
  KnowledgeStructuredAnalysisOperationRequestV2,
  KnowledgeVisualAnalysisOperationRequestV2
} from "./knowledgeOperationRequest";
import {
  knowledgeFollowUpTools,
  knowledgeRetrievalTool,
  parseKnowledgeSemanticToolRequest
} from "./knowledgeTools";
import {
  READ_SOURCE_MAX_WINDOW,
  type NormalizedReadSourceRequest
} from "./readSourceLocator";
import {
  decodeKnowledgeDocumentContext,
  isCompleteKnowledgeTableRowProjectionSequence,
  type KnowledgeDocumentLocatorV1
} from "./documentContext";
import type { KnowledgeCanonicalSourceProvenance } from "./canonicalSourceCandidates";
import type { StructuredKnowledgeSearchResult } from "./structuredRetrieval";
import { isStructuredDataQuery } from "./structuredPlanner";
import {
  isVisualKnowledgeQuery,
  type KnowledgeVisualSearchResult
} from "./visualEvidence";

export { knowledgeRetrievalTool } from "./knowledgeTools";

export type KnowledgeAcceptedEmbeddingRuntime = Readonly<{
  adapter: EmbeddingAdapter;
  configuration: Readonly<{
    embedding?: Readonly<{
      nativeDimension: number;
      providerFamily: string;
      queryInstructionTemplate: string | null;
      supportsMrl: boolean;
      targetDimension: number;
    }>;
    upstreamModelId: string;
  }>;
  provider: string;
  providerModelId: string;
}>;

export type KnowledgeRetrievalStore = Readonly<{
  prepareStrategySession?(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<Readonly<{ id: string }>>;
  budgetState?(input: Readonly<{
    modelRunToolCallId: string;
    operation: KnowledgeOperationKind;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetState | null>;
  hybridSearch(input: Readonly<{
    bindingOrdinals?: readonly number[];
    candidateLimit: number;
    operation: KnowledgeOperationKind;
    query: string;
    resultLimit: number;
    runId: string;
    sourceIds?: readonly string[];
    threshold: number;
    userId: string;
    vectors: readonly Readonly<{
      bindingOrdinal: number;
      indexGenerationId: string;
      knowledgeBaseId: string;
      targetDimension: 1024 | 1536;
      vector: readonly number[];
    }>[];
  }>): Promise<KnowledgeHybridSearchResult>;
  discoverSources?(input: Readonly<{
    request: KnowledgeSourceDiscoveryRequest;
    runId: string;
    sourceArtifactIds: readonly string[];
    userId: string;
  }>): Promise<KnowledgeSourceDiscoveryResult>;
  findExact?(input: Readonly<{
    request: KnowledgeExactSearchRequest;
    runId: string;
    sourceArtifactIds: readonly string[];
    userId: string;
  }>): Promise<KnowledgeExactSearchResult>;
  invocationOrdinal(input: Readonly<{
    modelRunToolCallId: string;
    runId: string;
    toolName: string;
    userId: string;
  }>): Promise<number | null>;
  loadReceipt?(input: Readonly<{
    modelRunToolCallId: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeRetrievalEvidence | null>;
  loadBindings(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<readonly KnowledgeAcceptedBinding[]>;
  loadStrategyPassagePage?(input: Readonly<{
    cursor: KnowledgeStrategyCursorV1 | null;
    executionId: string;
    limit: number;
    runId: string;
    source: KnowledgeAcceptedSourceTupleV1;
    streamId: string;
    userId: string;
  }>): Promise<KnowledgeStrategyPassagePage>;
  loadStrategySources?(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<readonly KnowledgeAcceptedSourceTupleV1[]>;
  loadScopeAliases?(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<readonly KnowledgeScopeAlias[]>;
  readSource?(input: Readonly<{
    binding: KnowledgeAcceptedBinding;
    read: NormalizedReadSourceRequest;
    runId: string;
    sourceArtifactId: string;
    sourceId: string;
    userId: string;
  }>): Promise<KnowledgeHybridSearchResult>;
  persistReceipt(input: Readonly<{
    budgetReservation?: Readonly<{
      actual: KnowledgeBudgetResourceActual;
      leaseToken: string;
      reservationId: string;
    }>;
    canonicalSourceProvenance?: readonly KnowledgeCanonicalSourceProvenance[];
    evidence: KnowledgeRetrievalEvidence;
    modelRunToolCallId: string;
    runId: string;
    strategyStep?: Readonly<{
      at: Date;
      executionId: string;
      includedPassageCount?: number;
      leaseToken: string;
      receipt: unknown;
      stateVersion: number;
      stepId: string;
    }>;
    userId: string;
  }>): Promise<KnowledgeRetrievalEvidence | void>;
  structuredSearch?(input: Readonly<{
    bindings: readonly KnowledgeAcceptedBinding[];
    query: string;
    selector?: KnowledgeStructuredAnalysisOperationRequestV2["structured"]["selector"];
    signal?: AbortSignal;
    sourceArtifactIds: readonly string[];
    targetSourceIds?: readonly string[];
  }>): Promise<StructuredKnowledgeSearchResult>;
  visualSearch?(input: Readonly<{
    bindings: readonly KnowledgeAcceptedBinding[];
    query: string;
    selector?: KnowledgeVisualAnalysisOperationRequestV2["visual"]["selector"];
    signal?: AbortSignal;
    sourceArtifactIds: readonly string[];
    targetSourceIds?: readonly string[];
  }>): Promise<KnowledgeVisualSearchResult>;
}>;

export type KnowledgeScopeAlias = Readonly<{
  alias: string;
  bindingOrdinal: number;
  bindingOrdinals?: readonly number[];
  kind: "base" | "source";
  label: string;
  sourceArtifactId?: string;
  sourceId?: string;
  sourceIds?: readonly string[];
  sourceVersionId?: string;
}>;

export type KnowledgeBudgetState = Readonly<{
  evidenceCount?: number;
  invocationOrdinal: number;
  policy: KnowledgeBudgetPolicy;
  priorContentHashes: readonly string[];
  stopReason: KnowledgeBudgetStopReason | null;
  usage: KnowledgeBudgetUsage;
}>;

export type KnowledgeEmbeddingRuntimeResolver = Readonly<{
  resolve(binding: KnowledgeAcceptedBinding): Promise<KnowledgeAcceptedEmbeddingRuntime>;
}>;

export type KnowledgeToolExecutor = ToolExecutor & Readonly<{
  accepts(name: string): boolean;
  drainStrategy?(input: Readonly<{
    executionId: string;
    runId: string;
    userId: string;
  }>): Promise<void>;
  finalizeStrategyCoverage?(input: Readonly<{
    draft: KnowledgeEvidenceDispatchManifestDraft;
    executionId: string;
    requireVerified: boolean;
  }>): Promise<
    | Readonly<{ kind: "requires_unverified" }>
    | Readonly<{
        coverage: KnowledgeStrategyCoverageReceiptV1;
        execution: Readonly<{
          executionHash: string;
          executionId: string;
          sourceSetHash: string;
        }>;
        kind: "finalized";
      }>
  >;
  prepareStrategy?(input: Readonly<{
    calls: readonly Readonly<{ id: string; ordinal: number }>[];
    plan: KnowledgePlannerPlanV2;
    runId: string;
    userId: string;
  }>): Promise<Readonly<{
    executionId: string;
    strategy: KnowledgeMeasuredStrategy;
  }> | null>;
  preflight?(
    call: ModelToolCall,
    context: ToolExecutionContext
  ): Promise<KnowledgeExecutionAdmission>;
  tools?: readonly RunTool[];
}>;

export type KnowledgeExecutionAdmission =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "rejected"; result: ToolExecutionResult }>
  | Readonly<{ kind: "replayed"; result: ToolExecutionResult }>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeFailureCode(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "embedding_unavailable";
  return /^[a-z][a-z0-9_]{0,127}$/u.test(candidate)
    ? candidate
    : "embedding_unavailable";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("knowledge_retrieval_aborted");
  error.name = "AbortError";
  throw error;
}

function errorResult(call: ModelToolCall, code: string, message?: string): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{ text: message ?? `Knowledge retrieval failed: ${code}.`, type: "text" }],
    name: call.name,
    rawPreview: { providerCall: false },
    status: "error",
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  };
}

function budgetRejectionResult(
  call: ModelToolCall,
  stopReason: KnowledgeBudgetStopReason | KnowledgeBudgetReservationStopReason
): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{
      text: "Knowledge retrieval budget exhausted. Continue with the evidence already returned.",
      type: "text"
    }],
    name: call.name,
    rawPreview: {
      knowledgeAdmission: {
        reasonCode: "knowledge_budget_exhausted",
        stopReason,
        version: 1
      },
      providerCall: false
    },
    status: "error",
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  };
}

function completedResult(
  call: ModelToolCall,
  evidence: KnowledgeRetrievalEvidence
): ToolExecutionResult {
  return {
    callId: call.id,
    content: knowledgeToolResultContent(evidence),
    name: call.name,
    rawPreview: {
      knowledgeRetrieval: evidence,
      knowledgeResultVersion: evidence.version,
      providerCall: true
    },
    status: "complete",
    usage: aggregateKnowledgeUsage(evidence.embeddingExecutions, evidence.results)
  };
}

function baseEvidence(
  bindings: readonly KnowledgeAcceptedBinding[],
  candidateCounts: Readonly<Record<number, number>> = {},
  vectorSearchEvidence: readonly KnowledgeVectorSearchEvidence[] = [],
  readyWhenEmpty = false
): KnowledgeBaseRetrievalEvidence[] {
  const vectorByBinding = new Map(vectorSearchEvidence.map((entry) => [
    entry.bindingOrdinal,
    entry
  ]));
  return bindings.map((binding) => {
    const candidateCount = candidateCounts[binding.ordinal] ?? 0;
    const vectorSearch = vectorByBinding.get(binding.ordinal);
    return {
      baseContentRevision: binding.baseContentRevision,
      baseName: binding.baseName,
      candidateCount,
      indexedContentRevision: binding.indexedContentRevision,
      indexGenerationId: binding.indexGenerationId,
      knowledgeBaseId: binding.knowledgeBaseId,
      ordinal: binding.ordinal,
      state: binding.indexedContentRevision < binding.baseContentRevision
        ? "indexing"
        : candidateCount === 0 && !readyWhenEmpty ? "empty" : "ready",
      targetDimension: binding.targetDimension,
      ...(vectorSearch ? { vectorSearch } : {}),
      vectorSpaceFingerprint: binding.vectorSpaceFingerprint
    };
  });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

type ReadSourceTableLocator = Extract<KnowledgeDocumentLocatorV1, Readonly<{
  kind: "table_row" | "table_row_projection";
}>>;

function sameReadSourceStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function completeReadSourceRowGroup(
  passages: KnowledgeHybridSearchResult["passages"],
  rowId: string
): boolean {
  if (passages.length < 1 || passages.length > READ_SOURCE_MAX_WINDOW) return false;
  const locators: ReadSourceTableLocator[] = [];
  for (const passage of passages) {
    const context = passage.documentContext === undefined || passage.documentContext === null
      ? null
      : decodeKnowledgeDocumentContext(passage.documentContext);
    const locator = context?.locator;
    if (!locator || (locator.kind !== "table_row" &&
      locator.kind !== "table_row_projection") || passage.layoutKind !== locator.kind) return false;
    locators.push(locator);
  }
  const first = locators[0]!;
  const firstPassage = passages[0]!;
  const chunkIds = new Set<string>();
  const headerRows = new Set<number>();
  for (const [index, locator] of locators.entries()) {
    const passage = passages[index]!;
    if (locator.rowId !== rowId || locator.blockId !== first.blockId ||
      locator.rowIndex !== first.rowIndex || locator.rowKind !== first.rowKind ||
      locator.kind === "table_row_projection" && locator.headerLineage.some((header) =>
        header.columnStart < locator.columnStart || header.columnEnd > locator.columnEnd) ||
      passage.page !== firstPassage.page || passage.sectionId !== firstPassage.sectionId ||
      !sameReadSourceStrings(passage.headingPath ?? [], firstPassage.headingPath ?? []) ||
      passage.documentId !== firstPassage.documentId ||
      passage.documentVersionId !== firstPassage.documentVersionId ||
      passage.documentVersionNumber !== firstPassage.documentVersionNumber ||
      passage.sourceArtifactId !== firstPassage.sourceArtifactId || chunkIds.has(passage.chunkId) ||
      (index > 0 && passage.chunkIndex <= passages[index - 1]!.chunkIndex)) return false;
    chunkIds.add(passage.chunkId);
    locator.headerLineage.forEach((header) => headerRows.add(header.rowIndex));
  }
  if (headerRows.size > 1) return false;
  if (first.kind === "table_row") {
    return passages.length === 1 && locators.every((locator) => locator.kind === "table_row");
  }
  const projections = locators.filter((locator): locator is Extract<
    KnowledgeDocumentLocatorV1,
    Readonly<{ kind: "table_row_projection" }>
  > => locator.kind === "table_row_projection");
  return projections.length === locators.length &&
    isCompleteKnowledgeTableRowProjectionSequence(projections);
}

function readSourceRowId(
  passage: KnowledgeHybridSearchResult["passages"][number] | undefined
): string | null {
  const context = passage?.documentContext === undefined || passage.documentContext === null
    ? null
    : decodeKnowledgeDocumentContext(passage.documentContext);
  const locator = context?.locator;
  return locator?.kind === "table_row" || locator?.kind === "table_row_projection"
    ? locator.rowId
    : null;
}

function includedPassages(
  passages: KnowledgeHybridSearchResult["passages"],
  evidenceOffset: number,
  aliases: readonly KnowledgeScopeAlias[],
  maximumBytes = KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES
): KnowledgeRetrievedPassageEvidence[] {
  if (passages.length === 0) return [];
  // Source boundaries deliberately repeat bounded provenance next to every
  // handle. Reserve enough room for those headers and instructions before
  // dividing the remaining byte budget between excerpts.
  const metadataReserveBytes = 16 * 1024;
  const excerptBudgetBytes = Math.max(1, maximumBytes - metadataReserveBytes);
  const sourceTextBytes = passages.map(({ text }) => Buffer.byteLength(text, "utf8"));
  const completeSetFits = sourceTextBytes.reduce((total, bytes) => total + bytes, 0) <=
    excerptBudgetBytes;
  const perPassageBytes = Math.max(1, Math.floor(excerptBudgetBytes / passages.length));
  const sourceAliasByArtifact = primarySourceAliasesByArtifact(aliases);
  return passages.map(({ text, ...passage }, index) => {
    const includedText = completeSetFits ? text : truncateUtf8(text, perPassageBytes);
    const includedTextBytes = Buffer.byteLength(includedText, "utf8");
    const passageSourceTextBytes = sourceTextBytes[index]!;
    const sourceAlias = passage.sourceArtifactId
      ? sourceAliasByArtifact.get(passage.sourceArtifactId)
      : undefined;
    if (passage.sourceArtifactId && !sourceAlias) {
      throw new Error("knowledge_evidence_source_alias_unavailable");
    }
    return {
      ...passage,
      handle: `K${evidenceOffset + index + 1}`,
      includedText,
      includedTextBytes,
      ...(sourceAlias ? { sourceAlias } : {}),
      sourceTextBytes: passageSourceTextBytes,
      textTruncated: includedTextBytes < passageSourceTextBytes
    };
  });
}

function primarySourceAliasesByArtifact(
  aliases: readonly KnowledgeScopeAlias[]
): ReadonlyMap<string, string> {
  const selected = new Map<string, KnowledgeScopeAlias>();
  for (const alias of aliases) {
    if (alias.kind !== "source" || !alias.sourceArtifactId) continue;
    const current = selected.get(alias.sourceArtifactId);
    if (!current || alias.bindingOrdinal < current.bindingOrdinal ||
      (alias.bindingOrdinal === current.bindingOrdinal && alias.alias < current.alias)) {
      selected.set(alias.sourceArtifactId, alias);
    }
  }
  return new Map([...selected].map(([artifactId, alias]) => [artifactId, alias.alias]));
}

function fallbackBudgetUsage(
  invocationOrdinal: number,
  operation: KnowledgeOperationKind
): KnowledgeBudgetUsage {
  return {
    cumulativeCandidates: 0,
    estimatedCostMicros: 0,
    followUpOperations: operation === "automatic_search" ? 0 : invocationOrdinal,
    latencyMs: 0,
    lowNoveltyStreak: 0,
    operations: invocationOrdinal,
    queryEmbeddingCalls: 0,
    rerankerCalls: 0,
    retrievedTokens: 0,
    searchPhases: 1,
    // The ordinal alone cannot reconstruct per-phase fan-out. The fallback
    // enforces the operation ceiling; the Prisma store supplies the complete
    // persisted multidimensional usage for every production execution.
    subqueriesInCurrentPhase: 1
  };
}

async function loadBudgetState(input: Readonly<{
  call: ModelToolCall;
  modelRunToolCallId: string;
  operation: KnowledgeOperationKind;
  runId: string;
  store: KnowledgeRetrievalStore;
  userId: string;
}>): Promise<KnowledgeBudgetState | null> {
  if (input.store.budgetState) {
    return input.store.budgetState({
      modelRunToolCallId: input.modelRunToolCallId,
      operation: input.operation,
      runId: input.runId,
      userId: input.userId
    });
  }
  const invocationOrdinal = await input.store.invocationOrdinal({
    modelRunToolCallId: input.modelRunToolCallId,
    runId: input.runId,
    toolName: input.call.name,
    userId: input.userId
  });
  if (invocationOrdinal === null) return null;
  const usage = fallbackBudgetUsage(invocationOrdinal, input.operation);
  return {
    evidenceCount: (invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
    invocationOrdinal,
    policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    priorContentHashes: [],
    stopReason: knowledgeBudgetStopReason(DEFAULT_KNOWLEDGE_BUDGET_POLICY, usage),
    usage
  };
}

function aliasFilter(
  requested: readonly string[],
  aliases: readonly KnowledgeScopeAlias[],
  operation: KnowledgeOperationKind
): Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }> | null {
  if (requested.length === 0) return {};
  const byAlias = new Map(aliases.map((alias) => [alias.alias, alias]));
  const resolved = requested.map((alias) => byAlias.get(alias));
  if (resolved.some((alias) => !alias)) return null;
  const kinds = new Set(resolved.map((alias) => alias!.kind));
  if (kinds.size !== 1) return null;
  const primaryBindingOrdinals = [...new Set(resolved.map((alias) => alias!.bindingOrdinal))].sort(
    (left, right) => left - right
  );
  if (kinds.has("base")) {
    const exactSourceIds = resolved.flatMap((alias) => alias!.sourceIds ?? []);
    return {
      bindingOrdinals: primaryBindingOrdinals,
      ...(exactSourceIds.length > 0
        ? { sourceIds: [...new Set(exactSourceIds)].sort() }
        : {})
    };
  }
  const exactBindingOrdinals = resolved.flatMap((alias) =>
    alias!.bindingOrdinals ?? [alias!.bindingOrdinal]);
  if (exactBindingOrdinals.some((ordinal) =>
    !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= KNOWLEDGE_SCOPE_MAX_BINDINGS)) {
    return null;
  }
  const bindingOrdinals = [...new Set(exactBindingOrdinals)].sort((left, right) => left - right);
  const sourceIds = resolved.map((alias) => alias!.sourceId);
  if (resolved.some((alias) => !alias!.sourceArtifactId || !alias!.sourceVersionId) ||
    sourceIds.some((sourceId) => !sourceId)) return null;
  return {
    bindingOrdinals: operation === "read_source" ? primaryBindingOrdinals : bindingOrdinals,
    sourceIds: [...new Set(sourceIds as string[])]
  };
}

function targetRestrictedFilter(input: Readonly<{
  aliases: readonly KnowledgeScopeAlias[];
  bindings: readonly KnowledgeAcceptedBinding[];
  filter: Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }>;
  request: NonNullable<ReturnType<typeof parseKnowledgeSemanticToolRequest>>;
}>): Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }> | null {
  const requested = input.request.targetSourceIds;
  if (requested.length === 0) return input.filter;
  const admittedBindings = new Set(input.bindings.map((binding) => binding.ordinal));
  const filteredBindings = input.filter.bindingOrdinals
    ? new Set(input.filter.bindingOrdinals)
    : admittedBindings;
  const filteredSources = input.filter.sourceIds ? new Set(input.filter.sourceIds) : null;
  const bySourceId = new Map<string, KnowledgeScopeAlias[]>();
  for (const alias of input.aliases) {
    if (alias.kind !== "source" || !alias.sourceId || !alias.sourceArtifactId ||
      !alias.sourceVersionId || filteredSources && !filteredSources.has(alias.sourceId)) continue;
    const ordinals = alias.bindingOrdinals ?? [alias.bindingOrdinal];
    if (!ordinals.some((ordinal) =>
      admittedBindings.has(ordinal) && filteredBindings.has(ordinal))) continue;
    const selected = bySourceId.get(alias.sourceId);
    if (selected) selected.push(alias);
    else bySourceId.set(alias.sourceId, [alias]);
  }
  if (requested.some((sourceId) => !bySourceId.has(sourceId))) return null;
  const bindingOrdinals = [...new Set(requested.flatMap((sourceId) =>
    bySourceId.get(sourceId)!.flatMap((alias) =>
      (alias.bindingOrdinals ?? [alias.bindingOrdinal]).filter((ordinal) =>
        admittedBindings.has(ordinal) && filteredBindings.has(ordinal)))))].sort(
    (left, right) => left - right
  );
  if (bindingOrdinals.length === 0) return null;
  return Object.freeze({
    bindingOrdinals: Object.freeze(bindingOrdinals),
    sourceIds: Object.freeze([...requested].sort())
  });
}

function explicitAnalysisPassageMatchesTarget(input: Readonly<{
  aliases: readonly KnowledgeScopeAlias[];
  bindings: readonly KnowledgeAcceptedBinding[];
  passage: KnowledgeHybridSearchResult["passages"][number];
  targetSourceIds: readonly string[];
}>): boolean {
  if (!input.passage.sourceArtifactId ||
    !input.targetSourceIds.includes(input.passage.documentId)) return false;
  const binding = input.bindings.find((candidate) =>
    candidate.ordinal === input.passage.bindingOrdinal);
  if (!binding || binding.knowledgeBaseId !== input.passage.knowledgeBaseId) return false;
  return input.aliases.some((alias) => alias.kind === "source" &&
    alias.sourceId === input.passage.documentId &&
    alias.sourceArtifactId === input.passage.sourceArtifactId &&
    alias.sourceVersionId === input.passage.documentVersionId &&
    (alias.bindingOrdinals ?? [alias.bindingOrdinal]).includes(input.passage.bindingOrdinal));
}

type ActiveStoredKnowledgeBudgetReservation = Extract<
  StoredKnowledgeBudgetReservation,
  { purgedAt: null }
>;

type ReservedKnowledgeExecutionBudget = Readonly<{
  budgetState: KnowledgeBudgetState;
  leaseToken: string;
  record: ActiveStoredKnowledgeBudgetReservation;
}>;

function originalQuerySha256(context: ToolExecutionContext): string {
  const messages = context.request.context?.messages ?? [];
  const original = [...messages].reverse().find((message) =>
    message.role === "user" && message.purpose !== "knowledge_evidence");
  return createHash("sha256")
    .update(canonicalJson(original?.content ?? context.request.context ?? context.request))
    .digest("hex");
}

function operationRequestInput(input: Readonly<{
  aliases: readonly KnowledgeScopeAlias[];
  bindings: readonly KnowledgeAcceptedBinding[];
  filter: Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }>;
  request: ReturnType<typeof parseKnowledgeSemanticToolRequest> & {};
}>): KnowledgeBudgetOperationRequestInput | null {
  const profileRevisionIds = [...new Set(input.bindings.map((binding) =>
    binding.profileRevisionId).filter((value): value is string => Boolean(value)))];
  if (profileRevisionIds.length !== 1 ||
    input.bindings.some((binding) => binding.profileRevisionId !== profileRevisionIds[0])) {
    return null;
  }
  const admittedOrdinals = new Set(input.bindings.map((binding) => binding.ordinal));
  const filteredSourceIds = input.filter.sourceIds
    ? new Set(input.filter.sourceIds)
    : null;
  const resolvedSourceIds = [...new Set(input.aliases.flatMap((alias) => {
    if (alias.kind !== "source" || !alias.sourceId ||
      !(alias.bindingOrdinals ?? [alias.bindingOrdinal]).some((ordinal) =>
        admittedOrdinals.has(ordinal)) ||
      filteredSourceIds && !filteredSourceIds.has(alias.sourceId)) return [];
    return [alias.sourceId];
  }))].sort();
  if (resolvedSourceIds.length < 1) return null;
  const semantic = input.request.operation === "automatic_search" ||
    input.request.operation === "search_knowledge"
    ? input.request.search
    : input.request.operation === "find_exact" ||
        input.request.operation === "discover_sources" ||
        input.request.operation === "structured_analysis" ||
        input.request.operation === "visual_analysis"
      ? input.request.semantic
      : null;
  const plan: KnowledgeOperationPlanProjectionV2 | null = semantic
    ? Object.freeze({
        allowedLanes: semantic.allowedLanes,
        coverage: semantic.coverage,
        exactTerms: semantic.exactTerms,
        rewrittenQuery: semantic.rewrittenQuery,
        strategy: semantic.strategy,
        targetNames: semantic.targetNames,
        targetSourceIds: semantic.targetSourceIds
      })
    : null;
  const common = Object.freeze({
    operation: input.request.operation,
    plannerVersion: semantic?.plannerVersion ?? 2,
    profileRevisionId: profileRevisionIds[0]!,
    purpose: (semantic
      ? semantic.purpose
      : input.request.operation === "discover_sources"
        ? "source_discovery"
        : "follow_up") as KnowledgeOperationPurpose,
    resolvedSourceIds,
    sourceAliases: [...input.request.sourceAliases]
  });
  switch (input.request.operation) {
    case "automatic_search":
    case "search_knowledge":
      return Object.freeze({
        ...common,
        operation: input.request.operation,
        search: plan!
      });
    case "find_exact":
      return Object.freeze({
        ...common,
        exact: input.request.exact,
        operation: "find_exact" as const,
        plan: plan!
      });
    case "read_source": {
      const { sourceAlias: _sourceAlias, ...read } = input.request.read;
      return Object.freeze({
        ...common,
        operation: "read_source" as const,
        read: Object.freeze(read)
      });
    }
    case "discover_sources":
      return Object.freeze({
        ...common,
        discovery: input.request.discovery,
        operation: "discover_sources" as const,
        plan: plan!
      });
    case "structured_analysis":
      return Object.freeze({
        ...common,
        operation: "structured_analysis" as const,
        plan: plan!,
        structured: input.request.structured
      });
    case "visual_analysis":
      return Object.freeze({
        ...common,
        operation: "visual_analysis" as const,
        plan: plan!,
        visual: input.request.visual
      });
  }
}

function reservationPriorBudgetState(
  legacy: KnowledgeBudgetState,
  record: ActiveStoredKnowledgeBudgetReservation,
  chargeAfter: Readonly<{
    candidateCount: number;
    costMicros: number;
    followUpOperationSlots: number;
    latencyMs: number;
    operationSlots: number;
    queryEmbeddingCalls: number;
    rerankerCalls: number;
    retrievedTokens: number;
    searchPhaseSlots: number;
    subquerySlots: number;
  }>
): KnowledgeBudgetState {
  const estimate = record.reservation.estimate;
  const prior = <K extends keyof typeof chargeAfter>(key: K): number =>
    Math.max(0, chargeAfter[key] - estimate[key]);
  return Object.freeze({
    ...legacy,
    invocationOrdinal: record.reservation.operationOrdinal,
    stopReason: null,
    usage: {
      cumulativeCandidates: prior("candidateCount"),
      estimatedCostMicros: prior("costMicros"),
      followUpOperations: prior("followUpOperationSlots"),
      latencyMs: prior("latencyMs"),
      lowNoveltyStreak: legacy.usage.lowNoveltyStreak,
      operations: prior("operationSlots"),
      queryEmbeddingCalls: prior("queryEmbeddingCalls"),
      rerankerCalls: prior("rerankerCalls"),
      retrievedTokens: prior("retrievedTokens"),
      searchPhases: prior("searchPhaseSlots"),
      subqueriesInCurrentPhase: prior("subquerySlots")
    }
  });
}

function operationActualUsage(
  evidence: KnowledgeRetrievalEvidence,
  policy: KnowledgeBudgetPolicy
): KnowledgeBudgetResourceActual {
  const embeddingTokens = evidence.embeddingExecutions.reduce((total, execution) =>
    total + (execution.status === "complete" ? execution.totalTokens : 0), 0);
  return Object.freeze({
    candidateCount: evidence.candidateCount,
    costMicros: estimatedKnowledgeEmbeddingCostMicros(policy, embeddingTokens),
    latencyMs: evidence.durationMs,
    queryEmbeddingCalls: evidence.embeddingExecutions.length,
    repairCalls: 0,
    rerankerCalls: evidence.rerankerBinding === null ? 0 : 1,
    retrievedTokens: Math.ceil(evidence.results.reduce((total, result) =>
      total + result.includedTextBytes, 0) / 4),
    validationCalls: 0
  });
}

function evidenceAliases(
  aliases: readonly KnowledgeScopeAlias[],
  passages: readonly KnowledgeRetrievedPassageEvidence[],
  bindings: readonly KnowledgeAcceptedBinding[],
  requiredSourceArtifactIds: readonly string[] = []
): readonly Readonly<{ alias: string; kind: "base" | "source"; label: string }>[] {
  const sourceArtifacts = new Set([
    ...requiredSourceArtifactIds,
    ...passages.flatMap((passage) => passage.sourceArtifactId ? [passage.sourceArtifactId] : [])
  ]);
  const bindingOrdinals = new Set(passages.map((passage) => passage.bindingOrdinal));
  const primarySourceAliases = primarySourceAliasesByArtifact(aliases);
  const selected = aliases.filter((alias) => alias.kind === "source"
    ? Boolean(alias.sourceArtifactId &&
      sourceArtifacts.has(alias.sourceArtifactId) &&
      primarySourceAliases.get(alias.sourceArtifactId) === alias.alias)
    : bindingOrdinals.has(alias.bindingOrdinal));
  if (selected.length === 0) {
    const admitted = new Set(bindings.map((binding) => binding.ordinal));
    selected.push(...aliases.filter((alias) =>
      alias.kind === "base" && admitted.has(alias.bindingOrdinal)));
  }
  return selected.slice(0, 256).map(({ alias, kind, label }) => ({ alias, kind, label }));
}

function admittedSourceArtifactIds(input: Readonly<{
  aliases: readonly KnowledgeScopeAlias[];
  bindings: readonly KnowledgeAcceptedBinding[];
  sourceIds?: readonly string[];
}>): readonly string[] {
  const admittedOrdinals = new Set(input.bindings.map((binding) => binding.ordinal));
  const admittedSourceIds = input.sourceIds ? new Set(input.sourceIds) : null;
  return [...new Set(input.aliases.flatMap((alias) =>
    alias.kind === "source" && alias.sourceArtifactId && alias.sourceId &&
    admittedOrdinals.has(alias.bindingOrdinal) &&
    (!admittedSourceIds || admittedSourceIds.has(alias.sourceId))
      ? [alias.sourceArtifactId]
      : []))];
}

function validDedicatedCandidateCounts(input: Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  scopedBindings: readonly KnowledgeAcceptedBinding[];
}>): boolean {
  if (input.bindingCount !== input.scopedBindings.length ||
    !Number.isSafeInteger(input.candidateCount) || input.candidateCount < 0) return false;
  const ordinals = new Set(input.scopedBindings.map((binding) => binding.ordinal));
  const entries = Object.entries(input.candidateCounts);
  if (entries.some(([rawOrdinal, count]) => {
    const ordinal = Number(rawOrdinal);
    return !Number.isSafeInteger(ordinal) || String(ordinal) !== rawOrdinal ||
      !ordinals.has(ordinal) || !Number.isSafeInteger(count) || count < 0;
  })) return false;
  return entries.reduce((total, [, count]) => total + count, 0) === input.candidateCount;
}

function completedBudgetUsage(input: Readonly<{
  candidateCount: number;
  durationMs: number;
  embeddingExecutions: readonly KnowledgeEmbeddingExecutionEvidence[];
  noveltyRatio: number | null;
  policy: KnowledgeBudgetPolicy;
  rerankerCalled: boolean;
  resultBytes: number;
  usage: KnowledgeBudgetUsage;
}>): KnowledgeBudgetUsage {
  const embeddingTokens = input.embeddingExecutions.reduce((total, execution) =>
    total + (execution.status === "complete" ? execution.totalTokens : 0), 0);
  return {
    cumulativeCandidates: input.usage.cumulativeCandidates + input.candidateCount,
    estimatedCostMicros: input.usage.estimatedCostMicros +
      estimatedKnowledgeEmbeddingCostMicros(input.policy, embeddingTokens),
    followUpOperations: input.usage.followUpOperations,
    latencyMs: input.usage.latencyMs + input.durationMs,
    lowNoveltyStreak: input.noveltyRatio === null ||
      input.noveltyRatio >= input.policy.minNoveltyRatio
      ? 0
      : input.usage.lowNoveltyStreak + 1,
    operations: input.usage.operations,
    queryEmbeddingCalls: input.usage.queryEmbeddingCalls + input.embeddingExecutions.length,
    rerankerCalls: input.usage.rerankerCalls + (input.rerankerCalled ? 1 : 0),
    retrievedTokens: input.usage.retrievedTokens + Math.ceil(input.resultBytes / 4),
    searchPhases: input.usage.searchPhases,
    subqueriesInCurrentPhase: input.usage.subqueriesInCurrentPhase
  };
}

function finalizedEvidence(input: Omit<KnowledgeRetrievalEvidence, "providerText">): KnowledgeRetrievalEvidence {
  const draft: KnowledgeRetrievalEvidence = { ...input, providerText: "pending" };
  const evidence = { ...draft, providerText: knowledgeToolResultText(draft) };
  if (Buffer.byteLength(evidence.providerText, "utf8") > KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES) {
    throw new Error("knowledge_provider_text_budget_exceeded");
  }
  return evidence;
}

async function loadKnowledgeStrategyDispatchLineagePages(input: Readonly<{
  currentPage: KnowledgeStrategyPassagePage;
  currentReceipt: KnowledgeStrategyStepReceiptV1;
  currentRequest: NonNullable<KnowledgeStrategyStepClaim["step"]["request"]>;
  execution: StoredKnowledgeStrategyExecution;
  runId: string;
  store: KnowledgeRetrievalStore;
  userId: string;
}>): Promise<Readonly<{
  pages: readonly KnowledgeStrategyPassagePage[];
  receipts: readonly KnowledgeStrategyStepReceiptV1[];
  requests: readonly NonNullable<KnowledgeStrategyStepClaim["step"]["request"]>[];
}>> {
  const frozen = input.execution.execution;
  const loadPage = input.store.loadStrategyPassagePage;
  if (!frozen || !loadPage ||
    (frozen.strategy !== "full_context" && frozen.strategy !== "exhaustive")) {
    throw new Error("knowledge_strategy_page_store_unavailable");
  }
  const requests = input.execution.steps.flatMap(({ request }) => request ? [request] : [])
    .sort((left, right) => left.ordinal - right.ordinal || left.stepId.localeCompare(right.stepId));
  const receipts = input.execution.steps.flatMap((step) => {
    if (step.lifecycle.stepId === input.currentRequest.stepId) return [input.currentReceipt];
    return step.lifecycle.state === "settled" && step.receipt ? [step.receipt] : [];
  }).sort((left, right) => left.stepId.localeCompare(right.stepId));
  const receiptsByStepId = new Map(receipts.map((receipt) => [receipt.stepId, receipt]));
  const sourcesByBindingId = new Map(frozen.sourceSet.map((source) => [source.bindingId, source]));
  const pages: KnowledgeStrategyPassagePage[] = [];
  for (const request of requests) {
    const receipt = receiptsByStepId.get(request.stepId);
    if (!receipt) continue;
    if (request.stepId === input.currentRequest.stepId) {
      pages.push(input.currentPage);
      continue;
    }
    const source = request.sourceBindingId === null
      ? undefined
      : sourcesByBindingId.get(request.sourceBindingId);
    if (!source || !Number.isSafeInteger(receipt.processedItemCount) ||
      receipt.processedItemCount < 0 || receipt.processedItemCount > 256) {
      continue;
    }
    pages.push(await loadPage({
      cursor: request.cursor,
      executionId: request.executionId,
      limit: Math.max(1, receipt.processedItemCount),
      runId: input.runId,
      source,
      streamId: request.streamId,
      userId: input.userId
    }));
  }
  return Object.freeze({
    pages: Object.freeze(pages),
    receipts: Object.freeze(receipts),
    requests: Object.freeze(requests)
  });
}

function mapSummarySupports(
  output: KnowledgeStrategyMapOutputV2
): readonly KnowledgeStrategyMapSupportingPassageV2[] {
  const byPassageId = new Map<string, KnowledgeStrategyMapSupportingPassageV2>();
  for (const summary of output.summaries) {
    for (const support of summary.supportingPassages) {
      const current = byPassageId.get(support.passageId);
      if (current && (current.contentHash !== support.contentHash ||
        current.passageOrdinal !== support.passageOrdinal ||
        current.sectionHash !== support.sectionHash)) {
        throw new Error("knowledge_strategy_summary_support_conflict");
      }
      byPassageId.set(support.passageId, support);
    }
  }
  return Object.freeze([...byPassageId.values()].sort((left, right) =>
    left.passageOrdinal - right.passageOrdinal));
}

/**
 * Rehydrates only the exact immutable map pages that contain selected citation
 * supports. It never replays the old first-N raw corpus dispatch path.
 */
async function loadKnowledgeStrategySummarySupportPassages(input: Readonly<{
  execution: StoredKnowledgeStrategyExecution;
  outputs: readonly KnowledgeStrategyMapOutputV2[];
  runId: string;
  store: KnowledgeRetrievalStore;
  userId: string;
}>): Promise<readonly KnowledgeStrategyPassagePage["passages"][number][]> {
  const frozen = input.execution.execution;
  const loadPage = input.store.loadStrategyPassagePage;
  if (!frozen || frozen.strategy !== "corpus_summary" || !loadPage ||
    input.outputs.length !== frozen.sourceSet.length ||
    input.outputs.some((output, ordinal) => output.sourceOrdinal !== ordinal ||
      output.sourceBindingId !== frozen.sourceSet[ordinal]?.bindingId)) {
    throw new Error("knowledge_strategy_summary_output_set_invalid");
  }
  const supports = input.outputs.flatMap((output) => mapSummarySupports(output).map((support) =>
    Object.freeze({ output, support })));
  if (supports.length < 1 || supports.length > 100) {
    throw new Error("knowledge_strategy_summary_support_limit_exceeded");
  }
  const passagesByIdentity = new Map<string, KnowledgeStrategyPassagePage["passages"][number]>();
  for (const output of input.outputs) {
    const source = frozen.sourceSet[output.sourceOrdinal]!;
    const sourceSupports = mapSummarySupports(output);
    const mapSteps = input.execution.steps.filter((step) =>
      step.request?.kind === "corpus_summary_map" &&
      step.request.sourceBindingId === source.bindingId).sort((left, right) =>
      left.request!.pageOrdinal - right.request!.pageOrdinal);
    if (mapSteps.length < 1 || mapSteps.some((step, pageOrdinal) =>
      step.lifecycle.state !== "settled" || !step.request || !step.receipt ||
      step.receipt.status !== "succeeded" || step.request.pageOrdinal !== pageOrdinal)) {
      throw new Error("knowledge_strategy_summary_map_chain_invalid");
    }
    const stepsBySupport = new Map<string, {
      step: (typeof mapSteps)[number];
      supports: KnowledgeStrategyMapSupportingPassageV2[];
    }>();
    for (const support of sourceSupports) {
      const step = mapSteps.find(({ request, receipt }) => {
        const start = request?.cursor?.nextPassageOrdinal ?? 0;
        return Boolean(request && receipt && support.passageOrdinal >= start &&
          support.passageOrdinal < start + receipt.processedItemCount);
      });
      if (!step) throw new Error("knowledge_strategy_summary_support_page_missing");
      const selected = stepsBySupport.get(step.lifecycle.stepId);
      if (selected) selected.supports.push(support);
      else stepsBySupport.set(step.lifecycle.stepId, { step, supports: [support] });
    }
    for (const { step, supports: pageSupports } of stepsBySupport.values()) {
      const request = step.request!;
      const storedReceipt = step.receipt!;
      const page = await loadPage({
        cursor: request.cursor,
        executionId: request.executionId,
        limit: KNOWLEDGE_STRATEGY_PAGE_SIZE,
        runId: input.runId,
        source,
        streamId: request.streamId,
        userId: input.userId
      });
      const replayedReceipt = knowledgeStrategyPassageStepReceiptV1(request, page);
      if (hashKnowledgeStrategyStepReceiptV1(replayedReceipt) !==
        hashKnowledgeStrategyStepReceiptV1(storedReceipt)) {
        throw new Error("knowledge_strategy_summary_page_receipt_mismatch");
      }
      for (const support of pageSupports) {
        const passage = page.passages.find((candidate) =>
          candidate.chunkId === support.passageId &&
          candidate.chunkIndex === support.passageOrdinal &&
          candidate.contentHash === support.contentHash &&
          candidate.sourceArtifactId === support.sourceArtifactId &&
          candidate.documentId === support.sourceId &&
          candidate.documentVersionId === support.sourceVersionId);
        if (!passage || Buffer.byteLength(passage.text, "utf8") > 64 * 1024) {
          throw new Error("knowledge_strategy_summary_support_passage_mismatch");
        }
        passagesByIdentity.set(`${output.sourceBindingId}\u0000${support.passageId}`, passage);
      }
    }
  }
  const passages = supports.map(({ output, support }) =>
    passagesByIdentity.get(`${output.sourceBindingId}\u0000${support.passageId}`));
  if (passages.some((passage) => !passage) || passagesByIdentity.size !== supports.length) {
    throw new Error("knowledge_strategy_summary_support_set_mismatch");
  }
  return Object.freeze(passages as KnowledgeStrategyPassagePage["passages"][number][]);
}

function bindingGroups(bindings: readonly KnowledgeAcceptedBinding[]): Array<{
  bindings: KnowledgeAcceptedBinding[];
  snapshot: ReturnType<typeof normalizeProviderExecutionSnapshot>;
}> {
  const groups = new Map<string, {
    bindings: KnowledgeAcceptedBinding[];
    snapshot: ReturnType<typeof normalizeProviderExecutionSnapshot>;
  }>();
  for (const binding of bindings) {
    const snapshot = normalizeProviderExecutionSnapshot(binding.embeddingExecutionSnapshot);
    const pin = snapshot.model.adapterKind === "fake" ? null : createKnowledgeVectorSpacePin({
      configuration: snapshot.model,
      deploymentId: binding.embeddingProviderModelId
    });
    if (
      snapshot.connectionId !== binding.embeddingConnectionId ||
      snapshot.credentialId !== binding.embeddingCredentialId ||
      snapshot.credentialVersionId !== binding.embeddingCredentialVersionId ||
      snapshot.providerModelId !== binding.embeddingProviderModelId ||
      !pin?.indexSupported || pin.fingerprint !== binding.vectorSpaceFingerprint ||
      pin.targetDimension !== binding.targetDimension
    ) throw new Error("knowledge_embedding_binding_invalid");
    const key = `${binding.vectorSpaceFingerprint}\u0000${canonicalJson(snapshot)}`;
    const group = groups.get(key);
    if (group) group.bindings.push(binding);
    else groups.set(key, { bindings: [binding], snapshot });
  }
  return [...groups.values()];
}

function validBindings(bindings: readonly KnowledgeAcceptedBinding[]): boolean {
  return bindings.length >= 1 && bindings.length <= KNOWLEDGE_SCOPE_MAX_BINDINGS &&
    bindings.every((binding, index) =>
    binding.ordinal === index && binding.baseContentRevision >= 0 &&
    binding.indexedContentRevision >= 0 &&
    typeof binding.knowledgeBaseSnapshotId === "string" &&
    binding.knowledgeBaseSnapshotId.length > 0 &&
    typeof binding.includeWholeBase === "boolean" &&
    Array.isArray(binding.selectedSourceIds) &&
    (binding.includeWholeBase
      ? binding.selectedSourceIds.length === 0
      : binding.selectedSourceIds.length > 0) &&
    new Set(binding.selectedSourceIds).size === binding.selectedSourceIds.length &&
    (binding.targetDimension === 1024 || binding.targetDimension === 1536) &&
    /^[0-9a-f]{64}$/u.test(binding.vectorSpaceFingerprint));
}

export function createKnowledgeToolExecutor(input: Readonly<{
  budgetReservations?: KnowledgeBudgetReservationRepository;
  candidateLimit?: number;
  embeddingRuntime: KnowledgeEmbeddingRuntimeResolver;
  policy?: KnowledgeRetrievalPolicyResolver;
  resultLimit?: number;
  scoreThreshold?: number;
  store: KnowledgeRetrievalStore;
  strategies?: PrismaKnowledgeStrategyRepository;
}>): KnowledgeToolExecutor {
  const staticPolicy = {
    candidateLimit: input.candidateLimit ?? KNOWLEDGE_CANDIDATE_LIMIT,
    resultLimit: input.resultLimit ?? KNOWLEDGE_RESULT_LIMIT,
    scoreThreshold: input.scoreThreshold ?? KNOWLEDGE_SCORE_THRESHOLD
  };
  if (!isKnowledgeRetrievalPolicy(staticPolicy)) {
    throw new Error("knowledge_retrieval_configuration_invalid");
  }

  const acceptedToolNames = new Set<string>(KNOWLEDGE_EXECUTION_TOOL_NAMES);
  const reserveAtomicBudget = async (reservationInput: Readonly<{
    aliases: readonly KnowledgeScopeAlias[];
    bindings: readonly KnowledgeAcceptedBinding[];
    budgetState: KnowledgeBudgetState;
    call: ModelToolCall;
    context: ToolExecutionContext;
    filter: Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }>;
    modelRunToolCallId: string;
    request: NonNullable<ReturnType<typeof parseKnowledgeSemanticToolRequest>>;
    runId: string;
    userId: string;
  }>): Promise<
    | Readonly<{ budget: ReservedKnowledgeExecutionBudget | null; kind: "admitted" }>
    | Readonly<{ kind: "rejected"; result: ToolExecutionResult }>
  > => {
    if (!input.budgetReservations) {
      return { budget: null, kind: "admitted" };
    }
    const operationRequest = operationRequestInput({
      aliases: reservationInput.aliases,
      bindings: reservationInput.bindings,
      filter: reservationInput.filter,
      request: reservationInput.request
    });
    if (!operationRequest) {
      return {
        kind: "rejected",
        result: errorResult(reservationInput.call, "knowledge_operation_request_invalid")
      };
    }
    const usesSemanticRetrieval = reservationInput.request.operation === "automatic_search" ||
      reservationInput.request.operation === "search_knowledge";
    const purposeLimit = reservationInput.request.operation === "find_exact"
      ? reservationInput.request.exact.limit
      : reservationInput.request.operation === "discover_sources"
        ? reservationInput.request.discovery.limit
        : null;
    const strategyCandidateLimit = (reservationInput.request.operation === "automatic_search" ||
      reservationInput.request.operation === "search_knowledge") &&
      (reservationInput.request.search.strategy === "exhaustive" ||
        reservationInput.request.search.strategy === "corpus_summary")
      ? 100
      : null;
    const reservedCandidateLimit = purposeLimit ?? strategyCandidateLimit ?? staticPolicy.candidateLimit;
    const result = await input.budgetReservations.reserve({
      estimate: {
        candidateCount: reservedCandidateLimit,
        costMicros: 0,
        latencyMs: 1_000,
        queryEmbeddingCalls: usesSemanticRetrieval ? 1 : 0,
        repairCalls: 0,
        rerankerCalls: usesSemanticRetrieval ? 1 : 0,
        retrievedTokens: (purposeLimit ?? strategyCandidateLimit ?? staticPolicy.resultLimit) * 512,
        validationCalls: 0
      },
      idempotencyKey: `knowledge-operation:${reservationInput.modelRunToolCallId}`,
      modelRunToolCallId: reservationInput.modelRunToolCallId,
      operationRequest,
      originalQuerySha256: originalQuerySha256(reservationInput.context),
      runId: reservationInput.runId,
      userId: reservationInput.userId
    });
    if (result.kind === "rejected") {
      return {
        kind: "rejected",
        result: budgetRejectionResult(reservationInput.call, result.reason)
      };
    }
    if (result.kind !== "admitted" && result.kind !== "idempotent") {
      return {
        kind: "rejected",
        result: errorResult(reservationInput.call, "knowledge_budget_reservation_unavailable")
      };
    }
    const record = result.record;
    if (record.purgedAt !== null || record.reservation.state !== "reserved" ||
      !record.leaseToken) {
      return {
        kind: "rejected",
        result: errorResult(reservationInput.call, "knowledge_operation_replay_unavailable")
      };
    }
    return {
      budget: {
        budgetState: reservationPriorBudgetState(
          reservationInput.budgetState,
          record,
          result.chargeAfter
        ),
        leaseToken: record.leaseToken,
        record
      },
      kind: "admitted"
    };
  };
  const preflight = async (
    call: ModelToolCall,
    context: ToolExecutionContext
  ): Promise<KnowledgeExecutionAdmission> => {
    const request = parseKnowledgeSemanticToolRequest(call);
    if (!request) {
      return { kind: "rejected", result: errorResult(call, "knowledge_tool_arguments_invalid") };
    }
    const runId = context.runId;
    const modelRunToolCallId = context.persistedToolCallId;
    const userId = context.userId;
    if (!runId || !modelRunToolCallId || !userId) {
      return { kind: "rejected", result: errorResult(call, "knowledge_run_context_unavailable") };
    }
    const replay = input.store.loadReceipt
      ? await input.store.loadReceipt({ modelRunToolCallId, runId, userId })
      : null;
    if (replay) return { kind: "replayed", result: completedResult(call, replay) };
    const budgetState = await loadBudgetState({
      call,
      modelRunToolCallId,
      operation: request.operation,
      runId,
      store: input.store,
      userId
    });
    if (!budgetState || budgetState.invocationOrdinal < 1 ||
      budgetState.invocationOrdinal > 256) {
      return { kind: "rejected", result: errorResult(call, "knowledge_run_context_unavailable") };
    }
    if (budgetState.stopReason) {
      return { kind: "rejected", result: budgetRejectionResult(call, budgetState.stopReason) };
    }
    if (!input.budgetReservations) return { kind: "admitted" };
    const bindings = await input.store.loadBindings({ runId, userId });
    if (!validBindings(bindings)) {
      return { kind: "rejected", result: errorResult(call, "knowledge_run_binding_unavailable") };
    }
    const aliases = input.store.loadScopeAliases
      ? await input.store.loadScopeAliases({ runId, userId })
      : [];
    const aliasScope = aliasFilter(request.sourceAliases, aliases, request.operation);
    const filter = aliasScope ? targetRestrictedFilter({
      aliases,
      bindings,
      filter: aliasScope,
      request
    }) : null;
    if (!filter) {
      return { kind: "rejected", result: errorResult(call, "knowledge_scope_alias_unavailable") };
    }
    const scopedBindings = filter.bindingOrdinals
      ? bindings.filter((binding) => filter.bindingOrdinals!.includes(binding.ordinal))
      : bindings;
    if (scopedBindings.length < 1) {
      return { kind: "rejected", result: errorResult(call, "knowledge_scope_alias_unavailable") };
    }
    const reservation = await reserveAtomicBudget({
      aliases,
      bindings: scopedBindings,
      budgetState,
      call,
      context,
      filter,
      modelRunToolCallId,
      request,
      runId,
      userId
    });
    return reservation.kind === "rejected"
      ? reservation
      : { kind: "admitted" };
  };
  return {
    accepts: (name) => acceptedToolNames.has(name),
    capability: "knowledge",
    ...(input.strategies && input.store.prepareStrategySession &&
      input.store.loadStrategySources
      ? {
          async prepareStrategy(strategyInput) {
            const session = await input.store.prepareStrategySession!({
              runId: strategyInput.runId,
              userId: strategyInput.userId
            });
            const sources = await input.store.loadStrategySources!({
              runId: strategyInput.runId,
              userId: strategyInput.userId
            });
            const executionId = `strategy-${createHash("sha256")
              .update(canonicalJson({
                modelRunId: strategyInput.runId,
                plannerVersion: strategyInput.plan.version,
                sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sources),
                strategy: strategyInput.plan.strategy
              }))
              .digest("hex")}`;
            const prepared = prepareKnowledgeStrategyExecutionV1({
              calls: strategyInput.calls,
              executionId,
              modelRunId: strategyInput.runId,
              pageSize: strategyInput.plan.strategy === "full_context"
                ? KNOWLEDGE_RESULT_LIMIT
                : strategyInput.plan.strategy === "exhaustive"
                  ? 100
                  : KNOWLEDGE_STRATEGY_PAGE_SIZE,
              plan: strategyInput.plan,
              sources
            });
            if (!prepared) return null;
            const stored = await input.strategies!.createExecution({
              dependencies: prepared.dependencies,
              execution: prepared.execution,
              retrievalSessionId: session.id,
              steps: prepared.steps.map(({ template }) => template),
              toolCallBindings: prepared.steps.flatMap(({ modelRunToolCallId, template }) =>
                modelRunToolCallId
                  ? [{ modelRunToolCallId, stepId: template.stepId }]
                  : [])
            });
            if (stored.execution.execution!.strategy === "corpus_summary" ||
              stored.execution.execution!.strategy === "exhaustive") {
              await drainKnowledgeStrategyInternalSteps({
                executionId: stored.execution.execution!.executionId,
                repository: input.strategies!,
                runId: strategyInput.runId,
                store: input.store,
                userId: strategyInput.userId
              });
            }
            return Object.freeze({
              executionId: stored.execution.execution!.executionId,
              strategy: stored.execution.execution!.strategy
            });
          },
          async drainStrategy(strategyInput) {
            await drainKnowledgeStrategyInternalSteps({
              executionId: strategyInput.executionId,
              repository: input.strategies!,
              runId: strategyInput.runId,
              store: input.store,
              userId: strategyInput.userId
            });
          },
          async finalizeStrategyCoverage(strategyInput) {
            const stored = await input.strategies!.loadExecution(strategyInput.executionId);
            if (!stored?.execution || stored.purgedAt) {
              throw new Error("knowledge_strategy_execution_unavailable");
            }
            const coverageRequest = knowledgeStrategyCoverageRequestForDispatchV1(
              stored,
              strategyInput.draft
            );
            const candidateReceipt = deriveKnowledgeStrategyCoverageReceiptV1(
              stored.execution,
              coverageRequest
            );
            const plannerStrategy = stored.execution.strategy === "multi_hop"
              ? "multi_pass" as const
              : stored.execution.strategy;
            if (strategyInput.requireVerified &&
              !knowledgeStrategyCoverageVerifiedForDispatch({
                coverage: candidateReceipt,
                dispatchManifestHash: strategyInput.draft.manifestHash,
                plannerStrategy
              })) {
              return Object.freeze({ kind: "requires_unverified" as const });
            }
            const finalized = await input.strategies!.finalizeExecution({
              at: new Date(),
              coverage: coverageRequest,
              executionId: strategyInput.executionId
            });
            const execution = finalized.execution.execution;
            const coverage = finalized.execution.coverage;
            if (!execution || !coverage) {
              throw new Error("knowledge_strategy_coverage_unavailable");
            }
            return Object.freeze({
              coverage,
              execution: Object.freeze({
                executionHash: hashKnowledgeStrategyExecutionRequestV1(execution),
                executionId: execution.executionId,
                sourceSetHash: execution.sourceSetHash
              }),
              kind: "finalized" as const
            });
          }
        }
      : {}),
    async execute(
      call: ModelToolCall,
      context: ToolExecutionContext,
      options?: { signal?: AbortSignal }
    ): Promise<ToolExecutionResult> {
      const request = parseKnowledgeSemanticToolRequest(call);
      if (!request) return errorResult(call, "knowledge_tool_arguments_invalid");
      const runId = context.runId;
      const modelRunToolCallId = context.persistedToolCallId;
      if (!runId || !modelRunToolCallId || !context.userId) {
        return errorResult(call, "knowledge_run_context_unavailable");
      }
      const replay = input.store.loadReceipt
        ? await input.store.loadReceipt({
            modelRunToolCallId,
            runId,
            userId: context.userId
          })
        : null;
      if (replay) return completedResult(call, replay);
      let budgetState = await loadBudgetState({
        call,
        modelRunToolCallId,
        operation: request.operation,
        runId,
        store: input.store,
        userId: context.userId
      });
      if (!budgetState || budgetState.invocationOrdinal < 1 ||
        budgetState.invocationOrdinal > 256) {
        return errorResult(call, "knowledge_run_context_unavailable");
      }
      if (budgetState.stopReason) {
        return budgetRejectionResult(call, budgetState.stopReason);
      }
      let retrievalPolicy = staticPolicy;
      if (input.policy) {
        try {
          const resolved = await input.policy.resolve();
          if (!isKnowledgeRetrievalPolicy(resolved)) throw new Error("knowledge_policy_unavailable");
          retrievalPolicy = resolved;
        } catch {
          return errorResult(call, "knowledge_policy_unavailable");
        }
      }
      const candidateLimit = Math.max(1, Math.min(
        retrievalPolicy.candidateLimit,
        budgetState.policy.maxCumulativeCandidates - budgetState.usage.cumulativeCandidates
      ));
      const resultLimit = retrievalPolicy.resultLimit;
      const threshold = retrievalPolicy.scoreThreshold;
      const startedAt = Date.now();
      const bindings = await input.store.loadBindings({ runId, userId: context.userId });
      if (!validBindings(bindings)) return errorResult(call, "knowledge_run_binding_unavailable");
      const aliases = input.store.loadScopeAliases
        ? await input.store.loadScopeAliases({ runId, userId: context.userId })
        : [];
      const aliasScope = aliasFilter(request.sourceAliases, aliases, request.operation);
      const filter = aliasScope ? targetRestrictedFilter({
        aliases,
        bindings,
        filter: aliasScope,
        request
      }) : null;
      if (!filter) return errorResult(call, "knowledge_scope_alias_unavailable");
      const scopedBindings = filter.bindingOrdinals
        ? bindings.filter((binding) => filter.bindingOrdinals!.includes(binding.ordinal))
        : bindings;
      if (scopedBindings.length < 1) {
        return errorResult(call, "knowledge_scope_alias_unavailable");
      }
      const reservationAdmission = await reserveAtomicBudget({
        aliases,
        bindings: scopedBindings,
        budgetState,
        call,
        context,
        filter,
        modelRunToolCallId,
        request,
        runId,
        userId: context.userId
      });
      if (reservationAdmission.kind === "rejected") return reservationAdmission.result;
      const activeReservation = reservationAdmission.budget;
      if (activeReservation) budgetState = activeReservation.budgetState;

      const readSourceAlias = request.operation === "read_source" && request.read
        ? aliases.find((alias) =>
            alias.alias === request.read!.sourceAlias && alias.kind === "source")
        : undefined;
      const readBinding = readSourceAlias
        ? scopedBindings.find((candidate) => candidate.ordinal === readSourceAlias.bindingOrdinal)
        : undefined;
      const readSource = input.store.readSource;
      if (request.operation === "read_source" &&
        (!request.read || !readSourceAlias?.sourceArtifactId || !readSourceAlias.sourceId ||
          !readSourceAlias.sourceVersionId || !readBinding || !readSource)) {
        if (activeReservation) {
          await input.budgetReservations!.release({
            leaseToken: activeReservation.leaseToken,
            reason: "source_location_unavailable",
            reservationId: activeReservation.record.reservation.id,
            runId,
            userId: context.userId
          }).catch(() => undefined);
        }
        return errorResult(call, "knowledge_source_location_unavailable");
      }
      if (options?.signal?.aborted) {
        if (activeReservation) {
          await input.budgetReservations!.release({
            leaseToken: activeReservation.leaseToken,
            reason: "operation_cancelled",
            reservationId: activeReservation.record.reservation.id,
            runId,
            userId: context.userId
          }).catch(() => undefined);
        }
        throwIfAborted(options.signal);
      }
      let strategyStepClaim: KnowledgeStrategyStepClaim | null = null;
      if (input.strategies) {
        const now = new Date();
        try {
          const claimed = await input.strategies.claimToolCallStep({
            leaseExpiresAt: new Date(now.valueOf() + 3_630_000),
            leaseToken: `strategy-tool:${randomUUID()}`,
            modelRunId: runId,
            modelRunToolCallId,
            now
          });
          if (claimed.kind === "none") {
            if (activeReservation) {
              await input.budgetReservations!.release({
                leaseToken: activeReservation.leaseToken,
                reason: "strategy_step_not_ready",
                reservationId: activeReservation.record.reservation.id,
                runId,
                userId: context.userId
              }).catch(() => undefined);
            }
            return errorResult(call, "knowledge_strategy_step_not_ready");
          }
          strategyStepClaim = claimed;
        } catch (error) {
          if (!(error instanceof KnowledgeStrategyRepositoryError) || error.code !== "not_found") {
            throw error;
          }
        }
      }
      if (strategyStepClaim?.step.request?.kind === "comparison_target") {
        const strategyRequest = strategyStepClaim.step.request;
        const execution = strategyStepClaim.execution.execution;
        const targetSource = execution?.sourceSet.find(({ bindingId }) =>
          bindingId === strategyRequest.sourceBindingId);
        const inputHash = createHash("sha256")
          .update(canonicalJson(["comparison_target", request.query]), "utf8")
          .digest("hex");
        if (!execution || execution.strategy !== "comparison" || !targetSource ||
          strategyRequest.targetOrdinal === null || strategyRequest.inputHash !== inputHash ||
          request.targetSourceIds.length !== 1 ||
          request.targetSourceIds[0] !== targetSource.sourceId ||
          filter.sourceIds?.length !== 1 || filter.sourceIds[0] !== targetSource.sourceId) {
          await input.strategies!.releaseStep({
            at: new Date(),
            executionId: strategyStepClaim.execution.execution?.executionId ??
              strategyRequest.executionId,
            leaseToken: strategyStepClaim.leaseToken,
            stateVersion: strategyStepClaim.step.lifecycle.stateVersion,
            stepId: strategyStepClaim.step.lifecycle.stepId
          }).catch(() => undefined);
          if (activeReservation) {
            await input.budgetReservations!.release({
              leaseToken: activeReservation.leaseToken,
              reason: "strategy_scope_mismatch",
              reservationId: activeReservation.record.reservation.id,
              runId,
              userId: context.userId
            }).catch(() => undefined);
          }
          return errorResult(call, "knowledge_strategy_comparison_scope_mismatch");
        }
      }
      let reservationDispatched = false;
      if (activeReservation) {
        const claimed = await input.budgetReservations!.claimDispatch({
          dispatchAttemptKey: `knowledge-dispatch:${activeReservation.record.reservation.id}`,
          leaseToken: activeReservation.leaseToken,
          reservationId: activeReservation.record.reservation.id,
          runId,
          userId: context.userId
        });
        if (claimed.kind !== "transitioned") {
          return errorResult(call, "knowledge_operation_replay_unavailable");
        }
        reservationDispatched = true;
      }

      try {
      if (strategyStepClaim && (
        strategyStepClaim.step.request?.kind === "comparison_target" ||
        strategyStepClaim.step.request?.kind === "multi_hop_root" ||
        strategyStepClaim.step.request?.kind === "multi_hop_follow_up"
      )) {
        const dispatched = await input.strategies!.markStepDispatched({
          at: new Date(),
          executionId: strategyStepClaim.execution.execution!.executionId,
          leaseToken: strategyStepClaim.leaseToken,
          providerAttemptId: null,
          stateVersion: strategyStepClaim.step.lifecycle.stateVersion,
          stepId: strategyStepClaim.step.lifecycle.stepId
        });
        strategyStepClaim = Object.freeze({
          execution: dispatched.execution,
          kind: "claimed" as const,
          leaseToken: strategyStepClaim.leaseToken,
          step: dispatched.step
        });
      }
      const persist = async (
        evidence: KnowledgeRetrievalEvidence,
        canonicalSourceProvenance: readonly KnowledgeCanonicalSourceProvenance[] = [],
        strategyReceipt?: KnowledgeStrategyStepReceiptV1
      ) => {
        const activeStrategyClaim = strategyStepClaim;
        const receipt = activeStrategyClaim
          ? strategyReceipt ?? knowledgeStrategyEvidenceStepReceiptV1(
              activeStrategyClaim.step.request!,
              evidence
            )
          : null;
        const acceptedEvidence = await input.store.persistReceipt({
          ...(activeReservation
            ? {
                budgetReservation: {
                  actual: operationActualUsage(evidence, budgetState.policy),
                  leaseToken: activeReservation.leaseToken,
                  reservationId: activeReservation.record.reservation.id
                }
              }
            : {}),
          ...(canonicalSourceProvenance.length > 0 ? { canonicalSourceProvenance } : {}),
          evidence,
          modelRunToolCallId,
          runId,
          ...(activeStrategyClaim && receipt
            ? {
                strategyStep: {
                  at: new Date(),
                  executionId: activeStrategyClaim.execution.execution!.executionId,
                  includedPassageCount: Math.min(
                    evidence.results.length,
                    receipt.processedItemCount
                  ),
                  leaseToken: activeStrategyClaim.leaseToken,
                  receipt,
                  stateVersion: activeStrategyClaim.step.lifecycle.stateVersion,
                  stepId: activeStrategyClaim.step.lifecycle.stepId
                }
              }
            : {}),
          userId: context.userId!
        });
        strategyStepClaim = null;
        const persistedEvidence = acceptedEvidence ?? evidence;
        return completedResult(call, persistedEvidence);
      };
      const persistExplicitUnavailable = async (failureCode: string) => {
        const durationMs = Date.now() - startedAt;
        const usage = completedBudgetUsage({
          candidateCount: 0,
          durationMs,
          embeddingExecutions: [],
          noveltyRatio: null,
          policy: budgetState.policy,
          rerankerCalled: false,
          resultBytes: 0,
          usage: budgetState.usage
        });
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings),
          budget: {
            noveltyRatio: null,
            operation: request.operation,
            stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
            usage,
            version: 1
          },
          candidateCount: 0,
          candidateLimit,
          durationMs,
          embeddingExecutions: [],
          failureCode,
          fusion: "rrf_k60",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: "base_empty",
          postRerankOrder: null,
          preRerankOrder: null,
          query: request.query,
          rerankerBinding: null,
          resultLimit,
          results: [],
          scopeAliases: evidenceAliases(aliases, [], scopedBindings),
          threshold,
          version: KNOWLEDGE_RESULT_VERSION
        }));
      };
      const failStrategyStepAndPersistUnavailable = async (failureCode: string) => {
        const activeClaim = strategyStepClaim;
        const activeRequest = activeClaim?.step.request;
        if (!activeClaim || !activeRequest ||
          activeClaim.step.lifecycle.irreversibleDispatch) {
          throw new Error(failureCode);
        }
        await input.strategies!.failStep({
          at: new Date(),
          executionId: activeClaim.execution.execution!.executionId,
          includedPassageCount: 0,
          leaseToken: activeClaim.leaseToken,
          receipt: createKnowledgeStrategyStepReceiptV1({
            cursorExhausted: false,
            executionId: activeRequest.executionId,
            lastItemHash: null,
            nextCursor: null,
            processedItemCount: 0,
            processedItemsHash: createHash("sha256")
              .update(`knowledge_strategy_failed:${failureCode}`, "utf8")
              .digest("hex"),
            reasonCode: failureCode,
            requestHash: hashKnowledgeStrategyStepRequestV1(activeRequest),
            status: "failed",
            stepId: activeRequest.stepId,
            version: 1
          }),
          stateVersion: activeClaim.step.lifecycle.stateVersion,
          stepId: activeClaim.step.lifecycle.stepId
        });
        strategyStepClaim = null;
        return persistExplicitUnavailable(failureCode);
      };

      const strategyRequest = strategyStepClaim?.step.request;
      if (strategyStepClaim && strategyRequest?.kind === "corpus_summary_reduce") {
        const execution = strategyStepClaim.execution.execution;
        if (!execution || execution.strategy !== "corpus_summary" || !input.strategies) {
          throw new Error("knowledge_strategy_summary_execution_unavailable");
        }
        const storedOutputs = await input.strategies.loadMapOutputs({
          executionId: execution.executionId
        });
        const outputs: KnowledgeStrategyMapOutputV2[] = [];
        const mapOutputReceipts = [];
        for (const storedOutput of storedOutputs) {
          const output = decodeKnowledgeStrategyMapOutputV2(storedOutput.output);
          const mapOutputReceipt = decodeKnowledgeStrategyMapOutputReceiptV2(
            storedOutput.receipt
          );
          if (!output || !mapOutputReceipt || output.outputHash !== mapOutputReceipt.outputHash) {
            throw new Error("knowledge_strategy_summary_output_set_invalid");
          }
          outputs.push(output);
          mapOutputReceipts.push(mapOutputReceipt);
        }
        const supportCount = outputs.reduce((total, output) =>
          total + mapSummarySupports(output).length, 0);
        if (supportCount < 1 || supportCount > 100) {
          return failStrategyStepAndPersistUnavailable(
            "knowledge_strategy_summary_support_limit_exceeded"
          );
        }
        const supportPassages = await loadKnowledgeStrategySummarySupportPassages({
          execution: strategyStepClaim.execution,
          outputs,
          runId,
          store: input.store,
          userId: context.userId
        });
        const results = includedPassages(
          supportPassages,
          budgetState.evidenceCount ??
            (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
          aliases,
          16 * 1024 + supportPassages.length * 64 * 1024
        );
        if (results.length !== supportPassages.length || results.some((result) =>
          result.textTruncated || !result.sourceAlias || !result.sourceArtifactId ||
          !result.sourceName)) {
          throw new Error("knowledge_strategy_summary_support_result_invalid");
        }
        const boundResults = results as KnowledgeSourceBoundRetrievedPassageEvidence[];
        let strategySummaryEvidence: ReturnType<
          typeof buildKnowledgeStrategySummaryResultEvidenceV2
        >;
        try {
          strategySummaryEvidence = buildKnowledgeStrategySummaryResultEvidenceV2({
            outputs,
            results: boundResults
          });
        } catch (error) {
          if (error instanceof Error &&
            error.message === "knowledge_strategy_summary_provider_budget_exceeded") {
            return failStrategyStepAndPersistUnavailable(error.message);
          }
          throw error;
        }
        const reduce = knowledgeStrategyCorpusSummaryReduceReceiptV2({
          execution,
          mapOutputReceipts,
          mapOutputs: outputs,
          request: strategyRequest,
          summaryEvidence: strategySummaryEvidence.summaries
        });
        const durationMs = Date.now() - startedAt;
        const summaryBytes = strategySummaryEvidence.summaries.reduce((total, sourceSummary) =>
          total + sourceSummary.summaries.reduce((sourceTotal, summary) =>
            sourceTotal + Buffer.byteLength(summary.summaryText, "utf8"), 0), 0);
        const usage = completedBudgetUsage({
          candidateCount: results.length,
          durationMs,
          embeddingExecutions: [],
          noveltyRatio: 1,
          policy: budgetState.policy,
          rerankerCalled: false,
          resultBytes: summaryBytes,
          usage: budgetState.usage
        });
        const candidateCounts = Object.fromEntries(scopedBindings.map((binding) => [
          binding.ordinal,
          supportPassages.filter(({ bindingOrdinal }) =>
            bindingOrdinal === binding.ordinal).length
        ]));
        let evidence: KnowledgeRetrievalEvidence;
        try {
          evidence = finalizedEvidence({
            bases: baseEvidence(scopedBindings, candidateCounts, [], true),
            budget: {
              noveltyRatio: 1,
              operation: request.operation,
              stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
              usage,
              version: 1
            },
            candidateCount: results.length,
            candidateLimit: results.length,
            durationMs,
            embeddingExecutions: [],
            fusion: "rrf_k60",
            invocationOrdinal: budgetState.invocationOrdinal,
            operation: request.operation,
            outcome: "complete",
            postRerankOrder: null,
            preRerankOrder: null,
            query: request.query,
            rerankerBinding: null,
            resultLimit: results.length,
            results: boundResults,
            scopeAliases: evidenceAliases(aliases, results, scopedBindings),
            strategySummaryEvidence,
            threshold: 0,
            version: KNOWLEDGE_RESULT_VERSION
          });
        } catch (error) {
          if (error instanceof Error &&
            error.message === "knowledge_provider_text_budget_exceeded") {
            return failStrategyStepAndPersistUnavailable(
              "knowledge_strategy_summary_provider_budget_exceeded"
            );
          }
          throw error;
        }
        return persist(evidence, [], reduce.receipt);
      }
      if (strategyStepClaim && strategyRequest &&
        (strategyRequest.kind === "full_context_page" ||
          strategyRequest.kind === "exhaustive_page")) {
        const execution = strategyStepClaim.execution.execution;
        const loadPage = input.store.loadStrategyPassagePage;
        const source = execution?.sourceSet.find(({ bindingId }) =>
          bindingId === strategyRequest.sourceBindingId);
        if (!execution || !loadPage || !source) {
          throw new Error("knowledge_strategy_page_store_unavailable");
        }
        const page = await loadPage({
          cursor: strategyRequest.cursor,
          executionId: strategyRequest.executionId,
          limit: strategyRequest.kind === "exhaustive_page"
            ? 100
            : KNOWLEDGE_RESULT_LIMIT,
          runId,
          source,
          streamId: strategyRequest.streamId,
          userId: context.userId
        });
        const pageResultLimit = strategyRequest.kind === "exhaustive_page"
          ? 100
          : KNOWLEDGE_RESULT_LIMIT;
        if (page.passages.length !== page.items.length ||
          page.passages.length > pageResultLimit) {
          throw new Error("knowledge_strategy_page_result_invalid");
        }
        const strategyReceipt = knowledgeStrategyPassageStepReceiptV1(strategyRequest, page);
        const lineage = await loadKnowledgeStrategyDispatchLineagePages({
          currentPage: page,
          currentReceipt: strategyReceipt,
          currentRequest: strategyRequest,
          execution: strategyStepClaim.execution,
          runId,
          store: input.store,
          userId: context.userId
        });
        const strategyPassages = lineage.pages.flatMap(({ passages }) => passages);
        const dispatchedStrategyPassages = strategyRequest.kind === "exhaustive_page"
          ? strategyPassages.slice(0, 100)
          : strategyPassages;
        const results = includedPassages(
          dispatchedStrategyPassages,
          budgetState.evidenceCount ??
            (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
          aliases
        );
        const durationMs = Date.now() - startedAt;
        const usage = completedBudgetUsage({
          candidateCount: dispatchedStrategyPassages.length,
          durationMs,
          embeddingExecutions: [],
          noveltyRatio: results.length > 0 ? 1 : null,
          policy: budgetState.policy,
          rerankerCalled: false,
          resultBytes: results.reduce((total, result) => total + result.includedTextBytes, 0),
          usage: budgetState.usage
        });
        const candidateCounts = Object.fromEntries(scopedBindings.map((binding) => [
          binding.ordinal,
          dispatchedStrategyPassages.filter(({ bindingOrdinal }) =>
            bindingOrdinal === binding.ordinal).length
        ]));
        const evidence = finalizedEvidence({
          bases: baseEvidence(scopedBindings, candidateCounts, [], true),
          budget: {
            noveltyRatio: results.length > 0 ? 1 : null,
            operation: request.operation,
            stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
            usage,
            version: 1
          },
          candidateCount: dispatchedStrategyPassages.length,
          candidateLimit: Math.max(1, dispatchedStrategyPassages.length),
          durationMs,
          embeddingExecutions: [],
          fusion: "rrf_k60",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: results.length > 0 ? "complete" : "base_empty",
          postRerankOrder: null,
          preRerankOrder: null,
          query: request.query,
          rerankerBinding: null,
          resultLimit: Math.max(1, results.length),
          results,
          scopeAliases: evidenceAliases(aliases, results, scopedBindings),
          threshold: 0,
          version: KNOWLEDGE_RESULT_VERSION
        });
        const verifiedEvidence: KnowledgeRetrievalEvidence = {
          ...evidence,
          strategyStepEvidence: sealKnowledgeStrategyStepEvidenceV1(
            strategyRequest,
            strategyReceipt
          )
        };
        const lineageStepIds = new Set(lineage.requests.map(({ stepId }) => stepId));
        const lineageResult = verifyKnowledgeStrategyDispatchLineageV1({
          evidence: verifiedEvidence,
          lineage: {
            dependencies: strategyStepClaim.execution.dependencies.filter((dependency) =>
              lineageStepIds.has(dependency.dependentStepId) &&
              lineageStepIds.has(dependency.prerequisiteStepId)),
            execution,
            kind: "explicit",
            stepReceipts: lineage.receipts,
            stepRequests: lineage.requests
          },
          pages: lineage.pages
        });
        const exactPartialExhaustiveReasons = new Set([
          "lineage_emitted_count_mismatch",
          "lineage_emitted_limit_exceeded"
        ]);
        const exactPartialExhaustive = strategyRequest.kind === "exhaustive_page" &&
          strategyPassages.length > 100 && results.length === 100 &&
          lineageResult.reasonCodes.length === exactPartialExhaustiveReasons.size &&
          lineageResult.reasonCodes.every((reason) =>
            exactPartialExhaustiveReasons.has(reason));
        if (!lineageResult.verified && !exactPartialExhaustive) {
          throw new Error(
            `knowledge_strategy_dispatch_lineage_invalid:${lineageResult.reasonCodes.join(",")}`
          );
        }
        return persist(evidence, [], strategyReceipt);
      }

      if (request.operation === "read_source") {
        const read = request.read!;
        const sourceAlias = readSourceAlias!;
        const binding = readBinding!;
        const search = await readSource!({
          binding,
          read,
          runId,
          sourceArtifactId: sourceAlias.sourceArtifactId!,
          sourceId: sourceAlias.sourceId!,
          userId: context.userId
        });
        const candidateEntries = Object.entries(search.candidateCounts);
        if (
          search.bindingCount !== 1 || candidateEntries.length !== 1 ||
          candidateEntries[0]?.[0] !== String(binding.ordinal) ||
          candidateEntries[0]?.[1] !== search.candidateCount ||
          !Number.isSafeInteger(search.candidateCount) || search.candidateCount < 0 ||
          search.candidateCount < search.passages.length ||
          (search.vectorSearchEvidence?.length ?? 0) !== 0 ||
          search.passages.some((passage) =>
            passage.bindingOrdinal !== binding.ordinal ||
            passage.knowledgeBaseId !== binding.knowledgeBaseId ||
            passage.sourceArtifactId !== sourceAlias.sourceArtifactId ||
            passage.documentId !== sourceAlias.sourceId ||
            passage.documentVersionId !== sourceAlias.sourceVersionId)
        ) {
          throw new Error("knowledge_source_read_result_invalid");
        }
        const rowTarget = read.target.kind === "row" ? read.target : null;
        const atomicRowId = rowTarget?.rowId ?? (read.target.kind === "evidence_handle"
          ? readSourceRowId(search.passages[0])
          : null);
        if (atomicRowId && (search.candidateCount !== search.passages.length ||
          (search.passages.length > 0 &&
            !completeReadSourceRowGroup(search.passages, atomicRowId)))) {
          throw new Error("knowledge_source_read_row_result_invalid");
        }
        const readResultLimit = atomicRowId && search.passages.length > 0
          ? search.passages.length
          : Math.min(resultLimit, read.window);
        const results = includedPassages(
          atomicRowId ? search.passages : search.passages.slice(0, readResultLimit),
          budgetState.evidenceCount ??
            (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
          aliases
        );
        const durationMs = Date.now() - startedAt;
        const priorContentHashes = new Set(budgetState.priorContentHashes);
        const contentHashes = results.flatMap((result) =>
          result.contentHash ? [result.contentHash] : []);
        const noveltyRatio = results.length === 0
          ? null
          : contentHashes.length === 0
            ? 1
            : contentHashes.filter((hash) => !priorContentHashes.has(hash)).length /
              contentHashes.length;
        const usage = completedBudgetUsage({
          candidateCount: search.candidateCount,
          durationMs,
          embeddingExecutions: [],
          noveltyRatio,
          policy: budgetState.policy,
          rerankerCalled: false,
          resultBytes: results.reduce((total, result) => total + result.includedTextBytes, 0),
          usage: budgetState.usage
        });
        return persist(finalizedEvidence({
          bases: baseEvidence(
            scopedBindings,
            search.candidateCounts,
            search.vectorSearchEvidence ?? [],
            true
          ),
          budget: {
            noveltyRatio,
            operation: request.operation,
            stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
            usage,
            version: 1
          },
          candidateCount: search.candidateCount,
          candidateLimit,
          durationMs,
          embeddingExecutions: [],
          fusion: "rrf_k60",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: results.length > 0 ? "complete" : "source_location_unavailable",
          postRerankOrder: null,
          preRerankOrder: null,
          query: request.query,
          read: {
            contractVersion: read.contractVersion,
            direction: read.direction,
            embedding: read.embedding,
            locator: read.locator,
            resolution: read.resolution,
            resolvedSource: {
              sourceAlias: sourceAlias.alias,
              sourceArtifactId: sourceAlias.sourceArtifactId!,
              sourceId: sourceAlias.sourceId!,
              sourceName: sourceAlias.label,
              sourceVersionId: sourceAlias.sourceVersionId!
            },
            target: read.target,
            version: 1,
            window: read.window
          },
          rerankerBinding: null,
          resultLimit: readResultLimit,
          results,
          scopeAliases: evidenceAliases(
            aliases,
            results,
            scopedBindings,
            [sourceAlias.sourceArtifactId!]
          ),
          threshold,
          version: KNOWLEDGE_RESULT_VERSION
        }));
      }

      if (request.operation === "find_exact") {
        const findExact = input.store.findExact;
        if (!findExact) throw new Error("knowledge_exact_store_unavailable");
        const sourceArtifactIds = admittedSourceArtifactIds({
          aliases,
          bindings: scopedBindings,
          ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {})
        });
        if (sourceArtifactIds.length === 0) {
          throw new Error("knowledge_exact_scope_unavailable");
        }
        const search = await findExact({
          request: request.exact,
          runId,
          sourceArtifactIds,
          userId: context.userId
        });
        const admittedArtifacts = new Set(sourceArtifactIds);
        const bindingByOrdinal = new Map(scopedBindings.map((binding) => [
          binding.ordinal,
          binding
        ]));
        if (!validDedicatedCandidateCounts({ ...search, scopedBindings }) ||
          search.candidateCount !== search.passages.length ||
          search.fields.length !== search.passages.length ||
          !Number.isSafeInteger(search.scannedBytes) || search.scannedBytes < 0 ||
          typeof search.scanTruncated !== "boolean" ||
          search.passages.length > request.exact.limit ||
          search.passages.some((passage) => {
            const binding = bindingByOrdinal.get(passage.bindingOrdinal);
            return !binding || passage.knowledgeBaseId !== binding.knowledgeBaseId ||
              !passage.sourceArtifactId || !admittedArtifacts.has(passage.sourceArtifactId);
          })) throw new Error("knowledge_exact_result_invalid");
        const results = includedPassages(
          search.passages,
          budgetState.evidenceCount ??
            (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
          aliases
        );
        const durationMs = Date.now() - startedAt;
        const usage = completedBudgetUsage({
          candidateCount: search.candidateCount,
          durationMs,
          embeddingExecutions: [],
          noveltyRatio: results.length > 0 ? 1 : null,
          policy: budgetState.policy,
          rerankerCalled: false,
          resultBytes: results.reduce((total, result) => total + result.includedTextBytes, 0),
          usage: budgetState.usage
        });
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings, search.candidateCounts, [], true),
          budget: {
            noveltyRatio: results.length > 0 ? 1 : null,
            operation: request.operation,
            stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
            usage,
            version: 1
          },
          candidateCount: search.candidateCount,
          candidateLimit: request.exact.limit,
          durationMs,
          embeddingExecutions: [],
          exact: {
            ...request.exact,
            matches: search.fields.map((field, resultOrdinal) => ({ field, resultOrdinal })),
            nextCursor: search.nextCursor,
            scannedBytes: search.scannedBytes,
            scanTruncated: search.scanTruncated,
            version: 1
          },
          fusion: "none",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: results.length > 0 ? "complete" : "zero_above_threshold",
          postRerankOrder: null,
          preRerankOrder: null,
          query: request.query,
          rerankerBinding: null,
          resultLimit: request.exact.limit,
          results,
          scopeAliases: evidenceAliases(aliases, results, scopedBindings),
          threshold: 0,
          version: KNOWLEDGE_RESULT_VERSION
        }));
      }

      if (request.operation === "discover_sources") {
        const discoverSources = input.store.discoverSources;
        if (!discoverSources) throw new Error("knowledge_discovery_store_unavailable");
        const sourceArtifactIds = admittedSourceArtifactIds({
          aliases,
          bindings: scopedBindings,
          ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {})
        });
        if (sourceArtifactIds.length === 0) {
          throw new Error("knowledge_discovery_scope_unavailable");
        }
        const discovery = await discoverSources({
          request: request.discovery,
          runId,
          sourceArtifactIds,
          userId: context.userId
        });
        const admittedAliases = new Map(aliases.flatMap((alias) =>
          alias.kind === "source" && alias.sourceArtifactId &&
          sourceArtifactIds.includes(alias.sourceArtifactId)
            ? [[alias.alias, alias] as const]
            : []));
        const requestedFields = new Set(request.discovery.fields);
        if (!validDedicatedCandidateCounts({ ...discovery, scopedBindings }) ||
          discovery.candidateCount !== discovery.sources.length ||
          discovery.sources.length > request.discovery.limit ||
          new Set(discovery.sources.map((source) => source.sourceAlias)).size !==
            discovery.sources.length ||
          discovery.sources.some((source) => {
            const admitted = admittedAliases.get(source.sourceAlias);
            return !admitted || admitted.label !== source.sourceName ||
              typeof source.fileName !== "string" || source.fileName.length === 0 ||
              source.readiness !== "ready" || typeof source.ambiguous !== "boolean" ||
              !Number.isSafeInteger(source.sourceVersionNumber) ||
              source.sourceVersionNumber < 1 || source.matchedFields.length < 1 ||
              source.matchedFields.some((field) => !requestedFields.has(field));
          })) throw new Error("knowledge_discovery_result_invalid");
        const durationMs = Date.now() - startedAt;
        const resultBytes = Buffer.byteLength(canonicalJson(discovery.sources), "utf8");
        const usage = completedBudgetUsage({
          candidateCount: discovery.candidateCount,
          durationMs,
          embeddingExecutions: [],
          noveltyRatio: null,
          policy: budgetState.policy,
          rerankerCalled: false,
          resultBytes,
          usage: budgetState.usage
        });
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings, discovery.candidateCounts, [], true),
          budget: {
            noveltyRatio: null,
            operation: request.operation,
            stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
            usage,
            version: 1
          },
          candidateCount: discovery.candidateCount,
          candidateLimit: request.discovery.limit,
          discovery: {
            ...request.discovery,
            nextCursor: discovery.nextCursor,
            sources: discovery.sources,
            version: 1
          },
          durationMs,
          embeddingExecutions: [],
          fusion: "none",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: discovery.sources.length > 0 ? "complete" : "zero_above_threshold",
          postRerankOrder: null,
          preRerankOrder: null,
          query: request.query,
          rerankerBinding: null,
          resultLimit: request.discovery.limit,
          results: [],
          scopeAliases: discovery.sources.map((source) => ({
            alias: source.sourceAlias,
            kind: "source" as const,
            label: source.sourceName
          })),
          threshold: 0,
          version: KNOWLEDGE_RESULT_VERSION
        }));
      }

      const explicitStructured = request.operation === "structured_analysis";
      const legacyStructured = request.operation === "automatic_search" &&
        Boolean(input.store.structuredSearch) && isStructuredDataQuery(request.query);
      if (explicitStructured || legacyStructured) {
        let structured: StructuredKnowledgeSearchResult | null = null;
        const structuredSearch = input.store.structuredSearch;
        if (!structuredSearch) {
          return persistExplicitUnavailable("knowledge_structured_store_unavailable");
        }
        try {
          structured = await structuredSearch({
            bindings: scopedBindings,
            query: request.query,
            ...(request.operation === "structured_analysis"
              ? {
                  selector: request.structured.selector,
                  targetSourceIds: request.structured.targetSourceIds
                }
              : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
            sourceArtifactIds: admittedSourceArtifactIds({
              aliases,
              bindings: scopedBindings,
              ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {})
            })
          });
        } catch {
          throwIfAborted(options?.signal);
          if (explicitStructured) {
            return persistExplicitUnavailable("knowledge_structured_analysis_unavailable");
          }
          // The legacy automatic heuristic is additive. Ordinary retrieval
          // remains available when its structured lane is damaged.
        }
        if (structured?.kind === "needs_clarification") {
          const durationMs = Date.now() - startedAt;
          const usage = completedBudgetUsage({
            candidateCount: 0,
            durationMs,
            embeddingExecutions: [],
            noveltyRatio: null,
            policy: budgetState.policy,
            rerankerCalled: false,
            resultBytes: 0,
            usage: budgetState.usage
          });
          return persist(finalizedEvidence({
            bases: baseEvidence(scopedBindings),
            budget: {
              noveltyRatio: null,
              operation: request.operation,
              stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
              usage,
              version: 1
            },
            candidateCount: 0,
            candidateLimit,
            durationMs,
            embeddingExecutions: [],
            fusion: "rrf_k60",
            invocationOrdinal: budgetState.invocationOrdinal,
            operation: request.operation,
            outcome: "structured_clarification_required",
            postRerankOrder: null,
            preRerankOrder: null,
            query: request.query,
            rerankerBinding: null,
            resultLimit,
            results: [],
            scopeAliases: evidenceAliases(aliases, [], scopedBindings),
            structured: {
              question: structured.question,
              status: "needs_clarification",
              version: 1
            },
            threshold,
            version: KNOWLEDGE_RESULT_VERSION
          }));
        }
        if (structured?.kind === "complete") {
          if (explicitStructured && !explicitAnalysisPassageMatchesTarget({
            aliases,
            bindings: scopedBindings,
            passage: structured.passage,
            targetSourceIds: request.operation === "structured_analysis"
              ? request.structured.targetSourceIds
              : []
          })) throw new Error("knowledge_structured_result_invalid");
          const results = includedPassages(
            [structured.passage],
            budgetState.evidenceCount ??
              (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
            aliases
          );
          const durationMs = Date.now() - startedAt;
          const priorContentHashes = new Set(budgetState.priorContentHashes);
          const noveltyRatio = priorContentHashes.has(structured.passage.contentHash ?? "") ? 0 : 1;
          const usage = completedBudgetUsage({
            candidateCount: 1,
            durationMs,
            embeddingExecutions: [],
            noveltyRatio,
            policy: budgetState.policy,
            rerankerCalled: false,
            resultBytes: results.reduce((total, result) => total + result.includedTextBytes, 0),
            usage: budgetState.usage
          });
          return persist(finalizedEvidence({
            bases: baseEvidence(scopedBindings, { [structured.passage.bindingOrdinal]: 1 }),
            budget: {
              noveltyRatio,
              operation: request.operation,
              stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
              usage,
              version: 1
            },
            candidateCount: 1,
            candidateLimit,
            durationMs,
            embeddingExecutions: [],
            fusion: "rrf_k60",
            invocationOrdinal: budgetState.invocationOrdinal,
            operation: request.operation,
            outcome: "complete",
            postRerankOrder: null,
            preRerankOrder: null,
            query: request.query,
            rerankerBinding: null,
            resultLimit,
            results,
            scopeAliases: evidenceAliases(aliases, results, scopedBindings),
            structured: { status: "complete", version: 1 },
            threshold,
            version: KNOWLEDGE_RESULT_VERSION
          }), structured.canonicalSourceProvenance ?? []);
        }
        if (explicitStructured) {
          return persistExplicitUnavailable("knowledge_structured_not_applicable");
        }
      }

      const explicitVisual = request.operation === "visual_analysis";
      const legacyVisual = request.operation === "automatic_search" &&
        Boolean(input.store.visualSearch) && isVisualKnowledgeQuery(request.query);
      if (explicitVisual || legacyVisual) {
        let visual: KnowledgeVisualSearchResult | null = null;
        const visualSearch = input.store.visualSearch;
        if (!visualSearch) {
          return persistExplicitUnavailable("knowledge_visual_store_unavailable");
        }
        try {
          visual = await visualSearch({
            bindings: scopedBindings,
            query: request.query,
            ...(request.operation === "visual_analysis"
              ? {
                  selector: request.visual.selector,
                  targetSourceIds: request.visual.targetSourceIds
                }
              : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
            sourceArtifactIds: admittedSourceArtifactIds({
              aliases,
              bindings: scopedBindings,
              ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {})
            })
          });
        } catch {
          throwIfAborted(options?.signal);
          if (explicitVisual) {
            return persistExplicitUnavailable("knowledge_visual_analysis_unavailable");
          }
          // The legacy automatic heuristic is additive. Ordinary retrieval
          // remains available when its visual lane is damaged.
        }
        if (visual?.kind === "complete") {
          if (explicitVisual && !explicitAnalysisPassageMatchesTarget({
            aliases,
            bindings: scopedBindings,
            passage: visual.passage,
            targetSourceIds: request.operation === "visual_analysis"
              ? request.visual.targetSourceIds
              : []
          })) throw new Error("knowledge_visual_result_invalid");
          const results = includedPassages(
            [visual.passage],
            budgetState.evidenceCount ??
              (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
            aliases
          );
          const durationMs = Date.now() - startedAt;
          const priorContentHashes = new Set(budgetState.priorContentHashes);
          const noveltyRatio = priorContentHashes.has(visual.passage.contentHash ?? "") ? 0 : 1;
          const usage = completedBudgetUsage({
            candidateCount: 1,
            durationMs,
            embeddingExecutions: [],
            noveltyRatio,
            policy: budgetState.policy,
            rerankerCalled: false,
            resultBytes: results.reduce((total, result) => total + result.includedTextBytes, 0),
            usage: budgetState.usage
          });
          const analysis = visual.passage.visualAnalysis;
          if (!analysis) throw new Error("knowledge_visual_result_invalid");
          return persist(finalizedEvidence({
            bases: baseEvidence(scopedBindings, { [visual.passage.bindingOrdinal]: 1 }),
            budget: {
              noveltyRatio,
              operation: request.operation,
              stopReason: knowledgeBudgetStopReason(budgetState.policy, usage),
              usage,
              version: 1
            },
            candidateCount: 1,
            candidateLimit,
            durationMs,
            embeddingExecutions: [],
            fusion: "rrf_k60",
            invocationOrdinal: budgetState.invocationOrdinal,
            operation: request.operation,
            outcome: "complete",
            postRerankOrder: null,
            preRerankOrder: null,
            query: request.query,
            rerankerBinding: null,
            resultLimit,
            results,
            scopeAliases: evidenceAliases(aliases, results, scopedBindings),
            threshold,
            version: KNOWLEDGE_RESULT_VERSION,
            visual: { status: analysis.status, version: 1 }
          }), visual.canonicalSourceProvenance ?? []);
        }
        if (explicitVisual) {
          return persistExplicitUnavailable("knowledge_visual_not_applicable");
        }
      }

      if (request.operation !== "automatic_search" &&
        request.operation !== "search_knowledge") {
        return persistExplicitUnavailable("knowledge_operation_not_applicable");
      }

      let groups: ReturnType<typeof bindingGroups> = [];
      let embeddingFailureCode: string | undefined;
      try {
        groups = bindingGroups(scopedBindings);
      } catch (error) {
        // An invalid or unavailable embedding binding degrades only the vector
        // lane. The accepted run/snapshot still authorizes lexical retrieval.
        embeddingFailureCode = safeFailureCode(error);
      }

      const embeddingExecutions: KnowledgeEmbeddingExecutionEvidence[] = [];
      const vectors: Array<{
        bindingOrdinal: number;
        indexGenerationId: string;
        knowledgeBaseId: string;
        targetDimension: 1024 | 1536;
        vector: readonly number[];
      }> = [];
      for (const group of groups) {
        const embeddingStartedAt = Date.now();
        let runtime: KnowledgeAcceptedEmbeddingRuntime | null = null;
        try {
          runtime = await input.embeddingRuntime.resolve(group.bindings[0]!);
          const result = await runtime.adapter.embed({
            mode: "query",
            ...(options?.signal ? { signal: options.signal } : {}),
            texts: [request.query]
          });
          throwIfAborted(options?.signal);
          const vector = result.vectors[0];
          if (!vector || vector.length !== group.bindings[0]!.targetDimension ||
            vector.some((value) => !Number.isFinite(value))) {
            throw new Error("embedding_response_dimension_mismatch");
          }
          embeddingExecutions.push({
            bindingOrdinals: group.bindings.map((binding) => binding.ordinal),
            durationMs: Date.now() - embeddingStartedAt,
            inputTokens: result.usage.inputTokens ?? 0,
            modelId: runtime.configuration.upstreamModelId,
            provider: runtime.provider,
            providerModelId: runtime.providerModelId,
            requestId: result.requestId,
            status: "complete",
            totalTokens: result.usage.totalTokens ?? result.usage.inputTokens ?? 0
          });
          for (const binding of group.bindings) {
            vectors.push({
              bindingOrdinal: binding.ordinal,
              indexGenerationId: binding.indexGenerationId,
              knowledgeBaseId: binding.knowledgeBaseId,
              targetDimension: binding.targetDimension,
              vector
            });
          }
        } catch (error) {
          throwIfAborted(options?.signal);
          embeddingFailureCode ??= safeFailureCode(error);
          embeddingExecutions.push({
            bindingOrdinals: group.bindings.map((binding) => binding.ordinal),
            durationMs: Date.now() - embeddingStartedAt,
            inputTokens: 0,
            modelId: runtime?.configuration.upstreamModelId ?? group.snapshot.model.upstreamModelId,
            provider: runtime?.provider ?? group.snapshot.providerFamily,
            providerModelId: runtime?.providerModelId ?? group.snapshot.providerModelId,
            requestId: null,
            status: "error",
            totalTokens: 0
          });
        }
      }

      const search = await input.store.hybridSearch({
        ...(filter.bindingOrdinals ? { bindingOrdinals: filter.bindingOrdinals } : {}),
        candidateLimit,
        operation: request.operation,
        query: request.query,
        resultLimit,
        runId,
        ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {}),
        threshold,
        userId: context.userId,
        vectors
      });
      if (search.bindingCount !== scopedBindings.length ||
        Object.values(search.candidateCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error("knowledge_hybrid_result_invalid");
      }
      const remainingRetrievedTokens = Math.max(
        1,
        budgetState.policy.maxRetrievedTokens - budgetState.usage.retrievedTokens
      );
      const results = includedPassages(
        search.passages,
        budgetState.evidenceCount ??
          (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
        aliases,
        Math.min(
          KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
          4 * 1_024 + remainingRetrievedTokens * 4
        )
      );
      const retrievalOutcome: KnowledgeRetrievalOutcome = results.length > 0
        ? "complete"
        : search.candidateCount > 0
          ? "zero_above_threshold"
          : embeddingFailureCode
            ? "embedding_model_unavailable"
            : scopedBindings.some((binding) =>
                binding.indexedContentRevision < binding.baseContentRevision)
              ? "base_indexing"
              : "base_empty";
      const ranking = search.rankingEvidence;
      const priorContentHashes = new Set(budgetState.priorContentHashes);
      const resultContentHashes = results.flatMap((result) =>
        result.contentHash ? [result.contentHash] : []);
      const noveltyRatio = results.length === 0
        ? null
        : resultContentHashes.length === 0
          ? 1
          : resultContentHashes.filter((hash) => !priorContentHashes.has(hash)).length /
            resultContentHashes.length;
      const durationMs = Date.now() - startedAt;
      const budgetUsage = completedBudgetUsage({
        candidateCount: search.candidateCount,
        durationMs,
        embeddingExecutions,
        noveltyRatio,
        policy: budgetState.policy,
        rerankerCalled: ranking?.rerankerBinding !== null && ranking?.rerankerBinding !== undefined,
        resultBytes: results.reduce((total, result) => total + result.includedTextBytes, 0),
        usage: budgetState.usage
      });
      const stopReason = knowledgeBudgetStopReason(budgetState.policy, budgetUsage);
      return persist(finalizedEvidence({
        bases: baseEvidence(
          scopedBindings,
          search.candidateCounts,
          search.vectorSearchEvidence ?? []
        ),
        budget: {
          noveltyRatio,
          operation: request.operation,
          stopReason,
          usage: budgetUsage,
          version: 1
        },
        candidateCount: search.candidateCount,
        candidateLimit,
        durationMs,
        embeddingExecutions,
        ...(embeddingFailureCode ? { failureCode: embeddingFailureCode } : {}),
        fusion: ranking?.fusion ?? "rrf_k60",
        invocationOrdinal: budgetState.invocationOrdinal,
        operation: request.operation,
        outcome: retrievalOutcome,
        postRerankOrder: ranking?.postRerankOrder ?? null,
        preRerankOrder: ranking?.preRerankOrder ?? null,
        query: request.query,
        rerankerBinding: ranking?.rerankerBinding ?? null,
        resultLimit,
        results: retrievalOutcome === "complete" ? results : [],
        scopeAliases: evidenceAliases(aliases, results, scopedBindings),
        threshold,
        version: KNOWLEDGE_RESULT_VERSION
      }), search.canonicalSourceProvenance ?? []);
      } catch (error) {
        if (strategyStepClaim) {
          const activeClaim = strategyStepClaim;
          if (activeClaim.step.lifecycle.irreversibleDispatch && activeClaim.step.request) {
            const request = activeClaim.step.request;
            await input.strategies!.markStepAmbiguous({
              at: new Date(),
              executionId: activeClaim.execution.execution!.executionId,
              includedPassageCount: 0,
              leaseToken: activeClaim.leaseToken,
              receipt: createKnowledgeStrategyStepReceiptV1({
                cursorExhausted: false,
                executionId: request.executionId,
                lastItemHash: null,
                nextCursor: null,
                processedItemCount: 0,
                processedItemsHash: createHash("sha256")
                  .update("knowledge_strategy_dispatch_ambiguous", "utf8")
                  .digest("hex"),
                reasonCode: "knowledge_strategy_dispatch_ambiguous",
                requestHash: hashKnowledgeStrategyStepRequestV1(request),
                status: "ambiguous",
                stepId: request.stepId,
                version: 1
              }),
              stateVersion: activeClaim.step.lifecycle.stateVersion,
              stepId: activeClaim.step.lifecycle.stepId
            }).catch(() => undefined);
          } else {
            await input.strategies!.releaseStep({
              at: new Date(),
              executionId: activeClaim.execution.execution!.executionId,
              leaseToken: activeClaim.leaseToken,
              stateVersion: activeClaim.step.lifecycle.stateVersion,
              stepId: activeClaim.step.lifecycle.stepId
            }).catch(() => undefined);
          }
        }
        if (activeReservation && reservationDispatched) {
          await input.budgetReservations!.markAmbiguous({
            leaseToken: activeReservation.leaseToken,
            reason: "operation_dispatch_failed",
            reservationId: activeReservation.record.reservation.id,
            runId,
            userId: context.userId
          }).catch(() => undefined);
        }
        throw error;
      }
    },
    preflight,
    tool: knowledgeRetrievalTool,
    tools: knowledgeFollowUpTools
  };
}
