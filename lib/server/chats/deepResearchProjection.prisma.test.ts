import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, expect, it } from "vitest";
import { decodeChatDetailResponse } from "../../contracts/chats";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
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
    const runs: string[] = [];
    // An ordinary turn; a turn sent with Deep research and answered again (a regenerate kept the choice before it was refused, so both
    // runs hold it); a turn whose request carries the field as anything but `true`; a Continue whose run picked research up (its frame);
    // the server's turn after an Allow in that research, failed; a Continue that failed before its own start; and an ordinary message after it.
    const turns: readonly Readonly<{ requests: readonly Prisma.InputJsonValue[]; status?: "complete" | "error"; systemTurnKind?: "mcp_approval_continuation";
      text?: string }>[] = [{ requests: [{}] }, { requests: [{ deepResearch: true }, { deepResearch: true }] }, { requests: [{ deepResearch: false }] },
      { requests: [{}], text: CONTINUE_TURN_TEXT }, { requests: [{}], status: "error", systemTurnKind: "mcp_approval_continuation" },
      { requests: [{}], status: "error", text: CONTINUE_TURN_TEXT }, { requests: [{}], status: "error" }];
    for (const turn of turns) {
      const questionId = randomUUID();
      await prisma.message.create({ data: { chatId, content: textMessageContent(turn.text ?? "Question"), id: questionId, parentMessageId,
        role: "user", status: "complete", ...turn.systemTurnKind ? { systemTurnKind: turn.systemTurnKind } : {} } });
      let answerId = questionId;
      for (const normalizedRequest of turn.requests) {
        answerId = randomUUID();
        await prisma.message.create({ data: { chatId, content: textMessageContent("Answer"), id: answerId, parentMessageId: questionId,
          role: "assistant", status: turn.status ?? "complete" } });
        const run = await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, engine: "native", id: randomUUID(), modelId: "fake-qsa",
          normalizedRequest, provider: "fake", status: turn.status ?? "complete", userId, userMessageId: questionId } });
        runs.push(run.id);
      }
      questions.push(questionId);
      parentMessageId = answerId;
    }
    // Only a research writes a frame row: the plan's window opens it, and a Continue that picks research up links it.
    await prisma.researchFrame.create({ data: { chatId, goal: "Synthetic goal", modelRunId: runs[4]!, userId } });
    await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chatId } });

    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail?.messages.filter((message) => message.role === "user").map((message) => message.deepResearch ?? null))
      .toEqual([null, true, null, null, null, null, null]);
    expect(detail?.messages.some((message) => message.role === "assistant" && message.deepResearch)).toBe(false);
    // The turn after the Allow and the Continue after it have no research of their own, yet are the research's; the ordinary message after it is not.
    expect(detail?.messages.filter((message) => message.role === "assistant").map((message) => message.researchAnswer ?? null))
      .toEqual([null, true, null, true, true, true, null]);
    expect(detail?.messages.some((message) => message.role === "user" && message.researchAnswer)).toBe(false);

    // The wire carries the mark, and the browser decodes it back.
    const wire = decodeChatDetailResponse(JSON.parse(JSON.stringify({ chat: serializeChatDetail(detail!) })));
    expect(wire?.messages.find((message) => message.id === questions[1])?.deepResearch).toBe(true);
    expect(wire?.messages.find((message) => message.id === questions[0])?.deepResearch).toBeUndefined();
    expect(wire?.messages.filter((message) => message.researchAnswer).map((message) => message.parentMessageId))
      .toEqual([questions[1], questions[3], questions[4], questions[5]]);
  } finally {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
