import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import type { RunRepository } from "../runs/runRepositoryContract";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";

const owners: string[] = [];
const repository = createPrismaRunRepository(prisma);

async function owner(): Promise<string> {
  const userId = `engine-routing-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Engine routing test", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

function sendInput(chatId: string, userId: string, expectedActiveLeafId: string | null = null): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Synthetic question");
  return {
    chatId, content, expectedActiveLeafId, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId,
    defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId },
    normalizedRequest: {
      attachmentIds: [], chatId, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
    }
  };
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("engine marker at admission", () => {
  it("writes native for every send, whatever the column's default", async () => {
    const userId = await owner();
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Native", userId } });
    const run = await repository.createRun(sendInput(chat.id, userId));
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).resolves.toMatchObject({ engine: "native" });
  });

  it("shares the one-active-run guard: a native run blocks another send of its chat", async () => {
    const userId = await owner();
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Busy", userId } });
    const first = await repository.createRun(sendInput(chat.id, userId));
    await expect(repository.createRun(sendInput(chat.id, userId, first.assistantMessageId))).rejects.toBeInstanceOf(ActiveRunConflictError);
  });

  it("writes native for a regeneration", async () => {
    const userId = await owner();
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Again", userId } });
    const first = await repository.createRun(sendInput(chat.id, userId));
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: first.runId } });
    await prisma.message.update({ data: { status: "complete" }, where: { id: first.assistantMessageId } });
    const input = sendInput(chat.id, userId);
    const again = await repository.createRegenerationRun({ chatId: chat.id, defaults: input.defaults,
      modelId: input.modelId, normalizedRequest: input.normalizedRequest, preSendAssistantMessageId: first.assistantMessageId,
      provider: input.provider, providerRequestPreview: {}, userId, userMessageId: first.userMessageId });
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: again.runId } })).resolves.toMatchObject({ engine: "native" });
  });
});
