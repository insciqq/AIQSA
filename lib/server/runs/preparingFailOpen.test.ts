import { describe, expect, it } from "vitest";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import {
  MEMORY_ACTION_NO_COMMIT_RESULT,
  MEMORY_ACTION_PENDING_RESULT
} from "../providers/memoryActionAnswer";
import {
  MEMORY_PREPARATION_FAILURE_CODES,
  failedSafeActionForRun,
  failedSafeActionFromBudget,
  memoryPreparationCauseCode,
  memoryPreparationFailOpen,
  memoryPreparationFailureCode,
  type MemoryPreparationStage
} from "./preparingFailOpen";
import { MemoryPreparingRunConflictError } from "./preparingRun";
import {
  AssistantRunConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  SkillRunConflictError
} from "./runRepositoryContract";

const conflict = (code: string, retryable = false) => new MemoryPreparingRunConflictError(code, retryable);
const decide = (error: unknown, stage: MemoryPreparationStage = "complete", extra: Partial<Readonly<{
  alreadyFallenBack: boolean; signal: AbortSignal;
}>> = {}) => memoryPreparationFailOpen({ alreadyFallenBack: false, error, stage, ...extra });

describe("Memory preparation fail-open classification", () => {
  // Class (a): the zero-item fallback absorbs the failure and rechecks every fence.
  it.each([
    ["row 8: settings drift whose retry returned null", conflict("memory_admission_settings_changed", true), "retry"],
    ["row 9: repeated stale item", conflict("memory_attempt_item_stale", true), "complete"],
    ["row 9: stale item at final recheck", conflict("memory_attempt_item_stale", true), "finalize"],
    ["row 10: changed utility egress", conflict("memory_utility_egress_changed", true), "finalize"],
    ["row 11: invalid attempt result", conflict("memory_attempt_result_invalid"), "materialize"],
    ["row 11: invalid attempt item", conflict("memory_attempt_item_text_invalid"), "complete"],
    ["row 12: unplaceable final request", conflict("memory_final_request_invalid"), "finalize"],
    ["row 14: exhausted retries", conflict("memory_preparing_retry_conflict"), "retry"],
    ["row 25: Assistant grant for a context-bearing request", conflict("memory_assistant_grant_required"), "finalize"]
  ] as const)("falls back for %s", (_label, error, stage) => {
    expect(decide(error, stage)).toEqual({ cause: error.code, kind: "skip" });
  });

  it("row 15: falls back for unknown retrieval and database exceptions under the generic code", () => {
    for (const stage of ["begin", "retrieve", "materialize", "complete", "finalize", "retry"] as const) {
      expect(decide(new Error("PRIVATE_PRISMA_FAILURE"), stage)).toEqual({
        cause: "memory_preparing_failed",
        kind: "skip"
      });
    }
  });

  it("row 16: serialization exhaustion falls back only on Memory-only stages", () => {
    for (const stage of ["begin", "retrieve", "complete", "retry"] as const) {
      expect(decide(new ProviderAdmissionConflictError(), stage)).toEqual({
        cause: "memory_preparing_failed",
        kind: "skip"
      });
    }
    expect(decide(new ProviderAdmissionConflictError(), "finalize")).toEqual({
      code: "provider_admission_changed",
      kind: "fail"
    });
  });

  it("row 17: non-Memory authority conflicts keep their own code and stay fail-closed", () => {
    for (const [error, code] of [
      [new KnowledgeRunPlanConflictError(), "knowledge_base_not_available"],
      [new McpRunPlanConflictError(), "mcp_not_ready"],
      [new McpToolAccessDeniedError(), "mcp_tool_access_denied"],
      [new SkillRunConflictError(), "skill_not_available"],
      [new AssistantRunConflictError(), "assistant_not_available"]
    ] as const) {
      for (const stage of ["complete", "finalize"] as const) {
        expect(decide(error, stage)).toEqual({ code, kind: "fail" });
        expect(memoryPreparationFailureCode(error, stage)).toBe(code);
      }
    }
    // Recognized by name too, as at the HTTP boundary.
    const renamed = Object.assign(new Error("x"), { name: "KnowledgeRunPlanConflictError" });
    expect(decide(renamed, "finalize")).toEqual({ code: "knowledge_base_not_available", kind: "fail" });
  });

  it.each([
    ["rows 4/26: Temporary lifecycle", "memory_temporary_chat_forbidden"],
    ["rows 5/26: missing owner", "memory_owner_unavailable"],
    ["row 18: changed DAG", "memory_admission_dag_changed"],
    ["row 19: changed shape", "memory_admission_shape_changed"],
    ["row 20: invalid snapshot", "memory_admission_snapshot_invalid"],
    ["row 20: invalid base request", "memory_base_request_invalid"],
    ["row 21: unproven execution accounting", "memory_attempt_execution_invalid"],
    ["row 22: expired attempt", "memory_preparing_attempt_expired"],
    ["row 23: another owner", "memory_preparing_attempt_unavailable"],
    ["row 24: lost finalization", "memory_preparing_finalize_conflict"],
    ["row 24: unavailable deadline fallback", "memory_preparing_deadline_fallback_unavailable"],
    ["row 24: unavailable settings fallback", "memory_preparing_settings_fallback_unavailable"],
    ["row 28: deletion fence", "memory_item_forgotten"],
    ["row 28: reset fence", "memory_all_reusable_deleted"],
    ["row 28: history purge", "memory_source_stale"],
    ["row 28: chat deletion", "memory_source_deleted"],
    ["row 31: recovery without a live owner", "memory_preparing_recovery_required"]
  ] as const)("stays fail-closed for %s", (_label, code) => {
    expect(decide(conflict(code), "finalize")).toEqual({ code, kind: "fail" });
  });

  it("row 13: a durable command without its PENDING request never falls back", () => {
    expect(decide(conflict("memory_final_request_invalid"), "guard")).toEqual({
      code: "memory_final_request_invalid",
      kind: "fail"
    });
  });

  it("row 27: Stop wins over every fallback", () => {
    const controller = new AbortController();
    controller.abort();
    expect(decide(conflict("memory_attempt_item_stale", true), "retrieve", { signal: controller.signal }))
      .toEqual({ code: "memory_attempt_item_stale", kind: "fail" });
    expect(decide(new Error("aborted"), "retrieve", { signal: controller.signal }))
      .toEqual({ code: "memory_preparing_failed", kind: "fail" });
  });

  it("allows at most one fallback finalization per run", () => {
    expect(decide(conflict("memory_attempt_item_stale", true), "complete", { alreadyFallenBack: true }))
      .toEqual({ code: "memory_attempt_item_stale", kind: "fail" });
  });

  it("persists only stable codes as the preparation cause", () => {
    expect(memoryPreparationCauseCode("memory_attempt_item_stale")).toBe("memory_attempt_item_stale");
    expect(memoryPreparationCauseCode("Private failure text")).toBe("memory_preparing_failed");
    expect(memoryPreparationCauseCode(`m${"a".repeat(64)}`)).toBe("memory_preparing_failed");
  });

  it("counts preparation failures by an explicit allowlist without post-dispatch Memory codes", () => {
    for (const code of [
      "memory_preparing_failed", "memory_preparing_recovery_required", "memory_preparing_attempt_expired",
      "memory_item_forgotten", "memory_all_reusable_deleted", "memory_source_stale", "memory_source_deleted",
      "memory_admission_dag_changed", "memory_attempt_item_stale", "memory_final_request_invalid"
    ]) expect(MEMORY_PREPARATION_FAILURE_CODES).toContain(code);
    for (const code of [
      "memory_answer_model_tools_retired", "memory_egress_changed", "provider_admission_changed",
      "memory_preparation_skipped"
    ]) expect(MEMORY_PREPARATION_FAILURE_CODES).not.toContain(code);
    expect(MEMORY_PREPARATION_FAILURE_CODES.every((code) => /^memory_[a-z0-9_]+$/.test(code))).toBe(true);
  });
});

const committedSave = { memoryRef: "ref-1", operation: "SAVE", statement: "Synthetic fact", status: "COMMITTED" } as const;
const committedAnswer = { operation: "SAVE", status: "COMMITTED", version: 4 } as const;

describe("fallback action outcome (D3)", () => {
  it("row 32: keeps an exact committed synchronous outcome with its feedback", () => {
    const budget = { memoryActionAnswerResult: committedAnswer, memoryActionResult: committedSave };
    expect(failedSafeActionForRun({ budgetSnapshot: budget, commandPending: false, executedAction: committedSave }))
      .toEqual({ answer: committedAnswer, feedback: committedSave, kind: "exact" });
    for (const [answer, feedback] of [
      [{ operation: "SAVE", status: "REJECTED", version: 4 }, { operation: "SAVE", status: "REJECTED" }],
      [{ operation: "SAVE", status: "THIS_CHAT_ONLY", version: 4 }, { operation: "SAVE", statement: "x", status: "THIS_CHAT_ONLY" }],
      [{ operation: "RESET", status: "CONFIRMATION_REQUIRED", version: 4 }, { operation: "RESET", status: "CONFIRMATION_REQUIRED" }]
    ] as const) {
      expect(failedSafeActionForRun({
        budgetSnapshot: { memoryActionAnswerResult: answer, memoryActionResult: feedback },
        commandPending: false,
        executedAction: feedback
      })).toEqual({ answer, feedback, kind: "exact" });
    }
  });

  it("fails closed when an executed action lacks exact recorded evidence", () => {
    for (const budgetSnapshot of [
      {},
      { memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT },
      { memoryActionAnswerResult: committedAnswer },
      { memoryActionAnswerResult: committedAnswer, memoryActionResult: { ...committedSave, memoryRef: "other" } },
      { memoryActionAnswerResult: { operation: "UPDATE", status: "COMMITTED", version: 4 }, memoryActionResult: committedSave }
    ]) {
      expect(failedSafeActionForRun({ budgetSnapshot, commandPending: false, executedAction: committedSave }))
        .toEqual({ kind: "fail" });
    }
  });

  it("fails closed for LIST/SEARCH results whose evidence the answer would lose", () => {
    const listed = { items: [], operation: "LIST" as const, status: "COMPLETE" as const };
    const budget = { memoryActionAnswerResult: { operation: "LIST", status: "COMPLETE", version: 4 }, memoryActionResult: listed };
    expect(failedSafeActionForRun({ budgetSnapshot: budget, commandPending: false, executedAction: listed }))
      .toEqual({ kind: "fail" });
    expect(failedSafeActionFromBudget(budget)).toEqual({ kind: "fail" });
  });

  it("keeps PENDING for a durable command and never pairs it with an executed action", () => {
    expect(failedSafeActionForRun({ budgetSnapshot: {}, commandPending: true, executedAction: undefined }))
      .toEqual({ kind: "pending" });
    expect(failedSafeActionForRun({ budgetSnapshot: {}, commandPending: true, executedAction: committedSave }))
      .toEqual({ kind: "fail" });
    expect(failedSafeActionFromBudget({ memoryActionAnswerResult: MEMORY_ACTION_PENDING_RESULT }))
      .toEqual({ kind: "pending" });
  });

  it("reports no commit only when nothing executed in this run", () => {
    expect(failedSafeActionForRun({ budgetSnapshot: {}, commandPending: false, executedAction: undefined }))
      .toEqual({ kind: "none" });
    // A resolved action with no outcome (control not ready, no executor) did nothing.
    expect(failedSafeActionForRun({
      budgetSnapshot: { memoryActionAnswerResult: { operation: "SAVE", status: "UNAVAILABLE", version: 4 } },
      commandPending: false,
      executedAction: null
    })).toEqual({ kind: "none" });
    expect(failedSafeActionFromBudget({ memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT }))
      .toEqual({ kind: "none" });
  });

  it("rejects undecodable or unmatched recorded evidence", () => {
    expect(failedSafeActionFromBudget({ memoryActionAnswerResult: { operation: "SAVE", status: "DONE", version: 4 } }))
      .toEqual({ kind: "fail" });
    expect(failedSafeActionFromBudget({ memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT, memoryActionResult: committedSave }))
      .toEqual({ kind: "fail" });
    expect(failedSafeActionFromBudget({ memoryActionAnswerResult: committedAnswer, memoryActionResult: { operation: "SAVE" } }))
      .toEqual({ kind: "fail" });
  });
});
