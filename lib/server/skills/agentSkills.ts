import type { Prisma, PrismaClient } from "@prisma/client";
import { RESOURCE_CHANGE_TASKS_LIMIT, type SkillDeleteProposalCard } from "@/lib/contracts/resourceChanges";
import type { SkillSaveCard } from "@/lib/contracts/skillSaves";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import { createSkillBundle, parseSkillMarkdown, type SkillBundle } from "./bundle";
import { SkillBundleError } from "./bundleErrors";
import { lockSkillRevisionWrites, skillAccessWhere } from "./prismaRepository";
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

/**
 * The version a save of an existing Skill starts from: the revision the run
 * staged for a frozen alias, else the owner's current or another user's
 * shared revision. The save's own guard then decides whether it may write.
 */
async function loadBaseRevision(tx: Prisma.TransactionClient, userId: string,
  target: Exclude<SkillSaveTarget, Readonly<{ kind: "new" | "restore" }>>): Promise<BaseRevision | null> {
  const definition = await tx.skillDefinition.findFirst({ where: { deletedAt: null, id: target.skillId, ...skillAccessWhere(userId) },
    select: { currentRevisionId: true, ownerUserId: true, sharedRevisionId: true } });
  if (!definition) return null;
  const revisionId = target.kind === "frozen" ? target.revisionId
    : definition.ownerUserId === userId ? definition.currentRevisionId : definition.sharedRevisionId;
  if (!revisionId) return null;
  return tx.skillRevision.findFirst({ where: { bundleReady: true, id: revisionId, skillId: target.skillId }, select: {
    description: true, frontmatterJson: true, instructions: true, name: true,
    files: { orderBy: { path: "asc" }, select: { executable: true, kind: true, path: true, textContent: true } }
  } });
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

type ServiceDatabase = Pick<PrismaClient, "$transaction" | "assistantDefinition" | "skillDefinition">;

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
  return {
    async save(save, result) {
      const needles = "files" in save ? await input.secretNeedles() : [];
      return commitSelfServiceChange<AgentSkillSaved, AgentSkillRefusal>(input.db, input.store, async (tx) => {
        let bundle: SkillBundle | null = null;
        if ("files" in save) {
          await lockSkillRevisionWrites(tx, scope.userId);
          const base = save.target.kind === "new" ? null : await loadBaseRevision(tx, scope.userId, save.target);
          if (save.target.kind !== "new" && !base) return { kind: "refused", value: { code: "skill_not_available", kind: "refused" } };
          const overlay = overlaySkillBundle(base, save, needles);
          if ("kind" in overlay) return { kind: "refused", value: overlay };
          bundle = overlay;
        }
        const outcome = await commit(tx, { bundle, changeNote: save.changeNote, operationKey: scope.callId, runId: scope.runId,
          target: save.target, userId: scope.userId });
        if (outcome.kind !== "saved") return { kind: "refused", value: outcome };
        const saved = { card: outcome.card, version: outcome.version };
        return { kind: "changed", result: result(saved), value: saved };
      });
    },

    async proposeDelete(skillId) {
      const definition = await input.db.skillDefinition.findFirst({
        select: { currentRevision: { select: { name: true } }, ownerUserId: true, publications: { select: { id: true }, take: 1 } },
        where: { deletedAt: null, id: skillId, ...skillAccessWhere(scope.userId) }
      });
      if (!definition) return { code: "skill_not_available", kind: "refused" };
      // A Skill the user can see but does not own is named as such; any other id looks missing.
      if (definition.ownerUserId !== scope.userId || !definition.currentRevision) return { code: "skill_delete_not_own", kind: "refused" };
      const assistantCount = await input.db.assistantDefinition.count({ where: { skillLinks: { some: { skillId } } } });
      const tasks = await input.db.$transaction((tx) => activeScheduledTasksUsingSkill(tx, { skillId, userId: scope.userId }));
      return { kind: "proposed", card: { action: "delete_proposed", assistantCount, name: definition.currentRevision.name, resource: "skill",
        scheduledTasks: tasks.tasks.slice(0, RESOURCE_CHANGE_TASKS_LIMIT), shared: definition.publications.length > 0, skillId, version: 1 } };
    }
  };
}
