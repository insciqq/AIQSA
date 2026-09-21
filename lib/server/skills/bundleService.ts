import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_ARCHIVE_MAX_ENTRIES, SKILL_FILE_MAX_BYTES, type SkillImportResponse } from "../../contracts/skills";
import { skillAlias } from "../../domain/skillBundlePaths";
import { writeZip } from "../artifacts/zip";
import type { StorageAdapter } from "../uploads/storage";
import { createSkillBundle, renderSkillMarkdown, skillExportEntries, type SkillBundle, type SkillImportCandidate } from "./bundle";
import { SkillBundleError, skillLimit } from "./bundleErrors";
import { lockSkillRevisionWrites, retrySkillRevisionWrite, skillAccessWhere } from "./prismaRepository";

const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function createSkillBundleService(db: PrismaClient, storage: StorageAdapter) {
  async function importOne(userId: string, bundle: SkillBundle) {
    // Stage immutable rows before object I/O. They remain private until the
    // checksum-verified revision becomes current, and protect their objects from pruning.
    const staged = await retrySkillRevisionWrite(() => db.$transaction(async (tx) => {
      await lockSkillRevisionWrites(tx, userId);
      const matches = await tx.skillDefinition.findMany({ where: {
        ownerUserId: userId, deletedAt: null,
        OR: [{ currentRevision: { name: bundle.name } }, { currentRevisionId: null, revisions: { some: { name: bundle.name } } }]
      }, include: { currentRevision: true }, take: 2 });
      if (matches.length > 1) throw new SkillBundleError({ code: "skill_name_ambiguous" });
      const existing = matches[0];
      if (existing?.currentRevision?.bundleDigest === bundle.bundleDigest) {
        return { unchanged: true as const, skillId: existing.id };
      }
      const definition = existing ?? await tx.skillDefinition.create({ data: { ownerUserId: userId } });
      const latest = await tx.skillRevision.aggregate({ where: { skillId: definition.id }, _max: { revisionNumber: true } });
      const revision = await tx.skillRevision.create({ data: {
        skillId: definition.id, revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
        authorUserId: userId, schemaVersion: 2, name: bundle.name, description: bundle.description,
        instructions: bundle.instructions, frontmatterJson: bundle.frontmatterJson ?? Prisma.DbNull,
        bundleDigest: bundle.bundleDigest, fileCount: bundle.fileCount, bundleByteSize: bundle.bundleByteSize,
        hasExecutables: bundle.hasExecutables, bundleReady: false
      } });
      const files = bundle.files.map((file) => ({
        revisionId: revision.id, skillId: definition.id, path: file.path, byteSize: file.byteSize,
        checksum: file.checksum, kind: file.kind, executable: file.executable,
        textContent: file.textContent,
        storageKey: file.kind === "binary" ? `skills/${definition.id}/${revision.id}/${randomUUID()}` : null
      }));
      if (files.length) await tx.skillRevisionFile.createMany({ data: files });
      const binaries = files.filter((file): file is typeof file & { storageKey: string } => file.storageKey !== null);
      if (binaries.length) await tx.attachmentDeletionJob.createMany({ data: binaries.map((file) => ({ storageKey: file.storageKey })) });
      return { unchanged: false as const, skillId: definition.id, revisionId: revision.id, files: binaries,
        expectedVersion: definition.version, expectedCurrentRevisionId: definition.currentRevisionId, created: !existing?.currentRevisionId };
    }), () => { throw new SkillBundleError({ code: "skill_version_conflict" }); });
    if (staged.unchanged) return { outcome: "unchanged" as const, skillId: staged.skillId };
    for (const file of staged.files) {
      const bytes = bundle.files.find((entry) => entry.path === file.path)!.bytes;
      await storage.putObject({ storageKey: file.storageKey, contentType: "application/octet-stream", body: bytes });
      const stored = await storage.getObject(file.storageKey, { maxBytes: Math.max(1, file.byteSize) });
      if (stored.body.length !== file.byteSize || checksum(stored.body) !== file.checksum) {
        throw new SkillBundleError({ code: "skill_bundle_integrity_failed" });
      }
    }
    await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ version: number; deletedAt: Date | null; currentRevisionId: string | null }>>`
        SELECT "version", "deletedAt", "currentRevisionId" FROM "SkillDefinition"
        WHERE "id" = ${staged.skillId} AND "ownerUserId" = ${userId} FOR UPDATE`;
      if (!locked[0] || locked[0].deletedAt || locked[0].version !== staged.expectedVersion ||
        locked[0].currentRevisionId !== staged.expectedCurrentRevisionId) {
        throw new SkillBundleError({ code: "skill_version_conflict" });
      }
      await tx.skillRevision.update({ where: { id: staged.revisionId }, data: { bundleReady: true } });
      await tx.skillDefinition.update({ where: { id: staged.skillId }, data: {
        currentRevisionId: staged.revisionId, ...(staged.created ? {} : { version: { increment: 1 } })
      } });
    });
    return { outcome: staged.created ? "created" as const : "updated" as const, skillId: staged.skillId };
  }

  async function importCandidates(userId: string, candidates: readonly SkillImportCandidate[], ignoredFiles: number): Promise<SkillImportResponse> {
    const results: SkillImportResponse["results"] = [];
    for (const candidate of candidates) {
      if (candidate.error) {
        results.push({ name: candidate.name, outcome: "failed", error: candidate.error });
        continue;
      }
      try { results.push({ name: candidate.name, ...await importOne(userId, candidate.bundle) }); }
      catch (error) {
        results.push({ name: candidate.name, outcome: "failed", error: error instanceof SkillBundleError
          ? error.issue : { code: "skill_import_failed" } });
      }
    }
    return { results, ignoredFiles };
  }

  async function exportOwned(userId: string, skillId: string | undefined, maxZipBytes: number): Promise<Buffer> {
    const definitions = await db.skillDefinition.findMany({ where: {
      ownerUserId: userId, deletedAt: null, currentRevisionId: { not: null }, ...(skillId ? { id: skillId } : {})
    }, include: { currentRevision: { select: {
      id: true, name: true, description: true, frontmatterJson: true,
      bundleReady: true, bundleByteSize: true, fileCount: true
    } } },
    orderBy: { id: "asc" }, take: SKILL_ARCHIVE_MAX_ENTRIES + 1 });
    if (skillId && !definitions.length) throw new SkillBundleError({ code: "skill_not_available" });
    // Preflight all metadata before reading binary objects or assembling the ZIP.
    let count = 0;
    let bytes = 0;
    const aliases = new Set<string>();
    for (const definition of definitions) {
      const revision = definition.currentRevision!;
      if (!revision.bundleReady) throw new SkillBundleError({ code: "skill_not_available" });
      count += 1 + revision.fileCount;
      const alias = skillAlias(revision.name, aliases);
      const metadata = { ...revision, instructions: "" };
      bytes += revision.bundleByteSize + Buffer.byteLength(renderSkillMarkdown(metadata, alias)) - Buffer.byteLength(renderSkillMarkdown(metadata));
      skillLimit("archiveEntries", count, SKILL_ARCHIVE_MAX_ENTRIES);
      skillLimit("archiveBytes", bytes, SKILL_ARCHIVE_MAX_BYTES);
    }
    const bundles: SkillBundle[] = [];
    for (const definition of definitions) {
      const revision = await db.skillRevision.findUniqueOrThrow({
        where: { id: definition.currentRevision!.id }, include: { files: { orderBy: { path: "asc" } } }
      });
      const files = [];
      for (const file of revision.files) {
        const bytes = file.textContent !== null ? Buffer.from(file.textContent)
          : (await storage.getObject(file.storageKey!, { maxBytes: Math.min(SKILL_FILE_MAX_BYTES, Math.max(1, file.byteSize)) })).body;
        if (bytes.length !== file.byteSize || checksum(bytes) !== file.checksum) throw new SkillBundleError({ code: "skill_bundle_integrity_failed" });
        files.push({ path: file.path, bytes, executable: file.executable });
      }
      bundles.push(createSkillBundle(revision, files));
    }
    const zip = writeZip(skillExportEntries(bundles));
    skillLimit("zipBytes", zip.length, maxZipBytes);
    return zip;
  }

  async function readFile(userId: string, skillId: string, path: string) {
    const definition = await db.skillDefinition.findFirst({ where: {
      id: skillId, deletedAt: null, ...skillAccessWhere(userId)
    }, include: { currentRevision: { include: { files: { where: { path } } } }, sharedRevision: { include: { files: { where: { path } } } } } });
    const revision = definition?.ownerUserId === userId ? definition.currentRevision : definition?.sharedRevision;
    if (!revision?.bundleReady) throw new SkillBundleError({ code: "skill_not_available" });
    const file = revision.files[0];
    if (!file) throw new SkillBundleError({ code: "skill_file_not_found" });
    if (file.kind !== "text" || file.textContent === null) throw new SkillBundleError({ code: "skill_file_binary" });
    return { path: file.path, content: file.textContent, bytes: file.byteSize };
  }

  return { importCandidates, exportOwned, readFile };
}

export type SkillBundleService = ReturnType<typeof createSkillBundleService>;
