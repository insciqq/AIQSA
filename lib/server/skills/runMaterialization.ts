export type SkillRunMaterialization = {
  instructions: string;
  name: string;
  revisionId: string;
  skillId: string;
};

export type SkillRunResolution =
  | { ok: true; skills: SkillRunMaterialization[] }
  | { code: "skill_not_available"; ok: false; status: 404 };

export type SkillRunResolver = Readonly<{
  resolveForProject?(
    projectId: string,
    skillIds: readonly string[]
  ): Promise<SkillRunResolution>;
  resolveForRun(userId: string, skillIds: readonly string[]): Promise<SkillRunResolution>;
}>;
