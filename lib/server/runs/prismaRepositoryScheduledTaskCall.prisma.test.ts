// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaScheduledTaskStore, scheduledTaskScheduleColumns } from "../scheduledTasks/store";
import { CREATE_SCHEDULED_TASK_TOOL_NAME, scheduledTaskCreatedResult } from "../tools/scheduledTaskCreation";
import { appendRunOutputEvents } from "./prismaRepositoryToolLoop";
import { createScheduledTaskForToolCall } from "./prismaRepositoryScheduledTaskCall";
import { projectRunOutputArtifactEvent } from "./runOutputEvents";

const users: string[] = [];
const deps = {
  kick: () => undefined,
  loadCatalog: async () => ({ models: [{ capabilities: { toolCalling: true }, modelId: "fake-qsa", provider: "fake",
    searchStrategyIds: [] }], searchStrategies: [] }),
  now: () => new Date("2026-10-04T10:00:00.000Z"),
  workspacePolicy: { read: async () => ({ enabled: true }) }
};
const body = {
  title: "Synthetic reminder", prompt: "Synthetic scheduled prompt", schedule: { kind: "weekly", time: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow", modelId: "fake-qsa", provider: "fake",
  searchEnabled: false, emailNotify: false, toolsEnabled: false, workspaceEnabled: false, chatMode: "new", kind: "standard"
};

/** An owner, a personal chat with one turn and its open run holding `calls` running creation calls. */
async function answer(input: Readonly<{ calls?: number; scheduledTaskId?: string }> = {}) {
  const userId = `scheduled-call-test-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic scheduled call", id: userId, status: "active" } });
  const chatId = randomUUID();
  const questionId = randomUUID();
  const answerId = randomUUID();
  const runId = randomUUID();
  await prisma.chat.create({ data: { id: chatId, title: "Synthetic chat", userId } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("Remind me"), id: questionId, role: "user",
    status: "complete" } });
  await prisma.message.create({ data: { chatId, content: textMessageContent(""), id: answerId, parentMessageId: questionId,
    role: "assistant", status: "streaming" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answerId }, where: { id: chatId } });
  await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: runId, modelId: "fake-qsa", normalizedRequest: {},
    provider: "fake", status: "streaming", userId, userMessageId: questionId,
    ...(input.scheduledTaskId ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1,
      scheduledTaskId: input.scheduledTaskId } : {}) } });
  const callIds: string[] = [];
  for (let ordinal = 0; ordinal < (input.calls ?? 1); ordinal += 1) {
    const call = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: runId, ordinal,
      providerCallId: `provider-call-${ordinal}`, roundIndex: 1, startedAt: new Date(), state: "running",
      toolName: CREATE_SCHEDULED_TASK_TOOL_NAME } });
    callIds.push(call.id);
  }
  const create = (callId: string, ordinal = 0) => createScheduledTaskForToolCall(prisma, deps, { body, callId, runId, userId,
    result: (task) => scheduledTaskCreatedResult({ id: `provider-call-${ordinal}`, name: CREATE_SCHEDULED_TASK_TOOL_NAME }, task, false) });
  return { answerId, callIds, chatId, create, runId, userId };
}

const cardEvents = (runId: string) => prisma.modelRunEvent.findMany({ where: { eventType: "artifact", modelRunId: runId,
  payload: { path: ["artifactType"], equals: "scheduled_task" } } });

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("a chat answer's scheduled task creation", () => {
  it("commits the task, the call's settlement and the card together, once per answer under concurrency", async () => {
    const turn = await answer({ calls: 2 });
    const outcomes = await Promise.all(turn.callIds.map((callId, ordinal) => turn.create(callId, ordinal)));
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["created", "refused"]);
    expect(outcomes.find((outcome) => outcome.kind === "refused")).toEqual({ code: "scheduled_task_answer_limit", kind: "refused" });
    expect(await prisma.scheduledTask.count({ where: { userId: turn.userId } })).toBe(1);
    const calls = await prisma.modelRunToolCall.findMany({ orderBy: { ordinal: "asc" }, where: { modelRunId: turn.runId } });
    // The refused call is still the loop's to settle; the created one settled with its task.
    expect(calls.map((call) => call.state).sort()).toEqual(["complete", "running"]);
    expect(await cardEvents(turn.runId)).toHaveLength(1);

    // A live or recovered replay publishes the card again: the answer keeps it once.
    const created = outcomes.find((outcome) => outcome.kind === "created");
    if (created?.kind !== "created") throw new Error("expected a created task");
    const card = projectRunOutputArtifactEvent(created.result.artifacts![0]!)!;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${turn.runId} FOR UPDATE`;
      await appendRunOutputEvents(tx, turn.runId, [card]);
    });
    expect(await cardEvents(turn.runId)).toHaveLength(1);
  });

  it("replays a settled call and creates again only what a rolled-back attempt never created", async () => {
    const turn = await answer();
    const first = await turn.create(turn.callIds[0]!);
    expect(first.kind).toBe("created");
    const again = await turn.create(turn.callIds[0]!);
    expect(again).toMatchObject({ kind: "settled", result: { status: "complete" } });
    expect(await prisma.scheduledTask.count({ where: { userId: turn.userId } })).toBe(1);

    // At a limit the transaction rolls back whole: no task, no settlement, no card.
    const full = await answer();
    await prisma.scheduledTask.createMany({ data: Array.from({ length: 10 }, (_value, index) => ({
      ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), modelId: "fake-qsa", nextRunAt: new Date(),
      prompt: "Seed", provider: "fake", status: "ACTIVE" as const, timeZone: "UTC", title: `Seed ${index}`, userId: full.userId
    })) });
    expect(await full.create(full.callIds[0]!)).toEqual({ code: "scheduled_task_limit", kind: "refused" });
    expect(await prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: full.callIds[0]! } })).toMatchObject({ state: "running" });
    expect(await cardEvents(full.runId)).toHaveLength(0);
  });

  it("never creates from a scheduled run", async () => {
    const turn = await answer({ scheduledTaskId: randomUUID() });
    expect(await turn.create(turn.callIds[0]!)).toEqual({ code: "scheduled_task_call_unavailable", kind: "refused" });
    expect(await prisma.scheduledTask.count({ where: { userId: turn.userId } })).toBe(0);
  });

  it("keeps one task per message while the owner has it: a regenerated answer creates again only after a deletion", async () => {
    const turn = await answer();
    const first = await turn.create(turn.callIds[0]!);
    if (first.kind !== "created") throw new Error("expected a created task");
    // The first answer settles; a regeneration answers the same message in a sibling run.
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: turn.runId } });
    const question = await prisma.modelRun.findUniqueOrThrow({ select: { userMessageId: true }, where: { id: turn.runId } });
    const regenerationId = randomUUID();
    const answerId = randomUUID();
    await prisma.message.create({ data: { chatId: turn.chatId, content: textMessageContent(""), id: answerId,
      parentMessageId: question.userMessageId, role: "assistant", status: "streaming" } });
    await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId: turn.chatId, id: regenerationId,
      modelId: "fake-qsa", provider: "fake", status: "streaming", userId: turn.userId, userMessageId: question.userMessageId } });
    const regenerate = async () => {
      const call = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: regenerationId,
        ordinal: await prisma.modelRunToolCall.count({ where: { modelRunId: regenerationId } }), providerCallId: randomUUID(),
        roundIndex: 1, startedAt: new Date(), state: "running", toolName: CREATE_SCHEDULED_TASK_TOOL_NAME } });
      return createScheduledTaskForToolCall(prisma, deps, { body, callId: call.id, runId: regenerationId, userId: turn.userId,
        result: (task) => scheduledTaskCreatedResult({ id: call.providerCallId, name: CREATE_SCHEDULED_TASK_TOOL_NAME }, task, false) });
    };
    expect(await regenerate()).toEqual({ code: "scheduled_task_already_created", kind: "refused" });
    expect(await prisma.scheduledTask.count({ where: { userId: turn.userId } })).toBe(1);
    await createPrismaScheduledTaskStore(prisma).delete(turn.userId, first.task.id);
    expect(await regenerate()).toMatchObject({ kind: "created" });
    expect(await prisma.scheduledTask.count({ where: { userId: turn.userId } })).toBe(1);
  });

  it("shows the card as the task is now on reload, and as deleted once the owner deletes it", async () => {
    const turn = await answer();
    const outcome = await turn.create(turn.callIds[0]!);
    if (outcome.kind !== "created") throw new Error("expected a created task");
    const chats = createPrismaChatRepository(prisma);
    const card = async () => (await chats.getChat({ chatId: turn.chatId, userId: turn.userId }))?.messages
      .find((message) => message.id === turn.answerId)?.artifactSummary?.scheduledTasks;
    expect(await card()).toEqual([expect.objectContaining({ taskId: outcome.task.id, title: "Synthetic reminder", status: "active" })]);
    await createPrismaScheduledTaskStore(prisma).delete(turn.userId, outcome.task.id);
    expect(await card()).toEqual([expect.objectContaining({ taskId: outcome.task.id, deleted: true })]);
  });
});
