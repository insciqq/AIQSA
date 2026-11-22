import type { Prisma } from "@prisma/client";
import { SEARCH_PAST_CHATS_TOOL_NAME, type PastChatSource } from "../../contracts/pastChats";
import { chatSearchEligibleWhere } from "../chatSearch/eligibility";
import { pastChatSourcesFromToolResults } from "../tools/pastChats";

/**
 * The past chats shown under answers (operator decision 2026-11-22): each answer's own `search_past_chats` results,
 * as its call records keep them (no receipt table), filtered when the chat loads to chats that still exist and are
 * still eligible for their owner (`chatSearchEligibleWhere`). A chat deleted, made Temporary or excluded from Memory
 * later no longer shows its title and excerpt under other answers, and only the run's owner reads them, since they
 * quote the owner's other chats.
 */
export type PastChatSourceRun = Readonly<{
  id: string;
  userId?: string | null;
  toolCalls?: readonly object[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One run's sources as its main agent's calls recorded them, before the load-time filter. */
export function recordedPastChatSources(run: PastChatSourceRun): PastChatSource[] {
  const results = (run.toolCalls ?? []).flatMap((call) => isRecord(call) && call.toolName === SEARCH_PAST_CHATS_TOOL_NAME &&
    !call.subagentThreadId ? [call.result] : []);
  return results.length ? pastChatSourcesFromToolResults(results) : [];
}

/** The sources each run shows to `viewerUserId`, by run id; a run without any is absent. */
export async function loadPastChatSourcesByRun(
  db: Pick<Prisma.TransactionClient, "chat">,
  input: Readonly<{ runs: readonly PastChatSourceRun[]; viewerUserId: string }>
): Promise<ReadonlyMap<string, readonly PastChatSource[]>> {
  const recorded = input.runs.flatMap((run) => {
    if (run.userId !== input.viewerUserId) return [];
    const sources = recordedPastChatSources(run);
    return sources.length ? [{ runId: run.id, sources }] : [];
  });
  if (recorded.length === 0) return new Map();
  const chatIds = [...new Set(recorded.flatMap((entry) => entry.sources.map((source) => source.chatId)))];
  const eligible = new Set((await db.chat.findMany({
    select: { id: true },
    where: { AND: [{ id: { in: chatIds } }, chatSearchEligibleWhere(input.viewerUserId)] }
  })).map((chat) => chat.id));
  const byRun = new Map<string, readonly PastChatSource[]>();
  for (const entry of recorded) {
    const shown = entry.sources.filter((source) => eligible.has(source.chatId));
    if (shown.length) byRun.set(entry.runId, shown);
  }
  return byRun;
}
