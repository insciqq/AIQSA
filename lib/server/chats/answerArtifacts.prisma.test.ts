import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { decodeChatDetailResponse } from "../../contracts/chats";
import { createReasoningFragmentBuffer } from "../../domain/answerReasoning";
import { textMessageContent } from "../../domain/content";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import { serializeChatDetail } from "./handlers";
import { createPrismaChatRepository } from "./prismaRepository";

async function withAnswerUser<T>(run: (input: { providerModelId: string; userId: string }) => Promise<T>): Promise<T> {
  const userId = `answer-artifacts-${randomUUID()}`;
  const fakeModel = await prisma.providerModel.findUniqueOrThrow({
    select: { id: true },
    where: { templateKey: "fake:fake-qsa" }
  });
  await prisma.user.create({ data: {
    displayName: "Answer Artifacts User",
    id: userId,
    status: "active",
    settings: { create: {
      defaultControlValues: {},
      defaultProviderModelId: fakeModel.id,
      defaultSearchStrategyId: "search-disabled"
    } }
  } });
  await prisma.accessGrant.create({ data: { enabled: true, providerModelId: fakeModel.id, userId } });
  try {
    return await run({ providerModelId: fakeModel.id, userId });
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

async function answerTurn(input: Readonly<{
  chatId: string;
  parentMessageId: string | null;
  question: string;
  userId: string;
}>) {
  const user = await prisma.message.create({ data: {
    chatId: input.chatId, content: textMessageContent(input.question), parentMessageId: input.parentMessageId,
    role: "user", status: "complete"
  } });
  const assistant = await prisma.message.create({ data: {
    chatId: input.chatId, content: textMessageContent("Answer"), parentMessageId: user.id,
    role: "assistant", status: "complete"
  } });
  // Provider output is appended only while the run is live, as in production.
  const run = await prisma.modelRun.create({ data: {
    assistantMessageId: assistant.id, chatId: input.chatId, modelId: "fake-qsa", normalizedRequest: {},
    provider: "fake", status: "streaming", userId: input.userId, userMessageId: user.id
  } });
  return { assistantId: assistant.id, runId: run.id };
}

function reasoning(payload: unknown): ModelRunSseEvent {
  return { data: { artifactType: "reasoning", payload }, type: "artifact" };
}

function citation(round: number, index: number): ModelRunSseEvent {
  return {
    data: { artifactType: "citation", payload: {
      title: `Round ${round} source ${index}`, type: "url_citation", url: `https://round-${round}.example.test/${index}`
    } },
    type: "artifact"
  };
}

function search(sources: unknown[]): ModelRunSseEvent {
  return {
    data: { artifactType: "search", payload: { action: { sources, type: "search" }, id: "private-search-call" } },
    type: "artifact"
  };
}

describe("answer artifacts across storage and reload", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores merged thinking and multi-round citations once and reloads a decodable history", async () => {
    await withAnswerUser(async ({ providerModelId, userId }) => {
      const runs = createPrismaRunRepository(prisma);
      const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerModelId, title: "Long outputs", userId } });

      // Historical answer written before merging: one trimmed row per delta.
      const legacy = await answerTurn({ chatId: chat.id, parentMessageId: null, question: "Earlier", userId });
      const legacyDeltas = Array.from({ length: 101 }, (_, index) => `old delta ${index}`);
      await prisma.modelRunEvent.createMany({ data: legacyDeltas.map((text, sequence) => ({
        eventType: "artifact", modelRunId: legacy.runId, payload: { artifactType: "reasoning", payload: { text } }, sequence
      })) });
      await prisma.modelRun.update({ data: { status: "complete" }, where: { id: legacy.runId } });

      const current = await answerTurn({
        chatId: chat.id, parentMessageId: legacy.assistantId, question: "Current", userId
      });
      const deltas = Array.from({ length: 700 }, (_, index) =>
        index === 5 ? "NUL\u0000removed " : index % 70 === 69 ? `idea ${index} 思考😀.\n\n` : `idea ${index} 思考😀 `);
      const block = createReasoningFragmentBuffer();
      const longUrl = `https://long.example.test/${"p".repeat(600)}`;
      const roundOne: ModelRunSseEvent[] = [
        ...[...deltas.flatMap((delta) => block.append(delta)), ...block.finish()].map(reasoning),
        ...Array.from({ length: 130 }, (_, index) => citation(1, index % 110)),
        search([
          { type: "url", url: longUrl },
          { type: "url", url: `https://too-long.example.test/${"q".repeat(2_100)}` },
          { title: "Titled result", url: "https://titled.example.test/" }
        ])
      ];
      const roundTwo: ModelRunSseEvent[] = [
        reasoning({ id: "private-item", summary: [{ text: "**Round two**", type: "summary_text" }, { text: "Checked again.", type: "summary_text" }] }),
        ...Array.from({ length: 100 }, (_, index) => citation(2, index)),
        search(Array.from({ length: 20 }, (_, index) => ({ type: "url", url: `https://round-two.example.test/${index}` })))
      ];
      for (const event of [...roundOne, ...roundTwo]) {
        const projected = projectRunOutputArtifactEvent(event);
        if (projected) await runs.appendRunOutputEvent(current.runId, projected);
      }
      await prisma.modelRun.update({ data: { status: "complete" }, where: { id: current.runId } });
      await prisma.chat.update({ data: { activeLeafMessageId: current.assistantId }, where: { id: chat.id } });

      const storedReasoning = await prisma.modelRunEvent.count({ where: {
        modelRunId: current.runId, payload: { path: ["artifactType"], equals: "reasoning" }
      } });
      expect(storedReasoning).toBeLessThan(15);

      const detail = await createPrismaChatRepository(prisma).getChat({ chatId: chat.id, userId });
      expect(detail).not.toBeNull();
      const wire = JSON.parse(JSON.stringify({ chat: serializeChatDetail(detail!) })) as unknown;
      const decoded = decodeChatDetailResponse(wire);
      expect(decoded?.messages).toHaveLength(4);
      const [, oldAnswer, , answer] = decoded!.messages;

      expect(oldAnswer?.artifactSummary?.reasoningText).toEqual([legacyDeltas.join(" ")]);
      expect(answer?.artifactSummary?.reasoningText).toEqual([
        deltas.join("").replace("\u0000", "").trim(),
        "**Round two**\n\nChecked again."
      ]);
      expect(answer?.artifactSummary?.citations).toHaveLength(210);
      expect(answer?.artifactSummary?.sources).toHaveLength(22);
      expect(answer?.artifactSummary?.sources[0]).toMatchObject({ rank: 1, title: "long.example.test", url: longUrl });
      expect(answer?.artifactSummary?.sources.every((source) => source.url.length <= 2_048)).toBe(true);
      expect(answer?.artifactSummary).not.toHaveProperty("citationsTruncated");
      expect(answer?.artifactSummary).not.toHaveProperty("reasoningTruncated");
      expect(JSON.stringify(decoded)).not.toMatch(/private-item|private-search-call|url_citation/u);

      // The terminal chat update projects the same stored rows the same way.
      const update = await runs.getChatUpdateForRun({
        assistantMessageId: current.assistantId, chatId: chat.id, userId,
        userMessageId: answer!.parentMessageId!
      });
      const updated = update?.messages.find(({ id }) => id === current.assistantId)?.artifactSummary;
      expect(updated).toMatchObject({
        citations: answer?.artifactSummary?.citations,
        reasoningText: answer?.artifactSummary?.reasoningText,
        sources: answer?.artifactSummary?.sources
      });
    });
  });
});
