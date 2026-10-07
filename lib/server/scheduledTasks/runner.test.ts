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
  SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD,
  SCHEDULED_TASK_LATENESS_MS,
  SCHEDULED_TASK_RETRY_WINDOW_MS,
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
import type { ScheduledWorkspaceCarryoverResult } from "./workspaceCarryover";

type Carryover = { answer: string; chatEpoch: number; reliedServerIds: readonly string[]; sourceAssistantMessageId: string;
  sourceChatId: string; taskGeneration: number };
type Task = {
  baseline: ScheduledTaskBaseline | null; carryover: Carryover | null; chatEpoch: number; chatPeriod: string | null;
  chatId: string | null; chatMode: ScheduledTaskChatMode; completionReason: string | null;
  consecutiveFailures: number; consecutiveIncompleteRuns: number; consecutiveMissingVerdicts: number; emailNotify: boolean;
  generation: number; id: string; kind: ScheduledTaskKind; memoryEnabled: boolean; modelId: string; nextRunAt: Date | null;
  pauseReason: string | null; pinnedSkillIds: readonly string[]; prompt: string; promptUrlDigests: readonly string[]; provider: string;
  /** What the store derives from the previous shown result (null: every server). */
  relevantMcpServerIds: readonly string[] | null;
  revision: number; schedule: ScheduledTaskSchedule; searchEnabled: boolean;
  status: ScheduledTaskStatusColumn; timeZone: string; title: string; toolsEnabled: boolean; userId: string; workspaceEnabled: boolean;
};
type Occurrence = {
  chatEpoch?: number | null;
  chatId: string | null; createdAt: number; finishedAt: Date | null; id: string; leaseExpiresAt: Date | null; notifiedAt: Date | null;
  reasonCode: string | null; runId: string | null; scheduledFor: Date; startedAt: Date | null; state: string; taskGeneration: number | null;
  taskId: string; taskRevision: number | null; trigger: ScheduledTaskRunTrigger; unavailableSources: unknown; unseenAt: Date | null;
  userId: string; userMessageId: string | null; verdict: MonitoringVerdict | null; workspaceWaitStartedAt?: Date | null;
};
/** `createdAt` is the run's admission, which its deadline counts from. */
type Run = {
  assistantMessageId: string; createdAt: Date; errorPayload: unknown; scheduledOutcome?: string; status: string; userId: string;
  /** Accepted with a Workspace binding: it holds a scheduled Workspace slot until terminal. */
  workspace?: boolean;
};

function harness(options: Readonly<{ dispatchOffsetMs?: (taskId: string) => number; workspaceMaxConcurrent?: number }> = {}) {
  let clock = new Date("2026-10-05T06:00:05.000Z");
  let ids = 0;
  const tasks = new Map<string, Task>();
  const occurrences: Occurrence[] = [];
  /** Accepted scheduled runs; each carries its scheduled origin, so it outlives its task. */
  const runs = new Map<string, Run>();
  const chats = new Map<string, {
    activeLeafMessageId: string | null; archived?: boolean; pinned?: boolean; title?: string; usable: boolean; userId: string;
  }>();
  /** Answer text by assistant message, what a rotation copies. */
  const answers = new Map<string, string>();
  /** Workspace seeds a rotation captured, by id: the chat it left and the chat it reached. */
  const seeds = new Map<string, { newChatId: string | null; sourceChatId: string; status: "READY" | "TRANSFERRED" }>();
  /** What capturing the old chat's Workspace yields next. */
  let carry: () => Promise<ScheduledWorkspaceCarryoverResult> = async () => ({ kind: "none" });
  const carried: string[] = [];
  const sweeps: Date[] = [];
  const inactiveUsers = new Set<string>();
  const emails: SmtpProductMessage[] = [];
  const pushes: string[] = [];
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
    answer?: string; runStatus: string; errorCode?: string; unavailableSources?: unknown; unlinked?: true; verdict?: MonitoringVerdict;
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
      // The rotated chat's own shown result retires the copy carried into it.
      plan.baseline ? { baseline: plan.baseline, carryover: null } : {},
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
      let workspaceExecuting = 0;
      const count = (userId: string) => executing.set(userId, (executing.get(userId) ?? 0) + 1);
      for (const run of runs.values()) {
        if (["complete", "cancelled", "error"].includes(run.status)) continue;
        count(run.userId);
        if (run.workspace) workspaceExecuting += 1;
      }
      for (const row of occurrences.filter((candidate) => tasks.has(candidate.taskId) && leased(candidate))) {
        count(row.userId);
        if (tasks.get(row.taskId)!.workspaceEnabled) workspaceExecuting += 1;
      }
      const pending = occurrences.filter((row) => row.state === "PENDING" && tasks.has(row.taskId) &&
        (!row.leaseExpiresAt || row.leaseExpiresAt <= now))
        .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime() || left.createdAt - right.createdAt)
        .map((row) => {
          const task = tasks.get(row.taskId)!;
          return { id: row.id, recurring: task.schedule.kind !== "once", scheduledFor: row.scheduledFor, taskId: row.taskId,
            trigger: row.trigger, userId: row.userId, waiting: row.reasonCode === "waiting_for_workspace",
            workspace: task.workspaceEnabled };
        });
      return { executing, pending, workspaceExecuting };
    },
    async acquireLease(id, now, until) {
      const row = find(id);
      if (!row || row.state !== "PENDING" || row.runId || (row.leaseExpiresAt && row.leaseExpiresAt > now)) return false;
      Object.assign(row, { leaseExpiresAt: until, startedAt: row.startedAt ?? now },
        row.reasonCode === "waiting_for_workspace" ? { reasonCode: null } : {});
      return true;
    },
    async waitForWorkspace(id, now) {
      const row = find(id);
      if (row?.state === "PENDING" && !row.runId) {
        Object.assign(row, { leaseExpiresAt: null, reasonCode: "waiting_for_workspace",
          workspaceWaitStartedAt: row.workspaceWaitStartedAt ?? now });
      }
    },
    async loadExecution(id) {
      const row = find(id);
      if (!row || row.state !== "PENDING" || row.runId) return null;
      const task = tasks.get(row.taskId)!;
      const chat = task.chatId ? chats.get(task.chatId) : undefined;
      const copy = task.carryover;
      return {
        // Reauthorized like the store does: this epoch's copy of this question.
        carriedResult: copy && copy.chatEpoch === task.chatEpoch && copy.taskGeneration === task.generation
          ? { answer: copy.answer, reliedServerIds: copy.reliedServerIds, sourceAssistantMessageId: copy.sourceAssistantMessageId,
            sourceChatId: copy.sourceChatId }
          : null,
        chat: chat?.usable && !chat.archived ? { activeLeafMessageId: chat.activeLeafMessageId, id: task.chatId! } : null,
        occurrence: { id: row.id, scheduledFor: row.scheduledFor, taskId: row.taskId, trigger: row.trigger, userId: row.userId },
        ownerActive: !inactiveUsers.has(row.userId),
        relevantMcpServerIds: task.relevantMcpServerIds,
        task: { baseline: task.baseline, chatEpoch: task.chatEpoch, chatMode: task.chatMode, chatPeriod: task.chatPeriod,
          generation: task.generation, kind: task.kind,
          memoryEnabled: task.memoryEnabled, modelId: task.modelId, pinnedSkillIds: task.pinnedSkillIds, prompt: task.prompt,
          promptUrlDigests: task.promptUrlDigests,
          provider: task.provider, revision: task.revision,
          searchEnabled: task.searchEnabled, status: task.status, timeZone: task.timeZone, title: task.title,
          toolsEnabled: task.toolsEnabled, workspaceEnabled: task.workspaceEnabled }
      };
    },
    async readOccurrence(id) {
      const row = find(id);
      return row ? { runId: row.runId, state: row.state } : null;
    },
    async loadRotationCopy({ baseline, chatId }) {
      const answer = answers.get(baseline.assistantMessageId);
      return answer ? { answer, reliedServerIds: ["server-relied"], sourceAssistantMessageId: baseline.assistantMessageId,
        sourceChatId: chatId } : null;
    },
    async archiveRotatedChat({ chatId }) {
      const chat = chats.get(chatId);
      // The owner keeps a pinned chat in view.
      if (!chat || chat.archived || chat.pinned) return false;
      chat.archived = true;
      return true;
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
        task: { ...task, baselineGeneration: task.baseline?.generation ?? null,
          carriedGeneration: task.carryover?.chatEpoch === task.chatEpoch ? task.carryover.taskGeneration : null } }) : null;
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
    const conflict = () => Response.json({ error: "scheduled_task_occurrence_unavailable" }, { status: 409 });
    // The real link refuses a task paused or edited, or moved to another chat, since the runner read it.
    if (task.revision !== origin.taskRevision || task.generation !== origin.taskGeneration ||
      task.chatEpoch !== (origin.taskChatEpoch ?? 0)) return conflict();
    const moved = task.chatId !== chatId;
    if (origin.rotation && (!moved || task.chatId !== origin.rotation.fromChatId)) return conflict();
    const copy = origin.previousResultCopy;
    if (copy && (origin.rotation ? task.baseline?.assistantMessageId !== copy.sourceAssistantMessageId
      : task.carryover?.chatEpoch !== task.chatEpoch || task.carryover.sourceAssistantMessageId !== copy.sourceAssistantMessageId)) {
      return conflict();
    }
    const seed = origin.rotation?.seedId ? seeds.get(origin.rotation.seedId) : undefined;
    if (origin.rotation?.seedId && (seed?.status !== "READY" || seed.sourceChatId !== origin.rotation.fromChatId)) return conflict();
    // The real handler links the occurrence in the run's creating transaction.
    const runId = nextId("run");
    const userMessageId = nextId("user-message");
    const assistantMessageId = nextId("assistant-message");
    answers.set(assistantMessageId, decision.answer ?? `Answer ${assistantMessageId}`);
    runs.set(runId, { assistantMessageId, createdAt: clock, errorPayload: decision.errorCode ? { code: decision.errorCode } : null,
      status: decision.runStatus, userId: occurrence.userId, workspace: body.workspace !== undefined &&
        (body.workspace as { enabled?: unknown }).enabled === true });
    const title = chats.get(chatId)?.title ?? origin.newChat?.title;
    chats.set(chatId, { ...chats.get(chatId), activeLeafMessageId: assistantMessageId, ...(title ? { title } : {}), usable: true,
      userId: occurrence.userId });
    const epoch = moved ? task.chatEpoch + 1 : task.chatEpoch;
    Object.assign(occurrence, { chatEpoch: epoch, chatId, leaseExpiresAt: null, reasonCode: null, runId, state: "RUNNING",
      taskGeneration: origin.taskGeneration, taskRevision: origin.taskRevision, unavailableSources: decision.unavailableSources ?? null,
      userMessageId,
      // Only a run admitted for a monitoring occurrence holds the reporting tool.
      verdict: origin.monitoring === true ? decision.verdict ?? null : null });
    if (moved) {
      Object.assign(task, { carryover: null, chatEpoch: epoch, chatId, chatPeriod: origin.chatPeriod ?? null },
        origin.rotation ? { baseline: null } : {});
    } else if (task.chatPeriod === null && origin.chatPeriod) {
      task.chatPeriod = origin.chatPeriod;
    }
    if (origin.rotation && copy) {
      task.carryover = { ...copy, chatEpoch: epoch, taskGeneration: origin.taskGeneration };
    }
    if (seed) Object.assign(seed, { newChatId: chatId, status: "TRANSFERRED" });
    return stream();
  };

  const kick = vi.fn();
  /** Skills the owner may load now; any other pinned id is gone, archived, disabled or unshared. */
  const availableSkills = new Set<string>();
  const runner = createScheduledTaskRunner({
    appBaseUrl: "https://aiqsa.example.test",
    // Without the spread unless a test asks for it: most tests start at the instant.
    dispatchOffsetMs: options.dispatchOffsetMs ?? (() => 0),
    // The rotation's capture of the old chat's project: a ready seed is the one the link transfers.
    carryWorkspace: async ({ sourceChatId }) => {
      carried.push(sourceChatId);
      const result = await carry();
      if (result.kind === "ready") seeds.set(result.seedId, { newChatId: null, sourceChatId, status: "READY" });
      return result;
    },
    kick,
    loadCatalog: async (userId) => catalogFor(userId),
    loadPinnedSkills: async (_userId, skillIds) => skillIds.map((id) => ({
      available: availableSkills.has(id), hasExecutables: false, id, name: availableSkills.has(id) ? id : null
    })),
    newId: () => nextId("id"),
    now: () => clock,
    retainHistory: async (now) => { sweeps.push(now); return 0; },
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
    store,
    ...(options.workspaceMaxConcurrent !== undefined ? { workspaceMaxConcurrent: options.workspaceMaxConcurrent } : {})
  });

  function addTask(overrides: Partial<Task> = {}): Task {
    const task: Task = {
      baseline: null, carryover: null, chatEpoch: 0, chatPeriod: null,
      chatId: null, chatMode: "same", completionReason: null, consecutiveFailures: 0, consecutiveIncompleteRuns: 0,
      consecutiveMissingVerdicts: 0, emailNotify: false, generation: 1, id: nextId("task"), kind: "standard", memoryEnabled: false,
      modelId: "model-a", pinnedSkillIds: [],
      nextRunAt: new Date("2026-10-05T06:00:00.000Z"), pauseReason: null, prompt: "  Summarize the synthetic fixture  ",
      promptUrlDigests: [], provider: "connection-a", relevantMcpServerIds: null, revision: 1, schedule: { kind: "daily", time: "09:00" },
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
    addOccurrence, addTask, answers, availableSkills, carried, chats, emails, inactiveUsers, kick, occurrences, pushes, runs, seeds,
    sent, settled, stops, store, sweeps, tasks, tick,
    advance(ms: number) { clock = new Date(clock.getTime() + ms); },
    now: () => clock,
    setCarry(next: typeof carry) { carry = next; },
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
    // The first run of a task has no earlier result to see; its chat is created with the month's title and the task as origin.
    expect(h.sent[0]!.occurrence).toEqual({ chatPeriod: "2026-10", newChat: { title: "Synthetic brief · October 2026" },
      occurrenceId: h.forTask(task)[0]!.id, previousResult: null, promptUrlDigests: [], relevantMcpServerIds: null,
      taskChatEpoch: 0, taskGeneration: 1, taskId: task.id, taskRevision: 1 });
    expect(h.chats.get(h.sent[0]!.chatId)?.title).toBe("Synthetic brief · October 2026");
    expect(task).toMatchObject({ chatEpoch: 1, chatId: h.sent[0]!.chatId, chatPeriod: "2026-10" });
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
    // Its model sees the previous shown result besides the prompt; the chat keeps its title and epoch.
    expect(h.sent[1]!.occurrence.previousResult).toEqual({ assistantMessageId: leaf, userMessageId: h.forTask(task)[0]!.userMessageId });
    expect(h.sent[1]!.occurrence).not.toHaveProperty("newChat");
    expect(h.sent[1]!.occurrence).toMatchObject({ chatPeriod: "2026-10", taskChatEpoch: 1 });
    expect(task.chatEpoch).toBe(1);
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
    // Each chat is created with its title, never renamed afterwards.
    expect(h.sent.map((send) => send.occurrence.newChat?.title)).toEqual(["Morning brief · 5 Oct 2026", "Morning brief · 6 Oct 2026",
      "Morning brief · 6 Oct 2026"]);
    expect(chatIds.map((chatId) => h.chats.get(chatId)?.title)).toEqual(["Morning brief · 5 Oct 2026", "Morning brief · 6 Oct 2026",
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
      loadPinnedSkills: async () => [],
      loadCatalog: async () => ({ models: [{ capabilities: { background: false, documentInputMode: "none", imageInput: false,
        nativeWebSearch: false, openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: true },
      modelId: "model-a", provider: "connection-a", searchStrategyIds: [] }], searchPlan: { mode: "all_selected", optionIds: [] },
      searchStrategies: [] }),
      dispatchOffsetMs: () => 0,
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
      appBaseUrl: "https://aiqsa.example.test", dispatchOffsetMs: () => 0, kick, loadPinnedSkills: async () => [],
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

  it("sends the task's pinned Skills as the composer pins them and never runs without one", async () => {
    const h = harness();
    h.availableSkills.add("skill-digest");
    h.availableSkills.add("skill-report");
    const pinned = h.addTask({ pinnedSkillIds: ["skill-digest", "skill-report"], toolsEnabled: true });
    const plain = h.addTask({ toolsEnabled: true, userId: "owner-2" });
    await h.tick();
    const [pinnedSend, plainSend] = [pinned, plain].map((task) => h.sent.find((send) => send.occurrence.taskId === task.id)!);
    expect(pinnedSend.body).toMatchObject({ skillIds: ["skill-digest", "skill-report"], skills: { mode: "auto" } });
    expect(plainSend.body).not.toHaveProperty("skillIds");

    // A pinned Skill the owner lost (deleted, archived, disabled or unshared) pauses before any send.
    const lost = harness();
    lost.availableSkills.add("skill-digest");
    const task = lost.addTask({ emailNotify: true, pinnedSkillIds: ["skill-digest", "skill-gone"], toolsEnabled: true });
    await lost.tick();
    expect(lost.sent).toHaveLength(0);
    expect(lost.forTask(task)).toMatchObject([{ reasonCode: "skill_unavailable", state: "FAILED" }]);
    expect(task).toMatchObject({ nextRunAt: null, pauseReason: "skill_unavailable", status: "PAUSED" });
    expect(lost.emails[0]!.text).toContain("A pinned Skill is no longer available.");

    // Lost between the check and admission: the handler's refusal pauses too; a version that changed meanwhile retries.
    const raced = harness();
    raced.availableSkills.add("skill-digest");
    const racing = raced.addTask({ pinnedSkillIds: ["skill-digest"], toolsEnabled: true });
    raced.setReply(() => ({ error: "skill_not_available", status: 404 }));
    await raced.tick();
    expect(racing).toMatchObject({ pauseReason: "skill_unavailable", status: "PAUSED" });
    const moved = harness();
    moved.availableSkills.add("skill-digest");
    const moving = moved.addTask({ pinnedSkillIds: ["skill-digest"], toolsEnabled: true });
    moved.setReply(() => ({ error: "skill_not_available", status: 409 }));
    await moved.tick();
    expect(moved.forTask(moving)).toMatchObject([{ reasonCode: null, runId: null, state: "PENDING" }]);
    expect(moving).toMatchObject({ status: "ACTIVE" });
  });

  it("passes the servers the previous result relied on to admission", async () => {

    const h = harness();
    const task = h.addTask({ relevantMcpServerIds: ["server-mail"], toolsEnabled: true });
    await h.tick();
    expect(h.sent[0]!.occurrence.relevantMcpServerIds).toEqual(["server-mail"]);
  });

  it("freezes the prompt's page-reading snapshot, read with the revision, into the admission", async () => {
    const h = harness();
    const digest = "a".repeat(64);
    h.addTask({ promptUrlDigests: [digest], revision: 3 });
    await h.tick();
    expect(h.sent[0]!.occurrence).toMatchObject({ promptUrlDigests: [digest], taskRevision: 3 });
  });

  it("pauses before any send when tools or Workspace need tool calling the model lost", async () => {
    // Room for both Workspace tasks at once: this test is about the pause, not the scheduled Workspace cap.
    const h = harness({ workspaceMaxConcurrent: 2 });
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

describe("scheduled task chat rotation", () => {
  const DAY = 24 * HOUR;
  /** From the first run on 5 Oct 09:00 Moscow to 1 Nov 09:00 Moscow, the first run of a new month. */
  const TO_NOVEMBER = 27 * DAY;

  it("starts the month's chat at the first run of a new month, carrying the previous shown result as a copy", async () => {
    const h = harness();
    const task = h.addTask({ toolsEnabled: true, relevantMcpServerIds: ["server-relied"] });
    h.setReply(() => ({ answer: "October digest", runStatus: "complete" }));
    await h.tick();
    const october = h.sent[0]!.chatId;
    const lastOctober = h.forTask(task)[0]!;
    expect(task).toMatchObject({ chatEpoch: 1, chatId: october, chatPeriod: "2026-10" });

    h.setReply(() => ({ answer: "November digest", runStatus: "complete" }));
    h.advance(TO_NOVEMBER);
    await h.tick();
    const rotation = h.sent[1]!;
    const november = rotation.chatId;
    expect(november).not.toBe(october);
    // A new Memory-excluded chat titled with the month, its context the copied answer, never the old chat's ids.
    expect(rotation.body).toMatchObject({ expectedActiveLeafId: null, personalDraft: { folderId: null, memoryMode: "EXCLUDED" } });
    expect(rotation.occurrence).toMatchObject({
      chatPeriod: "2026-11", newChat: { title: "Synthetic brief · November 2026" }, previousResult: null,
      previousResultCopy: { answer: "October digest", reliedServerIds: ["server-relied"],
        sourceAssistantMessageId: h.runs.get(lastOctober.runId!)!.assistantMessageId, sourceChatId: october },
      rotation: { fromChatId: october, seedId: null }, taskChatEpoch: 1
    });
    // The old chat is archived; the task moved under a new epoch.
    expect(h.chats.get(october)).toMatchObject({ archived: true });
    expect(task).toMatchObject({ chatEpoch: 2, chatId: november, chatPeriod: "2026-11" });
    // The new chat's own shown result retires the copy and becomes the baseline.
    expect(task.carryover).toBeNull();
    expect(task.baseline).toMatchObject({ runId: h.forTask(task).at(-1)!.runId });

    // The next run of the month continues the new chat with its own previous result.
    h.advance(DAY);
    await h.tick();
    expect(h.sent[2]!).toMatchObject({ chatId: november });
    expect(h.sent[2]!.occurrence).not.toHaveProperty("previousResultCopy");
    expect(h.sent[2]!.occurrence.previousResult).toMatchObject({ userMessageId: h.forTask(task).at(-2)!.userMessageId });
    expect(h.sent[2]!.occurrence).not.toHaveProperty("rotation");
  });

  it("keeps carrying the copy into the new chat until it has its own shown result", async () => {
    const h = harness();
    const task = h.addTask();
    h.setReply(() => ({ answer: "October digest", runStatus: "complete" }));
    await h.tick();
    // The month's first run fails: its chat exists, but has no result of its own yet.
    h.setReply(() => ({ errorCode: "provider_error", runStatus: "error" }));
    h.advance(TO_NOVEMBER);
    await h.tick();
    const november = h.sent[1]!.chatId;
    expect(task).toMatchObject({ baseline: null, chatId: november, carryover: { answer: "October digest", chatEpoch: 2 } });
    h.setReply(() => ({ runStatus: "complete" }));
    h.advance(DAY);
    await h.tick();
    expect(h.sent[2]!).toMatchObject({ chatId: november });
    expect(h.sent[2]!.occurrence).toMatchObject({ previousResult: null, previousResultCopy: { answer: "October digest" },
      taskChatEpoch: 2 });
    expect(h.sent[2]!.occurrence).not.toHaveProperty("rotation");
    expect(task.carryover).toBeNull();
  });

  it("rotates for Run now as well, and keeps a chat the owner pinned in view", async () => {
    const h = harness();
    const task = h.addTask();
    await h.tick();
    const october = h.sent[0]!.chatId;
    h.chats.get(october)!.pinned = true;
    // A manual run on 1 Nov at 12:00 Moscow: its instant is in the new month.
    h.advance(TO_NOVEMBER + 3 * HOUR);
    task.nextRunAt = new Date("2026-11-02T06:00:00.000Z");
    h.addOccurrence(task, { scheduledFor: new Date("2026-11-01T09:00:05.000Z") });
    await h.tick();
    expect(h.sent[1]!.occurrence).toMatchObject({ newChat: { title: "Synthetic brief · November 2026" },
      rotation: { fromChatId: october } });
    expect(h.chats.get(october)).toMatchObject({ pinned: true });
    expect(h.chats.get(october)?.archived).toBeUndefined();
    expect(task.chatId).toBe(h.sent[1]!.chatId);
  });

  it("adopts the month of a chat older than months instead of rotating it at once", async () => {
    const h = harness();
    const task = h.addTask();
    await h.tick();
    const chatId = h.sent[0]!.chatId;
    // A chat from before months were recorded.
    task.chatPeriod = null;
    h.advance(TO_NOVEMBER);
    await h.tick();
    expect(h.sent[1]!).toMatchObject({ chatId });
    expect(h.sent[1]!.occurrence).toMatchObject({ chatPeriod: "2026-11" });
    expect(task).toMatchObject({ chatId, chatPeriod: "2026-11" });
  });

  it("reports no spurious update for a monitoring check at the month boundary", async () => {
    const h = harness();
    const task = h.addTask({ kind: "monitoring" });
    h.setReply(() => ({ answer: "Version 1.0 is current", runStatus: "complete", verdict: "update" }));
    await h.tick();
    expect(h.forTask(task)[0]).toMatchObject({ reasonCode: "baseline" });
    const pushes = h.pushes.length;
    // Nothing changed: the check compared with the carried result, so it stays hidden.
    h.setReply(() => ({ runStatus: "complete", verdict: "no_update" }));
    h.advance(TO_NOVEMBER);
    await h.tick();
    const boundary = h.forTask(task).at(-1)!;
    expect(h.sent.at(-1)!.occurrence).toMatchObject({ monitoring: true, previousResultCopy: { answer: "Version 1.0 is current" } });
    expect(boundary).toMatchObject({ reasonCode: "no_update", state: "COMPLETED", unseenAt: null });
    expect(h.pushes).toHaveLength(pushes);
    // A hidden check is no comparison basis: the copy stays the previous result.
    expect(task.carryover).toMatchObject({ answer: "Version 1.0 is current" });
  });

  it("treats the month's first check as a first check when no copy could be carried", async () => {
    const h = harness();
    const task = h.addTask({ kind: "monitoring" });
    h.setReply(() => ({ runStatus: "complete", verdict: "update" }));
    await h.tick();
    // The previous answer has no text to copy.
    h.answers.clear();
    h.advance(TO_NOVEMBER);
    await h.tick();
    expect(h.sent.at(-1)!.occurrence).not.toHaveProperty("previousResultCopy");
    expect(h.forTask(task).at(-1)).toMatchObject({ reasonCode: "baseline", state: "COMPLETED" });
  });

  it("keeps a late settlement of the old chat from moving the task back or overwriting the new baseline", async () => {
    const h = harness();
    const task = h.addTask();
    await h.tick();
    const october = h.sent[0]!.chatId;
    // An October run still open in the old chat (forced: the runner itself never rotates while one is open).
    const late = h.addOccurrence(task, { chatEpoch: 1, chatId: october, runId: "run-late",
      scheduledFor: new Date("2026-10-31T06:00:00.000Z"), startedAt: new Date("2026-10-31T06:00:00.000Z"), state: "RUNNING",
      taskGeneration: 1, taskRevision: 1, userMessageId: "user-message-late" });
    h.runs.set("run-late", { assistantMessageId: "assistant-message-late", createdAt: new Date("2026-10-31T06:00:00.000Z"),
      errorPayload: null, status: "streaming", userId: task.userId });
    // The task already moved to November's chat, whose baseline is its own.
    const novemberBaseline = { assistantMessageId: "assistant-november", generation: 1, runId: "run-november",
      userMessageId: "user-november" };
    Object.assign(task, { baseline: novemberBaseline, chatEpoch: 2, chatId: "chat-november", chatPeriod: "2026-11" });
    h.runs.get("run-late")!.status = "complete";
    await h.store.settleLinked(late.id, new Date());
    expect(late).toMatchObject({ state: "COMPLETED" });
    expect(task).toMatchObject({ baseline: novemberBaseline, chatEpoch: 2, chatId: "chat-november" });
  });

  it("carries the old chat's Workspace project through a seed the run's admission transfers", async () => {
    const h = harness();
    const task = h.addTask({ workspaceEnabled: true, toolsEnabled: true });
    await h.tick();
    const october = h.sent[0]!.chatId;
    h.setCarry(async () => ({ kind: "ready", seedId: "seed-1" }));
    h.advance(TO_NOVEMBER);
    await h.tick();
    expect(h.carried).toEqual([october]);
    expect(h.sent[1]!.occurrence.rotation).toEqual({ fromChatId: october, seedId: "seed-1" });
    expect(h.seeds.get("seed-1")).toEqual({ newChatId: h.sent[1]!.chatId, sourceChatId: october, status: "TRANSFERRED" });
    expect(task.chatId).toBe(h.sent[1]!.chatId);
  });

  it("fails a rotation whose Workspace files cannot be carried, retrying transient trouble first, and never runs without them",
    async () => {
      const h = harness();
      const task = h.addTask({ workspaceEnabled: true, toolsEnabled: true });
      await h.tick();
      const october = h.sent[0]!.chatId;
      // A transient refusal waits within the window; nothing is sent.
      h.setCarry(async () => ({ kind: "retry" }));
      h.advance(TO_NOVEMBER);
      await h.tick();
      const waiting = h.forTask(task).at(-1)!;
      expect(waiting).toMatchObject({ reasonCode: "workspace_carryover_unavailable", runId: null, state: "PENDING" });
      expect(h.sent).toHaveLength(1);
      // Still failing at the window's end: a visible failure that counts toward the pause.
      h.advance(31 * MINUTE);
      await h.tick();
      expect(waiting).toMatchObject({ reasonCode: "workspace_carryover_unavailable", state: "FAILED" });
      expect(task).toMatchObject({ chatId: october, consecutiveFailures: 1 });
      // A project that cannot become a seed fails at once.
      h.setCarry(async () => ({ kind: "failed" }));
      h.advance(DAY);
      await h.tick();
      expect(h.forTask(task).at(-1)).toMatchObject({ reasonCode: "workspace_carryover_unavailable", state: "FAILED" });
      expect(task).toMatchObject({ chatId: october, consecutiveFailures: 2 });
      expect(h.sent).toHaveLength(1);
      // The owner busy in the old chat is a busy chat.
      h.setCarry(async () => ({ kind: "busy" }));
      h.advance(DAY);
      await h.tick();
      expect(h.forTask(task).at(-1)).toMatchObject({ reasonCode: "chat_busy", state: "PENDING" });
      // Without a disk to carry the rotation goes on, the new chat starting empty as a lost disk would.
      h.setCarry(async () => ({ kind: "none" }));
      h.advance(5 * MINUTE);
      await h.tick();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1]!.occurrence.rotation).toEqual({ fromChatId: october, seedId: null });
    });

  it("sweeps the history retention at most every quarter hour, outside the tick", async () => {
    const h = harness();
    await h.tick();
    expect(h.sweeps).toHaveLength(1);
    h.advance(5 * MINUTE);
    await h.tick();
    expect(h.sweeps).toHaveLength(1);
    h.advance(11 * MINUTE);
    await h.tick();
    expect(h.sweeps).toHaveLength(2);
  });
});

describe("scheduled Workspace capacity", () => {
  it("lets a second scheduled Workspace task wait for the one slot, shown as waiting, then run; neither fails", async () => {
    const h = harness();
    const first = h.addTask({ workspaceEnabled: true, toolsEnabled: true });
    const second = h.addTask({ userId: "owner-2", workspaceEnabled: true, toolsEnabled: true });
    // A task without Workspace is not held by the Workspace cap.
    const plain = h.addTask({ userId: "owner-3" });
    h.setReply((occurrence) => ({ runStatus: occurrence.taskId === first.id ? "streaming" : "complete" }));
    await h.tick();
    expect(h.forTask(first)).toMatchObject([{ state: "RUNNING" }]);
    expect(h.forTask(plain)).toMatchObject([{ state: "COMPLETED" }]);
    const waiting = h.forTask(second)[0]!;
    expect(waiting).toMatchObject({ leaseExpiresAt: null, reasonCode: "waiting_for_workspace", runId: null, startedAt: null,
      state: "PENDING" });
    expect(waiting.workspaceWaitStartedAt).toEqual(new Date("2026-10-05T06:00:05.000Z"));
    expect(h.sent.map((send) => send.occurrence.taskId)).toEqual([first.id, plain.id]);

    // Still busy: it keeps waiting, its first wait unchanged.
    h.advance(MINUTE);
    await h.tick();
    expect(h.forTask(second)).toMatchObject([{ reasonCode: "waiting_for_workspace", state: "PENDING" }]);
    expect(h.forTask(second)[0]!.workspaceWaitStartedAt).toEqual(new Date("2026-10-05T06:00:05.000Z"));

    // The first run ends: the slot frees and the waiting occurrence runs.
    h.runs.get(h.forTask(first)[0]!.runId!)!.status = "complete";
    h.advance(MINUTE);
    await h.tick();
    expect(h.forTask(first)).toMatchObject([{ reasonCode: null, state: "COMPLETED" }]);
    expect(h.forTask(second)).toMatchObject([{ reasonCode: null, state: "COMPLETED" }]);
    expect(first).toMatchObject({ consecutiveFailures: 0, status: "ACTIVE" });
    expect(second).toMatchObject({ consecutiveFailures: 0, status: "ACTIVE" });
  });

  it("takes as many scheduled Workspace runs at once as the configured cap", async () => {
    const h = harness({ workspaceMaxConcurrent: 2 });
    const tasks = ["owner-1", "owner-2", "owner-3"].map((userId) => h.addTask({ userId, workspaceEnabled: true, toolsEnabled: true }));
    h.setReply(() => ({ runStatus: "streaming" }));
    await h.tick();
    expect(tasks.map((task) => h.forTask(task)[0]!.state)).toEqual(["RUNNING", "RUNNING", "PENDING"]);
    expect(h.forTask(tasks[2]!)[0]!.reasonCode).toBe("waiting_for_workspace");
  });

  it("skips an occurrence still waiting when its window ends, without counting it toward the failure pause", async () => {
    const h = harness();
    // Other scheduled Workspace runs keep the only slot busy the whole time, each within its deadline.
    let holders = 0;
    const hold = () => {
      for (const run of h.runs.values()) if (run.workspace && run.status === "streaming") run.status = "complete";
      holders += 1;
      h.runs.set(`holder-${holders}`, { assistantMessageId: `holder-answer-${holders}`, createdAt: h.now(), errorPayload: null,
        status: "streaming", userId: "owner-busy", workspace: true });
    };
    const task = h.addTask({ consecutiveFailures: SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD - 1, emailNotify: true,
      toolsEnabled: true, workspaceEnabled: true });
    hold();
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "waiting_for_workspace", state: "PENDING" }]);
    // Never attempted, it waits through the lateness window rather than the retry window.
    h.advance(SCHEDULED_TASK_RETRY_WINDOW_MS + MINUTE);
    hold();
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "waiting_for_workspace", state: "PENDING" }]);
    for (let waited = SCHEDULED_TASK_RETRY_WINDOW_MS + MINUTE; waited <= SCHEDULED_TASK_LATENESS_MS; waited += 20 * MINUTE) {
      h.advance(20 * MINUTE);
      hold();
      await h.tick();
    }
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "workspace_capacity", runId: null, state: "SKIPPED", unseenAt: null }]);
    expect(task).toMatchObject({ consecutiveFailures: SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD - 1, pauseReason: null, status: "ACTIVE" });
    expect(h.sent).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
  });

  it("skips a waiting hourly occurrence as a capacity skip when the next instant supersedes it", async () => {
    const h = harness();
    const task = h.addTask({ schedule: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], everyHours: 1, kind: "hourly",
      time: "09:00", until: null }, toolsEnabled: true, workspaceEnabled: true });
    h.runs.set("holder", { assistantMessageId: "holder-answer", createdAt: h.now(), errorPayload: null, status: "streaming",
      userId: "owner-busy", workspace: true });
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ reasonCode: "waiting_for_workspace", state: "PENDING" }]);
    h.advance(HOUR);
    // A fresh holder, inside its deadline.
    h.runs.get("holder")!.createdAt = h.now();
    await h.tick();
    expect(h.forTask(task)[0]).toMatchObject({ reasonCode: "workspace_capacity", state: "SKIPPED" });
    expect(h.forTask(task)[1]).toMatchObject({ reasonCode: "waiting_for_workspace", state: "PENDING" });
    expect(task).toMatchObject({ consecutiveFailures: 0, status: "ACTIVE" });
  });
});

describe("scheduled dispatch spread", () => {
  it("starts a recurring occurrence after its task's offset, keeping the scheduled instant", async () => {
    const h = harness({ dispatchOffsetMs: () => 2 * MINUTE });
    const task = h.addTask();
    await h.tick();
    expect(h.forTask(task)).toMatchObject([{ leaseExpiresAt: null, reasonCode: null, startedAt: null, state: "PENDING" }]);
    expect(h.sent).toHaveLength(0);
    h.advance(MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(0);
    h.advance(MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.forTask(task)).toMatchObject([{ scheduledFor: new Date("2026-10-05T06:00:00.000Z"), state: "COMPLETED" }]);
    expect(task.nextRunAt).toEqual(new Date("2026-10-06T06:00:00.000Z"));
  });

  it("starts Run now and a once task's chosen moment without the offset", async () => {
    const h = harness({ dispatchOffsetMs: () => 2 * MINUTE });
    const manual = h.addTask({ nextRunAt: null, status: "PAUSED" });
    h.addOccurrence(manual);
    const once = h.addTask({ schedule: { date: "2026-10-05", kind: "once", time: "09:00" }, userId: "owner-2" });
    await h.tick();
    expect(h.forTask(manual)).toMatchObject([{ state: "COMPLETED", trigger: "manual" }]);
    expect(h.forTask(once)).toMatchObject([{ state: "COMPLETED", trigger: "schedule" }]);
  });

  it("decides the chat's month by the scheduled instant, not the later dispatch", async () => {
    const h = harness({ dispatchOffsetMs: () => 2 * MINUTE });
    const october = "chat-october";
    h.chats.set(october, { activeLeafMessageId: null, usable: true, userId: "owner-1" });
    // 23:59 Moscow on 31 October; dispatched at 00:01 on 1 November.
    const task = h.addTask({ chatEpoch: 1, chatId: october, chatPeriod: "2026-10", nextRunAt: new Date("2026-10-31T20:59:00.000Z"),
      schedule: { kind: "daily", time: "23:59" } });
    h.advance(Date.parse("2026-10-31T20:59:05.000Z") - h.now().getTime());
    await h.tick();
    expect(h.sent).toHaveLength(0);
    h.advance(2 * MINUTE);
    await h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.chatId).toBe(october);
    expect(h.sent[0]!.occurrence).toMatchObject({ chatPeriod: "2026-10", taskChatEpoch: 1 });
    expect(h.sent[0]!.occurrence).not.toHaveProperty("rotation");
    expect(task).toMatchObject({ chatId: october, chatPeriod: "2026-10" });
  });
});
