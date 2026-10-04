import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask } from "../../contracts/scheduledTasks";
import { insertScheduledTask, ScheduledTaskError } from "../scheduledTasks/store";
import { CREATE_SCHEDULED_TASK_TOOL_NAME, scheduledTaskCreatedResult } from "../tools/scheduledTaskCreation";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { createScheduledTaskForToolCall } from "./prismaRepositoryScheduledTaskCall";
import { snapshotToolExecutionResult } from "./toolExecutionPersistence";
import { fetchUrlDigest } from "../webFetch/urls";

vi.mock("../scheduledTasks/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../scheduledTasks/store")>(), insertScheduledTask: vi.fn()
}));
vi.mock("./prismaRepositoryToolLoop", async (importOriginal) => ({
  ...await importOriginal<typeof import("./prismaRepositoryToolLoop")>(),
  appendRunOutputEvents: vi.fn(async (_tx: unknown, _runId: string, events: readonly unknown[]) => [...events])
}));

const now = new Date("2026-10-04T10:00:00.000Z");
const body = {
  title: "Check mail", prompt: "Remind me to check my mail.", schedule: { kind: "weekly", time: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow", modelId: "deployment-1", provider: "connection-1",
  searchEnabled: false, emailNotify: false, toolsEnabled: true, workspaceEnabled: false, chatMode: "new", kind: "standard"
};
const created: ScheduledTask = {
  id: "task-1", title: "Check mail", prompt: body.prompt, schedule: { kind: "weekly", time: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow", modelId: "deployment-1", provider: "connection-1",
  searchEnabled: false, emailNotify: false, toolsEnabled: true, workspaceEnabled: false, chatMode: "new", kind: "standard",
  status: "active", pauseReason: null, completionReason: null, nextRunAt: "2026-10-05T06:00:00.000Z", lastRun: null,
  running: false, chatId: null, unseenResult: false, revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()
};
const providerCall = { id: "provider-call-1", name: CREATE_SCHEDULED_TASK_TOOL_NAME };

type FakeCall = { id: string; modelRunId: string; providerCallId: string; result: unknown; state: string; toolName: string };
type FakeState = {
  calls: FakeCall[];
  /** The owner's current task ids. */
  existingTaskIds: string[];
  owner: boolean;
  /** The answered user message's scheduled task prompt mark; null when the message is gone. */
  prompt: { scheduledTaskPrompt: boolean } | null;
  run: { errorPayload: null; scheduledTaskId: string | null; status: string; userMessageId: string } | null;
  /** Other runs answering the same user message. */
  siblingRuns: Array<{ id: string }>;
};

function harness(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    calls: [{ id: "persisted-1", modelRunId: "run-1", providerCallId: "provider-call-1", result: null, state: "running",
      toolName: CREATE_SCHEDULED_TASK_TOOL_NAME }],
    existingTaskIds: [],
    owner: true,
    prompt: { scheduledTaskPrompt: false },
    run: { errorPayload: null, scheduledTaskId: null, status: "streaming", userMessageId: "message-1" },
    siblingRuns: [],
    ...overrides
  };
  const runOfMessage = (runId: string) => runId === "run-1" || state.siblingRuns.some((sibling) => sibling.id === runId);
  const queries: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const text = query.strings.join("?");
      queries.push(text.includes("\"User\"") ? "owner" : text.includes("\"ModelRun\"") ? "run" : "other");
      if (text.includes("\"User\"")) return state.owner ? [{ id: "user-1" }] : [];
      if (text.includes("\"ModelRun\"")) return state.run ? [state.run] : [];
      throw new Error("unexpected_query");
    }),
    modelRunToolCall: {
      count: vi.fn(async ({ where }: { where: { id: { not: string }; modelRunId: string; state: string; toolName: string } }) =>
        state.calls.filter((call) => call.id !== where.id.not && call.modelRunId === where.modelRunId &&
          call.state === where.state && call.toolName === where.toolName).length),
      findFirst: vi.fn(async ({ where }: { where: { id: string; modelRunId: string } }) =>
        state.calls.find((call) => call.id === where.id && call.modelRunId === where.modelRunId) ?? null),
      findMany: vi.fn(async ({ where }: { where: { modelRunId: { not: string }; state: string; toolName: string } }) =>
        state.calls.filter((call) => call.modelRunId !== where.modelRunId.not && runOfMessage(call.modelRunId) &&
          call.state === where.state && call.toolName === where.toolName)),
      updateMany: vi.fn(async ({ data, where }: { data: { result: unknown; state: string };
        where: { id: string; modelRunId: string; state: string } }) => {
        const call = state.calls.find((entry) => entry.id === where.id && entry.modelRunId === where.modelRunId &&
          entry.state === where.state);
        if (!call) return { count: 0 };
        Object.assign(call, { result: data.result, state: data.state });
        return { count: 1 };
      })
    }
  };
  const findPrompt = vi.fn(async ({ where }: { where: { id: string } }) =>
    where.id === state.run?.userMessageId ? state.prompt : null);
  Object.assign(tx, {
    message: { findUnique: findPrompt },
    scheduledTask: { count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => state.existingTaskIds.includes(id)).length) }
  });
  const prisma = { $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)) };
  const kick = vi.fn();
  const deps = {
    kick,
    loadCatalog: vi.fn(async () => ({ models: [{ capabilities: { toolCalling: true }, modelId: "deployment-1",
      provider: "connection-1", searchStrategyIds: [] }], searchStrategies: [] })),
    now: () => now,
    workspacePolicy: { read: vi.fn(async () => ({ enabled: true })) }
  };
  const create = (input: Partial<Parameters<typeof createScheduledTaskForToolCall>[2]> = {}) =>
    createScheduledTaskForToolCall(prisma as unknown as PrismaClient, deps, {
      body, callId: "persisted-1", result: (task) => scheduledTaskCreatedResult(providerCall, task, false), runId: "run-1",
      userId: "user-1", userUrlDigests: [], ...input
    });
  return { create, deps, findPrompt, kick, prisma, queries, state, tx };
}

beforeEach(() => {
  vi.mocked(insertScheduledTask).mockReset().mockResolvedValue(created);
  vi.mocked(appendRunOutputEvents).mockClear();
});

describe("scheduled task creation for a run's tool call", () => {
  it("creates once under the owner then run locks, settling the call and appending the card in the same transaction", async () => {
    const h = harness();
    const outcome = await h.create();
    expect(outcome).toMatchObject({ kind: "created", task: { id: "task-1" } });
    expect(h.queries).toEqual(["owner", "run"]);
    expect(insertScheduledTask).toHaveBeenCalledExactlyOnceWith(h.tx, "user-1", expect.objectContaining({
      title: "Check mail", schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }
    }), new Date("2026-10-05T06:00:00.000Z"), []);
    // The call settles with exactly the snapshot the loop would settle, so its own settle is a reuse.
    const snapshot = snapshotToolExecutionResult(scheduledTaskCreatedResult(providerCall, created, false), 64_000);
    expect(snapshot).not.toBeNull();
    expect(h.state.calls[0]).toMatchObject({ result: snapshot, state: "complete" });
    expect(appendRunOutputEvents).toHaveBeenCalledExactlyOnceWith(h.tx, "run-1", [
      expect.objectContaining({ data: expect.objectContaining({ artifactType: "scheduled_task" }) })
    ]);
    expect(h.kick).toHaveBeenCalledOnce();
  });

  it("stores only links of the model-written prompt that the user's own text in the run authorized", async () => {
    const h = harness();
    const prompt = "Every morning read https://news.example/today and https://attacker.example/?data=secret";
    await h.create({ body: { ...body, prompt }, userUrlDigests: [fetchUrlDigest("https://news.example/today")] });
    expect(vi.mocked(insertScheduledTask).mock.calls[0]?.[4]).toEqual([fetchUrlDigest("https://news.example/today")]);
  });

  it("replays a call that already settled and never creates again", async () => {
    const stored = snapshotToolExecutionResult(scheduledTaskCreatedResult(providerCall, created, false), 64_000);
    const h = harness({ calls: [{ id: "persisted-1", modelRunId: "run-1", providerCallId: "provider-call-1", result: stored,
      state: "complete", toolName: CREATE_SCHEDULED_TASK_TOOL_NAME }] });
    const outcome = await h.create();
    expect(outcome).toMatchObject({ kind: "settled", result: { callId: "provider-call-1", status: "complete",
      artifacts: [expect.objectContaining({ type: "artifact" })] } });
    expect(insertScheduledTask).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it("refuses a second creation in the same answer", async () => {
    const h = harness();
    h.state.calls.push({ id: "persisted-0", modelRunId: "run-1", providerCallId: "provider-call-0", result: {}, state: "complete",
      toolName: CREATE_SCHEDULED_TASK_TOOL_NAME });
    expect(await h.create()).toEqual({ code: "scheduled_task_answer_limit", kind: "refused" });
    expect(insertScheduledTask).not.toHaveBeenCalled();
    expect(h.state.calls[0]?.state).toBe("running");
    // A refused earlier attempt created nothing, so it does not count.
    const retry = harness();
    retry.state.calls.push({ id: "persisted-0", modelRunId: "run-1", providerCallId: "provider-call-0", result: {}, state: "error",
      toolName: CREATE_SCHEDULED_TASK_TOOL_NAME });
    expect(await retry.create()).toMatchObject({ kind: "created" });
  });

  it("keeps one task per message while the owner has it, so a regenerated answer never duplicates it", async () => {
    const stored = snapshotToolExecutionResult(scheduledTaskCreatedResult({ id: "provider-call-0",
      name: CREATE_SCHEDULED_TASK_TOOL_NAME }, { ...created, id: "task-0" }, false), 64_000);
    const earlier = (existingTaskIds: string[]) => {
      const h = harness({ existingTaskIds, siblingRuns: [{ id: "run-0" }] });
      h.state.calls.push({ id: "persisted-0", modelRunId: "run-0", providerCallId: "provider-call-0", result: stored,
        state: "complete", toolName: CREATE_SCHEDULED_TASK_TOOL_NAME });
      return h;
    };
    expect(await earlier(["task-0"]).create()).toEqual({ code: "scheduled_task_already_created", kind: "refused" });
    expect(insertScheduledTask).not.toHaveBeenCalled();
    // The owner deleted the earlier task: answering again may create it anew.
    expect(await earlier([]).create()).toMatchObject({ kind: "created" });
  });

  it("never creates from another answer to a scheduled task's prompt, by the mark on its message", async () => {
    // A regeneration in the task's chat or an answer in a branch copy: an
    // ordinary run whose user message is marked as the task's prompt.
    const scheduledTurn = harness({ prompt: { scheduledTaskPrompt: true }, siblingRuns: [{ id: "run-0" }] });
    expect(await scheduledTurn.create()).toEqual({ code: "scheduled_task_call_unavailable", kind: "refused" });
    expect(scheduledTurn.findPrompt).toHaveBeenCalledWith({ select: { scheduledTaskPrompt: true }, where: { id: "message-1" } });
    // A message that cannot be read fails closed.
    expect(await harness({ prompt: null }).create()).toEqual({ code: "scheduled_task_call_unavailable", kind: "refused" });
    expect(insertScheduledTask).not.toHaveBeenCalled();
    // The call stays the loop's to settle.
    expect(scheduledTurn.state.calls[0]?.state).toBe("running");
  });

  it("never creates from a scheduled, settled or missing run, or for a call that is not this run's running creation", async () => {
    for (const overrides of [
      { run: { errorPayload: null, scheduledTaskId: "task-0", status: "streaming", userMessageId: "message-1" } },
      { run: { errorPayload: null, scheduledTaskId: null, status: "complete", userMessageId: "message-1" } },
      { run: null },
      { calls: [{ id: "persisted-1", modelRunId: "run-1", providerCallId: "provider-call-1", result: null, state: "pending",
        toolName: CREATE_SCHEDULED_TASK_TOOL_NAME }] },
      { calls: [{ id: "persisted-1", modelRunId: "run-1", providerCallId: "provider-call-1", result: null, state: "running",
        toolName: "get_session_status" }] },
      { calls: [] }
    ] satisfies Partial<FakeState>[]) {
      expect(await harness(overrides).create()).toEqual({ code: "scheduled_task_call_unavailable", kind: "refused" });
    }
    expect(await harness({ owner: false }).create()).toEqual({ code: "scheduled_tasks_unavailable", kind: "refused" });
    expect(insertScheduledTask).not.toHaveBeenCalled();
  });

  it("applies the owner API's rules first and its limits inside the transaction", async () => {
    const invalid = harness();
    expect(await invalid.create({ body: { ...body, schedule: { kind: "daily", time: "25:00" } } }))
      .toEqual({ code: "scheduled_task_schedule_invalid", kind: "refused" });
    expect(invalid.prisma.$transaction).not.toHaveBeenCalled();
    const unavailable = harness();
    unavailable.deps.loadCatalog.mockResolvedValueOnce({ models: [], searchStrategies: [] });
    expect(await unavailable.create()).toEqual({ code: "scheduled_task_model_unavailable", kind: "refused" });
    const workspace = harness();
    workspace.deps.workspacePolicy.read.mockResolvedValueOnce({ enabled: false });
    expect(await workspace.create({ body: { ...body, workspaceEnabled: true } }))
      .toEqual({ code: "scheduled_task_workspace_unavailable", kind: "refused" });
    expect(insertScheduledTask).not.toHaveBeenCalled();

    const full = harness();
    vi.mocked(insertScheduledTask).mockRejectedValueOnce(new ScheduledTaskError("scheduled_task_hourly_limit"));
    expect(await full.create()).toEqual({ code: "scheduled_task_hourly_limit", kind: "refused" });
    expect(full.state.calls[0]?.state).toBe("running");
    expect(full.kick).not.toHaveBeenCalled();
  });
});
