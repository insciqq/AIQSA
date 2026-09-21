export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1_024;
export const SKILL_INSTRUCTIONS_MAX_BYTES = 131_072;
/** Retained for form consumers; instructions are validated in UTF-8 bytes. */
export const SKILL_INSTRUCTIONS_MAX_LENGTH = SKILL_INSTRUCTIONS_MAX_BYTES;
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;
export const SKILL_FRONTMATTER_MAX_BYTES = 16_384;
export const SKILL_MAX_FILES = 200;
export const SKILL_FILE_MAX_BYTES = 8 * 1_024 * 1_024;
export const SKILL_TEXT_FILE_MAX_BYTES = 1_024 * 1_024;
export const SKILL_BUNDLE_MAX_BYTES = 24 * 1_024 * 1_024;
export const SKILL_ARCHIVE_MAX_ENTRIES = 2_000;
export const SKILL_ARCHIVE_MAX_BYTES = 96 * 1_024 * 1_024;
export const SKILL_MAX_PINNED = 32;
export const SKILL_MAX_AVAILABLE = 200;
export const SKILL_ASSISTANT_MAX_AVAILABLE = 64;
export const SKILL_FILE_PAGE_BYTES = 65_536;
export const SKILL_MAX_SELECTED = SKILL_MAX_PINNED;

export type SkillsMode = "auto" | "off";
export type AssistantSkillMode = "pinned" | "available";
export type SkillsSelection = { mode: SkillsMode };
export type SkillPreferenceResponse = { skillId: string; enabled: boolean };

export function decodeSkillsSelection(value: unknown): SkillsSelection | null {
  if (value === undefined) return { mode: "auto" };
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "mode") ||
    (value.mode !== "auto" && value.mode !== "off")) return null;
  return { mode: value.mode };
}

export type SkillValidationError = {
  code: string;
  field?: string;
  actual?: number;
  limit?: number;
};

export type SkillBudgetFacts = { pinnedTokens: number; catalogTokens: number; budgetTokens: number };

export type SkillFileSummary = {
  path: string;
  byteSize: number;
  kind: "text" | "binary";
  executable: boolean;
};

export type SkillImportResponse = {
  results: Array<{ name: string } & (
    | { outcome: "created" | "updated" | "unchanged"; skillId: string }
    | { outcome: "failed"; error: SkillValidationError }
  )>;
  ignoredFiles: number;
};

/** Assistant instructions precede manual instructions; overlap consumes one slot. */
export function resolveEffectiveSkillIds(includedIds: readonly string[], manualIds: readonly string[]): string[] {
  return [...new Set([...includedIds, ...manualIds])];
}

export type SkillDraft = {
  description: string;
  instructions: string;
  name: string;
};

export type SkillScope =
  | { kind: "owner" }
  | { kind: "workspace"; workspaceNames: string[] }
  | { kind: "installation" };

export type SkillSummary = {
  archived: boolean;
  enabled?: boolean;
  description: string;
  id: string;
  instructionCharacterCount: number;
  instructionApproxTokens?: number;
  fileCount?: number;
  hasExecutables?: boolean;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  scope: SkillScope;
  updatedAt: string;
  version: number;
};

export type SkillListResponse = {
  nextCursor: string | null;
  publishableWorkspaces: { id: string; name: string }[];
  skills: SkillSummary[];
  viewer: { canPublishInstallation: boolean };
};

export type SkillAudience =
  | { id: string; kind: "everyone"; name: "Everyone" }
  | { id: string; kind: "project"; name: "Project publication" }
  | { id: string; kind: "workspace"; name: string; workspaceId: string };

export const SKILL_REVIEW_NOTE_MAX_LENGTH = 4_000;
export const SKILL_SHARE_REQUEST_STATES = ["pending", "approved", "rejected", "withdrawn", "superseded"] as const;
export type SkillShareRequestState = typeof SKILL_SHARE_REQUEST_STATES[number];
export type SkillRevisionSummary = { id: string; revisionNumber: number; name: string; createdAt: string };
export type SkillShareRequestSummary = {
  id: string;
  revisionId: string;
  revisionNumber: number;
  state: SkillShareRequestState;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
};
export type SkillSharingStatus = {
  currentRevision: SkillRevisionSummary;
  sharedRevision: SkillRevisionSummary | null;
  request: SkillShareRequestSummary | null;
  canRequest: boolean;
  canWithdraw: boolean;
};

export type SkillDetail = SkillSummary & {
  assistantUsageCount: number;
  audiences: SkillAudience[];
  canDelete: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canUnshare: boolean;
  instructions: string;
  files?: SkillFileSummary[];
  bundle?: { fileCount: number; totalBytes: number; hasExecutables: boolean };
  /** Present only in the owner's private detail. */
  sharing?: SkillSharingStatus;
  owner: { displayName: string };
  workspaceUsageCount: number;
};

export type SkillMutationResponse = { skill: SkillDetail };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeSkillDraft(value: unknown):
  | { draft: SkillDraft; ok: true }
  | (SkillValidationError & { ok: false }) {
  if (!isRecord(value)) return { code: "skill_draft_invalid", ok: false };
  const keys = Object.keys(value);
  if (keys.some((key) => !["description", "instructions", "name"].includes(key))) {
    return { code: "skill_draft_invalid", ok: false };
  }
  if (keys.some((key) => typeof value[key] !== "string")) {
    return { code: "skill_draft_invalid", ok: false };
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const instructions = typeof value.instructions === "string" ? value.instructions.trim() : "";
  for (const [field, text, limit, bytes] of [
    ["name", name, SKILL_NAME_MAX_LENGTH, false],
    ["description", description, SKILL_DESCRIPTION_MAX_LENGTH, false],
    ["instructions", instructions, SKILL_INSTRUCTIONS_MAX_BYTES, true]
  ] as const) {
    if (!text) return { code: "skill_field_required", field, ok: false };
    if (/[\u0000\uD800-\uDFFF]/u.test(text)) return { code: "skill_field_invalid", field, ok: false };
    const actual = bytes ? new TextEncoder().encode(text).length : [...text].length;
    if (actual > limit) return { code: "skill_field_too_long", field, actual, limit, ok: false };
  }
  return { draft: { description, instructions, name }, ok: true };
}

export function decodeSkillIds(value: unknown):
  | { ids: string[]; ok: true }
  | (SkillValidationError & { ok: false }) {
  if (!Array.isArray(value)) {
    return { code: "skills_invalid", ok: false };
  }
  if (value.length > SKILL_MAX_PINNED) return {
    code: "skills_count_exceeded", field: "pinned", actual: value.length, limit: SKILL_MAX_PINNED, ok: false
  };
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 64 ||
      ids.includes(candidate.trim())) {
      return { code: "skills_invalid", ok: false };
    }
    ids.push(candidate.trim());
  }
  return { ids, ok: true };
}
