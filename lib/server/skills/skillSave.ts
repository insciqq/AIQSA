import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  SKILL_LIBRARY_PATH,
  SKILL_SAVE_CARD_DIFFS_LIMIT,
  SKILL_SAVE_CARD_FILES_LIMIT,
  SKILL_SAVE_DIFF_LINE_MAX_LENGTH,
  SKILL_SAVE_DIFF_LINES_LIMIT,
  SKILL_SAVE_HOURLY_LIMIT,
  type SkillSaveCard,
  type SkillSaveCardDiff,
  type SkillSaveCardFile,
  type SkillSaveUndoState
} from "../../contracts/skillSaves";
import type { SkillStoreMutationResult } from "../../contracts/skillsMcp";
import { boundedTextLineDiff } from "../../domain/textLineDiff";
import { renderSkillMarkdown, type SkillBundle } from "./bundle";
import { lockSkillRevisionWrites, skillAccessWhere } from "./prismaRepository";
import { listSkillVersions, restoreSkillRevisionInTransaction } from "./revisionRestore";
import { commitStagedSkillRevision, stageSkillRevision } from "./revisionWriteCore";
import { activeScheduledTasksUsingSkill } from "./skillScheduledTasks";

/**
 * Chat saves (`save_skill`) and their Undo. Both commit through the shared
 * revision write core and keep content-free receipts in the Skills store's
 * operation table under their own client identities: the save's receipt is
 * keyed by its persisted tool call (idempotency, the per-answer limit and the
 * hourly rate limit all derive from these rows), the Undo's by the save.
 */
export const SKILL_SAVE_CLIENT_ID = "aiqsa:chat-save";
export const SKILL_SAVE_UNDO_CLIENT_ID = "aiqsa:chat-save-undo";
const HOUR_MS = 3_600_000;
const CONFLICT_CONTENT_BUDGET = 32 * 1_024;
const DIFF_TOTAL_BUDGET = 32 * 1_024;
/** Versions a chat restore result lists, newest first. */
const CHAT_VERSIONS_LIMIT = 20;

/**
 * Where a save goes. `frozen`: a Skill of the run's frozen catalog (by
 * alias), guarded by the revision the run staged and the model read; the
 * `version` form comes from an earlier save result or conflict of the run.
 * `restore`: make version `revision` of the owner's Skill current again as a
 * new version, under the same guards; `revision` 0 only lists the versions.
 */
export type SkillSaveTarget =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "frozen"; skillId: string; revisionId: string }>
  | Readonly<{ kind: "version"; skillId: string; expectedVersion: number }>
  | Readonly<{ kind: "restore"; skillId: string; guard: Readonly<{ revisionId: string } | { expectedVersion: number }>; revision: number }>;

export type SkillSaveRefusal = "skill_save_answer_limit" | "skill_save_rate_limited" | "skill_not_available" |
  "skill_archived" | "skill_version_conflict" | "skill_restore_not_own" | "skill_restore_revision_unknown" | "skill_restore_conflict";

/** The owner's Skill versions as the model reads them to choose one to restore. */
export type SkillSaveVersionList = Readonly<{
  skillId: string;
  name: string;
  currentVersion: number;
  versions: readonly Readonly<{ revision: number; createdAt: string; current: boolean; files: number; changeNote: string | null;
    restoredFrom: number | null }>[];
  /** Older versions exist beyond this list. */
  more: boolean;
}>;

/** What the model needs to rebuild on the current version after a conflict. */
export type SkillSaveConflict = Readonly<{
  skillId: string;
  currentVersion: number;
  currentRevision: number;
  /** Files of the current version that differ from the saved folder; null content: binary. */
  differingFiles: readonly Readonly<{ path: string; content: string | null }>[];
  /** Differing files left out to bound the result. */
  omittedFiles: readonly string[];
  /** Folder files the current version does not have. */
  newFiles: readonly string[];
}>;

export type SkillSaveOutcome =
  | Readonly<{ kind: "saved"; card: SkillSaveCard; version: number; hasExecutables: boolean }>
  | Readonly<{ kind: "unchanged"; skillId: string; name: string; version: number }>
  /** A restore target with revision 0: the versions, nothing written. */
  | Readonly<{ kind: "versions"; list: SkillSaveVersionList }>
  | Readonly<{ kind: "refused"; code: SkillSaveRefusal; conflict?: SkillSaveConflict; versions?: SkillSaveVersionList }>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export type SkillSaveRevisionFiles = Readonly<{
  revisionNumber: number; name: string; description: string; instructions: string; frontmatterJson: Prisma.JsonValue;
  bundleDigest: string;
  files: readonly Readonly<{ path: string; checksum: string; kind: string; executable: boolean; textContent: string | null }>[];
}>;

async function loadRevision(tx: Prisma.TransactionClient, revisionId: string): Promise<SkillSaveRevisionFiles | null> {
  return tx.skillRevision.findUnique({ where: { id: revisionId }, select: {
    revisionNumber: true, name: true, description: true, instructions: true, frontmatterJson: true, bundleDigest: true,
    files: { orderBy: { path: "asc" }, select: { path: true, checksum: true, kind: true, executable: true, textContent: true } }
  } });
}

const markdown = (revision: Pick<SkillSaveRevisionFiles, "name" | "description" | "instructions" | "frontmatterJson">) =>
  renderSkillMarkdown({ name: revision.name, description: revision.description, instructions: revision.instructions,
    frontmatterJson: revision.frontmatterJson });

/** What a card compares: a saved folder's bundle or a stored revision's content. */
type SkillCardContent = Pick<SkillSaveRevisionFiles, "name" | "description" | "instructions"> & Readonly<{
  frontmatterJson: unknown;
  files: readonly Readonly<{ path: string; checksum: string; kind: string; executable: boolean; textContent: string | null }>[];
}>;
type CardSide = { text: string | null; checksum: string; executable: boolean; binary: boolean };

function cardSides(content: SkillCardContent): Map<string, CardSide> {
  const skillMarkdown = markdown({ ...content, frontmatterJson: content.frontmatterJson as Prisma.JsonValue });
  return new Map<string, CardSide>([
    ["SKILL.md", { text: skillMarkdown, checksum: digest(skillMarkdown), executable: false, binary: false }],
    ...content.files.map((file) => [file.path, { text: file.kind === "text" ? file.textContent : null, checksum: file.checksum,
      executable: file.executable, binary: file.kind !== "text" }] as const)
  ]);
}

/** File list and bounded diffs of a save (or a restored version) against the version it replaced (none for a new Skill). */
export function skillSaveCardChanges(next: SkillCardContent, previous: SkillCardContent | null): Pick<SkillSaveCard, "files" | "diffs"> {
  const saved = cardSides(next);
  const before = previous ? cardSides(previous) : new Map<string, CardSide>();
  const files: SkillSaveCardFile[] = [];
  const diffs: SkillSaveCardDiff[] = [];
  let diffBytes = 0;
  const paths = [...new Set([...saved.keys(), ...before.keys()])]
    .sort((a, b) => a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a < b ? -1 : a > b ? 1 : 0);
  for (const path of paths) {
    const next = saved.get(path), old = before.get(path);
    const change = !previous ? "added" : !old ? "added" : !next ? "removed" : old.checksum === next.checksum ? "unchanged" : "changed";
    const executable = (next ?? old)!.executable;
    files.push({ path, change, executable, ...(next && old && next.executable !== old.executable ? { executableChanged: true as const } : {}),
      ...((next ?? old)!.binary ? { binary: true as const } : {}) });
    if (change !== "changed" || old?.text == null || next?.text == null || diffs.length >= SKILL_SAVE_CARD_DIFFS_LIMIT) continue;
    const diff = boundedTextLineDiff(old.text, next.text, { maxLines: SKILL_SAVE_DIFF_LINES_LIMIT, maxLineLength: SKILL_SAVE_DIFF_LINE_MAX_LENGTH });
    if (!diff) continue;
    const size = diff.lines.reduce((sum, line) => sum + line.text.length + 16, 0);
    if (diffBytes + size > DIFF_TOTAL_BUDGET) continue;
    diffBytes += size;
    diffs.push({ path, lines: diff.lines, truncated: diff.truncated });
  }
  return { files: files.slice(0, SKILL_SAVE_CARD_FILES_LIMIT), diffs };
}

function conflictDetails(input: Readonly<{ skillId: string; version: number; current: SkillSaveRevisionFiles; bundle: SkillBundle }>): SkillSaveConflict {
  const savedMarkdown = markdown({ ...input.bundle, frontmatterJson: input.bundle.frontmatterJson as Prisma.JsonValue });
  const currentMarkdown = markdown(input.current);
  const folder = new Map(input.bundle.files.map((file) => [file.path, file.checksum]));
  const differing: Array<{ path: string; content: string | null }> = [];
  if (savedMarkdown !== currentMarkdown) differing.push({ path: "SKILL.md", content: currentMarkdown });
  for (const file of input.current.files) {
    if (folder.get(file.path) !== file.checksum) differing.push({ path: file.path, content: file.kind === "text" ? file.textContent : null });
  }
  let budget = CONFLICT_CONTENT_BUDGET;
  const differingFiles: Array<{ path: string; content: string | null }> = [];
  const omittedFiles: string[] = [];
  for (const file of differing) {
    const size = file.content === null ? 0 : Buffer.byteLength(file.content);
    if (size > budget) { omittedFiles.push(file.path); continue; }
    budget -= size;
    differingFiles.push(file);
  }
  const currentPaths = new Set(input.current.files.map((file) => file.path));
  return { skillId: input.skillId, currentVersion: input.version, currentRevision: input.current.revisionNumber, differingFiles,
    omittedFiles, newFiles: input.bundle.files.filter((file) => !currentPaths.has(file.path)).map((file) => file.path) };
}

/**
 * Saves `bundle` (text files only) for the run's owner in the caller's
 * transaction, which also fences the run and settles the call: at most one
 * save per answer and SKILL_SAVE_HOURLY_LIMIT per rolling hour, a new
 * personal Skill, a guarded new version of the owner's Skill (the published
 * version stays as it is), or a personal copy of another user's visible
 * Skill with its provenance. A restore target (no bundle) makes an earlier
 * version of the owner's Skill current again under the same limits. A
 * refusal writes nothing.
 */
export async function commitSkillSaveInTransaction(tx: Prisma.TransactionClient, input: Readonly<{
  userId: string;
  runId: string;
  /** The persisted tool call: the save's operation key. */
  operationKey: string;
  target: SkillSaveTarget;
  /** The captured folder; null exactly for a restore target. */
  bundle: SkillBundle | null;
  changeNote: string | null;
  now?: Date;
}>): Promise<SkillSaveOutcome> {
  const { userId, bundle } = input;
  if ((input.target.kind === "restore") !== (bundle === null)) throw new Error("skill_save_content_invalid");
  if (bundle?.files.some((file) => file.kind !== "text")) throw new Error("skill_save_binary_file");
  await lockSkillRevisionWrites(tx, userId);
  if (await tx.skillStoreOperation.findUnique({ where: { ownerUserId_clientId_operationKey: {
    ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID, operationKey: input.operationKey
  } }, select: { id: true } })) throw new Error("skill_save_operation_replayed");
  const [answer] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS "count" FROM "SkillStoreOperation" o
    JOIN "ModelRunToolCall" c ON c."id" = o."operationKey"
    WHERE o."ownerUserId" = ${userId} AND o."clientId" = ${SKILL_SAVE_CLIENT_ID} AND o."revisionId" IS NOT NULL
      AND c."modelRunId" = ${input.runId} AND c."id" <> ${input.operationKey}
  `);
  if ((answer?.count ?? 0) > 0) return { kind: "refused", code: "skill_save_answer_limit" };
  const now = input.now ?? new Date();
  const recent = await tx.skillStoreOperation.count({ where: {
    ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID, revisionId: { not: null }, createdAt: { gt: new Date(now.getTime() - HOUR_MS) }
  } });
  if (recent >= SKILL_SAVE_HOURLY_LIMIT) return { kind: "refused", code: "skill_save_rate_limited" };
  if (input.target.kind === "restore") {
    return commitSkillRestore(tx, { userId, operationKey: input.operationKey, target: input.target, changeNote: input.changeNote });
  }
  if (!bundle) throw new Error("skill_save_content_invalid");

  let own: { id: string; version: number; currentRevisionId: string; sharedRevisionId: string | null } | null = null;
  let copy: { skillId: string; revisionId: string; name: string } | null = null;
  if (input.target.kind !== "new") {
    const skillId = input.target.skillId;
    const [definition] = await tx.$queryRaw<Array<{ ownerUserId: string; deletedAt: Date | null }>>`
      SELECT "ownerUserId", "deletedAt" FROM "SkillDefinition" WHERE "id" = ${skillId}`;
    if (!definition || definition.deletedAt) return { kind: "refused", code: "skill_not_available" };
    if (definition.ownerUserId === userId) {
      const [locked] = await tx.$queryRaw<Array<{ version: number; currentRevisionId: string | null; sharedRevisionId: string | null;
        archivedAt: Date | null; deletedAt: Date | null }>>`
        SELECT "version", "currentRevisionId", "sharedRevisionId", "archivedAt", "deletedAt" FROM "SkillDefinition"
        WHERE "id" = ${skillId} AND "ownerUserId" = ${userId} FOR UPDATE`;
      if (!locked || locked.deletedAt || !locked.currentRevisionId) return { kind: "refused", code: "skill_not_available" };
      if (locked.archivedAt) return { kind: "refused", code: "skill_archived" };
      const current = await loadRevision(tx, locked.currentRevisionId);
      if (!current) return { kind: "refused", code: "skill_not_available" };
      const guarded = input.target.kind === "frozen" ? locked.currentRevisionId === input.target.revisionId
        : locked.version === input.target.expectedVersion;
      if (!guarded) {
        return { kind: "refused", code: "skill_version_conflict",
          conflict: conflictDetails({ skillId, version: locked.version, current, bundle }) };
      }
      if (current.bundleDigest === bundle.bundleDigest) return { kind: "unchanged", skillId, name: current.name, version: locked.version };
      own = { id: skillId, version: locked.version, currentRevisionId: locked.currentRevisionId, sharedRevisionId: locked.sharedRevisionId };
    } else {
      // Someone else's Skill is never edited: a visible one is copied into a new personal Skill.
      const visible = await tx.skillDefinition.findFirst({ where: { id: skillId, deletedAt: null, ...skillAccessWhere(userId) },
        select: { sharedRevisionId: true, sharedRevision: { select: { name: true } } } });
      if (!visible?.sharedRevisionId || !visible.sharedRevision) return { kind: "refused", code: "skill_not_available" };
      copy = { skillId, revisionId: input.target.kind === "frozen" ? input.target.revisionId : visible.sharedRevisionId,
        name: visible.sharedRevision.name };
    }
  }
  const previous = own ? await loadRevision(tx, own.currentRevisionId) : null;
  const staged = await stageSkillRevision(tx, {
    ownerUserId: userId,
    existing: own ? { id: own.id, version: own.version, currentRevisionId: own.currentRevisionId } : null,
    content: bundle,
    ...(copy ? { importSourceJson: { kind: "skill_copy", skillId: copy.skillId, revisionId: copy.revisionId } } : {})
  });
  if (staged.uploads.length) throw new Error("skill_save_binary_file");
  const committed = await commitStagedSkillRevision(tx, { ownerUserId: userId, staged, update: own !== null });
  if (!committed) throw new Error("skill_save_commit_conflict");
  const action = own ? "update" as const : "create" as const;
  const receipt: SkillStoreMutationResult = { outcome: own ? "updated" : "created", skillId: staged.skillId,
    version: committed.version, bundleDigest: bundle.bundleDigest, libraryPath: SKILL_LIBRARY_PATH };
  const operation = await tx.skillStoreOperation.create({ data: {
    ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID, operationKey: input.operationKey,
    requestDigest: digest(JSON.stringify([action, own?.id ?? null, bundle.bundleDigest])), action, status: "COMPLETED",
    skillId: staged.skillId, revisionId: staged.revisionId, expectedVersion: staged.expectedVersion,
    expectedCurrentRevisionId: staged.expectedCurrentRevisionId,
    resultJson: { ...receipt, ...(input.changeNote ? { changeNote: input.changeNote } : {}) }
  }, select: { id: true } });
  const tasks = await activeScheduledTasksUsingSkill(tx, { userId, skillId: staged.skillId });
  const card: SkillSaveCard = {
    version: 1, saveId: operation.id, skillId: staged.skillId, revisionId: staged.revisionId, name: bundle.name,
    outcome: own ? "updated" : "created", fromRevision: previous?.revisionNumber ?? null, toRevision: staged.revisionNumber,
    changeNote: input.changeNote, copiedFrom: copy?.name ?? null, published: own?.sharedRevisionId != null,
    ...skillSaveCardChanges(bundle, previous), scheduledTasks: tasks.tasks, scheduledTasksTruncated: tasks.truncated
  };
  return { kind: "saved", card, version: committed.version, hasExecutables: bundle.hasExecutables };
}

/** The newest versions of the owner's Skill for the model, or null when it is not the owner's. */
async function chatVersionList(tx: Prisma.TransactionClient, userId: string, skillId: string): Promise<SkillSaveVersionList | null> {
  const page = await listSkillVersions(tx, { userId, skillId, limit: CHAT_VERSIONS_LIMIT });
  const definition = page && await tx.skillDefinition.findFirst({ where: { id: skillId, ownerUserId: userId },
    select: { currentRevision: { select: { name: true } } } });
  if (!page || !definition?.currentRevision) return null;
  return { skillId, name: definition.currentRevision.name, currentVersion: page.version, more: page.nextBefore !== null,
    versions: page.versions.map((version) => ({ revision: version.revisionNumber, createdAt: version.createdAt, current: version.current,
      files: version.fileCount, changeNote: version.changeNote, restoredFrom: version.restoredFrom })) };
}

/**
 * A chat restore: version `revision` of the owner's Skill becomes current
 * again as a new version through the shared restore, guarded like a folder
 * save, with the same receipt (so the answer and hourly limits and Undo
 * apply) and a card whose diff runs from the replaced version to the
 * restored one. Another user's Skill is never restored.
 */
async function commitSkillRestore(tx: Prisma.TransactionClient, input: Readonly<{
  userId: string;
  operationKey: string;
  target: Extract<SkillSaveTarget, { kind: "restore" }>;
  changeNote: string | null;
}>): Promise<SkillSaveOutcome> {
  const { userId, target } = input;
  const [definition] = await tx.$queryRaw<Array<{ ownerUserId: string; deletedAt: Date | null }>>`
    SELECT "ownerUserId", "deletedAt" FROM "SkillDefinition" WHERE "id" = ${target.skillId}`;
  if (!definition || definition.deletedAt) return { kind: "refused", code: "skill_not_available" };
  if (definition.ownerUserId !== userId) {
    // Only a Skill the user can see is named as someone else's; any other id looks missing.
    const visible = await tx.skillDefinition.findFirst({ where: { id: target.skillId, deletedAt: null, ...skillAccessWhere(userId) },
      select: { id: true } });
    return { kind: "refused", code: visible ? "skill_restore_not_own" : "skill_not_available" };
  }
  const versions = () => chatVersionList(tx, userId, target.skillId).then((list) => list ?? undefined);
  if (target.revision === 0) {
    const list = await versions();
    return list ? { kind: "versions", list } : { kind: "refused", code: "skill_not_available" };
  }
  const outcome = await restoreSkillRevisionInTransaction(tx, { userId, skillId: target.skillId, revision: { number: target.revision },
    guard: "revisionId" in target.guard ? { expectedCurrentRevisionId: target.guard.revisionId } : { expectedVersion: target.guard.expectedVersion },
    whenUnchanged: "skip" });
  if (outcome.kind === "refused") {
    return outcome.code === "skill_revision_not_found"
      ? { kind: "refused", code: "skill_restore_revision_unknown", versions: await versions() }
      : { kind: "refused", code: outcome.code };
  }
  if (outcome.kind === "conflict") return { kind: "refused", code: "skill_restore_conflict", versions: await versions() };
  if (outcome.kind === "unchanged") return { kind: "unchanged", skillId: target.skillId, name: outcome.current.name, version: outcome.version };
  const receipt: SkillStoreMutationResult = { outcome: "updated", skillId: target.skillId, version: outcome.version,
    bundleDigest: outcome.bundleDigest, libraryPath: SKILL_LIBRARY_PATH };
  const operation = await tx.skillStoreOperation.create({ data: {
    ownerUserId: userId, clientId: SKILL_SAVE_CLIENT_ID, operationKey: input.operationKey,
    requestDigest: digest(JSON.stringify(["restore", target.skillId, outcome.restored.id])), action: "update", status: "COMPLETED",
    skillId: target.skillId, revisionId: outcome.revisionId, expectedVersion: outcome.expectedVersion,
    expectedCurrentRevisionId: outcome.expectedCurrentRevisionId,
    resultJson: { ...receipt, restoredRevision: outcome.restored.revisionNumber, ...(input.changeNote ? { changeNote: input.changeNote } : {}) }
  }, select: { id: true } });
  const tasks = await activeScheduledTasksUsingSkill(tx, { userId, skillId: target.skillId });
  const card: SkillSaveCard = {
    version: 1, saveId: operation.id, skillId: target.skillId, revisionId: outcome.revisionId, name: outcome.restored.name,
    outcome: "restored", fromRevision: outcome.previous.revisionNumber, toRevision: outcome.revisionNumber,
    restoredRevision: outcome.restored.revisionNumber, changeNote: input.changeNote, copiedFrom: null, published: outcome.published,
    ...skillSaveCardChanges(outcome.restored, outcome.previous), scheduledTasks: tasks.tasks, scheduledTasksTruncated: tasks.truncated
  };
  return { kind: "saved", card, version: outcome.version, hasExecutables: outcome.restored.hasExecutables };
}

type SaveReceipt = Readonly<{ id: string; action: string; skillId: string; revisionId: string; previousRevisionId: string | null; version: number }>;

async function saveReceipt(db: Prisma.TransactionClient, input: Readonly<{ userId: string; skillId: string; saveId: string }>): Promise<SaveReceipt | null> {
  const operation = await db.skillStoreOperation.findFirst({ where: {
    id: input.saveId, ownerUserId: input.userId, clientId: SKILL_SAVE_CLIENT_ID, skillId: input.skillId,
    status: "COMPLETED", revisionId: { not: null }
  }, select: { id: true, action: true, skillId: true, revisionId: true, expectedCurrentRevisionId: true, resultJson: true } });
  const version = (operation?.resultJson as { version?: unknown } | null)?.version;
  if (!operation || !Number.isSafeInteger(version) || (operation.action !== "create" && operation.action !== "update") ||
    (operation.action === "update" && !operation.expectedCurrentRevisionId)) return null;
  return { id: operation.id, action: operation.action, skillId: operation.skillId!, revisionId: operation.revisionId!,
    previousRevisionId: operation.expectedCurrentRevisionId, version: version as number };
}

function undoneState(value: Prisma.JsonValue | null): SkillSaveUndoState {
  const result = value as { outcome?: unknown; revision?: unknown } | null;
  return result?.outcome === "archived" || result?.outcome === "restored"
    ? { state: "undone", outcome: result.outcome, revision: Number.isSafeInteger(result.revision) ? result.revision as number : null }
    : { state: "unavailable" };
}

async function undoStatus(db: Prisma.TransactionClient, input: Readonly<{ userId: string; skillId: string; saveId: string }>,
  lock: boolean): Promise<Readonly<{ state: SkillSaveUndoState; receipt: SaveReceipt | null }>> {
  const receipt = await saveReceipt(db, input);
  if (!receipt) return { state: { state: "unavailable" }, receipt: null };
  const undo = await db.skillStoreOperation.findUnique({ where: { ownerUserId_clientId_operationKey: {
    ownerUserId: input.userId, clientId: SKILL_SAVE_UNDO_CLIENT_ID, operationKey: receipt.id
  } }, select: { resultJson: true } });
  if (undo) return { state: undoneState(undo.resultJson), receipt };
  const rows = await (lock
    ? db.$queryRaw<Array<{ version: number; currentRevisionId: string | null; archivedAt: Date | null; deletedAt: Date | null }>>`
      SELECT "version", "currentRevisionId", "archivedAt", "deletedAt" FROM "SkillDefinition"
      WHERE "id" = ${receipt.skillId} AND "ownerUserId" = ${input.userId} FOR UPDATE`
    : db.$queryRaw<Array<{ version: number; currentRevisionId: string | null; archivedAt: Date | null; deletedAt: Date | null }>>`
      SELECT "version", "currentRevisionId", "archivedAt", "deletedAt" FROM "SkillDefinition"
      WHERE "id" = ${receipt.skillId} AND "ownerUserId" = ${input.userId}`);
  const current = rows[0];
  if (!current || current.deletedAt) return { state: { state: "unavailable" }, receipt };
  // Any later change (content, archive, settings that bump the version) wins over Undo.
  if (current.archivedAt || current.version !== receipt.version || current.currentRevisionId !== receipt.revisionId) {
    return { state: { state: "conflict" }, receipt };
  }
  return { state: { state: "available" }, receipt };
}

/** Undo service for a chat save's card; authority is the signed-in owner of the save and the Skill. */
export function createSkillSaveUndoService(db: PrismaClient) {
  return {
    async state(input: Readonly<{ userId: string; skillId: string; saveId: string }>): Promise<SkillSaveUndoState> {
      return (await undoStatus(db, input, false)).state;
    },
    /**
     * Archives the Skill a save created, or makes the content the save replaced
     * current again as a new version through the shared write core, guarded by
     * the version the save left. Repeating it returns the first outcome.
     */
    async undo(input: Readonly<{ userId: string; skillId: string; saveId: string }>): Promise<SkillSaveUndoState> {
      return db.$transaction(async (tx) => {
        await lockSkillRevisionWrites(tx, input.userId);
        const { state, receipt } = await undoStatus(tx, input, true);
        if (state.state !== "available" || !receipt) return state;
        let result: SkillSaveUndoState;
        let restored: { revisionId: string; from: number } | null = null;
        if (receipt.action === "create") {
          await tx.skillShareRequest.updateMany({ where: { skillId: receipt.skillId, state: "pending" }, data: { state: "withdrawn" } });
          await tx.skillDefinition.update({ where: { id: receipt.skillId }, data: { archivedAt: new Date(), version: { increment: 1 } } });
          result = { state: "undone", outcome: "archived", revision: null };
        } else {
          // The replaced content becomes current again through the shared restore, even when it equals a later version.
          const outcome = await restoreSkillRevisionInTransaction(tx, { userId: input.userId, skillId: receipt.skillId,
            revision: { id: receipt.previousRevisionId! }, guard: { expectedVersion: receipt.version, expectedCurrentRevisionId: receipt.revisionId },
            whenUnchanged: "write" });
          if (outcome.kind === "conflict" || (outcome.kind === "refused" && outcome.code === "skill_archived")) return { state: "conflict" } as const;
          if (outcome.kind !== "restored") return { state: "unavailable" } as const;
          restored = { revisionId: outcome.revisionId, from: outcome.restored.revisionNumber };
          result = { state: "undone", outcome: "restored", revision: outcome.revisionNumber };
        }
        await tx.skillStoreOperation.create({ data: {
          ownerUserId: input.userId, clientId: SKILL_SAVE_UNDO_CLIENT_ID, operationKey: receipt.id,
          requestDigest: digest(JSON.stringify(["undo", receipt.id])), action: receipt.action === "create" ? "archive" : "restore",
          status: "COMPLETED", skillId: receipt.skillId, expectedVersion: receipt.version, expectedCurrentRevisionId: receipt.revisionId,
          ...(restored ? { revisionId: restored.revisionId } : {}),
          resultJson: { outcome: result.outcome, revision: result.revision, ...(restored ? { restoredRevision: restored.from } : {}) }
        } });
        return result;
      });
    },
    /** The immutable full text of one file of a revision a save made; SKILL.md is rendered from its fields. */
    async revisionFile(input: Readonly<{ userId: string; skillId: string; revisionId: string; path: string }>) {
      const revision = await db.skillRevision.findFirst({ where: { id: input.revisionId, skillId: input.skillId, bundleReady: true,
        skill: { ownerUserId: input.userId, deletedAt: null } }, select: { name: true, description: true, instructions: true,
        frontmatterJson: true, files: { where: { path: input.path }, select: { path: true, kind: true, textContent: true, byteSize: true } } } });
      if (!revision) return null;
      if (input.path === "SKILL.md") return { path: "SKILL.md", content: markdown(revision) };
      const file = revision.files[0];
      return file && file.kind === "text" && file.textContent !== null ? { path: file.path, content: file.textContent } : null;
    }
  };
}
export type SkillSaveUndoService = ReturnType<typeof createSkillSaveUndoService>;
