import { describe, expect, it } from "vitest";
import { CHAT_TITLE_MAX_LENGTH } from "./chats";
import {
  SCHEDULED_TASK_CARDS_LIMIT,
  SCHEDULED_TASK_CHECK_OUTCOMES,
  SCHEDULED_TASK_ERROR_CODES,
  SCHEDULED_TASK_MANAGED_PER_ANSWER,
  decodeScheduledTaskCard,
  foldScheduledTaskCards,
  scheduledTaskCard,
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_SEEN_RUNS_LIMIT,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  decodeScheduledTask,
  decodeScheduledTaskDetailResponse,
  decodeScheduledTaskListResponse,
  decodeScheduledTaskPinnedSkillIds,
  decodeScheduledTaskSeenRequest,
  SCHEDULED_TASK_MAX_PINNED_SKILLS,
  scheduledTaskSkillNameProjection,
  scheduledTaskSkillUnavailableReason,

  isScheduledTaskPrompt,
  isScheduledTaskRunIncomplete,
  normalizeScheduledTaskTitle,
  scheduledTaskChatModeAllowed,
  scheduledTaskErrorMessage,
  scheduledTaskReasonMessage,
  scheduledTaskSourceMessage,
  scheduledTaskToolDefaults,
  type ScheduledTask,
  type ScheduledTaskSchedule
} from "./scheduledTasks";

const task: ScheduledTask = {
  id: "task-1", title: "Morning brief", prompt: "Summarize overnight news.",
  schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow",
  modelId: "model-1", provider: "connection-1", searchEnabled: true, emailNotify: false, toolsEnabled: true, workspaceEnabled: false,
  memoryEnabled: true, pinnedSkillIds: [], chatMode: "new", kind: "standard", status: "active", pauseReason: null, completionReason: null,
  nextRunAt: "2026-10-05T06:00:00.000Z",
  lastRun: { scheduledFor: "2026-10-02T06:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-02T06:01:10.000Z",
    unseen: true },
  running: false, chatId: "chat-1", unseenResult: true, revision: 3,
  createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-10-02T06:01:10.000Z"
};
const hourly = { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] } satisfies ScheduledTaskSchedule;

describe("scheduled task wire contract", () => {
  it("bounds titles like the chat title they become, in code points", () => {
    expect(SCHEDULED_TASK_TITLE_MAX_LENGTH).toBe(CHAT_TITLE_MAX_LENGTH);
    expect(normalizeScheduledTaskTitle("  Brief  ")).toBe("Brief");
    expect(normalizeScheduledTaskTitle("😀".repeat(120))).toBe("😀".repeat(120));
    for (const title of ["   ", "😀".repeat(121), "a\0b", 7]) expect(normalizeScheduledTaskTitle(title)).toBeNull();
    expect(isScheduledTaskPrompt("😀".repeat(SCHEDULED_TASK_PROMPT_MAX_LENGTH))).toBe(true);
    for (const prompt of [" \n ", "😀".repeat(SCHEDULED_TASK_PROMPT_MAX_LENGTH + 1), "a\0", null]) {
      expect(isScheduledTaskPrompt(prompt)).toBe(false);
    }
  });

  it("decodes exact task projections and rejects inconsistent ones", () => {
    expect(decodeScheduledTask(task)).toEqual(task);
    expect(decodeScheduledTask({ ...task, status: "paused", nextRunAt: null, pauseReason: "model_unavailable" }))
      .toMatchObject({ status: "paused", pauseReason: "model_unavailable" });
    expect(decodeScheduledTask({ ...task, schedule: hourly, chatMode: "same" })).toMatchObject({ schedule: hourly, chatMode: "same" });
    expect(decodeScheduledTask({ ...task, memoryEnabled: false })).toMatchObject({ memoryEnabled: false });
    const reached = { ...task, chatMode: "same", completionReason: "goal_reached", kind: "monitoring", nextRunAt: null, status: "completed" };
    expect(decodeScheduledTask(reached)).toEqual(reached);
    // Instructions whose links runs cannot read yet carry only a flag.
    expect(decodeScheduledTask({ ...task, promptLinksPending: true })).toEqual({ ...task, promptLinksPending: true });
    for (const candidate of [
      { ...task, promptLinksPending: false }, { ...task, promptLinksPending: ["a".repeat(64)] },
      { ...task, extra: true }, { ...task, status: "paused" }, { ...task, title: " Morning brief" },
      { ...task, lastRun: { ...task.lastRun, state: "running" } }, { ...task, lastRun: { ...task.lastRun, unseen: undefined } },
      { ...task, pauseReason: "Not a code" },
      { ...task, revision: 0 }, { ...task, schedule: { kind: "daily", time: "25:00" } }, { ...task, timeZone: "+03:00" },
      { ...task, chatMode: "other" }, { ...task, chatMode: undefined }, { ...task, schedule: hourly, chatMode: "new" },
      { ...task, toolsEnabled: "auto" }, { ...task, workspaceEnabled: undefined },
      { ...task, memoryEnabled: undefined }, { ...task, memoryEnabled: "on" },
      { ...task, kind: "watch" }, { ...task, kind: undefined }, { ...task, kind: "monitoring" },
      { ...task, completionReason: "goal_reached" }, { ...reached, completionReason: "Goal reached" }
    ]) {
      expect(decodeScheduledTask(candidate)).toBeNull();
    }
  });

  it("decodes up to four pinned Skills, only with tools, and the owner's view of them", () => {
    const pinnedSkills = [
      { id: "skill-1", name: "gitlab-digest", available: true, hasExecutables: true },
      { id: "skill-2", name: null, available: false, hasExecutables: false }
    ];
    const pinned = { ...task, pinnedSkillIds: ["skill-1", "skill-2"], pinnedSkills };
    expect(decodeScheduledTask(pinned)).toEqual(pinned);
    // A chat card or a model result carries the ids without the owner's view.
    expect(decodeScheduledTask({ ...task, pinnedSkillIds: ["skill-1"] })).toEqual({ ...task, pinnedSkillIds: ["skill-1"] });
    expect(decodeScheduledTaskPinnedSkillIds(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
    expect(SCHEDULED_TASK_MAX_PINNED_SKILLS).toBe(4);
    for (const ids of [["a", "b", "c", "d", "e"], ["a", "a"], [""], [" a"], ["x".repeat(65)], [1], "a", null]) {
      expect(decodeScheduledTaskPinnedSkillIds(ids)).toBeNull();
    }
    for (const candidate of [
      { ...task, pinnedSkillIds: undefined }, { ...task, pinnedSkillIds: ["a", "b", "c", "d", "e"] },
      { ...task, toolsEnabled: false, pinnedSkillIds: ["skill-1"] },
      { ...pinned, pinnedSkills: [pinnedSkills[1], pinnedSkills[0]] }, { ...pinned, pinnedSkills: [pinnedSkills[0]] },
      { ...pinned, pinnedSkills: [{ ...pinnedSkills[0], name: null }, pinnedSkills[1]] },
      { ...pinned, pinnedSkills: [{ ...pinnedSkills[0], ownerId: "user-2" }, pinnedSkills[1]] },
      { ...pinned, pinnedSkills: [{ ...pinnedSkills[0], name: "x".repeat(65) }, pinnedSkills[1]] }
    ]) {
      expect(decodeScheduledTask(candidate)).toBeNull();
    }
    expect(scheduledTaskSkillNameProjection("  digest\u0007 ")).toBe("digest");
    expect(scheduledTaskSkillNameProjection("x".repeat(70))).toBe("x".repeat(64));
    expect(scheduledTaskSkillNameProjection(" \n ")).toBeNull();
  });

  it("names a lost pinned Skill only while the owner may still see it", () => {
    const skill = (name: string | null, available = false) => ({ id: name ?? "gone", name, available, hasExecutables: false });
    expect(scheduledTaskSkillUnavailableReason({ pinnedSkills: [skill("digest"), skill("report", true)] }))
      .toBe("the pinned Skill “digest” is no longer available");
    expect(scheduledTaskSkillUnavailableReason({ pinnedSkills: [skill("a"), skill("b"), skill("c")] }))
      .toBe("the pinned Skills “a”, “b” and “c” are no longer available");
    expect(scheduledTaskSkillUnavailableReason({ pinnedSkills: [skill(null)] })).toBe("a pinned Skill is no longer available");
    expect(scheduledTaskSkillUnavailableReason({})).toBe("a pinned Skill is no longer available");
    expect(scheduledTaskReasonMessage("skill_unavailable")).toBe("A pinned Skill is no longer available. Edit the task's Skills, then resume.");
  });

  it("keeps hourly and monitoring tasks in one chat and lets other tasks start a chat per run", () => {
    expect(scheduledTaskChatModeAllowed({ kind: "standard", schedule: hourly }, "same")).toBe(true);
    expect(scheduledTaskChatModeAllowed({ kind: "standard", schedule: hourly }, "new")).toBe(false);
    for (const schedule of [{ kind: "daily", time: "09:00" }, { kind: "once", date: "2026-10-12", time: "09:00" }] as const) {
      expect(scheduledTaskChatModeAllowed({ kind: "standard", schedule }, "new")).toBe(true);
      expect(scheduledTaskChatModeAllowed({ kind: "standard", schedule }, "same")).toBe(true);
      // A check compares with the previous shown result in the task's chat.
      expect(scheduledTaskChatModeAllowed({ kind: "monitoring", schedule }, "new")).toBe(false);
      expect(scheduledTaskChatModeAllowed({ kind: "monitoring", schedule }, "same")).toBe(true);
    }
  });

  it("decodes list and detail responses", () => {
    const list = { tasks: [task], limits: { maxActive: 10, maxTotal: 50, maxActiveHourly: 3 }, emailAvailable: false };
    expect(decodeScheduledTaskListResponse(list)).toEqual(list);
    expect(decodeScheduledTaskListResponse({ ...list, tasks: [task, task] })).toBeNull();
    expect(decodeScheduledTaskListResponse({ ...list, limits: { maxActive: 10, maxTotal: 50 } })).toBeNull();
    const run = { id: "run-1", scheduledFor: "2026-10-02T06:00:00.000Z", trigger: "schedule", state: "skipped",
      reasonCode: "previous_running", startedAt: null, finishedAt: "2026-10-02T19:00:00.000Z", chatId: null, unseen: false,
      unavailableSources: [], skills: [] };
    const result = { ...run, id: "run-2", state: "completed", reasonCode: null, chatId: "chat-1", unseen: true,
      skills: [{ name: "gitlab-digest", version: 3 }],
      unavailableSources: [{ name: "Почта", reason: "mcp_reauthorization_required" }, { name: "Tracker", reason: "mcp_server_unavailable" }] };
    expect(decodeScheduledTaskDetailResponse({ task, recentRuns: [result, run] })).toEqual({ task, recentRuns: [result, run] });
    for (const malformed of [{ ...run, trigger: "retry" }, { ...run, id: "" }, { ...run, unseen: "no" },
      { ...run, state: "running", finishedAt: null, unseen: true }, { id: run.id, scheduledFor: run.scheduledFor },
      { ...run, unavailableSources: undefined }, { ...run, unavailableSources: [{ name: "Tracker", reason: "expired" }] },
      // Server identifiers never cross the wire.
      { ...run, unavailableSources: [{ name: "Tracker", reason: "mcp_server_unavailable", serverId: "server-1" }] },
      { ...run, unavailableSources: [{ name: " Tracker", reason: "mcp_server_unavailable" }] },
      { ...run, unavailableSources: [{ name: "x".repeat(121), reason: "mcp_server_unavailable" }] },
      { ...run, unavailableSources: Array.from({ length: 65 }, () => ({ name: "Tracker", reason: "mcp_server_unavailable" })) },
      { ...run, skills: undefined }, { ...run, skills: [{ name: "digest", version: 0 }] },
      { ...run, skills: [{ name: "digest", version: 1, revisionId: "rev-1" }] },
      { ...run, skills: Array.from({ length: 5 }, () => ({ name: "digest", version: 1 })) }]) {
      expect(decodeScheduledTaskDetailResponse({ task, recentRuns: [malformed] })).toBeNull();
    }
  });

  it("starts a new task's switches from the composer defaults and marks runs that missed a source", () => {
    expect(scheduledTaskToolDefaults({ mcpMode: "auto", workspaceEnabled: true })).toEqual({ toolsEnabled: true, workspaceEnabled: true });
    expect(scheduledTaskToolDefaults({ mcpMode: "load_all" })).toEqual({ toolsEnabled: true, workspaceEnabled: false });
    expect(scheduledTaskToolDefaults({ mcpMode: "off", workspaceEnabled: false })).toEqual({ toolsEnabled: false, workspaceEnabled: false });
    expect(isScheduledTaskRunIncomplete({ unavailableSources: [] })).toBe(false);
    const missing = { name: "Почта", reason: "mcp_reauthorization_required" } as const;
    expect(isScheduledTaskRunIncomplete({ unavailableSources: [missing] })).toBe(true);
    expect(scheduledTaskSourceMessage(missing)).toBe("Почта needs sign-in.");
    expect(scheduledTaskSourceMessage({ name: "Tracker", reason: "mcp_server_unavailable" })).toBe("Tracker is unavailable.");
  });

  it("names the rendered results a mark-seen request clears", () => {
    expect(decodeScheduledTaskSeenRequest({ runIds: ["run-1", "run-2"] })).toEqual({ runIds: ["run-1", "run-2"] });
    const tooMany = Array.from({ length: SCHEDULED_TASK_SEEN_RUNS_LIMIT + 1 }, (_value, index) => `run-${index}`);
    for (const body of [{}, { runIds: [] }, { runIds: ["run-1", "run-1"] }, { runIds: [""] }, { runIds: "run-1" },
      { runIds: ["run-1"], all: true }, { runIds: tooMany }, null, []]) {
      expect(decodeScheduledTaskSeenRequest(body)).toBeNull();
    }
  });

  it("has copy for every API error and reason fallbacks", () => {
    const messages = SCHEDULED_TASK_ERROR_CODES.map(scheduledTaskErrorMessage);
    expect(new Set(messages).size).toBe(SCHEDULED_TASK_ERROR_CODES.length);
    expect(scheduledTaskErrorMessage("anything_else")).toBe(scheduledTaskErrorMessage("scheduled_tasks_unavailable"));
    expect(scheduledTaskErrorMessage("scheduled_task_hourly_limit")).toContain("3 active hourly tasks");
    expect(scheduledTaskReasonMessage(null)).toBeNull();
    expect(scheduledTaskReasonMessage("repeated_failures")).toContain("three");
    expect(scheduledTaskReasonMessage("previous_running")).toBe("Skipped: the previous run was still in progress.");
    expect(scheduledTaskReasonMessage("superseded")).toContain("newer scheduled time");
    expect(scheduledTaskReasonMessage("some_future_code")).toBe("The run did not complete.");
    // Every tool, Workspace, source and deadline outcome tells the owner what happened, distinctly.
    const tools = ["tools_unavailable", "workspace_unavailable", "workspace_secret_limit", "source_unavailable", "run_deadline"]
      .map(scheduledTaskReasonMessage);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).not.toContain("The run did not complete.");
    expect(scheduledTaskReasonMessage("run_deadline")).toBe("Stopped after running for 30 minutes.");
    expect(scheduledTaskReasonMessage("source_unavailable")).toContain("3 runs in a row");
    // Every check outcome and monitoring pause has its own history copy.
    const monitoring = [...SCHEDULED_TASK_CHECK_OUTCOMES, "model_cannot_report", "verdict_missing"].map(scheduledTaskReasonMessage);
    expect(new Set(monitoring).size).toBe(monitoring.length);
    expect(monitoring).not.toContain(scheduledTaskReasonMessage("some_future_code"));
    expect(new Set([...tools, ...monitoring]).size).toBe(tools.length + monitoring.length);
    expect(scheduledTaskReasonMessage("no_update")).toMatch(/^No update/u);
    expect(scheduledTaskReasonMessage("update")).toMatch(/^Update/u);
    expect(scheduledTaskReasonMessage("goal_reached")).toBe("Goal reached — task completed.");
  });

  it("projects a chat answer's card from the task alone and folds replays to one card per task", () => {
    const card = scheduledTaskCard(task, false);
    expect(card).toEqual({ taskId: "task-1", title: "Morning brief", kind: "standard", schedule: task.schedule,
      timeZone: "Europe/Moscow", timeZoneFallback: false, toolsEnabled: true, workspaceEnabled: false, status: "active",
      nextRunAt: "2026-10-05T06:00:00.000Z" });
    // Never the task's prompt, model or history.
    expect(JSON.stringify(card)).not.toMatch(/Summarize|model-1|connection-1|chat-1/u);
    expect(decodeScheduledTaskCard(card)).toEqual(card);
    expect(decodeScheduledTaskCard({ ...card, deleted: true })).toEqual({ ...card, deleted: true });
    for (const candidate of [
      { ...card, prompt: task.prompt }, { ...card, deleted: false }, { ...card, status: "paused" },
      { ...card, title: " Morning brief" }, { ...card, timeZone: "+03:00" }, { ...card, kind: "other" },
      { ...card, toolsEnabled: "yes" }, { ...card, schedule: { kind: "daily", time: "9:00" } }, { ...card, taskId: "" }
    ]) {
      expect(decodeScheduledTaskCard(candidate)).toBeNull();
    }
    const renamed = { ...card, title: "Renamed" };
    const others = Array.from({ length: SCHEDULED_TASK_CARDS_LIMIT + 1 }, (_value, index) => ({ ...card, taskId: `task-${index + 2}` }));
    const folded = foldScheduledTaskCards([card, { malformed: true }, renamed, ...others]);
    expect(folded[0]).toEqual(renamed);
    expect(folded).toHaveLength(SCHEDULED_TASK_CARDS_LIMIT);
  });

  it("carries what an answer last did to a task, with room for five managed tasks and one created", () => {
    expect(SCHEDULED_TASK_MANAGED_PER_ANSWER).toBe(5);
    expect(SCHEDULED_TASK_CARDS_LIMIT).toBe(6);
    const paused = scheduledTaskCard({ ...task, status: "paused", nextRunAt: null }, false, "paused");
    expect(paused).toMatchObject({ action: "paused", status: "paused" });
    for (const action of ["changed", "paused", "resumed", "delete_proposed"] as const) {
      expect(decodeScheduledTaskCard({ ...scheduledTaskCard(task, false), action })).toMatchObject({ action });
    }
    // A created task's card has no action; an unknown one is malformed.
    expect(scheduledTaskCard(task, false)).not.toHaveProperty("action");
    expect(decodeScheduledTaskCard({ ...scheduledTaskCard(task, false), action: "deleted" })).toBeNull();
    expect(decodeScheduledTaskCard({ ...scheduledTaskCard(task, false), action: null })).toBeNull();
    expect(decodeScheduledTaskCard({ ...scheduledTaskCard(task, false, "delete_proposed"), deleted: true }))
      .toMatchObject({ action: "delete_proposed", deleted: true });

    // One created and five managed tasks keep their cards; the latest action on a task wins in its first place.
    const created = scheduledTaskCard({ ...task, id: "created" }, false);
    const managed = Array.from({ length: 5 }, (_value, index) =>
      scheduledTaskCard({ ...task, id: `managed-${index}`, status: "paused", nextRunAt: null }, false, "paused"));
    const resumed = scheduledTaskCard({ ...task, id: "managed-0" }, false, "resumed");
    const folded = foldScheduledTaskCards([created, ...managed, resumed]);
    expect(folded.map((entry) => [entry.taskId, entry.action ?? "created"])).toEqual([
      ["created", "created"], ["managed-0", "resumed"], ["managed-1", "paused"], ["managed-2", "paused"], ["managed-3", "paused"],
      ["managed-4", "paused"]
    ]);
  });
});
