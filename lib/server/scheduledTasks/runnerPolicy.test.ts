import { describe, expect, it } from "vitest";
import {
  classifySendRefusal,
  expiredPendingOutcome,
  linkedRunOutcome,
  planScheduledTaskClaim,
  planTaskSettlement
} from "./runnerPolicy";

const daily = { kind: "daily", time: "09:00" } as const; // 06:00 UTC in Moscow
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

  it("records the due instant and pauses when the zone no longer resolves", () => {
    expect(planScheduledTaskClaim({ nextRunAt: at("2026-10-05T06:00:00Z"), schedule: daily, timeZone: "Mars/Olympus_Mons" },
      at("2026-10-05T06:00:10Z"))).toEqual({
      nextRunAt: null, occurrences: [{ missed: false, scheduledFor: at("2026-10-05T06:00:00Z") }],
      pauseReason: "schedule_invalid", status: "PAUSED"
    });
  });
});

describe("settlement bookkeeping", () => {
  const active = { consecutiveFailures: 0, revision: 4, status: "ACTIVE" } as const;
  const failed = { reasonCode: "run_orphaned", state: "FAILED" } as const;

  it("resets on success and pauses scheduled runs at the third consecutive failure", () => {
    expect(planTaskSettlement({ outcome: { reasonCode: null, state: "COMPLETED" }, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 0, pauseReason: null });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveFailures: 1 }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 2, pauseReason: null });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 3, pauseReason: "repeated_failures" });
    expect(planTaskSettlement({ outcome: failed, task: { ...active, consecutiveFailures: 2, status: "PAUSED" }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 3, pauseReason: null });
  });

  it("pauses on a permanent refusal only under the revision it was decided on", () => {
    const refused = { pauseReason: "model_unavailable", reasonCode: "model_unavailable", state: "FAILED" } as const;
    expect(planTaskSettlement({ observedRevision: 4, outcome: refused, task: active, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 1, pauseReason: "model_unavailable" });
    expect(planTaskSettlement({ observedRevision: 3, outcome: refused, task: active, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 1, pauseReason: null });
  });

  it("never counts or pauses for manual runs and skips", () => {
    const refused = { pauseReason: "model_unavailable", reasonCode: "model_unavailable", state: "FAILED" } as const;
    expect(planTaskSettlement({ outcome: refused, task: { ...active, consecutiveFailures: 2 }, trigger: "manual" }))
      .toEqual({ consecutiveFailures: 2, pauseReason: null });
    expect(planTaskSettlement({ outcome: { reasonCode: null, state: "COMPLETED" }, task: { ...active, consecutiveFailures: 2 }, trigger: "manual" }))
      .toEqual({ consecutiveFailures: 0, pauseReason: null });
    expect(planTaskSettlement({ outcome: { reasonCode: "chat_busy", state: "SKIPPED" }, task: { ...active, consecutiveFailures: 2 }, trigger: "schedule" }))
      .toEqual({ consecutiveFailures: 2, pauseReason: null });
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
    expect(classifySendRefusal(500, "internal_error")).toEqual({ kind: "fail", outcome: { reasonCode: "admission_failed", state: "FAILED" } });
    expect(classifySendRefusal(400, "Not a code")).toEqual({ kind: "fail", outcome: { reasonCode: "admission_failed", state: "FAILED" } });
  });
});
