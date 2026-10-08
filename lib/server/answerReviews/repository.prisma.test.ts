import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AnswerReviewCard } from "../../contracts/answerReviews";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan, type ProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { AnswerReviewStepConflictError, type CreateRunInput, type CreatedRun } from "../runs/runRepositoryContract";
import type { RunOutputArtifactEvent } from "../runs/runOutputEvents";
import { loadAnswerReviewProjection, loadAnswerReviewSessionSnapshot } from "./repository";
import { startAnswerReviewRound, type AnswerReviewServiceDeps } from "./service";
import { answerReviewSnapshotProgress, reconcileAnswerReviewSession } from "./stepStart";

/**
 * Answer review storage on the disposable database: sessions, the step claim
 * on a server-written turn, admission without message-window rows,
 * supersession by ordinary runs, the context collapse later runs read and
 * the deletion cascade. Provider admission is a stand-in: these cases never
 * dispatch to a provider.
 */

const repository = createPrismaRunRepository(prisma);
const cancelPayload = { code: "model_run_cancelled", message: "Model run cancelled" };
const reviewer = { modelId: "synthetic-reviewer-model", provider: "synthetic-reviewer-connection" };
const usage = { cachedInputTokens: 0, cacheWriteInputTokens: 0, completeness: "complete" as const, inputTokens: 1, outputTokens: 1,
  reasoningTokens: 0, totalTokens: 2 };

/** Admits any model: tool calling and display names as a catalog would report them. */
const providerAdmission: AnswerReviewServiceDeps["providerAdmission"] = {
  load: vi.fn(async (input) => ({
    answer: {
      modelConfiguration: { capabilities: { toolCalling: input.providerModelId !== "no-tools-model" } },
      snapshot: { modelDisplayName: input.providerModelId === providerTemplateIds.fakeModel ? "Fake QSA" : "Synthetic Reviewer" }
    }
  }) as unknown as ProviderAdmissionPlan)
};
const serviceDeps: AnswerReviewServiceDeps = { prisma, providerAdmission };

function reviewEvent(card: AnswerReviewCard): RunOutputArtifactEvent {
  return { data: { artifactType: "answer_review", payload: card }, type: "artifact" } as RunOutputArtifactEvent;
}

type Send = Partial<CreateRunInput> & Readonly<{ expectedActiveLeafId: string | null; text: string }>;
type Fixture = Readonly<{
  chatId: string;
  userId: string;
  complete(run: CreatedRun, text: string, outputEvents?: RunOutputArtifactEvent[]): Promise<void>;
  /** An ordinary send of the owner, answered with `answer`. */
  exchange(text: string, expectedActiveLeafId: string | null, answer: string): Promise<CreatedRun>;
  send(input: Send): Promise<CreatedRun>;
  /** A session step's run: its server-written turn claiming (round, step). */
  step(input: Readonly<{ kind: "review" | "revision"; leaf: string; round?: number; sessionId: string; step: number }>): Promise<CreatedRun>;
}>;

/** A personal chat of a synthetic owner on the fake deployment, removed afterwards. */
async function fixture<T>(execute: (fixture: Fixture) => Promise<T>): Promise<T> {
  const userId = `answer-review-owner-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic reviewer owner", id: userId, status: "active" } });
  try {
    await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled", userId } });
    await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Answer review fixture", userId } });
    const plan = await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId });
    const send = async ({ text, ...overrides }: Send) => {
      const content = textMessageContent(text);
      return repository.createRun({
        chatId: chat.id, content, modelId: "fake-qsa", provider: "fake", providerAdmissionPlan: plan, providerRequestPreview: {}, userId,
        normalizedRequest: { attachmentIds: [], chatId: chat.id, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [],
          version: 1 }, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true,
          vision: false }, modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
          searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto" },
        ...overrides
      } as CreateRunInput);
    };
    const complete = async (run: CreatedRun, text: string, outputEvents: RunOutputArtifactEvent[] = []) => {
      expect(await repository.completeRun({ assistantMessageId: run.assistantMessageId, chatId: chat.id, estimatedCostMicros: 0,
        finalText: text, modelId: "fake-qsa", outputEvents, provider: "fake", runId: run.runId, usage, userId })).toBe(true);
    };
    return await execute({
      chatId: chat.id,
      complete,
      async exchange(text, expectedActiveLeafId, answer) {
        const run = await send({ defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel,
          provider: providerTemplateIds.fakeConnection, searchPlan: { mode: "all_selected", optionIds: [] }, userId },
        expectedActiveLeafId, text });
        await complete(run, answer);
        return run;
      },
      send,
      step({ kind, leaf, round = 1, sessionId, step }) {
        return send({
          answerReviewStep: { round, sessionId, step },
          expectedActiveLeafId: leaf,
          systemTurnKind: kind === "review" ? "answer_review_request" : "answer_revision_request",
          text: kind === "review" ? "[Answer review request — written by AIQSA]" : "[Answer revision request — written by AIQSA] [R1.1.F1]"
        });
      },
      userId
    });
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

async function startSession(f: Fixture, answerId: string) {
  const started = await startAnswerReviewRound(serviceDeps, { answerMessageId: answerId, chatId: f.chatId,
    expectedActiveLeafId: answerId, reviewers: [reviewer], userId: f.userId });
  if (!started.ok) throw new Error(`answer review fixture refused: ${started.code}`);
  return started.session;
}

const findingsCard: AnswerReviewCard = { findings: [{ claim: "It is 42.", id: "F1", problem: "It is 41.", severity: "high",
  suggestion: "Say 41." }], reviewer: 0, reviewerName: "Synthetic Reviewer", round: 1, verdict: "changes_needed", version: 1 };

describe("answer review storage", () => {
  afterAll(() => prisma.$disconnect());

  it("starts a manual session on the chat's latest answer with frozen display names, once per answer", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    expect(session).toMatchObject({
      authorModel: { modelId: providerTemplateIds.fakeModel, name: "Fake QSA", provider: providerTemplateIds.fakeConnection },
      maxRounds: null, mode: "manual", reviewers: [{ ...reviewer, name: "Synthetic Reviewer" }], round: 1,
      sourceAssistantMessageId: first.assistantMessageId, state: "running", stopReason: null, userId: f.userId
    });
    // Starting again before any step reuses the session and its round.
    expect(await startSession(f, first.assistantMessageId)).toMatchObject({ id: session.id, round: 1 });
    expect(await prisma.answerReviewSession.count({ where: { chatId: f.chatId } })).toBe(1);
    // The author's own model never reviews, and a model without tools cannot.
    for (const reviewers of [[{ modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection }],
      [{ modelId: "no-tools-model", provider: "synthetic-reviewer-connection" }]]) {
      await expect(startAnswerReviewRound(serviceDeps, { answerMessageId: first.assistantMessageId, chatId: f.chatId,
        expectedActiveLeafId: first.assistantMessageId, reviewers, userId: f.userId }))
        .resolves.toMatchObject({ code: "answer_review_reviewer_unavailable", ok: false });
    }
  }));

  it("refuses an answer that is no longer the latest and another user's chat", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const second = await f.exchange("And the average?", first.assistantMessageId, "The average is 7.");
    await expect(startAnswerReviewRound(serviceDeps, { answerMessageId: first.assistantMessageId, chatId: f.chatId,
      expectedActiveLeafId: second.assistantMessageId, reviewers: [reviewer], userId: f.userId }))
      .resolves.toMatchObject({ code: "answer_review_not_latest", ok: false });
    await expect(startAnswerReviewRound(serviceDeps, { answerMessageId: second.assistantMessageId, chatId: f.chatId,
      expectedActiveLeafId: second.assistantMessageId, reviewers: [reviewer], userId: `someone-else-${randomUUID()}` }))
      .resolves.toMatchObject({ code: "answer_review_unavailable", ok: false, status: 404 });
  }));

  it("admits a step as the server's turn without a message-window row or saved defaults, and claims it once", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    const windowRows = await prisma.usageMessageAdmission.count({ where: { userId: f.userId } });
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: f.userId } });
    const review = await f.step({ kind: "review", leaf: first.assistantMessageId, sessionId: session.id, step: 0 });

    expect(await prisma.usageMessageAdmission.count({ where: { userId: f.userId } })).toBe(windowRows);
    expect(await prisma.userSettings.findUniqueOrThrow({ where: { userId: f.userId } })).toEqual(settings);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: review.userMessageId } })).toMatchObject({
      answerReviewRound: 1, answerReviewSessionId: session.id, answerReviewStep: 0, parentMessageId: first.assistantMessageId,
      role: "user", systemTurnKind: "answer_review_request"
    });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: review.assistantMessageId } })).toMatchObject({
      answerReviewRound: null, answerReviewSessionId: session.id, answerReviewStep: null, role: "assistant"
    });

    // A retried or restarted start of the same step never writes a second turn.
    await repository.cancelRun({ payload: cancelPayload, runId: review.runId, userId: f.userId });
    await expect(f.step({ kind: "review", leaf: review.assistantMessageId, sessionId: session.id, step: 0 }))
      .rejects.toMatchObject({ code: "answer_review_step_unavailable", name: "AnswerReviewStepConflictError" });
    expect(await prisma.message.count({ where: { answerReviewSessionId: session.id, role: "user" } })).toBe(1);
    // The stopped step ends the session at the next read.
    expect(await reconcileAnswerReviewSession(prisma, session.id)).toMatchObject({ state: "stopped", stopReason: "user_stopped" });
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ state: "stopped", stopReason: "user_stopped" });
  }));

  it("reads a session's steps with their cards and keeps its first conclusion", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    const review = await f.step({ kind: "review", leaf: first.assistantMessageId, sessionId: session.id, step: 0 });
    await f.complete(review, "Review submitted: no substantive issues.", [reviewEvent({ ...findingsCard, findings: [],
      verdict: "clean" })]);

    const snapshot = await loadAnswerReviewSessionSnapshot(prisma, session.id);
    expect(snapshot).toMatchObject({ lastMessageId: review.assistantMessageId, latestVersionId: first.assistantMessageId,
      steps: [{ answerId: review.assistantMessageId, kind: "review", review: { findings: 0, verdict: "clean" }, round: 1,
        status: "complete", step: 0, turnId: review.userMessageId }] });
    expect(answerReviewSnapshotProgress(snapshot!)).toMatchObject({ settle: true, state: "finished", stopReason: "clean" });
    await reconcileAnswerReviewSession(prisma, session.id);
    await reconcileAnswerReviewSession(prisma, session.id);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ state: "finished", stopReason: "clean" });

    // The transcript projects the session onto its source answer and the step's messages.
    const projection = await loadAnswerReviewProjection(prisma, { chatId: f.chatId, messages: [
      { answerReviewRound: null, answerReviewSessionId: null, answerReviewStep: null, id: first.assistantMessageId,
        parentMessageId: first.userMessageId, role: "assistant", systemTurnKind: null },
      { answerReviewRound: 1, answerReviewSessionId: session.id, answerReviewStep: 0, id: review.userMessageId,
        parentMessageId: first.assistantMessageId, role: "user", systemTurnKind: "answer_review_request" },
      { answerReviewRound: null, answerReviewSessionId: session.id, answerReviewStep: null, id: review.assistantMessageId,
        parentMessageId: review.userMessageId, role: "assistant", stepModelName: "Synthetic Reviewer", systemTurnKind: null }
    ], viewerUserId: f.userId });
    expect(projection.get(first.assistantMessageId)?.session).toMatchObject({ canAct: true, id: session.id, state: "finished" });
    expect(projection.get(review.userMessageId)?.step).toEqual({ kind: "review", reviewer: 0, round: 1, step: 0 });
    expect(projection.get(review.assistantMessageId)?.step).toEqual({ kind: "review", modelName: "Synthetic Reviewer", reviewer: 0,
      round: 1, step: 0 });
    // Another viewer (a Project member) sees the session without its actions.
    const other = await loadAnswerReviewProjection(prisma, { chatId: f.chatId, messages: [{ answerReviewRound: null,
      answerReviewSessionId: null, answerReviewStep: null, id: first.assistantMessageId, parentMessageId: first.userMessageId,
      role: "assistant", systemTurnKind: null }], viewerUserId: "another-member" });
    expect(other.get(first.assistantMessageId)?.session).not.toHaveProperty("canAct");
  }));

  it("lets an ordinary send supersede the chat's running sessions, whose later steps are refused", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    const later = await f.exchange("Something else entirely", first.assistantMessageId, "Sure.");
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ state: "stopped", stopReason: "superseded" });
    await expect(f.step({ kind: "review", leaf: later.assistantMessageId, sessionId: session.id, step: 0 }))
      .rejects.toBeInstanceOf(AnswerReviewStepConflictError);
    await expect(f.step({ kind: "review", leaf: later.assistantMessageId, sessionId: session.id, step: 0 }))
      .rejects.toMatchObject({ code: "answer_review_ended" });
  }));

  it("gives a later run the question and the latest version only, and a step of the session its whole chain", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    const review = await f.step({ kind: "review", leaf: first.assistantMessageId, sessionId: session.id, step: 0 });
    await f.complete(review, "Review submitted: one finding.", [reviewEvent(findingsCard)]);
    const revision = await f.step({ kind: "revision", leaf: review.assistantMessageId, sessionId: session.id, step: 1 });
    await f.complete(revision, "The total is 41.");

    const later = await repository.loadConversationContextForExpectedLeaf(f.chatId, f.userId, revision.assistantMessageId);
    expect(later?.map((message) => message.id)).toEqual([first.userMessageId, revision.assistantMessageId]);
    const own = await repository.loadConversationContextForExpectedLeaf(f.chatId, f.userId, revision.assistantMessageId,
      { answerReviewSessionId: session.id });
    expect(own?.map((message) => message.id)).toEqual([first.userMessageId, first.assistantMessageId, review.userMessageId,
      review.assistantMessageId, revision.userMessageId, revision.assistantMessageId]);
    // The next question follows the latest version in the model's context too.
    const next = await f.exchange("Thanks, and the median?", revision.assistantMessageId, "The median is 6.");
    expect((await repository.loadConversationContextForLeaf(f.chatId, f.userId, next.userMessageId))
      .map((message) => message.id)).toEqual([first.userMessageId, revision.assistantMessageId, next.userMessageId]);
  }));

  it("keeps a step turn's round when its session is deleted, so the chat's cascades succeed in any order", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    const review = await f.step({ kind: "review", leaf: first.assistantMessageId, sessionId: session.id, step: 0 });
    await f.complete(review, "Review submitted: one finding.", [reviewEvent(findingsCard)]);
    await prisma.answerReviewSession.delete({ where: { id: session.id } });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: review.userMessageId } }))
      .toMatchObject({ answerReviewRound: 1, answerReviewSessionId: null, answerReviewStep: 0, systemTurnKind: "answer_review_request" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: review.assistantMessageId } }))
      .toMatchObject({ answerReviewSessionId: null });
  }));

  it("deletes a chat with a running session and its steps", async () => fixture(async (f) => {
    const first = await f.exchange("What is the total?", null, "The total is 42.");
    const session = await startSession(f, first.assistantMessageId);
    const review = await f.step({ kind: "review", leaf: first.assistantMessageId, sessionId: session.id, step: 0 });
    await f.complete(review, "Review submitted: one finding.", [reviewEvent(findingsCard)]);
    await prisma.modelRun.deleteMany({ where: { chatId: f.chatId } });
    await prisma.chat.delete({ where: { id: f.chatId } });
    expect(await prisma.answerReviewSession.count({ where: { id: session.id } })).toBe(0);
    expect(await prisma.message.count({ where: { id: { in: [review.userMessageId, review.assistantMessageId] } } })).toBe(0);
  }));
});
