import { knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "../knowledge/answerGroundingV5";
import { toolLoopKnowledgeEvidenceDispatchDraft } from "../knowledge/automaticEvidence";
import { KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT } from "../knowledge/fullContext";
import { KnowledgeAnswerContractError } from "../knowledge/grounding";
import type { KnowledgeEvidenceAnswerExecutionV1Result } from "../knowledge/evidenceAnswerExecutionV1";
import { KNOWLEDGE_SEARCH_TOOL_NAME } from "../knowledge/retrievalTypes";
import { knowledgeSearchFailureCode, knowledgeSearchFailureToolResult } from "../knowledge/searchFailure";
import { KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS, type KnowledgeToolExecutor } from "../knowledge/toolExecutor";
import { knowledgeUsageAttributionsFromToolResult } from "../knowledge/toolResult";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { memoryEgressRequestEvidence } from "../providers/memoryEgress";
import type { ProviderRunRequest } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { RunRepository } from "./runRepositoryContract";
import { toolRunBudgetsForRequest } from "./toolBudgets";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "./toolExecutionPersistence";
import { toolLoopPersistenceLimits, type PersistedToolLoopCall } from "./toolLoopPersistence";

type Repository = Pick<RunRepository, "loadCheckpointedToolLoopRun" | "persistToolLoopCallBatch" |
  "claimToolLoopCall" | "settleToolLoopCall" | "advanceToolLoopCallBatch">;
const PREFIX = "knowledge-review-v1-";

/** Account settled retrieval even after a crash between tool settlement and
 * answer completion. UsageEvent timestamps distinguish previously recorded
 * aggregates; provider-reported tool usage remains the only token authority. */
export function knowledgeRefinementUsageAfter(calls: readonly PersistedToolLoopCall[], recordedAt: readonly string[]) {
  const through = Math.max(Number.NEGATIVE_INFINITY, ...recordedAt.map(value => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw Error("knowledge_refinement_usage_invalid");
    return time;
  }));
  return calls.filter(call => call.providerCallId.startsWith(PREFIX) && call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME &&
    (call.state === "complete" || call.state === "error")).flatMap(call => {
    const time = call.completedAt ? Date.parse(call.completedAt) : NaN;
    if (!Number.isFinite(time)) throw Error("knowledge_refinement_usage_invalid");
    if (time <= through) return [];
    const result = parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName }, call.result);
    if (!result) conflict();
    return knowledgeUsageAttributionsFromToolResult(result);
  });
}
function conflict(): never {
  throw new KnowledgeAnswerContractError(
    "knowledge_answer_contract_failed", "knowledge_refinement_checkpoint_conflict"
  );
}
function queryKey(args: Readonly<Record<string, unknown>>): string {
  return knowledgeAnswerCanonicalJson({ query: typeof args.query === "string" ? args.query.normalize("NFKC").trim().replace(/\s+/gu, " ") : null,
    sourceAliases: Array.isArray(args.sourceAliases) ? [...args.sourceAliases].sort() : null });
}

/** Runs accepted review queries through ordinary durable tool calls. No new
 * entitlement, provider route, budget, or synthetic delivery proof is created. */
export async function refineKnowledgeEvidence(input: Readonly<{
  authorize(): Promise<void>;
  executor?: KnowledgeToolExecutor;
  memoryEgress?: MemoryToolEgressReceiptService;
  onResult?(result: ToolExecutionResult): Promise<void> | void;
  repository: Repository;
  request: ProviderRunRequest;
  previousEvidence: Pick<NonNullable<ReturnType<typeof toolLoopKnowledgeEvidenceDispatchDraft>>, "items">;
  result: Pick<KnowledgeEvidenceAnswerExecutionV1Result, "review" | "publication" | "evidenceReceiptHash">;
  runId: string;
  signal: AbortSignal;
  userId: string;
}>) {
  if (input.request.knowledgeAnswering?.route === KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT ||
    input.result.review.coverage === "complete" || !input.result.review.followUps.length) return null;
  if (!input.executor) throw Error("knowledge_refinement_executor_unavailable");
  const run = await input.repository.loadCheckpointedToolLoopRun({ runId: input.runId, userId: input.userId });
  if (!run) conflict();
  if ((run.normalizedRequest.knowledgeAnswerWorkflowVersion !== 9 && run.normalizedRequest.knowledgeAnswerWorkflowVersion !== 10 && run.normalizedRequest.knowledgeAnswerWorkflowVersion !== 11) || !run.knowledgeScope ||
    run.id !== input.runId || run.userId !== input.userId || run.normalizedRequest.modelId !== input.request.modelId ||
    run.normalizedRequest.provider !== input.request.provider) conflict();
  const budgets = toolRunBudgetsForRequest(run.normalizedRequest);
  // A recurring review over later evidence is a new decision, not a replay of
  // an earlier tool batch. Keep workflow 9's accepted call identity unchanged.
  const prefix = `${PREFIX}${knowledgeAnswerHash(run.normalizedRequest.knowledgeAnswerWorkflowVersion !== 9
    ? { review: input.result.review, evidenceReceiptHash: input.result.evidenceReceiptHash }
    : input.result.review)}-`;
  const existing = run.calls.filter(call => call.providerCallId.startsWith(prefix));
  const earlier = run.calls.filter(call => !call.providerCallId.startsWith(prefix));
  const seen = new Set(earlier.filter(call => call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME).map(call => queryKey(call.arguments)));
  const rounds = new Set(earlier.map(call => call.roundIndex)).size;
  const remaining = Math.min(3, budgets.maxToolCalls - earlier.length,
    run.knowledgeScope.budgetPolicy.maxOperations - earlier.filter(call => call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME).length);
  const planned = input.result.review.followUps.filter(query => {
    const key = queryKey(query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(0, remaining));
  if (rounds >= budgets.maxToolRounds || !planned.length) {
    if (existing.length) conflict();
    return null;
  }
  const roundIndex = existing[0]?.roundIndex ?? run.checkpoint.roundIndex;
  const calls = planned.map((query, ordinal) => ({ arguments: { query: query.query, sourceAliases: [...query.sourceAliases] },
    ordinal, providerCallId: `${prefix}${ordinal}`, toolName: KNOWLEDGE_SEARCH_TOOL_NAME }));
  let persisted: readonly PersistedToolLoopCall[];
  if (existing.length) {
    if (existing.length !== calls.length || existing.some(call => {
      const expected = calls[call.ordinal];
      return !expected || call.roundIndex !== roundIndex || call.providerCallId !== expected.providerCallId ||
        call.toolName !== expected.toolName || knowledgeAnswerCanonicalJson(call.arguments) !== knowledgeAnswerCanonicalJson(expected.arguments);
    })) conflict();
    persisted = [...existing].sort((a, b) => a.ordinal - b.ordinal);
  } else {
    if (run.checkpoint.phase !== "provider_running") conflict();
    input.signal.throwIfAborted();
    await input.authorize();
    const batch = await input.repository.persistToolLoopCallBatch({ calls, roundIndex,
      providerContinuation: run.checkpoint.providerContinuation, providerCursor: run.checkpoint.providerCursor,
      runId: input.runId, userId: input.userId });
    if (batch.kind !== "persisted" && batch.kind !== "reused") conflict();
    persisted = batch.calls;
  }
  const results = new Map<string, ToolExecutionResult>();
  for (const saved of persisted) {
    input.signal.throwIfAborted();
    const call: ModelToolCall = { id: saved.providerCallId, name: saved.toolName, arguments: { ...saved.arguments } };
    const claim = await input.repository.claimToolLoopCall({ callId: saved.id, runId: input.runId, userId: input.userId });
    if (claim.kind !== "settled" && claim.kind !== "claimed") conflict(); // Running I/O is ambiguous, never repeated.
    if (claim.kind === "settled") {
      const result = parsePersistedToolExecutionResult(call, claim.call.result);
      if (!result) conflict();
      results.set(saved.providerCallId, result);
      continue;
    }
    await input.authorize();
    const context = { persistedToolCallId: saved.id, request: input.request, runId: input.runId, userId: input.userId };
    let receipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
    let result: ToolExecutionResult;
    try {
      const admission = await input.executor.preflight?.(call, context);
      if (admission && admission.kind !== "admitted") result = admission.result;
      else {
        if (!input.memoryEgress && process.env.NODE_ENV === "production") throw Error("memory_egress_receipt_unavailable");
        await input.authorize();
        receipt = input.memoryEgress ? await input.memoryEgress.beginDispatch({ destinationKind: "knowledge",
          destinationSnapshot: { kind: "knowledge", scopeFingerprint: knowledgeAnswerHash(run.knowledgeScope),
            selection: run.normalizedRequest.knowledgePlan, toolName: call.name, version: 1 },
          mode: "TOOL_CALL", modelRunToolCallId: saved.id, requestEvidence: memoryEgressRequestEvidence(input.request),
          requestPreview: { argumentsHash: knowledgeAnswerHash(call.arguments), toolName: call.name },
          runId: input.runId, userId: input.userId }) : null;
        result = await input.executor.execute(call, context, {
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS)]) });
        if (receipt && !await input.memoryEgress!.completeDispatch(receipt.id)) throw Error("memory_egress_receipt_conflict");
      }
    } catch (error) {
      if (receipt) await input.memoryEgress!.failDispatch(receipt.id, knowledgeSearchFailureCode(error) ?? "knowledge_retrieval_failed").catch(() => undefined);
      input.signal.throwIfAborted();
      // Keep authority, invariant, persistence and unknown failures terminal.
      if (!knowledgeSearchFailureCode(error)) throw error;
      result = knowledgeSearchFailureToolResult(call, error);
    }
    const stored = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
    if (!stored) conflict();
    const settled = await input.repository.settleToolLoopCall({ callId: saved.id, result: stored,
      runId: input.runId, userId: input.userId, state: result.status });
    if (settled !== "settled" && settled !== "reused") conflict();
    results.set(saved.providerCallId, result);
    await input.onResult?.(result);
  }
  if (run.checkpoint.roundIndex === roundIndex) {
    const advanced = await input.repository.advanceToolLoopCallBatch({ roundIndex, runId: input.runId, userId: input.userId });
    if (advanced !== "advanced") conflict();
  } else if (run.checkpoint.roundIndex !== roundIndex + 1 || run.checkpoint.phase !== "provider_running") conflict();
  // Delivery is established by the ordinary provider-running checkpoint.
  // Keep chronological order so the original source and passage handles stay stable.
  const all = [...earlier, ...persisted].filter(call => call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME)
    .sort((a, b) => a.roundIndex - b.roundIndex || a.ordinal - b.ordinal).map(call => {
      const result = results.get(call.providerCallId) ?? parsePersistedToolExecutionResult({
        id: call.providerCallId, name: call.toolName
      }, call.result);
      if (!result) conflict();
      return result;
    });
  const handles = new Set(input.result.publication.blocks.flatMap(block => block.evidenceHandles));
  try {
    return toolLoopKnowledgeEvidenceDispatchDraft({ exclusions: run.knowledgeScope.exclusions, request: input.request, results: all,
      retainedItems: input.previousEvidence.items.filter(item => handles.has(item.handle)) });
  } catch (error) {
    if (error instanceof Error && error.message === "knowledge_evidence_retention_exceeds_budget") return null;
    throw error;
  }
}
