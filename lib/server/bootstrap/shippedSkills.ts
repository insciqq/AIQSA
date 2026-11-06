import { Prisma, type PrismaClient } from "@prisma/client";
import { appendShippedSkillRevision } from "@/lib/server/skills/revisionWriteCore";
import type { ShippedSkill } from "@/lib/server/skills/shippedSkills";

const SHIPPED_SKILLS_LOCK_KEY = "aiqsa:shipped-skills:v1";
const ATTEMPTS = 3;

export type ShippedSkillSynchronization = Readonly<{
  created: number;
  updated: number;
  retired: number;
}>;

/**
 * Brings the installation's shipped Skills in line with the release on every
 * upgrade. Unchanged text writes nothing; changed text appends a revision that
 * only future messages see, because accepted runs keep their frozen one. A key
 * the release no longer ships is retired like a deleted Skill: it leaves every
 * catalog and Assistant, while revisions and past runs stay. The archive
 * switch is the administrator's installation-wide Off and is never touched,
 * and users' preferences stay keyed to the same definition across revisions.
 */
export async function synchronizeShippedSkillsInTransaction(
  tx: Prisma.TransactionClient,
  shipped: readonly ShippedSkill[],
  now: Date
): Promise<ShippedSkillSynchronization> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${SHIPPED_SKILLS_LOCK_KEY}, 0))::text`;
  const existing = await tx.skillDefinition.findMany({
    where: { shippedKey: { not: null } },
    select: { id: true, shippedKey: true, deletedAt: true, currentRevision: { select: { bundleDigest: true } } }
  });
  const byKey = new Map(existing.map((row) => [row.shippedKey!, row]));
  let created = 0;
  let updated = 0;
  let retired = 0;
  for (const skill of shipped) {
    const row = byKey.get(skill.key);
    if (!row) {
      const definition = await tx.skillDefinition.create({ data: { ownerUserId: null, shippedKey: skill.key }, select: { id: true } });
      const revisionId = await appendShippedSkillRevision(tx, { skillId: definition.id, content: skill.content });
      await tx.skillDefinition.update({ where: { id: definition.id },
        data: { currentRevisionId: revisionId, sharedRevisionId: revisionId } });
      created += 1;
      continue;
    }
    const changed = row.currentRevision?.bundleDigest !== skill.content.bundleDigest;
    if (!changed && row.deletedAt === null) continue;
    const revisionId = changed ? await appendShippedSkillRevision(tx, { skillId: row.id, content: skill.content }) : null;
    await tx.skillDefinition.update({ where: { id: row.id }, data: {
      ...(revisionId ? { currentRevisionId: revisionId, sharedRevisionId: revisionId } : {}),
      deletedAt: null, version: { increment: 1 }
    } });
    updated += 1;
  }
  const shippedKeys = new Set(shipped.map((skill) => skill.key));
  for (const row of existing) {
    if (shippedKeys.has(row.shippedKey!) || row.deletedAt !== null) continue;
    // As a deleted Skill does: Assistants drop the link and keep working.
    await tx.assistantSkill.deleteMany({ where: { skillId: row.id } });
    await tx.skillDefinition.update({ where: { id: row.id }, data: { deletedAt: now, version: { increment: 1 } } });
    retired += 1;
  }
  return { created, updated, retired };
}

export async function synchronizeShippedSkills(
  prisma: PrismaClient,
  shipped: readonly ShippedSkill[],
  now: () => Date = () => new Date()
): Promise<ShippedSkillSynchronization> {
  // The previous release keeps serving during an upgrade; a conflicting write
  // of its aborts this serializable transaction and a fresh attempt sees it.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => synchronizeShippedSkillsInTransaction(tx, shipped, now()), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 60_000
      });
    } catch (error) {
      if (attempt >= ATTEMPTS || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
    }
  }
}
