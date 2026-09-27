// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { prisma } from "../prisma";
import { getWorkspaceConfig } from "../workspace/config";
import { DeterministicWorkspaceRuntime } from "../workspace/deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "../workspace/fencedRuntime";
import { createPrismaProjectRepository } from "./prismaRepository";
import { createPrismaProjectContentRepository } from "./contentRepository";
import { finalizeProjectDeletion } from "./deletion";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });

async function fixture() {
  const suffix = randomUUID();
  const ownerId = `project-deletion-owner-${suffix}`;
  const viewerId = `project-deletion-viewer-${suffix}`;
  await prisma.user.createMany({ data: [ownerId, viewerId].map(id => ({ id, displayName: "Deletion fixture", status: "active" as const })) });
  const local = new DeterministicWorkspaceRuntime(config);
  const runtime = fenceDeterministicWorkspaceRuntime(local);
  const repository = createPrismaProjectRepository(prisma, { workspaceRuntime: runtime });
  const created = await repository.create({ actorDisplayName: "Deletion fixture", name: "Disposable Project", description: "PRIVATE_DESCRIPTION", userId: ownerId });
  if (created.kind !== "ok") throw new Error("fixture_create_failed");
  const projectId = created.value.id;
  await prisma.projectGrant.create({ data: { projectId, userId: viewerId, role: "VIEWER" } });
  const chat = await prisma.chat.create({ data: {
    projectId, userId: null, createdByUserId: ownerId, createdByDisplayName: "Deletion fixture", memoryMode: "EXCLUDED", title: "PRIVATE_CHAT"
  } });
  const request = { actorDisplayName: "Deletion fixture", projectId, userId: ownerId };
  let sessionId: string | null = null;
  let runtimeSandboxId: string | null = null;
  return {
    chat, local, ownerId, projectId, repository, request, runtime, viewerId,
    async workspace() {
      sessionId = `ws_${randomBytes(20).toString("hex")}`;
      const sandboxName = workspaceSandboxName(sessionId);
      runtimeSandboxId = (await local.ensureSession({ cpus: 1, diskMiB: config.diskMiB, imageRef: config.imageRef,
        internetEnabled: false, memoryMiB: 1024, runtimeSandboxId: null, sandboxName, sessionId })).runtimeSandboxId;
      await prisma.workspaceSession.create({ data: { id: sessionId, chatId: chat.id,
        expiresAt: new Date(Date.now() + 3_600_000), imageRef: config.imageRef, internetEnabled: false,
        policyRevision: 1, runtimeSandboxId, sandboxName, state: "READY" } });
      return sessionId;
    },
    async cleanup() {
      if (sessionId) {
        await local.removeSession({ runtimeSandboxId, sessionId });
        await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: sessionId } });
        await prisma.workspaceSession.deleteMany({ where: { id: sessionId } });
      }
      await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
      await prisma.project.deleteMany({ where: { id: projectId } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, viewerId] } } });
    }
  };
}

describe("durable Project deletion", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("rejects an active run before changing lifecycle or revoking shares", async () => {
    const value = await fixture();
    try {
      const message = await prisma.message.create({ data: { chatId: value.chat.id, role: "user",
        authorUserId: value.ownerId, authorDisplayName: "Deletion fixture", authorProjectRole: "OWNER", content: { blocks: [] } } });
      const answer = await prisma.message.create({ data: { chatId: value.chat.id, role: "assistant", parentMessageId: message.id, content: { blocks: [] } } });
      await prisma.$transaction(async tx => {
        const run = await tx.modelRun.create({ data: { chatId: value.chat.id, userId: value.ownerId,
          userMessageId: message.id, assistantMessageId: answer.id, provider: "fake", modelId: "fake-qsa", normalizedRequest: {}, status: "streaming" } });
        await tx.projectRunBinding.create({ data: { modelRunId: run.id, projectId: value.projectId,
          initiatorUserId: value.ownerId, acceptedRole: "OWNER", accessRevision: 1, instructionsRevision: 1,
          memoryRevision: 0, policyRevision: 1, personalMemoryDisabled: true } });
      });
      const share = await prisma.sharedChatSnapshot.create({ data: { projectId: value.projectId, chatId: value.chat.id,
        title: "Synthetic share", slugHash: randomBytes(32).toString("hex"), snapshot: {} } });
      expect(await value.repository.delete(value.request)).toEqual({ kind: "conflict", reason: "project_active_run" });
      expect(await prisma.project.findUnique({ where: { id: value.projectId } })).toMatchObject({ status: "ACTIVE", deletionRequestedAt: null });
      expect(await prisma.sharedChatSnapshot.findUnique({ where: { id: share.id } })).toMatchObject({ revokedAt: null });
      expect(await prisma.projectAuditEvent.count({ where: { projectId: value.projectId, eventType: "deletion_requested" } })).toBe(0);
    } finally { await value.cleanup(); }
  });

  it("keeps failed deletion visible only to its Owner and finalizes after that Owner is disabled", async () => {
    const value = await fixture();
    const foreign = await fixture();
    try {
      const sessionId = await value.workspace();
      const removeSession = vi.fn(value.runtime.removeSession).mockRejectedValueOnce(new Error("synthetic_runtime_outage"));
      const runtime = { ...value.runtime, removeSession };
      const repository = createPrismaProjectRepository(prisma, { workspaceRuntime: runtime });
      expect(await repository.delete(value.request)).toEqual({ kind: "ok", value: { id: value.projectId, status: "failed" } });
      expect(await repository.list(value.ownerId)).toContainEqual(expect.objectContaining({
        id: value.projectId, status: "DELETING", deletionStatus: "failed", description: "", chatCount: 0, audienceCount: 0
      }));
      expect(await repository.list(value.viewerId)).toEqual([]);
      const detail = await repository.getDetail(value.ownerId, value.projectId);
      expect(detail).toMatchObject({ deletionStatus: "failed", instructions: "", resources: [], grants: [], fileCount: 0 });
      expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
      expect(await repository.getDetail(value.viewerId, value.projectId)).toBeNull();
      const content = createPrismaProjectContentRepository(prisma);
      expect(await content.listWorkspace(value.ownerId, value.projectId)).toEqual({ chats: [], folders: [] });
      expect(await content.listWorkspace(value.viewerId, value.projectId)).toBeNull();
      expect(await content.createChat({ actorDisplayName: "Deletion fixture", projectId: value.projectId, userId: value.ownerId })).toEqual({ kind: "not_found" });
      expect(await repository.delete({ ...value.request, userId: value.viewerId })).toEqual({ kind: "not_found" });
      await prisma.user.update({ where: { id: value.ownerId }, data: { status: "disabled" } });
      // The prior failed Workspace operation keeps its own backoff/fence.
      await prisma.workspaceSession.update({ where: { id: sessionId }, data: { operationExpiresAt: new Date(0) } });
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime })).toBe("completed");
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime })).toBe("completed");
      expect(removeSession).toHaveBeenCalledTimes(2);
      expect(await prisma.project.findUnique({ where: { id: value.projectId } })).toBeNull();
      expect(await prisma.project.findUnique({ where: { id: foreign.projectId } })).not.toBeNull();
      expect(await prisma.chat.findUnique({ where: { id: foreign.chat.id } })).not.toBeNull();
    } finally { await value.cleanup(); await foreign.cleanup(); }
  });

  it("keeps concurrent retries pending while one worker owns deletion", async () => {
    const value = await fixture();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let pending: Promise<unknown> | undefined;
    try {
      await value.workspace();
      const removeSession = vi.fn(async (input: Parameters<typeof value.runtime.removeSession>[0]) => {
        entered(); await hold; await value.runtime.removeSession(input);
      });
      const repository = createPrismaProjectRepository(prisma, { workspaceRuntime: { ...value.runtime, removeSession } });
      pending = repository.delete(value.request);
      await started;
      expect(await repository.delete(value.request)).toEqual({ kind: "ok", value: { id: value.projectId, status: "pending" } });
      expect(removeSession).toHaveBeenCalledOnce();
      release();
      expect(await pending).toEqual({ kind: "ok", value: { id: value.projectId, status: "completed" } });
      expect(await repository.delete(value.request)).toEqual({ kind: "not_found" });
    } finally { release(); await pending; await value.cleanup(); }
  });

  it("retains a failed final transaction for a later worker retry", async () => {
    const value = await fixture();
    try {
      await prisma.project.update({ where: { id: value.projectId }, data: {
        status: "DELETING", deletionRequestedAt: new Date()
      } });
      let transactions = 0;
      const interrupted = new Proxy(prisma, { get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (...args: Parameters<typeof prisma.$transaction>) => {
          if (++transactions === 2) return Promise.reject(new Error("synthetic_final_transaction_failure"));
          return Reflect.apply(target.$transaction, target, args);
        };
      } });
      expect(await finalizeProjectDeletion({ prisma: interrupted, projectId: value.projectId })).toBe("failed");
      expect(await prisma.project.findUnique({ where: { id: value.projectId } })).toMatchObject({
        status: "DELETING", deletionLastErrorCode: "project_deletion_failed", deletionClaimToken: null
      });
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId })).toBe("completed");
    } finally { await value.cleanup(); }
  });

  it("recovers an expired worker claim without a current Owner session", async () => {
    const value = await fixture();
    try {
      await prisma.project.update({ where: { id: value.projectId }, data: {
        status: "DELETING", deletionRequestedAt: new Date(0), deletionClaimToken: randomUUID(), deletionClaimExpiresAt: new Date(0)
      } });
      await prisma.user.update({ where: { id: value.ownerId }, data: { status: "disabled" } });
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime: value.runtime })).toBe("completed");
    } finally { await value.cleanup(); }
  });
});
