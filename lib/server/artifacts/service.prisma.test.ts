// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ArtifactOperation } from "@/lib/contracts/artifacts";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "@/lib/contracts/memory";
import { prisma } from "../prisma";
import { scheduleTemporaryChatDeletion, temporaryRetentionDeadline } from "../memory/temporaryRetention";
import type { StorageAdapter, StoredObjectInput } from "../uploads/storage";
import { createPrismaRetentionRepository } from "../retention/prune";
import { createArtifactService } from "./service";

const operation: ArtifactOperation = { intent: "create", kind: "game", title: "Counter", entrypoint: "index.html",
  files: [{ path: "index.html", mimeType: "text/html", text: '<button id="count">Count</button><script>let n=0;count.onclick=()=>count.textContent=String(++n)</script>' }] };
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}
async function fixture(temporary = false) {
  const { owner, chat } = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.create({ data: { id: `artifact-test-${randomUUID()}`, displayName: "Artifact test" } });
    const now = new Date();
    const deadline = temporary ? temporaryRetentionDeadline(now) : null;
    const chat = await tx.chat.create({ data: { userId: owner.id, title: "Artifact test", memoryMode: temporary ? "TEMPORARY" : "EXCLUDED",
      ...(deadline ? { temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION, temporaryRetentionDeadline: deadline } : {}) } });
    if (deadline) await scheduleTemporaryChatDeletion(tx, { chatId: chat.id, deadline, now, userId: owner.id });
    return { owner, chat };
  });
  const objects = new Map<string, StoredObjectInput>();
  let beforePut: ((value: StoredObjectInput) => Promise<void>) | undefined;
  const storage: StorageAdapter = {
    async putObject(value) { await beforePut?.(value); objects.set(value.storageKey, { ...value, body: Buffer.from(value.body) }); },
    async getObject(key) { const value = objects.get(key); if (!value) throw new Error("missing_object"); return { ...value, body: Buffer.from(value.body) }; },
    async deleteObject(key) { objects.delete(key); }
  };
  const service = createArtifactService(prisma, storage);
  return { owner, chat, service, storage, objects, setBeforePut(value: typeof beforePut) { beforePut = value; },
    async cleanup() {
      if (temporary) {
        await prisma.$transaction(async (tx) => {
          await tx.memoryDeletionOutbox.updateMany({ where: { userId: owner.id, operation: "TEMPORARY_DELETE" }, data: {
            state: "RUNNING", leaseToken: "artifact-test-cleanup", leaseExpiresAt: new Date(Date.now() + 60_000), completedAt: null, nextAttemptAt: null
          } });
          await tx.chat.deleteMany({ where: { userId: owner.id } });
        });
        await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: owner.id } });
      }
      await prisma.user.deleteMany({ where: { id: owner.id } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { contains: owner.id } } });
    } };
}

describe("artifact settlement and lifecycle in PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("keeps temporary chats outside durable artifact creation and editing", async () => {
    const f = await fixture(true);
    try {
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, operation }))!;
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation })).rejects.toThrow("artifact_not_found");
      await expect(f.service.prepareEdit({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id, chatId: f.chat.id })).rejects.toThrow("artifact_chat_unavailable");
      expect(await prisma.artifactChatBinding.count({ where: { chatId: f.chat.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("rejects an oversized image set before reading objects or allocating a version", async () => {
    const f = await fixture();
    try {
      const images = await Promise.all(["one", "two"].map((name) => prisma.attachment.create({ data: {
        userId: f.owner.id, chatId: f.chat.id, fileName: `${name}.png`, mimeType: "image/png", kind: "image", status: "ready",
        byteSize: 20 * 1024 * 1024, storageKey: `source/${f.owner.id}/${name}.png`, metadata: {}
      } })));
      // No objects exist: an attempted storage read would fail with missing_object.
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: {
        intent: "create", kind: "image", title: "Too large", files: images.map((image, index) => ({
          path: `image-${index}.png`, mimeType: "image/png", assetRef: image.id
        }))
      } })).rejects.toThrow("artifact_bundle_limit_exceeded");
      expect(await prisma.artifact.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("serializes concurrent updates while storage is slow and preserves the previous ready version", async () => {
    const f = await fixture(); const entered = barrier(); const release = barrier();
    let pending: ReturnType<typeof f.service.createVersion> | undefined;
    try {
      const v1 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation }))!;
      f.setBeforePut(async () => { entered.release(); await release.wait; });
      const update = { ...operation, intent: "update" as const, baseVersionId: v1.id, title: "Updated" };
      pending = f.service.createVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, operation: update });
      await entered.wait;
      expect((await prisma.artifact.findUniqueOrThrow({ where: { id: v1.artifactId } })).currentVersionId).toBe(v1.id);
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, operation: update })).rejects.toThrow("artifact_version_conflict");
      release.release(); const v2 = (await pending)!;
      expect(v2.versionNumber).toBe(2);
      expect((await f.service.getArtifactVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, versionId: v1.id }))?.title).toBe("Counter");
      expect(await f.service.getPrivateBundle({ ownerUserId: "other-user", artifactId: v1.artifactId })).toBeNull();
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, operation: update })).rejects.toThrow("artifact_version_conflict");
    } finally { release.release(); await pending?.catch(() => undefined); await f.cleanup(); }
  });

  it("fences a publication against concurrent archive and retains cleanup jobs", async () => {
    const f = await fixture(); const entered = barrier(); const release = barrier();
    let publishing: Promise<unknown> | undefined;
    try {
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, operation }))!;
      f.setBeforePut(async (value) => { if (value.storageKey.startsWith("artifact-publications/")) { entered.release(); await release.wait; } });
      publishing = f.service.publish({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id }).catch(error => error);
      await entered.wait;
      expect(await f.service.archive({ ownerUserId: f.owner.id, artifactId: version.artifactId })).toBe(true);
      release.release(); expect(await publishing).toMatchObject({ message: "artifact_publication_unavailable" });
      expect(await prisma.artifactPublication.count({ where: { artifactId: version.artifactId, status: "READY" } })).toBe(0);
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { contains: f.owner.id } } })).toBe(2);
    } finally { release.release(); await publishing; await f.cleanup(); }
  });

  it("copies selected image bytes, survives source deletion, and fails closed on revocation, expiry and corruption", async () => {
    const f = await fixture();
    try {
      const bytes = Buffer.from("synthetic-image-bytes");
      const source = await prisma.attachment.create({ data: { userId: f.owner.id, chatId: f.chat.id, fileName: "private-name.png", mimeType: "image/png",
        kind: "image", status: "ready", byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), storageKey: `source/${f.owner.id}/image.png`, metadata: {} } });
      f.objects.set(source.storageKey, { body: bytes, contentType: source.mimeType, storageKey: source.storageKey });
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id,
        operation: { intent: "create", kind: "image", title: "Picture", files: [{ path: "image.png", mimeType: "image/png", assetRef: source.id }] } }))!;
      expect(JSON.stringify(version.manifest)).not.toContain(source.id);
      const pub = await f.service.publish({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id });
      await prisma.attachment.delete({ where: { id: source.id } }); f.objects.delete(source.storageKey);
      expect((await f.service.publicBundle(pub.shareToken))?.body).toEqual(bytes);
      expect(JSON.stringify((await f.service.publicBundle(pub.shareToken))?.manifest)).not.toContain(source.id);
      expect(JSON.stringify((await f.service.publicBundle(pub.shareToken))?.manifest)).not.toContain(source.fileName);
      const retention = createPrismaRetentionRepository(prisma);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { contains: f.owner.id } } });
      const prunable = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.some(job => prunable.includes(job.id))).toBe(false);
      await prisma.artifactPublication.update({ where: { id: pub.id }, data: { expiresAt: new Date(0) } });
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await prisma.artifactPublication.update({ where: { id: pub.id }, data: { expiresAt: null } });
      const row = await prisma.artifactPublication.findUniqueOrThrow({ where: { id: pub.id } });
      f.objects.set(row.bundleStorageKey, { body: Buffer.from("corrupted"), contentType: "application/json", storageKey: row.bundleStorageKey });
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      expect(await f.service.revoke({ ownerUserId: f.owner.id, publicationId: pub.id })).toBe(true);
      expect(await f.service.revoke({ ownerUserId: f.owner.id, publicationId: pub.id })).toBe(true);
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await prisma.user.delete({ where: { id: f.owner.id } });
      expect(await prisma.artifact.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { contains: f.owner.id } } })).toBe(2);
    } finally { await f.cleanup(); }
  });

  it("restores historical versions, preserves archived bytes, and releases objects only on permanent deletion", async () => {
    const f = await fixture();
    try {
      const v1 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation }))!;
      const v2 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: { ...operation, title: "Second", intent: "update", baseVersionId: v1.id } }))!;
      const pub = await f.service.publish({ ownerUserId: f.owner.id, artifactId: v1.artifactId, versionId: v2.id });
      await f.service.restoreVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, versionId: v1.id });
      expect((await f.service.contextForChat({ ownerUserId: f.owner.id, chatId: f.chat.id }))[0]?.base_version_id).toBe(v1.id);
      const v3 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: { ...operation, title: "Restored edit", intent: "update", baseVersionId: v1.id } }))!;
      expect(v3.versionNumber).toBe(3);
      expect((await f.service.list(f.owner.id))[0]?.versions[0]?.id).toBe(v3.id);
      await f.service.setArchived({ ownerUserId: f.owner.id, artifactId: v1.artifactId, archived: true });
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      expect(await f.service.list(f.owner.id)).toHaveLength(0);
      expect(await f.service.list(f.owner.id, true)).toHaveLength(1);
      const retention = createPrismaRetentionRepository(prisma);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { contains: f.owner.id } } });
      const claimable = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      const version = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: v3.id } });
      expect(claimable).not.toContain(jobs.find(job => job.storageKey === version.bundleStorageKey)?.id);
      await f.service.setArchived({ ownerUserId: f.owner.id, artifactId: v1.artifactId, archived: false });
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: v1.artifactId }))?.version.id).toBe(v3.id);
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await f.service.remove({ ownerUserId: f.owner.id, artifactId: v1.artifactId });
      const released = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(released).toEqual(expect.arrayContaining(jobs.map(job => job.id)));
    } finally { await f.cleanup(); }
  });

  it("expires an interrupted writer without letting its late completion overwrite a newer edit", async () => {
    const f = await fixture(); const entered = barrier(); const release = barrier();
    let pending: Promise<unknown> | undefined;
    try {
      const v1 = (await f.service.createVersion({ ownerUserId: f.owner.id, operation }))!;
      f.setBeforePut(async () => { entered.release(); await release.wait; });
      pending = f.service.createVersion({ ownerUserId: f.owner.id, operation: { ...operation, intent: "update", baseVersionId: v1.id } }).catch(error => error);
      await entered.wait;
      await prisma.artifactVersion.updateMany({ where: { artifactId: v1.artifactId, status: "PENDING" }, data: { createdAt: new Date(0) } });
      f.setBeforePut(undefined);
      const v3 = (await f.service.createVersion({ ownerUserId: f.owner.id, operation: { ...operation, title: "Recovered", intent: "update", baseVersionId: v1.id } }))!;
      release.release();
      expect(await pending).toMatchObject({ message: "artifact_version_settlement_conflict" });
      expect((await f.service.getArtifactVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId }))?.id).toBe(v3.id);
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: v1.artifactId }))?.version.title).toBe("Recovered");
    } finally { release.release(); await pending; await f.cleanup(); }
  });

  it("does not advance ready state after a failed write and safely retries from the prior version", async () => {
    const f = await fixture();
    try {
      const first = (await f.service.createVersion({ ownerUserId: f.owner.id, operation, sourceToolCallId: randomUUID() }))!;
      f.setBeforePut(async () => { throw new Error("storage_unavailable"); });
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, artifactId: first.artifactId,
        operation: { ...operation, intent: "update", baseVersionId: first.id } })).rejects.toThrow("storage_unavailable");
      expect((await prisma.artifact.findUniqueOrThrow({ where: { id: first.artifactId } })).currentVersionId).toBe(first.id);
      f.setBeforePut(undefined);
      const next = (await f.service.createVersion({ ownerUserId: f.owner.id, artifactId: first.artifactId,
        operation: { ...operation, intent: "update", baseVersionId: first.id } }))!;
      expect(next.versionNumber).toBe(3);
      expect(next.status).toBe("READY");
    } finally { await f.cleanup(); }
  });
});
