import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { DiscordEventIds } from "../../observability/events";
import type { DiscordLimitKind, DiscordMcpTotals, DiscordReplyKind } from "../store/replies";

/**
 * The content-free records of one Discord question (PRD D-28, D-30, O-32):
 * its stages `received → acked → admitted → first_status → delivered` (or
 * `failed`, `interrupted`, `limited`), each with its delay from `received`,
 * and a delivered run's totals, one record per MCP server. Ids are Discord
 * snowflakes and AIQSA run and chat ids; never names, text or URLs.
 */

export type DiscordQuestionIds = Readonly<{
  questionMessageId: string;
  /** The channel, thread or direct-message channel the question was posted in. */
  channelId: string;
  guildId: string | null;
  discordUserId: string;
  test: boolean;
}>;

export type DiscordRequestStage = "received" | "acked" | "admitted" | "first_status" | "delivered" | "failed" | "interrupted" | "limited";

export function discordEventIds(question: DiscordQuestionIds, extra: Readonly<{
  threadId?: string | null; runId?: string | null; chatId?: string | null;
}> = {}): DiscordEventIds {
  return {
    author_id: question.discordUserId,
    channel_id: question.channelId,
    ...(question.guildId ? { guild_id: question.guildId } : {}),
    message_id: question.questionMessageId,
    ...(extra.threadId ? { thread_id: extra.threadId } : {}),
    ...(extra.runId ? { run_id: extra.runId } : {}),
    ...(extra.chatId ? { chat_id: extra.chatId } : {}),
    ...(question.test ? { test: true } : {})
  };
}

export function logDiscordRequestStage(ids: DiscordEventIds, stage: DiscordRequestStage, input: Readonly<{
  receivedAt: Date;
  at: number;
  kind?: DiscordReplyKind;
  code?: string | null;
  limitKind?: DiscordLimitKind | null;
  redactions?: number;
}>): void {
  logEvent("discord_request", {
    ...ids, duration_ms: Math.max(0, input.at - input.receivedAt.getTime()), stage,
    ...(input.kind ? { kind: input.kind } : {}), ...(input.code ? { code: input.code } : {}),
    ...(input.limitKind ? { limit_kind: input.limitKind } : {}),
    ...(input.redactions ? { redactions: input.redactions } : {})
  });
}

export type DiscordRunTotals = Readonly<{
  mcpByServer: DiscordMcpTotals;
  compactions: number;
  subagents: number;
  sources: number;
}>;

/** A delivered run's totals: one record per MCP server, then one with the run's own counts (0 sources is "not found"). */
export function logDiscordRunSummary(ids: DiscordEventIds, totals: DiscordRunTotals): void {
  for (const [serverId, counts] of Object.entries(totals.mcpByServer).slice(0, 50)) {
    logEvent("discord_run_summary", { ...ids, mcp_calls: counts.calls, mcp_errors: counts.errors, mcp_server: serverId });
  }
  logEvent("discord_run_summary", {
    ...ids, compactions: totals.compactions, not_found: totals.sources === 0, sources: totals.sources, subagents: totals.subagents
  });
}

/** A bridge step that failed: content-free, with the code and its database identity when it was one. */
export function logDiscordBridgeFailure(fields: Readonly<{
  code: string; error?: unknown; runId?: string; outcome?: "failed" | "skipped" | "waiting" | "degraded";
  stage?: "dispatch" | "recovery" | "write" | "settle";
}>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    outcome: fields.outcome ?? "failed", ...(fields.runId ? { run_id: fields.runId } : {}), stage: fields.stage ?? "dispatch",
    subsystem: "discord"
  });
}
