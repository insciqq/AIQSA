import type { PrismaClient } from "@prisma/client";

/** Requests one Base's or Source's permanent deletion the way the remaining
 * deletion paths stage it (`accountDeletion.ts`): trashed, deletion requested
 * and one deletion job, in one transaction. */
export async function requestKnowledgeDeletion(
  client: PrismaClient,
  target: Readonly<{ id: string; ownerUserId: string; targetType: "BASE" | "SOURCE" }>
): Promise<void> {
  await client.$transaction(async (tx) => {
    const now = new Date();
    const data = { deletionRequestedAt: now, trashedAt: now, version: { increment: 1 } };
    const where = { deletionRequestedAt: null, id: target.id, ownerUserId: target.ownerUserId };
    const updated = target.targetType === "BASE"
      ? await tx.knowledgeBase.updateMany({ data, where })
      : await tx.knowledgeSource.updateMany({ data, where });
    if (updated.count !== 1) throw new Error("knowledge_deletion_fixture_invalid");
    await tx.knowledgeDeletionJob.create({
      data: { ownerUserId: target.ownerUserId, targetId: target.id, targetType: target.targetType }
    });
  });
}
