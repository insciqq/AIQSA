import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaChatRepository } from "./prismaRepository";

afterAll(() => prisma.$disconnect());

it("keeps a monitoring check's outcome on both messages of its turn after its occurrence history is gone", async () => {
  const userId = randomUUID();
  const chatId = randomUUID();
  await prisma.user.create({ data: { displayName: "Monitoring transcript test", id: userId, status: "active" } });
  try {
    await prisma.chat.create({ data: { id: chatId, title: "Synthetic watch", userId } });
    let parentMessageId: string | null = null;
    const turns: Array<{ answerId: string; questionId: string }> = [];
    // An ordinary turn, then three checks: shown first, two without news. Their
    // runs keep the scheduled origin as plain values: no occurrence row exists,
    // as after the task's history was pruned or the task was deleted.
    for (const outcome of [null, "baseline", "no_update", "no_update"] as const) {
      const questionId = randomUUID();
      const answerId = randomUUID();
      await prisma.message.create({ data: { chatId, content: textMessageContent("Check"), id: questionId, parentMessageId,
        role: "user", status: "complete" } });
      await prisma.message.create({ data: { chatId, content: textMessageContent("Result"), id: answerId, parentMessageId: questionId,
        role: "assistant", status: "complete" } });
      await prisma.modelRun.create({ data: {
        assistantMessageId: answerId, chatId, id: randomUUID(), modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
        status: "complete", userId,
        userMessageId: questionId,
        ...(outcome ? { scheduledOccurrenceId: randomUUID(), scheduledOutcome: outcome, scheduledTaskGeneration: 1,
          scheduledTaskId: randomUUID() } : {})
      } });
      turns.push({ answerId, questionId });
      parentMessageId = answerId;
    }
    await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chatId } });
    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail?.messages.map((message) => [message.role, message.scheduledOutcome ?? null])).toEqual([
      ["user", null], ["assistant", null],
      ["user", "baseline"], ["assistant", "baseline"],
      ["user", "no_update"], ["assistant", "no_update"],
      ["user", "no_update"], ["assistant", "no_update"]
    ]);
    // The occurrence marker needs its pruned row; the outcome does not.
    expect(detail?.messages.some((message) => message.scheduledTask)).toBe(false);
    // Only a run with a scheduled origin may carry an outcome.
    await expect(prisma.modelRun.create({ data: { assistantMessageId: turns[0]!.answerId, chatId, id: randomUUID(), modelId: "fake-qsa",
      provider: "fake", scheduledOutcome: "no_update", status: "complete", userId, userMessageId: turns[0]!.questionId } })).rejects.toThrow();
  } finally {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
