import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { decodeAdminUsageAnalyticsResponse } from "@/lib/contracts/adminUsageAnalytics";
import { textMessageContent } from "@/lib/domain/content";
import { prisma } from "../../prisma";
import { createAdminUsageRepository } from "./repository";

/**
 * Synthetic usage in October 2003, a window no other fixture writes, so
 * installation-wide aggregation is exact. Berlin left summer time on
 * 2003-10-26 at 03:00 local (01:00 UTC).
 */
const NOW = new Date("2003-10-28T12:00:00.000Z");
const ZONE = "Europe/Berlin";

afterAll(() => prisma.$disconnect());

async function withFixture<T>(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<T>): Promise<T> {
  const marker = `usage-analytics-${randomUUID()}`;
  try {
    return await run(await createFixture(marker));
  } finally {
    const users = await prisma.user.findMany({ select: { id: true }, where: { email: { endsWith: `@${marker}.example.com` } } });
    const userIds = users.map((user) => user.id);
    await prisma.usageEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.chat.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.group.deleteMany({ where: { name: { startsWith: marker } } });
    await prisma.providerModel.deleteMany({ where: { connectionId: `${marker}-conn` } });
    await prisma.providerConnection.deleteMany({ where: { id: `${marker}-conn` } });
  }
}

async function chatWithRun(userId: string, run: { id: string; provider: string; modelId: string; scheduled?: boolean }) {
  const chatId = randomUUID();
  const questionId = randomUUID();
  const answerId = randomUUID();
  await prisma.chat.create({ data: { id: chatId, title: "Synthetic usage", userId } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("Q"), id: questionId, role: "user", status: "complete" } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("A"), id: answerId, parentMessageId: questionId,
    role: "assistant", status: "complete" } });
  await prisma.modelRun.create({ data: {
    assistantMessageId: answerId, chatId, id: run.id, modelId: run.modelId, normalizedRequest: {}, provider: run.provider,
    status: "complete", userId, userMessageId: questionId,
    ...(run.scheduled ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID() } : {})
  } });
  return chatId;
}

async function createFixture(marker: string) {
  const connectionId = `${marker}-conn`;
  const family = `${marker}-family`;
  const modelId = `${marker}-pm-alpha`;
  const upstream = `${marker}/alpha`;
  await prisma.providerConnection.create({ data: { displayName: "Usage Conn", family, id: connectionId } });
  await prisma.providerModel.create({ data: {
    capabilities: {}, connectionId, defaultParams: {}, displayName: "Alpha", id: modelId, modelId: upstream, provider: family
  } });
  const team = await prisma.group.create({ data: { name: `${marker}-team` } });
  const archived = await prisma.group.create({ data: { archivedAt: new Date("2003-01-01T00:00:00.000Z"), name: `${marker}-archived` } });
  const u1 = await prisma.user.create({ data: { displayName: "Usage One", email: `one@${marker}.example.com`, status: "active",
    groups: { create: { groupId: team.id } } } });
  const u2 = await prisma.user.create({ data: { displayName: "Usage Two", email: `two@${marker}.example.com`, status: "active",
    groups: { create: [{ groupId: team.id }, { groupId: archived.id }] } } });

  const chatRun = randomUUID();
  const scheduledRun = randomUUID();
  const u1Chat = await chatWithRun(u1.id, { id: chatRun, modelId, provider: connectionId });
  await chatWithRun(u2.id, { id: scheduledRun, modelId, provider: connectionId, scheduled: true });
  await prisma.providerRunBinding.create({ data: {
    bindingKey: "image", connectionId, credentialSource: "default", executionSnapshot: {}, modelRunId: chatRun,
    providerModelId: modelId, role: "image"
  } });
  const toolCall = await prisma.modelRunToolCall.create({ data: {
    arguments: {}, modelRunId: chatRun, ordinal: 0, providerCallId: "call-image", roundIndex: 0,
    startedAt: new Date("2003-10-26T22:00:00.000Z"), toolName: "generate_image"
  } });

  await prisma.usageEvent.create({ data: { // Run row: local 2003-10-26 00:30 summer time.
    chatId: u1Chat, createdAt: new Date("2003-10-25T22:30:00.000Z"), estimatedCostMicros: 100, inputTokens: 10,
    modelId, modelRunId: chatRun, outputTokens: 5, provider: connectionId, purpose: "chat_answer", totalTokens: 15,
    usageCompleteness: "COMPLETE", userId: u1.id
  } });
  await prisma.usageEvent.create({ data: { // Image row: local 2003-10-26 23:30 winter time, the same 25-hour day.
    chatId: u1Chat, createdAt: new Date("2003-10-26T22:30:00.000Z"), estimatedCostMicros: 2_000, imageGeneration: true,
    imageToolCallId: toolCall.id, modelId: upstream, modelRunId: chatRun, provider: family, providerModelId: modelId,
    purpose: "image_generation", userId: u1.id
  } });
  await prisma.usageEvent.create({ data: { // Scheduled run row with unknown cost: local 2003-10-27 01:30.
    createdAt: new Date("2003-10-27T00:30:00.000Z"), inputTokens: 30, modelId, modelRunId: scheduledRun, outputTokens: 10,
    provider: connectionId, purpose: "chat_answer", totalTokens: 40, usageCompleteness: "COMPLETE", userId: u2.id
  } });
  await prisma.usageEvent.create({ data: { // Background row under an uncatalogued model: local 2003-10-22 02:00.
    createdAt: new Date("2003-10-22T00:00:00.000Z"), estimatedCostMicros: 5, inputTokens: 7, modelId: "raw-model",
    provider: `${marker}-raw`, purpose: "knowledge_indexing", totalTokens: 7, usageCompleteness: "PARTIAL", userId: u2.id
  } });
  await prisma.usageEvent.create({ data: { // Chat-summary shape: family plus the ProviderModel id.
    chatId: randomUUID(), createdAt: new Date("2003-10-28T09:00:00.000Z"), estimatedCostMicros: 1, inputTokens: 2, modelId,
    outputTokens: 1, provider: family, purpose: "chat_summary", totalTokens: 3, usageCompleteness: "COMPLETE", userId: u2.id
  } });
  await prisma.usageEvent.create({ data: { // Previous window only.
    chatId: u1Chat, createdAt: new Date("2003-10-18T10:00:00.000Z"), estimatedCostMicros: 50, inputTokens: 20, modelId,
    provider: connectionId, purpose: "chat_answer", totalTokens: 20, usageCompleteness: "PARTIAL", userId: u1.id
  } });
  await prisma.usageEvent.create({ data: { // Between the previous window's end and the current start: in neither.
    createdAt: new Date("2003-10-21T21:59:00.000Z"), estimatedCostMicros: 900, modelId, provider: connectionId, purpose: "other",
    userId: u1.id
  } });
  return { archived, connectionId, marker, modelId, team, u1, u2 };
}

describe("admin usage repository", () => {
  it("aggregates a window in the viewer's zone across a DST change", async () => {
    await withFixture(async (f) => {
      const usage = await createAdminUsageRepository(prisma).readAnalytics({ now: NOW, period: "7d", timeZone: ZONE });
      expect(decodeAdminUsageAnalyticsResponse(JSON.parse(JSON.stringify({ usage })))).not.toBeNull();
      expect(usage.window).toEqual({ bucket: "day", from: "2003-10-21T22:00:00.000Z", period: "7d", timeZone: ZONE,
        to: NOW.toISOString() });

      expect(usage.totals).toMatchObject({
        activeUserCount: 2, cachedInputTokens: null, estimatedCostMicros: 2_106, incompleteUsageCount: 2, inputTokens: 49,
        knownCostRecordCount: 4, lastUsedAt: "2003-10-28T09:00:00.000Z", outputTokens: 16, reasoningTokens: null,
        recordCount: 5, runCount: 2, totalTokens: 65
      });

      expect(usage.series.map((point) => point.start)).toEqual([
        "2003-10-21T22:00:00.000Z", "2003-10-22T22:00:00.000Z", "2003-10-23T22:00:00.000Z", "2003-10-24T22:00:00.000Z",
        "2003-10-25T22:00:00.000Z", "2003-10-26T23:00:00.000Z", "2003-10-27T23:00:00.000Z"
      ]);
      const day = (index: number) => usage.series[index]!;
      expect(day(0).categories.background).toEqual({ estimatedCostMicros: 5, totalTokens: 7 });
      expect(day(4)).toMatchObject({ runCount: 1, categories: {
        chat: { estimatedCostMicros: 100, totalTokens: 15 }, images: { estimatedCostMicros: 2_000, totalTokens: 0 } } });
      expect(day(5)).toMatchObject({ runCount: 1, categories: { scheduled: { estimatedCostMicros: 0, totalTokens: 40 } } });
      expect(day(6)).toMatchObject({ runCount: 0, categories: { chat: { estimatedCostMicros: 1, totalTokens: 3 } } });
      expect([1, 2, 3].every((index) => Object.values(day(index).categories)
        .every((value) => value.estimatedCostMicros === 0 && value.totalTokens === 0))).toBe(true);

      expect(usage.byCategory.map((row) => [row.category, row.estimatedCostMicros, row.totalTokens, row.runCount, row.recordCount])).toEqual([
        ["images", 2_000, null, 1, 1], ["chat", 101, 18, 1, 2], ["background", 5, 7, 0, 1], ["scheduled", null, 40, 1, 1]
      ]);

      expect(usage.byModel.map((row) => [row.label, row.provider, row.modelId, row.estimatedCostMicros, row.totalTokens,
        row.recordCount, row.runCount, row.userCount])).toEqual([
        ["Usage Conn / Alpha", f.connectionId, f.modelId, 2_101, 58, 4, 2, 2],
        ["raw-model", `${f.marker}-raw`, "raw-model", 5, 7, 1, 0, 1]
      ]);

      expect(usage.byUser.map((row) => [row.userId, row.estimatedCostMicros, row.totalTokens, row.runCount,
        row.topModels.map((model) => model.label), row.groups.map((group) => group.groupId).sort()])).toEqual([
        [f.u1.id, 2_100, 15, 1, ["Usage Conn / Alpha"], [f.team.id]],
        [f.u2.id, 6, 50, 1, ["raw-model", "Usage Conn / Alpha"], [f.archived.id, f.team.id].sort()]
      ]);

      const groups = usage.byGroup.filter((row) => row.groupId === f.team.id || row.groupId === f.archived.id);
      expect(groups.map((row) => [row.groupId, row.estimatedCostMicros, row.contributingUsers, row.userCount, row.runCount,
        row.archivedAt])).toEqual([
        [f.team.id, 2_106, 2, 2, 2, null],
        [f.archived.id, 6, 1, 1, 1, "2003-01-01T00:00:00.000Z"]
      ]);

      expect(usage.previous).toEqual({ activeUserCount: 1, estimatedCostMicros: 50, from: "2003-10-14T22:00:00.000Z",
        runCount: 0, to: "2003-10-21T11:00:00.000Z", totalTokens: 20 });
    });
  });

  it("returns empty buckets for a period without usage and month buckets for twelve months", async () => {
    await withFixture(async (f) => {
      const repository = createAdminUsageRepository(prisma);
      const empty = await repository.readAnalytics({ now: NOW, period: "last_month", timeZone: ZONE });
      expect(decodeAdminUsageAnalyticsResponse({ usage: empty })).not.toBeNull();
      expect(empty.series).toHaveLength(30);
      expect(empty.series.every((point) => point.runCount === 0)).toBe(true);
      expect(empty).toMatchObject({ byCategory: [], byModel: [], byUser: [], totals: { activeUserCount: 0, recordCount: 0,
        estimatedCostMicros: null, lastUsedAt: null } });

      const year = await repository.readAnalytics({ now: NOW, period: "12m", timeZone: ZONE });
      expect(year.window.bucket).toBe("month");
      expect(year.series).toHaveLength(12);
      expect(year.series.at(-1)).toMatchObject({ start: "2003-09-30T22:00:00.000Z", runCount: 2 });
      expect(year.totals.recordCount).toBe(7);

      const all = await repository.readAnalytics({ now: NOW, period: "all", timeZone: ZONE });
      expect(decodeAdminUsageAnalyticsResponse({ usage: all })).not.toBeNull();
      expect(all.previous).toBeNull();
      expect(all.byUser.map((row) => row.userId)).toEqual(expect.arrayContaining([f.u1.id, f.u2.id]));
    });
  });

  it("exports one row per bucket, user, model and category", async () => {
    await withFixture(async (f) => {
      const exported = await createAdminUsageRepository(prisma).readExport({ now: NOW, period: "7d", timeZone: ZONE });
      expect(exported).not.toBeNull();
      const rows = exported!.rows.map((row) => [row.bucket, row.userId, exported!.models.get(row.model)?.label ?? row.model,
        row.category, row.amounts.recordCount]).sort((left, right) => String(left[0]).localeCompare(String(right[0])) ||
        String(left[3]).localeCompare(String(right[3])));
      expect(rows).toEqual([
        ["2003-10-22", f.u2.id, "raw-model", "background", 1],
        ["2003-10-26", f.u1.id, "Usage Conn / Alpha", "chat", 1],
        ["2003-10-26", f.u1.id, "Usage Conn / Alpha", "images", 1],
        ["2003-10-27", f.u2.id, "Usage Conn / Alpha", "scheduled", 1],
        ["2003-10-28", f.u2.id, "Usage Conn / Alpha", "chat", 1]
      ]);
      expect([...exported!.users.keys()].sort()).toEqual([f.u1.id, f.u2.id].sort());
    });
  });
});
