import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { decodeChatDetailResponse } from "../../contracts/chats";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { serializeChatDetail } from "./handlers";
import { createPrismaChatRepository } from "./prismaRepository";

afterAll(() => prisma.$disconnect());

it("marks only the user messages one of whose runs was admitted with Deep research", async () => {
  const userId = randomUUID();
  const chatId = randomUUID();
  await prisma.user.create({ data: { displayName: "Deep research projection test", id: userId, status: "active" } });
  try {
    await prisma.chat.create({ data: { id: chatId, title: "Synthetic research", userId } });
    let parentMessageId: string | null = null;
    const questions: string[] = [];
    // An ordinary turn, a turn sent with Deep research and answered again by an ordinary regenerate request (which keeps the
    // choice, so both runs hold it), and a turn whose request carries the field as anything but `true`.
    for (const requests of [[{}], [{ deepResearch: true }, { deepResearch: true }], [{ deepResearch: false }]] as const) {
      const questionId = randomUUID();
      await prisma.message.create({ data: { chatId, content: textMessageContent("Question"), id: questionId, parentMessageId,
        role: "user", status: "complete" } });
      let answerId = questionId;
      for (const normalizedRequest of requests) {
        answerId = randomUUID();
        await prisma.message.create({ data: { chatId, content: textMessageContent("Answer"), id: answerId, parentMessageId: questionId,
          role: "assistant", status: "complete" } });
        await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: randomUUID(), modelId: "fake-qsa",
          normalizedRequest, provider: "fake", status: "complete", userId, userMessageId: questionId } });
      }
      questions.push(questionId);
      parentMessageId = answerId;
    }
    await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chatId } });

    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail?.messages.filter((message) => message.role === "user").map((message) => message.deepResearch ?? null))
      .toEqual([null, true, null]);
    expect(detail?.messages.some((message) => message.role === "assistant" && message.deepResearch)).toBe(false);

    // The wire carries the mark, and the browser decodes it back.
    const wire = decodeChatDetailResponse(JSON.parse(JSON.stringify({ chat: serializeChatDetail(detail!) })));
    expect(wire?.messages.find((message) => message.id === questions[1])?.deepResearch).toBe(true);
    expect(wire?.messages.find((message) => message.id === questions[0])?.deepResearch).toBeUndefined();
  } finally {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
