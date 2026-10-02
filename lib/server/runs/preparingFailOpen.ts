import { decodeMemoryActionFeedback, type MemoryActionFeedback } from "../../contracts/memory";
import {
  decodeMemoryActionAnswerResult,
  type MemoryActionAnswerResult
} from "../providers/memoryActionAnswer";
import { MemoryPreparingRunConflictError, memoryPreparingHash } from "./preparingRun";
import {
  AssistantRunConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  SkillRunConflictError
} from "./runRepositoryContract";

/**
 * Personal Memory preparation of an accepted run may fail before dispatch.
 * Where the zero-item FAILED_SAFE finalization can prove every non-Memory
 * fence again, the run answers without Memory; otherwise it stays
 * fail-closed with the neutral preparation text. This module only decides;
 * the live preparation owner performs the guarded finalization.
 */

/** Preparation step that was running when the failure surfaced. `guard`
 * precedes every attempt (a durable command without its PENDING request). */
export type MemoryPreparationStage =
  | "guard"
  | "begin"
  | "retrieve"
  | "materialize"
  | "complete"
  | "finalize"
  | "retry";

export const MEMORY_PREPARATION_SKIPPED_CODE = "memory_preparation_skipped";
export const MEMORY_PREPARATION_INTERRUPTED_CODE = "memory_preparation_interrupted";
export const MEMORY_PREPARATION_FALLBACK_FAILURE_CODE = "memory_preparing_failed";

const stableCode = /^[a-z][a-z0-9_]{0,63}$/;

/** Memory conflicts where answering without Memory would mask an authority,
 * identity, lifecycle, deletion, accounting or terminal-winner decision. */
const FAIL_CLOSED_MEMORY_CODES = [
  "memory_admission_dag_changed",
  "memory_admission_shape_changed",
  "memory_admission_snapshot_invalid",
  "memory_all_reusable_deleted",
  "memory_attempt_execution_invalid",
  "memory_base_request_invalid",
  "memory_base_request_too_large",
  "memory_item_forgotten",
  "memory_owner_unavailable",
  "memory_preparing_attempt_expired",
  "memory_preparing_attempt_unavailable",
  "memory_preparing_deadline_fallback_unavailable",
  "memory_preparing_finalize_conflict",
  "memory_preparing_recovery_required",
  "memory_preparing_settings_fallback_unavailable",
  "memory_snapshot_invalid",
  "memory_source_deleted",
  "memory_source_stale",
  "memory_temporary_chat_expired",
  "memory_temporary_chat_forbidden",
  "memory_temporary_policy_review_required"
] as const;
const failClosedMemoryCodes: ReadonlySet<string> = new Set(FAIL_CLOSED_MEMORY_CODES);

/** Optional Memory read failures that the zero-item fallback may absorb. */
const FAIL_OPEN_MEMORY_CODES = [
  "memory_admission_deadline_exceeded",
  "memory_admission_settings_changed",
  "memory_assistant_grant_required",
  "memory_attempt_item_chunk_projection_invalid",
  "memory_attempt_item_contextual_dependency_invalid",
  "memory_attempt_item_digest_mode_invalid",
  "memory_attempt_item_duplicate",
  "memory_attempt_item_fact_authority_invalid",
  "memory_attempt_item_fact_projection_invalid",
  "memory_attempt_item_fact_retrieval_invalid",
  "memory_attempt_item_feature_snapshot_invalid",
  "memory_attempt_item_lane_ranks_invalid",
  "memory_attempt_item_persisted_shape_invalid",
  "memory_attempt_item_persisted_target_invalid",
  "memory_attempt_item_projection_invalid",
  "memory_attempt_item_reason_invalid",
  "memory_attempt_item_round_projection_invalid",
  "memory_attempt_item_score_invalid",
  "memory_attempt_item_stale",
  "memory_attempt_item_supporting_invalid",
  "memory_attempt_item_target_invalid",
  "memory_attempt_item_text_invalid",
  "memory_attempt_item_tool_projection_invalid",
  "memory_attempt_result_invalid",
  "memory_final_request_invalid",
  "memory_preparing_retry_conflict",
  "memory_utility_egress_changed"
] as const;

/**
 * Stable `ModelRun.errorPayload.code` values written by Personal Memory
 * preparation (live owner, recovery and the purge/deletion leaves that end a
 * preparing run). The admin aggregate counts exactly these; post-dispatch
 * Memory codes are deliberately absent.
 */
export const MEMORY_PREPARATION_FAILURE_CODES: readonly string[] = Object.freeze([
  ...new Set([
    MEMORY_PREPARATION_FALLBACK_FAILURE_CODE,
    ...FAIL_CLOSED_MEMORY_CODES,
    ...FAIL_OPEN_MEMORY_CODES
  ])
].sort());

function errorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/**
 * Non-Memory authority conflicts keep their own code. Serialization retry
 * exhaustion surfaces as ProviderAdmissionConflictError from any run
 * transaction, so it names provider authority only where finalize rechecks it.
 */
export function nonMemoryPreparationConflictCode(
  error: unknown,
  stage: MemoryPreparationStage
): string | null {
  // Named check: the class module carries the Prisma client.
  if (errorNamed(error, "McpToolAccessDeniedError")) {
    return "mcp_tool_access_denied";
  }
  if (error instanceof McpRunPlanConflictError || errorNamed(error, "McpRunPlanConflictError")) {
    return "mcp_not_ready";
  }
  if (error instanceof KnowledgeRunPlanConflictError || errorNamed(error, "KnowledgeRunPlanConflictError")) {
    return "knowledge_base_not_available";
  }
  if (error instanceof AssistantRunConflictError || errorNamed(error, "AssistantRunConflictError")) {
    return "assistant_not_available";
  }
  if (error instanceof SkillRunConflictError || errorNamed(error, "SkillRunConflictError")) {
    return "skill_not_available";
  }
  if (
    (error instanceof ProviderAdmissionConflictError || errorNamed(error, "ProviderAdmissionConflictError")) &&
    stage === "finalize"
  ) {
    return "provider_admission_changed";
  }
  return null;
}

/** The stable code a fail-closed preparation persists for this failure. */
export function memoryPreparationFailureCode(
  error: unknown,
  stage: MemoryPreparationStage
): string {
  if (error instanceof MemoryPreparingRunConflictError) {
    return stableCode.test(error.code) ? error.code : MEMORY_PREPARATION_FALLBACK_FAILURE_CODE;
  }
  return nonMemoryPreparationConflictCode(error, stage) ?? MEMORY_PREPARATION_FALLBACK_FAILURE_CODE;
}

export type MemoryPreparationFailOpenDecision =
  | Readonly<{ kind: "skip"; cause: string }>
  | Readonly<{ kind: "fail"; code: string }>;

/**
 * Unknown failures default to the fallback: it rechecks run status, attempt,
 * shape, DAG and every non-Memory authority itself and refuses otherwise.
 * Stop, an earlier fallback, the durable-command guard, explicit fail-closed
 * Memory codes and non-Memory conflicts never fall back.
 */
export function memoryPreparationFailOpen(input: Readonly<{
  alreadyFallenBack: boolean;
  error: unknown;
  signal?: AbortSignal;
  stage: MemoryPreparationStage;
}>): MemoryPreparationFailOpenDecision {
  const code = memoryPreparationFailureCode(input.error, input.stage);
  if (
    input.signal?.aborted ||
    input.alreadyFallenBack ||
    input.stage === "guard" ||
    nonMemoryPreparationConflictCode(input.error, input.stage) !== null ||
    (input.error instanceof MemoryPreparingRunConflictError && failClosedMemoryCodes.has(code))
  ) {
    return { code, kind: "fail" };
  }
  return { cause: code, kind: "skip" };
}

export type MemoryFailedSafeAction =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{
      answer: MemoryActionAnswerResult;
      feedback: MemoryActionFeedback;
      kind: "exact";
    }>
  | Readonly<{ kind: "fail" }>;

/** Settled synchronous outcomes a zero-item answer can still report exactly.
 * LIST/SEARCH COMPLETE needs its evidence in the answer, so it is absent. */
const preservedActionStatuses: ReadonlySet<string> = new Set([
  "AMBIGUOUS",
  "COMMITTED",
  "CONFIRMATION_REQUIRED",
  "REJECTED",
  "THIS_CHAT_ONLY"
]);

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The action result a zero-item fallback may claim from recorded attempt
 * evidence alone: an exact settled pair, PENDING, or nothing happened.
 * Anything else (lost LIST/SEARCH evidence, an unmatched or undecodable pair)
 * fails closed rather than telling the model the action was not done.
 */
export function failedSafeActionFromBudget(budgetSnapshot: unknown): MemoryFailedSafeAction {
  const budget = record(budgetSnapshot) ?? {};
  const rawAnswer = budget.memoryActionAnswerResult;
  const rawFeedback = budget.memoryActionResult;
  const answer = rawAnswer === undefined ? null : decodeMemoryActionAnswerResult(rawAnswer);
  if (rawAnswer !== undefined && !answer) return { kind: "fail" };
  if (!answer || answer.status === "UNAVAILABLE") {
    return rawFeedback === undefined ? { kind: "none" } : { kind: "fail" };
  }
  if (answer.status === "PENDING") {
    return rawFeedback === undefined ? { kind: "pending" } : { kind: "fail" };
  }
  if (!preservedActionStatuses.has(answer.status)) return { kind: "fail" };
  const feedback = decodeMemoryActionFeedback(rawFeedback);
  if (
    !feedback.ok ||
    feedback.value.operation !== answer.operation ||
    feedback.value.status !== answer.status
  ) {
    return { kind: "fail" };
  }
  return { answer, feedback: feedback.value, kind: "exact" };
}

/**
 * The live owner also knows this run's in-process executor result. A durable
 * command keeps PENDING; an executed synchronous action is reported only when
 * the last attempt budget records exactly that outcome.
 */
export function failedSafeActionForRun(input: Readonly<{
  budgetSnapshot: unknown;
  commandPending: boolean;
  /** `undefined`: no synchronous action resolved in this run. */
  executedAction: MemoryActionFeedback | null | undefined;
}>): MemoryFailedSafeAction {
  if (input.commandPending) {
    return input.executedAction ? { kind: "fail" } : { kind: "pending" };
  }
  const recorded = failedSafeActionFromBudget(input.budgetSnapshot);
  if (input.executedAction) {
    return recorded.kind === "exact" &&
      memoryPreparingHash(recorded.feedback) === memoryPreparingHash(input.executedAction)
      ? recorded
      : { kind: "fail" };
  }
  return recorded.kind === "none" ? recorded : { kind: "fail" };
}

/** `budgetSnapshot.preparationFailureCode`: a stable code, never error text. */
export function memoryPreparationCauseCode(value: string): string {
  return stableCode.test(value) ? value : MEMORY_PREPARATION_FALLBACK_FAILURE_CODE;
}
