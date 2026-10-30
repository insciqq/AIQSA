import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import { createPrismaProviderRuntimeStore, createProviderRuntimeResolver } from "../../providerRuntime/runtimeResolver";
import type { SubagentModelEntry } from "./modelCatalog";
import { createPrismaSubagentModelCatalog, subagentBindingKey } from "./modelRoutes";

const owners: string[] = [];
const catalog = createPrismaSubagentModelCatalog({ prisma, runtime: createProviderRuntimeResolver({ allowFake: true,
  createFetch: () => { throw new Error("no provider request in this test"); }, store: createPrismaProviderRuntimeStore(prisma) }) });
const entry: SubagentModelEntry = { connectionId: providerTemplateIds.fakeConnection, contextWindow: null, defaultEffort: null,
  displayName: "Fake", imageInput: false, providerFamily: "fake", providerModelId: providerTemplateIds.fakeModel, reasoningEfforts: [],
  upstreamModelId: "fake-qsa" };

async function streamingRun() {
  const userId = `subagent-route-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Sub-agent route test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } } } });
  const grant = await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Routes", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic question"), role: "user",
    status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id,
    role: "assistant", status: "streaming" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine: "native", modelId: "fake-qsa",
    normalizedRequest: {}, provider: "fake", status: "streaming", userId, userMessageId: question.id } });
  return { chatId: chat.id, grantId: grant.id, runId: run.id, userId };
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("sub-agent model routes on PostgreSQL", () => {
  it("binds a frozen model once per run, however many first uses race, and derives every later route from that binding", async () => {
    const run = await streamingRun();
    const routes = await Promise.all(Array.from({ length: 4 }, () => catalog.route({ chatId: run.chatId, effort: null, entry,
      runId: run.runId, userId: run.userId })));
    expect(routes.every((route) => route.ok)).toBe(true);
    await expect(prisma.providerRunBinding.count({ where: { bindingKey: subagentBindingKey(entry), modelRunId: run.runId } }))
      .resolves.toBe(1);
    // The run keeps what its first use admitted: a revoked grant changes later runs, not this one's later turns.
    await prisma.accessGrant.delete({ where: { id: run.grantId } });
    const later = await catalog.route({ chatId: run.chatId, effort: null, entry, runId: run.runId, userId: run.userId });
    expect(later).toMatchObject({ ok: true, route: { request: { modelId: "fake-qsa" }, snapshot: { providerModelId: entry.providerModelId } } });
    await expect(prisma.providerRunBinding.count({ where: { modelRunId: run.runId } })).resolves.toBe(1);
  });

  it("routes a background turn's model after its parent answered, from the parent's binding, only while the turn's run runs", async () => {
    const run = await streamingRun();
    // The parent's call admits the model before the background turn is admitted (`call_subagent` resolves its route first).
    expect((await catalog.route({ chatId: run.chatId, effort: null, entry, runId: run.runId, userId: run.userId })).ok).toBe(true);
    const parent = await prisma.modelRun.findUniqueOrThrow({ select: { userMessageId: true }, where: { id: run.runId } });
    const call = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: run.runId, ordinal: 0, providerCallId: "call-0",
      roundIndex: 1, state: "complete", toolName: "call_subagent" } });
    const thread = await prisma.subagentThread.create({ data: { anchorRunId: run.runId, chatId: run.chatId, name: "watcher", userId: run.userId } });
    const turn = await prisma.subagentTurn.create({ data: { chatId: run.chatId, mode: "background", modelId: "fake-qsa", parentRunId: run.runId,
      parentToolCallId: call.id, provider: entry.connectionId, providerModelId: entry.providerModelId, threadId: thread.id, userId: run.userId } });
    const background = await prisma.modelRun.create({ data: { chatId: run.chatId, engine: "native", modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", status: "streaming", subagentThreadId: thread.id, subagentTurnId: turn.id, userId: run.userId,
      userMessageId: parent.userMessageId } });
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.runId } });
    const routed = { chatId: run.chatId, effort: null, entry, hostRunId: background.id, runId: run.runId, userId: run.userId };
    await expect(catalog.route(routed)).resolves.toMatchObject({ ok: true, route: { snapshot: { providerModelId: entry.providerModelId } } });
    // Another owner, or a run that is not this parent's background turn, gets nothing.
    await expect(catalog.route({ ...routed, userId: "someone-else" })).resolves.toEqual({ code: "subagent_model_unavailable", ok: false });
    await expect(catalog.route({ ...routed, hostRunId: run.runId, runId: background.id }))
      .resolves.toEqual({ code: "subagent_model_unavailable", ok: false });
    // A model the parent's call never admitted is not admitted by the background run.
    await expect(catalog.route({ ...routed, entry: { ...entry, providerModelId: `${entry.providerModelId}-other` } }))
      .resolves.toEqual({ code: "subagent_model_unavailable", ok: false });
    // Once the turn's own run ended, its model is refused too.
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: background.id } });
    await expect(catalog.route(routed)).resolves.toEqual({ code: "subagent_model_unavailable", ok: false });
    await expect(prisma.providerRunBinding.count({ where: { modelRunId: run.runId } })).resolves.toBe(1);
  });

  it("refuses a model for a run that is not its owner's or no longer runs, and binds nothing", async () => {
    const run = await streamingRun();
    await expect(catalog.route({ chatId: run.chatId, effort: null, entry, runId: run.runId, userId: "someone-else" }))
      .resolves.toEqual({ code: "subagent_model_unavailable", ok: false });
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.runId } });
    await expect(catalog.route({ chatId: run.chatId, effort: null, entry, runId: run.runId, userId: run.userId }))
      .resolves.toEqual({ code: "subagent_model_unavailable", ok: false });
    await expect(prisma.providerRunBinding.count({ where: { modelRunId: run.runId } })).resolves.toBe(0);
  });
});
