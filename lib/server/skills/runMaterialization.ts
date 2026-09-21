import type { SkillFileSummary } from "../../contracts/skills";

export type SkillRunCatalogEntry = {
  description?: string;
  fileCount?: number;
  hasExecutables?: boolean;
  loadedBefore?: boolean;
  name: string;
  revisionId: string;
  skillId: string;
};

export type SkillRunMaterialization = SkillRunCatalogEntry & {
  files?: SkillFileSummary[];
  instructions: string;
  alias?: string;
  workspacePath?: string;
};

export type SkillRunResolution =
  | { ok: true; skills: SkillRunMaterialization[] }
  | { code: "skill_not_available"; ok: false; status: 404 };

export type SkillRunResolver = Readonly<{
  listEnabledForRun?(userId: string): Promise<SkillRunCatalogEntry[]>;
  loadedBeforeForMessages?(userId: string, chatId: string, messageIds: readonly string[]): Promise<string[]>;
  resolveForProject?(
    projectId: string,
    skillIds: readonly string[]
  ): Promise<SkillRunResolution>;
  resolveForRun(userId: string, skillIds: readonly string[]): Promise<SkillRunResolution>;
}>;
