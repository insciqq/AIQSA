import type { PrismaClient } from "@prisma/client";
import {
  KnowledgeRunAdmissionError,
  knowledgeRunAdmissionHasReadySources,
  loadKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionStore
} from "../knowledge/runAdmission";
import { skillAccessWhere } from "../skills/prismaRepository";
import type { AssistantAccessEntry } from "./prismaRepository";

type DependencyStore = Pick<PrismaClient, "skillDefinition"> & KnowledgeRunAdmissionStore;

/** Reuses admission's metadata-only Knowledge reader and batches linked Skill metadata.
 * No document content, provider requests or runtime startup belongs in this projection. */
export async function withAssistantDependencyAvailability(
  client: DependencyStore,
  userId: string,
  entries: readonly AssistantAccessEntry[]
): Promise<AssistantAccessEntry[]> {
  const skillIds = [...new Set(entries.flatMap((entry) => entry.content.skillIds))];
  const definitions = skillIds.length ? await client.skillDefinition.findMany({
    select: { id: true, archivedAt: true, currentRevision: { select: { name: true } } },
    where: { AND: [{ id: { in: skillIds }, deletedAt: null }, skillAccessWhere(userId)] }
  }) : [];
  const skills = new Map(definitions.map((skill) => [skill.id, skill]));
  const knowledgeAvailability = new Map<string, boolean>();
  const projected: AssistantAccessEntry[] = [];
  for (const entry of entries) {
    const selection = entry.content.knowledgeSelection;
    const key = JSON.stringify(selection);
    if (!knowledgeAvailability.has(key)) {
      let available = selection.mode === "none";
      if (!available) {
        try {
          available = knowledgeRunAdmissionHasReadySources(await loadKnowledgeRunAdmissionPlan(client, {
            knowledgePlan: selection, userId
          }));
        } catch (error) {
          if (!(error instanceof KnowledgeRunAdmissionError)) throw error;
        }
      }
      knowledgeAvailability.set(key, available);
    }
    projected.push({
      ...entry,
      dependencyAvailability: {
        knowledge: knowledgeAvailability.get(key)!,
        skills: entry.content.skillIds.every((id) => {
          const skill = skills.get(id);
          return skill?.archivedAt === null && skill.currentRevision !== null;
        })
      },
      content: {
        ...entry.content,
        skillSummaries: entry.content.skillIds.flatMap((id) => {
          const revision = skills.get(id)?.currentRevision;
          return revision ? [{ id, name: revision.name }] : entry.owned ? [{ id, name: "Unavailable Skill" }] : [];
        })
      }
    });
  }
  return projected;
}
