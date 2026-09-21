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
