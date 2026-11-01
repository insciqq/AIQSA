import type { PrismaClient } from "@prisma/client";
import { turnsOfMainRuns } from "../subagents/nesting";
import { FETCH_URL_LIMITS, FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import type { RunRepository } from "./runRepositoryContract";

/**
 * The reads `fetch_url` needs beyond its frozen authority: the Search evidence
 * of the answer's agents and the earlier answers on its branch, the pages the
 * run read and which branch messages are scheduled prompts. Each read is scoped
 * to the run's owner or the chat the caller already authorized, returns no
 * content beyond what the caller decides with, and is bounded.
 */
/** Runs whose evidence counts, sub-agents' included. */
const AUTHORITY_RUN_LIMIT = 200;
const SEARCH_RUN_LIMIT = 500;
const SEARCH_EVENT_LIMIT = 1_000;
const SOURCE_URL_LIMIT = 10_000;
const PROMPT_MESSAGE_LIMIT = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceUrls(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((source) => isRecord(source) && typeof source.url === "string" ? [source.url] : [])
    : [];
}

type FetchUrlOperations = Required<Pick<RunRepository,
  "loadRunFetchUrlCalls" | "loadRunSearchSourceUrls" | "loadScheduledPromptMessageIds">>;

export function createPrismaFetchUrlOperations(prisma: PrismaClient): FetchUrlOperations {
  return {
    async loadRunSearchSourceUrls({ earlierRunIds, runId, userId }) {
      const run = await prisma.modelRun.findFirst({ select: { chatId: true }, where: { id: runId, userId } });
      if (!run) return [];
      // The answer and the earlier answers its caller names, each with its background sub-agents and their children (a
      // foreground sub-agent's Search is its host run's). Only this owner's runs of this chat, whatever the caller names.
      const mainRunIds = [...new Set([runId, ...earlierRunIds.slice(-AUTHORITY_RUN_LIMIT)])];
      const agentRuns = await prisma.modelRun.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true }, take: AUTHORITY_RUN_LIMIT,
        where: { chatId: run.chatId, userId, OR: [{ id: { in: mainRunIds } },
          { subagentTurn: { is: { mode: "background", ...turnsOfMainRuns(mainRunIds) } } }] }
      });
      const runIds = [...new Set([runId, ...agentRuns.map((row) => row.id)])];
      // Newest first at every bound, so what a bound hides is old and a fresh search always authorizes its results.
      const [searchRuns, events] = await Promise.all([
        // Query-only Search routes: the sources of each executed engine.
        prisma.searchRun.findMany({
          orderBy: { createdAt: "desc" }, select: { artifacts: true, createdAt: true }, take: SEARCH_RUN_LIMIT,
          where: { modelRunId: { in: runIds } }
        }),
        // Hosted Search routes: the answer model's own search and citation output.
        prisma.modelRunEvent.findMany({
          orderBy: [{ createdAt: "desc" }, { sequence: "asc" }], select: { createdAt: true, payload: true }, take: SEARCH_EVENT_LIMIT,
          where: { eventType: "artifact", modelRunId: { in: runIds }, OR: [
            { payload: { equals: "search", path: ["artifactType"] } },
            { payload: { equals: "citation", path: ["artifactType"] } }
          ] }
        })
      ]);
      const found: { at: Date; urls: string[] }[] = searchRuns.map((row) => ({ at: row.createdAt,
        urls: sourceUrls(isRecord(row.artifacts) ? row.artifacts.sources : null) }));
      for (const row of events) {
        const inner = isRecord(row.payload) && isRecord(row.payload.payload) ? row.payload.payload : null;
        if (!inner) continue;
        found.push({ at: row.createdAt, urls: [...(typeof inner.url === "string" ? [inner.url] : []),
          ...(isRecord(inner.action) ? sourceUrls(inner.action.sources) : [])] });
      }
      return found.sort((a, b) => b.at.getTime() - a.at.getTime()).flatMap((entry) => entry.urls).slice(0, SOURCE_URL_LIMIT);
    },

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
