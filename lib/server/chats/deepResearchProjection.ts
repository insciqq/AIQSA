import type { Prisma } from "@prisma/client";
import { isContinueContent, prismaResearchedRunsReader, researchedRuns } from "../research/researchedRuns";

/** What a page or a run's chat update marks of Deep research, by message id (`ChatMessageWire.deepResearch`, `ChatMessageWire.researchAnswer`). */
export type DeepResearchMarks = Readonly<{
  /** Answers whose run researched. */
  researchAnswers: ReadonlySet<string>;
  /** User messages the user sent with Deep research. */
  sentWithDeepResearch: ReadonlySet<string>;
}>;

/** A message as the marks read it: its answer's own main run, and its content where the caller holds it. */
export type DeepResearchMarkedMessage = Readonly<{ content?: unknown; id: string; role: string; runId?: string | null; systemTurnKind?: string | null }>;

/**
 * The messages' Deep research marks, from the main agent's runs alone. A user message was sent with it when one of its runs was admitted
 * with the choice (operator decision 2026-11-05). An answer researched when its run did (`researchedRuns`, operator decision 2026-11-06:
 * such an answer never offers Regenerate, since that would run the whole research again), which reads only the frozen field, the frame's
 * existence and the branch's turns: a run's request holds the whole branch's context, which a page never loads. The messages' own content
 * says which is the user's Continue, so a page asks the database of none of its own.
 */
export async function loadDeepResearchMarks(tx: Pick<Prisma.TransactionClient, "message" | "modelRun">,
  { chatId, userId }: Readonly<{ chatId: string; userId: string }>, messages: readonly DeepResearchMarkedMessage[]): Promise<DeepResearchMarks> {
  const questions = messages.filter((message) => message.role === "user").map((message) => message.id);
  const answers = new Map(messages.flatMap((message) => message.role === "assistant" && message.runId ? [[message.runId, message.id] as const] : []));
  const held = new Map(messages.flatMap((message) => message.role === "user" && (message.systemTurnKind ?? null) === null && message.content !== undefined
    ? [[message.id, isContinueContent(message.content)] as const] : []));
  const [sent, researched] = await Promise.all([
    questions.length === 0 ? [] : tx.modelRun.findMany({ distinct: ["userMessageId"], select: { userMessageId: true },
      where: { chatId, normalizedRequest: { equals: true, path: ["deepResearch"] }, subagentTurnId: null, userId, userMessageId: { in: questions } } }),
    answers.size === 0 ? new Set<string>() : researchedRuns(prismaResearchedRunsReader(tx, { chatId, userId }), answers.keys(), (id) => held.get(id))
  ]);
  return {
    researchAnswers: new Set([...researched].flatMap((runId) => answers.get(runId) ?? [])),
    sentWithDeepResearch: new Set(sent.map((run) => run.userMessageId))
  };
}
