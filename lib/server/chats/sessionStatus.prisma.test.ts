import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { prisma } from "../prisma";
import { textMessageContent } from "../../domain/content";
import { createPrismaChatRepository } from "./prismaRepository";
import type { SessionContextStatus } from "../../contracts/sessionStatus";

afterAll(() => prisma.$disconnect());

it("reloads the active branch's context snapshot without leaking sibling or other-owner measurements", async () => {
  const userId = randomUUID();
  const chatId = randomUUID();
  const questionId = randomUUID();
  const answerId = randomUUID();
  const siblingId = randomUUID();
  const status: SessionContextStatus = {
    approximateInputTokens: 4400, contextWindow: 12000, droppedMessages: 0, loadedTools: 3,
    maxOutputTokens: 800, modelId: "fake-qsa", phase: "after_answer", provider: "fake",
    safetyMarginTokens: 1200, version: 1
  };
  await prisma.user.create({ data: { id: userId, displayName: "Context test", status: "active" } });
  try {
    await prisma.chat.create({ data: { id: chatId, userId, title: "Context test" } });
    await prisma.message.create({ data: {
      id: questionId, chatId, role: "user", content: textMessageContent("question"), status: "complete"
    } });
    for (const [id, tokens] of [[answerId, 4400], [siblingId, 9000]] as const) {
      await prisma.message.create({ data: { id, chatId, parentMessageId: questionId,
        role: "assistant", content: textMessageContent("answer"), status: "complete" } });
      await prisma.modelRun.create({ data: {
        id: randomUUID(), chatId, userId, userMessageId: questionId, assistantMessageId: id,
        modelId: "fake-qsa", provider: "fake", status: "complete",
        normalizedRequest: { sessionStatusTool: true },
        events: { create: { sequence: 1, eventType: "artifact", payload: {
          artifactType: "context_status", payload: { ...status, approximateInputTokens: tokens }
        } } }
      } });
    }
    await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: answerId } });
    const repo = createPrismaChatRepository(prisma);
    const detail = await repo.getChat({ chatId, userId });
    expect(detail?.contextStats.session).toEqual(status);
    expect(detail?.messages.map((message) => message.id)).toEqual([questionId, answerId]);
    expect(await repo.getChat({ chatId, userId: randomUUID() })).toBeNull();
    await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: siblingId } });
    expect((await repo.getChat({ chatId, userId }))?.contextStats.session?.approximateInputTokens).toBe(9000);
  } finally {
    await prisma.user.delete({ where: { id: userId } });
  }
});
