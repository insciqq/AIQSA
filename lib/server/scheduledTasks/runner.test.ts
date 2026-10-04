import { describe, expect, it, vi } from "vitest";
import type { ScheduledTaskChatMode, ScheduledTaskRunTrigger, ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import type { SmtpProductMessage } from "../email/definitions";
import type { ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";
import type { ScheduledTaskSend } from "./admission";
import type { ScheduledTaskRunCatalog } from "./catalog";
import { createScheduledTaskRunner } from "./runner";
import {
  expiredPendingOutcome,
  linkedRunOutcome,
  planClaimOverlap,
  planScheduledTaskClaim,
  planTaskSettlement,
  settlementBaseline,
  settlementNotifiesOwner,
  type ScheduledTaskBaseline,
  type ScheduledTaskOutcome,
  type ScheduledTaskStatusColumn
} from "./runnerPolicy";
import type { ScheduledTaskRunnerStore, ScheduledTaskSettlement } from "./runnerStore";

type Task = {
  baseline: ScheduledTaskBaseline | null; chatId: string | null; chatMode: ScheduledTaskChatMode; consecutiveFailures: number;
  emailNotify: boolean; generation: number; id: string; modelId: string; nextRunAt: Date | null; pauseReason: string | null;
  prompt: string; provider: string; revision: number; schedule: ScheduledTaskSchedule; searchEnabled: boolean;
  status: ScheduledTaskStatusColumn; timeZone: string; title: string; userId: string;
};
type Occurrence = {
  chatId: string | null; createdAt: number; finishedAt: Date | null; id: string; leaseExpiresAt: Date | null; notifiedAt: Date | null;
  reasonCode: string | null; runId: string | null; scheduledFor: Date; startedAt: Date | null; state: string; taskGeneration: number | null;
  taskId: string; trigger: ScheduledTaskRunTrigger; unseenAt: Date | null; userId: string; userMessageId: string | null;
};
type Run = { assistantMessageId: string; errorPayload: unknown; status: string; userId: string };

function harness() {
  let clock = new Date("2026-10-05T06:00:05.000Z");
  let ids = 0;
  const tasks = new Map<string, Task>();
  const occurrences: Occurrence[] = [];
  /** Accepted scheduled runs; each carries its scheduled origin, so it outlives its task. */
  const runs = new Map<string, Run>();
  const chats = new Map<string, { activeLeafMessageId: string | null; usable: boolean; userId: string }>();
  const inactiveUsers = new Set<string>();
  const emails: SmtpProductMessage[] = [];
  const renamed: Array<{ chatId: string; title: string }> = [];
  const sent: Array<{ body: Record<string, unknown>; chatId: string; occurrence: ScheduledOccurrenceAdmission }> = [];
  const catalog: ScheduledTaskRunCatalog = {
    models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
      openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: true },
    modelId: "model-a", provider: "connection-a", searchStrategyIds: ["web"] }],
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchStrategies: [{ displayName: "Web", executionModes: ["all_selected", "model_choice"], kind: "web_search", strategyId: "web" }]
  };
  let catalogFor: (userId: string) => ScheduledTaskRunCatalog | null = () => catalog;
  /** What the ordinary send handler does for the next send: admit a run ending in `runStatus`, or refuse. */
  let reply: (occurrence: Occurrence) => { error: string; status: number } | { runStatus: string; errorCode?: string; unlinked?: true } =
    () => ({ runStatus: "complete" });
  const nextId = (prefix: string) => `${prefix}-${++ids}`;

  function settle(occurrence: Occurrence, outcome: ScheduledTaskOutcome, observedRevision?: number): ScheduledTaskSettlement {
    const task = tasks.get(occurrence.taskId)!;
    const plan = planTaskSettlement({ observedRevision, outcome, task, trigger: occurrence.trigger });
    const taskPaused = plan.pauseReason !== null;
    Object.assign(occurrence, { finishedAt: clock, leaseExpiresAt: null, reasonCode: outcome.reasonCode, state: outcome.state,
      unseenAt: settlementNotifiesOwner({ state: outcome.state, taskPaused }) ? clock : null });
    const baseline = settlementBaseline({ assistantMessageId: occurrence.runId ? runs.get(occurrence.runId)?.assistantMessageId ?? null : null,
      occurrence, outcome, taskGeneration: task.generation });
    Object.assign(task, { consecutiveFailures: plan.consecutiveFailures }, baseline ? { baseline } : {},
      taskPaused ? { nextRunAt: null, pauseReason: plan.pauseReason, revision: task.revision + 1, status: "PAUSED" } : {});
    return { occurrenceId: occurrence.id, reasonCode: outcome.reasonCode, runId: occurrence.runId, state: outcome.state, taskPaused };
  }
  const find = (id: string) => occurrences.find((occurrence) => occurrence.id === id && tasks.has(occurrence.taskId));
  const leased = (occurrence: Occurrence) =>
    occurrence.state === "PENDING" && occurrence.runId === null && occurrence.leaseExpiresAt !== null && occurrence.leaseExpiresAt > clock;
  const quietSkip = (occurrence: Occurrence, reasonCode: string): ScheduledTaskSettlement => {
    Object.assign(occurrence, { finishedAt: clock, leaseExpiresAt: null, reasonCode, state: "SKIPPED" });
    return { occurrenceId: occurrence.id, reasonCode, runId: null, state: "SKIPPED", taskPaused: false };
  };

  const store: ScheduledTaskRunnerStore = {
    async claimDue(now) {
      const due = [...tasks.values()].filter((task) => task.status === "ACTIVE" && task.nextRunAt && task.nextRunAt <= now);
      const settlements: ScheduledTaskSettlement[] = [];
      for (const task of due) {
        const plan = planScheduledTaskClaim({ nextRunAt: task.nextRunAt!, schedule: task.schedule, timeZone: task.timeZone }, now);
        const open = plan.occurrences.some((planned) => !planned.missed)
          ? occurrences.filter((row) => row.taskId === task.id && (row.state === "PENDING" || row.state === "RUNNING")) : [];
        const overlap = planClaimOverlap({ now, open, recurring: task.schedule.kind !== "once" });
        for (const stale of overlap.superseded) settlements.push(quietSkip(find(stale.id)!, stale.reasonCode));
        for (const planned of plan.occurrences) {
          if (occurrences.some((row) => row.taskId === task.id && row.trigger === "schedule" &&
            row.scheduledFor.getTime() === planned.scheduledFor.getTime())) continue;
          const reasonCode = planned.missed ? "missed" : overlap.previousRunning ? "previous_running" : null;
          const occurrence: Occurrence = {
            chatId: null, createdAt: ids, finishedAt: reasonCode ? now : null, id: nextId("occurrence"), leaseExpiresAt: null,
            notifiedAt: null, reasonCode, runId: null, scheduledFor: planned.scheduledFor, startedAt: null,
            state: reasonCode ? "SKIPPED" : "PENDING", taskGeneration: null, taskId: task.id, trigger: "schedule", unseenAt: null,
            userId: task.userId, userMessageId: null
          };
          occurrences.push(occurrence);
          if (reasonCode) settlements.push({ occurrenceId: occurrence.id, reasonCode, runId: null, state: "SKIPPED", taskPaused: false });
        }
        Object.assign(task, { nextRunAt: plan.nextRunAt },
          plan.status === "ACTIVE" ? {} : { pauseReason: plan.pauseReason, revision: task.revision + 1, status: plan.status });
      }
      return { claimed: due.length, settlements };
    },
    async settleFinishedRuns(now) {
      const settled: ScheduledTaskSettlement[] = [];
      for (const occurrence of occurrences.filter((row) => row.state === "RUNNING" && tasks.has(row.taskId))) {
        const result = await store.settleLinked(occurrence.id, now);
        if (result) settled.push(result);
      }
      return settled;
    },
    async expirePending(now) {
      return occurrences.filter((row) => row.state === "PENDING" && tasks.has(row.taskId) && !leased(row)).flatMap((row) => {
        const outcome = expiredPendingOutcome(row, now);
        return outcome ? [settle(row, outcome)] : [];
      });
    },
    async loadDispatch(now) {
      const executing = new Map<string, number>();
      const count = (userId: string) => executing.set(userId, (executing.get(userId) ?? 0) + 1);
      for (const run of runs.values()) if (!["complete", "cancelled", "error"].includes(run.status)) count(run.userId);
      for (const row of occurrences.filter((candidate) => tasks.has(candidate.taskId) && leased(candidate))) count(row.userId);
      const pending = occurrences.filter((row) => row.state === "PENDING" && tasks.has(row.taskId) &&
        (!row.leaseExpiresAt || row.leaseExpiresAt <= now))
        .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime() || left.createdAt - right.createdAt)
        .map((row) => ({ id: row.id, userId: row.userId }));
      return { executing, pending };
    },
    async acquireLease(id, now, until) {
      const row = find(id);
      if (!row || row.state !== "PENDING" || row.runId || (row.leaseExpiresAt && row.leaseExpiresAt > now)) return false;
      Object.assign(row, { leaseExpiresAt: until, startedAt: row.startedAt ?? now });
      return true;
    },
    async loadExecution(id) {
      const row = find(id);
      if (!row || row.state !== "PENDING" || row.runId) return null;
      const task = tasks.get(row.taskId)!;
      const chat = task.chatId ? chats.get(task.chatId) : undefined;
      return {
        chat: chat?.usable ? { activeLeafMessageId: chat.activeLeafMessageId, id: task.chatId! } : null,
        occurrence: { id: row.id, scheduledFor: row.scheduledFor, taskId: row.taskId, trigger: row.trigger, userId: row.userId },
        ownerActive: !inactiveUsers.has(row.userId),
        task: { baseline: task.baseline, chatMode: task.chatMode, generation: task.generation, modelId: task.modelId,
          prompt: task.prompt, provider: task.provider, revision: task.revision, searchEnabled: task.searchEnabled,
          status: task.status, timeZone: task.timeZone, title: task.title }
      };
    },
    async readOccurrence(id) {
      const row = find(id);
      return row ? { runId: row.runId, state: row.state } : null;
    },
    async retryLater(id, reasonCode) {
      const row = find(id);
      if (row?.state === "PENDING" && !row.runId) Object.assign(row, { leaseExpiresAt: null }, reasonCode ? { reasonCode } : {});
    },
    async settlePending(id, outcome, _now, observedRevision) {
      const row = find(id);
      return row?.state === "PENDING" && !row.runId ? settle(row, outcome, observedRevision) : null;
    },
    async settleLinked(id) {
      const row = find(id);
      if (row?.state !== "RUNNING") return null;
      const outcome = linkedRunOutcome(row.runId ? runs.get(row.runId) ?? null : null);
      return outcome ? settle(row, outcome) : null;
    },
    async claimNotification(id, now) {
      const row = find(id);
      const task = row && tasks.get(row.taskId);
      if (!row || !task || row.notifiedAt || !["COMPLETED", "FAILED", "SKIPPED"].includes(row.state) || !task.emailNotify) return null;
      row.notifiedAt = now;
      return { chatId: row.chatId ?? task.chatId, email: "owner@example.test", reasonCode: row.reasonCode,
        state: row.state as "COMPLETED", taskPauseReason: task.pauseReason, title: task.title, trigger: row.trigger };
    }
  };

  const send: ScheduledTaskSend = async ({ body, chatId, occurrence: origin }) => {
    sent.push({ body, chatId, occurrence: origin });
    const occurrence = find(origin.occurrenceId)!;
    const task = tasks.get(occurrence.taskId)!;
    const decision = reply(occurrence);
    if ("error" in decision) return Response.json({ error: decision.error }, { status: decision.status });
    const stream = () => new Response("event: done\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    if (decision.unlinked) return stream();
    // The real link refuses a task paused or edited since the runner read it.
    if (task.revision !== origin.taskRevision || task.generation !== origin.taskGeneration) {
      return Response.json({ error: "scheduled_task_occurrence_unavailable" }, { status: 409 });
    }
    // The real handler links the occurrence in the run's creating transaction.
    const runId = nextId("run");
    const userMessageId = nextId("user-message");
    const assistantMessageId = nextId("assistant-message");
    runs.set(runId, { assistantMessageId, errorPayload: decision.errorCode ? { code: decision.errorCode } : null,
      status: decision.runStatus, userId: occurrence.userId });
    chats.set(chatId, { activeLeafMessageId: assistantMessageId, usable: true, userId: occurrence.userId });
    Object.assign(occurrence, { chatId, leaseExpiresAt: null, reasonCode: null, runId, state: "RUNNING",
      taskGeneration: origin.taskGeneration, userMessageId });
    task.chatId = chatId;
    return stream();
  };

  const kick = vi.fn();
  const runner = createScheduledTaskRunner({
    appBaseUrl: "https://aiqsa.example.test",
    kick,
    loadCatalog: async (userId) => catalogFor(userId),
    newId: () => nextId("id"),
    now: () => clock,
    renameChat: async ({ chatId, title }) => { renamed.push({ chatId, title }); },
    send,
    sendEmail: async (message) => { emails.push(message); },
    store
  });

  function addTask(overrides: Partial<Task> = {}): Task {
    const task: Task = {
      baseline: null, chatId: null, chatMode: "same", consecutiveFailures: 0, emailNotify: false, generation: 1, id: nextId("task"),
      modelId: "model-a", nextRunAt: new Date("2026-10-05T06:00:00.000Z"), pauseReason: null,
      prompt: "  Summarize the synthetic fixture  ", provider: "connection-a", revision: 1, schedule: { kind: "daily", time: "09:00" },
      searchEnabled: false, status: "ACTIVE", timeZone: "Europe/Moscow", title: "Synthetic brief", userId: "owner-1", ...overrides
    };
    tasks.set(task.id, task);
    return task;
  }
  function addOccurrence(task: Task, overrides: Partial<Occurrence> = {}): Occurrence {
    const occurrence: Occurrence = {
      chatId: null, createdAt: ids, finishedAt: null, id: nextId("occurrence"), leaseExpiresAt: null, notifiedAt: null, reasonCode: null,
      runId: null, scheduledFor: clock, startedAt: null, state: "PENDING", taskGeneration: null, taskId: task.id, trigger: "manual",
      unseenAt: null, userId: task.userId, userMessageId: null, ...overrides
    };
    occurrences.push(occurrence);
    return occurrence;
  }
  async function tick(): Promise<void> {
    await runner.tick();
    await runner.idle();
  }
  return {
    addOccurrence, addTask, chats, emails, inactiveUsers, kick, occurrences, renamed, runs, sent, store, tasks, tick,
    advance(ms: number) { clock = new Date(clock.getTime() + ms); },
    setCatalog(load: typeof catalogFor) { catalogFor = load; },
    setReply(next: typeof reply) { reply = next; },
    forTask: (task: Task) => occurrences.filter((occurrence) => occurrence.taskId === task.id)
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("scheduled task runner", () => {
  it("claims a due task, runs it once into a new Memory-excluded chat and advances the schedule", async () => {
    const h = harness();
    const task = h.addTask({ emailNotify: true });
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ reasonCode: null, scheduledFor: new Date("2026-10-05T06:00:00.000Z"), state: "COMPLETED" }]);
    expect(task).toMatchObject({ consecutiveFailures: 0, nextRunAt: new Date("2026-10-06T06:00:00.000Z"), revision: 1, status: "ACTIVE" });
    expect(h.forTask(task)[0]!.unseenAt).not.toBeNull();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body).toMatchObject({
      content: { blocks: [{ text: "Summarize the synthetic fixture", type: "text" }] }, expectedActiveLeafId: null,
      mcp: { mode: "off" }, modelId: "model-a", personalDraft: { folderId: null, memoryMode: "EXCLUDED" }, provider: "connection-a",
      searchPlan: { mode: "all_selected", optionIds: [] }, skills: { mode: "off" }, timeZone: "Europe/Moscow", workspace: { enabled: false }
    });
    // The first run of a task has no earlier result to see.
    expect(h.sent[0]!.occurrence).toEqual({ occurrenceId: h.forTask(task)[0]!.id, previousResult: null, taskGeneration: 1,
      taskId: task.id, taskRevision: 1 });
    expect(h.renamed).toEqual([{ chatId: h.sent[0]!.chatId, title: "Synthetic brief" }]);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({ kind: "scheduled_task_result", subject: "Scheduled task finished", to: "owner@example.test" });
    expect(h.emails[0]!.text).toContain(`https://aiqsa.example.test/c/${h.sent[0]!.chatId}`);
    expect(h.emails[0]!.text).not.toContain("Summarize");
    // The finished run frees its owner's slot: the runner wakes itself for the next one.
    expect(h.kick).toHaveBeenCalledTimes(1);

    // The next instant appends to the same chat after its current leaf; nothing is claimed twice.
    await h.tick();
    expect(h.sent).toHaveLength(1);
    const leaf = h.chats.get(h.sent[0]!.chatId)!.activeLeafMessageId;
    h.advance(24 * HOUR);
    await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ chatId: h.sent[0]!.chatId });
    expect(h.sent[1]!.body).toMatchObject({ expectedActiveLeafId: leaf });
    expect(h.sent[1]!.body).not.toHaveProperty("personalDraft");
    // Its model sees the previous shown result besides the prompt.
    expect(h.sent[1]!.occurrence.previousResult).toEqual({ assistantMessageId: leaf, userMessageId: h.forTask(task)[0]!.userMessageId });
    expect(h.renamed).toHaveLength(1);
    expect(h.emails).toHaveLength(2);
  });

  it("starts a dated, Memory-excluded chat for every run in new-chat mode, Run now included", async () => {
    const h = harness();
    const task = h.addTask({ chatMode: "new", title: "Morning brief" });
    await h.tick();
    h.advance(24 * HOUR);
    await h.tick();
    const manual = h.addOccurrence(task);
    await h.tick();
    const chatIds = h.sent.map((send) => send.chatId);
    expect(new Set(chatIds).size).toBe(3);
    for (const send of h.sent) {
      expect(send.body).toMatchObject({ expectedActiveLeafId: null, personalDraft: { folderId: null, memoryMode: "EXCLUDED" } });
      expect(send.occurrence.previousResult).toBeNull();
    }
    expect(h.renamed.map((entry) => entry.title)).toEqual(["Morning brief · 5 Oct 2026", "Morning brief · 6 Oct 2026",
      "Morning brief · 6 Oct 2026"]);
    // The task opens its newest chat; every run keeps its own.
    expect(task.chatId).toBe(chatIds[2]);
    expect(h.forTask(task).map((row) => row.chatId)).toEqual(chatIds);
    expect(manual).toMatchObject({ chatId: chatIds[2], state: "COMPLETED", trigger: "manual" });
  });

  it("gives a same-chat run only the previous result of the current prompt", async () => {
    const h = harness();
    const task = h.addTask();
    await h.tick();
    const first = h.forTask(task)[0]!;
    expect(task.baseline).toMatchObject({ generation: 1, runId: first.runId, userMessageId: first.userMessageId });
    // The owner rewrites the prompt: a new generation, whose first run sees no earlier result.
    Object.assign(task, { baseline: null, generation: 2, prompt: "A different question", revision: 2 });
    h.advance(24 * HOUR);
    await h.tick();
    expect(h.sent[1]!.occurrence).toMatchObject({ previousResult: null, taskGeneration: 2, taskRevision: 2 });
    expect(task.baseline).toMatchObject({ generation: 2, runId: h.forTask(task)[1]!.runId });

    // A result of an older generation never becomes the baseline.
    h.setReply(() => ({ runStatus: "streaming" }));
    h.advance(24 * HOUR);
    await h.tick();
    const late = h.forTask(task)[2]!;
    const baseline = task.baseline;
    Object.assign(task, { baseline: null, generation: 3, revision: 3 });
    h.runs.get(late.runId!)!.status = "complete";
    await h.tick();
    expect(late.state).toBe("COMPLETED");
    expect(task.baseline).toBeNull();
    expect(baseline).not.toBeNull();
  });

  it("skips an instant that comes due while the previous run is still in progress, quietly", async () => {
    const h = harness();
    const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } as const;
    const task = h.addTask({ emailNotify: true, schedule: hourly });
    h.setReply(() => ({ runStatus: "streaming" }));
    await h.tick();
    const [running] = h.forTask(task);
    expect(running).toMatchObject({ state: "RUNNING" });
    expect(task.nextRunAt).toEqual(new Date("2026-10-05T07:00:00.000Z"));
    h.advance(HOUR);
    await h.tick();
    expect(h.forTask(task).map((row) => [row.scheduledFor.toISOString(), row.state, row.reasonCode])).toEqual([
      ["2026-10-05T06:00:00.000Z", "RUNNING", null],
      ["2026-10-05T07:00:00.000Z", "SKIPPED", "previous_running"]
    ]);
    expect(h.sent).toHaveLength(1);
    // Routine skips stay history only: no unread result and no email.
    expect(h.forTask(task)[1]!.unseenAt).toBeNull();
    expect(h.emails).toHaveLength(0);
    h.runs.get(running!.runId!)!.status = "complete";
    h.setReply(() => ({ runStatus: "complete" }));
    h.advance(HOUR);
    await h.tick();
    expect(h.forTask(task).map((row) => row.state)).toEqual(["COMPLETED", "SKIPPED", "COMPLETED"]);
    expect(h.emails.map((email) => email.subject)).toEqual(["Scheduled task finished", "Scheduled task finished"]);
  });

  it("replaces a pending run that could not start once the next instant arrives", async () => {
    const h = harness();
    const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } as const;
    const next = new Date("2026-10-05T07:00:00.000Z");
    // Busy retries since 06:45, still within their window when 07:00 arrives.
    const busyTask = h.addTask({ nextRunAt: next, schedule: hourly });
    const busy = h.addOccurrence(busyTask, { reasonCode: "chat_busy", scheduledFor: new Date("2026-10-05T06:00:00.000Z"),
      startedAt: new Date("2026-10-05T06:45:00.000Z"), trigger: "schedule" });
    // Never leased: no execution slot was free.
    const waitingTask = h.addTask({ nextRunAt: next, schedule: hourly, userId: "owner-2" });
    const waiting = h.addOccurrence(waitingTask, { scheduledFor: new Date("2026-10-05T06:00:00.000Z"), trigger: "schedule" });
    h.advance(HOUR);
    await h.tick();
    expect(busy).toMatchObject({ reasonCode: "chat_busy", state: "SKIPPED", unseenAt: null });
    expect(waiting).toMatchObject({ reasonCode: "superseded", state: "SKIPPED", unseenAt: null });
    // The fresh instant runs instead.
    for (const task of [busyTask, waitingTask]) {
      expect(h.forTask(task).map((row) => [row.scheduledFor.toISOString(), row.state])).toEqual([
        ["2026-10-05T06:00:00.000Z", "SKIPPED"], ["2026-10-05T07:00:00.000Z", "COMPLETED"]
      ]);
    }
  });

  it("collapses a backlog to one missed record and one run of the newest instant", async () => {
    const h = harness();
    const task = h.addTask({ nextRunAt: new Date("2026-10-02T06:00:00.000Z") });
    h.advance(2 * HOUR);
    await h.tick();
    expect(h.forTask(task).map((row) => [row.scheduledFor.toISOString(), row.state, row.reasonCode])).toEqual([
      ["2026-10-02T06:00:00.000Z", "SKIPPED", "missed"],
      ["2026-10-05T06:00:00.000Z", "COMPLETED", null]
    ]);
    expect(task.nextRunAt).toEqual(new Date("2026-10-06T06:00:00.000Z"));
    expect(h.sent).toHaveLength(1);
    expect(h.forTask(task)[0]!.unseenAt).toBeNull();
  });

  it("retries a busy chat each tick within the window, then records chat_busy", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => ({ error: "active_run_in_progress", status: 409 }));
    await h.tick();
    const [occurrence] = h.forTask(task);
    expect(occurrence).toMatchObject({ leaseExpiresAt: null, reasonCode: "chat_busy", runId: null, state: "PENDING" });
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(2);
    h.advance(16 * MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(occurrence).toMatchObject({ reasonCode: "chat_busy", state: "SKIPPED", unseenAt: null });
    expect(task).toMatchObject({ consecutiveFailures: 0, status: "ACTIVE" });
  });

  it("retries a server error before any run within the window without counting a failure", async () => {
    const h = harness();
    const task = h.addTask({ consecutiveFailures: 2 });
    h.setReply(() => ({ error: "internal_error", status: 500 }));
    await h.tick();
    const [occurrence] = h.forTask(task);
    expect(occurrence).toMatchObject({ leaseExpiresAt: null, reasonCode: null, runId: null, state: "PENDING", unseenAt: null });
    expect(task).toMatchObject({ consecutiveFailures: 2, status: "ACTIVE" });
    // Retried by the timer only: no wake-up that would spin on a failing database.
    expect(h.kick).not.toHaveBeenCalled();
    h.advance(MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(2);
    expect(occurrence!.state).toBe("PENDING");
    // A recovered handler admits it on a later tick.
    h.setReply(() => ({ runStatus: "complete" }));
    h.advance(MINUTE);
    await h.tick();
    expect(occurrence).toMatchObject({ reasonCode: null, state: "COMPLETED" });
    expect(task.consecutiveFailures).toBe(0);

    // Still failing when the window ends: one failure, counted once.
    const failing = h.addTask({ consecutiveFailures: 1, userId: "owner-2" });
    h.setReply(() => ({ error: "internal_error", status: 503 }));
    await h.tick();
    h.advance(31 * MINUTE);
    await h.tick();
    expect(h.forTask(failing)).toMatchObject([{ reasonCode: "admission_failed", runId: null, state: "FAILED", unseenAt: null }]);
    expect(failing).toMatchObject({ consecutiveFailures: 2, status: "ACTIVE" });
  });

  it("sends result emails outside the tick, one at a time", async () => {
    const h = harness();
    const first = h.addTask({ emailNotify: true });
    const second = h.addTask({ emailNotify: true, userId: "owner-2" });
    const delivered: SmtpProductMessage[] = [];
    const pending: Array<() => void> = [];
    const runner = createScheduledTaskRunner({
      appBaseUrl: "https://aiqsa.example.test",
      loadCatalog: async () => ({ models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false,
        nativeWebSearch: false, openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: true },
      modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }], searchPlan: { mode: "all_selected", optionIds: [] },
      searchStrategies: [] }),
      now: () => new Date("2026-10-05T06:00:05.000Z"),
      renameChat: async () => undefined,
      // A permanent refusal pauses each task: news the owner hears about.
      send: async () => Response.json({ error: "model_not_available" }, { status: 403 }),
      // SMTP that hangs until released.
      sendEmail: (message) => new Promise<void>((resolve) => { pending.push(() => { delivered.push(message); resolve(); }); }),
      store: h.store
    });
    await runner.tick();
    // Both runs settled without waiting for mail; only one email holds an SMTP slot.
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(h.forTask(first)).toMatchObject([{ reasonCode: "model_unavailable", state: "FAILED" }]);
    expect(h.forTask(second)).toMatchObject([{ reasonCode: "model_unavailable", state: "FAILED" }]);
    await runner.tick();
    expect(pending).toHaveLength(1);
    pending[0]!();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!();
    await runner.idle();
    expect(delivered.map((message) => message.subject)).toEqual(["Scheduled task paused", "Scheduled task paused"]);
    // At most once: a later settlement pass never claims them again.
    await runner.tick();
    await runner.idle();
    expect(pending).toHaveLength(2);
  });

  it("pauses a scheduled task on a permanent refusal without trying another model", async () => {
    const h = harness();
    const task = h.addTask();
    h.setCatalog(() => null);
    await h.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "model_unavailable", state: "FAILED" }]);
    expect(h.forTask(task)[0]!.unseenAt).not.toBeNull();
    expect(task).toMatchObject({ nextRunAt: null, pauseReason: "model_unavailable", revision: 2, status: "PAUSED" });

    const searching = h.addTask({ searchEnabled: true, userId: "owner-2" });
    h.setCatalog(() => ({ models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false,
      nativeWebSearch: false, openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: true },
    modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }], searchPlan: { mode: "all_selected", optionIds: [] },
    searchStrategies: [] }));
    await h.tick();
    expect(searching).toMatchObject({ pauseReason: "search_unavailable", status: "PAUSED" });

    const refused = h.addTask({ userId: "owner-3" });
    h.setCatalog((userId) => userId === "owner-3" ? {
      models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
        openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: false },
      modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }],
      searchPlan: { mode: "all_selected", optionIds: [] }, searchStrategies: [] } : null);
    h.setReply(() => ({ error: "credential_revoked", status: 403 }));
    await h.tick();
    expect(h.sent.at(-1)!.body).toMatchObject({ tools: "none" });
    expect(refused).toMatchObject({ pauseReason: "provider_unavailable", status: "PAUSED" });
  });

  it("pauses after three consecutive failed scheduled runs and resets on success", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => ({ errorCode: "provider_timeout", runStatus: "error" }));
    for (let day = 0; day < 2; day += 1) {
      await h.tick();
      h.advance(24 * HOUR);
    }
    expect(task).toMatchObject({ consecutiveFailures: 2, status: "ACTIVE" });
    // A failure that does not pause the task stays history only.
    expect(h.forTask(task).every((row) => row.unseenAt === null)).toBe(true);
    h.setReply(() => ({ runStatus: "complete" }));
    await h.tick();
    expect(task.consecutiveFailures).toBe(0);
    h.setReply(() => ({ errorCode: "provider_timeout", runStatus: "error" }));
    for (let day = 0; day < 3; day += 1) {
      h.advance(24 * HOUR);
      await h.tick();
    }
    expect(h.forTask(task).filter((row) => row.state === "FAILED").map((row) => row.reasonCode)).toEqual(
      ["provider_timeout", "provider_timeout", "provider_timeout", "provider_timeout", "provider_timeout"]);
    expect(task).toMatchObject({ consecutiveFailures: 3, nextRunAt: null, pauseReason: "repeated_failures", status: "PAUSED" });
    // Only the failure that paused it is news.
    expect(h.forTask(task).filter((row) => row.unseenAt !== null).map((row) => row.state)).toEqual(["COMPLETED", "FAILED"]);
  });

  it("caps executions at five installation-wide and one per owner, counting runs of deleted tasks", async () => {
    const h = harness();
    let admitted = 0;
    h.setReply(() => { admitted += 1; return { runStatus: "streaming" }; });
    const owners = ["owner-1", "owner-1", "owner-2", "owner-3", "owner-4", "owner-5", "owner-6"].map((userId) => h.addTask({ userId }));
    await h.tick();
    expect(admitted).toBe(5);
    const running = h.occurrences.filter((row) => row.state === "RUNNING");
    expect(new Set(running.map((row) => row.userId)).size).toBe(5);
    expect(h.occurrences.filter((row) => row.state === "PENDING")).toHaveLength(2);
    // Runs still active keep their slots, even when their task and history are gone.
    h.tasks.delete(running[0]!.taskId);
    await h.tick();
    expect(admitted).toBe(5);
    for (const row of running) h.runs.get(row.runId!)!.status = "complete";
    await h.tick();
    expect(admitted).toBe(7);
    expect(owners.filter((task) => h.tasks.has(task.id)).every((task) => h.forTask(task).length === 1)).toBe(true);
  });

  it("fences an admission against a pause made while it was prepared", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => {
      // The owner pauses the task while the send is prepared.
      Object.assign(task, { nextRunAt: null, revision: task.revision + 1, status: "PAUSED" });
      return { runStatus: "complete" };
    });
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ runId: null, state: "PENDING" }]);
    h.setReply(() => ({ runStatus: "complete" }));
    await h.tick();
    // Re-admitted under the current task: a paused task's scheduled instant is skipped, quietly.
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "paused", runId: null, state: "SKIPPED", unseenAt: null }]);
    expect(h.runs.size).toBe(0);
  });

  it("re-admits an interrupted admission once and never a linked occurrence", async () => {
    const h = harness();
    const task = h.addTask({ nextRunAt: null });
    // A crash after the lease, before any run: once the lease expires it is admitted again.
    const interrupted = h.addOccurrence(task, { leaseExpiresAt: new Date("2026-10-05T06:00:04.000Z"),
      startedAt: new Date("2026-10-05T05:59:00.000Z"), trigger: "schedule" });
    // A crash after the link: its run is left active until run recovery settles it.
    const other = h.addTask({ nextRunAt: null, userId: "owner-2" });
    h.runs.set("run-orphan", { assistantMessageId: "assistant-orphan", errorPayload: null, status: "streaming", userId: "owner-2" });
    const linked = h.addOccurrence(other, { runId: "run-orphan", startedAt: new Date("2026-10-05T06:00:00.000Z"), state: "RUNNING",
      trigger: "schedule" });
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(interrupted).toMatchObject({ state: "COMPLETED" });
    expect(linked.state).toBe("RUNNING");
    h.runs.set("run-orphan", { assistantMessageId: "assistant-orphan", errorPayload: { code: "run_orphaned" }, status: "error",
      userId: "owner-2" });
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(linked).toMatchObject({ reasonCode: "run_orphaned", state: "FAILED" });
  });

  it("never admits again an occurrence the handler accepted without a visible link", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => ({ runStatus: "complete", unlinked: true }));
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "admission_failed", runId: null, state: "FAILED" }]);
    h.advance(MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(1);
  });

  it("releases an occurrence whose admission threw before any run and retries it on a later tick only", async () => {
    const h = harness();
    const task = h.addTask();
    const kick = vi.fn();
    const send = vi.fn<ScheduledTaskSend>(async () => Response.json({ error: "active_run_in_progress" }, { status: 409 }));
    let catalogFails = true;
    const runner = createScheduledTaskRunner({
      appBaseUrl: "https://aiqsa.example.test", kick,
      loadCatalog: async () => {
        if (catalogFails) throw new Error("catalog_unavailable");
        return { models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
          openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: true },
        modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }], searchPlan: { mode: "all_selected", optionIds: [] },
        searchStrategies: [] };
      },
      now: () => new Date("2026-10-05T06:00:05.000Z"), renameChat: async () => undefined, send, store: h.store
    });
    await runner.tick();
    await runner.idle();
    expect(h.forTask(task)).toMatchObject([{ leaseExpiresAt: null, runId: null, state: "PENDING" }]);
    // A busy chat is retried by the timer, never by an immediate wake-up that would spin.
    catalogFails = false;
    await runner.tick();
    await runner.idle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "chat_busy", state: "PENDING" }]);
    expect(kick).not.toHaveBeenCalled();
  });

  it("runs manual occurrences in any status without changing the schedule or pausing", async () => {
    const h = harness();
    const task = h.addTask({ nextRunAt: null, pauseReason: null, status: "PAUSED" });
    const manual = h.addOccurrence(task);
    await h.tick();
    expect(manual).toMatchObject({ state: "COMPLETED", trigger: "manual" });
    expect(task).toMatchObject({ nextRunAt: null, revision: 1, status: "PAUSED" });
    h.setReply(() => ({ error: "model_not_available", status: 403 }));
    const refused = h.addOccurrence(task);
    const active = h.addTask({ userId: "owner-2" });
    active.nextRunAt = new Date("2026-10-06T06:00:00.000Z");
    const activeManual = h.addOccurrence(active);
    await h.tick();
    expect(refused).toMatchObject({ reasonCode: "model_unavailable", state: "FAILED", unseenAt: null });
    expect(activeManual).toMatchObject({ reasonCode: "model_unavailable", state: "FAILED" });
    expect(active).toMatchObject({ consecutiveFailures: 0, nextRunAt: new Date("2026-10-06T06:00:00.000Z"), status: "ACTIVE" });
  });

  it("skips scheduled occurrences of paused tasks and pauses tasks of inactive owners", async () => {
    const h = harness();
    const paused = h.addTask({ emailNotify: true, nextRunAt: null, status: "PAUSED" });
    const leftover = h.addOccurrence(paused, { trigger: "schedule" });
    const inactive = h.addTask({ userId: "owner-2" });
    h.inactiveUsers.add("owner-2");
    await h.tick();
    expect(leftover).toMatchObject({ reasonCode: "paused", state: "SKIPPED" });
    // The owner's own pause is not news: no unread result and no email.
    expect(leftover.unseenAt).toBeNull();
    expect(h.emails).toHaveLength(0);
    expect(h.forTask(inactive)).toMatchObject([{ reasonCode: "account_inactive", state: "FAILED" }]);
    expect(inactive).toMatchObject({ pauseReason: "account_inactive", status: "PAUSED" });
    expect(h.sent).toHaveLength(0);
  });

  it("tolerates a task deleted while its occurrence is pending", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply((occurrence) => {
      h.tasks.delete(occurrence.taskId);
      return { error: "unauthorized", status: 401 };
    });
    await h.tick();
    expect(h.tasks.has(task.id)).toBe(false);
    expect(h.emails).toHaveLength(0);
  });
});
