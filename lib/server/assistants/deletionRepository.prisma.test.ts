import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { decodeProjectDefaults, EMPTY_PROJECT_DEFAULTS } from "../../contracts/projects";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaMemoryCoordinatorRepository } from "../memory/coordinator/prismaRepository";
import type { MemoryJobClaim } from "../memory/coordinator/types";
import { createPrismaMemoryHistoryIndexHandler } from "../memory/history/handler";
import { createPrismaMemoryFactRepository } from "../memory/persistence/facts";
import { memorySha256 } from "../memory/persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../memory/persistence/scopes";
import { applyMemoryScopeTargetDeletion } from "../memory/scopeLifecycle";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../memory/sourceState";
import { MemorySuppressionKeyring } from "../memory/suppressionKeyring";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { CHAT_ASSISTANT_DELETED_MARKER } from "../../contracts/chats";
import { createPrismaAssistantDeletionRepository } from "./deletionRepository";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 71));
const keyring = MemorySuppressionKeyring.parse(
  `current=assistant-delete-v1,assistant-delete-v1=${keyBytes.toString("base64")}`
);

const avatar = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

async function createProject(userId: string, displayName: string, name: string): Promise<string> {
  const created = await createPrismaProjectRepository(prisma).create({
    actorDisplayName: displayName,
    description: "Disposable Assistant deletion fixture",
    name,
    userId
  });
  if (created.kind !== "ok") throw new Error(`assistant_delete_project_fixture_${created.kind}`);
  return created.value.id;
}

async function mutateMemorySource(
  userId: string,
  chatId: string,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">
) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("assistant_delete_history_chat_missing");
    return applyMemorySourceMutations(tx, { ...input, chat, hooks: defaultMemorySourceMutationHooks });
  });
}

/** Claims and commits the newest history job the way the coordinator does. */
async function indexMemoryHistory(userId: string): Promise<void> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
  });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, state: "CLAIMED" },
    where: { id: job.id }
  });
  const claim: MemoryJobClaim = {
    activeLeafMessageId: claimed.activeLeafMessageId,
    attemptCount: claimed.attemptCount,
    branchGeneration: claimed.branchGeneration,
    chatId: claimed.chatId,
    claimToken,
    id: claimed.id,
    idempotencyFingerprint: claimed.idempotencyFingerprint,
    kind: claimed.kind,
    leaseExpiresAt,
    memoryGenerationSnapshot: claimed.memoryGenerationSnapshot,
    memoryRevisionSnapshot: claimed.memoryRevisionSnapshot,
    pipelineVersion: claimed.pipelineVersion,
    recoveredLease: false,
    sourceHash: claimed.sourceHash,
    sourceMessageId: claimed.sourceMessageId,
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId,
    userId: claimed.userId
  };
  const handler = createPrismaMemoryHistoryIndexHandler(prisma);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const now = new Date();
  const result = await handler.execute(claim, {
    now: () => now,
    setStage: async () => undefined,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
}

describe("Prisma Assistant deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("previews and then applies every consequence of deleting a published Project default", async () => {
    const suffix = randomUUID();
    const ownerUserId = `assistant-delete-owner-${suffix}`;
    const consumerUserId = `assistant-delete-consumer-${suffix}`;
    const managerUserId = `assistant-delete-manager-${suffix}`;
    const userIds = [ownerUserId, consumerUserId, managerUserId];
    const projectIds: string[] = [];
    const skillIds: string[] = [];
    const chatIds: string[] = [];
    const outboxId = `assistant-delete-outbox-${suffix}`;
    let assistantId: string | null = null;

    await prisma.user.createMany({
      data: [
        { displayName: "Assistant owner", id: ownerUserId, status: "active" },
        { displayName: "Assistant consumer", id: consumerUserId, status: "active" },
        { displayName: "Other Project manager", id: managerUserId, role: "admin", status: "active" }
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

      const visibleProjectName = `Launch ${suffix}`;
      const visibleProjectId = await createProject(ownerUserId, "Assistant owner", visibleProjectName);
      projectIds.push(visibleProjectId);
      const hiddenProjectId = await createProject(managerUserId, "Other Project manager", `Hidden ${suffix}`);
      projectIds.push(hiddenProjectId);
      await prisma.projectAssistantBinding.createMany({
        data: projectIds.map((projectId) => ({ addedByUserId: ownerUserId, assistantId: assistantId!, projectId }))
      });
      const visibleDefaults = decodeProjectDefaults(
        (await prisma.project.findUniqueOrThrow({ where: { id: visibleProjectId } })).defaults
      );
      await prisma.project.update({
        data: { defaults: { ...(visibleDefaults.ok ? visibleDefaults.defaults : EMPTY_PROJECT_DEFAULTS), assistantId } },
        where: { id: visibleProjectId }
      });
      const policyRevision = (await prisma.project.findUniqueOrThrow({ where: { id: visibleProjectId } })).policyRevision;

      // Bound chats: the owner's with an accepted run, a consumer's, a Project
      // chat, and one awaiting permanent deletion. An earlier-unbound chat
      // keeps its own overrides.
      const ownerChat = `assistant-delete-owner-chat-${suffix}`;
      const consumerChat = `assistant-delete-consumer-chat-${suffix}`;
      const projectChat = `assistant-delete-project-chat-${suffix}`;
      const deletingChat = `assistant-delete-deleting-chat-${suffix}`;
      const unboundChat = `assistant-delete-unbound-chat-${suffix}`;
      chatIds.push(ownerChat, consumerChat, projectChat, deletingChat, unboundChat);
      const runId = `assistant-delete-run-${suffix}`;
      const identity = { avatar, name: "Doomed Assistant" };
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", title, "memoryMode",
            "assistantId", "assistantOverrides", "updatedAt")
          VALUES
            (${ownerChat}, ${ownerUserId}, NULL, NULL, '', 'Owner chat', 'EXCLUDED', ${assistantId}, '{"model":{"value":"x"}}'::jsonb, '2026-01-02 00:00:00'),
            (${consumerChat}, ${consumerUserId}, NULL, NULL, '', 'Consumer chat', 'EXCLUDED', ${assistantId}, NULL, '2026-01-02 00:00:00'),
            (${projectChat}, NULL, ${visibleProjectId}, ${ownerUserId}, 'Assistant owner', 'Project chat', 'EXCLUDED', ${assistantId}, NULL, '2026-01-02 00:00:00'),
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
          INSERT INTO "MemoryDeletionOutbox" (id, "userId", operation, "targetType", "targetId", "memoryGeneration",
            "admissionAuthorizationId", "admittedChatSourceRevision", "alsoForgetOriginMemories", "updatedAt")
          VALUES (${outboxId}, ${ownerUserId}, 'SOURCE_PURGE', 'CHAT@memory-chat-delete-v1', ${deletingChat}, 0,
            ${`${outboxId}-admission`}, 0, false, now())
        `;
        await tx.$executeRaw`
          UPDATE "Chat" SET archived = true, "permanentDeletionAt" = now(), "permanentDeletionOperationId" = ${outboxId},
            "updatedAt" = '2026-01-02 00:00:00'
          WHERE id = ${deletingChat}
        `;
      });

      // Memory of the owner scoped to this Assistant. Its evidence chat goes
      // with the owner account during cleanup, as in the scope lifecycle test.
      const evidenceChat = await prisma.chat.create({ data: { title: "Memory evidence", userId: ownerUserId } });
      const evidenceMessage = await prisma.message.create({
        data: { chatId: evidenceChat.id, content: textMessageContent("Scoped evidence."), role: "user", status: "complete" }
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensure(ownerUserId, { targetId: assistantId, type: "ASSISTANT" });
      const statement = "Prefers terse release notes.";
      await createPrismaMemoryFactRepository(keyring, prisma).save(ownerUserId, {
        evidence: {
          branchGeneration: 0,
          chatId: evidenceChat.id,
          kind: "MESSAGE",
          messageId: evidenceMessage.id,
          observedAt: new Date("2026-08-21T08:00:00.000Z"),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "assistant-delete-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `assistant-delete-${suffix}`,
        requestId: `assistant-delete-request-${suffix}`,
        scopeId: scope.id,
        value: {
          canonicalKey: `assistant.delete.${suffix}`,
          category: "preference",
          confidence: 1,
          directness: "DIRECT",
          displayText: statement,
          importance: 0.8,
          languageCode: "en",
          modality: "PREFERENCE",
          pipelineVersion: "assistant-delete-test-v1",
          secretTaintedSourceWindow: false,
          sensitivityClass: "NORMAL",
          sourceMode: "AUTOMATIC",
          structuredValue: { statement }
        }
      });
      const memoryRows = async () => [
        await prisma.memoryFact.count({ where: { userId: ownerUserId } }),
        await prisma.memoryFactVersion.count({ where: { userId: ownerUserId } })
      ];
      const memoryBefore = await memoryRows();

      await prisma.assistantListingRequest.create({
        data: { assistantId, definitionVersion: 1, requestedByUserId: ownerUserId }
      });
      const version = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;

      const notifyProjectEvent = vi.fn();
      const repository = createPrismaAssistantDeletionRepository(prisma, { notifyProjectEvent });

      await expect(repository.loadConsequences(consumerUserId, assistantId)).resolves.toBeNull();
      await expect(repository.loadConsequences(managerUserId, assistantId)).resolves.toBeNull();
      const consequences = await repository.loadConsequences(ownerUserId, assistantId);
      expect(consequences).toEqual({
        audiences: { groupNames: [group.name], installation: true },
        chatCount: 3,
        hiddenProjectCount: 1,
        pendingListingRequest: true,
        projects: [{ isDefault: true, name: visibleProjectName }],
        version
      });
      expect(JSON.stringify(consequences)).not.toMatch(new RegExp(`${hiddenProjectId}|Hidden|${consumerUserId}`));

      await expect(repository.delete(ownerUserId, assistantId, version - 1)).resolves.toEqual({ kind: "version_conflict" });
      await expect(repository.delete(consumerUserId, assistantId, version)).resolves.toEqual({ kind: "not_found" });
      await expect(repository.delete(managerUserId, assistantId, version)).resolves.toEqual({ kind: "not_found" });
      await expect(prisma.assistantPublication.count({ where: { assistantId } })).resolves.toBe(2);
      expect(notifyProjectEvent).not.toHaveBeenCalled();

      await expect(repository.delete(ownerUserId, assistantId, version)).resolves.toEqual({ kind: "deleted" });
      expect(notifyProjectEvent.mock.calls.map(([projectId]) => projectId).sort()).toEqual([...projectIds].sort());

      await expect(prisma.assistantDefinition.count({ where: { id: assistantId } })).resolves.toBe(0);
      for (const count of [
        prisma.assistantPublication.count({ where: { assistantId } }),
        prisma.assistantListingRequest.count({ where: { assistantId } }),
        prisma.assistantPin.count({ where: { assistantId } }),
        prisma.assistantSkill.count({ where: { assistantId } }),
        prisma.projectAssistantBinding.count({ where: { assistantId } }),
        prisma.chat.count({ where: { assistantId } }),
        prisma.modelRun.count({ where: { assistantId } })
      ]) {
        await expect(count).resolves.toBe(0);
      }

      const chats = await prisma.chat.findMany({
        select: { assistantId: true, assistantOverrides: true, id: true, updatedAt: true },
        where: { id: { in: [ownerChat, consumerChat, projectChat, deletingChat, unboundChat] } }
      });
      expect(Object.fromEntries(chats.map((chat) => [chat.id, chat.assistantOverrides]))).toEqual({
        [ownerChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [consumerChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [projectChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [deletingChat]: CHAT_ASSISTANT_DELETED_MARKER,
        [unboundChat]: { search: { mode: "off" } }
      });
      for (const chat of chats) {
        expect(chat.assistantId).toBeNull();
        expect(chat.updatedAt.toISOString()).toBe(new Date("2026-01-02T00:00:00.000Z").toISOString());
      }
      await expect(prisma.chat.findUniqueOrThrow({ where: { id: deletingChat } })).resolves.toMatchObject({
        permanentDeletionOperationId: outboxId
      });

      await expect(prisma.modelRun.findUniqueOrThrow({
        select: { assistantId: true, assistantIdentity: true },
        where: { id: runId }
      })).resolves.toEqual({ assistantId: null, assistantIdentity: identity });
      await expect(prisma.userSettings.findUniqueOrThrow({ where: { userId: consumerUserId } }))
        .resolves.toMatchObject({ defaultAssistantId: null });

      const visibleProject = await prisma.project.findUniqueOrThrow({ where: { id: visibleProjectId } });
      const defaultsAfter = decodeProjectDefaults(visibleProject.defaults);
      expect(defaultsAfter.ok && defaultsAfter.defaults.assistantId).toBeNull();
      expect(visibleProject.policyRevision).toBe(policyRevision + 1);
      for (const projectId of projectIds) {
        await expect(prisma.projectAuditEvent.findMany({
          select: { actorUserId: true, metadata: true },
          where: { eventType: "resource_owner_revoked", projectId }
        })).resolves.toEqual([{
          actorUserId: ownerUserId,
          metadata: expect.objectContaining({
            clearedDefaultCount: projectId === visibleProjectId ? 1 : 0,
            resourceType: "assistant"
          })
        }]);
        await expect(prisma.projectEvent.count({ where: { eventType: "resource_owner_revoked", projectId } }))
          .resolves.toBe(1);
      }

      await expect(prisma.memoryScope.findUniqueOrThrow({
        select: { assistantId: true, state: true },
        where: { id: scope.id }
      })).resolves.toEqual({ assistantId: null, state: "ORPHANED" });
      await expect(memoryRows()).resolves.toEqual(memoryBefore);

      await expect(repository.delete(ownerUserId, assistantId, version)).resolves.toEqual({ kind: "not_found" });
      await expect(repository.loadConsequences(ownerUserId, assistantId)).resolves.toBeNull();
      assistantId = null;
    } finally {
      if (assistantId) {
        const id = assistantId;
        await prisma.$transaction((tx) => applyMemoryScopeTargetDeletion(tx, {
          scopeType: "ASSISTANT", targetId: id, userId: ownerUserId
        }));
        await prisma.assistantListingRequest.deleteMany({ where: { assistantId: id } });
        await prisma.assistantPublication.deleteMany({ where: { assistantId: id } });
        await prisma.projectAssistantBinding.deleteMany({ where: { assistantId: id } });
        await prisma.assistantPin.deleteMany({ where: { assistantId: id } });
        await prisma.assistantSkill.deleteMany({ where: { assistantId: id } });
        await prisma.assistantDefinition.deleteMany({ where: { id } });
      }
      await prisma.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
      await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
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

  it("detaches Memory history of every kind while keeping its owner and content", async () => {
    const userId = `assistant-delete-history-${randomUUID()}`;
    let assistantId: string | null = null;
    await prisma.user.create({
      data: { displayName: "Assistant history owner", email: `${userId}@example.test`, id: userId, status: "active" }
    });
    await prisma.userMemorySettings.update({
      data: { learnAutomatically: false, referenceChatHistory: true },
      where: { userId }
    });

    try {
      const assistant = await prisma.assistantDefinition.create({
        data: {
          avatar,
          name: "Remembered Assistant",
          ownerUserId: userId,
          providerModelId: providerTemplateIds.fakeModel,
          searchPlan: { mode: "off" },
          systemPrompt: "Answer directly."
        }
      });
      assistantId = assistant.id;

      // One settled turn answered by the owned Assistant. Indexing attributes
      // its chunk and round to the Assistant that answered.
      const chat = await prisma.chat.create({ data: { assistantId, title: "Assistant history", userId } });
      const askedAt = new Date("2026-08-13T10:00:00.000Z");
      const answeredAt = new Date(askedAt.getTime() + 1_000);
      const question = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Compare the cedar and birch deployment options."),
          createdAt: askedAt,
          role: "user",
          status: "complete",
          updatedAt: askedAt
        }
      });
      const answer = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Cedar was selected for deployment."),
          createdAt: answeredAt,
          modelId: "history-test-model",
          parentMessageId: question.id,
          provider: "history-test-provider",
          role: "assistant",
          status: "complete",
          updatedAt: answeredAt
        }
      });
      const run = await prisma.modelRun.create({
        data: {
          assistantId,
          assistantIdentity: { avatar, name: "Remembered Assistant" },
          assistantMessageId: answer.id,
          chatId: chat.id,
          modelId: "history-test-model",
          normalizedRequest: {
            prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } }
          },
          provider: "history-test-provider",
          status: "complete",
          userId,
          userMessageId: question.id
        }
      });
      await mutateMemorySource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: answer.id }
      });
      await mutateMemorySource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: { assistantMessageId: answer.id, runId: run.id, status: "complete" }
      });
      await indexMemoryHistory(userId);

      const historyRows = async () => ({
        chunks: await prisma.memoryRecallChunk.findMany({ orderBy: { id: "asc" }, where: { chatId: chat.id, userId } }),
        rounds: await prisma.memoryRecallRound.findMany({ orderBy: { id: "asc" }, where: { chatId: chat.id, userId } })
      });
      const before = await historyRows();
      for (const rows of [before.chunks, before.rounds]) {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row).toMatchObject({ sourceAssistantId: assistantId, state: "ACTIVE", userId });
      }

      const repository = createPrismaAssistantDeletionRepository(prisma, { notifyProjectEvent: vi.fn() });
      await expect(repository.delete(userId, assistantId, assistant.version)).resolves.toEqual({ kind: "deleted" });

      // Every deferred Memory source guard ran at commit on the detached rows;
      // only the attribution changed.
      const detached = <T extends { sourceAssistantId: string | null }>(rows: readonly T[]) =>
        rows.map((row) => ({ ...row, sourceAssistantId: null }));
      await expect(historyRows()).resolves.toEqual({
        chunks: detached(before.chunks),
        rounds: detached(before.rounds)
      });
      await expect(prisma.chat.findUniqueOrThrow({
        select: { assistantId: true, assistantOverrides: true },
        where: { id: chat.id }
      })).resolves.toEqual({ assistantId: null, assistantOverrides: CHAT_ASSISTANT_DELETED_MARKER });
      await expect(prisma.modelRun.findUniqueOrThrow({ select: { assistantId: true }, where: { id: run.id } }))
        .resolves.toEqual({ assistantId: null });
      assistantId = null;
    } finally {
      if (assistantId) {
        await prisma.chat.deleteMany({ where: { userId } });
        await prisma.assistantDefinition.deleteMany({ where: { id: assistantId } });
      }
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
