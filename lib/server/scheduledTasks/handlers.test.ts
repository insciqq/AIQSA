import { describe, expect, it, vi } from "vitest";
import type { ScheduledTask, ScheduledTaskDraft, ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import type { ScheduledTaskCatalog } from "./catalog";
import { createScheduledTaskHandlers } from "./handlers";
import { ScheduledTaskError, type ScheduledTaskUpdateWrite } from "./store";

const NOW = new Date("2026-10-04T08:00:00.000Z"); // 11:00 in Moscow
const catalog: ScheduledTaskCatalog = {
  models: [
    { capabilities: { toolCalling: true }, modelId: "model-search", provider: "connection-a", searchStrategyIds: ["off", "web"] },
    { capabilities: { toolCalling: false }, modelId: "model-plain", provider: "connection-a", searchStrategyIds: ["off"] }
  ],
  searchStrategies: [{ kind: "none", strategyId: "off" }, { kind: "web_search", strategyId: "web" }]
};
const draft = {
  title: "Morning brief", prompt: "fixture-private-prompt", schedule: { kind: "daily", time: "09:00" }, timeZone: "Europe/Moscow",
  modelId: "model-search", provider: "connection-a", searchEnabled: true, emailNotify: false, toolsEnabled: true,
  workspaceEnabled: false, chatMode: "new", kind: "standard"
} as const;
const hourly = { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] } satisfies ScheduledTaskSchedule;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    ...draft, id: "task-1", schedule: { kind: "daily", time: "09:00" }, status: "active", pauseReason: null,
    completionReason: null, nextRunAt: "2026-10-05T06:00:00.000Z", lastRun: null, running: false, chatId: null,
    unseenResult: false, revision: 2,
    createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z", ...overrides
  };
}

function fixture(current: ScheduledTask | null = task()) {
  const store = {
    list: vi.fn().mockResolvedValue({ tasks: [current], limits: { maxActive: 10, maxTotal: 50 }, emailAvailable: false }),
    get: vi.fn().mockResolvedValue(current),
    detail: vi.fn().mockResolvedValue(current ? { task: current, recentRuns: [] } : null),
    create: vi.fn(async (_userId: string, value: ScheduledTaskDraft, nextRunAt: Date) =>
      task({ ...value, nextRunAt: nextRunAt.toISOString(), revision: 1 })),
    update: vi.fn(async (_userId: string, _taskId: string, write: ScheduledTaskUpdateWrite) =>
      task({ ...write.draft, status: write.status, revision: write.expectedRevision + 1 })),
    delete: vi.fn().mockResolvedValue(true),
    markSeen: vi.fn().mockResolvedValue(true),
    requestRun: vi.fn(async () => task({ ...current, running: true }))
  };
  const loadCatalog = vi.fn().mockResolvedValue(catalog);
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "owner", user: { id: "owner", status: "active" } });
  const kick = vi.fn();
  const workspacePolicy = { read: vi.fn().mockResolvedValue({ enabled: true }) };
  const handlers = createScheduledTaskHandlers({ kick, loadCatalog, now: () => NOW, resolveAuth, store, workspacePolicy });
  return { handlers, kick, loadCatalog, resolveAuth, store, workspacePolicy };
}

const json = (method: string, body: unknown, path = "") =>
  new Request(`http://localhost/api/me/scheduled-tasks${path}`, { body: JSON.stringify(body), method });
const patch = (body: unknown, id = "task-1") => json("PATCH", body, `/${id}`);
const lastWrite = (f: ReturnType<typeof fixture>) => f.store.update.mock.calls.at(-1)?.[2];

describe("scheduled tasks owner API", () => {
  it("authenticates before reading a body and keeps inactive accounts out", async () => {
    const f = fixture();
    f.resolveAuth.mockResolvedValueOnce(null);
    const request = json("POST", draft);
    expect((await f.handlers.create(request)).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    f.resolveAuth.mockResolvedValueOnce({ userId: "owner", user: { id: "owner", status: "disabled" } });
    expect((await f.handlers.list(new Request("http://localhost/api/me/scheduled-tasks"))).status).toBe(403);
    expect(f.store.list).not.toHaveBeenCalled();
    expect(f.store.create).not.toHaveBeenCalled();
  });

  it("creates an active task for the authenticated owner with its first run and private responses", async () => {
    const f = fixture();
    const response = await f.handlers.create(json("POST", { ...draft, title: "  Morning brief  " }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.store.create).toHaveBeenCalledWith("owner", draft, new Date("2026-10-05T06:00:00.000Z"));
    expect(f.loadCatalog).toHaveBeenCalledWith("owner");
    expect((await response.json()).task).toMatchObject({ title: "Morning brief", nextRunAt: "2026-10-05T06:00:00.000Z" });
  });

  it("rejects invalid input with stable codes before writing", async () => {
    const f = fixture();
    const cases: Array<[unknown, string]> = [
      [{ ...draft, userId: "other" }, "scheduled_task_invalid"],
      [{ ...draft, title: " " }, "scheduled_task_invalid"],
      [{ ...draft, searchEnabled: "yes" }, "scheduled_task_invalid"],
      [{ ...draft, schedule: { kind: "weekly", time: "09:00", days: [] } }, "scheduled_task_schedule_invalid"],
      [{ ...draft, timeZone: "Mars/Olympus" }, "scheduled_task_time_zone_invalid"],
      [{ ...draft, schedule: { kind: "once", date: "2026-10-04", time: "11:01" } }, "scheduled_task_once_in_past"],
      [{ ...draft, modelId: "model-gone" }, "scheduled_task_model_unavailable"],
      [{ ...draft, modelId: "model-plain" }, "scheduled_task_search_unavailable"],
      [{ ...draft, chatMode: "fresh" }, "scheduled_task_invalid"],
      [{ ...draft, chatMode: undefined }, "scheduled_task_invalid"],
      [{ ...draft, toolsEnabled: "auto" }, "scheduled_task_invalid"],
      [{ ...draft, workspaceEnabled: undefined }, "scheduled_task_invalid"],
      // The composer's rule: tools and Workspace need a model that calls tools.
      [{ ...draft, modelId: "model-plain", searchEnabled: false }, "scheduled_task_tools_unavailable"],
      [{ ...draft, modelId: "model-plain", searchEnabled: false, toolsEnabled: false, workspaceEnabled: true },
        "scheduled_task_workspace_unavailable"],
      [{ ...draft, schedule: { ...hourly, everyHours: 5 }, chatMode: "same" }, "scheduled_task_schedule_invalid"],
      // Hourly and monitoring tasks always continue in one chat.
      [{ ...draft, schedule: hourly }, "scheduled_task_chat_mode_invalid"],
      [{ ...draft, kind: "monitoring" }, "scheduled_task_chat_mode_invalid"],
      [{ ...draft, kind: "watch" }, "scheduled_task_invalid"],
      [{ ...draft, kind: undefined }, "scheduled_task_invalid"],
      // A monitoring check reports through a tool: its model must call tools.
      [{ ...draft, kind: "monitoring", chatMode: "same", modelId: "model-plain", searchEnabled: false }, "scheduled_task_model_cannot_report"]
    ];
    for (const [body, error] of cases) {
      const response = await f.handlers.create(json("POST", body));
      expect([response.status, await response.json()]).toEqual([400, { error }]);
    }
    const malformed = await f.handlers.create(new Request("http://localhost/api/me/scheduled-tasks", { body: "{", method: "POST" }));
    expect(await malformed.json()).toEqual({ error: "scheduled_task_invalid" });
    expect(f.store.create).not.toHaveBeenCalled();
    const accepted = await f.handlers.create(json("POST", {
      ...draft, modelId: "model-plain", searchEnabled: false, toolsEnabled: false,
      schedule: { kind: "once", date: "2026-10-04", time: "11:02" }
    }));
    expect(accepted.status).toBe(201);
    // 4 October 2026 is a Sunday: the first hourly run is Monday 09:00 in Moscow.
    const hourlyTask = await f.handlers.create(json("POST", { ...draft, schedule: hourly, chatMode: "same" }));
    expect(hourlyTask.status).toBe(201);
    expect(f.store.create).toHaveBeenLastCalledWith("owner", { ...draft, schedule: hourly, chatMode: "same" },
      new Date("2026-10-05T06:00:00.000Z"));
  });

  it("maps store limits and hides unexpected failures", async () => {
    const f = fixture();
    f.store.create.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_limit"));
    const limited = await f.handlers.create(json("POST", draft));
    expect([limited.status, await limited.json()]).toEqual([409, { error: "scheduled_task_limit" }]);
    f.store.create.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_hourly_limit"));
    const hourlyLimited = await f.handlers.create(json("POST", { ...draft, schedule: hourly, chatMode: "same" }));
    expect([hourlyLimited.status, await hourlyLimited.json()]).toEqual([409, { error: "scheduled_task_hourly_limit" }]);
    f.store.create.mockRejectedValueOnce(new Error(draft.prompt));
    const failed = await f.handlers.create(json("POST", draft));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(draft.prompt);
    f.store.list.mockRejectedValueOnce(new Error("boom"));
    expect((await f.handlers.list(new Request("http://localhost/api/me/scheduled-tasks"))).status).toBe(503);
  });

  it("scopes reads to the owner and answers missing or malformed ids alike", async () => {
    const f = fixture(null);
    const missing = await f.handlers.detail(new Request("http://localhost/api/me/scheduled-tasks/other"), "other");
    expect([missing.status, await missing.json()]).toEqual([404, { error: "scheduled_task_not_found" }]);
    expect(f.store.detail).toHaveBeenCalledWith("owner", "other");
    const malformed = await f.handlers.detail(new Request("http://localhost/api/me/scheduled-tasks/x"), "../x");
    expect(malformed.status).toBe(404);
    expect(f.store.detail).toHaveBeenCalledTimes(1);
    expect((await f.handlers.update(patch({ expectedRevision: 2, title: "New" }, "other"), "other")).status).toBe(404);
    expect(f.store.update).not.toHaveBeenCalled();
    const listed = await fixture().handlers.list(new Request("http://localhost/api/me/scheduled-tasks"));
    expect(await listed.json()).toMatchObject({ limits: { maxActive: 10, maxTotal: 50 }, emailAvailable: false });
  });

  it("enforces optimistic concurrency and a well-formed patch", async () => {
    const f = fixture();
    const stale = await f.handlers.update(patch({ expectedRevision: 1, title: "New" }), "task-1");
    expect([stale.status, await stale.json()]).toEqual([409, { error: "scheduled_task_stale" }]);
    for (const body of [{ expectedRevision: 2 }, { expectedRevision: 2, modelId: "model-plain" }, { title: "New" },
      { expectedRevision: 2, status: "completed" }, { expectedRevision: 2, chatId: "chat" }]) {
      expect(await (await f.handlers.update(patch(body), "task-1")).json()).toEqual({ error: "scheduled_task_invalid" });
    }
    f.store.update.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_stale"));
    expect((await f.handlers.update(patch({ expectedRevision: 2, title: "New" }), "task-1")).status).toBe(409);
    expect(f.store.update).toHaveBeenCalledTimes(1);
  });

  it("pauses without a due time or model check and resumes from now", async () => {
    const f = fixture();
    expect((await f.handlers.update(patch({ expectedRevision: 2, status: "paused" }), "task-1")).status).toBe(200);
    expect(lastWrite(f)).toMatchObject({ expectedRevision: 2, nextRunAt: null, status: "paused" });
    expect(f.loadCatalog).not.toHaveBeenCalled();

    const paused = fixture(task({ nextRunAt: null, pauseReason: "repeated_failures", status: "paused" }));
    await paused.handlers.update(patch({ expectedRevision: 2, status: "active" }), "task-1");
    expect(lastWrite(paused)).toMatchObject({ nextRunAt: new Date("2026-10-05T06:00:00.000Z"), status: "active" });
    paused.loadCatalog.mockResolvedValueOnce({ ...catalog, models: [] });
    const unavailable = await paused.handlers.update(patch({ expectedRevision: 2, status: "active" }), "task-1");
    expect(await unavailable.json()).toEqual({ error: "scheduled_task_model_unavailable" });
    paused.store.update.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_limit"));
    expect((await paused.handlers.update(patch({ expectedRevision: 2, status: "active" }), "task-1")).status).toBe(409);

    // A changed once schedule must lie ahead even while the task stays paused.
    const past = await paused.handlers.update(patch({ expectedRevision: 2, schedule: { kind: "once", date: "2026-10-03", time: "09:00" } }), "task-1");
    expect(await past.json()).toEqual({ error: "scheduled_task_once_in_past" });
    await paused.handlers.update(patch({ expectedRevision: 2, schedule: { kind: "once", date: "2026-10-12", time: "09:00" } }), "task-1");
    expect(lastWrite(paused)).toMatchObject({ nextRunAt: null, status: "paused" });
  });

  it("keeps an unchanged active due time and rearms a changed schedule", async () => {
    const f = fixture(task({ nextRunAt: "2026-10-04T06:00:00.000Z" })); // already due, not yet claimed
    await f.handlers.update(patch({ expectedRevision: 2, title: "Renamed" }), "task-1");
    expect(lastWrite(f)).toMatchObject({ nextRunAt: undefined, status: "active", draft: { ...draft, title: "Renamed" } });
    expect(f.loadCatalog).toHaveBeenCalledTimes(1);
    await f.handlers.update(patch({ expectedRevision: 2, schedule: { kind: "daily", time: "12:30" } }), "task-1");
    expect(lastWrite(f)?.nextRunAt).toEqual(new Date("2026-10-04T09:30:00.000Z"));

    // A claimed once task has no due time; renaming it while it runs is not "in the past".
    const claimed = fixture(task({ nextRunAt: null, schedule: { kind: "once", date: "2026-10-04", time: "10:00" } }));
    expect((await claimed.handlers.update(patch({ expectedRevision: 2, title: "Renamed" }), "task-1")).status).toBe(200);
    expect(lastWrite(claimed)).toMatchObject({ nextRunAt: undefined, status: "active" });
  });

  it("changes the chat mode only explicitly and keeps hourly tasks in one chat", async () => {
    const f = fixture();
    await f.handlers.update(patch({ expectedRevision: 2, chatMode: "same" }), "task-1");
    expect(lastWrite(f)).toMatchObject({ draft: { ...draft, chatMode: "same" }, nextRunAt: undefined, status: "active" });
    // A new-chat task cannot become hourly without continuing in one chat.
    const silent = await f.handlers.update(patch({ expectedRevision: 2, schedule: hourly }), "task-1");
    expect([silent.status, await silent.json()]).toEqual([400, { error: "scheduled_task_chat_mode_invalid" }]);
    await f.handlers.update(patch({ expectedRevision: 2, schedule: hourly, chatMode: "same" }), "task-1");
    expect(lastWrite(f)).toMatchObject({ draft: { chatMode: "same", schedule: hourly }, nextRunAt: new Date("2026-10-05T06:00:00.000Z") });
    const same = fixture(task({ chatMode: "same", schedule: hourly }));
    const back = await same.handlers.update(patch({ expectedRevision: 2, chatMode: "new" }), "task-1");
    expect(await back.json()).toEqual({ error: "scheduled_task_chat_mode_invalid" });
    expect((await same.handlers.update(patch({ expectedRevision: 2, chatMode: "rotating" }), "task-1")).status).toBe(400);
    expect(same.store.update).not.toHaveBeenCalled();
  });

  it("switches the type only with one chat and a tool-calling model, readmitting the model", async () => {
    const f = fixture(task({ chatMode: "same" }));
    await f.handlers.update(patch({ expectedRevision: 2, kind: "monitoring" }), "task-1");
    expect(lastWrite(f)).toMatchObject({ draft: { chatMode: "same", kind: "monitoring" }, nextRunAt: undefined, status: "active" });
    const separate = fixture();
    const newChat = await separate.handlers.update(patch({ expectedRevision: 2, kind: "monitoring" }), "task-1");
    expect([newChat.status, await newChat.json()]).toEqual([400, { error: "scheduled_task_chat_mode_invalid" }]);
    // A paused task's type change still readmits its model.
    const paused = fixture(task({ chatMode: "same", modelId: "model-plain", nextRunAt: null, searchEnabled: false, status: "paused" }));
    const plain = await paused.handlers.update(patch({ expectedRevision: 2, kind: "monitoring" }), "task-1");
    expect(await plain.json()).toEqual({ error: "scheduled_task_model_cannot_report" });
    expect(paused.store.update).not.toHaveBeenCalled();
    expect((await paused.handlers.update(patch({ expectedRevision: 2, kind: "daily" }), "task-1")).status).toBe(400);
  });

  it("resumes a task that reached its goal from now", async () => {
    const goal = fixture(task({ chatMode: "same", completionReason: "goal_reached", kind: "monitoring", nextRunAt: null, status: "completed" }));
    await goal.handlers.update(patch({ expectedRevision: 2, title: "Renamed" }), "task-1");
    expect(lastWrite(goal)).toMatchObject({ nextRunAt: null, status: "completed" });
    await goal.handlers.update(patch({ expectedRevision: 2, status: "active" }), "task-1");
    expect(lastWrite(goal)).toMatchObject({ nextRunAt: new Date("2026-10-05T06:00:00.000Z"), status: "active" });
  });

  it("reactivates a completed once task only for a new future schedule", async () => {
    const once = { kind: "once", date: "2026-10-01", time: "09:00" } as const;
    const f = fixture(task({ nextRunAt: null, schedule: once, status: "completed" }));
    await f.handlers.update(patch({ expectedRevision: 2, title: "Renamed", schedule: once }), "task-1");
    expect(lastWrite(f)).toMatchObject({ nextRunAt: null, status: "completed" });
    expect(f.loadCatalog).not.toHaveBeenCalled();
    const past = await f.handlers.update(patch({ expectedRevision: 2, status: "active" }), "task-1");
    expect(await past.json()).toEqual({ error: "scheduled_task_once_in_past" });
    await f.handlers.update(patch({ expectedRevision: 2, schedule: { ...once, date: "2026-10-12" } }), "task-1");
    expect(lastWrite(f)).toMatchObject({ nextRunAt: new Date("2026-10-12T06:00:00.000Z"), status: "active" });
  });

  it("deletes and marks rendered results seen for the owner only", async () => {
    const f = fixture();
    const removed = await f.handlers.remove(new Request("http://localhost/api/me/scheduled-tasks/task-1", { method: "DELETE" }), "task-1");
    expect(removed.status).toBe(204);
    expect(f.store.delete).toHaveBeenCalledWith("owner", "task-1");
    f.store.delete.mockResolvedValueOnce(false);
    expect((await f.handlers.remove(new Request("http://localhost/x", { method: "DELETE" }), "task-2")).status).toBe(404);
    const seen = (body: unknown, id = "task-1") => f.handlers.markSeen(json("POST", body, `/${id}/seen`), id);
    expect((await seen({ runIds: ["run-1", "run-2"] })).status).toBe(204);
    expect(f.store.markSeen).toHaveBeenCalledWith("owner", "task-1", ["run-1", "run-2"]);
    f.store.markSeen.mockResolvedValueOnce(false);
    expect((await seen({ runIds: ["run-1"] }, "task-2")).status).toBe(404);
    // Only named results: marking everything blindly could hide one that settled meanwhile.
    for (const body of [{}, { runIds: [] }, { runIds: ["run-1"], all: true }]) {
      const refused = await seen(body);
      expect([refused.status, await refused.json()]).toEqual([400, { error: "scheduled_task_invalid" }]);
    }
    expect(f.store.markSeen).toHaveBeenCalledTimes(2);
  });

  it("queues a manual run now for the owner, refuses while one is open and wakes the runner", async () => {
    const f = fixture(task({ nextRunAt: null, status: "paused" }));
    const run = (id = "task-1") => f.handlers.runNow(new Request(`http://localhost/api/me/scheduled-tasks/${id}/run`, { method: "POST" }), id);
    const queued = await run();
    expect(queued.status).toBe(200);
    expect(queued.headers.get("cache-control")).toBe("private, no-store");
    expect((await queued.json()).task).toMatchObject({ running: true, status: "paused" });
    expect(f.store.requestRun).toHaveBeenCalledWith("owner", "task-1", NOW);
    expect(f.kick).toHaveBeenCalledTimes(1);

    f.store.requestRun.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_running"));
    const busy = await run();
    expect([busy.status, await busy.json()]).toEqual([409, { error: "scheduled_task_running" }]);
    f.store.requestRun.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_not_found"));
    expect((await run("task-2")).status).toBe(404);
    expect((await run("../x")).status).toBe(404);
    expect(f.kick).toHaveBeenCalledTimes(1);

    f.resolveAuth.mockResolvedValueOnce({ userId: "owner", user: { id: "owner", status: "disabled" } });
    expect((await run()).status).toBe(403);
  });

  it("checks tools and Workspace against the model and the installation when they are turned on", async () => {
    const f = fixture(task({ toolsEnabled: false }));
    // Workspace needs the administrator's Workspace switch, read only when Workspace is on.
    await f.handlers.create(json("POST", draft));
    expect(f.workspacePolicy.read).not.toHaveBeenCalled();
    f.workspacePolicy.read.mockResolvedValueOnce({ enabled: false });
    const disabled = await f.handlers.create(json("POST", { ...draft, workspaceEnabled: true }));
    expect([disabled.status, await disabled.json()]).toEqual([400, { error: "scheduled_task_workspace_unavailable" }]);
    expect((await f.handlers.create(json("POST", { ...draft, workspaceEnabled: true }))).status).toBe(201);
    expect(f.store.create).toHaveBeenLastCalledWith("owner", { ...draft, workspaceEnabled: true }, expect.any(Date));

    // Turning tools on for a model without tool calling is refused, even for a paused task.
    const plain = fixture(task({ modelId: "model-plain", nextRunAt: null, searchEnabled: false, status: "paused", toolsEnabled: false }));
    const refused = await plain.handlers.update(patch({ expectedRevision: 2, toolsEnabled: true }), "task-1");
    expect(await refused.json()).toEqual({ error: "scheduled_task_tools_unavailable" });
    // Turning them off needs no check, and a paused task keeps them as they are.
    const tools = fixture(task({ nextRunAt: null, status: "paused" }));
    await tools.handlers.update(patch({ expectedRevision: 2, toolsEnabled: false }), "task-1");
    expect(lastWrite(tools)).toMatchObject({ draft: { toolsEnabled: false, workspaceEnabled: false }, status: "paused" });
    expect(tools.loadCatalog).not.toHaveBeenCalled();
    await tools.handlers.update(patch({ expectedRevision: 2, workspaceEnabled: true }), "task-1");
    expect(lastWrite(tools)).toMatchObject({ draft: { toolsEnabled: true, workspaceEnabled: true } });
    expect(tools.workspacePolicy.read).toHaveBeenCalledTimes(1);
  });

  it("wakes the runner after create and update", async () => {
    const f = fixture();
    await f.handlers.create(json("POST", draft));
    await f.handlers.update(patch({ expectedRevision: 2, title: "New" }), "task-1");
    expect(f.kick).toHaveBeenCalledTimes(2);
    f.store.create.mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_limit"));
    await f.handlers.create(json("POST", draft));
    expect(f.kick).toHaveBeenCalledTimes(2);
  });
});
