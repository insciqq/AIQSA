import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  applyMemoryScopedTargetOwnerLifecycle,
  applyMemorySourceMutations,
  type LockedMemorySourceChat
} from "../../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../../memory/sourceHooks";
import { lockMemorySettings } from "../../memory/persistence/transaction";
import { consumeMemoryMutationAuthorization } from "../../memory/persistence/authorizations";
import { memoryPersistenceFailure } from "../../memory/persistence/errors";
import { PERMANENT_CHAT_DELETION_TARGET_TYPE } from "./contract";
import type {
  PermanentChatDeletionAdmission,
  PermanentChatDeletionRepository
} from "./service";

const activeRunStatuses = [
  "preparing",
  "queued",
  "streaming",
  "in_progress"
] as const;

type LockedPermanentDeleteChat = LockedMemorySourceChat & Readonly<{
  permanentDeletionAt: Date | null;
  permanentDeletionOperationId: string | null;
}>;

type ReplayInput = Readonly<{
  alsoForgetOriginMemories: boolean;
  authorizationId: string;
  chatId: string;
  expectedActiveLeafMessageId: string | null;
  expectedChatRevision: number;
  userId: string;
}>;

async function replayDeletion(
  tx: Prisma.TransactionClient,
  input: ReplayInput
): Promise<PermanentChatDeletionAdmission | null> {
  const row = await tx.memoryDeletionOutbox.findUnique({
    select: {
      admittedActiveLeafMessageId: true,
      admittedChatSourceRevision: true,
      alsoForgetOriginMemories: true,
      createdAt: true,
      id: true,
      operation: true,
      state: true,
      targetId: true,
      targetType: true,
      userId: true
    },
    where: { admissionAuthorizationId: input.authorizationId }
  });
  if (!row) return null;
  if (
    row.userId !== input.userId ||
    row.operation !== "SOURCE_PURGE" ||
    row.targetType !== PERMANENT_CHAT_DELETION_TARGET_TYPE ||
    row.targetId !== input.chatId ||
    row.admittedChatSourceRevision !== input.expectedChatRevision ||
    row.admittedActiveLeafMessageId !== input.expectedActiveLeafMessageId ||
    row.alsoForgetOriginMemories !== input.alsoForgetOriginMemories
  ) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
  return {
    deletionId: row.id,
    fencedAt: row.createdAt,
    state: row.state
  };
}

async function lockChat(
  tx: Prisma.TransactionClient,
  chatId: string,
  userId: string
): Promise<LockedPermanentDeleteChat | null> {
  const rows = await tx.$queryRaw<LockedPermanentDeleteChat[]>(Prisma.sql`
    SELECT
      "id", "userId", "activeLeafMessageId", "folderId", "archived",
      "memoryMode", "memoryBranchGeneration", "memorySourceRevision",
      "temporaryRetentionPolicyVersion", "temporaryRetentionDeadline",
      "permanentDeletionAt", "permanentDeletionOperationId"
    FROM "Chat"
    WHERE "id" = ${chatId} AND "userId" = ${userId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

export function createPrismaPermanentChatDeletionRepository(
  client: PrismaClient = prisma
): PermanentChatDeletionRepository {
  return Object.freeze({
    async readSnapshot({ chatId, userId }) {
      const chat = await client.chat.findFirst({
        select: {
          activeLeafMessageId: true,
          memoryMode: true,
          memorySourceRevision: true
        },
        where: {
          id: chatId,
          permanentDeletionAt: null,
          userId
        }
      });
      if (!chat) return null;
      const activeRunCount = await client.modelRun.count({
        where: {
          chatId,
          status: { in: [...activeRunStatuses] },
          userId
        }
      });
      return {
        activeLeafMessageId: chat.activeLeafMessageId,
        activeRunCount,
        memoryMode: chat.memoryMode,
        sourceRevision: chat.memorySourceRevision
      };
    },

    async admit(input) {
      return client.$transaction(async (tx) => {
        const replayInput: ReplayInput = {
          alsoForgetOriginMemories: input.alsoForgetOriginMemories,
          authorizationId: input.authorization.authorizationId,
          chatId: input.chatId,
          expectedActiveLeafMessageId: input.expectedActiveLeafMessageId,
          expectedChatRevision: input.expectedChatRevision,
          userId: input.userId
        };
        const replay = await replayDeletion(tx, replayInput);
        if (replay) return { admission: replay, kind: "ok" as const };

        const chat = await lockChat(tx, input.chatId, input.userId);
        if (!chat) return { kind: "not_found" as const };
        if (chat.permanentDeletionAt || chat.permanentDeletionOperationId) {
          const concurrentReplay = await replayDeletion(tx, replayInput);
          return concurrentReplay
            ? { admission: concurrentReplay, kind: "ok" as const }
            : { kind: "not_found" as const };
        }
        if (chat.memoryMode === "TEMPORARY") return { kind: "temporary" as const };
        if (
          chat.memorySourceRevision !== input.expectedChatRevision ||
          chat.activeLeafMessageId !== input.expectedActiveLeafMessageId
        ) {
          return { kind: "stale" as const };
        }

        const activeRunCount = await tx.modelRun.count({
          where: {
            chatId: input.chatId,
            status: { in: [...activeRunStatuses] },
            userId: input.userId
          }
        });
        if (activeRunCount > 0) return { kind: "active_run" as const };

        const snapshot = await applyMemorySourceMutations(tx, {
          chat,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["SOURCE_HARD_DELETE"],
          patch: { archived: true, memoryMode: "EXCLUDED" },
          sourceRequiresBranchGeneration: chat.activeLeafMessageId !== null
        });
        await applyMemoryScopedTargetOwnerLifecycle(
          tx,
          defaultMemorySourceMutationHooks,
          {
            kind: "CHAT_DELETE",
            sourceSnapshots: [snapshot],
            targetId: input.chatId,
            userId: input.userId
          }
        );

        await tx.memoryJob.updateMany({
          data: {
            completedAt: input.now,
            errorCode: "memory_source_deleted",
            errorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            state: "CANCELLED",
            updatedAt: input.now
          },
          where: {
            chatId: input.chatId,
            state: {
              in: [
                "CLAIMED",
                "QUEUED",
                "RETRYABLE_FAILED",
                "WAITING_FOR_EGRESS_CONSENT"
              ]
            },
            userId: input.userId
          }
        });

        const settings = await lockMemorySettings(tx, input.userId, false);
        const deletionId = randomUUID();
        const deletion = await tx.memoryDeletionOutbox.create({
          data: {
            admissionAuthorizationId: input.authorization.authorizationId,
            admittedActiveLeafMessageId: input.expectedActiveLeafMessageId,
            admittedChatSourceRevision: input.expectedChatRevision,
            alsoForgetOriginMemories: input.alsoForgetOriginMemories,
            createdAt: input.now,
            id: deletionId,
            memoryGeneration: settings.memoryGeneration,
            operation: "SOURCE_PURGE",
            targetId: input.chatId,
            targetType: PERMANENT_CHAT_DELETION_TARGET_TYPE,
            updatedAt: input.now,
            userId: input.userId
          },
          select: { createdAt: true, id: true, state: true }
        });
        const fenced = await tx.chat.updateMany({
          data: {
            permanentDeletionAt: input.now,
            permanentDeletionOperationId: deletion.id
          },
          where: {
            archived: true,
            id: input.chatId,
            memoryMode: "EXCLUDED",
            memorySourceRevision: snapshot.memorySourceRevision,
            permanentDeletionAt: null,
            permanentDeletionOperationId: null,
            userId: input.userId
          }
        });
        if (fenced.count !== 1) {
          return memoryPersistenceFailure("memory_counter_contract_invalid");
        }
        await tx.sharedChatSnapshot.updateMany({
          data: { revokedAt: input.now },
          where: {
            chatId: input.chatId,
            ownerUserId: input.userId,
            revokedAt: null
          }
        });
        await consumeMemoryMutationAuthorization(
          tx,
          input.userId,
          input.authorization,
          input.now
        );
        return {
          admission: {
            deletionId: deletion.id,
            fencedAt: deletion.createdAt,
            state: deletion.state
          },
          kind: "ok" as const
        };
      });
    },

    async status({ chatId, deletionId, userId }) {
      const deletion = await client.memoryDeletionOutbox.findFirst({
        select: {
          attemptCount: true,
          createdAt: true,
          errorCode: true,
          id: true,
          lastAuditAt: true,
          state: true,
          updatedAt: true
        },
        where: {
          id: deletionId,
          operation: "SOURCE_PURGE",
          targetId: chatId,
          targetType: PERMANENT_CHAT_DELETION_TARGET_TYPE,
          userId
        }
      });
      return deletion
        ? {
            attemptCount: deletion.attemptCount,
            deletionId: deletion.id,
            errorCode: deletion.errorCode,
            fencedAt: deletion.createdAt,
            lastAuditAt: deletion.lastAuditAt,
            state: deletion.state,
            updatedAt: deletion.updatedAt
          }
        : null;
    }
  });
}
