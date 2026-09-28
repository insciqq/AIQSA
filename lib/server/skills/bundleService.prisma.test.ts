import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import type { StorageAdapter } from "../uploads/storage";
import { createSkillBundle, parseSkillImport } from "./bundle";
import { createSkillBundleService } from "./bundleService";
import { createPrismaSkillRepository } from "./prismaRepository";
import { createSkillPreferenceService } from "./preferenceService";
import { readSkillZip } from "./zipReader";
import { createPrismaRetentionRepository } from "../retention/prune";

function storage() {
  const objects = new Map<string, Buffer>();
  return { objects, adapter: {
    async putObject(input) { objects.set(input.storageKey, input.body); },
    async getObject(storageKey) {
      const body = objects.get(storageKey);
      if (!body) throw new Error("missing_test_object");
      return { storageKey, body, contentType: "application/octet-stream" };
    },
    async deleteObject(storageKey) { objects.delete(storageKey); }
  } satisfies StorageAdapter };
}

async function fixture() {
  const owner = await prisma.user.create({ data: { displayName: "Bundle test", status: "active" } });
  const peer = await prisma.user.create({ data: { displayName: "Bundle peer", status: "active" } });
  const memory = storage();
  return { owner, peer, memory, service: createSkillBundleService(prisma, memory.adapter),
    repository: createPrismaSkillRepository(prisma),
    async cleanup() {
      const skills = await prisma.skillDefinition.findMany({ where: { ownerUserId: owner.id }, select: { id: true } });
      const ids = skills.map((skill) => skill.id);
      const files = await prisma.skillRevisionFile.findMany({ where: { skillId: { in: ids } }, select: { storageKey: true } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: ids } }, data: { currentRevisionId: null, sharedRevisionId: null } });
      await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: ids } } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: files.flatMap((file) => file.storageKey ? [file.storageKey] : []) } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, peer.id] } } });
    }
  };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function interceptTransactions(intercept: (tx: Prisma.TransactionClient, write: () => Promise<unknown>) => Promise<unknown>) {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (write: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
        target.$transaction((tx) => intercept(tx, () => write(tx)), { ...options, timeout: 15_000 });
    }
  });
}

describe("Skill bundle persistence", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("imports, deduplicates, preserves files through editing, and exports the exact owned revision", async () => {
    const f = await fixture();
    try {
      const bundle = createSkillBundle({ name: "bundle-test", description: "Synthetic workflow", instructions: "Read the reference.",
        frontmatterJson: { metadata: { owner: "fixture" } } }, [
        { path: "references/a.txt", bytes: Buffer.from("Reference data") },
        { path: "scripts/run", bytes: Buffer.from("#!/bin/sh\ntrue"), executable: true },
        { path: "assets/binary", bytes: Buffer.from([0, 255]) }
      ]);
      const first = await f.service.importCandidates(f.owner.id, [{ name: bundle.name, bundle }], 0);
      expect(first.results[0]).toMatchObject({ outcome: "created" });
      const created = first.results[0]!;
      if (created.outcome === "failed") throw new Error("fixture_import_failed");
      const skillId = created.skillId;
      expect((await f.repository.getForUser(f.owner.id, skillId))?.enabled).toBe(true);
      await createSkillPreferenceService(prisma).set(f.owner.id, skillId, false);
      const binaries = await prisma.skillRevisionFile.findMany({ where: { skillId, kind: "binary" } });
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { in: binaries.map((entry) => entry.storageKey!) } } });
      expect(jobs).toHaveLength(1);
      const claimable = await createPrismaRetentionRepository(prisma).findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(claimable).not.toContain(jobs[0]!.id);
      const repeat = await f.service.importCandidates(f.owner.id, [{ name: bundle.name, bundle }], 0);
      expect(repeat.results[0]).toMatchObject({ outcome: "unchanged", skillId });
      expect((await f.repository.getForUser(f.owner.id, skillId))?.enabled).toBe(false);
      expect(await prisma.skillRevision.count({ where: { skillId } })).toBe(1);
      await f.repository.revise(f.owner.id, skillId, 1, { name: bundle.name, description: bundle.description, instructions: "Updated procedure" });
      const detail = await f.repository.getForUser(f.owner.id, skillId);
      expect(detail?.enabled).toBe(false);
      expect(detail?.revision.files).toHaveLength(3);
      expect(detail?.revision.hasExecutables).toBe(true);
      const archive = await f.service.exportOwned(f.owner.id, skillId, 25_000_000);
      const exported = parseSkillImport(readSkillZip(archive)).candidates[0]!.bundle!;
      expect(exported.instructions).toBe("Updated procedure");
      expect(exported.bundleDigest).toBe(detail?.revision.bundleDigest);
      expect(await f.service.readFile(f.owner.id, skillId, "references/a.txt")).toMatchObject({ content: "Reference data" });
      await expect(f.service.exportOwned(f.peer.id, skillId, 25_000_000)).rejects.toThrow("skill_not_available");
      await expect(f.service.readFile(f.peer.id, skillId, "references/a.txt")).rejects.toThrow("skill_not_available");
      await expect(f.service.readFile(f.owner.id, skillId, "assets/binary")).rejects.toThrow("skill_file_binary");
      await expect(f.service.exportOwned(f.owner.id, skillId, 1)).rejects.toThrow("skill_limit_exceeded");
    } finally { await f.cleanup(); }
  });

  it("rejects ambiguous owned names while importing other candidates and retains archives", async () => {
    const f = await fixture();
    try {
      const draft = { name: "same", description: "Fixture workflow", instructions: "Original" };
      await f.repository.create(f.owner.id, draft);
      await f.repository.create(f.owner.id, draft);
      const bundle = createSkillBundle(draft);
      const other = createSkillBundle({ ...draft, name: "other" });
      const result = await f.service.importCandidates(f.owner.id, [{ name: bundle.name, bundle }, { name: other.name, bundle: other }], 3);
      expect(result).toMatchObject({ ignoredFiles: 3, results: [{ outcome: "failed", error: { code: "skill_name_ambiguous" } }, { outcome: "created" }] });
      const created = result.results[1]!;
      if (created.outcome === "failed") throw new Error("fixture_import_failed");
      await f.repository.setArchived(f.owner.id, created.skillId, 1, true);
      const replacement = createSkillBundle({ ...draft, name: "other", instructions: "Replacement" });
      const updated = await f.service.importCandidates(f.owner.id, [{ name: replacement.name, bundle: replacement }], 0);
      expect(updated.results[0]).toMatchObject({ outcome: "updated" });
      expect((await f.repository.getForUser(f.owner.id, created.skillId))?.archived).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("keeps explicit remote creates independent and preserves owner-only provenance through edits", async () => {
    const f = await fixture();
    try {
      const bundle = createSkillBundle({ name: "remote", description: "Fixture workflow", instructions: "Original remote" }, [
        { path: "references/a.txt", bytes: Buffer.from("Companion reference") }
      ]);
      const source = { kind: "github" as const, url: "https://github.com/example/skills", revision: "a".repeat(40), path: "remote", bundleDigest: bundle.bundleDigest };
      const first = await f.service.importRemoteCandidate(f.owner.id, bundle, { kind: "create" }, source);
      const second = await f.service.importRemoteCandidate(f.owner.id, bundle, { kind: "create" }, source);
      expect(first.outcome).toBe("created");
      expect(second.skillId).not.toBe(first.skillId);
      expect((await f.repository.getForUser(f.owner.id, first.skillId))?.importSource).toEqual(source);
      expect(await f.service.importRemoteCandidate(f.owner.id, bundle, { kind: "update", skillId: first.skillId, version: 1 }, source))
        .toEqual({ outcome: "unchanged", skillId: first.skillId });
      expect((await f.repository.getForUser(f.owner.id, first.skillId))?.version).toBe(1);
      await expect(f.service.importRemoteCandidate(f.peer.id, bundle, { kind: "update", skillId: first.skillId, version: 1 }, source))
        .rejects.toThrow("skill_not_available");
      const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: first.skillId } });
      await prisma.skillDefinition.update({ where: { id: first.skillId }, data: { sharedRevisionId: definition.currentRevisionId } });
      await prisma.skillPublication.create({ data: { skillId: first.skillId, scope: "installation", publishedByUserId: f.owner.id } });
      expect((await f.repository.getForUser(f.peer.id, first.skillId))?.importSource).toBeUndefined();
      expect(await f.repository.revise(f.owner.id, first.skillId, 1, { name: bundle.name, description: bundle.description, instructions: "Local edit" }))
        .toEqual({ kind: "ok", skillId: first.skillId });
      expect((await f.repository.getForUser(f.owner.id, first.skillId))?.importSource).toEqual(source);
      await expect(f.service.importRemoteCandidate(f.owner.id, bundle, { kind: "update", skillId: first.skillId, version: 1 }, source))
        .rejects.toThrow("skill_version_conflict");
      await f.service.importRemoteCandidate(f.owner.id, bundle, { kind: "update", skillId: first.skillId, version: 2 }, source);
      expect((await f.repository.getForUser(f.owner.id, first.skillId))?.revision.instructions).toBe("Original remote");
      expect((await f.repository.getForUser(f.peer.id, first.skillId))?.revision.id).toBe(definition.currentRevisionId);
      expect(await f.service.readFile(f.owner.id, first.skillId, "references/a.txt")).toMatchObject({ content: "Companion reference" });
      await prisma.skillPublication.deleteMany({ where: { skillId: first.skillId } });
    } finally { await f.cleanup(); }
  });

  it("fences a remote update after binary staging and leaves its previous source intact", async () => {
    const f = await fixture();
    const storing = signal(), releaseStorage = signal();
    let pending: Promise<unknown> | undefined;
    try {
      const draft = { name: "remote-race", description: "Fixture workflow", instructions: "Original" };
      const firstBundle = createSkillBundle(draft);
      const firstSource = { kind: "zip" as const, url: "https://example.test/skills.zip", revision: "a".repeat(64), path: ".", bundleDigest: firstBundle.bundleDigest };
      const first = await f.service.importRemoteCandidate(f.owner.id, firstBundle, { kind: "create" }, firstSource);
      const replacement = createSkillBundle({ ...draft, instructions: "Replacement" }, [{ path: "binary", bytes: Buffer.from([0, 255]) }]);
      const secondSource = { ...firstSource, revision: "b".repeat(64), bundleDigest: replacement.bundleDigest };
      const service = createSkillBundleService(prisma, { ...f.memory.adapter, async putObject(input) {
        storing.resolve();
        await releaseStorage.promise;
        await f.memory.adapter.putObject(input);
      } });
      const importing = service.importRemoteCandidate(f.owner.id, replacement, { kind: "update", skillId: first.skillId, version: 1 }, secondSource);
      pending = importing.catch(() => undefined);
      await Promise.race([storing.promise, importing.then(() => { throw new Error("import_finished_before_storage_barrier"); })]);
      expect(await f.repository.revise(f.owner.id, first.skillId, 1, { ...draft, instructions: "Concurrent edit" })).toMatchObject({ kind: "ok" });
      releaseStorage.resolve();
      await expect(importing).rejects.toThrow("skill_version_conflict");
      expect(await f.repository.getForUser(f.owner.id, first.skillId)).toMatchObject({
        version: 2, importSource: firstSource, revision: { instructions: "Concurrent edit" }
      });
    } finally {
      releaseStorage.resolve();
      await pending;
      await f.cleanup();
    }
  });

  it("leaves current content unchanged on failed binary settlement", async () => {
    const f = await fixture();
    try {
      const draft = { name: "unchanged", description: "Fixture workflow", instructions: "Original" };
      const skillId = await f.repository.create(f.owner.id, draft);
      const broken = createSkillBundleService(prisma, { ...f.memory.adapter, putObject: vi.fn(async () => { throw new Error("synthetic failure"); }) });
      const bundle = createSkillBundle({ ...draft, instructions: "Replacement" }, [{ path: "binary", bytes: Buffer.from([0]) }]);
      expect((await broken.importCandidates(f.owner.id, [{ name: bundle.name, bundle }], 0)).results[0]).toMatchObject({ outcome: "failed" });
      expect((await f.repository.getForUser(f.owner.id, skillId))?.revision.instructions).toBe("Original");
      expect(await prisma.skillRevision.count({ where: { skillId, bundleReady: false } })).toBe(1);
      const binaries = await prisma.skillRevisionFile.findMany({ where: { skillId, kind: "binary" } });
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { in: binaries.map((entry) => entry.storageKey!) } } });
      const claimable = await createPrismaRetentionRepository(prisma).findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.some((job) => claimable.includes(job.id))).toBe(false);
    } finally { await f.cleanup(); }
  });

  it("retries a stale editor snapshot during import allocation and rejects stale import promotion", async () => {
    const f = await fixture();
    const staged = signal();
    const releaseStage = signal();
    const editorSnapshot = signal();
    const releaseEditor = signal();
    const storing = signal();
    const releaseStorage = signal();
    const pending: Promise<unknown>[] = [];
    try {
      const draft = { name: "concurrent", description: "Synthetic workflow", instructions: "Original" };
      const skillId = await f.repository.create(f.owner.id, draft);
      let importTransactions = 0;
      const importClient = interceptTransactions(async (_tx, write) => {
        const result = await write();
        if (++importTransactions === 1) {
          staged.resolve();
          await releaseStage.promise;
        }
        return result;
      });
      const service = createSkillBundleService(importClient, { ...f.memory.adapter, async putObject(input) {
        storing.resolve();
        await releaseStorage.promise;
        await f.memory.adapter.putObject(input);
      } });
      const bundle = createSkillBundle({ ...draft, instructions: "Import" }, [{ path: "binary", bytes: Buffer.from([0]) }]);
      const importing = service.importCandidates(f.owner.id, [{ name: bundle.name, bundle }], 0);
      pending.push(importing);
      await Promise.race([staged.promise, importing.then(() => { throw new Error("import_finished_before_staging_barrier"); })]);

      let editorAttempts = 0;
      const editor = createPrismaSkillRepository(interceptTransactions(async (tx, write) => {
        if (++editorAttempts === 1) {
          // Establish the snapshot an editor gets when its advisory-lock query
          // starts before the importer commits. Barriers keep the race deterministic.
          await tx.$queryRaw`SELECT "version" FROM "SkillDefinition" WHERE "id" = ${skillId}`;
          editorSnapshot.resolve();
          await releaseEditor.promise;
        }
        return write();
      }));
      const editing = editor.revise(f.owner.id, skillId, 1, { ...draft, instructions: "Editor" });
      pending.push(editing);
      await Promise.race([editorSnapshot.promise, editing.then(() => { throw new Error("editor_finished_before_snapshot_barrier"); })]);
      releaseStage.resolve();
      await Promise.race([storing.promise, importing.then(() => { throw new Error("import_finished_before_storage_barrier"); })]);
      releaseEditor.resolve();

      expect(await editing).toEqual({ kind: "ok", skillId });
      expect(editorAttempts).toBeGreaterThan(1);
      releaseStorage.resolve();
      expect((await importing).results).toEqual([
        { name: bundle.name, outcome: "failed", error: { code: "skill_version_conflict" } }
      ]);
      const detail = await f.repository.getForUser(f.owner.id, skillId);
      expect(detail).toMatchObject({ version: 2, revision: { revisionNumber: 3, instructions: "Editor", fileCount: 0 } });
      const revisions = await prisma.skillRevision.findMany({ where: { skillId }, orderBy: { revisionNumber: "asc" },
        select: { revisionNumber: true, bundleReady: true } });
      expect(revisions).toEqual([
        { revisionNumber: 1, bundleReady: true }, { revisionNumber: 2, bundleReady: false }, { revisionNumber: 3, bundleReady: true }
      ]);
    } finally {
      releaseStage.resolve();
      releaseEditor.resolve();
      releaseStorage.resolve();
      await Promise.allSettled(pending);
      await f.cleanup();
    }
  });

  it("backfills old-writer text metadata without changing historical fields", async () => {
    const f = await fixture();
    try {
      const definition = await prisma.skillDefinition.create({ data: { ownerUserId: f.owner.id } });
      const id = randomUUID();
      await prisma.$executeRaw`INSERT INTO "SkillRevision" ("id", "skillId", "revisionNumber", "name", "instructions")
        VALUES (${id}, ${definition.id}, 1, ${"legacy"}, ${"Legacy instructions"})`;
      const row = await prisma.skillRevision.findUniqueOrThrow({ where: { id } });
      const expected = createSkillBundle({ name: "legacy", description: "", instructions: "Legacy instructions" });
      expect(row.description).toBe("");
      expect(row.schemaVersion).toBe(1);
      expect(row.bundleDigest).toBe(expected.bundleDigest);
      expect(row.bundleByteSize).toBe(expected.bundleByteSize);
    } finally { await f.cleanup(); }
  });
});
