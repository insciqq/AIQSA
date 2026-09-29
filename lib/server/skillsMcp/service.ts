import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { SkillStoreDetail, SkillStoreDownload, SkillStoreEntry, SkillStoreMutationResult } from "../../contracts/skillsMcp";
import { SKILL_FILE_MAX_BYTES } from "../../contracts/skills";
import { skillAlias } from "../../domain/skillBundlePaths";
import { writeZip } from "../artifacts/zip";
import { createSkillBundle, renderSkillMarkdown, type SkillBundle } from "../skills/bundle";
import { deleteOwnedSkillInTransaction, lockSkillRevisionWrites } from "../skills/prismaRepository";
import type { StorageAdapter } from "../uploads/storage";

export type SkillsStoreAuthority = {
  userId: string; clientId: string;
  assertActive(access: "read" | "write"): Promise<void>;
  assertTransaction(tx: Prisma.TransactionClient, access: "read" | "write"): Promise<void>;
};
export class SkillsStoreError extends Error {
  constructor(readonly code: "authorization_required" | "insufficient_scope" | "skill_not_available" |
    "skill_version_conflict" | "operation_key_conflict" | "skill_bundle_integrity_failed" | "invalid_arguments") {
    super(code); this.name = "SkillsStoreError";
  }
}
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const projection = {
  currentRevision: { include: { files: { orderBy: { path: "asc" as const },
    select: { path: true, byteSize: true, checksum: true, executable: true } } } },
  preferences: { select: { userId: true, enabled: true } }
};
type Definition = Prisma.SkillDefinitionGetPayload<{ include: typeof projection }>;
const summaryProjection = {
  id: true, ownerUserId: true, version: true, archivedAt: true, updatedAt: true,
  preferences: { select: { userId: true, enabled: true } },
  currentRevision: { select: { name: true, description: true, bundleDigest: true, bundleByteSize: true, fileCount: true } }
} satisfies Prisma.SkillDefinitionSelect;
type SummaryDefinition = Prisma.SkillDefinitionGetPayload<{ select: typeof summaryProjection }>;

function summary(definition: SummaryDefinition): SkillStoreEntry {
  const revision = definition.currentRevision!;
  return {
    id: definition.id, version: definition.version, name: revision.name,
    description: revision.description, bundleDigest: revision.bundleDigest,
    bundleByteSize: revision.bundleByteSize, fileCount: revision.fileCount,
    archived: definition.archivedAt !== null,
    enabled: definition.preferences.find((preference) => preference.userId === definition.ownerUserId)?.enabled ?? true,
    updatedAt: definition.updatedAt.toISOString()
  };
}
function markdownBytes(definition: Definition): Buffer {
  const revision = definition.currentRevision!;
  return Buffer.from(renderSkillMarkdown(revision, skillAlias(revision.name, new Set())));
}
function detail(definition: Definition): SkillStoreDetail {
  const markdown = markdownBytes(definition);
  return { ...summary(definition), files: [{ path: "SKILL.md", byteSize: markdown.length, checksum: digest(markdown), executable: false },
    ...definition.currentRevision!.files.map(({ path, byteSize, checksum, executable }) => ({ path, byteSize, checksum, executable }))] };
}

export function createSkillsStoreService(db: PrismaClient, storage: StorageAdapter) {
  async function owned(authority: SkillsStoreAuthority, skillId: string, version?: number) {
    await authority.assertActive("read");
    const definition = await db.skillDefinition.findFirst({
      where: { id: skillId, ownerUserId: authority.userId, deletedAt: null, currentRevision: { bundleReady: true } },
      include: { ...projection, preferences: { where: { userId: authority.userId }, select: { userId: true, enabled: true } } }
    });
    if (!definition) throw new SkillsStoreError("skill_not_available");
    if (version !== undefined && definition.version !== version) throw new SkillsStoreError("skill_version_conflict");
    return definition;
  }
  async function validateRead(authority: SkillsStoreAuthority, definition?: Definition) {
    await db.$transaction(async (tx) => {
      await authority.assertTransaction(tx, "read");
      if (!definition) return;
      const current = await tx.skillDefinition.findFirst({ where: {
        id: definition.id, ownerUserId: authority.userId, deletedAt: null,
        version: definition.version, currentRevisionId: definition.currentRevisionId
      }, select: { id: true } });
      if (!current) throw new SkillsStoreError("skill_version_conflict");
    });
  }
  async function archive(authority: SkillsStoreAuthority, skillId: string, version: number) {
    const definition = await owned(authority, skillId, version);
    const files = [{ path: "SKILL.md", bytes: markdownBytes(definition), executable: false }];
    const revisionFiles = await db.skillRevisionFile.findMany({ where: { revisionId: definition.currentRevisionId! }, orderBy: { path: "asc" } });
    for (const file of revisionFiles) {
      const bytes = file.textContent !== null ? Buffer.from(file.textContent)
        : (await storage.getObject(file.storageKey!, { maxBytes: Math.min(SKILL_FILE_MAX_BYTES, Math.max(1, file.byteSize)) })).body;
      if (bytes.length !== file.byteSize || digest(bytes) !== file.checksum) throw new SkillsStoreError("skill_bundle_integrity_failed");
      files.push({ path: file.path, bytes, executable: file.executable });
    }
    const reconstructed = createSkillBundle(definition.currentRevision!, files.slice(1));
    if (reconstructed.bundleDigest !== definition.currentRevision!.bundleDigest) throw new SkillsStoreError("skill_bundle_integrity_failed");
    const bytes = writeZip(files);
    await validateRead(authority, definition);
    const descriptor: SkillStoreDownload = { ...detail(definition), archive: {
      path: `/mcp/skills/bundle?${new URLSearchParams({ skillId, version: String(version) })}`,
      sha256: digest(bytes), byteSize: bytes.length
    } };
    return { bytes, descriptor };
  }
  function operationWhere(authority: SkillsStoreAuthority, operationKey: string) {
    return { ownerUserId_clientId_operationKey: { ownerUserId: authority.userId, clientId: authority.clientId, operationKey } };
  }
  async function write(authority: SkillsStoreAuthority, input: {
    action: "create" | "update"; operationKey: string; skillId?: string; expectedVersion?: number; bundle: SkillBundle;
  }): Promise<SkillStoreMutationResult> {
    await authority.assertActive("write");
    const { bundle } = input;
    const requestDigest = digest(JSON.stringify([input.action, input.skillId ?? null, input.expectedVersion ?? null, bundle.bundleDigest]));
    const where = operationWhere(authority, input.operationKey);
    const staged = await db.$transaction(async (tx) => {
      await authority.assertTransaction(tx, "write");
      await lockSkillRevisionWrites(tx, authority.userId);
      const previous = await tx.skillStoreOperation.findUnique({ where });
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new SkillsStoreError("operation_key_conflict");
        // A staged receipt owns the immutable definition/revision. Reuse it after
        // a lost response or object-store interruption instead of allocating a
        // second definition under the same operation key.
        return previous;
      }
      let existing: Awaited<ReturnType<typeof tx.skillDefinition.findUnique>> | null = null;
      if (input.action === "update") {
        await tx.$queryRaw`SELECT "id" FROM "SkillDefinition" WHERE "id" = ${input.skillId!} AND "ownerUserId" = ${authority.userId} FOR UPDATE`;
        existing = await tx.skillDefinition.findFirst({ where: {
          id: input.skillId, ownerUserId: authority.userId, deletedAt: null, archivedAt: null, currentRevision: { bundleReady: true }
        } });
        if (!existing) throw new SkillsStoreError("skill_not_available");
        if (existing.version !== input.expectedVersion) throw new SkillsStoreError("skill_version_conflict");
        const current = await tx.skillRevision.findUniqueOrThrow({ where: { id: existing.currentRevisionId! }, select: { bundleDigest: true } });
        if (current.bundleDigest === bundle.bundleDigest) {
          const result: SkillStoreMutationResult = { outcome: "unchanged", skillId: existing.id, version: existing.version, bundleDigest: bundle.bundleDigest, libraryPath: "/?library=skills" };
          return tx.skillStoreOperation.create({ data: {
            ownerUserId: authority.userId, clientId: authority.clientId, operationKey: input.operationKey,
            requestDigest, action: input.action, status: "COMPLETED", skillId: existing.id, resultJson: result
          } });
        }
      }
      // Creation is always a new personal definition; a name match grants no update authority.
      const definition = existing ?? await tx.skillDefinition.create({ data: { ownerUserId: authority.userId } });
      const latest = await tx.skillRevision.aggregate({ where: { skillId: definition.id }, _max: { revisionNumber: true } });
      const revision = await tx.skillRevision.create({ data: {
        skillId: definition.id, authorUserId: authority.userId, revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
        schemaVersion: 2, name: bundle.name, description: bundle.description, instructions: bundle.instructions,
        frontmatterJson: bundle.frontmatterJson ?? Prisma.DbNull, bundleDigest: bundle.bundleDigest,
        fileCount: bundle.fileCount, bundleByteSize: bundle.bundleByteSize, hasExecutables: bundle.hasExecutables, bundleReady: false
      } });
      const files = bundle.files.map((file) => ({ revisionId: revision.id, skillId: definition.id,
        path: file.path, byteSize: file.byteSize, checksum: file.checksum, kind: file.kind,
        executable: file.executable, textContent: file.textContent,
        storageKey: file.kind === "binary" ? `skills/${definition.id}/${revision.id}/${randomUUID()}` : null }));
      if (files.length) await tx.skillRevisionFile.createMany({ data: files });
      const binaries = files.filter((file): file is typeof file & { storageKey: string } => file.storageKey !== null);
      if (binaries.length) await tx.attachmentDeletionJob.createMany({ data: binaries.map((file) => ({ storageKey: file.storageKey })) });
      return tx.skillStoreOperation.create({ data: {
        ownerUserId: authority.userId, clientId: authority.clientId, operationKey: input.operationKey, requestDigest,
        action: input.action, skillId: definition.id, revisionId: revision.id,
        expectedVersion: definition.version, expectedCurrentRevisionId: definition.currentRevisionId
      } });
    });
    if (staged.status === "COMPLETED") return staged.resultJson as SkillStoreMutationResult;
    const binaryFiles = await db.skillRevisionFile.findMany({ where: { revisionId: staged.revisionId!, storageKey: { not: null } } });
    for (const file of binaryFiles) {
      await authority.assertActive("write");
      const bytes = bundle.files.find((entry) => entry.path === file.path)!.bytes;
      await storage.putObject({ storageKey: file.storageKey!, contentType: "application/octet-stream", body: bytes });
      const settled = await storage.getObject(file.storageKey!, { maxBytes: Math.max(1, file.byteSize) });
      if (settled.body.length !== file.byteSize || digest(settled.body) !== file.checksum) throw new SkillsStoreError("skill_bundle_integrity_failed");
    }
    return db.$transaction(async (tx) => {
      await authority.assertTransaction(tx, "write");
      await lockSkillRevisionWrites(tx, authority.userId);
      const operation = await tx.skillStoreOperation.findUniqueOrThrow({ where });
      if (operation.status === "COMPLETED") return operation.resultJson as SkillStoreMutationResult;
      const rows = await tx.$queryRaw<Array<{ version: number; currentRevisionId: string | null; deletedAt: Date | null; archivedAt: Date | null }>>`
        SELECT "version", "currentRevisionId", "deletedAt", "archivedAt" FROM "SkillDefinition"
        WHERE "id" = ${staged.skillId!} AND "ownerUserId" = ${authority.userId} FOR UPDATE`;
      const current = rows[0];
      if (!current || current.deletedAt || current.archivedAt || current.version !== staged.expectedVersion ||
        current.currentRevisionId !== staged.expectedCurrentRevisionId) throw new SkillsStoreError("skill_version_conflict");
      await tx.skillRevision.update({ where: { id: staged.revisionId! }, data: { bundleReady: true } });
      const definition = await tx.skillDefinition.update({ where: { id: staged.skillId! }, data: {
        currentRevisionId: staged.revisionId, ...(input.action === "update" ? { version: { increment: 1 } } : {})
      } });
      const result: SkillStoreMutationResult = {
        outcome: input.action === "create" ? "created" : "updated", skillId: definition.id, version: definition.version, bundleDigest: bundle.bundleDigest, libraryPath: "/?library=skills"
      };
      await tx.skillStoreOperation.update({ where, data: { status: "COMPLETED", resultJson: result } });
      return result;
    });
  }
  return {
    async list(authority: SkillsStoreAuthority, input: { query?: string; cursor?: string; limit?: number; includeArchived?: boolean }) {
      await authority.assertActive("read");
      const limit = input.limit ?? 50;
      const definitions = await db.skillDefinition.findMany({ where: {
        ownerUserId: authority.userId, deletedAt: null, currentRevision: { bundleReady: true,
          ...(input.query ? { OR: [{ name: { contains: input.query, mode: "insensitive" as const } },
            { description: { contains: input.query, mode: "insensitive" as const } }] } : {}) },
        ...(input.includeArchived ? {} : { archivedAt: null }), ...(input.cursor ? { id: { gt: input.cursor } } : {})
      }, select: { ...summaryProjection, preferences: { where: { userId: authority.userId }, select: { userId: true, enabled: true } } }, orderBy: { id: "asc" }, take: limit + 1 });
      await validateRead(authority);
      return { skills: definitions.slice(0, limit).map(summary), nextCursor: definitions.length > limit ? definitions[limit - 1]!.id : null };
    },
    async get(authority: SkillsStoreAuthority, skillId: string) {
      const definition = await owned(authority, skillId); await validateRead(authority, definition); return detail(definition);
    },
    async download(authority: SkillsStoreAuthority, skillId: string, version: number) { return (await archive(authority, skillId, version)).descriptor; },
    archive, write,
    async delete(authority: SkillsStoreAuthority, input: { skillId: string; expectedVersion: number; operationKey: string }): Promise<SkillStoreMutationResult> {
      await authority.assertActive("write");
      return db.$transaction(async (tx) => {
        await authority.assertTransaction(tx, "write"); await lockSkillRevisionWrites(tx, authority.userId);
        const where = operationWhere(authority, input.operationKey);
        const requestDigest = digest(JSON.stringify(["delete", input.skillId, input.expectedVersion]));
        const previous = await tx.skillStoreOperation.findUnique({ where });
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw new SkillsStoreError("operation_key_conflict");
          return previous.resultJson as SkillStoreMutationResult;
        }
        const outcome = await deleteOwnedSkillInTransaction(tx, authority.userId, input.skillId, input.expectedVersion);
        if (outcome !== "ok") throw new SkillsStoreError(outcome === "not_found" ? "skill_not_available" : "skill_version_conflict");
        const result: SkillStoreMutationResult = { outcome: "deleted", skillId: input.skillId, version: input.expectedVersion + 1, bundleDigest: null, libraryPath: "/?library=skills" };
        await tx.skillStoreOperation.create({ data: {
          ownerUserId: authority.userId, clientId: authority.clientId, operationKey: input.operationKey,
          requestDigest, action: "delete", status: "COMPLETED", skillId: input.skillId, resultJson: result
        } });
        return result;
      });
    }
  };
}
export type SkillsStoreService = ReturnType<typeof createSkillsStoreService>;
