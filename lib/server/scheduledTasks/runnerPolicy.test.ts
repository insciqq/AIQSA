import { describe, expect, it } from "vitest";
import { scheduledTaskReasonMessage, type ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import {
  SCHEDULED_TASK_MAX_EXECUTING,
  SCHEDULED_TASK_MAX_EXECUTING_PER_USER,
  SCHEDULED_TASK_RUN_DEADLINE_CODE,
  SCHEDULED_TASK_RUN_DEADLINE_MS,
  classifySendRefusal,
  expiredPendingOutcome,
  linkedRunOutcome,
  planClaimOverlap,
  planScheduledTaskClaim,
  planTaskSettlement,
  settlementBaseline,
  settlementNotifiesOwner
} from "./runnerPolicy";

const daily = { kind: "daily", time: "09:00" } as const; // 06:00 UTC in Moscow
const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } satisfies ScheduledTaskSchedule;
const at = (iso: string) => new Date(iso);

describe("claim planning", () => {
  it("runs a due instant once and advances strictly after now", () => {
    expect(planScheduledTaskClaim({ nextRunAt: at("2026-10-05T06:00:00Z"), schedule: daily, timeZone: "Europe/Moscow" },
      at("2026-10-05T06:00:10Z"))).toEqual({
      nextRunAt: at("2026-10-06T06:00:00Z"), occurrences: [{ missed: false, scheduledFor: at("2026-10-05T06:00:00Z") }],
      pauseReason: null, status: "ACTIVE"
    });
    // Late within twelve hours still runs once, late.
    expect(planScheduledTaskClaim({ nextRunAt: at("2026-10-05T06:00:00Z"), schedule: daily, timeZone: "Europe/Moscow" },
      at("2026-10-05T17:59:00Z")).occurrences).toEqual([{ missed: false, scheduledFor: at("2026-10-05T06:00:00Z") }]);
  });

  it("records an old backlog as one missed instant and runs only the newest instant of the window", () => {
    const plan = planScheduledTaskClaim({ nextRunAt: at("2026-10-02T06:00:00Z"), schedule: daily, timeZone: "Europe/Moscow" },
      at("2026-10-05T08:00:00Z"));
    expect(plan).toEqual({
      nextRunAt: at("2026-10-06T06:00:00Z"), pauseReason: null, status: "ACTIVE",
      occurrences: [{ missed: true, scheduledFor: at("2026-10-02T06:00:00Z") }, { missed: false, scheduledFor: at("2026-10-05T06:00:00Z") }]
    });
    // Today's instant is also older than the window: nothing runs late.
    expect(planScheduledTaskClaim({ nextRunAt: at("2026-10-02T06:00:00Z"), schedule: daily, timeZone: "Europe/Moscow" },
      at("2026-10-05T20:00:00Z")).occurrences).toEqual([{ missed: true, scheduledFor: at("2026-10-02T06:00:00Z") }]);
  });

  it("completes a once task with its single occurrence, even when missed", () => {
    const once = { date: "2026-10-12", kind: "once", time: "10:00" } as const;
    const instant = at("2026-10-12T07:00:00Z");
    expect(planScheduledTaskClaim({ nextRunAt: instant, schedule: once, timeZone: "Europe/Moscow" }, at("2026-10-12T07:00:05Z")))
      .toEqual({ nextRunAt: null, occurrences: [{ missed: false, scheduledFor: instant }], pauseReason: null, status: "COMPLETED" });
    expect(planScheduledTaskClaim({ nextRunAt: instant, schedule: once, timeZone: "Europe/Moscow" }, at("2026-10-13T08:00:00Z")))
      .toMatchObject({ occurrences: [{ missed: true, scheduledFor: instant }], status: "COMPLETED" });
  });

  it("runs only the newest due hourly instant and records the older backlog quietly as one missed instant", () => {
    // Moscow (+03:00): 06:00, 07:00 and 08:00 local were due by 08:30.
    expect(planScheduledTaskClaim({ nextRunAt: at("2026-10-05T03:00:00Z"), schedule: hourly, timeZone: "Europe/Moscow" },
      at("2026-10-05T05:30:00Z"))).toEqual({
      nextRunAt: at("2026-10-05T06:00:00Z"), pauseReason: null, status: "ACTIVE",
      occurrences: [{ missed: true, scheduledFor: at("2026-10-05T03:00:00Z") }, { missed: false, scheduledFor: at("2026-10-05T05:00:00Z") }]
    });
    // Down for two days: the newest instant still runs, never one per missed hour.
    const plan = planScheduledTaskClaim({ nextRunAt: at("2026-10-03T03:00:00Z"), schedule: hourly, timeZone: "Europe/Moscow" },
      at("2026-10-05T05:30:00Z"));
    expect(plan.occurrences).toEqual([
      { missed: true, scheduledFor: at("2026-10-03T03:00:00Z") }, { missed: false, scheduledFor: at("2026-10-05T05:00:00Z") }
    ]);
  });

  it("records the due instant and pauses when the zone no longer resolves", () => {
    expect(planScheduledTaskClaim({ nextRunAt: at("2026-10-05T06:00:00Z"), schedule: daily, timeZone: "Mars/Olympus_Mons" },
      at("2026-10-05T06:00:10Z"))).toEqual({
      nextRunAt: null, occurrences: [{ missed: false, scheduledFor: at("2026-10-05T06:00:00Z") }],
      pauseReason: "schedule_invalid", status: "PAUSED"
    });
  });
});

describe("settlement bookkeeping", () => {
  const active = { consecutiveFailures: 0, consecutiveIncompleteRuns: 0, revision: 4, status: "ACTIVE" } as const;
  const failed = { reasonCode: "run_orphaned", state: "FAILED" } as const;
  const completed = { reasonCode: null, state: "COMPLETED" } as const;
  const quiet = { consecutiveIncompleteRuns: 0, sourceAlert: false } as const;

  it("resets on success and pauses scheduled runs at the third consecutive failure", () => {
    expect(planTaskSettlement({ outcome: completed, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 0, pauseReason: null });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveFailures: 1 }, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 2, pauseReason: null });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 3, pauseReason: "repeated_failures" });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveFailures: 2, status: "PAUSED" }, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 3, pauseReason: null });
  });

  it("counts a run stopped at its deadline as a failure toward the pause", () => {
    const deadline = linkedRunOutcome({ errorPayload: { code: SCHEDULED_TASK_RUN_DEADLINE_CODE, message: "x" }, status: "cancelled" })!;
    expect(deadline).toEqual({ reasonCode: "run_deadline", state: "FAILED" });
    expect(planTaskSettlement({ outcome: deadline, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 3, pauseReason: "repeated_failures" });
    expect(SCHEDULED_TASK_RUN_DEADLINE_MS).toBe(30 * 60 * 1000);
  });

  it("pauses on a permanent refusal only under the revision it was decided on", () => {
    const refused = { pauseReason: "model_unavailable", reasonCode: "model_unavailable", state: "FAILED" } as const;
    expect(planTaskSettlement({ observedRevision: 4, outcome: refused, task: active, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 1, pauseReason: "model_unavailable" });
    expect(planTaskSettlement({ observedRevision: 3, outcome: refused, task: active, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 1, pauseReason: null });
  });

  it("never counts or pauses for manual runs and skips", () => {
    const refused = { pauseReason: "model_unavailable", reasonCode: "model_unavailable", state: "FAILED" } as const;
    expect(planTaskSettlement({ outcome: refused, task: { ...active, consecutiveFailures: 2 }, trigger: "manual" }))
      .toEqual({ ...quiet, consecutiveFailures: 2, pauseReason: null });
    expect(planTaskSettlement({ outcome: completed, task: { ...active, consecutiveFailures: 2 }, trigger: "manual" }))
      .toEqual({ ...quiet, consecutiveFailures: 0, pauseReason: null });
    expect(planTaskSettlement({ outcome: { reasonCode: "chat_busy", state: "SKIPPED" }, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ ...quiet, consecutiveFailures: 2, pauseReason: null });
  });

  it("alerts once per streak of incomplete runs and pauses at the third, separately from failures", () => {
    const incomplete = (task: Parameters<typeof planTaskSettlement>[0]["task"], trigger: "schedule" | "manual" = "schedule") =>
      planTaskSettlement({ outcome: completed, sourcesIncomplete: true, task, trigger });
    // The first incomplete run still completes (resetting failures) and is the streak's one alert.
    expect(incomplete({ ...active, consecutiveFailures: 2 }))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 1, pauseReason: null, sourceAlert: true });
    expect(incomplete({ ...active, consecutiveIncompleteRuns: 1 }))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 2, pauseReason: null, sourceAlert: false });
    expect(incomplete({ ...active, consecutiveIncompleteRuns: 2 }))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 3, pauseReason: "source_unavailable", sourceAlert: false });
    // An owner pause meanwhile wins; the streak still counts.
    expect(incomplete({ ...active, consecutiveIncompleteRuns: 2, status: "PAUSED" }))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 3, pauseReason: null, sourceAlert: false });
    // A complete run ends the streak; failures and skips leave it alone.
    expect(planTaskSettlement({ outcome: completed, sourcesIncomplete: false, task: { ...active, consecutiveIncompleteRuns: 2 }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 0, pauseReason: null, sourceAlert: false });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveIncompleteRuns: 2 }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 1, consecutiveIncompleteRuns: 2, pauseReason: null, sourceAlert: false });
    expect(planTaskSettlement({ outcome: { reasonCode: "previous_running", state: "SKIPPED" }, task: { ...active, consecutiveIncompleteRuns: 2 },
      trigger: "schedule" })).toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 2, pauseReason: null, sourceAlert: false });
    // A manual run neither extends the streak nor alerts, but a complete one proves the source again.
    expect(incomplete({ ...active, consecutiveIncompleteRuns: 2 }, "manual"))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 2, pauseReason: null, sourceAlert: false });
    expect(planTaskSettlement({ outcome: completed, task: { ...active, consecutiveIncompleteRuns: 2 }, trigger: "manual" }))
      .toEqual({ consecutiveFailures: 0, consecutiveIncompleteRuns: 0, pauseReason: null, sourceAlert: false });
  });

  it("notifies the owner of shown results, pauses and the health alert, never routine skips", () => {
    expect(settlementNotifiesOwner({ state: "COMPLETED", taskPaused: false })).toBe(true);
    expect(settlementNotifiesOwner({ state: "FAILED", taskPaused: true })).toBe(true);
    // The incomplete run that pauses its task, and the alert that starts a streak.
    expect(settlementNotifiesOwner({ state: "COMPLETED", taskPaused: true })).toBe(true);
    expect(settlementNotifiesOwner({ sourceAlert: true, state: "COMPLETED", taskPaused: false })).toBe(true);
    // Routine skips and failures that did not pause stay in the history.
    expect(settlementNotifiesOwner({ state: "FAILED", taskPaused: false })).toBe(false);
    expect(settlementNotifiesOwner({ state: "SKIPPED", taskPaused: false })).toBe(false);
  });

  it("makes only a completed result of the current generation the next same-chat baseline", () => {
    const occurrence = { runId: "run-1", taskGeneration: 2, userMessageId: "user-1" };
    expect(settlementBaseline({ assistantMessageId: "answer-1", occurrence, outcome: { state: "COMPLETED" }, taskGeneration: 2 }))
      .toEqual({ assistantMessageId: "answer-1", generation: 2, runId: "run-1", userMessageId: "user-1" });
    // The prompt changed while the run executed: its result answers an older question.
    expect(settlementBaseline({ assistantMessageId: "answer-1", occurrence, outcome: { state: "COMPLETED" }, taskGeneration: 3 })).toBeNull();
    expect(settlementBaseline({ assistantMessageId: "answer-1", occurrence, outcome: { state: "FAILED" }, taskGeneration: 2 })).toBeNull();
    expect(settlementBaseline({ assistantMessageId: null, occurrence, outcome: { state: "COMPLETED" }, taskGeneration: 2 })).toBeNull();
    expect(settlementBaseline({ assistantMessageId: "answer-1", occurrence: { ...occurrence, userMessageId: null },
      outcome: { state: "COMPLETED" }, taskGeneration: 2 })).toBeNull();
  });
});

describe("claims over open runs", () => {
  const now = at("2026-10-05T10:00:00Z");
  const open = (overrides: Record<string, unknown>) => ({ id: "open-1", leaseExpiresAt: null, reasonCode: null, runId: null,
    state: "PENDING", ...overrides });

  it("skips a newly due instant while the previous run of a recurring task is still in progress", () => {
    for (const running of [open({ runId: "run-1", state: "RUNNING" }), open({ leaseExpiresAt: at("2026-10-05T10:04:00Z") })]) {
      expect(planClaimOverlap({ now, open: [running], recurring: true })).toEqual({ previousRunning: true, superseded: [] });
    }
    expect(planClaimOverlap({ now, open: [], recurring: true })).toEqual({ previousRunning: false, superseded: [] });
    // A once task's only instant always queues.
    expect(planClaimOverlap({ now, open: [open({ runId: "run-1", state: "RUNNING" })], recurring: false }).previousRunning).toBe(false);
  });

  it("replaces a pending occurrence that never got a run once the next instant arrives", () => {
    expect(planClaimOverlap({ now, open: [open({}), open({ id: "busy", leaseExpiresAt: at("2026-10-05T09:00:00Z"),
      reasonCode: "chat_busy", startedAt: at("2026-10-05T09:00:00Z") })], recurring: true })).toEqual({
      previousRunning: false,
      superseded: [{ id: "open-1", reasonCode: "superseded" }, { id: "busy", reasonCode: "chat_busy" }]
    });
  });

  it("executes at most five scheduled runs installation-wide and one per owner", () => {
    expect([SCHEDULED_TASK_MAX_EXECUTING, SCHEDULED_TASK_MAX_EXECUTING_PER_USER]).toEqual([5, 1]);
  });
});

describe("pending expiry and run outcomes", () => {
  const now = at("2026-10-05T12:00:00Z");

  it("skips late instants and ends retries thirty minutes after the first attempt", () => {
    expect(expiredPendingOutcome({ reasonCode: null, scheduledFor: at("2026-10-04T23:59:00Z"), startedAt: null }, now))
      .toEqual({ reasonCode: "missed", state: "SKIPPED" });
    expect(expiredPendingOutcome({ reasonCode: "chat_busy", scheduledFor: at("2026-10-05T11:00:00Z"), startedAt: at("2026-10-05T11:29:00Z") }, now))
      .toEqual({ reasonCode: "chat_busy", state: "SKIPPED" });
    expect(expiredPendingOutcome({ reasonCode: null, scheduledFor: at("2026-10-05T11:00:00Z"), startedAt: at("2026-10-05T11:29:00Z") }, now))
      .toEqual({ reasonCode: "admission_failed", state: "FAILED" });
    expect(expiredPendingOutcome({ reasonCode: "chat_busy", scheduledFor: at("2026-10-05T11:00:00Z"), startedAt: at("2026-10-05T11:31:00Z") }, now))
      .toBeNull();
    // Never attempted (waiting for a slot): only lateness expires it.
    expect(expiredPendingOutcome({ reasonCode: null, scheduledFor: at("2026-10-05T01:00:00Z"), startedAt: null }, now)).toBeNull();
  });

  it("settles from the persisted run state and keeps active runs open", () => {
    expect(linkedRunOutcome(null)).toEqual({ reasonCode: "run_unavailable", state: "FAILED" });
    expect(linkedRunOutcome({ errorPayload: null, status: "complete" })).toEqual({ reasonCode: null, state: "COMPLETED" });
    expect(linkedRunOutcome({ errorPayload: { code: "model_run_cancelled", message: "x" }, status: "cancelled" }))
      .toEqual({ reasonCode: "model_run_cancelled", state: "FAILED" });
    expect(linkedRunOutcome({ errorPayload: { code: "run_orphaned" }, status: "error" })).toEqual({ reasonCode: "run_orphaned", state: "FAILED" });
    expect(linkedRunOutcome({ errorPayload: { code: "Not A Code" }, status: "error" })).toEqual({ reasonCode: "run_failed", state: "FAILED" });
    for (const status of ["preparing", "queued", "streaming", "in_progress"]) {
      expect(linkedRunOutcome({ errorPayload: null, status })).toBeNull();
    }
  });
});

describe("send refusals", () => {
  it("retries busy chats and transient races, pauses permanent refusals and fails the rest", () => {
    expect(classifySendRefusal(409, "active_run_in_progress")).toEqual({ kind: "retry", reasonCode: "chat_busy" });
    expect(classifySendRefusal(409, "active_leaf_changed")).toEqual({ kind: "retry", reasonCode: "chat_busy" });
    expect(classifySendRefusal(404, "chat_not_found")).toEqual({ kind: "retry", reasonCode: null });
    expect(classifySendRefusal(403, "model_not_available")).toEqual({ kind: "fail",
      outcome: { pauseReason: "model_unavailable", reasonCode: "model_unavailable", state: "FAILED" } });
    expect(classifySendRefusal(403, "search_strategy_not_available")).toMatchObject({ outcome: { pauseReason: "search_unavailable" } });
    expect(classifySendRefusal(403, "user_not_available")).toMatchObject({ outcome: { pauseReason: "account_inactive" } });
    expect(classifySendRefusal(409, "credential_assignment_ambiguous")).toMatchObject({ outcome: { pauseReason: "provider_unavailable" } });
    expect(classifySendRefusal(400, "context_too_large")).toEqual({ kind: "fail", outcome: { reasonCode: "context_too_large", state: "FAILED" } });
    // No run exists after a server error: retried within the window, never counted at once.
    expect(classifySendRefusal(500, "internal_error")).toEqual({ kind: "retry", reasonCode: null });
    expect(classifySendRefusal(503, undefined)).toEqual({ kind: "retry", reasonCode: null });
    expect(classifySendRefusal(503, "provider_not_available")).toMatchObject({ outcome: { pauseReason: "provider_unavailable" } });
    expect(classifySendRefusal(400, "Not a code")).toEqual({ kind: "fail", outcome: { reasonCode: "admission_failed", state: "FAILED" } });
  });

  it("retries every transient tool and Workspace refusal within the window", () => {
    // Unlike a busy chat, a Workspace that stays busy ends the window as a counted failure, never a quiet skip.
    for (const [status, code] of [
      [409, "workspace_busy"], [409, "workspace_followup_predecessor_failed"], [409, "workspace_followup_unavailable"],
      [503, "workspace_runtime_unavailable"], [409, "mcp_not_ready"],
      // Saved Workspace secrets that could not be read or locked.
      [503, "workspace_secret_unavailable"]
    ] as const) {
      expect(classifySendRefusal(status, code)).toEqual({ kind: "retry", reasonCode: null });
    }
  });

  it("fails and pauses every permanent tool and Workspace refusal with a reason the owner can act on", () => {
    for (const [status, code, pauseReason] of [
      [409, "workspace_disabled", "workspace_unavailable"],
      [503, "workspace_runtime_incompatible", "workspace_unavailable"],
      [409, "workspace_runtime_incompatible", "workspace_unavailable"],
      [400, "workspace_model_tools_required", "workspace_unavailable"],
      [400, "mcp_tool_calling_not_supported", "tools_unavailable"],
      [409, "mcp_plan_too_large", "tools_unavailable"],
      [400, "skills_count_exceeded", "tools_unavailable"],
      [409, "workspace_secret_limit", "workspace_secret_limit"]
    ] as const) {
      expect(classifySendRefusal(status, code)).toEqual({ kind: "fail", outcome: { pauseReason, reasonCode: pauseReason, state: "FAILED" } });
      // Each pause has its own human copy, never the generic fallback.
      expect(scheduledTaskReasonMessage(pauseReason)).not.toBe(scheduledTaskReasonMessage("some_future_code"));
    }
  });
});
