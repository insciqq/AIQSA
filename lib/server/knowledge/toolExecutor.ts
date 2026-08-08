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
import { validateKnowledgeToolArguments } from "./retrievalQuery";
import {
  aggregateKnowledgeUsage,
  knowledgeToolResultContent,
  knowledgeToolResultText
} from "./toolResult";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_MAX_INVOCATIONS,
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SCORE_THRESHOLD,
  KNOWLEDGE_TOOL_NAME,
  type KnowledgeAcceptedBinding,
  type KnowledgeBaseRetrievalEvidence,
  type KnowledgeEmbeddingExecutionEvidence,
  type KnowledgeHybridSearchResult,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievalOutcome,
  type KnowledgeRetrievedPassageEvidence
} from "./retrievalTypes";

export const knowledgeRetrievalTool: RunTool = Object.freeze({
  capability: "knowledge",
  description:
    "Search the private Knowledge sources accepted for this run with one concise query. " +
    `Use this tool at most ${KNOWLEDGE_MAX_INVOCATIONS} times for this answer.`,
  inputSchema: {
    additionalProperties: false,
    properties: {
      query: {
        description: "The concise semantic and keyword retrieval query.",
        maxLength: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      }
    },
    required: ["query"],
    type: "object"
  },
  name: KNOWLEDGE_TOOL_NAME,
  strict: true
});

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
  hybridSearch(input: Readonly<{
    candidateLimit: number;
    query: string;
    resultLimit: number;
    runId: string;
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
  persistReceipt(input: Readonly<{
    evidence: KnowledgeRetrievalEvidence;
    modelRunToolCallId: string;
    runId: string;
    userId: string;
  }>): Promise<void>;
}>;

export type KnowledgeEmbeddingRuntimeResolver = Readonly<{
  resolve(binding: KnowledgeAcceptedBinding): Promise<KnowledgeAcceptedEmbeddingRuntime>;
}>;

export type KnowledgeToolExecutor = ToolExecutor & Readonly<{
  accepts(name: string): boolean;
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
    rawPreview: {
      finalProviderResponsePreview: { error: code },
      providerCall: false,
      requestPreview: {
        queryCharacters: typeof call.arguments.query === "string"
          ? Math.min(call.arguments.query.length, KNOWLEDGE_QUERY_MAX_CHARACTERS + 1)
          : 0
      }
    },
    status: "error",
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  };
}

function baseEvidence(
  bindings: readonly KnowledgeAcceptedBinding[],
  candidateCounts: Readonly<Record<number, number>> = {}
): KnowledgeBaseRetrievalEvidence[] {
  return bindings.map((binding) => {
    const candidateCount = candidateCounts[binding.ordinal] ?? 0;
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
  invocationOrdinal: number
): KnowledgeRetrievedPassageEvidence[] {
  if (passages.length === 0) return [];
  // Four KiB is reserved for fixed instructions, handles, pages, separators,
  // and honest truncation markers. The remaining byte budget is divided so
  // every selected result reaches the model rather than one chunk monopolizing it.
  const perPassageBytes = Math.max(
    1,
    Math.floor((KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES - 4 * 1024) / passages.length)
  );
  return passages.map(({ text, ...passage }, index) => {
    const includedText = truncateUtf8(text, perPassageBytes);
    const includedTextBytes = Buffer.byteLength(includedText, "utf8");
    const sourceTextBytes = Buffer.byteLength(text, "utf8");
    return {
      ...passage,
      handle: `K${invocationOrdinal}.${index + 1}`,
      includedText,
      includedTextBytes,
      sourceTextBytes,
      textTruncated: includedTextBytes < sourceTextBytes
    };
  });
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
  return bindings.length >= 1 && bindings.length <= 3 && bindings.every((binding, index) =>
    binding.ordinal === index && binding.baseContentRevision >= 0 &&
    binding.indexedContentRevision >= 0 &&
    (binding.targetDimension === 1024 || binding.targetDimension === 1536) &&
    /^[0-9a-f]{64}$/u.test(binding.vectorSpaceFingerprint));
}

export function createKnowledgeToolExecutor(input: Readonly<{
  candidateLimit?: number;
  embeddingRuntime: KnowledgeEmbeddingRuntimeResolver;
  resultLimit?: number;
  scoreThreshold?: number;
  store: KnowledgeRetrievalStore;
}>): KnowledgeToolExecutor {
  const candidateLimit = input.candidateLimit ?? KNOWLEDGE_CANDIDATE_LIMIT;
  const resultLimit = input.resultLimit ?? KNOWLEDGE_RESULT_LIMIT;
  const threshold = input.scoreThreshold ?? KNOWLEDGE_SCORE_THRESHOLD;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < resultLimit || candidateLimit > 100 ||
    !Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > KNOWLEDGE_RESULT_LIMIT ||
    !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("knowledge_retrieval_configuration_invalid");
  }

  return {
    accepts: (name) => name === KNOWLEDGE_TOOL_NAME,
    capability: "knowledge",
    async execute(
      call: ModelToolCall,
      context: ToolExecutionContext,
      options?: { signal?: AbortSignal }
    ): Promise<ToolExecutionResult> {
      const validation = validateKnowledgeToolArguments(call.arguments);
      if (!validation.ok) return errorResult(call, validation.code);
      const runId = context.runId;
      const modelRunToolCallId = context.persistedToolCallId;
      if (!runId || !modelRunToolCallId || !context.userId) {
        return errorResult(call, "knowledge_run_context_unavailable");
      }
      const invocationOrdinal = await input.store.invocationOrdinal({
        modelRunToolCallId,
        runId,
        toolName: KNOWLEDGE_TOOL_NAME,
        userId: context.userId
      });
      if (invocationOrdinal === null) {
        return errorResult(call, "knowledge_run_context_unavailable");
      }
      if (invocationOrdinal > KNOWLEDGE_MAX_INVOCATIONS) {
        return errorResult(
          call,
          "knowledge_invocation_limit_reached",
          "Knowledge retrieval limit reached. Continue with the Knowledge evidence already returned."
        );
      }
      const startedAt = Date.now();
      const bindings = await input.store.loadBindings({ runId, userId: context.userId });
      if (!validBindings(bindings)) return errorResult(call, "knowledge_run_binding_unavailable");
      throwIfAborted(options?.signal);

      const persist = async (evidence: KnowledgeRetrievalEvidence) => {
        await input.store.persistReceipt({
          evidence,
          modelRunToolCallId,
          runId,
          userId: context.userId!
        });
        return {
          callId: call.id,
          content: knowledgeToolResultContent(evidence),
          name: call.name,
          rawPreview: {
            finalProviderResponsePreview: { knowledgeRetrieval: evidence },
            knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
            providerCall: true,
            requestPreview: {
              candidateLimit,
              invocationOrdinal,
              queryCharacters: validation.query.length,
              resultLimit,
              threshold
            }
          },
          status: "complete" as const,
          usage: aggregateKnowledgeUsage(evidence.embeddingExecutions)
        };
      };

      if (bindings.some((binding) =>
        binding.indexedContentRevision < binding.baseContentRevision)) {
        return persist(finalizedEvidence({
          bases: baseEvidence(bindings),
          candidateCount: 0,
          candidateLimit,
          durationMs: Date.now() - startedAt,
          embeddingExecutions: [],
          fusion: "rrf_k60",
          invocationOrdinal,
          outcome: "base_indexing",
          postRerankOrder: null,
          preRerankOrder: null,
          query: validation.query,
          rerankerBinding: null,
          resultLimit,
          results: [],
          threshold,
          version: KNOWLEDGE_RESULT_VERSION
        }));
      }

      let groups: ReturnType<typeof bindingGroups>;
      try {
        groups = bindingGroups(bindings);
      } catch (error) {
        const failureCode = safeFailureCode(error);
        return persist(finalizedEvidence({
          bases: baseEvidence(bindings),
          candidateCount: 0,
          candidateLimit,
          durationMs: Date.now() - startedAt,
          // Snapshot validation failed before an embedding request existed;
          // do not fabricate execution identity or zero-token provider usage.
          embeddingExecutions: [],
          failureCode,
          fusion: "rrf_k60",
          invocationOrdinal,
          outcome: "embedding_model_unavailable",
          postRerankOrder: null,
          preRerankOrder: null,
          query: validation.query,
          rerankerBinding: null,
          resultLimit,
          results: [],
          threshold,
          version: KNOWLEDGE_RESULT_VERSION
        }));
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
            texts: [validation.query]
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
          const failureCode = safeFailureCode(error);
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
          return persist(finalizedEvidence({
            bases: baseEvidence(bindings),
            candidateCount: 0,
            candidateLimit,
            durationMs: Date.now() - startedAt,
            embeddingExecutions,
            failureCode,
            fusion: "rrf_k60",
            invocationOrdinal,
            outcome: "embedding_model_unavailable",
            postRerankOrder: null,
            preRerankOrder: null,
            query: validation.query,
            rerankerBinding: null,
            resultLimit,
            results: [],
            threshold,
            version: KNOWLEDGE_RESULT_VERSION
          }));
        }
      }

      const search = await input.store.hybridSearch({
        candidateLimit,
        query: validation.query,
        resultLimit,
        runId,
        threshold,
        userId: context.userId,
        vectors
      });
      if (search.bindingCount !== bindings.length ||
        Object.values(search.candidateCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error("knowledge_hybrid_result_invalid");
      }
      const results = includedPassages(search.passages, invocationOrdinal);
      const retrievalOutcome: KnowledgeRetrievalOutcome = search.candidateCount === 0
        ? "base_empty"
        : results.length === 0 ? "zero_above_threshold" : "complete";
      return persist(finalizedEvidence({
        bases: baseEvidence(bindings, search.candidateCounts),
        candidateCount: search.candidateCount,
        candidateLimit,
        durationMs: Date.now() - startedAt,
        embeddingExecutions,
        fusion: "rrf_k60",
        invocationOrdinal,
        outcome: retrievalOutcome,
        postRerankOrder: null,
        preRerankOrder: null,
        query: validation.query,
        rerankerBinding: null,
        resultLimit,
        results: retrievalOutcome === "complete" ? results : [],
        threshold,
        version: KNOWLEDGE_RESULT_VERSION
      }));
    },
    tool: knowledgeRetrievalTool
  };
}
