import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { SKILL_SAVE_CHANGE_NOTE_MAX_LENGTH } from "../../contracts/skillSaves";
import { SKILL_VERSIONS_PAGE_LIMIT, type SkillRestoreResponse, type SkillVersionSummary, type SkillVersionsResponse } from "../../contracts/skillVersions";
import { skillBundleDigest } from "./bundle";
import { lockSkillRevisionWrites } from "./prismaRepository";
import { commitStagedSkillRevision, stageSkillRevision } from "./revisionWriteCore";

/**
 * Restoring an earlier version of a personal Skill: its exact content becomes
 * current again as a new revision through the shared revision write core.
 * History is never rewritten, the published revision never changes and
 * stored objects are reused by key (revisions share them, as library edits
 * do), so a restore copies no bytes. The library, the chat `save_skill`
 * restore target and a chat save's Undo all restore here.
 */
export const SKILL_LIBRARY_RESTORE_CLIENT_ID = "aiqsa:library-restore";
/** Receipts whose revision a version list annotates (note, restored version). */
const VERSION_NOTE_CLIENT_IDS = ["aiqsa:chat-save", "aiqsa:chat-save-undo", SKILL_LIBRARY_RESTORE_CLIENT_ID];

const revisionSelect = {
  id: true, revisionNumber: true, name: true, description: true, instructions: true, frontmatterJson: true,
  bundleDigest: true, fileCount: true, bundleByteSize: true, hasExecutables: true,
  files: { orderBy: { path: "asc" }, select: { path: true, byteSize: true, checksum: true, kind: true, executable: true,
    textContent: true, storageKey: true } }
} satisfies Prisma.SkillRevisionSelect;

export type RestorableSkillRevision = Prisma.SkillRevisionGetPayload<{ select: typeof revisionSelect }>;

/** A guard of the definition as the caller last saw it; every given field must still match. */
export type SkillRestoreGuard = Readonly<{ expectedVersion?: number; expectedCurrentRevisionId?: string }>;

export type SkillRevisionRestoreOutcome =
  | Readonly<{
      kind: "restored";
      skillId: string;
      revisionId: string;
      revisionNumber: number;
      /** The definition version after the restore. */
      version: number;
      /** The definition as the restore found it (the receipt's guard). */
      expectedVersion: number;
      expectedCurrentRevisionId: string;
      previous: RestorableSkillRevision;
      restored: RestorableSkillRevision;
      /** The new revision's digest: the restored content's. */
      bundleDigest: string;
      published: boolean;
    }>
  | Readonly<{ kind: "unchanged"; version: number; current: RestorableSkillRevision }>
  | Readonly<{ kind: "conflict"; version: number; current: RestorableSkillRevision }>
  | Readonly<{ kind: "refused"; code: "skill_not_available" | "skill_archived" | "skill_revision_not_found" }>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The stored bundle digest; legacy revisions without one get it computed from their content. */
function revisionDigest(revision: RestorableSkillRevision): string {
  return revision.bundleDigest || skillBundleDigest({ name: revision.name, description: revision.description,
    instructions: revision.instructions, frontmatterJson: revision.frontmatterJson, files: revision.files });
}

async function loadRevision(tx: Prisma.TransactionClient, skillId: string,
  revision: Readonly<{ id: string }> | Readonly<{ number: number }>): Promise<RestorableSkillRevision | null> {
  return tx.skillRevision.findFirst({ where: { skillId, bundleReady: true,
    ...("id" in revision ? { id: revision.id } : { revisionNumber: revision.number }) }, select: revisionSelect });
}

/**
 * Makes `revision` of the owner's Skill current again as a new version with
 * the same content (same digest, same stored objects). The caller holds
 * `lockSkillRevisionWrites` for the owner and records its own receipt.
 * Missing, deleted and other users' Skills look alike; an archived Skill, a
 * failed guard or an unknown revision write nothing. `whenUnchanged: "skip"`
 * returns `unchanged` instead of a new identical version.
 */
export async function restoreSkillRevisionInTransaction(tx: Prisma.TransactionClient, input: Readonly<{
  userId: string;
  skillId: string;
  revision: Readonly<{ id: string }> | Readonly<{ number: number }>;
  guard: SkillRestoreGuard;
  whenUnchanged: "skip" | "write";
}>): Promise<SkillRevisionRestoreOutcome> {
  const [definition] = await tx.$queryRaw<Array<{ version: number; currentRevisionId: string | null; sharedRevisionId: string | null;
    archivedAt: Date | null; deletedAt: Date | null }>>`
    SELECT "version", "currentRevisionId", "sharedRevisionId", "archivedAt", "deletedAt" FROM "SkillDefinition"
    WHERE "id" = ${input.skillId} AND "ownerUserId" = ${input.userId} FOR UPDATE`;
  if (!definition || definition.deletedAt || !definition.currentRevisionId) return { kind: "refused", code: "skill_not_available" };
  if (definition.archivedAt) return { kind: "refused", code: "skill_archived" };
  const current = await loadRevision(tx, input.skillId, { id: definition.currentRevisionId });
  if (!current) return { kind: "refused", code: "skill_not_available" };
  if ((input.guard.expectedVersion !== undefined && definition.version !== input.guard.expectedVersion) ||
    (input.guard.expectedCurrentRevisionId !== undefined && definition.currentRevisionId !== input.guard.expectedCurrentRevisionId)) {
    return { kind: "conflict", version: definition.version, current };
  }
  const restored = await loadRevision(tx, input.skillId, input.revision);
  if (!restored) return { kind: "refused", code: "skill_revision_not_found" };
  const digest = revisionDigest(restored);
  if (input.whenUnchanged === "skip" && (restored.id === current.id || digest === revisionDigest(current))) {
    return { kind: "unchanged", version: definition.version, current };
  }
  const staged = await stageSkillRevision(tx, {
    ownerUserId: input.userId,
    existing: { id: input.skillId, version: definition.version, currentRevisionId: definition.currentRevisionId },
    content: { name: restored.name, description: restored.description, instructions: restored.instructions,
      frontmatterJson: restored.frontmatterJson, bundleDigest: digest, fileCount: restored.fileCount,
      bundleByteSize: restored.bundleByteSize, hasExecutables: restored.hasExecutables,
      files: restored.files.map((file) => ({ ...file })) }
  });
  // Every binary of a ready revision has a settled object; one without would need bytes a restore never uploads.
  if (staged.uploads.length) throw new Error("skill_restore_object_missing");
  const committed = await commitStagedSkillRevision(tx, { ownerUserId: input.userId, staged, update: true });
  if (!committed) throw new Error("skill_restore_commit_conflict");
  return { kind: "restored", skillId: input.skillId, revisionId: staged.revisionId, revisionNumber: staged.revisionNumber,
    version: committed.version, expectedVersion: definition.version, expectedCurrentRevisionId: definition.currentRevisionId,
    previous: current, restored, bundleDigest: digest, published: definition.sharedRevisionId !== null };
}

function receiptNote(value: Prisma.JsonValue | null): Pick<SkillVersionSummary, "changeNote" | "restoredFrom"> {
  const result: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const note = result.changeNote;
  const restored = result.restoredRevision;
  return {
    changeNote: typeof note === "string" && note.length <= SKILL_SAVE_CHANGE_NOTE_MAX_LENGTH ? note : null,
    restoredFrom: Number.isSafeInteger(restored) && (restored as number) > 0 ? restored as number : null
  };
}

/**
 * One page of the owner's Skill versions, newest first: ready revisions only
 * (a staged revision was never a version). Null for a Skill the user does not
 * own or that is deleted.
 */
export async function listSkillVersions(db: Prisma.TransactionClient, input: Readonly<{
  userId: string; skillId: string; before?: number; limit?: number;
}>): Promise<SkillVersionsResponse | null> {
  const definition = await db.skillDefinition.findFirst({ where: { id: input.skillId, ownerUserId: input.userId, deletedAt: null },
    select: { version: true, archivedAt: true, currentRevisionId: true, sharedRevisionId: true } });
  if (!definition) return null;
  const limit = Math.min(Math.max(1, input.limit ?? SKILL_VERSIONS_PAGE_LIMIT), SKILL_VERSIONS_PAGE_LIMIT);
  const revisions = await db.skillRevision.findMany({
    where: { skillId: input.skillId, bundleReady: true, ...(input.before ? { revisionNumber: { lt: input.before } } : {}) },
    orderBy: { revisionNumber: "desc" }, take: limit + 1,
    select: { id: true, revisionNumber: true, createdAt: true, fileCount: true, bundleByteSize: true, hasExecutables: true,
      author: { select: { displayName: true } } }
  });
  const page = revisions.slice(0, limit);
  const receipts = page.length ? await db.skillStoreOperation.findMany({ where: { ownerUserId: input.userId, skillId: input.skillId,
    clientId: { in: VERSION_NOTE_CLIENT_IDS }, revisionId: { in: page.map((revision) => revision.id) }, status: "COMPLETED" },
  select: { revisionId: true, resultJson: true } }) : [];
  const notes = new Map(receipts.map((receipt) => [receipt.revisionId, receiptNote(receipt.resultJson)]));
  return {
    skillId: input.skillId, version: definition.version, archived: definition.archivedAt !== null,
    versions: page.map((revision) => ({
      revisionId: revision.id, revisionNumber: revision.revisionNumber, createdAt: revision.createdAt.toISOString(),
      authorDisplayName: revision.author?.displayName ?? null, fileCount: revision.fileCount, byteSize: revision.bundleByteSize,
      hasExecutables: revision.hasExecutables, current: revision.id === definition.currentRevisionId,
      shared: revision.id === definition.sharedRevisionId, ...(notes.get(revision.id) ?? { changeNote: null, restoredFrom: null })
    })),
    nextBefore: revisions.length > limit ? page.at(-1)!.revisionNumber : null
  };
}

export type SkillLibraryRestoreResult =
  | Readonly<{ kind: "ok"; response: SkillRestoreResponse }>
  | Readonly<{ kind: "not_found" | "archived" | "conflict" }>;

/** The owner's library: list versions and restore one, guarded by the version the library showed. */
export function createSkillVersionService(db: PrismaClient) {
  return {
    list: (input: Readonly<{ userId: string; skillId: string; before?: number }>) => listSkillVersions(db, input),
    async restore(input: Readonly<{ userId: string; skillId: string; revisionId: string; expectedVersion: number }>): Promise<SkillLibraryRestoreResult> {
      return db.$transaction(async (tx) => {
        await lockSkillRevisionWrites(tx, input.userId);
        const outcome = await restoreSkillRevisionInTransaction(tx, { userId: input.userId, skillId: input.skillId,
          revision: { id: input.revisionId }, guard: { expectedVersion: input.expectedVersion }, whenUnchanged: "skip" });
        if (outcome.kind === "refused") return { kind: outcome.code === "skill_archived" ? "archived" : "not_found" } as const;
        if (outcome.kind === "conflict") return { kind: "conflict" } as const;
        if (outcome.kind === "unchanged") return { kind: "ok", response: { outcome: "unchanged", version: outcome.version } } as const;
        await tx.skillStoreOperation.create({ data: {
          ownerUserId: input.userId, clientId: SKILL_LIBRARY_RESTORE_CLIENT_ID, operationKey: outcome.revisionId,
          requestDigest: sha256(JSON.stringify(["restore", input.skillId, outcome.restored.id])), action: "restore", status: "COMPLETED",
          skillId: input.skillId, revisionId: outcome.revisionId, expectedVersion: outcome.expectedVersion,
          expectedCurrentRevisionId: outcome.expectedCurrentRevisionId,
          resultJson: { outcome: "restored", version: outcome.version, revision: outcome.revisionNumber,
            restoredRevision: outcome.restored.revisionNumber }
        } });
        return { kind: "ok", response: { outcome: "restored", version: outcome.version, revisionNumber: outcome.revisionNumber,
          restoredFrom: outcome.restored.revisionNumber } } as const;
      });
    }
  };
}
export type SkillVersionService = ReturnType<typeof createSkillVersionService>;
