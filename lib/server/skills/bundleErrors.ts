import type { SkillValidationError } from "../../contracts/skills";

export class SkillBundleError extends Error {
  constructor(readonly issue: SkillValidationError) {
    super(issue.code);
    this.name = "SkillBundleError";
  }
}

export function skillLimit(field: string, actual: number, limit: number): void {
  if (actual > limit) throw new SkillBundleError({ code: "skill_limit_exceeded", field, actual, limit });
}
