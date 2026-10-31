// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { readHealthReach } from "./reach";

const MARK = `health-reach-${randomUUID()}`;
const owners = [`${MARK}-a`, `${MARK}-b`];
const base = new Date(Date.UTC(2002, 4, 5, 6, Math.floor(Math.random() * 600)));
const at = (days: number) => new Date(base.getTime() + days * 86_400_000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: owners } } });
  await prisma.$disconnect();
});

describe("product reach on PostgreSQL", () => {
  it("unions hosted and explicit Search users without requiring a SearchRun and excludes out-of-window activity", async () => {
    for (const [index, userId] of owners.entries()) {
      await prisma.user.create({ data: { id: userId, displayName: "Private reach owner", status: "active" } });
      const chat = await prisma.chat.create({ data: { userId, title: "Private title" } });
      const message = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Private prompt"), role: "user", status: "complete" } });
      for (const day of [0, -2, -10]) {
        const run = await prisma.modelRun.create({ data: { userId, chatId: chat.id, userMessageId: message.id,
          provider: "fake", modelId: "fake", status: "complete", createdAt: at(day), normalizedRequest: {} } });
        await prisma.usageEvent.create({ data: { userId, modelRunId: run.id, provider: "fake", modelId: "fake",
          purpose: "chat_answer", webSearchCount: 3, createdAt: at(day) } });
        if (index === 0) await prisma.modelRunToolCall.create({ data: { modelRunId: run.id, roundIndex: 0, ordinal: 0,
          providerCallId: randomUUID(), toolName: "search_engine_1", arguments: {}, state: "complete", createdAt: at(day) } });
      }
    }
    const reach = await readHealthReach(prisma, { from: at(0), to: at(1) }, []);
    expect(reach).toMatchObject({ activeUsers: 2, runs: 2, runsPerActiveUser: 1, reportedWebSearches: 6,
      weekly: [{ activeUsers: 2, runs: 4 }], features: expect.arrayContaining([{ feature: "search", users: 2 }]),
      tools: [{ kind: "search", users: 2, calls: 0, failed: 0, cancelled: 0, awaitingApproval: 0, failureRate: null }],
      perTool: [{ tool: "search_engine_1", users: 1, calls: 0, failed: 0, failureRate: null }] });
    expect(JSON.stringify(reach)).not.toMatch(/Private|health-reach-/u);
  });
});
