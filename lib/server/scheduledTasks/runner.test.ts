import { describe, expect, it, vi } from "vitest";
import type {
  ScheduledTaskChatMode,
  ScheduledTaskKind,
  ScheduledTaskRunTrigger,
  ScheduledTaskSchedule
} from "../../contracts/scheduledTasks";
import type { SmtpProductMessage } from "../email/definitions";
import type { ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";
import type { ScheduledTaskSend } from "./admission";
import type { ScheduledTaskRunCatalog } from "./catalog";
import { createScheduledTaskRunner } from "./runner";
import {
  SCHEDULED_TASK_RUN_DEADLINE_MS,
  completedRunCheck,
  expiredPendingOutcome,
  linkedRunOutcome,
  planClaimOverlap,
  planOccurrenceSettlement,
  planScheduledTaskClaim,
  type MonitoringCheckSettlement,
  type MonitoringVerdict,
  type ScheduledTaskBaseline,
  type ScheduledTaskOutcome,
  type ScheduledTaskStatusColumn
} from "./runnerPolicy";
import type { ScheduledTaskRunnerStore, ScheduledTaskSettlement } from "./runnerStore";
import { occurrenceCheckSourcesMissing, occurrenceSourcesIncomplete, unavailableSourcesWire } from "./sourceHealth";

type Task = {
  baseline: ScheduledTaskBaseline | null; chatId: string | null; chatMode: ScheduledTaskChatMode; completionReason: string | null;
  consecutiveFailures: number; consecutiveIncompleteRuns: number; consecutiveMissingVerdicts: number; emailNotify: boolean;
  generation: number; id: string; kind: ScheduledTaskKind; memoryEnabled: boolean; modelId: string; nextRunAt: Date | null;
  pauseReason: string | null; prompt: string; provider: string;
  /** What the store derives from the previous shown result (null: every server). */
  relevantMcpServerIds: readonly string[] | null;
  revision: number; schedule: ScheduledTaskSchedule; searchEnabled: boolean;
  status: ScheduledTaskStatusColumn; timeZone: string; title: string; toolsEnabled: boolean; userId: string; workspaceEnabled: boolean;
};
type Occurrence = {
  chatId: string | null; createdAt: number; finishedAt: Date | null; id: string; leaseExpiresAt: Date | null; notifiedAt: Date | null;
  reasonCode: string | null; runId: string | null; scheduledFor: Date; startedAt: Date | null; state: string; taskGeneration: number | null;
  taskId: string; taskRevision: number | null; trigger: ScheduledTaskRunTrigger; unavailableSources: unknown; unseenAt: Date | null;
  userId: string; userMessageId: string | null; verdict: MonitoringVerdict | null;
};
/** `createdAt` is the run's admission, which its deadline counts from. */
type Run = {
  assistantMessageId: string; createdAt: Date; errorPayload: unknown; scheduledOutcome?: string; status: string; userId: string;
};

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
  const pushes: string[] = [];
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
  /**
   * What the ordinary send handler does for the next send: admit a run ending
   * in `runStatus` (its admission freezing `unavailableSources` on the
   * occurrence; a monitoring check's run may report `verdict`), or refuse.
   */
  let reply: (occurrence: Occurrence) => { error: string; status: number } | {
    runStatus: string; errorCode?: string; unavailableSources?: unknown; unlinked?: true; verdict?: MonitoringVerdict;
  } = () => ({ runStatus: "complete" });
  const stops: Array<{ code: string; runId: string; userId: string }> = [];
  const nextId = (prefix: string) => `${prefix}-${++ids}`;

  /** As the Prisma store applies `planOccurrenceSettlement` under its row locks. */
  function settle(occurrence: Occurrence, outcome: ScheduledTaskOutcome, observedRevision?: number,
    check: MonitoringCheckSettlement | null = null): ScheduledTaskSettlement {
    const task = tasks.get(occurrence.taskId)!;
    const run = occurrence.runId ? runs.get(occurrence.runId) : undefined;
    const sourcesIncomplete = outcome.state === "COMPLETED" && occurrenceSourcesIncomplete(occurrence.unavailableSources);
    const plan = planOccurrenceSettlement({ assistantMessageId: run?.assistantMessageId ?? null, check, observedRevision, occurrence,
      outcome, sourcesIncomplete, task });
    Object.assign(occurrence, { finishedAt: clock, leaseExpiresAt: null, reasonCode: outcome.reasonCode, state: outcome.state,
      unseenAt: plan.notifies ? clock : null });
    Object.assign(task, { consecutiveFailures: plan.consecutiveFailures, consecutiveIncompleteRuns: plan.consecutiveIncompleteRuns,
      consecutiveMissingVerdicts: plan.consecutiveMissingVerdicts },
      plan.baseline ? { baseline: plan.baseline } : {},
      plan.pauseReason ? { nextRunAt: null, pauseReason: plan.pauseReason, revision: task.revision + 1, status: "PAUSED" } : {},
      plan.goalCompletes ? { completionReason: "goal_reached", nextRunAt: null, pauseReason: null, revision: task.revision + 1,
        status: "COMPLETED" } : {});
    if (check && run) run.scheduledOutcome = check.outcome;
    settled.push({ occurrenceId: occurrence.id, sourceAlert: plan.sourceAlert });
    return { occurrenceId: occurrence.id, reasonCode: outcome.reasonCode, runId: occurrence.runId, sourceAlert: plan.sourceAlert,
      sourcesIncomplete, state: outcome.state, taskPaused: plan.pauseReason !== null };
  }
  /** Every settlement's health alert flag, in order. */
  const settled: Array<{ occurrenceId: string; sourceAlert: boolean }> = [];
  const find = (id: string) => occurrences.find((occurrence) => occurrence.id === id && tasks.has(occurrence.taskId));
  const leased = (occurrence: Occurrence) =>
    occurrence.state === "PENDING" && occurrence.runId === null && occurrence.leaseExpiresAt !== null && occurrence.leaseExpiresAt > clock;
  const quietSkip = (occurrence: Occurrence, reasonCode: string): ScheduledTaskSettlement => {
    Object.assign(occurrence, { finishedAt: clock, leaseExpiresAt: null, reasonCode, state: "SKIPPED" });
    return { occurrenceId: occurrence.id, reasonCode, runId: null, sourceAlert: false, sourcesIncomplete: false, state: "SKIPPED",
      taskPaused: false };
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
            state: reasonCode ? "SKIPPED" : "PENDING", taskGeneration: null, taskId: task.id, taskRevision: null, trigger: "schedule",
            unavailableSources: null, unseenAt: null, userId: task.userId, userMessageId: null, verdict: null
          };
          occurrences.push(occurrence);
          if (reasonCode) {
            settlements.push({ occurrenceId: occurrence.id, reasonCode, runId: null, sourceAlert: false, sourcesIncomplete: false,
              state: "SKIPPED", taskPaused: false });
          }
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
        relevantMcpServerIds: task.relevantMcpServerIds,
        task: { baseline: task.baseline, chatMode: task.chatMode, generation: task.generation, kind: task.kind,
          memoryEnabled: task.memoryEnabled, modelId: task.modelId, prompt: task.prompt, provider: task.provider,
          revision: task.revision,
          searchEnabled: task.searchEnabled, status: task.status, timeZone: task.timeZone, title: task.title,
          toolsEnabled: task.toolsEnabled, workspaceEnabled: task.workspaceEnabled }
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
      if (!outcome) return null;
      const task = tasks.get(row.taskId)!;
      // Health first, from the source health its admission froze, as the store judges it.
      const check = outcome.state === "COMPLETED" ? completedRunCheck({
        healthIncomplete: occurrenceCheckSourcesMissing(row.unavailableSources), occurrence: row,
        task: { ...task, baselineGeneration: task.baseline?.generation ?? null } }) : null;
      return settle(row, check ? { reasonCode: check.outcome, state: "COMPLETED" } : outcome, undefined, check);
    },
    async claimNotification(id, now) {
      const row = find(id);
      const task = row && tasks.get(row.taskId);
      if (!row || !task || row.notifiedAt || !["COMPLETED", "FAILED", "SKIPPED"].includes(row.state) || !task.emailNotify) return null;
      row.notifiedAt = now;
      return { chatId: row.chatId ?? task.chatId, email: "owner@example.test", reasonCode: row.reasonCode,
        state: row.state as "COMPLETED", taskPauseReason: task.pauseReason, title: task.title, trigger: row.trigger,
        unavailableSources: unavailableSourcesWire(row.unavailableSources) };
    },
    async overdueRuns(now) {
      // By the origin on the run itself: a run of a deleted task is still found.
      return [...runs.entries()]
        .filter(([, run]) => !["complete", "cancelled", "error"].includes(run.status) &&
          run.createdAt.getTime() <= now.getTime() - SCHEDULED_TASK_RUN_DEADLINE_MS)
        .map(([runId, run]) => ({ runId, userId: run.userId }));
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
    runs.set(runId, { assistantMessageId, createdAt: clock, errorPayload: decision.errorCode ? { code: decision.errorCode } : null,
      status: decision.runStatus, userId: occurrence.userId });
    chats.set(chatId, { activeLeafMessageId: assistantMessageId, usable: true, userId: occurrence.userId });
    Object.assign(occurrence, { chatId, leaseExpiresAt: null, reasonCode: null, runId, state: "RUNNING",
      taskGeneration: origin.taskGeneration, taskRevision: origin.taskRevision, unavailableSources: decision.unavailableSources ?? null,
      userMessageId,
      // Only a run admitted for a monitoring occurrence holds the reporting tool.
      verdict: origin.monitoring === true ? decision.verdict ?? null : null });
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
    sendPush: (occurrenceId) => { pushes.push(occurrenceId); },
    // The Stop path: an active run becomes cancelled with the given cause.
    stopRun: async ({ code, runId, userId }) => {
      stops.push({ code, runId, userId });
      const run = runs.get(runId);
      if (!run || run.userId !== userId) return "not_found";
      if (["complete", "cancelled", "error"].includes(run.status)) return "not_cancelable";
      Object.assign(run, { errorPayload: { code, message: "stopped" }, status: "cancelled" });
      return "stopped";
    },
    store
  });

  function addTask(overrides: Partial<Task> = {}): Task {
    const task: Task = {
      baseline: null, chatId: null, chatMode: "same", completionReason: null, consecutiveFailures: 0, consecutiveIncompleteRuns: 0,
      consecutiveMissingVerdicts: 0, emailNotify: false, generation: 1, id: nextId("task"), kind: "standard", memoryEnabled: false,
      modelId: "model-a",
      nextRunAt: new Date("2026-10-05T06:00:00.000Z"), pauseReason: null, prompt: "  Summarize the synthetic fixture  ",
      provider: "connection-a", relevantMcpServerIds: null, revision: 1, schedule: { kind: "daily", time: "09:00" },
      searchEnabled: false, status: "ACTIVE", timeZone: "Europe/Moscow", title: "Synthetic brief", toolsEnabled: false,
      userId: "owner-1", workspaceEnabled: false, ...overrides
    };
    tasks.set(task.id, task);
    return task;
  }
  function addOccurrence(task: Task, overrides: Partial<Occurrence> = {}): Occurrence {
    const occurrence: Occurrence = {
      chatId: null, createdAt: ids, finishedAt: null, id: nextId("occurrence"), leaseExpiresAt: null, notifiedAt: null, reasonCode: null,
      runId: null, scheduledFor: clock, startedAt: null, state: "PENDING", taskGeneration: null, taskId: task.id, taskRevision: null,
      trigger: "manual", unavailableSources: null, unseenAt: null, userId: task.userId, userMessageId: null, verdict: null, ...overrides
    };
    occurrences.push(occurrence);
    return occurrence;
  }
  async function tick(): Promise<void> {
    await runner.tick();
    await runner.idle();
  }
  return {
    addOccurrence, addTask, chats, emails, inactiveUsers, kick, occurrences, pushes, renamed, runs, sent, settled, stops, store, tasks,
    tick,
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
    expect(h.sent[0]!.occurrence).toEqual({ occurrenceId: h.forTask(task)[0]!.id, previousResult: null, relevantMcpServerIds: null,
      taskGeneration: 1, taskId: task.id, taskRevision: 1 });
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
    const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } satisfies ScheduledTaskSchedule;
    // A scheduled run ends within its deadline, well before the next hour: a
    // Run now shortly before an instant is what can still be in progress.
    const task = h.addTask({ emailNotify: true, nextRunAt: new Date("2026-10-05T07:00:00.000Z"), schedule: hourly });
    h.advance(50 * MINUTE);
    h.addOccurrence(task);
    h.setReply(() => ({ runStatus: "streaming" }));
    await h.tick();
    const [running] = h.forTask(task);
    expect(running).toMatchObject({ state: "RUNNING", trigger: "manual" });
    h.advance(10 * MINUTE);
    await h.tick();
    expect(h.forTask(task).map((row) => [row.scheduledFor.toISOString(), row.state, row.reasonCode])).toEqual([
      ["2026-10-05T06:50:05.000Z", "RUNNING", null],
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
    const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } satisfies ScheduledTaskSchedule;
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
      stopRun: async () => "not_found",
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
    h.runs.set("run-orphan", { assistantMessageId: "assistant-orphan", createdAt: new Date("2026-10-05T06:00:00.000Z"), errorPayload: null,
      status: "streaming", userId: "owner-2" });
    const linked = h.addOccurrence(other, { runId: "run-orphan", startedAt: new Date("2026-10-05T06:00:00.000Z"), state: "RUNNING",
      trigger: "schedule" });
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(interrupted).toMatchObject({ state: "COMPLETED" });
    expect(linked.state).toBe("RUNNING");
    h.runs.set("run-orphan", { assistantMessageId: "assistant-orphan", createdAt: new Date("2026-10-05T06:00:00.000Z"),
      errorPayload: { code: "run_orphaned" }, status: "error", userId: "owner-2" });
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
      now: () => new Date("2026-10-05T06:00:05.000Z"), renameChat: async () => undefined, send, stopRun: async () => "not_found",
      store: h.store
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
    expect(h.pushes).not.toContain(leftover.id);
    expect(h.forTask(inactive)).toMatchObject([{ reasonCode: "account_inactive", state: "FAILED" }]);
    expect(inactive).toMatchObject({ pauseReason: "account_inactive", status: "PAUSED" });
    expect(h.sent).toHaveLength(0);
  });

  it("queues one browser push per notifying settlement, with or without result email, never for a quiet skip", async () => {
    const h = harness();
    const task = h.addTask({ emailNotify: false, nextRunAt: new Date("2026-10-02T06:00:00.000Z") });
    h.advance(2 * 60 * MINUTE);
    await h.tick();
    const [missed, completed] = h.forTask(task);
    expect(missed).toMatchObject({ reasonCode: "missed", state: "SKIPPED" });
    expect(completed).toMatchObject({ state: "COMPLETED" });
    expect(h.pushes).toEqual([completed!.id]);
    expect(h.emails).toHaveLength(0);
    await h.tick();
    expect(h.pushes).toHaveLength(1);
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

describe("scheduled task runner with the owner's tools", () => {
  it("sends the owner's MCP tools and Skills in Auto and the task's Workspace, like an ordinary message", async () => {
    const h = harness();
    const tooling = h.addTask({ toolsEnabled: true, workspaceEnabled: true });
    const plain = h.addTask({ userId: "owner-2" });
    await h.tick();
    const [toolSend, plainSend] = [tooling, plain].map((task) => h.sent.find((send) => send.occurrence.taskId === task.id)!);
    expect(toolSend.body).toMatchObject({ knowledgePlan: { mode: "none" }, mcp: { mode: "auto" }, skills: { mode: "auto" },
      workspace: { enabled: true } });
    // Never Load all, which fails a whole unattended run when one server is not ready, and never Agent.
    expect(toolSend.body).not.toHaveProperty("tools");
    expect(toolSend.body).not.toHaveProperty("agentEnabled");
    expect(plainSend.body).toMatchObject({ mcp: { mode: "off" }, skills: { mode: "off" }, workspace: { enabled: false } });
  });

  it("passes the servers the previous result relied on to admission", async () => {
    const h = harness();
    const task = h.addTask({ relevantMcpServerIds: ["server-mail"], toolsEnabled: true });
    await h.tick();
    expect(h.sent[0]!.occurrence.relevantMcpServerIds).toEqual(["server-mail"]);
  });

  it("pauses before any send when tools or Workspace need tool calling the model lost", async () => {
    const h = harness();
    const noTools = (userId: string) => ({ models: [{ capabilities: { background: false, documentInputMode: "none" as const,
      imageInput: false, nativeWebSearch: false, openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true as const,
      toolCalling: userId === "owner-3" }, modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }],
    searchPlan: { mode: "all_selected" as const, optionIds: [] }, searchStrategies: [] });
    h.setCatalog(noTools);
    const tools = h.addTask({ toolsEnabled: true });
    const workspace = h.addTask({ userId: "owner-2", workspaceEnabled: true });
    const fine = h.addTask({ toolsEnabled: true, userId: "owner-3", workspaceEnabled: true });
    await h.tick();
    expect(h.forTask(tools)).toMatchObject([{ reasonCode: "tools_unavailable", state: "FAILED" }]);
    expect(tools).toMatchObject({ pauseReason: "tools_unavailable", status: "PAUSED" });
    expect(h.forTask(workspace)).toMatchObject([{ reasonCode: "workspace_unavailable", state: "FAILED" }]);
    expect(workspace).toMatchObject({ pauseReason: "workspace_unavailable", status: "PAUSED" });
    expect(h.sent.map((send) => send.occurrence.taskId)).toEqual([fine.id]);
  });

  it("pauses on a permanent tool or Workspace refusal and retries a transient one, never failing in a loop", async () => {
    const h = harness();
    const refusing = h.addTask({ emailNotify: true, toolsEnabled: true, workspaceEnabled: true });
    h.setReply(() => ({ error: "workspace_disabled", status: 409 }));
    await h.tick();
    expect(h.forTask(refusing)).toMatchObject([{ reasonCode: "workspace_unavailable", state: "FAILED" }]);
    expect(refusing).toMatchObject({ nextRunAt: null, pauseReason: "workspace_unavailable", status: "PAUSED" });
    expect(h.emails.map((email) => email.subject)).toEqual(["Scheduled task paused"]);
    expect(h.emails[0]!.text).toContain("Workspace can no longer be used for this task.");
    // Paused: no later instant fails and emails again.
    h.advance(24 * HOUR);
    await h.tick();
    expect(h.forTask(refusing)).toHaveLength(1);

    const transient = harness();
    const waiting = transient.addTask({ toolsEnabled: true, workspaceEnabled: true });
    transient.setReply(() => ({ error: "workspace_runtime_unavailable", status: 503 }));
    await transient.tick();
    expect(transient.forTask(waiting)).toMatchObject([{ reasonCode: null, runId: null, state: "PENDING" }]);
    transient.setReply(() => ({ runStatus: "complete" }));
    transient.advance(MINUTE);
    await transient.tick();
    expect(transient.forTask(waiting)).toMatchObject([{ state: "COMPLETED" }]);
    expect(waiting).toMatchObject({ consecutiveFailures: 0, status: "ACTIVE" });

    // A Workspace that stays busy through the window is a counted failure, never a quiet skip.
    const stuck = harness();
    const busy = stuck.addTask({ workspaceEnabled: true });
    stuck.setReply(() => ({ error: "workspace_busy", status: 409 }));
    await stuck.tick();
    stuck.advance(31 * MINUTE);
    await stuck.tick();
    expect(stuck.forTask(busy)).toMatchObject([{ reasonCode: "admission_failed", state: "FAILED" }]);
    expect(busy).toMatchObject({ consecutiveFailures: 1, status: "ACTIVE" });
  });
});

describe("scheduled run deadline", () => {
  it("stops a run through the Stop path thirty minutes after its admission and fails it as run_deadline", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const h = harness();
    const task = h.addTask({ consecutiveFailures: 1 });
    // The chat is busy at first: the occurrence's first attempt is long before the run's admission.
    h.setReply(() => ({ error: "active_run_in_progress", status: 409 }));
    await h.tick();
    const [occurrence] = h.forTask(task);
    h.advance(20 * MINUTE);
    h.setReply(() => ({ runStatus: "streaming" }));
    await h.tick();
    expect(occurrence).toMatchObject({ startedAt: new Date("2026-10-05T06:00:05.000Z"), state: "RUNNING" });
    const admittedAt = h.runs.get(occurrence!.runId!)!.createdAt;
    expect(admittedAt).toEqual(new Date("2026-10-05T06:20:05.000Z"));
    // Thirty minutes after the first attempt, but not after admission: the run goes on.
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.stops).toEqual([]);
    expect(occurrence!.state).toBe("RUNNING");
    h.advance(SCHEDULED_TASK_RUN_DEADLINE_MS - 15 * MINUTE);
    await h.tick();
    expect(h.stops).toEqual([{ code: "run_deadline", runId: occurrence!.runId, userId: "owner-1" }]);
    expect(h.runs.get(occurrence!.runId!)).toMatchObject({ errorPayload: { code: "run_deadline" }, status: "cancelled" });
    // The occurrence settles from its run: failed run_deadline, counted toward the repeated-failure pause.
    await h.tick();
    expect(occurrence).toMatchObject({ reasonCode: "run_deadline", state: "FAILED" });
    expect(task).toMatchObject({ consecutiveFailures: 2, status: "ACTIVE" });
    expect(h.stops).toHaveLength(1);
    // Content-free logs carry the registered code, never "unknown".
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({ code: "run_deadline", event: "job_attempt", stage: "fail" }));
    expect(records).toContainEqual(expect.objectContaining({ code: "run_deadline", event: "job_attempt", stage: "settle" }));
    vi.restoreAllMocks();
  });

  it("stops an overdue run by its own origin even after its task was deleted", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => ({ runStatus: "streaming" }));
    await h.tick();
    const runId = h.forTask(task)[0]!.runId!;
    h.tasks.delete(task.id);
    h.advance(SCHEDULED_TASK_RUN_DEADLINE_MS);
    await h.tick();
    expect(h.stops).toEqual([{ code: "run_deadline", runId, userId: "owner-1" }]);
    expect(h.runs.get(runId)!.status).toBe("cancelled");
  });
});

describe("scheduled run source health", () => {
  const mail = { name: "Mail", reason: "mcp_reauthorization_required", relied: true, serverId: "server-mail" } as const;

  it("completes a run that missed a relevant source as incomplete, alerts once per streak and pauses at the third", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const h = harness();
    const task = h.addTask({ emailNotify: true, toolsEnabled: true });
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [mail] }));
    await h.tick();
    const [first] = h.forTask(task);
    // The result completed; its health is incomplete and the owner hears which source needs sign-in.
    expect(first).toMatchObject({ reasonCode: null, state: "COMPLETED" });
    expect(task).toMatchObject({ consecutiveFailures: 0, consecutiveIncompleteRuns: 1, status: "ACTIVE" });
    expect(h.emails.at(-1)).toMatchObject({ subject: "Scheduled task finished", text: expect.stringContaining("Mail needs sign-in.") });
    for (let day = 0; day < 2; day += 1) {
      h.advance(24 * HOUR);
      await h.tick();
    }
    expect(h.forTask(task).map((row) => row.state)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(h.settled.map((settlement) => settlement.sourceAlert)).toEqual([true, false, false]);
    expect(task).toMatchObject({ consecutiveIncompleteRuns: 3, nextRunAt: null, pauseReason: "source_unavailable", status: "PAUSED" });
    expect(h.emails.at(-1)).toMatchObject({ subject: "Scheduled task paused", text: expect.stringContaining("Mail needs sign-in.") });
    // The health is logged by its registered code, never by source name.
    expect(lines.join("")).not.toContain("Mail");
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>))
      .toContainEqual(expect.objectContaining({ code: "source_unavailable", outcome: "completed", stage: "settle" }));
    vi.restoreAllMocks();
  });

  it("ends the streak with a complete run and never pauses for manual runs", async () => {
    const h = harness();
    const task = h.addTask({ toolsEnabled: true });
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [mail] }));
    await h.tick();
    h.advance(24 * HOUR);
    await h.tick();
    expect(task.consecutiveIncompleteRuns).toBe(2);
    // A manual incomplete run neither extends the streak nor alerts.
    h.addOccurrence(task);
    await h.tick();
    expect(task).toMatchObject({ consecutiveIncompleteRuns: 2, status: "ACTIVE" });
    h.setReply(() => ({ runStatus: "complete" }));
    h.advance(24 * HOUR);
    await h.tick();
    expect(task).toMatchObject({ consecutiveIncompleteRuns: 0, status: "ACTIVE" });
    expect(h.settled.map((settlement) => settlement.sourceAlert)).toEqual([true, false, false, false]);
  });
});

describe("scheduled monitoring checks", () => {
  const DAY = 24 * HOUR;

  it("shows the first check, keeps later checks without news hidden and silent, and compares with the last shown result", async () => {
    const h = harness();
    const task = h.addTask({ emailNotify: true, kind: "monitoring" });
    // A first check is shown whatever it reports.
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    await h.tick();
    const [first] = h.forTask(task);
    expect(h.sent[0]!.occurrence).toMatchObject({ monitoring: true, previousResult: null });
    expect(first).toMatchObject({ reasonCode: "baseline", state: "COMPLETED", verdict: "no_update" });
    expect(first!.unseenAt).not.toBeNull();
    expect([h.emails.length, h.pushes]).toEqual([1, [first!.id]]);
    expect(h.emails[0]!.text).toContain("First check");
    expect(h.runs.get(first!.runId!)?.scheduledOutcome).toBe("baseline");
    const shown = task.baseline;
    expect(shown).toMatchObject({ runId: first!.runId });

    // No news: completed, but no unread result, email or push, and no new baseline.
    h.advance(DAY);
    await h.tick();
    const quiet = h.forTask(task)[1]!;
    expect(quiet).toMatchObject({ reasonCode: "no_update", state: "COMPLETED", unseenAt: null });
    expect([h.emails.length, h.pushes.length]).toEqual([1, 1]);
    expect(task.baseline).toEqual(shown);
    expect(h.runs.get(quiet.runId!)?.scheduledOutcome).toBe("no_update");

    // The next check still compares with the last shown result, never the hidden one.
    h.setReply(() => ({ runStatus: "complete", verdict: "update" }));
    h.advance(DAY);
    await h.tick();
    expect(h.sent[2]!.occurrence.previousResult).toEqual({ assistantMessageId: shown!.assistantMessageId,
      userMessageId: shown!.userMessageId });
    const news = h.forTask(task)[2]!;
    expect(news).toMatchObject({ reasonCode: "update", state: "COMPLETED" });
    expect(news.unseenAt).not.toBeNull();
    expect([h.emails.length, h.pushes.at(-1)]).toEqual([2, news.id]);
    expect(task.baseline).toMatchObject({ runId: news.runId });
  });

  it("lets a run read Memory only while its task has Memory on, by the revision its admission is fenced on", async () => {
    const h = harness();
    const task = h.addTask({ memoryEnabled: true });
    await h.tick();
    // The switch travels server-only with the occurrence, never in the composer-shaped body.
    expect(h.sent[0]!.occurrence).toMatchObject({ memory: true, taskRevision: 1 });
    expect(Object.keys(h.sent[0]!.body).some((key) => key.toLowerCase().includes("memory"))).toBe(false);
    // The owner turns it off: the next run is admitted under the new revision without it.
    Object.assign(task, { memoryEnabled: false, revision: 2 });
    h.advance(24 * HOUR);
    await h.tick();
    expect(h.sent[1]!.occurrence).toMatchObject({ taskRevision: 2 });
    expect(h.sent[1]!.occurrence).not.toHaveProperty("memory");
    expect(h.forTask(task).map((row) => row.state)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it("gives a standard task's runs no reporting duty and keeps their results ordinary", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    await h.tick();
    expect(h.sent[0]!.occurrence).not.toHaveProperty("monitoring");
    expect(h.forTask(task)).toMatchObject([{ reasonCode: null, state: "COMPLETED", verdict: null }]);
    expect(h.forTask(task)[0]!.unseenAt).not.toBeNull();
    expect(h.runs.get(h.forTask(task)[0]!.runId!)?.scheduledOutcome).toBeUndefined();
  });

  it("shows a check whose model never reported and pauses after three scheduled ones in a row", async () => {
    const h = harness();
    const task = h.addTask({ kind: "monitoring" });
    h.setReply(() => ({ runStatus: "complete" }));
    await h.tick();
    h.advance(DAY);
    await h.tick();
    // A manual check between scheduled ones neither counts nor pauses.
    const manual = h.addOccurrence(task);
    await h.tick();
    expect(manual).toMatchObject({ reasonCode: "unreported", state: "COMPLETED" });
    expect(task).toMatchObject({ consecutiveMissingVerdicts: 2, status: "ACTIVE" });
    h.advance(DAY);
    await h.tick();
    const checks = h.forTask(task).filter((occurrence) => occurrence.trigger === "schedule");
    expect(checks.map((occurrence) => occurrence.reasonCode)).toEqual(["unreported", "unreported", "unreported"]);
    // Every unreported check is shown and notified (fail-open).
    expect(checks.every((occurrence) => occurrence.unseenAt !== null)).toBe(true);
    expect(task).toMatchObject({ consecutiveMissingVerdicts: 3, nextRunAt: null, pauseReason: "verdict_missing", revision: 2,
      status: "PAUSED" });
    // The pausing check's notification says it paused the task.
    expect(h.pushes).toEqual(h.forTask(task).filter((occurrence) => occurrence.unseenAt !== null).map((occurrence) => occurrence.id));
    // A reported outcome resets the count.
    const reported = h.addTask({ consecutiveMissingVerdicts: 2, kind: "monitoring", userId: "owner-2" });
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    await h.tick();
    expect(reported).toMatchObject({ consecutiveMissingVerdicts: 0, status: "ACTIVE" });
  });

  it("completes the task when its goal is reached and notifies, unless the owner changed it meanwhile", async () => {
    const h = harness();
    const task = h.addTask({ emailNotify: true, kind: "monitoring" });
    h.setReply(() => ({ runStatus: "complete", verdict: "goal_reached" }));
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "goal_reached", state: "COMPLETED" }]);
    expect(task).toMatchObject({ completionReason: "goal_reached", nextRunAt: null, revision: 2, status: "COMPLETED" });
    expect(h.emails.at(-1)!.text).toContain("Goal reached");
    h.advance(DAY);
    await h.tick();
    expect(h.sent).toHaveLength(1);

    // An owner edit after admission wins: the reached goal is shown as an update and the task goes on.
    const edited = h.addTask({ kind: "monitoring", nextRunAt: new Date("2026-10-06T06:00:00.000Z"), userId: "owner-2" });
    h.setReply(() => ({ runStatus: "streaming", verdict: "goal_reached" }));
    await h.tick();
    const running = h.forTask(edited)[0]!;
    expect(running.state).toBe("RUNNING");
    edited.revision += 1;
    h.runs.get(running.runId!)!.status = "complete";
    await h.tick();
    expect(running).toMatchObject({ reasonCode: "update", state: "COMPLETED" });
    expect(running.unseenAt).not.toBeNull();
    expect(edited).toMatchObject({ completionReason: null, status: "ACTIVE" });
  });

  it("pauses a monitoring task whose model can no longer call its reporting tool", async () => {
    const h = harness();
    const task = h.addTask({ kind: "monitoring" });
    h.setCatalog(() => ({
      models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
        openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: false },
      modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }],
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchStrategies: []
    }));
    await h.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "model_cannot_report", state: "FAILED" }]);
    expect(task).toMatchObject({ pauseReason: "model_cannot_report", status: "PAUSED" });

    // Admission refuses the same way when the provider cannot offer the tool.
    const refused = harness();
    const other = refused.addTask({ kind: "monitoring" });
    refused.setReply(() => ({ error: "model_cannot_report", status: 409 }));
    await refused.tick();
    expect(other).toMatchObject({ pauseReason: "model_cannot_report", status: "PAUSED" });
  });
});

describe("scheduled monitoring checks and source health", () => {
  const DAY = 24 * HOUR;
  // Admission records `relied` once a previous shown result says which servers the task uses.
  const relied = { name: "Tracker", reason: "mcp_server_unavailable", relied: true, serverId: "server-tracker" } as const;
  const unjudged = { ...relied, relied: false } as const;

  it("settles a check that missed a source its baseline relied on as could not check, never a baseline or a reached goal", async () => {
    const h = harness();
    const task = h.addTask({ kind: "monitoring", toolsEnabled: true });
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    await h.tick();
    const shown = task.baseline;
    expect(h.forTask(task)[0]).toMatchObject({ reasonCode: "baseline", state: "COMPLETED" });
    // Even a reported goal cannot complete the task while its source is missing.
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [relied], verdict: "goal_reached" }));
    for (let day = 0; day < 3; day += 1) {
      h.advance(DAY);
      await h.tick();
    }
    const checks = h.forTask(task).slice(1);
    expect(checks.map((row) => row.reasonCode)).toEqual(["could_not_check", "could_not_check", "could_not_check"]);
    expect(checks.map((row) => h.runs.get(row.runId!)?.scheduledOutcome))
      .toEqual(["could_not_check", "could_not_check", "could_not_check"]);
    expect(task.baseline).toEqual(shown);
    // The incomplete streak runs exactly as for a standard task: one alert, then a pause at the third.
    expect(h.settled.slice(1).map((settlement) => settlement.sourceAlert)).toEqual([true, false, false]);
    expect(task).toMatchObject({ completionReason: null, consecutiveIncompleteRuns: 3, nextRunAt: null,
      pauseReason: "source_unavailable", status: "PAUSED" });
  });

  it("notifies of a check that could not check only as the streak's alert and its pause, the same way everywhere", async () => {
    const h = harness();
    const task = h.addTask({ emailNotify: true, kind: "monitoring", toolsEnabled: true });
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    await h.tick();
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [relied], verdict: "no_update" }));
    for (let day = 0; day < 3; day += 1) {
      h.advance(DAY);
      await h.tick();
    }
    const [baseline, alert, quiet, pausing] = h.forTask(task);
    // Unread, email and push follow one predicate: the baseline, the first could-not-check and the pausing one.
    const notified = [baseline!, alert!, pausing!].map((row) => row.id);
    expect(h.forTask(task).filter((row) => row.unseenAt !== null).map((row) => row.id)).toEqual(notified);
    expect(h.pushes).toEqual(notified);
    expect(quiet!.unseenAt).toBeNull();
    expect(h.emails.map((email) => email.subject)).toEqual(["Scheduled task finished", "Scheduled task finished", "Scheduled task paused"]);
    expect(h.emails[1]!.text).toContain("Could not check: a source was unavailable.\nTracker is unavailable.");
    expect(h.emails[2]!.text).toContain("could not reach a source the task uses");
    expect(h.emails[2]!.text).toContain("Tracker is unavailable.");
  });

  it("says in its email and push that the third check in a row without a report paused the task", async () => {
    const h = harness();
    const task = h.addTask({ consecutiveMissingVerdicts: 2, emailNotify: true, kind: "monitoring" });
    h.setReply(() => ({ runStatus: "complete" }));
    await h.tick();
    const [check] = h.forTask(task);
    expect(check).toMatchObject({ reasonCode: "unreported", state: "COMPLETED" });
    expect(task).toMatchObject({ pauseReason: "verdict_missing", status: "PAUSED" });
    expect(h.pushes).toEqual([check!.id]);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({ subject: "Scheduled task paused" });
    expect(h.emails[0]!.text).toContain("was paused.\nPaused after three checks in a row did not report whether anything changed.");
  });

  it("judges a check's sources, not its report: a missing report neither counts nor resets", async () => {
    const h = harness();
    const task = h.addTask({ consecutiveMissingVerdicts: 2, kind: "monitoring", toolsEnabled: true });
    h.setReply(() => ({ runStatus: "complete", verdict: "update" }));
    await h.tick();
    expect(task.consecutiveMissingVerdicts).toBe(0);
    task.consecutiveMissingVerdicts = 2;
    // Unreported while its source is gone: no third missing report, no verdict_missing pause.
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [relied] }));
    h.advance(DAY);
    await h.tick();
    expect(h.forTask(task)[1]).toMatchObject({ reasonCode: "could_not_check", verdict: null });
    expect(task).toMatchObject({ consecutiveIncompleteRuns: 1, consecutiveMissingVerdicts: 2, status: "ACTIVE" });
    // A report made without the source does not prove the check either.
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [relied], verdict: "no_update" }));
    h.advance(DAY);
    await h.tick();
    expect(task).toMatchObject({ consecutiveIncompleteRuns: 2, consecutiveMissingVerdicts: 2, status: "ACTIVE" });
  });

  it("lets a first check that missed only servers nothing relied on yet become the baseline, like a standard first result", async () => {
    const h = harness();
    const task = h.addTask({ kind: "monitoring", toolsEnabled: true });
    h.setReply(() => ({ runStatus: "complete", unavailableSources: [unjudged], verdict: "no_update" }));
    await h.tick();
    const [first] = h.forTask(task);
    expect(first).toMatchObject({ reasonCode: "baseline", state: "COMPLETED" });
    expect(task.baseline).toMatchObject({ runId: first!.runId });
    // Still incomplete in health: the one alert of its streak.
    expect(task.consecutiveIncompleteRuns).toBe(1);
    expect(h.settled.map((settlement) => settlement.sourceAlert)).toEqual([true]);
    // Relevance is judged by that baseline from now on: an unrelated server no longer counts.
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    h.advance(DAY);
    await h.tick();
    expect(h.forTask(task)[1]).toMatchObject({ reasonCode: "no_update", state: "COMPLETED" });
    expect(task).toMatchObject({ consecutiveIncompleteRuns: 0, status: "ACTIVE" });
  });
});
