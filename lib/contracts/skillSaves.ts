/**
 * Client-safe contract of the chat `save_skill` tool's answer card and its
 * Undo. A chat answer saves a Workspace folder as a new personal Skill or a
 * new version of the owner's Skill without confirmation; the card shows the
 * result after the fact (`ThreadArtifactSummary.skillSaves`).
 */

/** Saves one user may make from chat answers in a rolling hour. */
export const SKILL_SAVE_HOURLY_LIMIT = 20;
/** Files one chat save captures, SKILL.md included (one coherent Workspace capture). */
export const SKILL_SAVE_MAX_FILES = 100;
export const SKILL_SAVE_CHANGE_NOTE_MAX_LENGTH = 280;
/** Files a card lists: a save's files plus the previous version's removed ones. */
export const SKILL_SAVE_CARD_FILES_LIMIT = 301;
export const SKILL_SAVE_CARD_DIFFS_LIMIT = 20;
export const SKILL_SAVE_DIFF_LINES_LIMIT = 80;
export const SKILL_SAVE_DIFF_LINE_MAX_LENGTH = 300;
export const SKILL_SAVE_CARD_TASKS_LIMIT = 5;
/** Cards one answer carries: one save. Older answers never hold more. */
export const SKILL_SAVE_CARDS_LIMIT = 1;
export const SKILL_LIBRARY_PATH = "/?library=skills";

export type SkillSaveFileChange = "added" | "changed" | "removed" | "unchanged";
export type SkillSaveCardFile = Readonly<{
  path: string;
  change: SkillSaveFileChange;
  /** Whether the saved version runs it (a `#!` line); a removed file's former flag. */
  executable: boolean;
  /** Set when the executable flag differs from the previous version. */
  executableChanged?: true;
  /** A binary file (only a restored version holds them): no diff and no text view. */
  binary?: true;
}>;
export type SkillSaveDiffLine = Readonly<{ kind: "context" | "add" | "del" | "gap"; text: string }>;
export type SkillSaveCardDiff = Readonly<{ path: string; lines: readonly SkillSaveDiffLine[]; truncated: boolean }>;
export type SkillSaveCardTask = Readonly<{ taskId: string; title: string }>;

/**
 * One save as its call left it. `fromRevision`/`toRevision` are the Skill's
 * revision numbers (`v3 → v4`); `saveId` names the save's receipt for Undo;
 * `revisionId` is the saved immutable revision the full-file view reads. A
 * `restored` save made an earlier version current again as a new one
 * (`v4 → v5 (= v3)`, `restoredRevision` 3).
 */
export type SkillSaveCard = Readonly<{
  version: 1;
  saveId: string;
  skillId: string;
  revisionId: string;
  name: string;
  outcome: "created" | "updated" | "restored";
  fromRevision: number | null;
  toRevision: number;
  /** Set only for `restored`: the version whose content is current again. */
  restoredRevision?: number;
  changeNote: string | null;
  /** Name of another user's Skill this personal copy was made from. */
  copiedFrom: string | null;
  /** The Skill has a published version colleagues keep until the owner shares again. */
  published: boolean;
  files: readonly SkillSaveCardFile[];
  diffs: readonly SkillSaveCardDiff[];
  /** Active scheduled tasks that use this Skill; their next run uses the saved version. */
  scheduledTasks: readonly SkillSaveCardTask[];
  scheduledTasksTruncated: boolean;
}>;

/** What Undo did or could do for one save, as the owner's store reads it now. */
export type SkillSaveUndoState =
  | Readonly<{ state: "available" }>
  /** Archived the Skill the save created, or made the previous content current again as `revision`. */
  | Readonly<{ state: "undone"; outcome: "archived" | "restored"; revision: number | null }>
  /** The Skill changed after this save; Undo would overwrite that change and does nothing. */
  | Readonly<{ state: "conflict" }>
  | Readonly<{ state: "unavailable" }>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length <= maximum && !value.includes("\0");
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const CHANGES: readonly unknown[] = ["added", "changed", "removed", "unchanged"];
const LINE_KINDS: readonly unknown[] = ["context", "add", "del", "gap"];
const CARD_KEYS = ["version", "saveId", "skillId", "revisionId", "name", "outcome", "fromRevision", "toRevision", "changeNote",
  "copiedFrom", "published", "files", "diffs", "scheduledTasks", "scheduledTasksTruncated"] as const;

function decodeFile(value: unknown): SkillSaveCardFile | null {
  if (!record(value) || !only(value, ["path", "change", "executable", "executableChanged", "binary"]) || !text(value.path, 1_024) ||
    !value.path || !CHANGES.includes(value.change) || typeof value.executable !== "boolean" ||
    (value.executableChanged !== undefined && value.executableChanged !== true) ||
    (value.binary !== undefined && value.binary !== true)) return null;
  return { path: value.path, change: value.change as SkillSaveFileChange, executable: value.executable,
    ...(value.executableChanged ? { executableChanged: true as const } : {}), ...(value.binary ? { binary: true as const } : {}) };
}

function decodeDiff(value: unknown): SkillSaveCardDiff | null {
  if (!record(value) || !only(value, ["path", "lines", "truncated"]) || !text(value.path, 1_024) || !value.path ||
    typeof value.truncated !== "boolean" || !Array.isArray(value.lines) || value.lines.length > SKILL_SAVE_DIFF_LINES_LIMIT) return null;
  const lines: SkillSaveDiffLine[] = [];
  for (const line of value.lines) {
    if (!record(line) || !only(line, ["kind", "text"]) || !LINE_KINDS.includes(line.kind) ||
      !text(line.text, SKILL_SAVE_DIFF_LINE_MAX_LENGTH)) return null;
    lines.push({ kind: line.kind as SkillSaveDiffLine["kind"], text: line.text });
  }
  return { path: value.path, lines, truncated: value.truncated };
}

function decodeList<T>(value: unknown, decode: (item: unknown) => T | null, maximum: number): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const items: T[] = [];
  for (const item of value) {
    const decoded = decode(item);
    if (!decoded) return null;
    items.push(decoded);
  }
  return items;
}

export function decodeSkillSaveCard(value: unknown): SkillSaveCard | null {
  if (!record(value) || !CARD_KEYS.every((key) => key in value) || !only(value, [...CARD_KEYS, "restoredRevision"]) ||
    value.version !== 1 || !id(value.saveId) || !id(value.skillId) || !id(value.revisionId) || !text(value.name, 256) || !value.name ||
    (value.outcome !== "created" && value.outcome !== "updated" && value.outcome !== "restored") ||
    !(value.fromRevision === null || positive(value.fromRevision)) || !positive(value.toRevision) ||
    (value.outcome === "created") !== (value.fromRevision === null) ||
    (value.outcome === "restored" ? !positive(value.restoredRevision) : value.restoredRevision !== undefined) ||
    !(value.changeNote === null || text(value.changeNote, SKILL_SAVE_CHANGE_NOTE_MAX_LENGTH)) ||
    !(value.copiedFrom === null || text(value.copiedFrom, 256)) || typeof value.published !== "boolean" ||
    typeof value.scheduledTasksTruncated !== "boolean") return null;
  const files = decodeList(value.files, decodeFile, SKILL_SAVE_CARD_FILES_LIMIT);
  const diffs = decodeList(value.diffs, decodeDiff, SKILL_SAVE_CARD_DIFFS_LIMIT);
  const scheduledTasks = decodeList(value.scheduledTasks, (task) => record(task) && only(task, ["taskId", "title"]) &&
    id(task.taskId) && text(task.title, 120) && task.title ? { taskId: task.taskId, title: task.title } : null,
  SKILL_SAVE_CARD_TASKS_LIMIT);
  if (!files || !diffs || !scheduledTasks) return null;
  return {
    version: 1, saveId: value.saveId, skillId: value.skillId, revisionId: value.revisionId, name: value.name,
    outcome: value.outcome, fromRevision: value.fromRevision, toRevision: value.toRevision,
    ...(value.outcome === "restored" ? { restoredRevision: value.restoredRevision as number } : {}), changeNote: value.changeNote,
    copiedFrom: value.copiedFrom, published: value.published, files, diffs, scheduledTasks,
    scheduledTasksTruncated: value.scheduledTasksTruncated
  };
}

export function decodeSkillSaveUndoState(value: unknown): SkillSaveUndoState | null {
  if (!record(value)) return null;
  if ((value.state === "available" || value.state === "conflict" || value.state === "unavailable") && only(value, ["state"])) {
    return { state: value.state };
  }
  if (value.state === "undone" && only(value, ["state", "outcome", "revision"]) &&
    (value.outcome === "archived" || value.outcome === "restored") &&
    (value.revision === null || positive(value.revision))) {
    return { state: "undone", outcome: value.outcome, revision: value.revision };
  }
  return null;
}

/** An answer's save cards from its artifact payloads: decoded, one per save, bounded. */
export function foldSkillSaveCards(payloads: readonly unknown[]): SkillSaveCard[] {
  const cards = new Map<string, SkillSaveCard>();
  for (const payload of payloads) {
    const card = decodeSkillSaveCard(payload);
    if (card && !cards.has(card.saveId) && cards.size < SKILL_SAVE_CARDS_LIMIT) cards.set(card.saveId, card);
  }
  return [...cards.values()];
}
