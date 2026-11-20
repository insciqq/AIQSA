import type { PrismaClient } from "@prisma/client";
import { FETCH_URL_LIMITS, FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import type { RunRepository } from "./runRepositoryContract";

/**
 * The run reads kept here: the pages a run's `fetch_url` read (a recovered
 * run's read cache) and which branch messages are scheduled prompts, which
 * are the server's turns (`lib/server/engine/execution.ts`). Each read is scoped to the run's owner or the chat the caller already
 * authorized, returns no content beyond what the caller decides with, and is
 * bounded.
 */
const PROMPT_MESSAGE_LIMIT = 1_000;

type FetchUrlOperations = Required<Pick<RunRepository,
  "loadRunFetchUrlCalls" | "loadScheduledPromptMessageIds">>;

export function createPrismaFetchUrlOperations(prisma: PrismaClient): FetchUrlOperations {
  return {
    async loadRunFetchUrlCalls({ runId, userId }) {
      // Only the reads: a bound below the run's calls just means an older page is read again.
      const rows = await prisma.modelRunToolCall.findMany({
        orderBy: [{ roundIndex: "desc" }, { ordinal: "desc" }],
        select: { result: true },
        take: FETCH_URL_LIMITS.cachedPages,
        where: { modelRun: { userId }, modelRunId: runId, result: { equals: "read", path: ["rawPreview", "fetchUrl", "outcome"] },
          toolName: FETCH_URL_TOOL_NAME }
      });
      return rows.reverse();
    },

    async loadScheduledPromptMessageIds({ chatId, messageIds }) {
      const ids = [...new Set(messageIds)];
      // Ids beyond the bound are not checked, so they count as prompts: fail closed.
      const unchecked = ids.slice(PROMPT_MESSAGE_LIMIT);
      const checked = ids.slice(0, PROMPT_MESSAGE_LIMIT);
      if (checked.length === 0) return new Set(unchecked);
      const rows = await prisma.message.findMany({
        select: { id: true }, where: { chatId, id: { in: checked }, role: "user", scheduledTaskPrompt: true }
      });
      return new Set([...rows.map((row) => row.id), ...unchecked]);
    }
  };
}
