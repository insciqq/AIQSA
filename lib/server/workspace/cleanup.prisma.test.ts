// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { prisma } from "@/lib/server/prisma";
import { getWorkspaceConfig } from "./config";
import {
  reconcileWorkspaceAfterRestore,
  runWorkspaceMaintenance
} from "./cleanup";
import type { WorkspaceRuntime } from "./runtime";

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

const TEST_USER_PREFIX = "workspace-maintenance-test-";

async function cleanupWorkspaceMaintenanceFixtures(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { id: { startsWith: TEST_USER_PREFIX } }
  });
  const userIds = users.map(({ id }) => id);
  if (userIds.length === 0) return;
  const chats = await prisma.chat.findMany({
    select: { id: true },
    where: { userId: { in: userIds } }
  });
  const chatIds = chats.map(({ id }) => id);
  const sessions = await prisma.workspaceSession.findMany({
    select: { id: true },
    where: { chatId: { in: chatIds } }
  });
  const sessionIds = sessions.map(({ id }) => id);

  await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.chat.updateMany({
    data: { activeLeafMessageId: null },
    where: { id: { in: chatIds } }
  });
  await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.workspaceCleanupJob.deleteMany({
    where: { workspaceSessionId: { in: sessionIds } }
  });
  await prisma.workspaceSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function unused(): never {
  throw new Error("unused");
}

describe("Prisma Workspace maintenance", () => {
  beforeAll(cleanupWorkspaceMaintenanceFixtures);

  afterAll(async () => {
    await cleanupWorkspaceMaintenanceFixtures();
    await prisma.$disconnect();
  });

  it("stops idle sessions, retries durable expiry cleanup, fences restore, and skips active runs", async () => {
    const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
    const now = new Date();
    const staleOperationAt = new Date(now.getTime() - 6 * 60 * 1_000);
    const idleAt = new Date(
      now.getTime() - (config.idleTtlSeconds + 60) * 1_000
    );
    const future = new Date(now.getTime() + config.retentionSeconds * 1_000);
    const expiredAt = new Date(now.getTime() - 60_000);
    const removeSession = vi
      .fn<WorkspaceRuntime["removeSession"]>()
      .mockRejectedValueOnce(new Error("synthetic runner outage"))
      .mockResolvedValue(undefined);
    const stopSession = vi.fn<WorkspaceRuntime["stopSession"]>(async () => undefined);
    const runtime: WorkspaceRuntime = {
      callBoundTool: unused,
      cancelToolCall: unused,
      collectOutputs: unused,
      createProjectArchive: unused,
      ensureSession: unused,
      health: unused,
      loadBoundTools: unused,
      removeSession,
      stageAttachments: unused,
      stopSession
    };

    const user = await prisma.user.create({
      data: { displayName: "Workspace Maintenance Test", id: userId }
    });
    const [expiredChat, idleChat, interruptedChat, activeChat] =
      await Promise.all([
        prisma.chat.create({
          data: { title: "Expired workspace", userId: user.id, workspaceEnabled: true }
        }),
        prisma.chat.create({
          data: { title: "Idle workspace", userId: user.id, workspaceEnabled: true }
        }),
        prisma.chat.create({
          data: { title: "Interrupted workspace", userId: user.id, workspaceEnabled: true }
        }),
        prisma.chat.create({
          data: { title: "Active workspace", userId: user.id, workspaceEnabled: true }
        })
      ]);
    const sessionData = (chatId: string, suffix: string) => ({
      chatId,
      expiresAt: future,
      imageRef: config.imageRef,
      internetEnabled: true,
      policyRevision: 1,
      runtimeSandboxId: `runtime-${suffix}-${randomUUID()}`,
      sandboxName: `aiqsa-ws-${randomUUID()}`
    });
    const expired = await prisma.workspaceSession.create({
      data: {
        ...sessionData(expiredChat.id, "expired"),
        expiresAt: expiredAt,
        lastActiveAt: idleAt,
        state: "READY"
      }
    });
    const idle = await prisma.workspaceSession.create({
      data: {
        ...sessionData(idleChat.id, "idle"),
        lastActiveAt: idleAt,
        state: "RUNNING"
      }
    });
    const interrupted = await prisma.workspaceSession.create({
      data: {
        ...sessionData(interruptedChat.id, "interrupted"),
        lastActiveAt: staleOperationAt,
        lastErrorCode: "workspace_archive_in_progress",
        state: "CREATING",
        updatedAt: staleOperationAt
      }
    });
    const active = await prisma.workspaceSession.create({
      data: {
        ...sessionData(activeChat.id, "active"),
        expiresAt: expiredAt,
        lastActiveAt: idleAt,
        state: "RUNNING"
      }
    });
    const userMessage = await prisma.message.create({
      data: {
        chatId: activeChat.id,
        content: textMessageContent("Keep this session active"),
        modelId: "fake-qsa",
        provider: "fake",
        role: "user",
        status: "complete"
      }
    });
    const assistantMessage = await prisma.message.create({
      data: {
        chatId: activeChat.id,
        content: textMessageContent(""),
        modelId: "fake-qsa",
        parentMessageId: userMessage.id,
        provider: "fake",
        role: "assistant",
        status: "streaming"
      }
    });
    const activeRun = await prisma.modelRun.create({
      data: {
        assistantMessageId: assistantMessage.id,
        chatId: activeChat.id,
        modelId: "fake-qsa",
        normalizedRequest: {},
        provider: "fake",
        status: "streaming",
        userId,
        userMessageId: userMessage.id
      }
    });

    try {
      await expect(runWorkspaceMaintenance({
        config,
        now,
        prisma,
        runtime
      })).resolves.toEqual({
        cleanupClaimed: 1,
        cleanupCompleted: 0,
        cleanupFailed: 1,
        expiredFenced: 1,
        idleFailed: 0,
        idleStopped: 1,
        staleOperationsRecovered: 1
      });
      expect(stopSession).toHaveBeenCalledWith({
        runtimeSandboxId: idle.runtimeSandboxId,
        sessionId: idle.id
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { lastActiveAt: true, runtimeSandboxId: true, state: true, stoppedAt: true },
        where: { id: idle.id }
      })).resolves.toMatchObject({
        lastActiveAt: idleAt,
        runtimeSandboxId: idle.runtimeSandboxId,
        state: "STOPPED",
        stoppedAt: now
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { state: true },
        where: { id: active.id }
      })).resolves.toEqual({ state: "RUNNING" });

      const failedJob = await prisma.workspaceCleanupJob.findUniqueOrThrow({
        where: { workspaceSessionId: expired.id }
      });
      expect(failedJob).toMatchObject({
        attemptCount: 1,
        claimToken: null,
        lastErrorCode: "workspace_remove_failed",
        state: "FAILED"
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { runtimeSandboxId: true, state: true },
        where: { id: expired.id }
      })).resolves.toEqual({
        runtimeSandboxId: expired.runtimeSandboxId,
        state: "DELETING"
      });

      await expect(runWorkspaceMaintenance({
        config,
        now: failedJob.nextAttemptAt,
        prisma,
        runtime
      })).resolves.toMatchObject({
        cleanupClaimed: 1,
        cleanupCompleted: 1,
        cleanupFailed: 0,
        expiredFenced: 0
      });
      expect(removeSession).toHaveBeenCalledTimes(2);
      await expect(prisma.workspaceCleanupJob.findUnique({
        where: { workspaceSessionId: expired.id }
      })).resolves.toBeNull();
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { lastErrorCode: true, runtimeSandboxId: true, state: true },
        where: { id: expired.id }
      })).resolves.toEqual({
        lastErrorCode: null,
        runtimeSandboxId: null,
        state: "PENDING"
      });

      await expect(reconcileWorkspaceAfterRestore(prisma, now)).resolves.toBe(3);
      await expect(prisma.workspaceSession.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          lastErrorCode: true,
          runtimeSandboxId: true,
          state: true,
          stoppedAt: true
        },
        where: { id: { in: [idle.id, interrupted.id, active.id] } }
      })).resolves.toEqual(
        [idle.id, interrupted.id, active.id]
          .sort()
          .map((id) => ({
            id,
            lastErrorCode: "workspace_restored_without_disk",
            runtimeSandboxId: null,
            state: "PENDING",
            stoppedAt: null
          }))
      );
    } finally {
      await prisma.modelRun.deleteMany({ where: { id: activeRun.id } });
      await prisma.chat.updateMany({
        data: { activeLeafMessageId: null },
        where: { id: activeChat.id }
      });
      await prisma.message.deleteMany({ where: { chatId: activeChat.id } });
      await prisma.workspaceCleanupJob.deleteMany({
        where: { workspaceSessionId: { in: [expired.id, idle.id, interrupted.id, active.id] } }
      });
      await prisma.workspaceSession.deleteMany({
        where: { id: { in: [expired.id, idle.id, interrupted.id, active.id] } }
      });
      await prisma.chat.deleteMany({
        where: {
          id: { in: [expiredChat.id, idleChat.id, interruptedChat.id, activeChat.id] }
        }
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("keeps expired overflow out of the idle-stop batch", async () => {
    const userId = `${TEST_USER_PREFIX}${randomUUID()}`;
    const now = new Date();
    const lastActiveAt = new Date(
      now.getTime() - (config.idleTtlSeconds + 120) * 1_000
    );
    const oldestExpiry = new Date(now.getTime() - 120_000);
    const overflowExpiry = new Date(now.getTime() - 60_000);
    const removeSession = vi.fn<WorkspaceRuntime["removeSession"]>(async () => undefined);
    const stopSession = vi.fn<WorkspaceRuntime["stopSession"]>(async () => undefined);
    const runtime: WorkspaceRuntime = {
      callBoundTool: unused,
      cancelToolCall: unused,
      collectOutputs: unused,
      createProjectArchive: unused,
      ensureSession: unused,
      health: unused,
      loadBoundTools: unused,
      removeSession,
      stageAttachments: unused,
      stopSession
    };
    const user = await prisma.user.create({
      data: { displayName: "Workspace Maintenance Overflow Test", id: userId }
    });
    const [oldestChat, overflowChat] = await Promise.all([
      prisma.chat.create({
        data: { title: "Oldest expired workspace", userId, workspaceEnabled: true }
      }),
      prisma.chat.create({
        data: { title: "Overflow expired workspace", userId, workspaceEnabled: true }
      })
    ]);
    const createExpiredSession = (
      chatId: string,
      expiresAt: Date,
      suffix: string
    ) => prisma.workspaceSession.create({
      data: {
        chatId,
        expiresAt,
        imageRef: config.imageRef,
        internetEnabled: true,
        lastActiveAt,
        policyRevision: 1,
        runtimeSandboxId: `runtime-${suffix}-${randomUUID()}`,
        sandboxName: `aiqsa-ws-${randomUUID()}`,
        state: "READY"
      }
    });
    const [oldest, overflow] = await Promise.all([
      createExpiredSession(oldestChat.id, oldestExpiry, "oldest"),
      createExpiredSession(overflowChat.id, overflowExpiry, "overflow")
    ]);

    try {
      await expect(runWorkspaceMaintenance({
        config,
        limit: 1,
        now,
        prisma,
        runtime
      })).resolves.toEqual({
        cleanupClaimed: 1,
        cleanupCompleted: 1,
        cleanupFailed: 0,
        expiredFenced: 1,
        idleFailed: 0,
        idleStopped: 0,
        staleOperationsRecovered: 0
      });
      expect(removeSession).toHaveBeenCalledWith({
        runtimeSandboxId: oldest.runtimeSandboxId,
        sessionId: oldest.id
      });
      expect(stopSession).not.toHaveBeenCalled();
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { runtimeSandboxId: true, state: true },
        where: { id: overflow.id }
      })).resolves.toEqual({
        runtimeSandboxId: overflow.runtimeSandboxId,
        state: "READY"
      });
    } finally {
      await prisma.workspaceCleanupJob.deleteMany({
        where: { workspaceSessionId: { in: [oldest.id, overflow.id] } }
      });
      await prisma.workspaceSession.deleteMany({
        where: { id: { in: [oldest.id, overflow.id] } }
      });
      await prisma.chat.deleteMany({
        where: { id: { in: [oldestChat.id, overflowChat.id] } }
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
