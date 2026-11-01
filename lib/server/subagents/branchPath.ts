import type { Prisma } from "@prisma/client";
import { branchPathMessageIds } from "../toolObservations/repository";
import type { SubagentChatScope } from "./ports";

/**
 * The message ids of the branch an agent works on: the chat's active branch while its parent run's answer is on it, so
 * it reaches agents the main agent started after it, otherwise that answer's own path. Null when it has no answer.
 */
export async function agentBranchPath(tx: Prisma.TransactionClient,
  input: SubagentChatScope & Readonly<{ activeLeafMessageId: string | null; parentRunId: string }>): Promise<ReadonlySet<string> | null> {
  const parent = await tx.modelRun.findFirst({ select: { assistantMessageId: true },
    where: { chatId: input.chatId, id: input.parentRunId, subagentTurnId: null, userId: input.userId } });
  if (!parent?.assistantMessageId) return null;
  const active = input.activeLeafMessageId ? await branchPathMessageIds(tx, input.chatId, input.activeLeafMessageId) : null;
  return active?.has(parent.assistantMessageId) ? active : branchPathMessageIds(tx, input.chatId, parent.assistantMessageId);
}

/** The thread a name means on an agent's branch, with that branch; null when no thread of the name is on it. */
export async function threadOnBranch(tx: Prisma.TransactionClient, input: SubagentChatScope & Readonly<{ name: string; parentRunId: string }>):
  Promise<Readonly<{ path: ReadonlySet<string>; threadId: string }> | null> {
  const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true }, where: { id: input.chatId, userId: input.userId } });
  if (!chat) return null;
  const path = await agentBranchPath(tx, { activeLeafMessageId: chat.activeLeafMessageId, chatId: input.chatId, parentRunId: input.parentRunId, userId: input.userId });
  if (!path) return null;
  const threads = await tx.subagentThread.findMany({ select: { anchorRun: { select: { assistantMessageId: true } }, id: true },
    where: { chatId: input.chatId, name: input.name, userId: input.userId } });
  const thread = threads.find((candidate) => candidate.anchorRun.assistantMessageId !== null && path.has(candidate.anchorRun.assistantMessageId));
  return thread ? { path, threadId: thread.id } : null;
}
