import { SKILL_SAVE_CHANGE_NOTE_MAX_LENGTH } from "./skillSaves";

/**
 * Client-safe contract of a personal Skill's version history and restore.
 * Versions are the definition's ready immutable revisions, newest first; a
 * restore makes an earlier one current again as a new version with the same
 * content, so history is never rewritten and the published version stays.
 */

export const SKILL_VERSIONS_PAGE_LIMIT = 30;

export type SkillVersionSummary = Readonly<{
  revisionId: string;
  /** The `vN` the library, cards and chat show. */
  revisionNumber: number;
  createdAt: string;
  /** Null when the author's account no longer exists. */
  authorDisplayName: string | null;
  fileCount: number;
  byteSize: number;
  hasExecutables: boolean;
  current: boolean;
  /** The version colleagues use until the owner shares again. */
  shared: boolean;
  /** The note a chat save recorded, when present. */
  changeNote: string | null;
  /** This version was made by restoring `vN`. */
  restoredFrom: number | null;
}>;

export type SkillVersionsResponse = Readonly<{
  skillId: string;
  /** The definition's optimistic version a restore must send as `expectedVersion`. */
  version: number;
  archived: boolean;
  versions: readonly SkillVersionSummary[];
  /** Pass as `before` to read older versions; null when none remain. */
  nextBefore: number | null;
}>;

export type SkillRestoreResponse =
  | Readonly<{ outcome: "restored"; version: number; revisionNumber: number; restoredFrom: number }>
  /** The chosen version already is the current content; nothing was written. */
  | Readonly<{ outcome: "unchanged"; version: number }>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const VERSION_KEYS = ["revisionId", "revisionNumber", "createdAt", "authorDisplayName", "fileCount", "byteSize", "hasExecutables",
  "current", "shared", "changeNote", "restoredFrom"] as const;

function decodeVersion(value: unknown): SkillVersionSummary | null {
  if (!record(value) || !VERSION_KEYS.every((key) => key in value) || !only(value, VERSION_KEYS) || !id(value.revisionId) ||
    !positive(value.revisionNumber) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    !(value.authorDisplayName === null || (typeof value.authorDisplayName === "string" && value.authorDisplayName.length <= 256)) ||
    !count(value.fileCount) || !count(value.byteSize) || typeof value.hasExecutables !== "boolean" ||
    typeof value.current !== "boolean" || typeof value.shared !== "boolean" ||
    !(value.changeNote === null || (typeof value.changeNote === "string" && value.changeNote.length <= SKILL_SAVE_CHANGE_NOTE_MAX_LENGTH)) ||
    !(value.restoredFrom === null || positive(value.restoredFrom))) return null;
  return {
    revisionId: value.revisionId, revisionNumber: value.revisionNumber, createdAt: value.createdAt,
    authorDisplayName: value.authorDisplayName, fileCount: value.fileCount, byteSize: value.byteSize,
    hasExecutables: value.hasExecutables, current: value.current, shared: value.shared, changeNote: value.changeNote,
    restoredFrom: value.restoredFrom
  };
}

export function decodeSkillVersionsResponse(value: unknown): SkillVersionsResponse | null {
  if (!record(value) || !only(value, ["skillId", "version", "archived", "versions", "nextBefore"]) || !id(value.skillId) ||
    !positive(value.version) || typeof value.archived !== "boolean" || !Array.isArray(value.versions) ||
    value.versions.length > SKILL_VERSIONS_PAGE_LIMIT || !(value.nextBefore === null || positive(value.nextBefore))) return null;
  const versions: SkillVersionSummary[] = [];
  for (const item of value.versions) {
    const version = decodeVersion(item);
    if (!version) return null;
    versions.push(version);
  }
  return { skillId: value.skillId, version: value.version, archived: value.archived, versions, nextBefore: value.nextBefore };
}

export function decodeSkillRestoreResponse(value: unknown): SkillRestoreResponse | null {
  if (!record(value)) return null;
  if (value.outcome === "unchanged" && only(value, ["outcome", "version"]) && positive(value.version)) {
    return { outcome: "unchanged", version: value.version };
  }
  if (value.outcome === "restored" && only(value, ["outcome", "version", "revisionNumber", "restoredFrom"]) &&
    positive(value.version) && positive(value.revisionNumber) && positive(value.restoredFrom)) {
    return { outcome: "restored", version: value.version, revisionNumber: value.revisionNumber, restoredFrom: value.restoredFrom };
  }
  return null;
}
