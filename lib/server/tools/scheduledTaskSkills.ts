import { SCHEDULED_TASK_MAX_PINNED_SKILLS, type ScheduledTask } from "../../contracts/scheduledTasks";
import { decodeFrozenSkillManifest } from "../skills/runManifest";

/**
 * How the scheduled task tools name Skills. A model sees a run's Skills by
 * alias and name (`<available_skills>` and pinned instructions), never by id,
 * so a task's pinned Skills are given by alias or exact name and resolve only
 * against the run's own frozen catalog: a model can pin only a Skill this run
 * was admitted to offer the owner. The owner's rules recheck each one against
 * the Skills available to the owner now before anything is saved.
 */

type SkillCatalogRequest = Readonly<{ skills?: unknown }>;
type CatalogSkill = Readonly<{ alias: string; name: string; skillId: string }>;

/** The schema of the Skill list both tools take. */
export const SCHEDULED_TASK_SKILLS_SCHEMA = {
  description: `Aliases of this chat's skills to pin, at most ${SCHEDULED_TASK_MAX_PINNED_SKILLS}.`,
  items: { type: "string" },
  type: ["array", "null"]
} as const;

/** The run's frozen Skills (pinned first, then the Auto catalog); none for a run without Skills. */
function runSkills(request: SkillCatalogRequest): CatalogSkill[] {
  const manifest = decodeFrozenSkillManifest(request.skills);
  return manifest ? [...manifest.pinned, ...manifest.available] : [];
}

/**
 * The Skill ids the model's references name, in its order without repeats,
 * or why they cannot be used. A reference matches a run Skill's alias, else
 * its name, case-insensitively.
 */
export function resolveScheduledTaskSkillReferences(
  request: SkillCatalogRequest,
  references: unknown
): Readonly<{ ok: true; skillIds: string[] }> | Readonly<{ ok: false; message: string }> {
  if (!Array.isArray(references) || references.some((reference) => typeof reference !== "string")) {
    return { ok: false, message: "skills must be a list of Skill aliases or names." };
  }
  const skills = runSkills(request);
  const skillIds: string[] = [];
  const unknown: string[] = [];
  for (const reference of references as string[]) {
    const wanted = reference.trim().toLowerCase();
    const skill = skills.find((entry) => entry.alias === wanted) ??
      skills.find((entry) => entry.name.trim().toLowerCase() === wanted);
    if (!skill) unknown.push(reference.slice(0, 64));
    else if (!skillIds.includes(skill.skillId)) skillIds.push(skill.skillId);
  }
  if (unknown.length > 0) {
    return { ok: false, message: `${unknown.map((name) => JSON.stringify(name)).join(", ")} ${unknown.length === 1 ? "is" : "are"} ` +
      "not among this chat's skills; use an alias from the skills listed here, or ask the user to pin the Skill in the composer." };
  }
  if (skillIds.length > SCHEDULED_TASK_MAX_PINNED_SKILLS) {
    return { ok: false, message: `A task pins at most ${SCHEDULED_TASK_MAX_PINNED_SKILLS} Skills.` };
  }
  return { ok: true, skillIds };
}

/** A task's pinned Skills as the model reads them: the names the owner may see, never ids. */
export function scheduledTaskModelSkills(task: Pick<ScheduledTask, "pinnedSkillIds" | "pinnedSkills">):
  Readonly<{ name: string | null; available: boolean }>[] {
  return task.pinnedSkills
    ? task.pinnedSkills.map((skill) => ({ available: skill.available, name: skill.name }))
    : task.pinnedSkillIds.map(() => ({ available: false, name: null }));
}
