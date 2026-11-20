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

/** A run as `mcpBindingRunIds` reads it: a background sub-agent's own run names its turn and the turn's parent run. */
export type McpBindingRun = Readonly<{ id: string; subagentTurn?: Readonly<{ parentRunId: string;
  parentRun: Readonly<{ subagentTurn?: Readonly<{ parentRunId: string }> | null }> }> | null }>;

/**
 * The runs whose `McpRunBinding` rows a run's MCP calls may link: its own, and for a background sub-agent's own run also
 * the main-agent run behind its turn (`turnMainRunId`). Such a run calls what that run bound under its rows (integrator
 * decision 2026-10-30) and binds on itself what its own `find_tools` loads, because a discovery epoch writes and locks
 * only the run that calls it (`lib/server/runs/prismaRepositoryMcpDiscovery.ts`); a child of a background sub-agent takes
 * copies of its parent's own rows at admission (`lib/server/runs/subagentBackground/store.ts`). No other run of the chat,
 * a sibling sub-agent's included, qualifies; the keys tie a turn to its parent's user and chat.
 */
export function mcpBindingRunIds(run: McpBindingRun): readonly string[] {
  if (!run.subagentTurn) return [run.id];
  const main = turnMainRunId(run.subagentTurn.parentRunId, run.subagentTurn.parentRun);
  return main === run.id ? [run.id] : [run.id, main];
}

/** The main-agent run that owns a run's bindings, and the answer it writes. */
export type RunBindingOwner = Readonly<{ assistantMessageId: string | null; runId: string }>;

/**
 * The run whose bindings a run uses, and whose answer shows what it makes: a main-agent run itself, or for a background
 * sub-agent's own run the main-agent run behind its turn (`turnMainRunId`). Such a run answers nothing, so what it makes
 * shows under that run's answer (`lib/server/runs/subagentBackground/store.ts`). Null when the run is
 * not this user's in this chat, or its turn leads to no main-agent run of theirs there; the keys already tie a turn to its
 * parent's user and chat, so this only refuses what no admission makes.
 */
export async function runBindingOwner(db: Pick<Prisma.TransactionClient, "modelRun">,
  scope: Readonly<{ chatId: string; runId: string; userId: string }>): Promise<RunBindingOwner | null> {
  const run = await db.modelRun.findFirst({ select: { assistantMessageId: true, id: true,
    subagentTurn: { select: { mode: true, parentRunId: true, parentRun: { select: { subagentTurn: { select: { parentRunId: true } } } } } } },
  where: { chatId: scope.chatId, id: scope.runId, userId: scope.userId } });
  if (!run) return null;
  const turn = run.subagentTurn;
  if (!turn) return { assistantMessageId: run.assistantMessageId, runId: run.id };
  if (turn.mode !== "background") return null;
  const owner = await db.modelRun.findFirst({ select: { assistantMessageId: true, id: true },
    where: { chatId: scope.chatId, id: turnMainRunId(turn.parentRunId, turn.parentRun), subagentTurnId: null, userId: scope.userId } });
  return owner ? { assistantMessageId: owner.assistantMessageId, runId: owner.id } : null;
}

/**
 * Why an agent may not run a turn of this thread, under the chat's admission lock; null when it may. A name is one
 * thread on a branch, so another agent's thread is refused rather than taken over, and a thread stays with the agent that
 * started it: only a sub-agent's own children count toward its limit, and a child never starts one of its own. A child
 * needs its parent's very turn active: the run behind that turn may long outlive it, and nobody would read the child's
 * report or stop it.
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
  const turn = await tx.subagentTurn.findFirst({ select: { id: true }, where: { chatId: input.chatId, id: parent.turnId, state: { in: ["running", "waiting"] },
    threadId: parent.threadId, userId: input.userId } });
  if (!turn) return SUBAGENT_ERROR_CODES.notActive;
  const running = await tx.subagentTurn.count({ where: { chatId: input.chatId, state: { in: ["running", "waiting"] },
    thread: { parentThreadId: parent.threadId }, userId: input.userId } });
  return running >= SUBAGENT_LIMITS.childrenPerSubagent ? SUBAGENT_ERROR_CODES.childLimit : null;
}
