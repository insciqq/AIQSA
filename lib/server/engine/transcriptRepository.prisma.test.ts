import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
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
  // Only a preparing run lacks its normalized request (ModelRun_memory_request_shape_check).
  const run = await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, engine, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
    status: "complete", userId, userMessageId: question.id
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
    // Repeating a batch that committed (its outcome was lost) succeeds without a second copy.
    await expect(transcripts.append(scope, 2, [answer!])).resolves.toBeUndefined();
    await expect(prisma.runTranscriptItem.count({ where: { modelRunId: run.runId } })).resolves.toBe(3);
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

  // Regression (codex review): an old-core write reached its server and the upgrade retired its run; the native guard must
  // still find that unknown effect through the answer's branch, though the answer stopped without text.
  it("finds the unknown calls of an old-core run retirement ended on the branch, and only there", async () => {
    const userId = await owner();
    const strangerId = await owner();
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Old core", userId } });
    const message = (role: "assistant" | "user", parentMessageId?: string) => prisma.message.create({ data: {
      chatId: chat.id, content: textMessageContent(role === "user" ? "Synthetic question" : ""), role,
      status: role === "user" ? "complete" : "streaming", ...(parentMessageId ? { parentMessageId } : {}) } });
    const oldRun = async (questionId: string, answerId: string) => prisma.modelRun.create({ data: {
      assistantMessageId: answerId, chatId: chat.id, engine: "v1", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
      status: "streaming", userId, userMessageId: questionId } });
    const call = (modelRunId: string, ordinal: number, state: "cancelled" | "complete" | "running", summary: string,
      toolName = "mcp_jira_create_issue") => prisma.modelRunToolCall.create({ data: {
      arguments: { summary }, modelRunId, ordinal, providerCallId: `call-${ordinal}`, roundIndex: 0, startedAt: new Date(), state,
      toolName, ...(state === "running" ? {} : { completedAt: new Date(), result: { callId: `call-${ordinal}`, content: [],
        name: toolName, status: "complete" } }) } });

    const question = await message("user");
    const answer = await message("assistant", question.id);
    const run = await oldRun(question.id, answer.id);
    const done = await call(run.id, 0, "complete", "earlier");
    const sent = await call(run.id, 1, "running", "x");
    // Another tool's completed call settles nothing here.
    await call(run.id, 2, "complete", "read", "mcp_jira_get_issue");
    await call(run.id, 3, "cancelled", "never sent");
    // The upgrade retires the run (`endRetiredEngineRuns`' own settlement, here only for this test's runs): its running
    // call keeps an unknown outcome. A chat holds one active run at a time, so the sibling below starts after it.
    const runs = createPrismaRunRepository(prisma);
    await runs.failRun(run.id, answer.id, RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });
    // A sibling answer to the same question, which the branch does not follow.
    const sibling = await message("assistant", question.id);
    const siblingRun = await oldRun(question.id, sibling.id);
    await call(siblingRun.id, 0, "running", "sibling");
    await runs.failRun(siblingRun.id, sibling.id, RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });
    await expect(prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: sent.id } })).resolves.toMatchObject({ state: "error" });
    // Continue: the answer stopped without text, so the context leaves it out; the next turn still follows it.
    const next = await message("user", answer.id);

    const expected = [{ assistantMessageId: answer.id, userMessageId: question.id, items: [
      { arguments: "{\"summary\":\"earlier\"}", callId: `retired-${done.id}`, id: `retired-${done.id}-call`, kind: "tool_call",
        name: "mcp_jira_create_issue" },
      { callId: `retired-${done.id}`, id: `retired-${done.id}-result`, kind: "tool_result", name: "mcp_jira_create_issue",
        outcome: "complete", output: "" },
      { arguments: "{\"summary\":\"x\"}", callId: `retired-${sent.id}`, id: `retired-${sent.id}-call`, kind: "tool_call",
        name: "mcp_jira_create_issue" },
      { callId: `retired-${sent.id}`, id: `retired-${sent.id}-result`, kind: "tool_result", name: "mcp_jira_create_issue",
        outcome: "unknown", output: "" }
    ] }];
    await expect(transcripts.retiredRunEffects({ assistantMessageIds: [], chatId: chat.id, userId,
      userMessageIds: [question.id, next.id] })).resolves.toEqual(expected);
    await expect(transcripts.retiredRunEffects({ assistantMessageIds: [answer.id], chatId: chat.id, userId,
      userMessageIds: [question.id] })).resolves.toEqual(expected);
    // Off the branch, for another owner or in another chat: nothing.
    await expect(transcripts.retiredRunEffects({ assistantMessageIds: [], chatId: chat.id, userId, userMessageIds: [question.id] }))
      .resolves.toEqual([]);
    await expect(transcripts.retiredRunEffects({ assistantMessageIds: [answer.id], chatId: chat.id, userId: strangerId,
      userMessageIds: [next.id] })).resolves.toEqual([]);
    const other = await chatWithRun(userId);
    await expect(transcripts.retiredRunEffects({ assistantMessageIds: [answer.id], chatId: other.chatId, userId,
      userMessageIds: [next.id] })).resolves.toEqual([]);
  });

  // Regression: a native run interrupted before any text left an answer the context drops; the next turn still follows it.
  it("finds a stopped native answer through the branch turn that follows it, and only there", async () => {
    const userId = await owner();
    const strangerId = await owner();
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Stopped", userId } });
    const message = (role: "assistant" | "user", parentMessageId?: string, status: "cancelled" | "complete" | "error" = "complete") =>
      prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(role === "user" ? "Synthetic question" : ""), role,
        status, ...(parentMessageId ? { parentMessageId } : {}) } });
    const run = (questionId: string, answerId: string, engine: "native" | "v1" = "native") => prisma.modelRun.create({ data: {
      assistantMessageId: answerId, chatId: chat.id, engine, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
      status: "error", userId, userMessageId: questionId } });

    const question = await message("user");
    const stopped = await message("assistant", question.id, "error");
    const stoppedRun = await run(question.id, stopped.id);
    const next = await message("user", stopped.id);
    // A sibling answer that stopped too, followed by a turn the branch does not take.
    const sibling = await message("assistant", question.id, "cancelled");
    await run(question.id, sibling.id);
    const siblingNext = await message("user", sibling.id);
    // A complete answer stays in the context by itself; an old-core answer is never the native engine's.
    const complete = await message("assistant", next.id);
    await run(next.id, complete.id);
    const afterComplete = await message("user", complete.id);
    const oldStopped = await message("assistant", afterComplete.id, "error");
    await run(afterComplete.id, oldStopped.id, "v1");
    const afterOld = await message("user", oldStopped.id);

    const branch = [question.id, next.id, afterComplete.id, afterOld.id];
    await expect(transcripts.nativeRunsBeforeTurns({ chatId: chat.id, userId, userMessageIds: branch }))
      .resolves.toEqual([{ assistantMessageId: stopped.id, nextUserMessageId: next.id, runId: stoppedRun.id }]);
    await expect(transcripts.nativeRunsBeforeTurns({ chatId: chat.id, userId, userMessageIds: [question.id, siblingNext.id] }))
      .resolves.toEqual([expect.objectContaining({ assistantMessageId: sibling.id, nextUserMessageId: siblingNext.id })]);
    // Off the branch, for another owner or in another chat: nothing.
    await expect(transcripts.nativeRunsBeforeTurns({ chatId: chat.id, userId, userMessageIds: [question.id] })).resolves.toEqual([]);
    await expect(transcripts.nativeRunsBeforeTurns({ chatId: chat.id, userId: strangerId, userMessageIds: branch }))
      .resolves.toEqual([]);
    const other = await chatWithRun(userId);
    await expect(transcripts.nativeRunsBeforeTurns({ chatId: other.chatId, userId, userMessageIds: branch })).resolves.toEqual([]);
  });

  // Regression: a follow-up after a stopped step of an answer review recorded before the feature's removal hangs from it.
  it("marks a stopped step of a recorded answer review, and a revision copy under one, as a review step", async () => {
    const userId = await owner();
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Reviewed", userId } });
    const message = (role: "assistant" | "user", parentMessageId: string | null, extra: Partial<Prisma.MessageUncheckedCreateInput> = {}) =>
      prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(role === "user" ? "Synthetic question" : ""), role,
        status: "complete", ...(parentMessageId ? { parentMessageId } : {}), ...extra } });
    const run = (questionId: string, answerId: string) => prisma.modelRun.create({ data: { assistantMessageId: answerId,
      chatId: chat.id, engine: "native", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "error", userId,
      userMessageId: questionId } });
    const question = await message("user", null);
    const answer = await message("assistant", question.id);
    const session = await prisma.answerReviewSession.create({ data: { authorModel: { modelId: "fake-qsa", name: "Fake QSA",
      provider: "fake" }, chatId: chat.id, mode: "manual", reviewers: [{ modelId: "fixture-reviewer", name: "Reviewer",
      provider: "fake" }], sourceAssistantMessageId: answer.id, userId } });
    const reviewTurn = await message("user", answer.id, { answerReviewRound: 1, answerReviewSessionId: session.id,
      answerReviewStep: 0, systemTurnKind: "answer_review_request" });
    const review = await message("assistant", reviewTurn.id, { answerReviewSessionId: session.id, status: "cancelled" });
    const reviewRun = await run(reviewTurn.id, review.id);
    const afterReview = await message("user", review.id);
    const revisionTurn = await message("user", review.id, { answerReviewRound: 1, answerReviewSessionId: session.id,
      answerReviewStep: 1, systemTurnKind: "answer_revision_request" });
    // The previous release's regeneration of a version: a copy under the revision request without its session.
    const copy = await message("assistant", revisionTurn.id, { status: "error" });
    const copyRun = await run(revisionTurn.id, copy.id);
    const afterCopy = await message("user", copy.id);

    await expect(transcripts.nativeRunsBeforeTurns({ chatId: chat.id, userId, userMessageIds: [question.id, afterReview.id,
      afterCopy.id] })).resolves.toEqual([
      { assistantMessageId: review.id, nextUserMessageId: afterReview.id, reviewStep: true, runId: reviewRun.id },
      { assistantMessageId: copy.id, nextUserMessageId: afterCopy.id, reviewStep: true, runId: copyRun.id }
    ]);
  });

  it("goes with its run", async () => {
    const userId = await owner();
    const run = await chatWithRun(userId);
    await transcripts.append({ chatId: run.chatId, runId: run.runId, userId }, 0, turn());
    await prisma.modelRun.delete({ where: { id: run.runId } });
    await expect(prisma.runTranscriptItem.count({ where: { modelRunId: run.runId } })).resolves.toBe(0);
  });
});
