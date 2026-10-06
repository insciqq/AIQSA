import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * The one guarded write path for a personal Skill's content: the Skills MCP
 * store (`create_skill`, `update_skill`), the chat `save_skill` tool and its
 * Undo all stage a new immutable revision here and make it current here.
 * Callers hold `lockSkillRevisionWrites` for the owner in the same
 * transaction, decide which definition they may write (ownership, archive and
 * version rules of their surface) and record their own operation receipt.
 */

/** One file of a revision to stage. A binary without `storageKey` gets a new
 * private object the caller uploads and verifies before commit; a
 * `storageKey` reuses an already settled object of this definition (a
 * restored revision), exactly as library revisions share unchanged files. */
export type SkillRevisionContentFile = Readonly<{
  path: string;
  byteSize: number;
  checksum: string;
  kind: string;
  executable: boolean;
  textContent: string | null;
  storageKey?: string | null;
}>;

export type SkillRevisionContent = Readonly<{
  name: string;
  description: string;
  instructions: string;
  frontmatterJson: unknown;
  bundleDigest: string;
  fileCount: number;
  bundleByteSize: number;
  hasExecutables: boolean;
  files: readonly SkillRevisionContentFile[];
}>;

export type StagedSkillRevision = Readonly<{
  skillId: string;
  revisionId: string;
  revisionNumber: number;
  /** The definition as staging read it; commit requires it unchanged. */
  expectedVersion: number;
  expectedCurrentRevisionId: string | null;
  /** New private objects to upload and verify before commit. */
  uploads: readonly Readonly<{ path: string; storageKey: string; byteSize: number; checksum: string }>[];
}>;

/**
 * Stages a not yet selectable revision (`bundleReady: false`) of `existing`,
 * or of a new private definition owned by `ownerUserId` when `existing` is
 * null (creation never adopts a definition by name). New binary objects are
 * protected by deletion obligations until their revision settles.
 */
export async function stageSkillRevision(tx: Prisma.TransactionClient, input: Readonly<{
  ownerUserId: string;
  existing: Readonly<{ id: string; version: number; currentRevisionId: string | null }> | null;
  content: SkillRevisionContent;
  /** Provenance recorded on a new definition only (for example a personal copy of a shared Skill). */
  importSourceJson?: Prisma.InputJsonValue;
}>): Promise<StagedSkillRevision> {
  const { content } = input;
  const definition = input.existing ?? await tx.skillDefinition.create({ data: {
    ownerUserId: input.ownerUserId,
    ...(input.importSourceJson === undefined ? {} : { importSourceJson: input.importSourceJson })
  } });
  const latest = await tx.skillRevision.aggregate({ where: { skillId: definition.id }, _max: { revisionNumber: true } });
  const revisionNumber = (latest._max.revisionNumber ?? 0) + 1;
  const revision = await tx.skillRevision.create({ data: {
    skillId: definition.id, authorUserId: input.ownerUserId, revisionNumber,
    schemaVersion: 2, name: content.name, description: content.description, instructions: content.instructions,
    frontmatterJson: content.frontmatterJson === null || content.frontmatterJson === undefined
      ? Prisma.DbNull : content.frontmatterJson as Prisma.InputJsonValue,
    bundleDigest: content.bundleDigest, fileCount: content.fileCount, bundleByteSize: content.bundleByteSize,
    hasExecutables: content.hasExecutables, bundleReady: false
  } });
  const uploads: Array<{ path: string; storageKey: string; byteSize: number; checksum: string }> = [];
  const files = content.files.map((file) => {
    let storageKey: string | null = null;
    if (file.kind === "binary") {
      storageKey = file.storageKey ?? `skills/${definition.id}/${revision.id}/${randomUUID()}`;
      if (!file.storageKey) uploads.push({ path: file.path, storageKey, byteSize: file.byteSize, checksum: file.checksum });
    }
    return { revisionId: revision.id, skillId: definition.id, path: file.path, byteSize: file.byteSize,
      checksum: file.checksum, kind: file.kind, executable: file.executable, textContent: file.textContent, storageKey };
  });
  if (files.length) await tx.skillRevisionFile.createMany({ data: files });
  if (uploads.length) await tx.attachmentDeletionJob.createMany({ data: uploads.map((file) => ({ storageKey: file.storageKey })) });
  return { skillId: definition.id, revisionId: revision.id, revisionNumber, expectedVersion: definition.version,
    expectedCurrentRevisionId: definition.currentRevisionId, uploads };
}

/**
 * Makes a staged revision current when its definition is still the one
 * staging read (same version and current revision, not archived or deleted).
 * Null is `skill_version_conflict`: nothing changes. An update increments the
 * definition version; a creation keeps version 1.
 */
export async function commitStagedSkillRevision(tx: Prisma.TransactionClient, input: Readonly<{
  ownerUserId: string;
  staged: Pick<StagedSkillRevision, "skillId" | "revisionId" | "expectedVersion" | "expectedCurrentRevisionId">;
  update: boolean;
}>): Promise<Readonly<{ version: number }> | null> {
  const rows = await tx.$queryRaw<Array<{ version: number; currentRevisionId: string | null; deletedAt: Date | null; archivedAt: Date | null }>>`
    SELECT "version", "currentRevisionId", "deletedAt", "archivedAt" FROM "SkillDefinition"
    WHERE "id" = ${input.staged.skillId} AND "ownerUserId" = ${input.ownerUserId} FOR UPDATE`;
  const current = rows[0];
  if (!current || current.deletedAt || current.archivedAt || current.version !== input.staged.expectedVersion ||
    current.currentRevisionId !== input.staged.expectedCurrentRevisionId) return null;
  await tx.skillRevision.update({ where: { id: input.staged.revisionId }, data: { bundleReady: true } });
  const definition = await tx.skillDefinition.update({ where: { id: input.staged.skillId }, data: {
    currentRevisionId: input.staged.revisionId, ...(input.update ? { version: { increment: 1 } } : {})
  }, select: { version: true } });
  return { version: definition.version };
}
