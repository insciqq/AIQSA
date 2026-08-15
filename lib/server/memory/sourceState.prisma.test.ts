import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaMemoryCoordinatorRepository } from "./coordinator/prismaRepository";
import type { MemoryJobClaim } from "./coordinator/types";
import {
  applyMemorySourceMutations,
  loadMemorySourceSnapshot,
  lockMemorySourceChat
} from "./sourceState";
import {
  MEMORY_TEMPORARY_DELETION_GENERATION,
  MEMORY_TEMPORARY_DELETION_TARGET_TYPE
} from "./temporaryRetention";

async function mutateSource(
  userId: string,
  chatId: string,
  operation: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat">
) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, {
      chatId,
      lock: "UPDATE",
      userId
    });
    if (!chat) throw new Error("source_test_chat_missing");
    return applyMemorySourceMutations(tx, { ...operation, chat });
  });
}

async function claimOwnedJob(
  userId: string,
  kind: "RECONCILE_BRANCH" | "RECONCILE_SOURCE",
  now: Date
): Promise<MemoryJobClaim | null> {
  const job = await prisma.memoryJob.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    where: { kind, state: "QUEUED", userId }
  });
  if (!job) return null;
  const claimToken = `${kind.toLocaleLowerCase("en-US")}-${randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED",
      updatedAt: now
    },
    where: { id: job.id }
  });
  return {
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
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    userId: claimed.userId
  };
}

describe("Memory source-state persistence", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("applies the counter matrix and fences stale source-job commits by exact snapshot", async () => {
    const suffix = randomUUID();
    const userId = `memory-source-${suffix}`;
    const now = new Date("2026-08-10T18:00:00.000Z");
    await prisma.user.create({
      data: {
        displayName: "Memory Source Test",
        email: `memory-source-${suffix}@example.test`,
        id: userId,
        status: "active"
      }
    });

    try {
      const [folderA, folderB] = await Promise.all([
        prisma.folder.create({
          data: { name: `Source A ${suffix}`, userId }
        }),
        prisma.folder.create({
          data: { name: `Source B ${suffix}`, userId }
        })
      ]);
      const chat = await prisma.chat.create({
        data: { folderId: folderA.id, title: "Source state", userId }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Original question"),
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Draft"),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "streaming"
        }
      });

      const appended = await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: assistantMessage.id }
      });
      expect(appended).toMatchObject({
        memoryBranchGeneration: 0,
        memorySourceRevision: 1
      });
      const appendHash = appended.sourceHash;

      await prisma.message.update({
        data: { content: textMessageContent("Streaming token batch") },
        where: { id: assistantMessage.id }
      });
      await expect(prisma.$transaction((tx) => loadMemorySourceSnapshot(tx, {
        chatId: chat.id,
        userId
      }))).resolves.toMatchObject({
        memoryBranchGeneration: 0,
        memorySourceRevision: 1,
        sourceHash: appendHash
      });

      const terminalHook = vi.fn(async () => undefined);
      const settled = await prisma.$transaction(async (tx) => {
        await tx.message.update({
          data: {
            content: textMessageContent("Settled answer"),
            status: "complete"
          },
          where: { id: assistantMessage.id }
        });
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("source_test_chat_missing");
        return applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: { onTemporaryRunFinalized: terminalHook },
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: {
            assistantMessageId: assistantMessage.id,
            runId: `run-${suffix}`,
            status: "complete"
          }
        });
      });
      expect(settled).toMatchObject({
        memoryBranchGeneration: 0,
        memorySourceRevision: 2
      });
      expect(settled.sourceHash).not.toBe(appendHash);
      expect(terminalHook).not.toHaveBeenCalled();
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({ memoryGeneration: 0, memoryRevision: 0 });

      const editedMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Edited answer"),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "complete"
        }
      });
      const branched = await mutateSource(userId, chat.id, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: editedMessage.id }
      });
      expect(branched).toMatchObject({
        activeLeafMessageId: editedMessage.id,
        memoryBranchGeneration: 1,
        memorySourceRevision: 3
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({ memoryGeneration: 1, memoryRevision: 1 });

      const scopeHook = vi.fn(async () => undefined);
      const moved = await mutateSource(userId, chat.id, {
        hooks: { onScopedTargetLifecycle: scopeHook },
        mutations: ["FOLDER_MOVE"],
        patch: { folderId: folderB.id }
      });
      expect(moved).toMatchObject({
        folderId: folderB.id,
        memoryBranchGeneration: 1,
        memorySourceRevision: 4
      });
      expect(moved.sourceHash).not.toBe(branched.sourceHash);
      expect(scopeHook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        nextFolderId: folderB.id,
        previousFolderId: folderA.id
      }));
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      })).resolves.toMatchObject({ memoryGeneration: 1, memoryRevision: 2 });

      const archived = await mutateSource(userId, chat.id, {
        mutations: ["CHAT_ARCHIVE_OR_RESTORE"],
        patch: { archived: true }
      });
      expect(archived).toMatchObject({
        archived: true,
        memoryBranchGeneration: 1,
        memorySourceRevision: 4
      });
      expect(archived.sourceHash).toBe(moved.sourceHash);

      const repository = createPrismaMemoryCoordinatorRepository(prisma);
      const branchClaim = await claimOwnedJob(userId, "RECONCILE_BRANCH", now);
      expect(branchClaim).toMatchObject({
        branchGeneration: 1,
        sourceRevision: 3
      });
      const staleApply = vi.fn(async () => undefined);
      await expect(repository.commitJobSuccess({
        acceptedResultHash: "a".repeat(64),
        apply: staleApply,
        claim: branchClaim!,
        now: new Date(now.getTime() + 1_000),
        stage: "APPLIED"
      })).resolves.toBe(true);
      expect(staleApply).not.toHaveBeenCalled();
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: branchClaim!.id }
      })).resolves.toMatchObject({
        acceptedResultHash: null,
        errorCode: "memory_source_stale",
        state: "STALE"
      });

      const sourceClaim = await claimOwnedJob(userId, "RECONCILE_SOURCE", now);
      expect(sourceClaim).toMatchObject({
        branchGeneration: 1,
        sourceRevision: 4,
        sourceHash: moved.sourceHash
      });
      await expect(repository.commitJobSuccess({
        acceptedResultHash: "b".repeat(64),
        apply: async () => undefined,
        claim: sourceClaim!,
        now: new Date(now.getTime() + 2_000),
        stage: "APPLIED"
      })).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: sourceClaim!.id }
      })).resolves.toMatchObject({
        acceptedResultHash: "b".repeat(64),
        state: "SUCCEEDED"
      });

      const refreshed = await mutateSource(userId, chat.id, {
        mutations: ["FOLDER_MOVE"],
        patch: { folderId: folderA.id }
      });
      const racedClaim = await claimOwnedJob(
        userId,
        "RECONCILE_SOURCE",
        new Date(now.getTime() + 3_000)
      );
      expect(racedClaim).toMatchObject({
        sourceHash: refreshed.sourceHash,
        sourceRevision: 5
      });

      let releaseMutation: () => void = () => {};
      const mutationGate = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      let reportChatLock: () => void = () => {};
      const chatLocked = new Promise<void>((resolve) => {
        reportChatLock = resolve;
      });
      const concurrentMutation = prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("source_test_chat_missing");
        reportChatLock();
        await mutationGate;
        return applyMemorySourceMutations(tx, {
          chat: locked,
          mutations: ["FOLDER_MOVE"],
          patch: { folderId: folderB.id }
        });
      });
      await chatLocked;
      const racedApply = vi.fn(async () => undefined);
      const concurrentCommit = repository.commitJobSuccess({
        acceptedResultHash: "c".repeat(64),
        apply: racedApply,
        claim: racedClaim!,
        now: new Date(now.getTime() + 4_000),
        stage: "APPLIED"
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseMutation();
      const [mutationResult, commitResult] = await Promise.all([
        concurrentMutation,
        concurrentCommit
      ]);
      expect(mutationResult).toMatchObject({
        folderId: folderB.id,
        memorySourceRevision: 6
      });
      expect(commitResult).toBe(true);
      expect(racedApply).not.toHaveBeenCalled();
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: racedClaim!.id }
      })).resolves.toMatchObject({
        errorCode: "memory_source_stale",
        state: "STALE"
      });
      await expect(prisma.$transaction((tx) => loadMemorySourceSnapshot(tx, {
        chatId: chat.id,
        userId
      }))).resolves.toMatchObject({ sourceHash: moved.sourceHash });

      const excluded = await mutateSource(userId, chat.id, {
        mutations: ["SOURCE_EXCLUDE"],
        patch: { memoryMode: "EXCLUDED" }
      });
      expect(excluded).toMatchObject({
        memoryBranchGeneration: 1,
        memoryMode: "EXCLUDED",
        memorySourceRevision: 7
      });
      const resumed = await mutateSource(userId, chat.id, {
        mutations: ["SOURCE_RESUME"],
        patch: { memoryMode: "NORMAL" }
      });
      expect(resumed).toMatchObject({
        memoryBranchGeneration: 1,
        memoryMode: "NORMAL",
        memorySourceRevision: 8
      });
      expect(resumed.sourceHash).toBe(moved.sourceHash);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      })).resolves.toEqual({ memoryGeneration: 2, memoryRevision: 6 });
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("invokes the Temporary finalization leaf inside the terminal source transaction", async () => {
    const suffix = randomUUID();
    const userId = `memory-temporary-source-${suffix}`;
    await prisma.user.create({
      data: {
        displayName: "Temporary Source Test",
        id: userId,
        status: "active"
      }
    });
    try {
      const { chat, message } = await prisma.$transaction(async (tx) => {
        const deadline = new Date(Date.now() + 86_400_000);
        const chat = await tx.chat.create({
          data: {
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: deadline,
            temporaryRetentionPolicyVersion: "temporary-24h-v1",
            title: "Temporary source",
            userId
          }
        });
        await tx.memoryDeletionOutbox.create({
          data: {
            memoryGeneration: MEMORY_TEMPORARY_DELETION_GENERATION,
            nextAttemptAt: deadline,
            operation: "TEMPORARY_DELETE",
            targetId: chat.id,
            targetType: MEMORY_TEMPORARY_DELETION_TARGET_TYPE,
            userId
          }
        });
        const message = await tx.message.create({
          data: {
            chatId: chat.id,
            content: textMessageContent("Temporary answer"),
            role: "assistant",
            status: "complete"
          }
        });
        return { chat, message };
      });
      await mutateSource(userId, chat.id, {
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: message.id }
      });
      await expect(prisma.$transaction((tx) => loadMemorySourceSnapshot(tx, {
        chatId: chat.id,
        userId
      }))).resolves.toMatchObject({
        memoryMode: "TEMPORARY",
        messages: []
      });
      const temporaryHook = vi.fn(async () => undefined);
      await mutateSource(userId, chat.id, {
        hooks: { onTemporaryRunFinalized: temporaryHook },
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: message.id,
          runId: `temporary-run-${suffix}`,
          status: "complete"
        }
      });
      expect(temporaryHook).toHaveBeenCalledWith(expect.anything(), {
        settlement: {
          assistantMessageId: message.id,
          runId: `temporary-run-${suffix}`,
          status: "complete"
        },
        snapshot: expect.objectContaining({
          activeLeafMessageId: message.id,
          memoryMode: "TEMPORARY",
          memorySourceRevision: 0,
          messages: []
        })
      });
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.memoryDeletionOutbox.updateMany({
          data: {
            leaseExpiresAt: new Date(Date.now() + 60_000),
            leaseToken: "temporary-source-test-cleanup",
            nextAttemptAt: null,
            state: "RUNNING"
          },
          where: { operation: "TEMPORARY_DELETE", userId }
        });
        await tx.chat.deleteMany({ where: { userId } });
        await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
        await tx.user.deleteMany({ where: { id: userId } });
      });
    }
  });
});
