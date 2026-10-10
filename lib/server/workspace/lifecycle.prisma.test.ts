// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/server/prisma";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { scheduledTaskScheduleColumns } from "@/lib/server/scheduledTasks/store";
import { createWorkspaceAvailabilityService, type WorkspaceAvailabilityService } from "./availability";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";
import { createWorkspaceLifecycleService } from "./lifecycle";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import type { WorkspacePolicyRepository } from "./policyRepository";
import type { WorkspaceRuntime } from "./runtime";

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    }
  });
}

const availability: WorkspaceAvailabilityService = {
  invalidate() {},
  project() {
    throw new Error("unused");
  },
  async snapshot() {
    throw new Error("unused");
  }
};

const policy: WorkspacePolicyRepository = {
  async read() {
    return { enabled: true, internetEnabled: true, version: 1 };
  },
  async update() {
    throw new Error("unused");
  }
};

describe("Prisma Workspace lifecycle", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("clears stoppedAt before archive and run restart state transitions", async () => {
    const userId = `workspace-lifecycle-test-${randomUUID()}`;
    const runtimeSandboxId = `runtime-${randomUUID()}`;
    const archive = Buffer.from("workspace archive fixture", "utf8");
    const checksum = createHash("sha256").update(archive).digest("hex");
    const storage = createMemoryStorageAdapter();
    const runtime: WorkspaceRuntime = fenceDeterministicWorkspaceRuntime({
      callBoundTool: vi.fn(async () => { throw new Error("unused"); }),
      cancelToolCall: vi.fn(async () => undefined),
      collectOutputs: vi.fn(async () => []),
      listStagedAttachments: vi.fn(async () => []),
      terminateExecutions: vi.fn(async () => []),
      createProjectArchive: vi.fn(async () => ({
        body: stream(archive),
        byteSize: archive.byteLength,
        checksum,
        mimeType: "application/gzip",
        opaqueFileId: "a".repeat(64),
        relativePath: "workspace.tar.gz"
      })),
      ensureSession: vi.fn(async (input) => ({
        runtimeSandboxId,
        sandboxName: input.sandboxName,
        state: "ready" as const
      })),
      health: vi.fn(async () => ({ state: "ready" as const })),
      loadBoundTools: vi.fn(async () => { throw new Error("unused"); }),
      removeSession: vi.fn(async () => undefined),
      stageAttachments: vi.fn(async () => undefined),
      syncPersonalSecrets: vi.fn(async () => undefined),
      prepareSkillRun: vi.fn(async () => { throw new Error("unused"); }),
      installSkillBundle: vi.fn(async () => { throw new Error("unused"); }),
      completeSkillRunPreparation: vi.fn(async () => { throw new Error("unused"); }),
      collectBrowserSessions: vi.fn(async () => ({ files: [], skipped: [] })),
      stopSession: vi.fn(async () => undefined)
    });
    const user = await prisma.user.create({
      data: { displayName: "Workspace Lifecycle Test", id: userId }
    });
    const chat = await prisma.chat.create({
      data: { title: "Stopped workspace archive", userId: user.id, workspaceEnabled: true }
    });
    const stoppedAt = new Date("2026-09-04T00:00:00.000Z");
    const session = await prisma.workspaceSession.create({
      data: {
        chatId: chat.id,
        expiresAt: new Date(Date.now() + config.retentionSeconds * 1_000),
        imageRef: config.imageRef,
        internetEnabled: true,
        policyRevision: 1,
        runtimeSandboxId,
        sandboxName: `aiqsa-ws-${randomUUID()}`,
        state: "STOPPED",
        stoppedAt
      }
    });

    try {
      const lifecycle = createWorkspaceLifecycleService({
        availability,
        config,
        policy,
        prisma,
        runtime,
        storage
      });
      await expect(lifecycle.archive({ chatId: chat.id, userId })).resolves.toMatchObject({
        byteSize: archive.byteLength,
        fileName: "workspace.tar.gz",
        mimeType: "application/gzip"
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { operationOwner: true, state: true, stoppedAt: true },
        where: { id: session.id }
      })).resolves.toEqual({ operationOwner: null, state: "STOPPED", stoppedAt: expect.any(Date) });
      expect([...storage.objects.values()][0]?.body.equals(archive)).toBe(true);

      const claimed = await prisma.workspaceSession.update({
        data: { operationOwner: "run:lifecycle_fixture", version: { increment: 1 }, state: "STOPPED", stoppedAt },
        where: { id: session.id }
      });
      const operation = { generation: claimed.version, owner: claimed.operationOwner! };
      const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
      const startingAt = new Date();
      const startingExpiresAt = new Date(
        startingAt.getTime() + config.retentionSeconds * 1_000
      );
      await expect(repository.markSessionStarting({
        operation,
        expiresAt: startingExpiresAt,
        lastActiveAt: startingAt,
        sessionId: session.id
      })).resolves.toBe(true);
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { expiresAt: true, lastActiveAt: true, state: true, stoppedAt: true },
        where: { id: session.id }
      })).resolves.toEqual({
        expiresAt: startingExpiresAt,
        lastActiveAt: startingAt,
        state: "CREATING",
        stoppedAt: null
      });
      const readyAt = new Date();
      const readyExpiresAt = new Date(
        readyAt.getTime() + config.retentionSeconds * 1_000
      );
      await repository.markSessionReady({
        operation,
        expiresAt: readyExpiresAt,
        lastActiveAt: readyAt,
        sessionId: session.id
      });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { expiresAt: true, lastActiveAt: true, state: true, stoppedAt: true },
        where: { id: session.id }
      })).resolves.toEqual({
        expiresAt: readyExpiresAt,
        lastActiveAt: readyAt,
        state: "READY",
        stoppedAt: null
      });
    } finally {
      await prisma.attachment.deleteMany({ where: { chatId: chat.id } });
      await prisma.workspaceSession.deleteMany({ where: { id: session.id } });
      await prisma.chat.deleteMany({ where: { id: chat.id } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it("lets a reset consume a carried project a failed start never restored", async () => {
    const userId = `workspace-lifecycle-test-${randomUUID()}`;
    const storageKey = `${userId}/workspace-seeds/${randomUUID()}`;
    const runtime = {
      claimSessionOperation: vi.fn(async () => undefined),
      removeSession: vi.fn(async () => undefined),
      retireSessionOperation: vi.fn(async () => undefined)
    } as unknown as WorkspaceRuntime;
    await prisma.user.create({ data: { displayName: "Workspace Lifecycle Test", id: userId } });
    const chat = await prisma.chat.create({
      data: { title: "Rotated scheduled chat", userId, workspaceEnabled: true }
    });
    const task = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatId: chat.id, chatMode: "SAME", emailNotify: false,
      modelId: "fake-qsa", nextRunAt: new Date(Date.now() + 86_400_000), prompt: "Synthetic scheduled prompt", provider: "fake",
      searchEnabled: false, status: "ACTIVE", timeZone: "Europe/Moscow", title: "Synthetic brief", userId, workspaceEnabled: true
    } });
    // The failed start never recorded a runtime identity, so the old reset refused with `workspace_not_started`.
    const session = await prisma.workspaceSession.create({
      data: {
        chatId: chat.id,
        expiresAt: new Date(Date.now() + config.retentionSeconds * 1_000),
        imageRef: config.imageRef,
        internetEnabled: true,
        lastErrorCode: "workspace_carryover_unavailable",
        policyRevision: 1,
        runtimeSandboxId: null,
        sandboxName: `aiqsa-ws-${randomUUID()}`,
        state: "FAILED"
      }
    });
    const seed = await prisma.chatContinuationWorkspaceSeed.create({ data: {
      byteSize: 1, checksum: "b".repeat(64), newChatId: chat.id, scheduledTaskId: task.id, status: "TRANSFERRED", storageKey
    } });

    try {
      const lifecycle = createWorkspaceLifecycleService({
        availability: createWorkspaceAvailabilityService({
          health: { invalidate() {}, read: async () => ({ state: "ready" as const }) },
          policy
        }),
        config,
        policy,
        prisma,
        runtime,
        storage: createMemoryStorageAdapter()
      });
      await expect(lifecycle.archive({ chatId: chat.id, userId })).rejects.toMatchObject({ code: "workspace_not_started" });
      await expect(lifecycle.reset({ chatId: chat.id, userId: `${userId}-other` }))
        .rejects.toMatchObject({ code: "workspace_reset_conflict", status: 404 });
      await expect(lifecycle.reset({ chatId: chat.id, userId })).resolves.toMatchObject({
        continuationFiles: { reason: "reset_consumed", status: "failed" },
        sessionState: "not_started"
      });
      expect(runtime.removeSession).toHaveBeenCalledWith(expect.objectContaining({ runtimeSandboxId: null, sessionId: session.id }));
      await expect(prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({
        select: { failureCode: true, status: true }, where: { id: seed.id }
      })).resolves.toEqual({ failureCode: "workspace_reset_consumed", status: "ABANDONED" });
      await expect(prisma.workspaceSession.findUniqueOrThrow({
        select: { operationOwner: true, runtimeSandboxId: true, state: true }, where: { id: session.id }
      })).resolves.toEqual({ operationOwner: null, runtimeSandboxId: null, state: "PENDING" });
      await expect(prisma.workspaceCleanupJob.count({ where: { workspaceSessionId: session.id } })).resolves.toBe(0);
      await expect(prisma.attachmentDeletionJob.count({ where: { storageKey } })).resolves.toBe(1);
      await expect(lifecycle.reset({ chatId: chat.id, userId })).rejects.toMatchObject({ code: "workspace_not_started" });
    } finally {
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey } });
      await prisma.chatContinuationWorkspaceSeed.deleteMany({ where: { id: seed.id } });
      await prisma.scheduledTask.deleteMany({ where: { id: task.id } });
      await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: session.id } });
      await prisma.workspaceSession.deleteMany({ where: { id: session.id } });
      await prisma.chat.deleteMany({ where: { id: chat.id } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
