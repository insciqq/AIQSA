import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { freezeComputerBinding } from "../tools/computerBinding";
import { createPrismaRunRepository } from "./prismaRepository";
import type { RunRepository } from "./runRepositoryContract";

const owners: string[] = [];
const repository = createPrismaRunRepository(prisma);
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const choice = { cwd: "C:\\Users\\synthetic\\Reports", deviceId: DEVICE };
const frozen = freezeComputerBinding(choice, { arch: "amd64", name: "Synthetic PC", online: false, os: "windows" })!;

async function owner(): Promise<string> {
  const userId = `chat-computer-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: {
    displayName: "Chat computer test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } }
  } });
  return userId;
}

function sendInput(chatId: string, userId: string, expectedActiveLeafId: string | null,
  extra: Partial<Parameters<RunRepository["createRun"]>[0]> = {}): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Synthetic question");
  return {
    chatId, content, expectedActiveLeafId, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId,
    normalizedRequest: {
      attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
    },
    ...extra
  };
}

async function settle(runId: string): Promise<void> {
  await prisma.modelRun.update({ data: { status: "complete" }, where: { id: runId } });
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    await tx.user.deleteMany({ where: { id } });
  });
});
afterAll(() => prisma.$disconnect());

describe("a chat's computer choice", () => {
  it("is stored with the message that made it, left by one without the field, cleared by null, and read back for admission", async () => {
    const userId = await owner();
    const { id: chatId } = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Chat", userId } });
    const first = await repository.createRun(sendInput(chatId, userId, null, { chatComputer: choice,
      normalizedRequest: { ...sendInput(chatId, userId, null).normalizedRequest, computer: frozen } }));
    expect(await prisma.chat.findUnique({ select: { computerCwd: true, computerDeviceId: true }, where: { id: chatId } }))
      .toEqual({ computerCwd: choice.cwd, computerDeviceId: DEVICE });
    expect((await repository.findOwnedChat(chatId, userId))?.computer).toEqual(choice);
    await settle(first.runId);

    // A regenerate of that answer repeats its run's computer.
    expect((await repository.findRegenerationSource(first.assistantMessageId, userId))?.computer).toEqual(frozen);

    const second = await repository.createRun(sendInput(chatId, userId, first.assistantMessageId));
    expect((await repository.findOwnedChat(chatId, userId))?.computer).toEqual(choice);
    expect((await repository.findRegenerationSource(second.assistantMessageId, userId))?.computer).toBeNull();
    await settle(second.runId);

    await repository.createRun(sendInput(chatId, userId, second.assistantMessageId, { chatComputer: null }));
    expect(await prisma.chat.findUnique({ select: { computerCwd: true, computerDeviceId: true }, where: { id: chatId } }))
      .toEqual({ computerCwd: null, computerDeviceId: null });
    expect((await repository.findOwnedChat(chatId, userId))?.computer).toBeNull();
  });

  it("stays named when its device is gone, since nothing ties it to the device row", async () => {
    const userId = await owner();
    const { id: chatId } = await prisma.chat.create({ data: { computerCwd: "~", computerDeviceId: DEVICE,
      defaultProviderModelId: providerTemplateIds.fakeModel, title: "Chat", userId } });
    expect((await repository.findOwnedChat(chatId, userId))?.computer).toEqual({ cwd: "~", deviceId: DEVICE });
  });
});
