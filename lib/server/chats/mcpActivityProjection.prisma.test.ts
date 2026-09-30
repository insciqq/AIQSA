import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatDetailRecord } from "./handlers";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createPrismaChatRepository } from "./prismaRepository";

const toolName = "mcp_projection_fixture";
const fingerprint = "projection-fixture-fingerprint";
const acceptedRequest = {
  mcp: {
    servers: [{ serverId: "projection-server", revisionId: "projection-revision", fingerprint }],
    tools: [{ namespacedName: toolName, originalName: "search", serverId: "projection-server",
      serverName: "Projection Tools" }]
  }
};
const reference = { roundIndex: 2, ordinal: 3 };

async function withProjectionFixture(
  projectMode: boolean,
  check: (fixture: {
    chatId: string; initiatorId: string; viewerIds: string[]; sourceAnswerId: string; copiedAnswerId: string; userMessageId: string;
  }) => Promise<void>
) {
  const initiatorId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const userIds = [initiatorId, ownerId, adminId];
  let projectId: string | undefined;
  let chatId: string | undefined;
  await prisma.user.createMany({ data: userIds.map((id, index) => ({
    id, displayName: `Projection member ${index}`, role: id === adminId ? "admin" : "user", status: "active"
  })) });
  try {
    if (projectMode) {
      const project = await prisma.project.create({ data: {
        name: "MCP projection test", createdByDisplayName: "Projection Owner", createdByUserId: ownerId,
        grants: { create: [
          { role: "OWNER", userId: ownerId }, { role: "CONTRIBUTOR", userId: initiatorId },
          { role: "VIEWER", userId: adminId }
        ] }
      } });
      projectId = project.id;
    }
    const chat = await prisma.chat.create({ data: {
      title: "MCP projection", memoryMode: "EXCLUDED", userId: projectMode ? null : initiatorId,
      ...(projectId ? { projectId, createdByUserId: initiatorId, createdByDisplayName: "Projection member 0" } : {})
    } });
    chatId = chat.id;
    const ids = Array.from({ length: 54 }, () => randomUUID());
    await prisma.message.createMany({ data: ids.map((id, index) => ({
      id, chatId: chat.id, role: index === 0 ? "user" : "assistant", status: "complete",
      parentMessageId: index === 0 ? null : ids[index - 1],
      ...(projectId && index === 0 ? { authorUserId: initiatorId, authorDisplayName: "Projection member 0",
        authorProjectRole: "CONTRIBUTOR" as const } : {}),
      content: { blocks: [{ type: "text", text: "Synthetic message" }] }
    })) });
    const run = await prisma.$transaction(async tx => {
      const run = await tx.modelRun.create({ data: {
        chatId: chat.id, userId: initiatorId, userMessageId: ids[0], assistantMessageId: ids[1],
        modelId: "fake-qsa", provider: "fake", normalizedRequest: acceptedRequest, status: "complete"
      } });
      if (projectId) await tx.projectRunBinding.create({ data: {
        modelRunId: run.id, projectId, initiatorUserId: initiatorId, acceptedRole: "CONTRIBUTOR",
        accessRevision: 1, policyRevision: 1, instructionsRevision: 1, memoryRevision: 0,
        personalMemoryDisabled: true
      } });
      const binding = await tx.mcpRunBinding.create({ data: {
        modelRunId: run.id, runtimeGenerationFingerprint: fingerprint
      } });
      await tx.modelRunToolCall.create({ data: {
        modelRunId: run.id, mcpRunBindingId: binding.id, ...reference, toolName, providerCallId: "fixture-call",
        arguments: { privateArgument: "synthetic request" }, result: { privateResult: "synthetic response" },
        state: "complete"
      } });
      return run;
    });
    // A copied assistant message keeps the source run's initiator, independently
    // of the Project participant currently reading the chat.
    await prisma.message.update({ where: { id: ids.at(-1)! }, data: {
      branchSourceModelRunId: run.id
    } });
    await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: ids.at(-1) } });
    await check({ chatId: chat.id, initiatorId, viewerIds: [ownerId, adminId],
      sourceAnswerId: ids[1]!, copiedAnswerId: ids.at(-1)!, userMessageId: ids[0]! });
  } finally {
    if (chatId) await prisma.chat.deleteMany({ where: { id: chatId } });
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

function callFor(messages: ChatDetailRecord["messages"], messageId: string) {
  return messages.find(message => message.id === messageId)?.toolActivity?.calls[0];
}

describe("MCP activity references on persisted chat reads", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("projects original initiator references on personal active and archived details and history pages", async () => {
    await withProjectionFixture(false, async ({ chatId, initiatorId, viewerIds, sourceAnswerId, copiedAnswerId, userMessageId }) => {
      const repository = createPrismaChatRepository(prisma);
      const detail = await repository.getChat({ chatId, userId: initiatorId });
      expect(callFor(detail!.messages, copiedAnswerId)?.details).toEqual(reference);
      const older = await repository.getMessagesPage({ chatId, userId: initiatorId,
        before: detail!.pageInfo.beforeCursor! });
      expect(older.kind).toBe("ok");
      if (older.kind === "ok") expect(callFor(older.page.messages, sourceAnswerId)?.details).toEqual(reference);
      for (const userId of viewerIds) expect(await repository.getChat({ chatId, userId })).toBeNull();
      const update = await createPrismaRunRepository(prisma).getChatUpdateForRun({ chatId,
        userId: initiatorId, userMessageId, assistantMessageId: sourceAnswerId });
      expect(update?.messages.find(message => message.id === sourceAnswerId)?.toolActivity?.calls[0]?.details).toEqual(reference);

      expect(await repository.archiveChat({ chatId, userId: initiatorId })).toBe(true);
      const archived = await repository.getArchivedChat({ chatId, userId: initiatorId });
      expect(callFor(archived!.messages, copiedAnswerId)?.details).toEqual(reference);
      const archivedOlder = await repository.getArchivedMessagesPage({ chatId, userId: initiatorId,
        before: archived!.pageInfo.beforeCursor! });
      expect(archivedOlder.kind).toBe("ok");
      if (archivedOlder.kind === "ok") expect(callFor(archivedOlder.page.messages, sourceAnswerId)?.details).toEqual(reference);
      expect(JSON.stringify([detail, older, archived, archivedOlder])).not.toMatch(/privateArgument|privateResult|projection-fixture-fingerprint/);
    });
  });

  it("offers Project details only to the original initiator across copied branches and old pages", async () => {
    await withProjectionFixture(true, async ({ chatId, initiatorId, viewerIds, sourceAnswerId, copiedAnswerId, userMessageId }) => {
      const repository = createPrismaChatRepository(prisma);
      for (const userId of [initiatorId, ...viewerIds]) {
        const detail = await repository.getChat({ chatId, userId });
        expect(detail).not.toBeNull();
        const call = callFor(detail!.messages, copiedAnswerId);
        expect(call).toMatchObject({ origin: "mcp", toolName: "search", serverName: "Projection Tools" });
        const older = await repository.getMessagesPage({ chatId, userId, before: detail!.pageInfo.beforeCursor! });
        expect(older.kind).toBe("ok");
        const update = await createPrismaRunRepository(prisma).getChatUpdateForRun({ chatId, userId,
          userMessageId, assistantMessageId: sourceAnswerId });
        const updateCall = update?.messages.find(message => message.id === sourceAnswerId)?.toolActivity?.calls[0];
        if (userId === initiatorId) {
          expect(call?.details).toEqual(reference);
          expect(updateCall?.details).toEqual(reference);
          if (older.kind === "ok") expect(callFor(older.page.messages, sourceAnswerId)?.details).toEqual(reference);
        } else {
          expect(call).not.toHaveProperty("details");
          expect(updateCall).not.toHaveProperty("details");
          if (older.kind === "ok") expect(callFor(older.page.messages, sourceAnswerId)).not.toHaveProperty("details");
        }
        expect(JSON.stringify([detail, older])).not.toMatch(/privateArgument|privateResult|projection-fixture-fingerprint/);
      }
    });
  });
});
