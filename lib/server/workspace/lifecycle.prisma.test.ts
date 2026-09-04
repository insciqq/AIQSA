// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/server/prisma";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import type { WorkspaceAvailabilityService } from "./availability";
import { getWorkspaceConfig } from "./config";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";
import { createWorkspaceLifecycleService } from "./lifecycle";
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
    const runtime: WorkspaceRuntime = {
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
      stopSession: vi.fn(async () => undefined)
    };
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
        expiresAt: new Date("2026-09-05T00:00:00.000Z"),
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
        select: { state: true, stoppedAt: true },
        where: { id: session.id }
      })).resolves.toEqual({ state: "READY", stoppedAt: null });
      expect([...storage.objects.values()][0]?.body.equals(archive)).toBe(true);

      await prisma.workspaceSession.update({
        data: { state: "STOPPED", stoppedAt },
        where: { id: session.id }
      });
      const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
      const startingAt = new Date();
      const startingExpiresAt = new Date(
        startingAt.getTime() + config.retentionSeconds * 1_000
      );
      await expect(repository.markSessionStarting({
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
});
