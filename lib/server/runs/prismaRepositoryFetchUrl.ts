import type { PrismaClient } from "@prisma/client";
import { FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import type { RunRepository } from "./runRepositoryContract";

/**
 * The reads `fetch_url` needs beyond its frozen authority: the run's own
 * Search evidence, its earlier page-reader calls and which branch messages
 * are scheduled prompts. Each read is scoped to the run's owner or the chat
 * the caller already authorized, returns no content beyond what the caller
 * decides with, and is bounded.
 */
const SEARCH_RUN_LIMIT = 200;
const SEARCH_EVENT_LIMIT = 500;
const SOURCE_URL_LIMIT = 2_000;
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
    async loadRunSearchSourceUrls({ runId, userId }) {
      const run = await prisma.modelRun.findFirst({ select: { id: true }, where: { id: runId, userId } });
      if (!run) return [];
      const [searchRuns, events] = await Promise.all([
        // Query-only Search routes: the sources of each executed engine.
        prisma.searchRun.findMany({
          orderBy: { createdAt: "asc" }, select: { artifacts: true }, take: SEARCH_RUN_LIMIT, where: { modelRunId: runId }
        }),
        // Hosted Search routes: the answer model's own search and citation output.
        prisma.modelRunEvent.findMany({
          orderBy: { sequence: "asc" }, select: { payload: true }, take: SEARCH_EVENT_LIMIT,
          where: { eventType: "artifact", modelRunId: runId, OR: [
            { payload: { equals: "search", path: ["artifactType"] } },
            { payload: { equals: "citation", path: ["artifactType"] } }
          ] }
        })
      ]);
      const urls: string[] = [];
      for (const row of searchRuns) urls.push(...sourceUrls(isRecord(row.artifacts) ? row.artifacts.sources : null));
      for (const row of events) {
        const inner = isRecord(row.payload) && isRecord(row.payload.payload) ? row.payload.payload : null;
        if (!inner) continue;
        if (typeof inner.url === "string") urls.push(inner.url);
        if (isRecord(inner.action)) urls.push(...sourceUrls(inner.action.sources));
      }
      return urls.slice(0, SOURCE_URL_LIMIT);
    },

    async loadRunFetchUrlCalls({ runId, userId }) {
      // Every call of the run, which its accepted tool-call budget bounds. A
      // smaller bound would hide later sent calls: recovery would then read a
      // settled page again and rebuild the request cap too low.
      return prisma.modelRunToolCall.findMany({
        orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
        select: { id: true, result: true, state: true },
        where: { modelRun: { userId }, modelRunId: runId, toolName: FETCH_URL_TOOL_NAME }
      });
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
