import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  type MemoryScopeSelection
} from "../../contracts/memory";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaAssistantRepository } from "../assistants/prismaRepository";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaExplicitMemoryRepository } from "./explicit/repository";
import { createExplicitMemoryService } from "./explicit/service";
import { createPrismaMemoryLifecycleRepository } from "./lifecycle/repository";
import { createMemoryLifecycleService } from "./lifecycle/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "./persistence/authorizations";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactValueInput
} from "./persistence/facts";
import { memorySha256 } from "./persistence/lexical";
import { createPrismaMemoryScopeRepository } from "./persistence/scopes";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "./purge/contract";
import { registerMemoryDeletionContributors } from "./purge/leaves";
import { MemoryDeletionContributorRegistry } from "./purge/registry";
import { MemorySuppressionKeyring } from "./suppressionKeyring";
import { defaultMemorySourceMutationHooks } from "./sourceHooks";
import { applyMemoryScopedTargetOwnerLifecycle } from "./sourceState";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 113));
const keyring = MemorySuppressionKeyring.parse(
  `current=scopes-v1,scopes-v1=${keyBytes.toString("base64")}`
);

function purgeRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Memory scopes ${label}`,
      email: `memory-scopes-${label}-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function createAssistant(ownerUserId: string, name: string, published: boolean) {
  const definition = await prisma.assistantDefinition.create({
    data: { ownerUserId }
  });
  const revision = await prisma.assistantRevision.create({
    data: {
      assistantId: definition.id,
      authorUserId: ownerUserId,
      avatar: {},
      description: "",
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      name,
      providerModelId: providerTemplateIds.fakeModel,
      revisionNumber: 1,
      runControls: {},
      searchPlan: { mode: "disabled", optionIds: [] },
      starterPrompts: [],
      systemPrompt: "Scoped Memory test"
    }
  });
  await prisma.assistantDefinition.update({
    data: { currentRevisionId: revision.id },
    where: { id: definition.id }
  });
  if (published) {
    await prisma.assistantPublication.create({
      data: {
        assistantId: definition.id,
        publishedByUserId: ownerUserId,
        revisionId: revision.id,
        scope: "installation"
      }
    });
  }
  return { ...definition, revisionId: revision.id };
}

async function cleanup(userIds: readonly string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
    await tx.memoryOperationReceipt.deleteMany({ where: { userId: { in: [...userIds] } } });
    await tx.memoryMutationAuthorization.deleteMany({
      where: { userId: { in: [...userIds] } }
    });
    await tx.memorySearchEntry.deleteMany({ where: { userId: { in: [...userIds] } } });
    await tx.memoryEvidence.deleteMany({ where: { userId: { in: [...userIds] } } });
    await tx.$executeRaw(Prisma.sql`
      WITH deleted_events AS (
        DELETE FROM "MemoryEvent"
        WHERE "userId" IN (${Prisma.join(userIds)})
        RETURNING "id"
      ), deleted_versions AS (
        DELETE FROM "MemoryFactVersion"
        WHERE "userId" IN (${Prisma.join(userIds)})
        RETURNING "id"
      ), deleted_facts AS (
        DELETE FROM "MemoryFact"
        WHERE "userId" IN (${Prisma.join(userIds)})
        RETURNING "id"
      )
      DELETE FROM "MemoryScope"
      WHERE "userId" IN (${Prisma.join(userIds)})
    `);
  });
  const temporaryChats = await prisma.chat.findMany({
    select: { id: true, userId: true },
    where: {
      memoryMode: "TEMPORARY",
      userId: { in: [...userIds] }
    }
  });
  if (temporaryChats.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
      for (const chat of temporaryChats) {
        if (!chat.userId) throw new Error("temporary_chat_owner_missing");
        const leaseToken = `scope-cleanup-${randomUUID()}`;
        await tx.memoryDeletionOutbox.upsert({
          create: {
            attemptCount: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000),
            leaseToken,
            memoryGeneration: 0,
            operation: "TEMPORARY_DELETE",
            state: "RUNNING",
            targetId: chat.id,
            targetType: `TEMPORARY_CHAT@${MEMORY_TEMPORARY_RETENTION_POLICY_VERSION}`,
            userId: chat.userId
          },
          update: {
            leaseExpiresAt: new Date(Date.now() + 60_000),
            leaseToken,
            state: "RUNNING"
          },
          where: {
            userId_operation_targetType_targetId_memoryGeneration: {
              memoryGeneration: 0,
              operation: "TEMPORARY_DELETE",
              targetId: chat.id,
              targetType: `TEMPORARY_CHAT@${MEMORY_TEMPORARY_RETENTION_POLICY_VERSION}`,
              userId: chat.userId
            }
          }
        });
        await tx.chat.delete({ where: { id: chat.id } });
      }
    });
  }
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: [...userIds] } } });
  const definitions = await prisma.assistantDefinition.findMany({
    select: { id: true },
    where: { ownerUserId: { in: [...userIds] } }
  });
  const assistantIds = definitions.map(({ id }) => id);
  if (assistantIds.length > 0) {
    await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.assistantPin.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.assistantDefinition.updateMany({
      data: { currentRevisionId: null },
      where: { id: { in: assistantIds } }
    });
    await prisma.assistantRevision.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
}

function services() {
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const factRepository = createPrismaMemoryFactRepository(keyring, prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository,
    factRepository,
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    mutationRepository: createPrismaMemoryLifecycleRepository(
      keyring,
      purgeRegistry(),
      prisma
    ),
    readRepository
  });
  return { explicit, factRepository, lifecycle };
}

async function saveExplicit(
  explicit: ReturnType<typeof services>["explicit"],
  userId: string,
  statement: string,
  scope: MemoryScopeSelection
) {
  const authorization = await explicit.mintAuthorization(userId, {
    action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement),
    requestNonce: randomUUID()
  });
  return explicit.create(userId, {
    mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope,
    statement
  });
}

function automaticValue(statement: string): MemoryFactValueInput {
  return {
    canonicalKey: "automatic.scoped.target",
    category: "preference",
    confidence: 0.9,
    directness: "DIRECT",
    displayText: statement,
    importance: 0.8,
    languageCode: "en",
    modality: "PREFERENCE",
    pipelineVersion: "memory-scope-test-v1",
    secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL",
    sourceMode: "AUTOMATIC",
    structuredValue: { statement }
  };
}

describe("Memory scoped-target lifecycle", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("authorizes exact targets, pauses Assistant scope, tombstones deletion, and moves or forgets orphans", async () => {
    const ownerId = await createUser("owner");
    const foreignId = await createUser("foreign");
    const ownerAssistant = await createAssistant(ownerId, "Owner Assistant", false);
    const foreignAssistant = await createAssistant(foreignId, "Published foreign", true);
    const memory = services();
    try {
      const folder = await prisma.folder.create({
        data: { name: "Scoped folder", userId: ownerId }
      });
      const sourceChat = await prisma.chat.create({
        data: { title: "Evidence source", userId: ownerId }
      });
      const targetChat = await prisma.chat.create({
        data: { title: "Move target", userId: ownerId }
      });
      const temporaryChat = await prisma.$transaction(async (tx) => {
        const deadline = new Date(Date.now() + 86_400_000);
        const chat = await tx.chat.create({
          data: {
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: deadline,
            temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
            title: "Temporary",
            userId: ownerId
          }
        });
        await tx.memoryDeletionOutbox.create({
          data: {
            memoryGeneration: 0,
            nextAttemptAt: deadline,
            operation: "TEMPORARY_DELETE",
            targetId: chat.id,
            targetType: `TEMPORARY_CHAT@${MEMORY_TEMPORARY_RETENTION_POLICY_VERSION}`,
            userId: ownerId
          }
        });
        return chat;
      });
      const sourceMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: textMessageContent("Scoped evidence"),
          role: "user",
          status: "complete"
        }
      });

      const folderMoved = await saveExplicit(
        memory.explicit,
        ownerId,
        "Use the folder deployment preference.",
        { targetId: folder.id, type: "FOLDER" }
      );
      const folderForgotten = await saveExplicit(
        memory.explicit,
        ownerId,
        "Forget this orphan after target deletion.",
        { targetId: folder.id, type: "FOLDER" }
      );
      const conflictSource = await saveExplicit(
        memory.explicit,
        ownerId,
        "Move conflict initial preference.",
        { targetId: folder.id, type: "FOLDER" }
      );
      const conflictTarget = await saveExplicit(
        memory.explicit,
        ownerId,
        "Move conflict initial preference.",
        { targetId: targetChat.id, type: "CHAT" }
      );
      const conflictEditAuthorization = await memory.explicit.mintAuthorization(ownerId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: conflictTarget.memory.currentVersionId!,
        requestNonce: randomUUID(),
        targetFactId: conflictTarget.memory.id
      });
      await memory.explicit.update(ownerId, conflictTarget.memory.id, {
        expectedVersionId: conflictTarget.memory.currentVersionId!,
        mutationAuthorizationId: conflictEditAuthorization.mutationAuthorizationId,
        statement: "A different target value must not be overwritten."
      });
      const assistantFact = await saveExplicit(
        memory.explicit,
        ownerId,
        "Use concise answers with this Assistant.",
        { targetId: ownerAssistant.id, type: "ASSISTANT" }
      );
      const folderScope = await createPrismaMemoryScopeRepository(prisma).ensure(ownerId, {
        targetId: folder.id,
        type: "FOLDER"
      });
      const automatic = await memory.factRepository.save(ownerId, {
        evidence: {
          branchGeneration: 0,
          chatId: sourceChat.id,
          kind: "MESSAGE",
          messageId: sourceMessage.id,
          observedAt: new Date(),
          safeExcerpt: "Scoped evidence",
          safeSourceHash: memorySha256("Scoped evidence"),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-scope-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: randomUUID(),
        requestId: randomUUID(),
        scopeId: folderScope.id,
        value: automaticValue("Automatically learned folder preference.")
      });

      await expect(memory.explicit.search(ownerId, {
        query: "deployment",
        scope: { targetId: folder.id, type: "FOLDER" }
      })).resolves.toMatchObject({ memories: [{ id: folderMoved.memory.id }] });
      await expect(memory.explicit.search(ownerId, {
        query: "concise",
        scope: { targetId: ownerAssistant.id, type: "ASSISTANT" }
      })).resolves.toMatchObject({ memories: [{ id: assistantFact.memory.id }] });

      const archivedFrom = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: ownerId }
      });
      const assistants = createPrismaAssistantRepository(prisma);
      await expect(assistants.setArchived(ownerId, ownerAssistant.id, 1, true))
        .resolves.toMatchObject({ kind: "ok" });
      await expect(memory.explicit.search(ownerId, {
        query: "concise",
        scope: { targetId: ownerAssistant.id, type: "ASSISTANT" }
      })).resolves.toEqual({ memories: [], nextCursor: null });
      await expect(assistants.setArchived(ownerId, ownerAssistant.id, 2, false))
        .resolves.toMatchObject({ kind: "ok" });
      await expect(memory.explicit.search(ownerId, {
        query: "concise",
        scope: { targetId: ownerAssistant.id, type: "ASSISTANT" }
      })).resolves.toMatchObject({ memories: [{ id: assistantFact.memory.id }] });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: ownerId }
      })).resolves.toMatchObject({ memoryRevision: archivedFrom.memoryRevision + 2 });

      const racedStatement = "Serialize this Assistant scope against archive.";
      const racedAuthorization = await memory.explicit.mintAuthorization(ownerId, {
        action: "SAVE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: memorySha256(racedStatement),
        requestNonce: randomUUID()
      });
      const [racedCreate, racedArchive] = await Promise.allSettled([
        memory.explicit.create(ownerId, {
          mutationAuthorizationId: racedAuthorization.mutationAuthorizationId,
          scope: { targetId: ownerAssistant.id, type: "ASSISTANT" },
          statement: racedStatement
        }),
        assistants.setArchived(ownerId, ownerAssistant.id, 3, true)
      ]);
      expect(racedArchive).toMatchObject({
        status: "fulfilled",
        value: { kind: "ok" }
      });
      expect(["fulfilled", "rejected"]).toContain(racedCreate.status);
      if (racedCreate.status === "rejected") {
        expect(racedCreate.reason).toMatchObject({ code: "memory_scope_unavailable" });
      }
      await expect(memory.explicit.search(ownerId, {
        query: "Serialize",
        scope: { targetId: ownerAssistant.id, type: "ASSISTANT" }
      })).resolves.toEqual({ memories: [], nextCursor: null });

      const racedFolder = await prisma.folder.create({
        data: { name: "Concurrent scoped folder", userId: ownerId }
      });
      const racedFolderStatement = "Serialize this Folder scope against deletion.";
      const racedFolderAuthorization = await memory.explicit.mintAuthorization(ownerId, {
        action: "SAVE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactStatementHash: memorySha256(racedFolderStatement),
        requestNonce: randomUUID()
      });
      const [racedFolderCreate, racedFolderDelete] = await Promise.allSettled([
        memory.explicit.create(ownerId, {
          mutationAuthorizationId: racedFolderAuthorization.mutationAuthorizationId,
          scope: { targetId: racedFolder.id, type: "FOLDER" },
          statement: racedFolderStatement
        }),
        createPrismaChatRepository(prisma).deleteFolder({
          folderId: racedFolder.id,
          userId: ownerId
        })
      ]);
      expect(racedFolderDelete).toMatchObject({ status: "fulfilled", value: true });
      if (racedFolderCreate.status === "rejected") {
        expect(racedFolderCreate.reason).toMatchObject({ code: "memory_scope_unavailable" });
      }

      for (const [selection, statement] of [
        [
          { targetId: foreignAssistant.id, type: "ASSISTANT" as const },
          "Reject a published foreign Assistant scope."
        ],
        [
          { targetId: temporaryChat.id, type: "CHAT" as const },
          "Reject a Temporary chat scope."
        ]
      ] as const) {
        const authorization = await memory.explicit.mintAuthorization(ownerId, {
          action: "SAVE",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          exactStatementHash: memorySha256(statement),
          requestNonce: randomUUID()
        });
        await expect(memory.explicit.create(ownerId, {
          mutationAuthorizationId: authorization.mutationAuthorizationId,
          scope: selection,
          statement
        })).rejects.toMatchObject({ code: "memory_scope_unavailable" });
        await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
          where: { id: authorization.mutationAuthorizationId }
        })).resolves.toMatchObject({ consumedAt: null });
      }

      await expect(createPrismaChatRepository(prisma).deleteFolder({
        folderId: folder.id,
        userId: ownerId
      })).resolves.toBe(true);
      const orphanedScope = await prisma.memoryScope.findUniqueOrThrow({
        where: { id: folderScope.id }
      });
      expect(orphanedScope).toMatchObject({
        folderId: null,
        state: "ORPHANED",
        targetIdSnapshot: folder.id
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: folderMoved.memory.id }
      })).resolves.toMatchObject({ currentVersionId: null, state: "ORPHANED" });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: automatic.factId }
      })).resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
      await expect(memory.explicit.list(ownerId, {
        scope: { targetId: folder.id, type: "FOLDER" },
        state: "ORPHANED"
      })).resolves.toMatchObject({
        memories: expect.arrayContaining([
          expect.objectContaining({
            actionVersionId: folderMoved.memory.currentVersionId,
            currentVersionId: null,
            displayText: "Use the folder deployment preference.",
            id: folderMoved.memory.id,
            versionState: "ORPHANED"
          })
        ])
      });

      const conflictMoveAuthorization = await memory.explicit.mintAuthorization(ownerId, {
        action: "MOVE_SCOPE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: conflictSource.memory.currentVersionId!,
        requestNonce: randomUUID(),
        targetFactId: conflictSource.memory.id
      });
      await expect(memory.explicit.update(ownerId, conflictSource.memory.id, {
        expectedVersionId: conflictSource.memory.currentVersionId!,
        mutationAuthorizationId: conflictMoveAuthorization.mutationAuthorizationId,
        scope: { targetId: targetChat.id, type: "CHAT" }
      })).rejects.toMatchObject({ code: "memory_action_failed" });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: conflictSource.memory.id }
      })).resolves.toMatchObject({ movedToFactId: null, state: "ORPHANED" });
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: conflictMoveAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });

      const moveAuthorization = await memory.explicit.mintAuthorization(ownerId, {
        action: "MOVE_SCOPE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: folderMoved.memory.currentVersionId!,
        requestNonce: randomUUID(),
        targetFactId: folderMoved.memory.id
      });
      const moved = await memory.explicit.update(ownerId, folderMoved.memory.id, {
        expectedVersionId: folderMoved.memory.currentVersionId!,
        mutationAuthorizationId: moveAuthorization.mutationAuthorizationId,
        scope: { targetId: targetChat.id, type: "CHAT" }
      });
      expect(moved.memory).toMatchObject({
        scope: { targetId: targetChat.id, type: "CHAT" },
        versionState: "ACTIVE"
      });
      await expect(memory.explicit.update(ownerId, folderMoved.memory.id, {
        expectedVersionId: folderMoved.memory.currentVersionId!,
        mutationAuthorizationId: moveAuthorization.mutationAuthorizationId,
        scope: { targetId: targetChat.id, type: "CHAT" }
      })).resolves.toEqual(moved);
      const [oldFact, oldVersion, movedVersion] = await Promise.all([
        prisma.memoryFact.findUniqueOrThrow({ where: { id: folderMoved.memory.id } }),
        prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: folderMoved.memory.currentVersionId! }
        }),
        prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: moved.memory.currentVersionId! }
        })
      ]);
      expect(oldFact).toMatchObject({
        movedToFactId: moved.memory.id,
        scopeId: folderScope.id,
        state: "RETRACTED"
      });
      expect(oldVersion).toMatchObject({ state: "RETRACTED" });
      expect(movedVersion).toMatchObject({
        movedFromVersionId: folderMoved.memory.currentVersionId
      });

      await prisma.$transaction((tx) => applyMemoryScopedTargetOwnerLifecycle(
        tx,
        defaultMemorySourceMutationHooks,
        {
          kind: "CHAT_DELETE",
          sourceSnapshots: [],
          targetId: targetChat.id,
          userId: ownerId
        }
      ));
      await prisma.chat.delete({ where: { id: targetChat.id } });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: moved.memory.id }
      })).resolves.toMatchObject({ currentVersionId: null, state: "ORPHANED" });

      const forgetAuthorization = await memory.explicit.mintAuthorization(ownerId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: folderForgotten.memory.currentVersionId!,
        requestNonce: randomUUID(),
        targetFactId: folderForgotten.memory.id
      });
      await expect(memory.lifecycle.forget(ownerId, folderForgotten.memory.id, {
        expectedVersionId: folderForgotten.memory.currentVersionId!,
        mutationAuthorizationId: forgetAuthorization.mutationAuthorizationId
      })).resolves.toMatchObject({
        memory: { factState: "FORGOTTEN", id: folderForgotten.memory.id }
      });
    } finally {
      await cleanup([ownerId, foreignId]);
    }
  });
});
