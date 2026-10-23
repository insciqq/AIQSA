// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { prisma } from "../prisma";
import { getWorkspaceConfig } from "../workspace/config";
import { DeterministicWorkspaceRuntime } from "../workspace/deterministicRuntime";
import { fenceDeterministicWorkspaceRuntime } from "../workspace/fencedRuntime";
import { finalizeProjectDeletion, runProjectDeletionMaintenance } from "./deletion";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });

/** A Project as the retirement migration leaves it: fenced for deletion, with a chat, a file and a share. */
async function fixture() {
  const suffix = randomUUID();
  const ownerId = `project-retirement-owner-${suffix}`;
  const viewerId = `project-retirement-viewer-${suffix}`;
  await prisma.user.createMany({ data: [ownerId, viewerId].map(id => ({ id, displayName: "Retirement fixture", status: "active" as const })) });
  const local = new DeterministicWorkspaceRuntime(config);
  const runtime = fenceDeterministicWorkspaceRuntime(local);
  const project = await prisma.project.create({ data: {
    createdByDisplayName: "Retirement fixture", createdByUserId: ownerId, deletionRequestedAt: new Date(),
    description: "PRIVATE_DESCRIPTION", name: "Retired Project", status: "DELETING",
    grants: { create: [{ role: "OWNER", userId: ownerId }, { role: "VIEWER", userId: viewerId }] }
  } });
  const projectId = project.id;
  const chat = await prisma.chat.create({ data: {
    projectId, userId: null, createdByUserId: ownerId, createdByDisplayName: "Retirement fixture", memoryMode: "EXCLUDED", title: "PRIVATE_CHAT"
  } });
  const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", authorUserId: ownerId,
    authorDisplayName: "Retirement fixture", authorProjectRole: "OWNER", content: { blocks: [{ type: "text", text: "PRIVATE_TEXT" }] } } });
  const storageKey = `projects/retirement-${suffix}`;
  const attachment = await prisma.attachment.create({ data: { byteSize: 4, chatId: chat.id, fileName: "private.txt", kind: "file",
    messageId: message.id, metadata: {}, mimeType: "text/plain", projectId, storageKey, uploaderDisplayName: "Retirement fixture", uploaderUserId: ownerId } });
  const share = await prisma.sharedChatSnapshot.create({ data: { chatId: chat.id, createdByDisplayName: "Retirement fixture",
    projectId, revokedAt: new Date(), slugHash: randomBytes(32).toString("hex"), snapshot: {}, title: "Synthetic share" } });
  const personal = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Personal chat", userId: ownerId } });
  let sessionId: string | null = null;
  let runtimeSandboxId: string | null = null;
  return {
    attachment, chat, local, message, ownerId, personal, projectId, runtime, share, storageKey, viewerId,
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
        await local.removeSession({ runtimeSandboxId, sessionId }).catch(() => undefined);
        await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: sessionId } });
        await prisma.workspaceSession.deleteMany({ where: { id: sessionId } });
      }
      await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
      await prisma.project.deleteMany({ where: { id: projectId } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey } });
      await prisma.chat.deleteMany({ where: { id: personal.id } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, viewerId] } } });
    }
  };
}

describe("Project retirement", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("deletes a fenced Project with its chats, files, shares, memberships and Workspace, and nothing personal", async () => {
    const value = await fixture();
    try {
      const sessionId = await value.workspace();
      const removeSession = vi.fn(value.runtime.removeSession);
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime: { ...value.runtime, removeSession } }))
        .toBe("completed");
      expect(removeSession).toHaveBeenCalledOnce();
      expect(await prisma.project.findUnique({ where: { id: value.projectId } })).toBeNull();
      expect(await prisma.projectGrant.count({ where: { projectId: value.projectId } })).toBe(0);
      expect(await prisma.chat.findUnique({ where: { id: value.chat.id } })).toBeNull();
      expect(await prisma.message.findUnique({ where: { id: value.message.id } })).toBeNull();
      expect(await prisma.attachment.findUnique({ where: { id: value.attachment.id } })).toBeNull();
      expect(await prisma.sharedChatSnapshot.findUnique({ where: { id: value.share.id } })).toBeNull();
      expect(await prisma.workspaceSession.findUnique({ where: { id: sessionId } })).toBeNull();
      // The stored object leaves through the ordinary reference-checked object deletion.
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: value.storageKey } })).toBe(1);
      expect(await prisma.chat.findUnique({ where: { id: value.personal.id } })).not.toBeNull();
      expect(await prisma.user.count({ where: { id: { in: [value.ownerId, value.viewerId] } } })).toBe(2);
      // Repeating the step after completion changes nothing.
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime: value.runtime })).toBe("completed");
    } finally { await value.cleanup(); }
  });

  it("finalizes fenced Projects from the maintenance pass and leaves a Project that is not fenced", async () => {
    const value = await fixture();
    const unfenced = await fixture();
    try {
      await prisma.project.update({ where: { id: unfenced.projectId }, data: { deletionRequestedAt: null, status: "ACTIVE" } });
      for (let pass = 0; pass < 20 && await prisma.project.count({ where: { id: value.projectId } }); pass += 1) {
        await runProjectDeletionMaintenance({ prisma, runtime: value.runtime, limit: 50 });
      }
      expect(await prisma.project.findUnique({ where: { id: value.projectId } })).toBeNull();
      expect(await prisma.project.findUnique({ where: { id: unfenced.projectId } })).not.toBeNull();
      expect(await prisma.chat.findUnique({ where: { id: unfenced.chat.id } })).not.toBeNull();
    } finally { await value.cleanup(); await unfenced.cleanup(); }
  });

  it("without a Workspace runtime finalizes only fenced Projects whose chats hold no Workspace VM", async () => {
    const plain = await fixture();
    const withVm = await fixture();
    try {
      await withVm.workspace();
      for (let pass = 0; pass < 20 && await prisma.project.count({ where: { id: plain.projectId } }); pass += 1) {
        await runProjectDeletionMaintenance({ prisma, limit: 50 });
      }
      expect(await prisma.project.findUnique({ where: { id: plain.projectId } })).toBeNull();
      // Never claimed or failed: Workspace maintenance removes the VM first.
      expect(await prisma.project.findUnique({ where: { id: withVm.projectId } })).toMatchObject({
        deletionClaimToken: null, deletionLastAttemptAt: null, deletionLastErrorCode: null, status: "DELETING"
      });
      for (let pass = 0; pass < 20 && await prisma.project.count({ where: { id: withVm.projectId } }); pass += 1) {
        await runProjectDeletionMaintenance({ prisma, runtime: withVm.runtime, limit: 50 });
      }
      expect(await prisma.project.findUnique({ where: { id: withVm.projectId } })).toBeNull();
    } finally { await plain.cleanup(); await withVm.cleanup(); }
  });

  it("records a failed attempt while a run is active and finishes once the run settled", async () => {
    const value = await fixture();
    try {
      const answer = await prisma.message.create({ data: { chatId: value.chat.id, role: "assistant", parentMessageId: value.message.id,
        content: { blocks: [] } } });
      // A Project run carries its binding (a deferred database check).
      const run = await prisma.$transaction(async (tx) => {
        const created = await tx.modelRun.create({ data: { assistantMessageId: answer.id, chatId: value.chat.id, modelId: "fake-qsa",
          normalizedRequest: {}, provider: "fake", status: "streaming", userId: value.ownerId, userMessageId: value.message.id } });
        await tx.projectRunBinding.create({ data: { acceptedRole: "OWNER", accessRevision: 1, initiatorUserId: value.ownerId,
          instructionsRevision: 1, memoryRevision: 0, modelRunId: created.id, personalMemoryDisabled: true, policyRevision: 1,
          projectId: value.projectId } });
        return created;
      });
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime: value.runtime })).toBe("failed");
      expect(await prisma.project.findUnique({ where: { id: value.projectId } })).toMatchObject({
        deletionClaimToken: null, deletionLastErrorCode: "project_deletion_failed", status: "DELETING"
      });
      await prisma.modelRun.update({ where: { id: run.id }, data: { status: "cancelled" } });
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime: value.runtime })).toBe("completed");
      expect(await prisma.modelRun.findUnique({ where: { id: run.id } })).toBeNull();
    } finally { await value.cleanup(); }
  });

  it("keeps concurrent attempts pending while one worker owns the deletion", async () => {
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
      const runtime = { ...value.runtime, removeSession };
      pending = finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime });
      await started;
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime })).toBe("pending");
      expect(removeSession).toHaveBeenCalledOnce();
      release();
      expect(await pending).toBe("completed");
    } finally { release(); await pending; await value.cleanup(); }
  });

  it("retains a failed final transaction for a later worker retry", async () => {
    const value = await fixture();
    try {
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

  it("recovers an expired worker claim", async () => {
    const value = await fixture();
    try {
      await prisma.project.update({ where: { id: value.projectId }, data: {
        deletionClaimExpiresAt: new Date(0), deletionClaimToken: randomUUID(), deletionRequestedAt: new Date(0)
      } });
      await prisma.user.update({ where: { id: value.ownerId }, data: { status: "disabled" } });
      expect(await finalizeProjectDeletion({ prisma, projectId: value.projectId, runtime: value.runtime })).toBe("completed");
    } finally { await value.cleanup(); }
  });
});
