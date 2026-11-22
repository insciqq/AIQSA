import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { CHAT_ASSISTANT_DELETED_MARKER } from "../../contracts/chats";
import { createPrismaAssistantDeletionRepository } from "./deletionRepository";

const avatar = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

describe("Prisma Assistant deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("previews and then applies every consequence of deleting a published Assistant", async () => {
    const suffix = randomUUID();
    const ownerUserId = `assistant-delete-owner-${suffix}`;
    const consumerUserId = `assistant-delete-consumer-${suffix}`;
    const managerUserId = `assistant-delete-manager-${suffix}`;
    const userIds = [ownerUserId, consumerUserId, managerUserId];
    const skillIds: string[] = [];
    const chatIds: string[] = [];
    // A chat fenced for permanent deletion carries an opaque operation id.
    const deletionOperationId = `assistant-delete-operation-${suffix}`;
    let assistantId: string | null = null;

    await prisma.user.createMany({
      data: [
        { displayName: "Assistant owner", id: ownerUserId, status: "active" },
        { displayName: "Assistant consumer", id: consumerUserId, status: "active" },
        { displayName: "Administrator", id: managerUserId, role: "admin", status: "active" }
      ]
    });
    const group = await prisma.group.create({ data: { name: `Assistant delete group ${suffix}` } });
    await prisma.userGroup.create({ data: { groupId: group.id, userId: ownerUserId } });

    try {
      const assistant = await prisma.assistantDefinition.create({
        data: {
          avatar,
          name: "Doomed Assistant",
          ownerUserId,
          providerModelId: providerTemplateIds.fakeModel,
          searchPlan: { mode: "off" },
          systemPrompt: "Answer directly."
        }
      });
      assistantId = assistant.id;
      const skillId = await createPrismaSkillRepository(prisma).create(ownerUserId, {
        description: "Closes with actions.",
        instructions: "End with a short action list.",
        name: "Action closer"
      });
      skillIds.push(skillId);
      await prisma.assistantSkill.create({ data: { assistantId, ordinal: 0, skillId } });
      await prisma.assistantPublication.createMany({
        data: [
          { assistantId, groupId: group.id, publishedByUserId: ownerUserId, scope: "group" },
          { assistantId, publishedByUserId: managerUserId, scope: "installation" }
        ]
      });
      await prisma.assistantPin.createMany({
        data: [{ assistantId, userId: ownerUserId }, { assistantId, userId: consumerUserId }]
      });
      await prisma.userSettings.upsert({
        create: { defaultAssistantId: assistantId, userId: consumerUserId },
        update: { defaultAssistantId: assistantId },
        where: { userId: consumerUserId }
      });

      // Bound chats: the owner's with an accepted run, a consumer's, and one
      // awaiting permanent deletion. An earlier-unbound chat keeps its own
      // overrides.
      const ownerChat = `assistant-delete-owner-chat-${suffix}`;
      const consumerChat = `assistant-delete-consumer-chat-${suffix}`;
      const deletingChat = `assistant-delete-deleting-chat-${suffix}`;
      const unboundChat = `assistant-delete-unbound-chat-${suffix}`;
      chatIds.push(ownerChat, consumerChat, deletingChat, unboundChat);
      const runId = `assistant-delete-run-${suffix}`;
      const identity = { avatar, name: "Doomed Assistant" };
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", title, "memoryMode",
            "assistantId", "assistantOverrides", "updatedAt")
          VALUES
            (${ownerChat}, ${ownerUserId}, NULL, NULL, '', 'Owner chat', 'EXCLUDED', ${assistantId}, '{"model":{"value":"x"}}'::jsonb, '2026-01-02 00:00:00'),
            (${consumerChat}, ${consumerUserId}, NULL, NULL, '', 'Consumer chat', 'EXCLUDED', ${assistantId}, NULL, '2026-01-02 00:00:00'),
            (${deletingChat}, ${ownerUserId}, NULL, NULL, '', 'Deleting chat', 'EXCLUDED', ${assistantId}, NULL, '2026-01-02 00:00:00'),
            (${unboundChat}, ${ownerUserId}, NULL, NULL, '', 'Removed earlier', 'EXCLUDED', NULL, '{"search":{"mode":"off"}}'::jsonb, '2026-01-02 00:00:00')
        `;
        await tx.$executeRaw`
          INSERT INTO "Message" (id, "chatId", role, content, status, "updatedAt")
          VALUES (${`${runId}-question`}, ${ownerChat}, 'user', '{"blocks":[]}'::jsonb, 'complete', now())
        `;
        await tx.$executeRaw`
          INSERT INTO "Message" (id, "chatId", "parentMessageId", role, content, status, "updatedAt")
          VALUES (${`${runId}-answer`}, ${ownerChat}, ${`${runId}-question`}, 'assistant', '{"blocks":[]}'::jsonb, 'complete', now())
        `;
        await tx.$executeRaw`
          INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", "assistantId", "assistantIdentity",
            provider, "modelId", status, "normalizedRequest", "updatedAt")
          VALUES (${runId}, ${ownerChat}, ${ownerUserId}, ${`${runId}-question`}, ${`${runId}-answer`}, ${assistantId},
            ${JSON.stringify(identity)}::jsonb, 'fake', 'fixture', 'complete', '{"prompt":{"system":"Accepted instructions"}}'::jsonb, now())
        `;
        await tx.$executeRaw`
          UPDATE "Chat" SET archived = true, "permanentDeletionAt" = now(), "permanentDeletionOperationId" = ${deletionOperationId},
            "updatedAt" = '2026-01-02 00:00:00'
          WHERE id = ${deletingChat}
        `;
      });

      await prisma.assistantListingRequest.create({
        data: { assistantId, definitionVersion: 1, requestedByUserId: ownerUserId }
      });
      const version = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;

      const repository = createPrismaAssistantDeletionRepository(prisma);

      await expect(repository.loadConsequences(consumerUserId, assistantId)).resolves.toBeNull();
      await expect(repository.loadConsequences(managerUserId, assistantId)).resolves.toBeNull();
      const consequences = await repository.loadConsequences(ownerUserId, assistantId);
      expect(consequences).toEqual({
        audiences: { groupNames: [group.name], installation: true },
        chatCount: 2,
        pendingListingRequest: true,
        version
      });
      expect(JSON.stringify(consequences)).not.toMatch(new RegExp(consumerUserId));

      await expect(repository.delete(ownerUserId, assistantId, version - 1)).resolves.toEqual({ kind: "version_conflict" });
      await expect(repository.delete(consumerUserId, assistantId, version)).resolves.toEqual({ kind: "not_found" });
      await expect(repository.delete(managerUserId, assistantId, version)).resolves.toEqual({ kind: "not_found" });
      await expect(prisma.assistantPublication.count({ where: { assistantId } })).resolves.toBe(2);

      await expect(repository.delete(ownerUserId, assistantId, version)).resolves.toEqual({ kind: "deleted" });

      await expect(prisma.assistantDefinition.count({ where: { id: assistantId } })).resolves.toBe(0);
      for (const count of [
        prisma.assistantPublication.count({ where: { assistantId } }),
        prisma.assistantListingRequest.count({ where: { assistantId } }),
        prisma.assistantPin.count({ where: { assistantId } }),
        prisma.assistantSkill.count({ where: { assistantId } }),
        prisma.chat.count({ where: { assistantId } }),
        prisma.modelRun.count({ where: { assistantId } })
      ]) {
        await expect(count).resolves.toBe(0);
      }

      const chats = await prisma.chat.findMany({
        select: { assistantId: true, assistantOverrides: true, id: true, updatedAt: true },
        where: { id: { in: [ownerChat, consumerChat, deletingChat, unboundChat] } }
      });
      expect(Object.fromEntries(chats.map((chat) => [chat.id, chat.assistantOverrides]))).toEqual({
        [ownerChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [consumerChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [deletingChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [unboundChat]: { search: { mode: "off" } }
      });
      for (const chat of chats) {
        expect(chat.assistantId).toBeNull();
        expect(chat.updatedAt.toISOString()).toBe(new Date("2026-01-02T00:00:00.000Z").toISOString());
      }
      await expect(prisma.chat.findUniqueOrThrow({ where: { id: deletingChat } })).resolves.toMatchObject({
        permanentDeletionOperationId: deletionOperationId
      });

      await expect(prisma.modelRun.findUniqueOrThrow({
        select: { assistantId: true, assistantIdentity: true },
        where: { id: runId }
      })).resolves.toEqual({ assistantId: null, assistantIdentity: identity });
      await expect(prisma.userSettings.findUniqueOrThrow({ where: { userId: consumerUserId } }))
        .resolves.toMatchObject({ defaultAssistantId: null });

      await expect(repository.delete(ownerUserId, assistantId, version)).resolves.toEqual({ kind: "not_found" });
      await expect(repository.loadConsequences(ownerUserId, assistantId)).resolves.toBeNull();
      assistantId = null;
    } finally {
      if (assistantId) {
        const id = assistantId;
        await prisma.assistantListingRequest.deleteMany({ where: { assistantId: id } });
        await prisma.assistantPublication.deleteMany({ where: { assistantId: id } });
        await prisma.assistantPin.deleteMany({ where: { assistantId: id } });
        await prisma.assistantSkill.deleteMany({ where: { assistantId: id } });
        await prisma.assistantDefinition.deleteMany({ where: { id } });
      }
      await prisma.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
      await prisma.skillDefinition.updateMany({
        data: { currentRevisionId: null, sharedRevisionId: null },
        where: { id: { in: skillIds } }
      });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.group.deleteMany({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
});
