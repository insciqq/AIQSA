import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createSkillBundle, parseSkillImport } from "../skills/bundle";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { createSkillPreferenceService } from "../skills/preferenceService";
import { readSkillZip } from "../skills/zipReader";
import type { StorageAdapter } from "../uploads/storage";
import { createSkillsStoreService, SkillsStoreError, type SkillsStoreAuthority } from "./service";

const draft = { name: "portable-fixture", description: "Synthetic portable workflow", instructions: "Read the references and use the template." };
const bundle = () => createSkillBundle({ ...draft, frontmatterJson: { metadata: { fixture: "true" } } }, [
  { path: "references/guide.txt", bytes: Buffer.from("Synthetic reference.") },
  { path: "scripts/check", bytes: Buffer.from("#!/bin/sh\ntrue\n"), executable: true },
  { path: "assets/template.docx", bytes: Buffer.from([0, 255, 17, 18]) }
]);
function signal() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const owner = await prisma.user.create({ data: { displayName: "Skill store owner", status: "active" } });
  const peer = await prisma.user.create({ data: { displayName: "Skill store peer", status: "active" } });
  const objects = new Map<string, Buffer>();
  const storage: StorageAdapter = {
    async putObject(input) { objects.set(input.storageKey, input.body); },
    async getObject(storageKey) { const body = objects.get(storageKey); if (!body) throw new Error("fixture_missing_object"); return { storageKey, body, contentType: "application/octet-stream" }; },
    async deleteObject(storageKey) { objects.delete(storageKey); }
  };
  let active = true;
  const authority = (userId = owner.id, clientId = "fixture-client"): SkillsStoreAuthority => ({
    userId, clientId,
    async assertActive() { if (!active) throw new SkillsStoreError("authorization_required"); },
    async assertTransaction() { if (!active) throw new SkillsStoreError("authorization_required"); }
  });
  return { owner, peer, storage, objects, authority, service: createSkillsStoreService(prisma, storage), repository: createPrismaSkillRepository(prisma),
    revoke() { active = false; }, restore() { active = true; },
    async cleanup() {
      const ownerIds = [owner.id, peer.id];
      const definitions = await prisma.skillDefinition.findMany({ where: { ownerUserId: { in: ownerIds } }, select: { id: true } });
      const ids = definitions.map((entry) => entry.id);
      const files = await prisma.skillRevisionFile.findMany({ where: { skillId: { in: ids } }, select: { storageKey: true } });
      await prisma.skillStoreOperation.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: ids } }, data: { currentRevisionId: null, sharedRevisionId: null } });
      await prisma.userSkillPreference.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: ids } } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: files.flatMap((entry) => entry.storageKey ? [entry.storageKey] : []) } } });
      await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    }
  };
}
describe("personal Skill store persistence and races", () => {
  afterAll(async () => { await prisma.$disconnect(); });
  it("round-trips full bundles owner-only, includes disabled Skills, opts into archived Skills and preserves shared revisions", async () => {
    const f = await fixture();
    try {
      const original = bundle(); const auth = f.authority();
      const created = await f.service.write(auth, { action: "create", operationKey: randomUUID(), bundle: original });
      await createSkillPreferenceService(prisma).set(f.owner.id, created.skillId, false);
      const list = await f.service.list(auth, {});
      expect(list.skills).toMatchObject([{ id: created.skillId, enabled: false }]);
      expect(list.skills[0]).not.toHaveProperty("instructions");
      const detail = await f.service.get(auth, created.skillId); expect(detail.files).toHaveLength(4);
      const downloaded = await f.service.archive(auth, created.skillId, 1);
      expect(parseSkillImport(readSkillZip(downloaded.bytes)).candidates[0]!.bundle?.bundleDigest).toBe(original.bundleDigest);
      const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: created.skillId } });
      await prisma.skillDefinition.update({ where: { id: created.skillId }, data: { sharedRevisionId: definition.currentRevisionId } });
      await prisma.skillPublication.create({ data: { skillId: created.skillId, scope: "installation", publishedByUserId: f.owner.id } });
      expect((await f.service.list(f.authority(f.peer.id), {})).skills).toHaveLength(0);
      await expect(f.service.get(f.authority(f.peer.id), created.skillId)).rejects.toThrow("skill_not_available");
      await expect(f.service.get(f.authority(f.peer.id), "missing")).rejects.toThrow("skill_not_available");
      const changed = createSkillBundle({ ...draft, instructions: "Updated local instructions." }, original.files);
      await f.service.write(auth, { action: "update", operationKey: randomUUID(), skillId: created.skillId, expectedVersion: 1, bundle: changed });
      const after = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: created.skillId } });
      expect(after.sharedRevisionId).toBe(definition.currentRevisionId);
      expect((await f.service.get(auth, created.skillId)).enabled).toBe(false);
      await f.repository.setArchived(f.owner.id, created.skillId, 2, true);
      expect((await f.service.list(auth, {})).skills).toHaveLength(0);
      expect((await f.service.list(auth, { includeArchived: true })).skills).toMatchObject([{ archived: true }]);
      expect((await f.service.archive(auth, created.skillId, 3)).bytes.length).toBeGreaterThan(0);
    } finally { await f.cleanup(); }
  });
  it("settles parallel/repeated creates once, detects changed payload, and does not match names", async () => {
    const f = await fixture();
    try {
      const args = { action: "create" as const, operationKey: randomUUID(), bundle: bundle() };
      const [first, repeat] = await Promise.all([f.service.write(f.authority(), args), f.service.write(f.authority(), args)]);
      expect(repeat).toEqual(first);
      expect(await prisma.skillDefinition.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
      await expect(f.service.write(f.authority(), { ...args, bundle: createSkillBundle({ ...draft, instructions: "Different" }) })).rejects.toThrow("operation_key_conflict");
      const duplicateName = await f.service.write(f.authority(), { ...args, operationKey: randomUUID() });
      expect(duplicateName.skillId).not.toBe(first.skillId);
      expect((await f.service.list(f.authority(), { limit: 1 })).nextCursor).not.toBeNull();
      expect(await prisma.skillRevision.count({ where: { skillId: first.skillId } })).toBe(1);
    } finally { await f.cleanup(); }
  });
  it("guards updates/deletes and returns original receipts after lost responses and newer edits", async () => {
    const f = await fixture();
    try {
      const auth = f.authority(); const original = bundle();
      const created = await f.service.write(auth, { action: "create", operationKey: randomUUID(), bundle: original });
      expect(await f.service.write(auth, { action: "update", skillId: created.skillId, expectedVersion: 1, operationKey: randomUUID(), bundle: original })).toMatchObject({ outcome: "unchanged", version: 1 });
      const update = { action: "update" as const, skillId: created.skillId, expectedVersion: 1, operationKey: randomUUID(), bundle: createSkillBundle({ ...draft, instructions: "Second version" }) };
      const updated = await f.service.write(auth, update); expect(updated.version).toBe(2);
      await f.repository.revise(f.owner.id, created.skillId, 2, { ...draft, instructions: "Third version" });
      expect(await f.service.write(auth, update)).toEqual(updated);
      expect((await f.service.get(auth, created.skillId)).version).toBe(3);
      await expect(f.service.write(auth, { ...update, operationKey: randomUUID() })).rejects.toThrow("skill_version_conflict");
      await expect(f.service.delete(auth, { skillId: created.skillId, expectedVersion: 2, operationKey: randomUUID() })).rejects.toThrow("skill_version_conflict");
      const deletion = { skillId: created.skillId, expectedVersion: 3, operationKey: randomUUID() };
      const deleted = await f.service.delete(auth, deletion); expect(deleted.outcome).toBe("deleted");
      expect(await f.service.delete(auth, deletion)).toEqual(deleted);
      await expect(f.service.get(auth, created.skillId)).rejects.toThrow("skill_not_available");
      expect(await prisma.skillRevision.count({ where: { skillId: created.skillId } })).toBe(3);
      f.revoke(); await expect(f.service.delete(auth, deletion)).rejects.toThrow("authorization_required");
    } finally { await f.cleanup(); }
  });
  it("keeps failed uploads private and resumes the same immutable staged revision", async () => {
    const f = await fixture();
    try {
      const failing = createSkillsStoreService(prisma, { ...f.storage, async putObject() { throw new Error("fixture_storage_failure"); } });
      const input = { action: "create" as const, operationKey: randomUUID(), bundle: bundle() };
      await expect(failing.write(f.authority(), input)).rejects.toThrow("fixture_storage_failure");
      expect((await f.service.list(f.authority(), {})).skills).toHaveLength(0);
      expect(await prisma.skillRevision.count({ where: { authorUserId: f.owner.id, bundleReady: false } })).toBe(1);
      const result = await f.service.write(f.authority(), input);
      expect(result.outcome).toBe("created");
      expect(await prisma.skillRevision.count({ where: { skillId: result.skillId } })).toBe(1);
      expect(await prisma.skillStoreOperation.count({ where: { ownerUserId: f.owner.id, status: "COMPLETED" } })).toBe(1);
    } finally { await f.cleanup(); }
  });
  it("revalidates authority and version after storage, and suppresses revoked downloads", async () => {
    const f = await fixture(); const storing = signal(); const release = signal(); let pending: Promise<unknown> | undefined;
    try {
      const slow = createSkillsStoreService(prisma, { ...f.storage, async putObject(input) {
        storing.resolve(); await release.promise; await f.storage.putObject(input);
      } });
      const writing = slow.write(f.authority(), { action: "create", operationKey: randomUUID(), bundle: bundle() });
      pending = writing.catch(() => undefined);
      await storing.promise; f.revoke(); release.resolve();
      await expect(writing).rejects.toThrow("authorization_required");
      expect(await prisma.skillDefinition.count({ where: { ownerUserId: f.owner.id, currentRevisionId: { not: null } } })).toBe(0);
      f.restore();
      const created = await f.service.write(f.authority(), { action: "create", operationKey: randomUUID(), bundle: bundle() });
      const revokedRead = createSkillsStoreService(prisma, { ...f.storage, async getObject(key, options) {
        const value = await f.storage.getObject(key, options); f.revoke(); return value;
      } });
      await expect(revokedRead.archive(f.authority(), created.skillId, created.version)).rejects.toThrow("authorization_required");
    } finally { release.resolve(); await pending; await f.cleanup(); }
  });
});
