import { createHash } from "node:crypto";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { EmbeddingAdapterError, type EmbeddingAdapter } from "../providers/embeddings";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { elapsedMilliseconds, monotonicNowMilliseconds } from "../monotonicTime";
import type {
  ModelToolCall,
  RunTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutor
} from "../tools/types";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  aggregateKnowledgeUsage,
  knowledgeToolResultContent,
  knowledgeToolResultText
} from "./toolResult";
import {
  KNOWLEDGE_EXECUTION_TOOL_NAMES,
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_SCOPED_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  type KnowledgeAcceptedBinding,
  type KnowledgeBaseRetrievalEvidence,
  type KnowledgeEmbeddingExecutionEvidence,
  type KnowledgeExactSearchRequest,
  type KnowledgeExactSearchResult,
  type KnowledgeHybridPassage,
  type KnowledgeHybridSearchResult,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeRetrievedPassageEvidence,
  type KnowledgeSourceDiscoveryRequest,
  type KnowledgeSourceDiscoveryResult,
  type KnowledgeVectorSearchEvidence
} from "./retrievalTypes";
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
import {
  knowledgeRetrievalTool,
  normalizeKnowledgeQuery,
  parseKnowledgeExecutionRequest
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
import { KNOWLEDGE_LANE_CANDIDATE_LIMIT } from "./retrievalRanking";
import {
  createKnowledgeRerankStage,
  knowledgeRerankerDisabledEvidence,
  knowledgeRerankerUnavailableEvidence,
  type KnowledgeRerankExecutor
} from "./rerankExecution";
import type { KnowledgeRerankerBindingEvidenceV2 } from "./rerankEvidence";
import type { KnowledgeRerankerRuntimeResolver } from "./rerankerRuntime";
import { knowledgeTokenizerEvidenceLabel } from "./tokenizer/knowledgeTokenCounter";
import {
  fitKnowledgeParentExpansionsToByteBudget,
  knowledgeParentExpansionEvidence
} from "./parentContextExpansion";

export { knowledgeRetrievalTool } from "./knowledgeTools";

/**
 * End-to-end envelope for one read-only Knowledge tool operation. Query
 * embedding, hybrid retrieval, hosted reranking, and durable receipt writes
 * are sequential stages; this must leave headroom beyond the reranker's own
 * bounded fallback deadline instead of racing it at the same wall clock.
 */
export const KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS = 60_000 as const;

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
  budgetState?(input: Readonly<{
    modelRunToolCallId: string;
    operation: KnowledgeOperationKind;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetState | null>;
  hybridSearch(input: Readonly<{
    anchorQuery?: string;
    bindingOrdinals?: readonly number[];
    candidateLimit: number;
    excludedOccurrenceKeys: readonly string[];
    operation: KnowledgeOperationKind;
    query: string;
    rerank?: Readonly<{
      executor: KnowledgeRerankExecutor;
      signal?: AbortSignal;
    }>;
    resultLimit: number;
    runId: string;
    sourceIds?: readonly string[];
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
  loadScopeAliases?(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<readonly KnowledgeScopeAlias[]>;
  materializeScopeAliases?(input: Readonly<{
    runId: string;
    sourceProvenance: readonly KnowledgeCanonicalSourceProvenance[];
    userId: string;
  }>): Promise<void>;
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
    userId: string;
  }>): Promise<KnowledgeRetrievalEvidence | void>;
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
  excludedResources?: number;
  invocationOrdinal: number;
  policy: KnowledgeBudgetPolicy;
  priorOccurrenceKeys: readonly string[];
  priorSourceAliases: readonly string[];
  stopReason: KnowledgeBudgetStopReason | null;
  usage: KnowledgeBudgetUsage;
}>;

export type KnowledgeEmbeddingRuntimeResolver = Readonly<{
  resolve(binding: KnowledgeAcceptedBinding): Promise<KnowledgeAcceptedEmbeddingRuntime>;
}>;

export type KnowledgeToolExecutor = ToolExecutor & Readonly<{
  accepts(name: string): boolean;
  preflight?(
    call: ModelToolCall,
    context: ToolExecutionContext
  ): Promise<KnowledgeExecutionAdmission>;
  /** Model-facing Knowledge tools; current runs expose only search_knowledge. */
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

function permitsLexicalQueryDegradation(error: unknown): boolean {
  if (error instanceof ProviderAdmissionError) {
    return error.code === "model_not_available" || error.code.startsWith("credential_");
  }
  if (!(error instanceof EmbeddingAdapterError)) return false;
  return error.code === "embedding_request_timed_out" ||
    error.code === "embedding_provider_request_failed" ||
    error.code === "embedding_provider_http_error" &&
      (error.httpStatus === 429 || error.httpStatus !== null && error.httpStatus >= 500);
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
    usage: aggregateKnowledgeUsage(evidence.embeddingExecutions)
  };
}

/** Content-free tokenizer identity derived from the accepted embedding
 * snapshot; recorded next to the vector-space fingerprint that already
 * carries the index-profile identity. Never fails the operation. */
function bindingTokenizerProfile(binding: KnowledgeAcceptedBinding): string | null {
  try {
    const snapshot = normalizeProviderExecutionSnapshot(binding.embeddingExecutionSnapshot);
    return knowledgeTokenizerEvidenceLabel(snapshot.model.upstreamModelId);
  } catch {
    return null;
  }
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
    const tokenizerProfile = bindingTokenizerProfile(binding);
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
      ...(tokenizerProfile ? { tokenizerProfile } : {}),
      ...(vectorSearch ? { vectorSearch } : {}),
      vectorSpaceFingerprint: binding.vectorSpaceFingerprint
    };
  });
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
  // packing complete excerpts. Primary chunks are never cut mid-item.
  const metadataReserveBytes = 16 * 1024;
  const excerptBudgetBytes = Math.max(1, maximumBytes - metadataReserveBytes);
  const sourceAliasByArtifact = primarySourceAliasesByArtifact(aliases);
  const selected: KnowledgeRetrievedPassageEvidence[] = [];
  const pendingExpandedContext: Array<string | null> = [];
  const pendingExpansion: Array<KnowledgeHybridPassage["expansion"] | null> = [];
  let retainedExcerptBytes = 0;
  for (const { expandedContext, expansion, text, ...passage } of passages) {
    const sourceTextBytes = Buffer.byteLength(text, "utf8");
    if (sourceTextBytes > excerptBudgetBytes) {
      if (selected.length === 0) throw new Error("knowledge_evidence_item_too_large");
      continue;
    }
    if (retainedExcerptBytes + sourceTextBytes > excerptBudgetBytes) continue;
    const sourceAlias = passage.sourceArtifactId
      ? sourceAliasByArtifact.get(passage.sourceArtifactId)
      : undefined;
    if (passage.sourceArtifactId && !sourceAlias) {
      throw new Error("knowledge_evidence_source_alias_unavailable");
    }
    selected.push({
      ...passage,
      handle: `K${evidenceOffset + selected.length + 1}`,
      includedText: text,
      includedTextBytes: sourceTextBytes,
      ...(sourceAlias ? { sourceAlias } : {}),
      sourceTextBytes,
      textTruncated: false
    });
    pendingExpandedContext.push(expandedContext || null);
    pendingExpansion.push(expansion ?? null);
    retainedExcerptBytes += sourceTextBytes;
  }
  // FR-14 trim order: every atomic hit above is already packed and is never
  // dropped in favor of expansion — expanded context competes only for the
  // leftover bytes. Unit-bearing expansions shrink unit-by-unit with
  // per-source round-robin fairness before any expansion drops entirely;
  // legacy whole-string context keeps its historical all-or-nothing attach.
  let remainingContextBytes = excerptBudgetBytes - retainedExcerptBytes;
  const unitEntries = selected.flatMap((passage, index) => {
    const expansion = pendingExpansion[index];
    return expansion && expansion.units.length > 0
      ? [{
          key: String(index),
          sourceKey: [
            passage.documentId,
            passage.documentVersionId,
            passage.sourceArtifactId ?? ""
          ].join("\u001f"),
          units: expansion.units
        }]
      : [];
  });
  const fitted = unitEntries.length > 0
    ? fitKnowledgeParentExpansionsToByteBudget({
        entries: unitEntries,
        maximumBytes: Math.max(0, remainingContextBytes)
      })
    : null;
  if (fitted) {
    for (const kept of fitted.values()) {
      if (kept.units.length > 0) {
        remainingContextBytes -= Buffer.byteLength(kept.text, "utf8");
      }
    }
  }
  return selected.map((passage, index) => {
    const expansion = pendingExpansion[index];
    if (expansion) {
      const kept = fitted?.get(String(index));
      const units = kept?.units ?? [];
      return {
        ...passage,
        ...(units.length > 0 ? { expandedContext: kept!.text } : {}),
        expansion: knowledgeParentExpansionEvidence(expansion, units)
      };
    }
    const expandedContext = pendingExpandedContext[index];
    if (!expandedContext) return passage;
    const expandedContextBytes = Buffer.byteLength(expandedContext, "utf8");
    if (expandedContextBytes > remainingContextBytes) return passage;
    remainingContextBytes -= expandedContextBytes;
    return { ...passage, expandedContext };
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

function fallbackBudgetUsage(invocationOrdinal: number): KnowledgeBudgetUsage {
  return {
    cumulativeCandidates: 0,
    estimatedCostMicros: 0,
    latencyMs: 0,
    operations: invocationOrdinal,
    queryEmbeddingCalls: 0,
    retrievedTokens: 0
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
  const usage = fallbackBudgetUsage(invocationOrdinal);
  return {
    evidenceCount: (invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
    invocationOrdinal,
    policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    priorOccurrenceKeys: [],
    priorSourceAliases: [],
    stopReason: knowledgeBudgetStopReason(DEFAULT_KNOWLEDGE_BUDGET_POLICY, usage),
    usage
  };
}

function automaticSourceAliasesPreviouslyDisclosed(
  request: NonNullable<ReturnType<typeof parseKnowledgeExecutionRequest>>,
  budgetState: KnowledgeBudgetState
): boolean {
  if (request.operation !== "automatic_search" || request.sourceAliases.length === 0) return true;
  const disclosed = new Set(budgetState.priorSourceAliases);
  return budgetState.invocationOrdinal > 1 &&
    request.sourceAliases.every((alias) => disclosed.has(alias));
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

function currentUserAnchorQuery(
  context: ToolExecutionContext,
  request: NonNullable<ReturnType<typeof parseKnowledgeExecutionRequest>>
): string | null {
  if (
    request.operation !== "automatic_search" ||
    request.focused
  ) return null;
  const currentUserQuery = normalizeKnowledgeQuery(
    textFromContentBlocks(context.request.content)
  );
  return currentUserQuery && currentUserQuery !== request.query
    ? currentUserQuery
    : null;
}

function operationRequestInput(input: Readonly<{
  aliases: readonly KnowledgeScopeAlias[];
  bindings: readonly KnowledgeAcceptedBinding[];
  filter: Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }>;
  request: ReturnType<typeof parseKnowledgeExecutionRequest> & {};
}>): KnowledgeBudgetOperationRequestInput | null {
  const profileRevisionIds = [...new Set(input.bindings.map((binding) =>
    binding.profileRevisionId).filter((value): value is string => Boolean(value)))].sort();
  try {
    if (profileRevisionIds.length < 1 || bindingGroups(input.bindings).length !== 1) return null;
  } catch {
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
  const canUseBaseSnapshots = input.request.operation === "automatic_search" &&
    !input.filter.sourceIds &&
    input.bindings.every((binding) => binding.executionScope === "base" &&
      Boolean(binding.knowledgeBaseSnapshotId)) &&
    input.request.sourceAliases.every((alias) => alias.startsWith("B"));
  const scope = canUseBaseSnapshots
    ? Object.freeze({
        bindings: Object.freeze([...input.bindings]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((binding) => Object.freeze({
            bindingOrdinal: binding.ordinal,
            knowledgeBaseId: binding.knowledgeBaseId,
            knowledgeBaseSnapshotId: binding.knowledgeBaseSnapshotId
          }))),
        kind: "base_snapshots" as const
      })
    : resolvedSourceIds.length > 0 || input.request.operation === "discover_sources"
      ? Object.freeze({
          kind: "sources" as const,
          sourceIds: Object.freeze(resolvedSourceIds)
        })
      : null;
  if (!scope) return null;
  const common = Object.freeze({
    operation: input.request.operation,
    profileRevisionId: profileRevisionIds[0]!,
    scope,
    sourceAliases: [...input.request.sourceAliases]
  });
  switch (input.request.operation) {
    case "automatic_search":
      return Object.freeze({
        ...common,
        ...(input.request.focused
          ? { focused: input.request.focused }
          : { query: input.request.query }),
        operation: "automatic_search" as const
      });
    case "find_exact":
      return Object.freeze({
        ...common,
        exact: input.request.exact,
        operation: "find_exact" as const
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
        operation: "discover_sources" as const
      });
  }
}

function automaticSearchResultLimit(
  request: NonNullable<ReturnType<typeof parseKnowledgeExecutionRequest>>
): number {
  return request.operation === "automatic_search" && request.sourceAliases.length > 0
    ? KNOWLEDGE_SCOPED_RESULT_LIMIT
    : KNOWLEDGE_RESULT_LIMIT;
}

function reservationPriorBudgetState(
  legacy: KnowledgeBudgetState,
  record: ActiveStoredKnowledgeBudgetReservation,
  chargeAfter: Readonly<{
    candidateCount: number;
    costMicros: number;
    latencyMs: number;
    operationSlots: number;
    queryEmbeddingCalls: number;
    retrievedTokens: number;
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
      latencyMs: prior("latencyMs"),
      operations: prior("operationSlots"),
      queryEmbeddingCalls: prior("queryEmbeddingCalls"),
      retrievedTokens: prior("retrievedTokens")
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
    retrievedTokens: Math.ceil(evidence.results.reduce((total, result) =>
      total + result.includedTextBytes, 0) / 4)
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

function finalizedEvidence(input: Omit<KnowledgeRetrievalEvidence, "providerText">): KnowledgeRetrievalEvidence {
  const draft: KnowledgeRetrievalEvidence = { ...input, providerText: "pending" };
  const evidence = { ...draft, providerText: knowledgeToolResultText(draft) };
  if (Buffer.byteLength(evidence.providerText, "utf8") > KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES) {
    throw new Error("knowledge_provider_text_budget_exceeded");
  }
  return evidence;
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
    new Set(bindings.map((binding) => binding.ordinal)).size === bindings.length &&
    bindings.every((binding, index) =>
    Number.isSafeInteger(binding.ordinal) && binding.ordinal >= 0 &&
    binding.ordinal < KNOWLEDGE_SCOPE_MAX_BINDINGS &&
    (index === 0 || bindings[index - 1]!.ordinal < binding.ordinal) &&
    binding.baseContentRevision >= 0 &&
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
  embeddingRuntime: KnowledgeEmbeddingRuntimeResolver;
  /** Test seam for the monotonic elapsed-time source; never a wall clock. */
  monotonicNow?: () => number;
  /**
   * Installation reranker role for hosted reranking. When omitted, retrieval
   * stays fully deterministic and no reranker evidence is recorded.
   */
  rerankerRuntime?: KnowledgeRerankerRuntimeResolver;
  store: KnowledgeRetrievalStore;
}>): KnowledgeToolExecutor {
  const monotonicNow = input.monotonicNow ?? monotonicNowMilliseconds;
  const elapsedSince = (startedAt: number) =>
    elapsedMilliseconds(startedAt, monotonicNow());
  const staticPolicy = Object.freeze({
    candidateLimit: KNOWLEDGE_LANE_CANDIDATE_LIMIT,
    resultLimit: KNOWLEDGE_RESULT_LIMIT
  });

  const acceptedToolNames = new Set<string>([KNOWLEDGE_SEARCH_TOOL_NAME]);
  const reserveAtomicBudget = async (reservationInput: Readonly<{
    aliases: readonly KnowledgeScopeAlias[];
    bindings: readonly KnowledgeAcceptedBinding[];
    budgetState: KnowledgeBudgetState;
    call: ModelToolCall;
    context: ToolExecutionContext;
    filter: Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }>;
    modelRunToolCallId: string;
    request: NonNullable<ReturnType<typeof parseKnowledgeExecutionRequest>>;
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
    const usesSemanticRetrieval = reservationInput.request.operation === "automatic_search";
    const purposeLimit = reservationInput.request.operation === "find_exact"
      ? reservationInput.request.exact.limit
      : reservationInput.request.operation === "discover_sources"
        ? reservationInput.request.discovery.limit
        : null;
    const reservedCandidateLimit = purposeLimit ?? staticPolicy.candidateLimit;
    const reservedResultLimit = purposeLimit ?? automaticSearchResultLimit(
      reservationInput.request
    );
    const result = await input.budgetReservations.reserve({
      estimate: {
        candidateCount: reservedCandidateLimit,
        costMicros: 0,
        latencyMs: 1_000,
        queryEmbeddingCalls: usesSemanticRetrieval ? 1 : 0,
        retrievedTokens: reservedResultLimit * 512
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
    const request = parseKnowledgeExecutionRequest(call);
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
    if (!automaticSourceAliasesPreviouslyDisclosed(request, budgetState)) {
      return {
        kind: "rejected",
        result: errorResult(call, "knowledge_scope_alias_unavailable")
      };
    }
    if (!input.budgetReservations) return { kind: "admitted" };
    const bindings = await input.store.loadBindings({ runId, userId });
    if (!validBindings(bindings)) {
      return { kind: "rejected", result: errorResult(call, "knowledge_run_binding_unavailable") };
    }
    const aliases = input.store.loadScopeAliases
      ? await input.store.loadScopeAliases({ runId, userId })
      : [];
    const filter = aliasFilter(request.sourceAliases, aliases, request.operation);
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
    async execute(
      call: ModelToolCall,
      context: ToolExecutionContext,
      options?: { signal?: AbortSignal }
    ): Promise<ToolExecutionResult> {
      const request = parseKnowledgeExecutionRequest(call);
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
      if (!automaticSourceAliasesPreviouslyDisclosed(request, budgetState)) {
        return errorResult(call, "knowledge_scope_alias_unavailable");
      }
      const candidateLimit = staticPolicy.candidateLimit;
      const resultLimit = automaticSearchResultLimit(request);
      const anchorQuery = currentUserAnchorQuery(context, request);
      const startedAt = monotonicNow();
      const bindings = await input.store.loadBindings({ runId, userId: context.userId });
      if (!validBindings(bindings)) return errorResult(call, "knowledge_run_binding_unavailable");
      let aliases = input.store.loadScopeAliases
        ? await input.store.loadScopeAliases({ runId, userId: context.userId })
        : [];
      const filter = aliasFilter(request.sourceAliases, aliases, request.operation);
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
      const persist = async (
        evidence: KnowledgeRetrievalEvidence,
        canonicalSourceProvenance: readonly KnowledgeCanonicalSourceProvenance[] = []
      ) => {
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
          userId: context.userId!
        });
        const persistedEvidence = acceptedEvidence ?? evidence;
        return completedResult(call, persistedEvidence);
      };
      const persistExplicitUnavailable = async (failureCode: string) => {
        const durationMs = elapsedSince(startedAt);
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings),
          candidateCount: 0,
          candidateLimit,
          durationMs,
          embeddingExecutions: [],
          failureCode,
          fusion: "rrf_k60",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: "base_empty",
          query: request.query,
          resultLimit,
          results: [],
          scopeAliases: evidenceAliases(aliases, [], scopedBindings),
          version: KNOWLEDGE_RESULT_VERSION
        }));
      };
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
        const durationMs = elapsedSince(startedAt);
        return persist(finalizedEvidence({
          bases: baseEvidence(
            scopedBindings,
            search.candidateCounts,
            search.vectorSearchEvidence ?? [],
            true
          ),
          candidateCount: search.candidateCount,
          candidateLimit,
          durationMs,
          embeddingExecutions: [],
          fusion: "rrf_k60",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: results.length > 0 ? "complete" : "source_location_unavailable",
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
          resultLimit: readResultLimit,
          results,
          scopeAliases: evidenceAliases(
            aliases,
            results,
            scopedBindings,
            [sourceAlias.sourceArtifactId!]
          ),
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
        const durationMs = elapsedSince(startedAt);
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings, search.candidateCounts, [], true),
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
          outcome: results.length > 0 ? "complete" : "base_empty",
          query: request.query,
          resultLimit: request.exact.limit,
          results,
          scopeAliases: evidenceAliases(aliases, results, scopedBindings),
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
        const durationMs = elapsedSince(startedAt);
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings, discovery.candidateCounts, [], true),
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
          outcome: discovery.sources.length > 0 ? "complete" : "base_empty",
          query: request.query,
          resultLimit: request.discovery.limit,
          results: [],
          scopeAliases: discovery.sources.map((source) => ({
            alias: source.sourceAlias,
            kind: "source" as const,
            label: source.sourceName
          })),
          version: KNOWLEDGE_RESULT_VERSION
        }));
      }

      if (request.operation !== "automatic_search") {
        return persistExplicitUnavailable("knowledge_operation_not_applicable");
      }
      const groups = bindingGroups(scopedBindings);
      if (groups.length !== 1) throw new Error("knowledge_embedding_space_incompatible");

      const embeddingExecutions: KnowledgeEmbeddingExecutionEvidence[] = [];
      let semanticUnavailable = false;
      const semanticQueries = anchorQuery
        ? [anchorQuery, request.query]
        : [request.query];
      const vectors: Array<{
        bindingOrdinal: number;
        indexGenerationId: string;
        knowledgeBaseId: string;
        targetDimension: 1024 | 1536;
        vector: readonly number[];
      }> = [];
      for (const group of groups) {
        const embeddingStartedAt = monotonicNow();
        let runtime: KnowledgeAcceptedEmbeddingRuntime | null = null;
        try {
          runtime = await input.embeddingRuntime.resolve(group.bindings[0]!);
          const result = await runtime.adapter.embed({
            mode: "query",
            ...(options?.signal ? { signal: options.signal } : {}),
            texts: semanticQueries
          });
          throwIfAborted(options?.signal);
          if (result.vectors.length !== semanticQueries.length || result.vectors.some((vector) =>
            vector.length !== group.bindings[0]!.targetDimension ||
            vector.some((value) => !Number.isFinite(value)))) {
            throw new Error("embedding_response_dimension_mismatch");
          }
          embeddingExecutions.push({
            bindingOrdinals: group.bindings.map((binding) => binding.ordinal),
            durationMs: elapsedSince(embeddingStartedAt),
            inputTokens: result.usage.inputTokens ?? 0,
            modelId: runtime.configuration.upstreamModelId,
            provider: runtime.provider,
            providerModelId: runtime.providerModelId,
            requestId: result.requestId,
            status: "complete",
            totalTokens: result.usage.totalTokens ?? result.usage.inputTokens ?? 0
          });
          for (const binding of group.bindings) {
            for (const vector of result.vectors) {
              vectors.push({
                bindingOrdinal: binding.ordinal,
                indexGenerationId: binding.indexGenerationId,
                knowledgeBaseId: binding.knowledgeBaseId,
                targetDimension: binding.targetDimension,
                vector
              });
            }
          }
        } catch (error) {
          throwIfAborted(options?.signal);
          if (permitsLexicalQueryDegradation(error)) {
            semanticUnavailable = true;
            embeddingExecutions.push({
              bindingOrdinals: group.bindings.map((binding) => binding.ordinal),
              durationMs: elapsedSince(embeddingStartedAt),
              inputTokens: 0,
              modelId: runtime?.configuration.upstreamModelId ??
                group.snapshot.model.upstreamModelId,
              provider: runtime?.provider ?? group.snapshot.providerFamily,
              providerModelId: runtime?.providerModelId ??
                group.bindings[0]!.embeddingProviderModelId,
              requestId: null,
              status: "error",
              totalTokens: 0
            });
            continue;
          }
          throw new Error(safeFailureCode(error), { cause: error });
        }
      }

      // FR-4/FR-15: the installation reranker role is resolved and pinned per
      // accepted operation. Recovery replays the stored receipt above and
      // never reaches this resolution, so an accepted operation is immutable.
      const rerankResolution = input.rerankerRuntime
        ? await input.rerankerRuntime.resolve()
        : null;
      const rerankExecutor: KnowledgeRerankExecutor | null =
        rerankResolution?.kind === "ready"
          ? createKnowledgeRerankStage({
              adapter: rerankResolution.adapter,
              now: monotonicNow,
              pin: rerankResolution.pin,
              query: request.query
            })
          : null;
      const search = await input.store.hybridSearch({
        ...(anchorQuery ? { anchorQuery } : {}),
        ...(filter.bindingOrdinals ? { bindingOrdinals: filter.bindingOrdinals } : {}),
        candidateLimit,
        excludedOccurrenceKeys: budgetState.priorOccurrenceKeys,
        operation: request.operation,
        query: request.query,
        ...(rerankExecutor
          ? {
              rerank: {
                executor: rerankExecutor,
                ...(options?.signal ? { signal: options.signal } : {})
              }
            }
          : {}),
        resultLimit,
        runId,
        ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {}),
        userId: context.userId,
        vectors
      });
      if (search.bindingCount !== scopedBindings.length ||
        Object.values(search.candidateCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error("knowledge_hybrid_result_invalid");
      }
      const ranking = search.rankingEvidence;
      const lexicalBackend = search.lexicalBackendEvidence;
      if (!ranking || ranking.fusion !== "weighted_rrf_v2" ||
        ranking.candidateOrder.length !== search.candidateCount ||
        (search.candidateCount > 0 && search.passages.length === 0) ||
        lexicalBackend?.backendKind !== "opensearch_bm25_v1" ||
        lexicalBackend.rankingProfileVersion !== 5 ||
        lexicalBackend.status !== "complete") {
        throw new Error("knowledge_hybrid_ranking_invalid");
      }
      const rerankerBinding: KnowledgeRerankerBindingEvidenceV2 | undefined =
        rerankResolution === null
          ? undefined
          : rerankResolution.kind === "absent"
            ? knowledgeRerankerDisabledEvidence()
            : rerankResolution.kind === "unavailable"
              ? knowledgeRerankerUnavailableEvidence({
                  selectedProviderModelId: rerankResolution.selectedProviderModelId
                })
              : search.rerankerBinding;
      if (rerankResolution?.kind === "ready" && !rerankerBinding) {
        throw new Error("knowledge_reranker_evidence_missing");
      }
      if (search.canonicalSourceProvenance?.length &&
        input.store.materializeScopeAliases && input.store.loadScopeAliases) {
        await input.store.materializeScopeAliases({
          runId,
          sourceProvenance: search.canonicalSourceProvenance,
          userId: context.userId
        });
        aliases = await input.store.loadScopeAliases({ runId, userId: context.userId });
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
      if (search.candidateCount > 0 && results.length === 0) {
        throw new Error("knowledge_evidence_package_empty");
      }
      const retrievalOutcome: KnowledgeRetrievalOutcome = results.length > 0
        ? "complete"
        : scopedBindings.some((binding) =>
              binding.indexedContentRevision < binding.baseContentRevision)
            ? "base_indexing"
            : "no_relevant_evidence";
      const durationMs = elapsedSince(startedAt);
      return persist(finalizedEvidence({
        bases: baseEvidence(
          scopedBindings,
          search.candidateCounts,
          search.vectorSearchEvidence ?? []
        ),
        candidateCount: search.candidateCount,
        candidateLimit,
        durationMs,
        embeddingExecutions,
        ...(semanticUnavailable
          ? { failureCode: "semantic_retrieval_unavailable" }
          : budgetState.excludedResources
            ? { failureCode: "partial_sources_ready" }
            : {}),
        fusion: ranking.fusion,
        invocationOrdinal: budgetState.invocationOrdinal,
        lexicalBackend,
        operation: request.operation,
        outcome: retrievalOutcome,
        query: request.query,
        ...(rerankerBinding ? { rerankerBinding } : {}),
        resultLimit,
        results: retrievalOutcome === "complete" ? results : [],
        scopeAliases: evidenceAliases(aliases, results, scopedBindings),
        version: KNOWLEDGE_RESULT_VERSION
      }), search.canonicalSourceProvenance ?? []);
      } catch (error) {
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
    tools: Object.freeze([knowledgeRetrievalTool])
  };
}
