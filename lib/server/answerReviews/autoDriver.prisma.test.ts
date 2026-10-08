import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerReviewCard, AnswerReviewDecisionsCard } from "../../contracts/answerReviews";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AnswerReviewStepConflictError,
  type AnswerReviewAutoAdmission,
  type CreateRunInput,
  type CreatedRun
} from "../runs/runRepositoryContract";
import type { RunOutputArtifactEvent } from "../runs/runOutputEvents";
import { answerReviewOwnerAuth, createAnswerReviewDriver } from "./autoDriver";
import { loadAnswerReviewSessionSnapshot } from "./repository";
import {
  answerReviewSnapshotProgress,
  startAnswerReviewStep,
  type AnswerReviewStepStart,
  type AnswerReviewStepStartInput
} from "./stepStart";

/**
 * The automatic review driver on the disposable database: the session its
 * user's send creates, steps claimed once under racing triggers and across a
 * restart, the early clean finish, disagreement, the time limit, supersession
 * and Stop, each end handled once. A step's start here admits its turn through
 * the real admission transaction (the unique step claim) instead of the whole
 * send pipeline, and like the real start reads the claimed turn, not the
 * admission's outcome: these cases never dispatch to a provider.
 */

vi.mock("./stepStart", async (importOriginal) => ({
  ...await importOriginal<typeof import("./stepStart")>(),
  startAnswerReviewStep: vi.fn()
}));
const startStep = vi.mocked(startAnswerReviewStep);

const repository = createPrismaRunRepository(prisma);
const usage = { cachedInputTokens: 0, cacheWriteInputTokens: 0, completeness: "complete" as const, inputTokens: 1, outputTokens: 1,
  reasoningTokens: 0, totalTokens: 2 };
const reviewer = { modelId: "synthetic-reviewer-model", name: "Synthetic Reviewer", provider: "synthetic-reviewer-connection" };

function reviewEvent(card: AnswerReviewCard): RunOutputArtifactEvent {
  return { data: { artifactType: "answer_review", payload: card }, type: "artifact" } as RunOutputArtifactEvent;
}

function decisionsEvent(card: AnswerReviewDecisionsCard): RunOutputArtifactEvent {
  return { data: { artifactType: "answer_review_decisions", payload: card }, type: "artifact" } as RunOutputArtifactEvent;
}

const card = (round: number, overrides: Partial<AnswerReviewCard> = {}): AnswerReviewCard => ({
  findings: [{ claim: "It is 42.", id: "F1", problem: "It is 41.", severity: "high", suggestion: "Say 41." }], reviewer: 0,
  reviewerName: "Synthetic Reviewer", round, verdict: "changes_needed", version: 1, ...overrides
});

type Fixture = Readonly<{
  chatId: string;
  userId: string;
  /** The owner's send with automatic review on, as its admission freezes it. */
  ask(text: string, leaf: string | null, auto?: Partial<AnswerReviewAutoAdmission>): Promise<CreatedRun>;
  complete(run: CreatedRun, text: string, outputEvents?: RunOutputArtifactEvent[]): Promise<void>;
}>;

/** A personal chat of a synthetic owner on the fake deployment, removed afterwards. */
async function fixture<T>(execute: (fixture: Fixture) => Promise<T>): Promise<T> {
  const userId = `answer-review-auto-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic auto reviewer owner", id: userId, status: "active" } });
  try {
    await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled", userId } });
    await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Automatic review fixture", userId } });
    const plan = await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId });
    const send = (text: string, overrides: Partial<CreateRunInput>) => {
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
    startStep.mockImplementation(async (_deps, input: AnswerReviewStepStartInput): Promise<AnswerReviewStepStart> => {
      const refuse = (code: string): AnswerReviewStepStart => ({ code, ok: false, response: Response.json({ error: code }, { status: 409 }) });
      const snapshot = await loadAnswerReviewSessionSnapshot(prisma, input.sessionId);
      if (!snapshot || snapshot.session.userId !== input.userId) return refuse("answer_review_unavailable");
      const progress = answerReviewSnapshotProgress(snapshot);
      const next = progress.next;
      if (progress.state !== "running") return refuse("answer_review_ended");
      if (progress.running || !next || next.kind !== input.kind) return refuse("answer_review_step_unavailable");
      if (snapshot.lastMessageId !== input.expectedActiveLeafId) return refuse("active_leaf_changed");
      try {
        await send(next.kind === "review" ? "[Answer review request]" : "[Answer revision request] [R1.1.F1]", {
          answerReviewStep: { round: next.round, sessionId: input.sessionId, step: next.step },
          expectedActiveLeafId: input.expectedActiveLeafId,
          systemTurnKind: next.kind === "review" ? "answer_review_request" : "answer_revision_request"
        });
      } catch (error) {
        if (!(error instanceof AnswerReviewStepConflictError || error instanceof ActiveLeafConflictError
          || error instanceof ActiveRunConflictError)) throw error;
      }
      // As the real start does: the claimed turn, not the admission's outcome, says whether the step exists.
      const claimed = await prisma.message.findFirst({
        select: { id: true, userModelRuns: { orderBy: { createdAt: "desc" }, select: { assistantMessageId: true, id: true }, take: 1 } },
        where: { answerReviewRound: next.round, answerReviewSessionId: input.sessionId, answerReviewStep: next.step, role: "user" }
      });
      const run = claimed?.userModelRuns[0];
      return claimed && run?.assistantMessageId
        ? { assistantMessageId: run.assistantMessageId, ok: true, response: new Response("data: {}\n\n"), runId: run.id,
          userMessageId: claimed.id }
        : refuse("answer_review_step_unavailable");
    });
    return await execute({
      async ask(text, leaf, auto) {
        return send(text, {
          answerReviewAuto: {
            authorModel: { modelId: providerTemplateIds.fakeModel, name: "Fake QSA", provider: providerTemplateIds.fakeConnection },
            controls: { controls: { mcp: { mode: "off" } }, reviewerSearchPlans: [{ mode: "all_selected", optionIds: [] }], version: 1 },
            maxRounds: 3,
            reviewers: [reviewer],
            ...auto
          },
          defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
            searchPlan: { mode: "all_selected", optionIds: [] }, userId },
          expectedActiveLeafId: leaf
        });
      },
      chatId: chat.id,
      async complete(run, text, outputEvents = []) {
        expect(await repository.completeRun({ assistantMessageId: run.assistantMessageId, chatId: chat.id, estimatedCostMicros: 0,
          finalText: text, modelId: "fake-qsa", outputEvents, provider: "fake", runId: run.runId, usage, userId })).toBe(true);
      },
      userId
    });
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

/** A driver as one process runs it; the steps' send services are never reached through the stand-in start. */
function driver() {
  const notifyEnded = vi.fn();
  const stopRun = vi.fn(async () => "stopped");
  return {
    driver: createAnswerReviewDriver({
      notifyEnded,
      ownerAuth: (userId) => answerReviewOwnerAuth(prisma, userId),
      prisma,
      steps: () => ({ prisma, sendDeps: {} as never }),
      stopRun
    }),
    notifyEnded,
    stopRun
  };
}

type Driver = ReturnType<typeof driver>["driver"];

/** The reconciler's tick on every given driver at once, then their work settled. */
async function advance(...drivers: Driver[]) {
  await Promise.all(drivers.map((entry) => entry.tick()));
  await Promise.all(drivers.map((entry) => entry.idle()));
}

const sessionOf = (chatId: string) => prisma.answerReviewSession.findFirstOrThrow({ orderBy: { createdAt: "asc" }, where: { chatId } });
const turns = (sessionId: string) => prisma.message.findMany({ orderBy: [{ answerReviewRound: "asc" }, { answerReviewStep: "asc" }],
  select: { answerReviewRound: true, answerReviewStep: true, id: true, systemTurnKind: true },
  where: { answerReviewSessionId: sessionId, role: "user" } });
const lastStep = async (sessionId: string): Promise<CreatedRun> => {
  const turn = (await turns(sessionId)).at(-1)!;
  const run = await prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { userMessageId: turn.id } });
  return { assistantMessageId: run.assistantMessageId!, runId: run.id, userMessageId: turn.id };
};

beforeEach(() => { startStep.mockReset(); });
afterAll(() => prisma.$disconnect());

describe("automatic answer review driver", () => {
  it("creates the automatic session at the send's admission with its frozen choice and stores the chat's choice", async () =>
    fixture(async (f) => {
      const asked = await f.ask("What is the total of 12, 15 and 14?", null);
      expect(await sessionOf(f.chatId)).toMatchObject({
        authorModel: { modelId: providerTemplateIds.fakeModel, name: "Fake QSA" }, controls: { version: 1 }, endNotifiedAt: null,
        maxRounds: 3, mode: "auto", reviewers: [reviewer], round: 1, sourceAssistantMessageId: asked.assistantMessageId,
        state: "running", userId: f.userId
      });
      expect((await prisma.chat.findUniqueOrThrow({ where: { id: f.chatId } })).answerReviewConfig).toEqual({
        enabled: true, maxRounds: 3, reviewers: [{ modelId: reviewer.modelId, provider: reviewer.provider }]
      });
    }));

  it("waits for the answer, then starts each step once however many triggers race, also after a restart", async () =>
    fixture(async (f) => {
      const asked = await f.ask("What is the total of 12, 15 and 14?", null);
      const session = await sessionOf(f.chatId);
      const first = driver();
      const second = driver();
      // The answer is still being written: nothing starts.
      await advance(first.driver, second.driver);
      expect(await turns(session.id)).toEqual([]);

      await f.complete(asked, "The total is 42.");
      await advance(first.driver, second.driver, first.driver);
      expect((await turns(session.id)).map((turn) => [turn.answerReviewRound, turn.answerReviewStep])).toEqual([[1, 0]]);

      // The review settles; a fresh driver (a restarted process) resumes with the revision, once.
      await f.complete(await lastStep(session.id), "Review submitted: one finding.", [reviewEvent(card(1))]);
      const restarted = driver();
      await advance(restarted.driver, restarted.driver);
      await advance(restarted.driver, first.driver);
      expect((await turns(session.id)).map((turn) => [turn.answerReviewRound, turn.answerReviewStep, turn.systemTurnKind])).toEqual([
        [1, 0, "answer_review_request"], [1, 1, "answer_revision_request"]
      ]);
      expect(restarted.notifyEnded).not.toHaveBeenCalled();
    }));

  it("finishes clean after one review without a revision, and notifies once", async () => fixture(async (f) => {
    const asked = await f.ask("Summarize the plan", null);
    await f.complete(asked, "The plan has three steps.");
    const session = await sessionOf(f.chatId);
    const { driver: running, notifyEnded } = driver();
    await advance(running);
    await f.complete(await lastStep(session.id), "Review submitted: no substantive issues.",
      [reviewEvent(card(1, { findings: [], verdict: "clean" }))]);
    await advance(running);
    await advance(running);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ endNotifiedAt: expect.any(Date), state: "finished", stopReason: "clean" });
    expect(await turns(session.id)).toHaveLength(1);
    expect(notifyEnded).toHaveBeenCalledTimes(1);
    expect(notifyEnded).toHaveBeenCalledWith(expect.objectContaining({ chatId: f.chatId, rounds: 1, sessionId: session.id,
      state: "finished", stopReason: "clean", userId: f.userId }));
  }));

  it("runs the next round after a revision and ends with disagreement when the reviewer only repeats rejected findings", async () =>
    fixture(async (f) => {
      const asked = await f.ask("What is the total?", null);
      await f.complete(asked, "The total is 42.");
      const session = await sessionOf(f.chatId);
      const { driver: running, notifyEnded } = driver();
      await advance(running);
      await f.complete(await lastStep(session.id), "Review submitted: one finding.", [reviewEvent(card(1))]);
      await advance(running);
      await f.complete(await lastStep(session.id), "The total is 42, as computed.", [decisionsEvent({ decisions: [
        { decision: "rejected", findingId: "R1.1.F1", reason: "The sum is right." }], round: 1, version: 1 })]);
      await advance(running);
      expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
        .toMatchObject({ round: 2, state: "running" });
      expect((await turns(session.id)).at(-1)).toMatchObject({ answerReviewRound: 2, answerReviewStep: 0 });
      await f.complete(await lastStep(session.id), "Review submitted: one finding.", [reviewEvent(card(2, {
        findings: [{ claim: "It is 42.", id: "F1", problem: "It is 41.", repeatsFindingId: "R1.1.F1", severity: "high",
          suggestion: "Say 41." }] }))]);
      await advance(running);
      expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
        .toMatchObject({ state: "finished", stopReason: "disagreement" });
      expect(await turns(session.id)).toHaveLength(3);
      expect(notifyEnded).toHaveBeenCalledTimes(1);
    }));

  it("ends at the round limit with the latest version as the session's answer", async () => fixture(async (f) => {
    const asked = await f.ask("What is the total?", null, { maxRounds: 1 });
    await f.complete(asked, "The total is 42.");
    const session = await sessionOf(f.chatId);
    const { driver: running, notifyEnded } = driver();
    await advance(running);
    await f.complete(await lastStep(session.id), "Review submitted: one finding.", [reviewEvent(card(1))]);
    await advance(running);
    const revision = await lastStep(session.id);
    await f.complete(revision, "The total is 41.");
    await advance(running);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ endNotifiedAt: expect.any(Date), state: "finished", stopReason: "max_rounds" });
    expect((await loadAnswerReviewSessionSnapshot(prisma, session.id))?.latestVersionId).toBe(revision.assistantMessageId);
    expect(notifyEnded).toHaveBeenCalledWith(expect.objectContaining({ rounds: 1, stopReason: "max_rounds" }));
  }));

  it("stops at the time limit and stops the running step with it", async () => fixture(async (f) => {
    const asked = await f.ask("What is the total?", null);
    await f.complete(asked, "The total is 42.");
    const session = await sessionOf(f.chatId);
    const { driver: running, notifyEnded, stopRun } = driver();
    await advance(running);
    const step = await lastStep(session.id);
    await prisma.answerReviewSession.update({ data: { createdAt: new Date(Date.now() - 31 * 60_000) }, where: { id: session.id } });
    await advance(running);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ state: "stopped", stopReason: "time_limit" });
    expect(stopRun).toHaveBeenCalledWith(expect.objectContaining({ code: "answer_review_time_limit", runId: step.runId,
      userId: f.userId }));
    expect(notifyEnded).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "time_limit" }));
  }));

  it("is superseded by a later send and notifies nothing", async () => fixture(async (f) => {
    const asked = await f.ask("What is the total?", null);
    await f.complete(asked, "The total is 42.");
    const session = await sessionOf(f.chatId);
    const { driver: running, notifyEnded } = driver();
    // The user asks something else before the review starts: the new answer gets a session of its own.
    const later = await f.ask("Something else", asked.assistantMessageId);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ state: "stopped", stopReason: "superseded" });
    expect(await prisma.answerReviewSession.count({ where: { chatId: f.chatId, sourceAssistantMessageId: later.assistantMessageId } }))
      .toBe(1);
    await advance(running);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ endNotifiedAt: expect.any(Date) });
    expect(await turns(session.id)).toEqual([]);
    expect(notifyEnded).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
  }));

  it("stops a session for its initiator only, between steps too, without a notification", async () => fixture(async (f) => {
    const asked = await f.ask("What is the total?", null);
    await f.complete(asked, "The total is 42.");
    const session = await sessionOf(f.chatId);
    const { driver: running, notifyEnded, stopRun } = driver();
    expect(await running.stop({ sessionId: session.id, userId: `someone-else-${randomUUID()}` })).toBeNull();
    const stopped = await running.stop({ sessionId: session.id, userId: f.userId });
    await running.idle();
    expect(stopped?.session).toMatchObject({ state: "stopped", stopReason: "user_stopped" });
    expect(stopRun).not.toHaveBeenCalled();
    await advance(running);
    expect(await turns(session.id)).toEqual([]);
    expect(await prisma.answerReviewSession.findUniqueOrThrow({ where: { id: session.id } }))
      .toMatchObject({ endNotifiedAt: expect.any(Date) });
    expect(notifyEnded).not.toHaveBeenCalled();
  }));
});
