import type { SkillAudience, SkillFileSummary, SkillRevisionSummary, SkillShareRequestSummary } from "./skills";

export type AdminSkillShareRequestSummary = SkillShareRequestSummary & {
  skillId: string;
  name: string;
  ownerDisplayName: string;
  canReview: boolean;
};
export type AdminSkillShareRequestListResponse = {
  requests: AdminSkillShareRequestSummary[];
  nextCursor: string | null;
  pendingCount: number;
};
export type AdminSkillFileDiff = SkillFileSummary & {
  change: "added" | "removed" | "changed";
  previousExecutable?: boolean;
};
export type AdminSkillShareRequestDetail = AdminSkillShareRequestSummary & {
  audiences: SkillAudience[];
  currentRevision: SkillRevisionSummary | null;
  sharedRevision: SkillRevisionSummary | null;
  requestedRevision: SkillRevisionSummary & {
    description: string;
    instructions: string;
    skillMarkdown: string;
    files: SkillFileSummary[];
    bundle: { fileCount: number; totalBytes: number; hasExecutables: boolean };
  };
  diff: { skillMarkdownChanged: boolean; files: AdminSkillFileDiff[] };
};
export type AdminSkillShareRequestDetailResponse = { request: AdminSkillShareRequestDetail };
export type AdminSkillShareDecision = { action: "approve" | "reject"; note?: string };
export type SkillShareRequestCreate = { expectedVersion: number };
export type SkillShareRequestWithdraw = { requestId: string };

/** A Skill the release ships to everyone; `enabled` is the installation-wide switch. */
export type AdminBuiltInSkill = {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  /** Assistants linking it, which become unavailable while it is off. */
  assistantUsageCount: number;
};
export type AdminBuiltInSkillListResponse = { skills: AdminBuiltInSkill[] };
export type AdminBuiltInSkillUpdate = { enabled: boolean; expectedVersion: number };
export type AdminBuiltInSkillUpdateResponse = { skill: AdminBuiltInSkill };
