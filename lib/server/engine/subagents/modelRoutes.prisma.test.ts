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
