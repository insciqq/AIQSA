import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createAcceptedDecisionRuntime, type AcceptedDecisionRuntimeBinding } from "../providerRuntime/decisionRuntime";
import { DecisionAdapterError, type DecisionReceipt, type DecisionResult } from "../providers/decisions";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { logEvent } from "../observability";
import { formatKnowledgeRerankCandidate } from "./rerankCandidateFormatter";
import { createKnowledgeRelevanceRepository, type KnowledgeRelevanceOwner, type KnowledgeRelevanceRepository } from "./relevanceRepository";
import { KNOWLEDGE_RELEVANCE_QUESTION, KNOWLEDGE_RELEVANCE_VERSION, qualifiedKnowledgeDecisionModel,
  type KnowledgeRelevanceEvidence } from "./relevancePolicy";
import { loadAcceptedKnowledgeRelevanceRole, type KnowledgeRelevanceRoleResolution } from "./relevanceBinding";

// One small fan-out on already selected passages, inside the Knowledge tool's
// deadline. Optional filtering must not hold a chat through a provider outage.
export const KNOWLEDGE_RELEVANCE_TIMEOUT_MS = 4_000;
export const KNOWLEDGE_RELEVANCE_CONCURRENCY = 4;
type Passage = Readonly<{ chunkId: string; includedText: string; sourceName?: string; fileName: string; headingPath?: readonly string[] }>;
export type KnowledgeRelevanceInput = KnowledgeRelevanceOwner & Readonly<{
  query: string; passages: readonly Passage[]; signal?: AbortSignal;
  authorize(): Promise<void>;
}>;
export type KnowledgeRelevanceExecutor = (input: KnowledgeRelevanceInput) => Promise<KnowledgeRelevanceEvidence | null>;
type Dependencies = Readonly<{
  repository: KnowledgeRelevanceRepository;
  resolveRole(owner: KnowledgeRelevanceOwner): Promise<KnowledgeRelevanceRoleResolution>;
  runtime(role: Extract<KnowledgeRelevanceRoleResolution, { ok: true }>): Promise<AcceptedDecisionRuntimeBinding>;
  timeoutMs?: number;
}>;

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createKnowledgeRelevanceService(deps: Dependencies): KnowledgeRelevanceExecutor {
  let cooldown: { model: string; until: number } | null = null;
  return async input => {
    input.signal?.throwIfAborted();
    if (!input.passages.length) return null;
    if (!input.query.trim() || new Set(input.passages.map(p => p.chunkId)).size !== input.passages.length) {
      throw new Error("knowledge_relevance_input_invalid");
    }
    const startedAt = performance.now();
    const role = await deps.resolveRole(input);
    if (!role.ok) return null;
    const evidence = (failureCode: string | null, attemptIds: readonly string[] = [], scores: readonly number[] = []): KnowledgeRelevanceEvidence => {
      const durationMs = Math.round(performance.now() - startedAt);
      logEvent("tool_execution", { tool_kind: "knowledge", operation_stage: "relevance", stage: "execution",
        outcome: failureCode ? "degraded" : "completed", duration_ms: durationMs, count: input.passages.length,
        ...(failureCode ? { code: failureCode, action: "degrade" as const } : {}) });
      return { version: 1, status: failureCode ? "unavailable" : "complete", failureCode, durationMs,
        chunkIds: input.passages.map(p => p.chunkId), attemptIds: attemptIds.filter(Boolean), scores: failureCode ? [] : scores };
    };
    if (!qualifiedKnowledgeDecisionModel(role.role.snapshot)) return null;
    const modelKey = createHash("sha256").update(JSON.stringify(role.role.snapshot)).digest("hex");
    if (cooldown?.model === modelKey && cooldown.until > Date.now()) return evidence("decision_provider_cooldown");
    const runtime = await deps.runtime(role);
    await input.authorize();
    input.signal?.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("knowledge_relevance_timeout")), deps.timeoutMs ?? KNOWLEDGE_RELEVANCE_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout.signal, ...(input.signal ? [input.signal] : [])]);
    let next = 0;
    let failure: string | null = null;
    const attemptIds: string[] = [];
    const scores: number[] = [];
    const invoke = async (index: number) => {
      const passage = input.passages[index]!;
      const request = { state: { query: input.query, passage: formatKnowledgeRerankCandidate({
        sourceName: passage.sourceName ?? passage.fileName, headingPath: passage.headingPath ?? [], text: passage.includedText
      }) }, questions: { useful: KNOWLEDGE_RELEVANCE_QUESTION } };
      signal.throwIfAborted();
      const id = await deps.repository.start({ ...input, ordinal: index + 1, executionSnapshot: role.role.snapshot,
        inputHash: createHash("sha256").update(JSON.stringify({ version: KNOWLEDGE_RELEVANCE_VERSION, request })).digest("hex") });
      if (!id) { failure ??= "knowledge_relevance_already_attempted"; return; }
      attemptIds[index] = id;
      let receipt: DecisionReceipt | null = null;
      let pending: Promise<DecisionResult> | null = null;
      let usefulness: number | null = null;
      let code: string | null = null;
      let dispatched = false;
      try {
        signal.throwIfAborted();
        dispatched = true;
        pending = runtime.adapter.decide({ ...request, signal });
        const result = await untilAborted(pending, signal);
        receipt = result;
        signal.throwIfAborted();
        const answer = result.answers.useful;
        if (Object.keys(result.answers).length !== 1 || answer?.type !== "noul" ||
          !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new DecisionAdapterError("decision_response_invalid", { receipt });
        usefulness = answer.noul;
      } catch (error) {
        if (error instanceof DecisionAdapterError) receipt = error.receipt ?? receipt;
        if (!receipt && (error instanceof ProviderAdmissionError || error instanceof DecisionAdapterError &&
          ["decision_input_invalid", "decision_request_too_large"].includes(error.code))) dispatched = false;
        code = signal.aborted ? "knowledge_relevance_cancelled" :
          error instanceof DecisionAdapterError || error instanceof ProviderAdmissionError ? error.code : "knowledge_relevance_unavailable";
        failure ??= code;
        if (timeout.signal.aborted || error instanceof DecisionAdapterError && (
          error.code === "decision_provider_request_failed" || error.code === "decision_request_timed_out" ||
          error.code === "decision_provider_http_error" && (error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500))) {
          cooldown = { model: modelKey, until: Date.now() + Math.max(30_000, error instanceof DecisionAdapterError ? error.retryAfterMs ?? 0 : 0) };
        }
      }
      await deps.repository.settle(input, id, { receipt, usefulness, failureCode: code, dispatched });
      if (usefulness !== null) scores[index] = usefulness;
      if (!receipt && pending) {
        // A delayed response may enrich the same usage row, never the result
        // already returned to retrieval. There is no second provider request.
        void pending.then(value => value as DecisionReceipt, (error: unknown) => error instanceof DecisionAdapterError ? error.receipt : null)
          .then(async late => { if (late) await deps.repository.settle(input, id, {
            receipt: late, usefulness: null, failureCode: "knowledge_relevance_cancelled", dispatched: true
          }); }).catch(() => undefined);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(KNOWLEDGE_RELEVANCE_CONCURRENCY, input.passages.length) }, async () => {
        while (!failure && !signal.aborted && next < input.passages.length) {
          try { await invoke(next++); }
          catch (error) { if (!signal.aborted) throw error; failure ??= "knowledge_relevance_cancelled"; }
        }
      }));
      input.signal?.throwIfAborted();
      return evidence(failure ?? (signal.aborted || scores.filter(n => n !== undefined).length !== input.passages.length
        ? "knowledge_relevance_unavailable" : null), attemptIds, scores);
    } finally { clearTimeout(timer); }
  };
}

export function createPrismaKnowledgeRelevanceService(db: PrismaClient): KnowledgeRelevanceExecutor {
  const runtime = createAcceptedDecisionRuntime(db);
  return createKnowledgeRelevanceService({ repository: createKnowledgeRelevanceRepository(db),
    resolveRole: owner => loadAcceptedKnowledgeRelevanceRole(db, owner),
    runtime: role => runtime.resolve({ ...role.role.authority, executionSnapshot: role.role.snapshot }) });
}
