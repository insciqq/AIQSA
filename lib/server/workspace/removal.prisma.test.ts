// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION, MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "@/lib/contracts/memory";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { prisma } from "@/lib/server/prisma";
import { createPrismaProjectRepository } from "@/lib/server/projects/prismaRepository";
import { createPrismaPermanentChatDeletionHandler } from "@/lib/server/chats/permanentDeletion/cleanup";
import { createPrismaPermanentChatDeletionRepository } from "@/lib/server/chats/permanentDeletion/repository";
import { createPermanentChatDeletionService } from "@/lib/server/chats/permanentDeletion/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "@/lib/server/memory/persistence/authorizations";
import { MemoryCoordinator } from "@/lib/server/memory/coordinator/coordinator";
import { MemoryCoordinatorRegistry } from "@/lib/server/memory/coordinator/registry";
import { createPrismaMemoryCoordinatorRepository } from "@/lib/server/memory/coordinator/prismaRepository";
import { createPrismaTemporaryChatDeletionHandler } from "@/lib/server/memory/temporaryDeletion";
import { scheduleTemporaryChatDeletion } from "@/lib/server/memory/temporaryRetention";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "./fencedRuntime";
import { removeWorkspaceForDeletion } from "./removal";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });

describe("Workspace aggregate deletion protocol", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("keeps deletion exclusive and rejects a delayed remove after expired-owner takeover", async () => {
    const userId = `workspace-removal-test-${randomUUID()}`;
    const sessionId = `ws_${randomBytes(20).toString("hex")}`;
    const sandboxName = workspaceSandboxName(sessionId);
    const local = new DeterministicWorkspaceRuntime(config);
    const fenced = fenceDeterministicWorkspaceRuntime(local);
    const now = new Date();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let delayed = true;
    const runtime = { ...fenced, async removeSession(input: Parameters<typeof fenced.removeSession>[0]) {
      if (delayed) { delayed = false; entered(); await held; }
      await fenced.removeSession(input);
    } };
    let chatId: string | undefined;
    let runtimeSandboxId: string | null = null;
    let pending: Promise<unknown> | undefined;
    try {
      await prisma.user.create({ data: { id: userId, displayName: "Workspace Deletion Barrier" } });
      const chat = await prisma.chat.create({ data: { archived: true, title: "Deletion already authorized", userId } });
      chatId = chat.id;
      runtimeSandboxId = (await local.ensureSession({ cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef,
        internetEnabled: false, memoryMiB: 1024, runtimeSandboxId: null, sandboxName, sessionId })).runtimeSandboxId;
      await prisma.workspaceSession.create({ data: { id: sessionId, chatId, expiresAt: new Date(now.getTime() + 3_600_000),
        imageRef: config.imageRef, internetEnabled: false, policyRevision: 1, runtimeSandboxId, sandboxName, state: "READY" } });
      pending = removeWorkspaceForDeletion({ now, prisma, runtime, sessionId }).then(() => null, (error: unknown) => error);
      await started;
      const first = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId } });
      await expect(removeWorkspaceForDeletion({ now, prisma, runtime, sessionId })).rejects.toMatchObject({ code: "workspace_operation_stale" });
      expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId } })).toEqual(first);
      await removeWorkspaceForDeletion({ now: new Date(first.operationExpiresAt!.getTime() + 1), prisma, runtime, sessionId });
      const settled = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(settled).toMatchObject({ operationOwner: null, operationExpiresAt: null, runtimeSandboxId: null, state: "DELETING", version: first.version + 1 });
      release();
      expect(await pending).toMatchObject({ code: "workspace_operation_stale" });
      expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId } })).toEqual(settled);
      expect(await prisma.workspaceCleanupJob.count({ where: { workspaceSessionId: sessionId } })).toBe(0);
      await expect(local.listStagedAttachments({ attachments: [], runtimeSandboxId, sessionId })).rejects.toMatchObject({ code: "workspace_session_lost" });
    } finally {
      release();
      await pending;
      await local.removeSession({ runtimeSandboxId, sessionId });
      await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: sessionId } });
      await prisma.workspaceSession.deleteMany({ where: { id: sessionId } });
      if (chatId) await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it.each(["personal", "project", "temporary"] as const)("removes the exact fenced Workspace during %s deletion", async (kind) => {
    const userId = `workspace-removal-test-${randomUUID()}`;
    const local = new DeterministicWorkspaceRuntime(config);
    const runtime = fenceDeterministicWorkspaceRuntime(local);
    const sessionId = `ws_${randomBytes(20).toString("hex")}`;
    const sandboxName = workspaceSandboxName(sessionId);
    let chatId: string | null = null;
    let projectId: string | null = null;
    let runtimeSandboxId: string | null = null;
    try {
      await prisma.user.create({ data: { id: userId, displayName: "Workspace Deletion Fixture", status: "active" } });
      const projectRepository = createPrismaProjectRepository(prisma, { workspaceRuntime: runtime });
      if (kind === "project") {
        const created = await projectRepository.create({ actorDisplayName: "Workspace Deletion Fixture", description: "", name: "Disposable Workspace", userId });
        expect(created.kind).toBe("ok");
        if (created.kind !== "ok") throw new Error("workspace_fixture_project_unavailable");
        projectId = created.value.id;
      }
      const chat = await prisma.$transaction(async (tx) => {
        const created = await tx.chat.create({ data: {
        ...(projectId ? { projectId, createdByUserId: userId, createdByDisplayName: "Workspace Deletion Fixture", memoryMode: "EXCLUDED" as const } : { userId }),
        ...(kind === "temporary" ? { memoryMode: "TEMPORARY" as const, temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
          createdAt: new Date(Date.now() - 60_000),
          temporaryRetentionDeadline: new Date(Date.now() - 1_000) } : {}),
        title: "Workspace deletion", workspaceEnabled: true
        } });
        if (kind === "temporary") await scheduleTemporaryChatDeletion(tx, {
          chatId: created.id, deadline: created.temporaryRetentionDeadline!, now: new Date(), userId
        });
        return created;
      });
      chatId = chat.id;
      runtimeSandboxId = (await local.ensureSession({ cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef,
        internetEnabled: false, memoryMiB: 1024, runtimeSandboxId: null, sandboxName, sessionId })).runtimeSandboxId;
      await prisma.workspaceSession.create({ data: { id: sessionId, chatId, expiresAt: new Date(Date.now() + 3_600_000),
        imageRef: config.imageRef, internetEnabled: false, policyRevision: 1, runtimeSandboxId, sandboxName, state: "READY" } });
      if (projectId) {
        await expect(projectRepository.delete({ actorDisplayName: "Workspace Deletion Fixture", projectId, userId })).resolves.toMatchObject({ kind: "ok" });
      } else if (kind === "temporary") {
        const registry = new MemoryCoordinatorRegistry();
        registry.registerDeletion(createPrismaTemporaryChatDeletionHandler(createMemoryStorageAdapter(), prisma, runtime));
        const coordinator = new MemoryCoordinator({ registry, repository: createPrismaMemoryCoordinatorRepository(prisma) });
        await coordinator.reconcileNow();
        await expect(prisma.memoryDeletionOutbox.findFirstOrThrow({ where: { targetId: chat.id, userId } })).resolves.toMatchObject({ state: "SUCCEEDED" });
      } else {
        const service = createPermanentChatDeletionService({
          authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma), capability: { enabled: true }, kick() {},
          repository: createPrismaPermanentChatDeletionRepository(prisma)
        });
        const authorization = await service.mintAuthorization(userId, chatId, {
          alsoForgetOriginMemories: false, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedActiveLeafMessageId: null, expectedChatRevision: chat.memorySourceRevision, requestNonce: randomUUID()
        });
        const admission = await service.admit(userId, chatId, {
          alsoForgetOriginMemories: false, expectedActiveLeafMessageId: null, expectedChatRevision: chat.memorySourceRevision,
          mutationAuthorizationId: authorization.mutationAuthorizationId
        });
        const registry = new MemoryCoordinatorRegistry();
        registry.registerDeletion(createPrismaPermanentChatDeletionHandler(createMemoryStorageAdapter(), prisma, runtime));
        const coordinator = new MemoryCoordinator({ registry, repository: createPrismaMemoryCoordinatorRepository(prisma) });
        await coordinator.reconcileNow();
        await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: admission.deletionId } })).resolves.toMatchObject({ state: "SUCCEEDED" });
      }
      expect(await prisma.workspaceSession.count({ where: { id: sessionId } })).toBe(0);
      expect(await prisma.workspaceCleanupJob.count({ where: { workspaceSessionId: sessionId } })).toBe(0);
      expect(await prisma.chat.count({ where: { id: chatId } })).toBe(0);
      await expect(local.listStagedAttachments({ attachments: [], runtimeSandboxId, sessionId })).rejects.toMatchObject({ code: "workspace_session_lost" });
    } finally {
      await local.removeSession({ runtimeSandboxId, sessionId });
      await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: sessionId } });
      await prisma.workspaceSession.deleteMany({ where: { id: sessionId } });
      await prisma.$transaction(async (tx) => {
        if (kind === "temporary" && await tx.chat.count({ where: { userId } })) {
          await tx.memoryDeletionOutbox.updateMany({ data: {
            completedAt: null, leaseExpiresAt: new Date(Date.now() + 60_000), leaseToken: "workspace-removal-fixture-cleanup",
            nextAttemptAt: null, state: "RUNNING"
          }, where: { operation: "TEMPORARY_DELETE", userId } });
        }
        if (chatId) await tx.chat.deleteMany({ where: { id: chatId } });
        await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
      });
      if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
