import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { decodeChatDetailResponse } from "../../contracts/chats";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { serializeChatDetail } from "./handlers";
import { createPrismaChatRepository } from "./prismaRepository";

afterAll(() => prisma.$disconnect());

it("marks only the user messages one of whose runs was admitted with Deep research, and the answers whose runs researched", async () => {
  const userId = randomUUID();
  const chatId = randomUUID();
  await prisma.user.create({ data: { displayName: "Deep research projection test", id: userId, status: "active" } });
  try {
    await prisma.chat.create({ data: { id: chatId, title: "Synthetic research", userId } });
    let parentMessageId: string | null = null;
    const questions: string[] = [];
    // An ordinary turn, a turn sent with Deep research and answered again (a regenerate kept the choice before it was refused, so both
    // runs hold it), a turn whose request carries the field as anything but `true`, and a Continue whose run picked research up.
    const continued: string[] = [];
    for (const requests of [[{}], [{ deepResearch: true }, { deepResearch: true }], [{ deepResearch: false }], [{}]] as const) {
      const questionId = randomUUID();
      await prisma.message.create({ data: { chatId, content: textMessageContent("Question"), id: questionId, parentMessageId,
        role: "user", status: "complete" } });
      let answerId = questionId;
      for (const normalizedRequest of requests) {
        answerId = randomUUID();
        await prisma.message.create({ data: { chatId, content: textMessageContent("Answer"), id: answerId, parentMessageId: questionId,
          role: "assistant", status: "complete" } });
        const run = await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: randomUUID(), modelId: "fake-qsa",
          normalizedRequest, provider: "fake", status: "complete", userId, userMessageId: questionId } });
        if (questions.length === 3) continued.push(run.id);
      }
      questions.push(questionId);
      parentMessageId = answerId;
    }
    // Only a research writes a frame row: the plan's window opens it, and a Continue that picks research up links it.
    await prisma.researchFrame.create({ data: { chatId, goal: "Synthetic goal", modelRunId: continued[0]!, userId } });
    await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chatId } });

    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail?.messages.filter((message) => message.role === "user").map((message) => message.deepResearch ?? null))
      .toEqual([null, true, null, null]);
    expect(detail?.messages.some((message) => message.role === "assistant" && message.deepResearch)).toBe(false);
    expect(detail?.messages.filter((message) => message.role === "assistant").map((message) => message.researchAnswer ?? null))
      .toEqual([null, true, null, true]);
    expect(detail?.messages.some((message) => message.role === "user" && message.researchAnswer)).toBe(false);

    // The wire carries the mark, and the browser decodes it back.
    const wire = decodeChatDetailResponse(JSON.parse(JSON.stringify({ chat: serializeChatDetail(detail!) })));
    expect(wire?.messages.find((message) => message.id === questions[1])?.deepResearch).toBe(true);
    expect(wire?.messages.find((message) => message.id === questions[0])?.deepResearch).toBeUndefined();
    expect(wire?.messages.filter((message) => message.researchAnswer).map((message) => message.parentMessageId)).toEqual([questions[1], questions[3]]);
  } finally {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
