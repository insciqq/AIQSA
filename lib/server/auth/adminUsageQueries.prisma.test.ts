import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { serializeAdminUsageDashboard } from "./adminUsageAggregation";
import { loadAdminUsageQueryRows } from "./adminUsageQueries";

describe("Prisma admin usage cost totals", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("counts each cost record independently of retained runs and retains detached, unknown and zero costs", async () => {
    const userId = randomUUID();
    await prisma.user.create({ data: { id: userId, displayName: "Usage cost fixture", status: "active" } });
    try {
      const chat = await prisma.chat.create({ data: { userId, title: "Usage cost fixture", memoryMode: "EXCLUDED" } });
      const userMessage = await prisma.message.create({ data: {
        chatId: chat.id, role: "user", content: { blocks: [{ type: "text", text: "Synthetic usage fixture" }] }
      } });
      const assistantMessage = await prisma.message.create({ data: {
        chatId: chat.id, role: "assistant", parentMessageId: userMessage.id, content: { blocks: [] }
      } });
      const run = await prisma.modelRun.create({ data: {
        userId, chatId: chat.id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id,
        provider: "fixture", modelId: "mixed-cost", status: "complete", normalizedRequest: {}
      } });
      await prisma.usageEvent.createMany({ data: [
        { userId, chatId: chat.id, modelRunId: run.id, provider: "fixture", modelId: "mixed-cost",
          totalTokens: 10, estimatedCostMicros: 12_000, usageCompleteness: "COMPLETE" },
        { userId, chatId: chat.id, modelRunId: run.id, provider: "fixture", modelId: "mixed-cost",
          totalTokens: 20, estimatedCostMicros: null, usageCompleteness: "COMPLETE" },
        { userId, chatId: chat.id, provider: "fixture", modelId: "mixed-cost",
          totalTokens: 5, estimatedCostMicros: 3_000, usageCompleteness: "COMPLETE" },
        { userId, provider: "fixture", modelId: "unknown-cost", totalTokens: 7,
          estimatedCostMicros: null, usageCompleteness: "COMPLETE" },
        { userId, provider: "fixture", modelId: "zero-cost", totalTokens: 2,
          estimatedCostMicros: 0, usageCompleteness: "COMPLETE" }
      ] });

      const rows = await loadAdminUsageQueryRows(prisma);
      const userRows = rows.userRows.filter((row) => row.userId === userId);
      const providerModelRows = rows.providerModelRows.filter((row) => row.userId === userId);
      expect(userRows).toEqual([expect.objectContaining({
        _count: { _all: 1 }, recordCount: 5, knownCostRecordCount: 3,
        _sum: expect.objectContaining({ estimatedCostMicros: 15_000, totalTokens: 44 })
      })]);
      expect(providerModelRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: "mixed-cost", _count: { _all: 1 }, recordCount: 3, knownCostRecordCount: 2,
          _sum: expect.objectContaining({ estimatedCostMicros: 15_000, totalTokens: 35 }) }),
        expect.objectContaining({ modelId: "unknown-cost", _count: { _all: 0 }, recordCount: 1, knownCostRecordCount: 0,
          _sum: expect.objectContaining({ estimatedCostMicros: null }) }),
        expect.objectContaining({ modelId: "zero-cost", _count: { _all: 0 }, recordCount: 1, knownCostRecordCount: 1,
          _sum: expect.objectContaining({ estimatedCostMicros: 0 }) })
      ]));
      const dashboard = serializeAdminUsageDashboard({
        userRows, providerModelRows,
        users: [{ id: userId, displayName: "Usage cost fixture", email: null,
          groups: [{ groupId: "fixture-group", role: "member" }] }],
        groups: [{ id: "fixture-group", name: "Usage cost group", archivedAt: null, _count: { users: 1 } }]
      });
      const totals = { estimatedCostMicros: 15_000, recordCount: 5, knownCostRecordCount: 3, runCount: 1, totalTokens: 44 };
      expect(dashboard.totals).toMatchObject(totals);
      expect(dashboard.byUser[0]).toMatchObject(totals);
      expect(dashboard.byGroup[0]).toMatchObject(totals);

      await prisma.modelRun.delete({ where: { id: run.id } });
      const afterDeletion = (await loadAdminUsageQueryRows(prisma)).userRows.find((row) => row.userId === userId);
      expect(afterDeletion).toMatchObject({
        _count: { _all: 0 }, recordCount: 5, knownCostRecordCount: 3,
        _sum: { estimatedCostMicros: 15_000, totalTokens: 44 }
      });
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});
