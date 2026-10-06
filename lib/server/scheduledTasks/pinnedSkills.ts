import type { Prisma, PrismaClient } from "@prisma/client";
import {
  scheduledTaskSkillNameProjection,
  type ScheduledTaskPinnedSkill,
  type ScheduledTaskRunSkill
} from "../../contracts/scheduledTasks";
import { skillAccessWhere } from "../skills/prismaRepository";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Projects a task's pinned Skills as the owner may see them now, one per id in
 * the given order. Every check of a pin (save, admission, the editor) reads
 * this one predicate.
 */
export type ScheduledTaskPinnedSkillLoader = (userId: string, skillIds: readonly string[]) =>
  Promise<ScheduledTaskPinnedSkill[]>;

const revision = { select: { hasExecutables: true, name: true } } as const;

/**
 * The owner's view of the named Skills, by id. A Skill the owner can no
 * longer see (deleted, or no longer shared to them) is absent, so its name
 * is never projected. One the owner sees is `available` exactly when a run's
 * Auto catalog would offer it (`createSkillCatalogRepository.listEnabledForRun`):
 * not archived, with a version the owner may load, and enabled for the owner
 * (an own Skill without a preference is enabled; a shared one needs one).
 */
export async function loadScheduledTaskPinnedSkillMap(
  client: Client,
  userId: string,
  skillIds: readonly string[]
): Promise<Map<string, ScheduledTaskPinnedSkill>> {
  const ids = [...new Set(skillIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.skillDefinition.findMany({
    select: {
      archivedAt: true, currentRevision: revision, id: true, ownerUserId: true,
      preferences: { select: { enabled: true }, where: { userId } }, sharedRevision: revision
    },
    where: { AND: [{ currentRevisionId: { not: null }, deletedAt: null, id: { in: ids } }, skillAccessWhere(userId)] }
  });
  return new Map(rows.flatMap((row) => {
    const owned = row.ownerUserId === userId;
    const current = owned ? row.currentRevision : row.sharedRevision;
    const name = current ? scheduledTaskSkillNameProjection(current.name) : null;
    if (!current || name === null) return [];
    const enabled = row.preferences[0]?.enabled ?? owned;
    return [[row.id, {
      available: row.archivedAt === null && enabled, hasExecutables: current.hasExecutables, id: row.id, name
    }] as const];
  }));
}

/** The pinned Skills of one task from a loaded view, a Skill the owner cannot see as an unnamed unavailable one. */
export function scheduledTaskPinnedSkillsFrom(
  view: ReadonlyMap<string, ScheduledTaskPinnedSkill>,
  skillIds: readonly string[]
): ScheduledTaskPinnedSkill[] {
  return skillIds.map((id) => view.get(id) ?? { available: false, hasExecutables: false, id, name: null });
}

export function createPrismaScheduledTaskPinnedSkillLoader(client: Client): ScheduledTaskPinnedSkillLoader {
  return async (userId, skillIds) =>
    scheduledTaskPinnedSkillsFrom(await loadScheduledTaskPinnedSkillMap(client, userId, skillIds), skillIds);
}

/**
 * The pinned Skills each run of the given ones loaded, with the version (the
 * revision number) each used, from the run's own bindings: content-free, and
 * frozen with the run whatever happened to the Skill since.
 */
export async function loadScheduledTaskRunSkills(
  client: Client,
  userId: string,
  runIds: readonly string[]
): Promise<Map<string, ScheduledTaskRunSkill[]>> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return new Map();
  const bindings = await client.modelRunSkillBinding.findMany({
    orderBy: [{ createdAt: "asc" }, { skillId: "asc" }],
    select: { modelRunId: true, revision: { select: { name: true, revisionNumber: true } } },
    where: { mode: "pinned", modelRun: { userId }, modelRunId: { in: ids } }
  });
  const skills = new Map<string, ScheduledTaskRunSkill[]>();
  for (const binding of bindings) {
    const name = scheduledTaskSkillNameProjection(binding.revision.name);
    if (name === null) continue;
    skills.set(binding.modelRunId, [...skills.get(binding.modelRunId) ?? [], { name, version: binding.revision.revisionNumber }]);
  }
  return skills;
}
