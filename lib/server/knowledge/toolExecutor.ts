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
  type KnowledgeHybridSearchResult,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeRetrievedPassageEvidence,
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
import {
  knowledgeFollowUpTools,
  knowledgeRetrievalTool,
  parseKnowledgeSemanticToolRequest
} from "./knowledgeTools";
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
  budgetState?(input: Readonly<{
    modelRunToolCallId: string;
    operation: KnowledgeOperationKind;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetState | null>;
  hybridSearch(input: Readonly<{
    bindingOrdinals?: readonly number[];
    candidateLimit: number;
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
  invocationOrdinal(input: Readonly<{
    modelRunToolCallId: string;
    runId: string;
    toolName: string;
    userId: string;
  }>): Promise<number | null>;
  loadBindings(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<readonly KnowledgeAcceptedBinding[]>;
  loadScopeAliases?(input: Readonly<{
    runId: string;
    userId: string;
  }>): Promise<readonly KnowledgeScopeAlias[]>;
  persistReceipt(input: Readonly<{
    evidence: KnowledgeRetrievalEvidence;
    modelRunToolCallId: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeRetrievalEvidence | void>;
  structuredSearch?(input: Readonly<{
    bindings: readonly KnowledgeAcceptedBinding[];
    query: string;
    signal?: AbortSignal;
    sourceArtifactIds: readonly string[];
  }>): Promise<StructuredKnowledgeSearchResult>;
  visualSearch?(input: Readonly<{
    bindings: readonly KnowledgeAcceptedBinding[];
    query: string;
    signal?: AbortSignal;
    sourceArtifactIds: readonly string[];
  }>): Promise<KnowledgeVisualSearchResult>;
}>;

export type KnowledgeScopeAlias = Readonly<{
  alias: string;
  bindingOrdinal: number;
  kind: "base" | "source";
  label: string;
  sourceArtifactId?: string;
  sourceId?: string;
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
  tools?: readonly RunTool[];
}>;

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

function baseEvidence(
  bindings: readonly KnowledgeAcceptedBinding[],
  candidateCounts: Readonly<Record<number, number>> = {},
  vectorSearchEvidence: readonly KnowledgeVectorSearchEvidence[] = []
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
        : candidateCount === 0 ? "empty" : "ready",
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

function includedPassages(
  passages: KnowledgeHybridSearchResult["passages"],
  evidenceOffset: number,
  maximumBytes = KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES
): KnowledgeRetrievedPassageEvidence[] {
  if (passages.length === 0) return [];
  // Four KiB is reserved for fixed instructions, handles, pages, separators,
  // and honest truncation markers. The remaining byte budget is divided so
  // every selected result reaches the model rather than one chunk monopolizing it.
  const perPassageBytes = Math.max(
    1,
    Math.floor((Math.max(4 * 1024 + 1, maximumBytes) - 4 * 1024) / passages.length)
  );
  return passages.map(({ text, ...passage }, index) => {
    const includedText = truncateUtf8(text, perPassageBytes);
    const includedTextBytes = Buffer.byteLength(includedText, "utf8");
    const sourceTextBytes = Buffer.byteLength(text, "utf8");
    return {
      ...passage,
      handle: `K${evidenceOffset + index + 1}`,
      includedText,
      includedTextBytes,
      sourceTextBytes,
      textTruncated: includedTextBytes < sourceTextBytes
    };
  });
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
    subqueriesInCurrentPhase: invocationOrdinal
  };
}

function aliasFilter(
  requested: readonly string[],
  aliases: readonly KnowledgeScopeAlias[]
): Readonly<{ bindingOrdinals?: readonly number[]; sourceIds?: readonly string[] }> | null {
  if (requested.length === 0) return {};
  const byAlias = new Map(aliases.map((alias) => [alias.alias, alias]));
  const resolved = requested.map((alias) => byAlias.get(alias));
  if (resolved.some((alias) => !alias)) return null;
  const kinds = new Set(resolved.map((alias) => alias!.kind));
  if (kinds.size !== 1) return null;
  const bindingOrdinals = [...new Set(resolved.map((alias) => alias!.bindingOrdinal))].sort(
    (left, right) => left - right
  );
  if (kinds.has("base")) return { bindingOrdinals };
  const sourceIds = resolved.map((alias) => alias!.sourceId);
  if (sourceIds.some((sourceId) => !sourceId)) return null;
  return { bindingOrdinals, sourceIds: sourceIds as string[] };
}

function evidenceAliases(
  aliases: readonly KnowledgeScopeAlias[],
  passages: readonly KnowledgeRetrievedPassageEvidence[],
  bindings: readonly KnowledgeAcceptedBinding[]
): readonly Readonly<{ alias: string; kind: "base" | "source"; label: string }>[] {
  const artifactIds = new Set(passages.flatMap((passage) =>
    passage.sourceArtifactId ? [passage.sourceArtifactId] : []));
  const bindingOrdinals = new Set(passages.map((passage) => passage.bindingOrdinal));
  const selected = aliases.filter((alias) => alias.kind === "source"
    ? Boolean(alias.sourceArtifactId && artifactIds.has(alias.sourceArtifactId))
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
  candidateLimit?: number;
  embeddingRuntime: KnowledgeEmbeddingRuntimeResolver;
  policy?: KnowledgeRetrievalPolicyResolver;
  resultLimit?: number;
  scoreThreshold?: number;
  store: KnowledgeRetrievalStore;
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
  return {
    accepts: (name) => acceptedToolNames.has(name),
    capability: "knowledge",
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
      let budgetState: KnowledgeBudgetState | null;
      if (input.store.budgetState) {
        budgetState = await input.store.budgetState({
          modelRunToolCallId,
          operation: request.operation,
          runId,
          userId: context.userId
        });
      } else {
        const invocationOrdinal = await input.store.invocationOrdinal({
          modelRunToolCallId,
          runId,
          toolName: call.name,
          userId: context.userId
        });
        budgetState = invocationOrdinal === null ? null : {
          evidenceCount: invocationOrdinal === null
            ? 0
            : (invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT,
          invocationOrdinal,
          policy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          priorContentHashes: [],
          stopReason: null,
          usage: fallbackBudgetUsage(invocationOrdinal, request.operation)
        };
      }
      if (!budgetState || budgetState.invocationOrdinal < 1 ||
        budgetState.invocationOrdinal > 256) {
        return errorResult(call, "knowledge_run_context_unavailable");
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
      const filter = aliasFilter(request.sourceAliases, aliases);
      if (!filter) return errorResult(call, "knowledge_scope_alias_unavailable");
      const scopedBindings = filter.bindingOrdinals
        ? bindings.filter((binding) => filter.bindingOrdinals!.includes(binding.ordinal))
        : bindings;
      if (scopedBindings.length < 1) {
        return errorResult(call, "knowledge_scope_alias_unavailable");
      }
      throwIfAborted(options?.signal);

      const persist = async (evidence: KnowledgeRetrievalEvidence) => {
        const acceptedEvidence = await input.store.persistReceipt({
          evidence,
          modelRunToolCallId,
          runId,
          userId: context.userId!
        });
        const persistedEvidence = acceptedEvidence ?? evidence;
        return {
          callId: call.id,
          content: knowledgeToolResultContent(persistedEvidence),
          name: call.name,
          rawPreview: {
            knowledgeRetrieval: persistedEvidence,
            knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
            providerCall: true
          },
          status: "complete" as const,
          usage: aggregateKnowledgeUsage(
            persistedEvidence.embeddingExecutions,
            persistedEvidence.results
          )
        };
      };

      if (budgetState.stopReason) {
        return persist(finalizedEvidence({
          bases: baseEvidence(scopedBindings),
          budget: {
            noveltyRatio: null,
            operation: request.operation,
            stopReason: budgetState.stopReason,
            usage: budgetState.usage,
            version: 1
          },
          candidateCount: 0,
          candidateLimit,
          durationMs: 0,
          embeddingExecutions: [],
          fusion: "rrf_k60",
          invocationOrdinal: budgetState.invocationOrdinal,
          operation: request.operation,
          outcome: "budget_exhausted",
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
      }

      if (request.operation === "automatic_search" && input.store.structuredSearch &&
        isStructuredDataQuery(request.query)) {
        let structured: StructuredKnowledgeSearchResult | null = null;
        try {
          structured = await input.store.structuredSearch({
            bindings: scopedBindings,
            query: request.query,
            ...(options?.signal ? { signal: options.signal } : {}),
            sourceArtifactIds: admittedSourceArtifactIds({
              aliases,
              bindings: scopedBindings,
              ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {})
            })
          });
        } catch {
          throwIfAborted(options?.signal);
          // Structured artifacts are an additional exactness lane. Ordinary
          // lexical/vector retrieval remains available if that lane is damaged.
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
          const results = includedPassages(
            [structured.passage],
            budgetState.evidenceCount ??
              (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT
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
          }));
        }
      }

      if (request.operation === "automatic_search" && input.store.visualSearch &&
        isVisualKnowledgeQuery(request.query)) {
        let visual: KnowledgeVisualSearchResult | null = null;
        try {
          visual = await input.store.visualSearch({
            bindings: scopedBindings,
            query: request.query,
            ...(options?.signal ? { signal: options.signal } : {}),
            sourceArtifactIds: admittedSourceArtifactIds({
              aliases,
              bindings: scopedBindings,
              ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {})
            })
          });
        } catch {
          throwIfAborted(options?.signal);
          // Visual evidence is additive. Provider, object, or index failures
          // leave the ordinary text retrieval path intact.
        }
        if (visual?.kind === "complete") {
          const results = includedPassages(
            [visual.passage],
            budgetState.evidenceCount ??
              (budgetState.invocationOrdinal - 1) * KNOWLEDGE_RESULT_LIMIT
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
          }));
        }
      }

      let groups: ReturnType<typeof bindingGroups> = [];
      let embeddingFailureCode: string | undefined;
      if (request.operation !== "find_exact" && request.operation !== "discover_sources") {
        try {
          groups = bindingGroups(scopedBindings);
        } catch (error) {
          // An invalid or unavailable embedding binding degrades only the vector
          // lane. The accepted run/snapshot still authorizes lexical and exact
          // retrieval, and no provider execution is fabricated here.
          embeddingFailureCode = safeFailureCode(error);
        }
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
      }));
    },
    tool: knowledgeRetrievalTool,
    tools: knowledgeFollowUpTools
  };
}
