import type { PrismaClient } from "@prisma/client";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { skillAccessWhere } from "../skills/prismaRepository";
import type { AssistantAccessEntry } from "./prismaRepository";

type DependencyStore = Pick<PrismaClient, "skillDefinition">;
type SkillSummary = NonNullable<AssistantAccessEntry["content"]["skillSummaries"]>[number];

/** Batches authorized Skills. Skill instructions stay server-side; only their
 * selected revision's estimate is projected. */
export async function withAssistantDependencyAvailability(
  client: DependencyStore,
  userId: string,
  entries: readonly AssistantAccessEntry[]
): Promise<AssistantAccessEntry[]> {
  const skillIds = [...new Set(entries.flatMap((entry) => entry.content.skillIds))];
  const definitions = skillIds.length ? await client.skillDefinition.findMany({
    select: { id: true, ownerUserId: true, archivedAt: true,
      currentRevision: { select: { name: true, instructions: true } }, sharedRevision: { select: { name: true, instructions: true } } },
    where: { AND: [{ id: { in: skillIds }, deletedAt: null }, skillAccessWhere(userId)] }
  }) : [];
  const skills = new Map(definitions.map(skill => {
    const revision = skill.ownerUserId === userId ? skill.currentRevision : skill.sharedRevision;
    return [skill.id, revision ? { name: revision.name, available: skill.archivedAt === null,
      instructionApproxTokens: estimateApproxTokens(revision.instructions) } : null] as const;
  }));
  return entries.map((entry) => ({
    ...entry,
    dependencyAvailability: {
      skills: entry.content.skillIds.every((id) => {
        const skill = skills.get(id);
        return skill?.available === true;
      })
    },
    content: {
      ...entry.content,
      skillSummaries: entry.content.skillIds.flatMap<SkillSummary>((id) => {
        const skill = skills.get(id);
        const delivery = entry.content.skillModes ? { mode: entry.content.skillModes[id] ?? "pinned" as const } : {};
        return skill ? [{ id, ...skill, ...delivery }]
          : entry.owned ? [{ id, name: "Unavailable Skill", available: false, ...delivery }] : [];
      })
    }
  }));
}
