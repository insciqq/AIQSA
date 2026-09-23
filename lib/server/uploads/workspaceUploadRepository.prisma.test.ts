// @vitest-environment node
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createWorkspaceUploadRepository } from "./workspaceUploadRepository";
import { WorkspaceUploadService } from "./workspaceUploadService";
import { createFileSystemStorageAdapter } from "./storage";
import { WORKSPACE_UPLOAD_LEASE_MS } from "./workspaceUploadConfig";

const repository = createWorkspaceUploadRepository(prisma);
const checksum = createHash("sha256").update("abc").digest("hex");
const input = (userId: string, projectId: string | null = null) => ({ userId, projectId,
  idempotencyKey: randomUUID(), byteSize: 3, fileName: "original.bin", mimeType: "application/octet-stream" });

async function owner() {
  const user = await prisma.user.create({ data: { displayName: "Disposable upload test", status: "active" } });
  return { user, async cleanup() {
    const uploads = await prisma.attachmentUpload.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.attachmentUpload.deleteMany({ where: { id: { in: uploads.map(row => row.id) } } });
  } };
}
async function readyPart(id: string, userId: string) {
  const claim = await repository.claimPart({ id, userId, partNumber: 1, checksum });
  expect(await repository.finishPart({ id, userId, objectId: claim.part.id, claimToken: claim.part.claimToken!, ready: true })).toBe(true);
  return claim.part;
}

describe("durable Workspace uploads", () => {
  afterAll(() => prisma.$disconnect());

  it("serializes idempotent create/part/complete and fences cancellation while bytes are in flight", async () => {
    const fixture = await owner();
    try {
      const request = input(fixture.user.id);
      const [first, repeated] = await Promise.all([repository.create(request), repository.create(request)]);
      expect(first.id).toBe(repeated.id);
      await expect(repository.create({ ...request, fileName: "changed.bin" })).rejects.toMatchObject({ code: "upload_conflict" });
      await expect(repository.complete(first.id, fixture.user.id)).rejects.toMatchObject({ code: "upload_incomplete" });
      const claim = await repository.claimPart({ id: first.id, userId: fixture.user.id, partNumber: 1, checksum });
      await expect(repository.claimPart({ id: first.id, userId: fixture.user.id, partNumber: 1, checksum })).rejects.toMatchObject({ code: "upload_busy" });
      await repository.cancel(first.id, fixture.user.id);
      // Cleanup cannot remove an object until its writer has stopped or its lease expires.
      expect(await repository.claimCleanup()).toBeNull();
      expect(await repository.finishPart({ id: first.id, userId: fixture.user.id, objectId: claim.part.id, claimToken: claim.part.claimToken!, ready: true })).toBe(false);
      const cleanup = await repository.claimCleanup();
      expect(cleanup?.objects.map(object => object.storageKey)).toEqual([claim.part.storageKey]);
      await repository.finishCleanup(first.id, cleanup!.row.claimToken!);
      expect((await repository.get(first.id, fixture.user.id)).state).toBe("cancelled");
    } finally { await fixture.cleanup(); }
  });

  it("enforces owner limits and immutable part hashes independently of HTTP", async () => {
    const fixture = await owner();
    try {
      const rows = await Promise.all([repository.create(input(fixture.user.id)), repository.create(input(fixture.user.id))]);
      await expect(repository.create(input(fixture.user.id))).rejects.toMatchObject({ code: "upload_busy" });
      const part = await readyPart(rows[0]!.id, fixture.user.id);
      expect((await repository.claimPart({ id: rows[0]!.id, userId: fixture.user.id, partNumber: 1, checksum })).duplicate).toBe(true);
      await expect(repository.claimPart({ id: rows[0]!.id, userId: fixture.user.id, partNumber: 1, checksum: "0".repeat(64) })).rejects.toMatchObject({ code: "upload_part_conflict" });
      const completed = await Promise.all([repository.complete(rows[0]!.id, fixture.user.id), repository.complete(rows[0]!.id, fixture.user.id)]);
      expect(completed.map(row => row.state)).toEqual(["verifying", "verifying"]);
      expect(completed[0]!.objects.map(row => row.id)).toEqual([part.id]);
      await expect(repository.get(rows[0]!.id, "another-owner")).rejects.toMatchObject({ code: "upload_not_found" });
      await expect(repository.cancel(rows[0]!.id, "another-owner")).rejects.toMatchObject({ code: "upload_not_found" });
    } finally { await fixture.cleanup(); }
  });

  it("rechecks Project membership at settlement and preserves deletion obligations after Project deletion", async () => {
    const fixture = await owner();
    const manager = await owner();
    const project = await prisma.project.create({ data: { name: "Upload test", createdByDisplayName: "Test",
      grants: { create: [{ userId: manager.user.id, role: "OWNER" }, { userId: fixture.user.id, role: "CONTRIBUTOR" }] } } });
    let uploadId: string | null = null;
    try {
      const row = await repository.create(input(fixture.user.id, project.id)); uploadId = row.id;
      await readyPart(row.id, fixture.user.id);
      await repository.complete(row.id, fixture.user.id);
      const claim = await repository.claimSettlement(); expect(claim?.row.id).toBe(row.id);
      await prisma.projectGrant.deleteMany({ where: { projectId: project.id, userId: fixture.user.id } });
      await expect(repository.get(row.id, fixture.user.id)).rejects.toMatchObject({ code: "upload_not_found" });
      expect(await repository.settle({ id: row.id, claimToken: claim!.row.claimToken!, storageKey: claim!.output.storageKey, checksum })).toBe(false);
      expect(await prisma.attachment.count({ where: { projectId: project.id } })).toBe(0);
      await prisma.project.delete({ where: { id: project.id } });
      const cleanup = await repository.claimCleanup();
      expect(cleanup?.row.id).toBe(row.id); expect(cleanup?.row.projectScoped).toBe(true);
      expect(cleanup?.objects).toHaveLength(2);
      await repository.finishCleanup(row.id, cleanup!.row.claimToken!);
    } finally {
      await prisma.project.deleteMany({ where: { id: project.id } });
      if (uploadId) await prisma.attachmentUpload.deleteMany({ where: { id: uploadId } });
      await fixture.cleanup();
      await manager.cleanup();
    }
  });

  it("recovers an expired claim with a fresh output key and rejects the stale publisher", async () => {
    const fixture = await owner();
    try {
      const row = await repository.create(input(fixture.user.id));
      await readyPart(row.id, fixture.user.id); await repository.complete(row.id, fixture.user.id);
      const first = await repository.claimSettlement();
      const later = new Date(Date.now() + WORKSPACE_UPLOAD_LEASE_MS + 1_000);
      const second = await repository.claimSettlement(later);
      expect(second?.row.id).toBe(row.id); expect(second?.output.storageKey).not.toBe(first?.output.storageKey);
      expect(await repository.settle({ id: row.id, claimToken: first!.row.claimToken!, storageKey: first!.output.storageKey, checksum }, later)).toBe(false);
      expect(await repository.settle({ id: row.id, claimToken: second!.row.claimToken!, storageKey: second!.output.storageKey, checksum }, later)).toBe(true);
      expect((await repository.complete(row.id, fixture.user.id)).attachmentId).not.toBeNull();
      const cleanup = await repository.claimCleanup(later);
      expect(cleanup?.objects.map(object => object.storageKey)).toContain(first!.output.storageKey);
      expect(cleanup?.objects.map(object => object.storageKey)).not.toContain(second!.output.storageKey);
    } finally { await fixture.cleanup(); }
  });

  it("assembles, verifies and cleans parts through the real filesystem adapter after a worker restart", async () => {
    const fixture = await owner();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-upload-test-"));
    const storage = createFileSystemStorageAdapter(directory);
    const service = new WorkspaceUploadService({ repository, storage, available: async () => true });
    try {
      const row = await repository.create(input(fixture.user.id));
      await service.part(new Request("http://localhost/part", { method: "PUT", body: "abc",
        headers: { "content-type": "application/octet-stream", "x-upload-sha256": checksum } }), row.id, fixture.user.id, 1);
      await service.reconcileNow();
      // The durable complete transition must be sufficient for a new process.
      await repository.complete(row.id, fixture.user.id);
      const restarted = new WorkspaceUploadService({ repository, storage, available: async () => true });
      await restarted.reconcileNow();
      const ready = await repository.get(row.id, fixture.user.id);
      expect(ready.state).toBe("completed");
      expect(ready.attachment).toMatchObject({ kind: "file", status: "ready", checksum, extractedText: null, metadata: { workspaceOriginalOnly: true } });
      expect(ready.objects).toHaveLength(0);
      expect((await storage.getObject(ready.attachment!.storageKey)).body.toString()).toBe("abc");
      await restarted.reconcileNow();
      expect((await repository.get(row.id, fixture.user.id)).attachmentId).toBe(ready.attachmentId);
    } finally { service.stop(); await service.reconcileNow(); await fixture.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
});
