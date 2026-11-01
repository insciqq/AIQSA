import type { Prisma } from "@prisma/client";
import { SUBAGENT_ERROR_CODES, SUBAGENT_LIMITS, normalizeSubagentName, type SubagentErrorCode } from "../../contracts/subagents";
import type { SubagentParentAgent } from "./ports";

/**
 * A sub-agent's children (operator decision 2026-10-31): one extra level, at most `SUBAGENT_LIMITS.childrenPerSubagent`
 * at once. `SubagentTurn.parentRunId` stays the run that holds the `call_subagent` call, because that is what the call's
 * key needs and where a foreground turn runs; for a child of a background sub-agent it is that sub-agent's own run, which
 * answers nothing. What places a turn on a branch is the main-agent run behind it, one step further: the parent run's own
 * turn leads there. Whatever asks "which answer is this turn under" reads it here, and one level is why one step will do.
 */

/** The `authorName` of what the main agent writes a sub-agent's mailbox, which no sub-agent's name can be. */
export const MAIN_AGENT_AUTHOR = "Main agent";

/** The sub-agent a mailbox row names as its writer; undefined when the main agent wrote it. */
export function mailboxWriter(authorName: string): string | undefined {
  return normalizeSubagentName(authorName) === authorName ? authorName : undefined;
}

/** The turns these main-agent runs started, their children included. */
export function turnsOfMainRuns(runIds: readonly string[]): Prisma.SubagentTurnWhereInput {
  const ids = { in: [...new Set(runIds)] };
  return { OR: [{ parentRunId: ids }, { parentRun: { subagentTurn: { is: { parentRunId: ids } } } }] };
}

/** What `turnAnswerMessageId` reads of a turn's parent run. */
export const TURN_ANSWER_SELECT = {
  assistantMessageId: true,
  subagentTurn: { select: { parentRun: { select: { assistantMessageId: true } } } }
} satisfies Prisma.ModelRunSelect;

/** The answer whose run placed a turn on its branch, given its parent run. */
export function turnAnswerMessageId(parentRun: Readonly<{ assistantMessageId: string | null;
  subagentTurn?: Readonly<{ parentRun: Readonly<{ assistantMessageId: string | null }> }> | null }>): string | null {
  return parentRun.subagentTurn?.parentRun.assistantMessageId ?? parentRun.assistantMessageId;
}

/** The main-agent run behind a turn, given its parent run. */
export function turnMainRunId(parentRunId: string, parentRun: Readonly<{ subagentTurn?: Readonly<{ parentRunId: string }> | null }>): string {
  return parentRun.subagentTurn?.parentRunId ?? parentRunId;
}

/**
 * Why an agent may not run a turn of this thread, under the chat's admission lock; null when it may. A name is one
 * thread on a branch, so another agent's thread is refused rather than taken over, and a thread stays with the agent that
 * started it: only a sub-agent's own children count toward its limit, and a child never starts one of its own.
 */
export async function childAdmissionRefusal(tx: Pick<Prisma.TransactionClient, "subagentThread" | "subagentTurn">, input: Readonly<{
  chatId: string;
  parentAgent?: SubagentParentAgent;
  thread: Readonly<{ parentThreadId: string | null }> | null;
  userId: string;
}>): Promise<SubagentErrorCode | null> {
  const parent = input.parentAgent;
  if (input.thread && input.thread.parentThreadId !== (parent?.threadId ?? null)) return SUBAGENT_ERROR_CODES.notOwnChild;
  if (!parent) return null;
  const starter = await tx.subagentThread.findFirst({ select: { parentThreadId: true },
    where: { chatId: input.chatId, id: parent.threadId, userId: input.userId } });
  if (!starter) return SUBAGENT_ERROR_CODES.notFound;
  if (starter.parentThreadId !== null) return SUBAGENT_ERROR_CODES.depthLimit;
  const running = await tx.subagentTurn.count({ where: { chatId: input.chatId, state: { in: ["running", "waiting"] },
    thread: { parentThreadId: parent.threadId }, userId: input.userId } });
  return running >= SUBAGENT_LIMITS.childrenPerSubagent ? SUBAGENT_ERROR_CODES.childLimit : null;
}
