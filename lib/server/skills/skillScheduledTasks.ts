import { Prisma } from "@prisma/client";
import { SKILL_SAVE_CARD_TASKS_LIMIT, type SkillSaveCardTask } from "../../contracts/skillSaves";

/**
 * The owner's active scheduled tasks that use a Skill: the "used by tasks"
 * warning of a chat save's card. Integration hook: until scheduled tasks pin
 * Skills explicitly, a task uses a Skill when one of its runs bound it (a
 * pinned or loaded Skill of that run). Bounded; titles are the owner's own.
 */
export async function activeScheduledTasksUsingSkill(
  tx: Prisma.TransactionClient,
  input: Readonly<{ userId: string; skillId: string }>
): Promise<Readonly<{ tasks: SkillSaveCardTask[]; truncated: boolean }>> {
  const rows = await tx.$queryRaw<Array<{ id: string; title: string }>>(Prisma.sql`
    SELECT t."id", t."title" FROM "ScheduledTask" t
    WHERE t."userId" = ${input.userId} AND t."status" = 'ACTIVE' AND EXISTS (
      SELECT 1 FROM "ModelRun" r JOIN "ModelRunSkillBinding" b ON b."modelRunId" = r."id"
      WHERE r."scheduledTaskId" = t."id" AND r."userId" = ${input.userId} AND b."skillId" = ${input.skillId}
    )
    ORDER BY t."createdAt" ASC, t."id" ASC
    LIMIT ${SKILL_SAVE_CARD_TASKS_LIMIT + 1}
  `);
  return {
    tasks: rows.slice(0, SKILL_SAVE_CARD_TASKS_LIMIT).map((row) => ({ taskId: row.id, title: row.title })),
    truncated: rows.length > SKILL_SAVE_CARD_TASKS_LIMIT
  };
}
