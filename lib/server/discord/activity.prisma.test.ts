// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { decodeDiscordAdminActivity, decodeDiscordMonitoringTelemetry } from "../../contracts/discord";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { discordActivityStats, readDiscordActivityRows, readDiscordJournalStats } from "./activity";
import { createPrismaDiscordProblemReports, createPrismaDiscordRatingStore } from "./lifecycle";
import { formatDiscordMetrics, readDiscordHourLoad, readDiscordMonitoringTelemetry, readDiscordProblemRows } from "./monitoring";

/**
 * The journal's aggregates, problem rows, Activity rows, hour load, ratings and
 * problem reports on a disposable database. Rows live in a window long past
 * (a random hour of 2003) so other tests' rows never fall inside; every id is
 * synthetic, and each test removes what it made.
 */

const users: string[] = [];
const loose: bigint[] = [];
let next = 1_300_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)) * 1_000n;
const snowflake = () => next++;
const BASE = Date.parse("2003-01-01T00:00:00.000Z") + Math.floor(Math.random() * 300 * 24) * 3_600_000;
const at = (seconds: number) => new Date(BASE + seconds * 1_000);
const WINDOW = { since: at(0), until: at(3_600) };
const SENTINEL = "Sentinel Author Name 7f3a";
const GUILD = 1_300_000_000_000_000_001n;
const CHANNEL = 1_300_000_000_000_000_010n;

const servers: string[] = [];

afterEach(async () => {
  await prisma.mcpServer.deleteMany({ where: { id: { in: servers.splice(0) } } });
  await prisma.discordReply.deleteMany({ where: { questionMessageId: { in: loose.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

async function serviceRun(status: "complete" | "error" = "complete") {
  const userId = `discord-activity-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Discord", id: userId, kind: "service", status: "active" } });
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED", title: SENTINEL, userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(SENTINEL), role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(SENTINEL), parentMessageId: question.id, role: "assistant", status
  } });
  const run = await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, engine: "native", modelId: "fake-qsa", provider: "fake", status, userId, userMessageId: question.id,
    // A run past `preparing` carries its normalized request (ModelRun_memory_request_shape_check).
    normalizedRequest: {}
  } });
  const conversation = await prisma.discordConversation.create({ data: {
    chatId: chat.id, discordChannelId: snowflake(), guildId: GUILD, kind: "thread", parentChannelId: CHANNEL, userId
  } });
  return { answerId: answer.id, chatId: chat.id, conversationId: conversation.id, runId: run.id, userId };
}

function reply(input: Partial<Prisma.DiscordReplyCreateManyInput> & Readonly<{ seconds: number }>): Prisma.DiscordReplyCreateManyInput {
  const questionMessageId = snowflake();
  if (!input.conversationId) loose.push(questionMessageId);
  const { seconds, ...rest } = input;
  return {
    authorName: SENTINEL, channelId: CHANNEL, discordUserId: 1_300_000_000_000_000_020n, guildId: GUILD, kind: "answer", questionMessageId,
    receivedAt: at(seconds), state: "delivered", ...rest
  };
}

describe("Discord journal reads (stateful)", () => {
  it("aggregates a window without test-mode rows, lists its problems once each, and never returns a name or text", async () => {
    const service = await serviceRun();
    const server = async (displayName: string, ownerUserId: string | null = null) => {
      const created = await prisma.mcpServer.create({ data: { displayName, namespace: `mcp_${randomUUID().replaceAll("-", "").slice(0, 20)}`, ownerUserId } });
      servers.push(created.id);
      return created.id;
    };
    const tracker = await server("Tracker\u0007 tools");
    const wiki = await server("Wiki");
    const personal = await server(SENTINEL, service.userId);
    const deleted = `server-${randomUUID()}`;
    const delivered = (seconds: number, delayS: number, extra: Partial<Prisma.DiscordReplyCreateManyInput> = {}) => reply({
      ackAt: at(seconds + 1), admittedAt: at(seconds + 2), conversationId: service.conversationId, deliveredAt: at(seconds + delayS),
      firstStatusAt: at(seconds + 3), seconds, sources: 2, ...extra
    });
    const rows = [
      delivered(10, 10, {
        compactions: 1, mcpByServer: { [personal]: { calls: 1, errors: 1 }, [tracker]: { calls: 3, errors: 1 } }, runId: service.runId, subagents: 2
      }),
      delivered(20, 20, { mcpByServer: { [deleted]: { calls: 5, errors: 0 }, [tracker]: { calls: 1, errors: 0 }, [wiki]: { calls: 2, errors: 2 } } }),
      delivered(30, 30, { sources: 0 }),
      delivered(40, 100),
      reply({ code: "discord_busy", kind: "refused", seconds: 50, state: "failed" }),
      reply({ code: "discord_delivery_unknown", seconds: 60, state: "unknown" }),
      reply({ code: "discord_user_limit", kind: "refused", limitKind: "author", seconds: 70, state: "failed" }),
      reply({ code: "discord_question_deleted", seconds: 80, state: "interrupted" }),
      // Test mode: in the problem rows, never in the aggregates.
      reply({ code: "discord_busy", kind: "refused", seconds: 90, state: "failed", test: true }),
      // Outside the window.
      reply({ code: "discord_busy", kind: "refused", seconds: 3_700, state: "failed" })
    ];
    await prisma.discordReply.createMany({ data: rows });
    const ratings = createPrismaDiscordRatingStore(prisma);
    await ratings.set({ at: at(500), discordUserId: "1300000000000000101", replyId: rows[0]!.questionMessageId.toString(), value: -1 });
    await ratings.set({ at: at(500), discordUserId: "1300000000000000102", replyId: rows[0]!.questionMessageId.toString(), value: 1 });
    await ratings.set({ at: at(500), discordUserId: "1300000000000000103", replyId: rows[8]!.questionMessageId.toString(), value: -1 });

    const stats = await readDiscordJournalStats(prisma, WINDOW);
    expect(stats).toMatchObject({
      compactions: 1, delivered: 4, failed: 2, interrupted: 1, limitHits: { author: 1, key: 0, thread: 0 }, notFound: 1, ratingsDown: 1, ratingsUp: 1,
      requests: 8, subagents: 2
    });
    expect(stats.failuresByCode).toEqual([{ code: "discord_busy", count: 1 }, { code: "discord_delivery_unknown", count: 1 }]);
    expect(stats.latency.acked).toEqual({ p50Ms: 1_000, p95Ms: 1_000 });
    expect(stats.latency.delivered.p50Ms).toBe(25_000);
    expect(stats.latency.delivered.p95Ms).toBe(89_500);

    const telemetry = await readDiscordMonitoringTelemetry(prisma, WINDOW, at(4_000));
    expect(decodeDiscordMonitoringTelemetry(telemetry)).not.toBeNull();
    // Servers by their administrator's name; a deleted one is `other`, a personal one `personal`; never an id.
    expect(telemetry.mcpByServer).toEqual([
      { calls: 5, errors: 0, server: "other" }, { calls: 4, errors: 1, server: "Tracker tools" }, { calls: 2, errors: 2, server: "Wiki" },
      { calls: 1, errors: 1, server: "personal" }
    ]);
    for (const id of [tracker, wiki, personal, deleted]) expect(JSON.stringify(telemetry)).not.toContain(id);
    const kinds = new Map(telemetry.problems.map((problem) => [problem.questionMessageId, problem]));
    const id = (index: number) => rows[index]!.questionMessageId.toString();
    expect(telemetry.problems.map((problem) => problem.questionMessageId)).toEqual([8, 7, 6, 5, 4, 3, 2, 0].map(id));
    expect([...kinds.values()].map((problem) => problem.kind)).toEqual(
      ["failed", "interrupted", "limit", "failed", "failed", "slow", "not_found", "rated_down"]);
    expect(kinds.get(id(8))!.test).toBe(true);
    expect(kinds.get(id(0))).toMatchObject({
      chatId: service.chatId, latencyMs: 10_000,
      messageLink: `https://discord.com/channels/${GUILD}/${CHANNEL}/${id(0)}`
    });
    expect(kinds.get(id(6))).toMatchObject({ code: "discord_user_limit", limitKind: "author" });
    expect(JSON.stringify(telemetry)).not.toContain(SENTINEL);

    const activity = discordActivityStats(stats);
    expect(activity.latency).toEqual(stats.latency.delivered);
    const listed = await readDiscordActivityRows(prisma, { channelNames: new Map([[CHANNEL.toString(), "agent-test"]]), until: WINDOW.until });
    expect(decodeDiscordAdminActivity({ last24h: activity, last7d: activity, rows: listed })).not.toBeNull();
    expect(listed.slice(0, 9).map((entry) => entry.questionMessageId)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0].map(id));
    expect(listed[0]).toMatchObject({ authorName: SENTINEL, channelName: "agent-test", code: "discord_busy", kind: "refused", latencyMs: null,
      state: "failed", test: true });
    expect(listed[8]).toMatchObject({ latencyMs: 10_000, state: "delivered", test: false });
  });

  it("counts an answer from MCP results as found though it cites nothing, from the stored totals (operator decision 2026-11-13)", async () => {
    const rows = [
      reply({ mcpByServer: { a: { calls: 2, errors: 1 } }, seconds: 10, sources: 0 }),
      // Only failed calls, or none: nothing found.
      reply({ mcpByServer: { a: { calls: 1, errors: 1 }, b: { calls: 0, errors: 0 } }, seconds: 20, sources: 0 }),
      reply({ seconds: 30, sources: 0 }),
      // Not an object, or counts that are not numbers: no call counts.
      reply({ mcpByServer: [], seconds: 40, sources: 0 }),
      reply({ mcpByServer: { a: { calls: "2", errors: 0 } }, seconds: 50, sources: 0 }),
      reply({ seconds: 60, sources: 1 }),
      reply({ code: "discord_busy", kind: "refused", seconds: 70, sources: 0, state: "failed" })
    ];
    await prisma.discordReply.createMany({ data: rows });
    const id = (index: number) => rows[index]!.questionMessageId.toString();
    expect((await readDiscordJournalStats(prisma, WINDOW)).notFound).toBe(4);
    const problems = await readDiscordProblemRows(prisma, WINDOW, null);
    expect(problems.map((problem) => [problem.questionMessageId, problem.kind])).toEqual([
      [id(6), "failed"], [id(4), "not_found"], [id(3), "not_found"], [id(2), "not_found"], [id(1), "not_found"]
    ]);
  });

  it("counts the last hour's requests, failures and limit hits apart for test mode, as the metrics and the attention rule read them", async () => {
    const now = at(3_000);
    await prisma.discordReply.createMany({ data: [
      ...Array.from({ length: 5 }, (_, index) => reply({ code: "discord_busy", kind: "refused", seconds: 100 + index, state: "failed" })),
      ...Array.from({ length: 15 }, (_, index) => reply({ deliveredAt: at(200 + index + 4), seconds: 200 + index })),
      reply({ code: "discord_key_limit", limitKind: "key", seconds: 300, state: "failed" }),
      reply({ code: "discord_busy", kind: "refused", seconds: 310, state: "failed", test: true }),
      // Older than the hour.
      reply({ code: "discord_busy", kind: "refused", seconds: -700, state: "failed" })
    ] });
    const hour = await readDiscordHourLoad(prisma, now);
    expect(hour.people).toEqual({ failures: 5, latencyP95Ms: 4_000, limitHits: { author: 0, key: 1, thread: 0 }, requests: 21 });
    expect(hour.test).toEqual({ failures: 1, latencyP95Ms: null, limitHits: { author: 0, key: 0, thread: 0 }, requests: 1 });
    const text = formatDiscordMetrics({ connected: true, enabled: true, hour, lastEventAt: now, now });
    expect(text).toContain(`aiqsa_discord_failures_1h{test="false"} 5\n`);
    expect(text).toContain("aiqsa_discord_failure_ratio_1h 0.238\n");
  });

  it("keeps one rating per person and answer, and files one problem report per answer however often it is rated down", async () => {
    const service = await serviceRun();
    const row = reply({ conversationId: service.conversationId, runId: service.runId, seconds: 10 });
    await prisma.discordReply.createMany({ data: [row] });
    const replyId = row.questionMessageId.toString();
    const ratings = createPrismaDiscordRatingStore(prisma);
    await ratings.set({ at: at(20), discordUserId: "1300000000000000101", replyId, value: 1 });
    await ratings.set({ at: at(21), discordUserId: "1300000000000000101", replyId, value: -1 });
    expect(await ratings.remove({ discordUserId: "1300000000000000101", replyId, value: 1 })).toBe(false);
    expect(await prisma.discordAnswerRating.findMany({ select: { value: true }, where: { replyId: row.questionMessageId } })).toEqual([{ value: -1 }]);
    expect(await ratings.remove({ discordUserId: "1300000000000000101", replyId, value: -1 })).toBe(true);
    expect(await prisma.discordAnswerRating.count({ where: { replyId: row.questionMessageId } })).toBe(0);

    const reports = createPrismaDiscordProblemReports(prisma);
    expect(await reports.answerOfRun({ runId: service.runId, userId: "someone-else" })).toBeNull();
    const answer = await reports.answerOfRun({ runId: service.runId, userId: service.userId });
    expect(answer).toEqual({ assistantMessageId: service.answerId, chatId: service.chatId });
    const input = { chatId: service.chatId, comment: "Discord: rated 👎 by Alex", messageId: service.answerId, runId: service.runId, userId: service.userId };
    expect(await Promise.all([reports.fileOnce(input), reports.fileOnce({ ...input, comment: "Discord: rated 👎 by Sam" })]))
      .toEqual(expect.arrayContaining(["created", "exists"]));
    expect(await prisma.answerProblemReport.findMany({ select: { reason: true, runId: true }, where: { messageId: service.answerId } }))
      .toEqual([{ reason: "other", runId: service.runId }]);
    expect(await reports.fileOnce({ ...input, messageId: randomUUID() })).toBe("skipped");
  });
});
