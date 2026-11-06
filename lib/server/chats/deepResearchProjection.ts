import type { Prisma } from "@prisma/client";

/** What a page or a run's chat update marks of Deep research, by message id (`ChatMessageWire.deepResearch`, `ChatMessageWire.researchAnswer`). */
export type DeepResearchMarks = Readonly<{
  /** Answers whose run researched. */
  researchAnswers: ReadonlySet<string>;
  /** User messages the user sent with Deep research. */
  sentWithDeepResearch: ReadonlySet<string>;
}>;

/**
 * The messages' Deep research marks, from the main agent's runs alone. A user message was sent with it when one of its runs was admitted
 * with the choice (operator decision 2026-11-05). An answer researched when its run was admitted with it, or has a research frame, which
 * only a research writes: the plan's window opens it, and a Continue that picks research up links it (operator decision 2026-11-06:
 * such an answer never offers Regenerate, since that would run the whole research again). Only the frozen field and the frame's
 * existence are read, in the database: a run's request holds the whole branch's context, which a page never loads.
 */
export async function loadDeepResearchMarks(tx: Pick<Prisma.TransactionClient, "modelRun">,
  { chatId, userId }: Readonly<{ chatId: string; userId: string }>,
  messages: readonly Readonly<{ id: string; role: string }>[]): Promise<DeepResearchMarks> {
  const questions = messages.filter((message) => message.role === "user").map((message) => message.id);
  const answers = messages.filter((message) => message.role === "assistant").map((message) => message.id);
  const sentWith = { equals: true, path: ["deepResearch"] };
  const [sent, researched] = await Promise.all([
    questions.length === 0 ? [] : tx.modelRun.findMany({ distinct: ["userMessageId"], select: { userMessageId: true },
      where: { chatId, normalizedRequest: sentWith, subagentTurnId: null, userId, userMessageId: { in: questions } } }),
    answers.length === 0 ? [] : tx.modelRun.findMany({ distinct: ["assistantMessageId"], select: { assistantMessageId: true },
      where: { assistantMessageId: { in: answers }, chatId, OR: [{ normalizedRequest: sentWith }, { researchFrame: { isNot: null } }],
        subagentTurnId: null, userId } })
  ]);
  return {
    researchAnswers: new Set(researched.flatMap((run) => run.assistantMessageId ? [run.assistantMessageId] : [])),
    sentWithDeepResearch: new Set(sent.map((run) => run.userMessageId))
  };
}
