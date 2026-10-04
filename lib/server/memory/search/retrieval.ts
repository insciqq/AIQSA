import { fuseMemoryRetrievalCandidates, packMemoryPersonalContext, planMemoryRetrieval,
  type MemoryContextPack, type MemoryRankedCandidate, type MemoryRetrievalPlan } from "../../../domain/memory/retrieval";
import { createPrismaLocalMemoryRetrievalRepository, type MemoryLocalRetrievalSnapshot } from "../retrieval/localRepository";
import { createPrismaMemoryVectorRepository } from "../retrieval/vector";
import { createPrismaMemoryRunUtilityService } from "../retrieval/runUtilities";
import { memoryRelevanceCandidates, applyMemoryRelevance, atomicMemoryRerankResult } from "../retrieval/runAdmission";
import type { PrismaClient } from "@prisma/client";
import type { MemorySearchSnapshot } from "./contract";
import type { MemoryPreparingItemInput } from "../../runs/preparingRun";
import { memorySha256 } from "../persistence/lexical";
import { abortableMemoryRead } from "../retrieval/deadline";
import { estimateApproxTokens } from "../../../domain/contextBudget";
import { memoryReadBudgetFailureCode } from "../retrieval/readBudget";
import { memoryReadableChatMode } from "../scheduledPrompt";

const diagnosticCodes = new Set([
  "memory_read_admission_timeout", "memory_read_connection_timeout", "memory_read_deadline_exhausted",
  "memory_read_lock_timeout", "memory_read_statement_timeout", "memory_read_transaction_expired", "memory_execution_policy_drift",
  "memory_execution_target_unavailable", "memory_execution_state_conflict", "memory_execution_binding_conflict",
  "memory_vector_generation_stale", "memory_vector_profile_unsupported", "memory_vector_settle_timeout", "memory_vector_unavailable",
  "memory_query_embedding_attempt_timed_out", "memory_query_embedding_failed", "memory_query_embedding_outcome_unknown",
  "memory_query_embedding_output_invalid", "memory_query_embedding_profile_changed", "memory_query_embedding_runtime_unavailable",
  "memory_query_embedding_transient_http_failure", "memory_reranker_failed", "memory_reranker_model_unavailable",
  "memory_reranker_outcome_unknown", "memory_reranker_runtime_unavailable", "memory_reranker_transient_http_failure",
  "memory_run_utility_binding_changed", "memory_run_utility_binding_invalid", "memory_run_utility_cancelled",
  "memory_run_utility_outcome_unknown", "memory_run_utility_output_invalid", "memory_run_utility_provider_failed",
  "memory_run_utility_settle_failed", "memory_run_utility_start_failed", "memory_run_utility_unavailable", "memory_utility_input_blocked",
  "memory_lexical_lane_unavailable", "memory_lexical_projection_not_ready", "memory_lexical_shadow_capacity",
  "memory_lexical_settle_timeout", "memory_opensearch_authentication_failed", "memory_opensearch_canonical_guard",
  "memory_opensearch_circuit_open", "memory_opensearch_connection_failed", "memory_opensearch_index_incompatible",
  "memory_opensearch_index_missing", "memory_opensearch_rate_limited", "memory_opensearch_response_invalid",
  "memory_opensearch_response_too_large", "memory_opensearch_scope_too_large", "memory_opensearch_timeout", "memory_opensearch_unavailable"
]);
function diagnosticCode(value: unknown, fallback: string): string {
  const budget = memoryReadBudgetFailureCode(value);
  if (budget) return budget;
  const code = typeof value === "string" ? value : typeof value === "object" && value !== null && "code" in value ? value.code : null;
  return typeof code === "string" && diagnosticCodes.has(code) ? code : fallback;
}
export type MemorySearchDiagnosticEvidence = Readonly<{
  version: 1;
  reasons: readonly Readonly<{ stage: string; code: string }>[];
  factsLexicalState: string; historyLexicalState: string; factsVectorState: string; historyVectorState: string;
  lexicalFailureCount: number; lexicalFailureCodes: readonly string[];
  fusedCount: number; expandedBeforeRerankCount: number; rerankCandidateCount: number;
  rankedAfterRerankCount: number; expandedFinalCount: number; packedCount: number;
}>;

export type MemorySearchRetrieved = Readonly<{
  pack: MemoryContextPack; snapshot: MemoryLocalRetrievalSnapshot;
  items: readonly MemoryPreparingItemInput[]; limited: boolean;
  diagnosticEvidence: MemorySearchDiagnosticEvidence;
}>;

function itemsFor(pack: MemoryContextPack, ranked: readonly MemoryRankedCandidate[], historyPlan: MemoryRetrievalPlan, factPlan: MemoryRetrievalPlan): MemoryPreparingItemInput[] {
  return pack.items.map(item => {
    const plan = item.itemType === "FACT_VERSION" ? factPlan : historyPlan;
    const candidate = ranked.find(value => value.itemId === item.itemId && value.itemType === item.itemType)!;
    const base = { exactItemId: item.itemId, exactSafeText: item.exactSafeText,
      finalScore: candidate.finalScore, laneRanks: candidate.laneRanks, projectionKind: item.projectionKind,
      supportingItemId: item.supportingItemId, selectionReason: candidate.selectionReason,
      featureSnapshot: { ...candidate.featureSnapshot, aggregationRequested: plan.aggregationRequested,
        derived: item.derived, documentTime: item.documentTime, eventTimeEnd: item.eventTimeEnd,
        eventTimeStart: item.eventTimeStart, evidenceHandle: item.evidenceHandle, evidenceType: item.evidenceType,
        contextualRetrievalHintHash: item.retrievalHint ? memorySha256(item.retrievalHint) : null,
        contextualSupportingEvidenceHashes: (item.supportingEvidence ?? []).map(value => memorySha256(value.rawSafeText)),
        contextualSupportingRoundIds: (item.supportingEvidence ?? []).map(value => value.itemId),
        finalScore: candidate.finalScore, lastConfirmedAt: item.lastConfirmedAt, observedAt: item.observedAt,
        projectionKind: item.projectionKind, retrievalReason: item.retrievalReason,
        rrfScore: candidate.rrfScore, sourceAuthority: item.sourceAuthority, sourceSessionHandle: item.sourceSessionHandle,
        speakerScope: item.speakerScope, status: item.recordStatus, supportingItemId: item.supportingItemId,
        temporalReason: item.temporalReason, historical: candidate.metadata.historical,
        lifecycleState: candidate.metadata.lifecycleState, matchedSegmentId: candidate.matchedSegmentId ?? null,
        matchedSegmentPosition: candidate.matchedSegmentPosition ?? null, retrievalMode: plan.mode,
        temporalIntent: plan.temporalIntent, tier: item.tier, validFrom: item.validFrom, validTo: item.validTo }
    };
    if (item.itemType === "FACT_VERSION") return { ...base, itemType: "FACT_VERSION", factVersionId: item.itemId };
    if (item.itemType === "RECALL_CHUNK") return { ...base, itemType: "RECALL_CHUNK", recallChunkId: item.itemId };
    if (item.itemType === "TOOL_EVENT") return { ...base, itemType: "TOOL_EVENT", toolEventId: item.itemId };
    return { ...base, itemType: "RECALL_ROUND", recallRoundId: item.itemId,
      recallRoundSegmentId: candidate.matchedSegmentId ?? null };
  });
}

export function createMemorySearchRetrieval(client: PrismaClient, dependencies: Readonly<{
  repository?: Pick<ReturnType<typeof createPrismaLocalMemoryRetrievalRepository>, "snapshot" | "retrieve" | "expand">;
  vectors?: Pick<ReturnType<typeof createPrismaMemoryVectorRepository>, "resolveActiveProfile">;
  utilities?: Pick<ReturnType<typeof createPrismaMemoryRunUtilityService>, "embedQuery" | "rerank">;
}> = {}) {
  const repository = dependencies.repository ?? createPrismaLocalMemoryRetrievalRepository(client);
  const vectors = dependencies.vectors ?? createPrismaMemoryVectorRepository(client);
  const utilities = dependencies.utilities ?? createPrismaMemoryRunUtilityService({}, client);
  return async (input: Readonly<{ userId: string; chatId: string; assistantId: string | null;
    runId: string; toolCallId: string; query: string; comparison: boolean;
    /** The run answers a scheduled task's prompt: it also reads in its excluded chat. */
    scheduledPrompt?: boolean;
    accepted: MemorySearchSnapshot; signal: AbortSignal }>): Promise<MemorySearchRetrieved> => {
    input.signal.throwIfAborted();
    const now = new Date();
    const reasons: Array<{ stage: string; code: string }> = [];
    const reason = (stage: string, code: string) => { if (reasons.length < 16) reasons.push({ stage, code }); };
    const deadlineAt = now.getTime() + input.accepted.timeoutSeconds * 1000;
    const optionalSignal = (reserve: number) => AbortSignal.any([input.signal,
      AbortSignal.timeout(Math.max(1, deadlineAt - Date.now() - reserve))]);
    const optional = async <T>(stage: string, operation: (signal: AbortSignal) => Promise<T>, reserve: number): Promise<T | null> => {
      if (deadlineAt - Date.now() <= reserve) { reason(stage, "optional_window_exhausted"); return null; }
      const signal = optionalSignal(reserve);
      try { return await abortableMemoryRead(operation(signal), signal); }
      catch (error) { input.signal.throwIfAborted(); reason(stage, signal.aborted ? "optional_timeout" : diagnosticCode(error, "optional_stage_failed")); return null; }
    };
    const factPlan = planMemoryRetrieval({ currentUserText: input.query, now, applyResponsePreferences: false,
      filters: { sourceKinds: ["FACT", "EVENT"] }, mode: "TARGETED_CURRENT", temporalIntent: "CURRENT" });
    const scheduledPrompt = input.scheduledPrompt === true;
    const base = { assistantId: input.assistantId, chatId: input.chatId, now, userId: input.userId,
      settleSignal: input.signal, plan: factPlan, excludeToolEvents: true as const,
      ...(scheduledPrompt ? { scheduledPrompt: true as const } : {}) };
    const snapshot = await repository.snapshot(base);
    if (snapshot.status !== "READY" || !snapshot.useMemoryFacts ||
      !memoryReadableChatMode(snapshot.chatMemoryMode, scheduledPrompt) ||
      input.assistantId !== snapshot.assistantId ||
      snapshot.memoryGeneration !== input.accepted.memoryGeneration) throw new Error("memory_search_authority_changed");
    const history = input.accepted.referenceChatHistory && snapshot.referenceChatHistory;
    const plan = history ? planMemoryRetrieval({ currentUserText: input.query, now, applyResponsePreferences: false,
      filters: { sourceKinds: ["HISTORY"] }, mode: "PAST_CHAT_SEARCH", temporalIntent: "ANY",
      aggregationRequested: input.comparison }) : factPlan;
    const owner = { type: "MODEL_RUN_TOOL_CALL" as const, modelRunId: input.runId, modelRunToolCallId: input.toolCallId };
    let limited = history && snapshot.indexMode === null;
    if (limited) reason("snapshot", "history_index_unavailable");
    let vector: Parameters<typeof repository.retrieve>[0]["vector"];
    if (input.accepted.destinations.some(value => value.role === "MEMORY_QUERY_EMBED")) {
      const profile = await optional("embedding_profile", signal => vectors.resolveActiveProfile(input.userId, { signal }), 6000);
      if (profile?.status === "READY") {
        const embedded = await optional("embedding", signal => utilities.embedQuery({ owner, userId: input.userId, signal,
          profile: profile.profile, query: input.query }), 6000);
        if (embedded?.status === "READY") vector = { profile: embedded.profile, vector: embedded.vector, minimumScore: -1 };
        else { limited = true; if (embedded) reason("embedding", diagnosticCode(embedded.reason, "embedding_unavailable")); }
      } else { limited = true; if (profile) reason("embedding_profile", diagnosticCode(profile.reason, "embedding_profile_unavailable")); }
    }
    input.signal.throwIfAborted();
    const [factRead, pastRead] = await Promise.allSettled([
      repository.retrieve({ ...base, sourceSnapshot: snapshot, vector }),
      history ? repository.retrieve({ ...base, plan, sourceSnapshot: snapshot, vector }) : Promise.resolve(null)
    ]);
    const facts = factRead.status === "fulfilled" ? factRead.value : null;
    const past = pastRead.status === "fulfilled" ? pastRead.value : null;
    if (factRead.status === "rejected") reason("facts", diagnosticCode(factRead.reason, "retrieval_read_failed"));
    if (pastRead.status === "rejected") reason("history", diagnosticCode(pastRead.reason, "retrieval_read_failed"));
    for (const [stage, read] of [["facts", facts], ["history", past]] as const) {
      if (read?.lexicalState === "DEGRADED" || read?.lexicalState === "FAILED") reason(stage, "lexical_degraded");
      if (read?.vectorState === "DEGRADED") {
        reason(stage, "vector_degraded");
        for (const code of read.vectorFailureCodes ?? []) reason(stage, diagnosticCode(code, "vector_failure_unclassified"));
      }
    }
    limited ||= !facts || history && !past || facts?.lexicalState === "DEGRADED" || facts?.lexicalState === "FAILED" ||
      past?.lexicalState === "DEGRADED" || past?.lexicalState === "FAILED" ||
      facts?.vectorState === "DEGRADED" || past?.vectorState === "DEGRADED";
    let ranked = [...(facts ? fuseMemoryRetrievalCandidates(factPlan, facts.laneResults, now) : []),
      ...(past ? fuseMemoryRetrievalCandidates(plan, past.laneResults, now) : [])]
      .filter(candidate => candidate.itemType !== "TOOL_EVENT")
      .sort((a, b) => b.finalScore - a.finalScore).slice(0, 80);
    const fusedCount = ranked.length;
    const expand = async () => [
      ...await repository.expand(snapshot, factPlan, ranked.filter(value => value.itemType === "FACT_VERSION"), { signal: input.signal }),
      ...(history ? await repository.expand(snapshot, plan, ranked.filter(value => value.itemType !== "FACT_VERSION"), { signal: input.signal }) : [])
    ];
    let expanded = await expand();
    const expandedBeforeRerankCount = expanded.length;
    const candidates = memoryRelevanceCandidates(ranked, expanded, { aggregationRequested: input.comparison,
      temporalIntent: plan.temporalIntent });
    if (candidates.length && input.accepted.destinations.some(value => value.role === "MEMORY_RERANK")) {
      const rerank = atomicMemoryRerankResult(candidates, await optional("rerank", signal => utilities.rerank({ owner, userId: input.userId, signal,
        query: input.query, candidates, aggregationRequested: input.comparison, profileRequested: false,
        retrievalMode: plan.mode, temporalIntent: plan.temporalIntent }), 2000));
      limited ||= rerank?.status !== "READY";
      if (rerank?.status === "UNAVAILABLE") reason("rerank", diagnosticCode(rerank.reason, "rerank_unavailable"));
      ranked = [...applyMemoryRelevance(candidates, rerank, plan)];
    }
    input.signal.throwIfAborted();
    expanded = await expand();
    // Reserve envelope space. The evidence block itself never exceeds the accepted per-call bound.
    const cap = (input.comparison && history ? input.accepted.comparisonResultTokens : input.accepted.resultTokens) - 384;
    const selected = ranked.slice(0, input.comparison ? 30 : 15);
    const packSelected = () => packMemoryPersonalContext({ expanded, ranked: selected,
      plan, questionDirectedTemporalFallback: history, now,
      targetTokens: Math.min(cap, history && input.comparison ? cap : 6000), hardCapTokens: cap });
    let pack = packSelected();
    const resultLimit = input.comparison ? input.accepted.comparisonResultTokens : input.accepted.resultTokens;
    while (selected.length && estimateApproxTokens(JSON.stringify(pack.text)) + 300 > resultLimit) {
      if (!reasons.some(value => value.stage === "pack")) reason("pack", "serialized_result_budget");
      selected.pop();
      pack = packSelected();
      limited = true;
    }
    const lexicalFailureCodes = [...new Set([...(facts?.lexicalEvidence ?? []), ...(past?.lexicalEvidence ?? [])]
      .flatMap(evidence => evidence.failureCode ? [diagnosticCode(evidence.failureCode, "lexical_failure_unclassified")] : []))].slice(0, 18);
    const diagnosticEvidence: MemorySearchDiagnosticEvidence = { version: 1, reasons,
      factsLexicalState: facts?.lexicalState ?? "UNAVAILABLE", historyLexicalState: past?.lexicalState ?? (history ? "UNAVAILABLE" : "DISABLED"),
      factsVectorState: facts?.vectorState ?? "UNAVAILABLE", historyVectorState: past?.vectorState ?? (history ? "UNAVAILABLE" : "DISABLED"),
      lexicalFailureCount: (facts?.lexicalFailures.length ?? 0) + (past?.lexicalFailures.length ?? 0), lexicalFailureCodes,
      fusedCount, expandedBeforeRerankCount, rerankCandidateCount: candidates.length, rankedAfterRerankCount: ranked.length,
      expandedFinalCount: expanded.length, packedCount: pack.items.length };
    return { pack, snapshot, items: itemsFor(pack, ranked, plan, factPlan), limited, diagnosticEvidence };
  };
}
