import type { PrismaClient } from "@prisma/client";
import { estimateApproxTokens } from "../../domain/contextBudget";
import {
  KnowledgeRunAdmissionError,
  knowledgeRunAdmissionHasReadySources,
  loadKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionStore
} from "../knowledge/runAdmission";
import { skillAccessWhere } from "../skills/prismaRepository";
import type { AssistantAccessEntry } from "./prismaRepository";

type DependencyStore = Pick<PrismaClient, "skillDefinition"> & KnowledgeRunAdmissionStore;
type SkillSummary = NonNullable<AssistantAccessEntry["content"]["skillSummaries"]>[number];

/** Reuses admission's metadata-only Knowledge reader and batches authorized Skills.
 * Skill instructions stay server-side; only their selected revision's estimate is projected. */
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
  const knowledgeAvailability = new Map<string, NonNullable<AssistantAccessEntry["dependencyAvailability"]>["knowledge"]>();
  const projected: AssistantAccessEntry[] = [];
  for (const entry of entries) {
    const selection = entry.content.knowledgeSelection;
    const key = JSON.stringify(selection);
    if (!knowledgeAvailability.has(key)) {
      let availability: NonNullable<AssistantAccessEntry["dependencyAvailability"]>["knowledge"] = "ready";
      if (selection.mode !== "none") {
        try {
          availability = knowledgeRunAdmissionHasReadySources(await loadKnowledgeRunAdmissionPlan(client, {
            knowledgePlan: selection, userId
          })) ? "ready" : "not_ready";
        } catch (error) {
          // A broken dependency must not hide unrelated Assistants. Do not
          // expose configuration errors or private dependency metadata here.
          availability = error instanceof KnowledgeRunAdmissionError ? "access_denied" : "unavailable";
        }
      }
      knowledgeAvailability.set(key, availability);
    }
    projected.push({
      ...entry,
      dependencyAvailability: {
        knowledge: knowledgeAvailability.get(key)!,
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
    });
  }
  return projected;
}
