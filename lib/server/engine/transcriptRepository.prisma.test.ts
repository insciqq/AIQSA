import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createTranscriptRepository } from "./transcriptRepository";
import type { TranscriptItem } from "./transcript";

const owners: string[] = [];
const transcripts = createTranscriptRepository(prisma);

async function owner(): Promise<string> {
  const userId = `transcript-test-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: {
    displayName: "Transcript test user", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } }
  } });
  return userId;
}

async function chatWithRun(userId: string, engine: "native" | "v1" = "native", systemTurn = false) {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Transcript", userId } });
  const question = await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent("Synthetic question"), role: "user", status: "complete",
    ...(systemTurn ? { systemTurnKind: "mcp_approval_continuation" as const } : {})
  } });
  const answer = await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "complete"
  } });
  const run = await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, engine, modelId: "fake-qsa", provider: "fake", status: "complete",
    userId, userMessageId: question.id
  } });
  return { answerId: answer.id, chatId: chat.id, questionId: question.id, runId: run.id };
}

const origin = { model: "fake-qsa", provider: "fake" };
function turn(): TranscriptItem[] {
  return [
    { arguments: "{\"q\":1}", callId: "call_1", id: randomUUID(), kind: "tool_call", name: "lookup", origin },
    { callId: "call_1", id: randomUUID(), kind: "tool_result", name: "lookup", outcome: "complete", output: "found" },
    { id: randomUUID(), kind: "assistant_text", origin, text: "Done." }
  ];
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("native transcript repository", () => {
  it("appends a run's items in order and reads them back by run", async () => {
    const userId = await owner();
    const run = await chatWithRun(userId);
    const scope = { chatId: run.chatId, runId: run.runId, userId };
    const [call, result, answer] = turn();
    await expect(transcripts.nextSequence(scope)).resolves.toBe(0);
    await transcripts.append(scope, 0, [call!, result!]);
    await expect(transcripts.nextSequence(scope)).resolves.toBe(2);
    await transcripts.append(scope, 2, [answer!]);
    const loaded = await transcripts.loadRuns({ chatId: run.chatId, runIds: [run.runId], userId });
    expect(loaded.get(run.runId)).toEqual([call, result, answer]);
    // A taken sequence refuses the whole batch.
    await expect(transcripts.append(scope, 2, turn())).rejects.toThrow();
    await expect(transcripts.nextSequence(scope)).resolves.toBe(3);
  });

  it("never reads or writes another owner's or another chat's run", async () => {
    const userId = await owner();
    const strangerId = await owner();
    const run = await chatWithRun(userId);
    const other = await chatWithRun(userId);
    await transcripts.append({ chatId: run.chatId, runId: run.runId, userId }, 0, turn());
    await expect(transcripts.loadRuns({ chatId: run.chatId, runIds: [run.runId], userId: strangerId }))
      .resolves.toEqual(new Map([[run.runId, []]]));
    await expect(transcripts.loadRuns({ chatId: other.chatId, runIds: [run.runId], userId }))
      .resolves.toEqual(new Map([[run.runId, []]]));
    // The composite key refuses a row that names the run under another owner or chat.
    await expect(transcripts.append({ chatId: run.chatId, runId: run.runId, userId: strangerId }, 10, turn())).rejects.toThrow();
    await expect(transcripts.append({ chatId: other.chatId, runId: run.runId, userId }, 10, turn())).rejects.toThrow();
    await expect(prisma.runTranscriptItem.count({ where: { modelRunId: run.runId } })).resolves.toBe(3);
  });

  it("finds the native runs of answers and the approval turns they continued", async () => {
    const userId = await owner();
    const native = await chatWithRun(userId, "native", true);
    const oldCore = await chatWithRun(userId, "v1");
    await expect(transcripts.nativeRunsForAnswers({ assistantMessageIds: [native.answerId], chatId: native.chatId, userId }))
      .resolves.toEqual(new Map([[native.answerId, native.runId]]));
    await expect(transcripts.nativeRunsForAnswers({ assistantMessageIds: [oldCore.answerId], chatId: oldCore.chatId, userId }))
      .resolves.toEqual(new Map());
    await expect(transcripts.approvalContinuationTurns({ chatId: native.chatId, messageIds: [native.questionId] }))
      .resolves.toEqual(new Set([native.questionId]));
    await expect(transcripts.approvalContinuationTurns({ chatId: oldCore.chatId, messageIds: [oldCore.questionId] }))
      .resolves.toEqual(new Set());
  });

  it("goes with its run", async () => {
    const userId = await owner();
    const run = await chatWithRun(userId);
    await transcripts.append({ chatId: run.chatId, runId: run.runId, userId }, 0, turn());
    await prisma.modelRun.delete({ where: { id: run.runId } });
    await expect(prisma.runTranscriptItem.count({ where: { modelRunId: run.runId } })).resolves.toBe(0);
  });
});
