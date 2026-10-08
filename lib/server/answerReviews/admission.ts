import { Prisma } from "@prisma/client";
import { AnswerReviewStepConflictError, type AnswerReviewStepAdmission } from "../runs/runRepositoryContract";

/**
 * The answer review side of a run's admitting transaction, after the chat row
 * is locked. A step's admission locks its session and requires it running and
 * owned by the initiator. Any other run admitted in the chat (a send, an edit,
 * a regeneration) supersedes the chat's running sessions: their next step
 * could only follow their last message, which this run moves away from.
 */
export async function admitAnswerReviewInTransaction(
  tx: Prisma.TransactionClient,
  input: Readonly<{ chatId: string; step?: AnswerReviewStepAdmission; userId: string }>
): Promise<void> {
  if (!input.step) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "AnswerReviewSession"
      SET "state" = 'stopped', "stopReason" = 'superseded', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "chatId" = ${input.chatId} AND "state" = 'running'
    `);
    return;
  }
  const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "AnswerReviewSession"
    WHERE "id" = ${input.step.sessionId}
      AND "chatId" = ${input.chatId}
      AND "userId" = ${input.userId}
      AND "state" = 'running'
      AND "round" = ${input.step.round}
    FOR UPDATE
  `);
  if (sessions.length === 0) throw new AnswerReviewStepConflictError("answer_review_ended");
}

/** The session columns of a step's turn (its claim) and of that turn's answer. */
export function answerReviewMessageFields(step: AnswerReviewStepAdmission | undefined, role: "assistant" | "user") {
  if (!step) return {};
  return role === "user"
    ? { answerReviewRound: step.round, answerReviewSessionId: step.sessionId, answerReviewStep: step.step }
    : { answerReviewSessionId: step.sessionId };
}

/** Creates a step's turn; a second turn for the same step loses its unique claim. */
export async function createClaimingMessage<T>(step: AnswerReviewStepAdmission | undefined, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (step && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AnswerReviewStepConflictError("answer_review_step_unavailable");
    }
    throw error;
  }
}
