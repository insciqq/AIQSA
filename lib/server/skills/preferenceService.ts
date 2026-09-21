import type { PrismaClient } from "@prisma/client";
import { skillAccessWhere } from "./prismaRepository";

/** Preferences affect discovery only; every catalog/read still proves access. */
export function createSkillPreferenceService(db: PrismaClient) {
  return {
    enableAll(userId: string) {
      return db.$transaction(async (tx) => {
        const actor = await tx.user.findFirst({ where: { id: userId, status: "active" }, select: { id: true } });
        if (!actor) return null;
        const skills = await tx.skillDefinition.findMany({ where: {
          archivedAt: null, deletedAt: null, currentRevisionId: { not: null }, ...skillAccessWhere(userId)
        }, select: { id: true } });
        const skillIds = skills.map(skill => skill.id);
        if (skillIds.length) {
          await tx.userSkillPreference.createMany({ data: skillIds.map(skillId => ({ userId, skillId, enabled: true })), skipDuplicates: true });
          await tx.userSkillPreference.updateMany({ where: { userId, skillId: { in: skillIds } }, data: { enabled: true } });
        }
        return { enabledCount: skillIds.length };
      });
    },
    set(userId: string, skillId: string, enabled: boolean) {
      return db.$transaction(async (tx) => {
        const actor = await tx.user.findFirst({ where: { id: userId, status: "active" }, select: { id: true } });
        if (!actor) return null;
        await tx.$queryRaw`SELECT "id" FROM "SkillDefinition" WHERE "id" = ${skillId} FOR SHARE`;
        const skill = await tx.skillDefinition.findFirst({
          where: { id: skillId, deletedAt: null, currentRevisionId: { not: null }, ...skillAccessWhere(userId) }, select: { id: true }
        });
        if (!skill) return null;
        await tx.userSkillPreference.upsert({ where: { userId_skillId: { userId, skillId } },
          create: { userId, skillId, enabled }, update: { enabled } });
        return { skillId, enabled };
      });
    }
  };
}
export type SkillPreferenceService = ReturnType<typeof createSkillPreferenceService>;
