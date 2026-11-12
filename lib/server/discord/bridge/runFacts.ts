import type { PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import type { DiscordMcpTotals } from "../store/replies";

/**
 * What the bridge reads of AIQSA's own records, content-free (PRD D-28,
 * D-16): a run's totals once it settled (MCP calls and errors per server id,
 * its compactions and sub-agent turns, and its failure code), so live
 * delivery and recovery after a restart record the same summary; and which
 * Discord messages are AIQSA's own posts (statuses and answers), so the
 * context never repeats an answer the chat already holds.
 */

export type DiscordRunSummary = Readonly<{
  mcpByServer: DiscordMcpTotals;
  compactions: number;
  subagents: number;
  /** The run's recorded failure code; null for a run that did not fail. */
  errorCode: string | null;
}>;

export type DiscordRunFacts = Readonly<{
  summary(runId: string): Promise<DiscordRunSummary | null>;
  /** The given Discord messages that AIQSA posted for a question, each with the question's conversation (null: none). */
  aiqsaMessages(messageIds: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  /** The questions a run answers (its answer and its follow-ups). */
  questionsOfRun(runId: string): Promise<readonly string[]>;
  /** A chat's first run: in a chat a Discord question created, that question's own. */
  firstRunOfChat(chatId: string): Promise<string | null>;
}>;

type FactsClient = Pick<PrismaClient, "discordReply" | "modelRun" | "modelRunToolCall" | "runTranscriptItem" | "subagentTurn">;

const AIQSA_MESSAGE_BATCH = 500;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Namespaced MCP tool name → server id, from the run's frozen tools and its Auto catalog. */
export function discordMcpServerOfTool(normalizedRequest: unknown): ReadonlyMap<string, string> {
  const servers = new Map<string, string>();
  const request = record(normalizedRequest);
  const tools = record(request?.mcp)?.tools;
  if (Array.isArray(tools)) {
    for (const entry of tools) {
      const tool = record(entry);
      if (typeof tool?.namespacedName === "string" && typeof tool.serverId === "string") servers.set(tool.namespacedName, tool.serverId);
    }
  }
  const catalog = record(record(request?.mcpDiscovery)?.catalog)?.servers;
  if (Array.isArray(catalog)) {
    for (const entry of catalog) {
      const server = record(entry);
      if (typeof server?.serverId !== "string" || !Array.isArray(server.tools)) continue;
      for (const candidate of server.tools) {
        const name = record(candidate)?.namespacedName;
        if (typeof name === "string" && !servers.has(name)) servers.set(name, server.serverId);
      }
    }
  }
  return servers;
}

export function createPrismaDiscordRunFacts(prisma: FactsClient): DiscordRunFacts {
  return Object.freeze({
    async summary(runId) {
      const run = await prisma.modelRun.findUnique({ select: { errorPayload: true, normalizedRequest: true }, where: { id: runId } })
        .catch(retainDatabaseFailure);
      if (!run) return null;
      const [calls, compactions, subagents] = await Promise.all([
        prisma.modelRunToolCall.findMany({ select: { state: true, toolName: true }, take: 5_000, where: { modelRunId: runId } }),
        prisma.runTranscriptItem.count({ where: { kind: "compaction", modelRunId: runId } }),
        prisma.subagentTurn.count({ where: { parentRunId: runId } })
      ]).catch(retainDatabaseFailure);
      const servers = discordMcpServerOfTool(run.normalizedRequest);
      const mcpByServer: Record<string, { calls: number; errors: number }> = {};
      for (const call of calls) {
        const serverId = servers.get(call.toolName);
        if (!serverId) continue;
        const totals = mcpByServer[serverId] ??= { calls: 0, errors: 0 };
        totals.calls += 1;
        if (call.state === "error") totals.errors += 1;
      }
      const code = record(run.errorPayload)?.code;
      return { compactions, errorCode: typeof code === "string" && code ? code.slice(0, 80) : null, mcpByServer, subagents };
    },

    async aiqsaMessages(messageIds) {
      const found = new Map<string, string | null>();
      const ids = [...new Set(messageIds)].map((id) => BigInt(id));
      for (let index = 0; index < ids.length; index += AIQSA_MESSAGE_BATCH) {
        const batch = ids.slice(index, index + AIQSA_MESSAGE_BATCH);
        const rows = await prisma.discordReply.findMany({
          select: { answerMessageId: true, conversationId: true, statusMessageId: true },
          where: { OR: [{ answerMessageId: { in: batch } }, { statusMessageId: { in: batch } }] }
        }).catch(retainDatabaseFailure);
        for (const row of rows) {
          for (const id of [row.answerMessageId, row.statusMessageId]) {
            if (id !== null && batch.includes(id)) found.set(id.toString(), row.conversationId);
          }
        }
      }
      return found;
    },

    async questionsOfRun(runId) {
      const rows = await prisma.discordReply.findMany({ select: { questionMessageId: true }, take: 100, where: { runId } })
        .catch(retainDatabaseFailure);
      return rows.map((row) => row.questionMessageId.toString());
    },

    async firstRunOfChat(chatId) {
      const run = await prisma.modelRun.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true }, where: { chatId } })
        .catch(retainDatabaseFailure);
      return run?.id ?? null;
    }
  });
}
