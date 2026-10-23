import type { Prisma, PrismaClient } from "@prisma/client";
import {
  RESOURCE_CHANGE_TASKS_LIMIT,
  RESOURCE_CHANGE_TEXT_LIMITS,
  clipResourceChangeText,
  type SkillDeleteProposalCard
} from "@/lib/contracts/resourceChanges";
import type { SkillSaveCard } from "@/lib/contracts/skillSaves";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../tools/selfServiceCall";
import { newProposalId } from "../tools/resourceChangeCard";
import type { ToolExecutionResult } from "../tools/types";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import { createSkillBundle, parseSkillMarkdown, type SkillBundle } from "./bundle";
import { SkillBundleError } from "./bundleErrors";
import { skillAccessWhere } from "./prismaRepository";
import { commitSkillSaveInTransaction, type SkillSaveOutcome, type SkillSaveTarget } from "./skillSave";
import { activeScheduledTasksUsingSkill } from "./skillScheduledTasks";

/**
 * Skill writes by the agent from any chat (`manage_skill`): the content
 * comes from the call instead of a Workspace folder, and everything else is
 * the chat save's path (`commitSkillSaveInTransaction`): the revision write
 * core, the per-answer and hourly limits, text-only files, the guard against
 * the user's secret values, version guards, personal copies of other users'
 * Skills, the save card and its Undo. A save of an existing Skill changes
 * only the files it names: the rest of the version it is guarded by stays.
 */

/** One file the call adds or replaces: UTF-8 text. */
export type AgentSkillFileEdit = Readonly<{ path: string; bytes: Buffer }>;

export type AgentSkillSave = Readonly<{
  target: Exclude<SkillSaveTarget, Readonly<{ kind: "restore" }>>;
  /** Files to add or replace; SKILL.md replaces the name, description and instructions. */
  files: readonly AgentSkillFileEdit[];
  /** Files of the guarded version to leave out. */
  removeFiles: readonly string[];
  changeNote: string | null;
}>;

export type AgentSkillSaved = Readonly<{ card: SkillSaveCard; version: number }>;

export type AgentSkillRefusal =
  | Exclude<SkillSaveOutcome, Readonly<{ kind: "saved" }>>
  | Readonly<{ kind: "invalid"; code: "skill_markdown_required" | "skill_file_unknown" | "skill_binary_files_kept" | "skill_save_secret_detected";
      files?: readonly string[] }>
  | Readonly<{ kind: "invalid"; code: "skill_save_bundle_invalid"; problem: string; details: Readonly<Record<string, unknown>> }>;

export type AgentSkillDeleteProposal =
  | Readonly<{ kind: "proposed"; card: SkillDeleteProposalCard }>
  | Readonly<{ kind: "refused"; code: "skill_not_available" | "skill_delete_not_own" }>;

export type AgentSkillService = Readonly<{
  /** Saves a version (or restores one) and settles the call with `result` in the same transaction. */
  save(save: AgentSkillSave | Readonly<{ target: Extract<SkillSaveTarget, Readonly<{ kind: "restore" }>>; changeNote: string | null }>,
    result: (saved: AgentSkillSaved) => ToolExecutionResult): Promise<SelfServiceCommitOutcome<AgentSkillSaved, AgentSkillRefusal>>;
  /** The user's own Skill and what deleting it changes; nothing is deleted. */
  proposeDelete(skillId: string): Promise<AgentSkillDeleteProposal>;
}>;

type BaseRevision = Readonly<{
  name: string; description: string; instructions: string; frontmatterJson: Prisma.JsonValue;
  files: readonly Readonly<{ path: string; kind: string; executable: boolean; textContent: string | null }>[];
}>;

type ExistingTarget = Exclude<SkillSaveTarget, Readonly<{ kind: "new" | "restore" }>>;

/** The revision a save builds on, read before its transaction, and the guard the save commits under. */
type BaseRead = Readonly<{ content: BaseRevision; target: SkillSaveTarget }>;

type SkillReader = Pick<Prisma.TransactionClient, "skillDefinition" | "skillRevision">;

/**
 * The version a save of an existing Skill starts from: the revision the run
 * staged for a frozen alias, else the owner's current or another user's
 * shared revision. Revisions never change, so it is read before the save's
 * transaction, which then must not commit on top of anything else; the
 * guard returned makes the save's core re-check that under its lock:
 * - a frozen alias is already guarded by the exact revision read;
 * - a copy of another user's Skill names the shared revision it was built from;
 * - the owner's version guard that matched stays: versions only grow and every
 *   new current revision raises it, so the same version under the lock proves
 *   the base is still current;
 * - one that missed is a conflict, kept below the version read so no later
 *   version meets it, and the core refuses with the current files.
 */
async function loadBaseRevision(db: SkillReader, userId: string, target: ExistingTarget): Promise<BaseRead | null> {
  const definition = await db.skillDefinition.findFirst({ where: { deletedAt: null, id: target.skillId, ...skillAccessWhere(userId) },
    select: { currentRevisionId: true, ownerUserId: true, sharedRevisionId: true, version: true } });
  if (!definition) return null;
  const own = definition.ownerUserId === userId;
  const revisionId = target.kind === "frozen" ? target.revisionId : own ? definition.currentRevisionId : definition.sharedRevisionId;
  if (!revisionId) return null;
  const content = await db.skillRevision.findFirst({ where: { bundleReady: true, id: revisionId, skillId: target.skillId }, select: {
    description: true, frontmatterJson: true, instructions: true, name: true,
    files: { orderBy: { path: "asc" }, select: { executable: true, kind: true, path: true, textContent: true } }
  } });
  if (!content) return null;
  if (target.kind === "frozen") return { content, target };
  if (!own) return { content, target: { kind: "frozen", revisionId, skillId: target.skillId } };
  return { content, target: definition.version === target.expectedVersion ? target
    : { ...target, expectedVersion: Math.min(target.expectedVersion, definition.version - 1) } };
}

const textBytes = (text: string) => Buffer.from(text, "utf8");

/** The saved content: the base with the call's files replaced, added and removed, or a reason it cannot be one. */
export function overlaySkillBundle(base: BaseRevision | null, save: Pick<AgentSkillSave, "files" | "removeFiles">,
  needles: readonly Buffer[]): SkillBundle | Extract<AgentSkillRefusal, Readonly<{ kind: "invalid" }>> {
  const markdown = save.files.find((file) => file.path === "SKILL.md");
  if (!base && !markdown) return { code: "skill_markdown_required", kind: "invalid" };
  const leaked = save.files.filter((file) => needles.some((needle) => file.bytes.includes(needle))).map((file) => file.path);
  if (leaked.length) return { code: "skill_save_secret_detected", files: leaked, kind: "invalid" };
  const files = new Map<string, Readonly<{ path: string; bytes: Buffer; executable?: boolean }> | Readonly<{ binary: string }>>();
  for (const file of base?.files ?? []) {
    files.set(file.path, file.kind === "text" && file.textContent !== null
      ? { bytes: textBytes(file.textContent), executable: file.executable, path: file.path } : { binary: file.path });
  }
  const unknown = save.removeFiles.filter((path) => !files.has(path));
  if (unknown.length) return { code: "skill_file_unknown", files: unknown, kind: "invalid" };
  for (const path of save.removeFiles) files.delete(path);
  for (const file of save.files) if (file !== markdown) files.set(file.path, { bytes: file.bytes, path: file.path });
  const binary = [...files.values()].flatMap((file) => "binary" in file ? [file.binary] : []);
  if (binary.length) return { code: "skill_binary_files_kept", files: binary, kind: "invalid" };
  try {
    const draft = markdown ? parseSkillMarkdown(markdown.bytes, base?.name ?? "skill")
      : { description: base!.description, frontmatterJson: base!.frontmatterJson, instructions: base!.instructions, name: base!.name };
    return createSkillBundle(draft, [...files.values()].flatMap((file) => "binary" in file ? [] : [file]));
  } catch (error) {
    if (!(error instanceof SkillBundleError)) throw error;
    const { code, ...details } = error.issue;
    return { code: "skill_save_bundle_invalid", details, kind: "invalid", problem: code };
  }
}

/** Every saved secret the run may read, for the save guard. */
export async function runSecretValues(source: RunSecretSource, scope: Readonly<{ runId: string; userId: string }>): Promise<AcceptedWorkspaceSecret[]> {
  const entries = await source.list(scope);
  return Promise.all(entries.map((entry) => source.read({ ...scope, valueId: entry.valueId })));
}

type ServiceDatabase = Pick<PrismaClient, "$transaction" | "assistantDefinition" | "skillDefinition" | "skillRevision">;

export function createAgentSkillService(input: Readonly<{
  db: ServiceDatabase;
  store: SelfServiceCallStore;
  scope: SelfServiceScope;
  /** Exact values the save guard refuses (`skillSaveSecretNeedles` over the run's readable secrets). */
  secretNeedles: () => Promise<readonly Buffer[]>;
  commit?: typeof commitSkillSaveInTransaction;
}>): AgentSkillService {
  const { scope } = input;
  const commit = input.commit ?? commitSkillSaveInTransaction;

  /** A save's content and the guard it commits under, or why it cannot be one; a restore has no content. */
  async function prepare(save: Parameters<AgentSkillService["save"]>[0]): Promise<Readonly<{ kind: "prepared"; bundle: SkillBundle | null;
    target: SkillSaveTarget }> | Readonly<{ kind: "refused"; value: AgentSkillRefusal }>> {
    if (!("files" in save)) return { bundle: null, kind: "prepared", target: save.target };
    const needles = await input.secretNeedles();
    const base = save.target.kind === "new" ? null : await loadBaseRevision(input.db, scope.userId, save.target);
    if (save.target.kind !== "new" && !base) return { kind: "refused", value: { code: "skill_not_available", kind: "refused" } };
    const overlay = overlaySkillBundle(base?.content ?? null, save, needles);
    if ("kind" in overlay) return { kind: "refused", value: overlay };
    return { bundle: overlay, kind: "prepared", target: base?.target ?? save.target };
  }

  return {
    async save(save, result) {
      // The content (up to the bundle limit) is built before the transaction,
      // which stays short: the save's core re-checks the base under its lock.
      // A refusal still follows the claim, so a settled call keeps its result.
      const prepared = await prepare(save);
      return commitSelfServiceChange<AgentSkillSaved, AgentSkillRefusal>(input.db, input.store, async (tx) => {
        if (prepared.kind === "refused") return prepared;
        const outcome = await commit(tx, { bundle: prepared.bundle, changeNote: save.changeNote, operationKey: scope.callId, runId: scope.runId,
          target: prepared.target, userId: scope.userId });
        if (outcome.kind !== "saved") return { kind: "refused", value: outcome };
        const saved = { card: outcome.card, version: outcome.version };
        return { kind: "changed", result: result(saved), value: saved };
      });
    },

    async proposeDelete(skillId) {
      const definition = await input.db.skillDefinition.findFirst({
        select: { currentRevision: { select: { name: true } }, ownerUserId: true, publications: { select: { id: true }, take: 1 }, version: true },
        where: { deletedAt: null, id: skillId, ...skillAccessWhere(scope.userId) }
      });
      if (!definition) return { code: "skill_not_available", kind: "refused" };
      // A Skill the user can see but does not own is named as such; any other id looks missing.
      if (definition.ownerUserId !== scope.userId || !definition.currentRevision) return { code: "skill_delete_not_own", kind: "refused" };
      // Only the user's own Assistants: others' are not the user's to count.
      const assistantCount = await input.db.assistantDefinition.count({ where: { ownerUserId: scope.userId, skillLinks: { some: { skillId } } } });
      const tasks = await input.db.$transaction((tx) => activeScheduledTasksUsingSkill(tx, { skillId, userId: scope.userId }));
      const limits = RESOURCE_CHANGE_TEXT_LIMITS;
      return { kind: "proposed", card: { action: "delete_proposed", assistantCount,
        name: clipResourceChangeText(definition.currentRevision.name, limits.skillName), proposalId: newProposalId(), resource: "skill",
        scheduledTasks: tasks.tasks.slice(0, RESOURCE_CHANGE_TASKS_LIMIT)
          .map((task) => ({ taskId: task.taskId, title: clipResourceChangeText(task.title, limits.taskTitle) })),
        shared: definition.publications.length > 0, skillId, skillVersion: definition.version, version: 1 } };
    }
  };
}
