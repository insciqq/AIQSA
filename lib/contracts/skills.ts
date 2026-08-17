export const SKILL_NAME_MAX_LENGTH = 80;
export const SKILL_DESCRIPTION_MAX_LENGTH = 400;
export const SKILL_INSTRUCTIONS_MAX_LENGTH = 32_000;
export const SKILL_MAX_SELECTED = 8;

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
  description: string;
  id: string;
  instructionCharacterCount: number;
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

export type SkillDetail = SkillSummary & {
  assistantUsageCount: number;
  audiences: SkillAudience[];
  canDelete: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canUnshare: boolean;
  instructions: string;
  owner: { displayName: string };
  workspaceUsageCount: number;
};

export type SkillMutationResponse = { skill: SkillDetail };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeSkillDraft(value: unknown):
  | { draft: SkillDraft; ok: true }
  | { code: "skill_draft_invalid"; ok: false } {
  if (!isRecord(value)) return { code: "skill_draft_invalid", ok: false };
  const keys = Object.keys(value);
  if (keys.some((key) => !["description", "instructions", "name"].includes(key))) {
    return { code: "skill_draft_invalid", ok: false };
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const instructions = typeof value.instructions === "string" ? value.instructions.trim() : "";
  if (!name || name.length > SKILL_NAME_MAX_LENGTH ||
    description.length > SKILL_DESCRIPTION_MAX_LENGTH ||
    !instructions || instructions.length > SKILL_INSTRUCTIONS_MAX_LENGTH) {
    return { code: "skill_draft_invalid", ok: false };
  }
  return { draft: { description, instructions, name }, ok: true };
}

export function decodeSkillIds(value: unknown):
  | { ids: string[]; ok: true }
  | { code: "skills_invalid"; ok: false } {
  if (!Array.isArray(value) || value.length > SKILL_MAX_SELECTED) {
    return { code: "skills_invalid", ok: false };
  }
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
