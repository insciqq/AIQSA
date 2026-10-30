import type { Prisma } from "@prisma/client";
import { decodeRunFollowupState } from "../../contracts/runFollowups";

export type FollowupReference = Readonly<{ id: string; answerId: string }>;
type Client = Pick<Prisma.TransactionClient, "message" | "runFollowup">;

/**
 * A copied answer's source-run link proves lineage; a matching author name or a null
 * author does not. Return only original owner-authored receipts, without trusting the
 * copied JSON's text or exposing the source chat to the browser.
 */
export async function verifiedFollowups(db: Client, input: Readonly<{
  chatId: string; userId: string; references: readonly FollowupReference[];
}>): Promise<Map<string, Readonly<{ id: string; text: string; authorUserId: string }>>> {
  if (!input.references.length) return new Map();
  const answers = await db.message.findMany({ where: { id: { in: [...new Set(input.references.map(ref => ref.answerId))] },
    chatId: input.chatId, role: "assistant", chat: { userId: input.userId, permanentDeletionAt: null } },
    select: { id: true, branchSourceModelRunId: true, branchFollowups: true,
      assistantModelRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, userId: true } } } });
  const allowed = new Map(answers.map(answer => [answer.id, answer]));
  const rows = await db.runFollowup.findMany({ where: { id: { in: input.references.map(ref => ref.id) }, authorUserId: input.userId,
    modelRun: { userId: input.userId, chat: { userId: input.userId, permanentDeletionAt: null } } },
    select: { id: true, text: true, authorUserId: true, modelRunId: true } });
  const originals = new Map(rows.map(row => [row.id, row]));
  const verified = new Map<string, { id: string; text: string; authorUserId: string }>();
  for (const ref of input.references) {
    const answer = allowed.get(ref.answerId);
    const row = originals.get(ref.id);
    if (!answer || row?.authorUserId !== input.userId) continue;
    const direct = answer.assistantModelRuns[0];
    const copied = decodeRunFollowupState(answer.branchFollowups)?.entries.find(entry => entry.id === ref.id);
    if (!(direct?.userId === input.userId && direct.id === row.modelRunId) &&
      !(answer.branchSourceModelRunId === row.modelRunId && copied?.text === row.text)) continue;
    verified.set(`${ref.answerId}:${ref.id}`, { id: row.id, text: row.text, authorUserId: input.userId });
  }
  return verified;
}
