import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_REVIEW_AUTO_MAX_MS } from "../../contracts/answerReviews";
import type { AnswerReviewSessionSnapshot, AnswerReviewStepRecord } from "./repository";
import type { AnswerReviewStepStart, AnswerReviewStepStartInput } from "./stepStart";

const repository = vi.hoisted(() => ({
  load: vi.fn(),
  settle: vi.fn()
}));
const steps = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock("./repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("./repository")>(),
  loadAnswerReviewSessionSnapshot: repository.load,
  settleAnswerReviewSession: repository.settle
}));
vi.mock("./stepStart", async (importOriginal) => ({
  ...await importOriginal<typeof import("./stepStart")>(),
  startAnswerReviewStep: steps.start
}));

const {
  answerReviewDriverDecision,
  answerReviewOwnerAuth,
  answerReviewStepAdmissionId,
  createAnswerReviewDriver
} = await import("./autoDriver");

const NOW = Date.UTC(2026, 9, 8, 12);
const author = { modelId: "model-a", name: "Claude", provider: "connection-a" };
const reviewer = { modelId: "model-b", name: "GPT-5", provider: "connection-b" };
const second = { modelId: "model-c", name: "Gemini", provider: "connection-c" };

function snapshot(overrides: Omit<Partial<AnswerReviewSessionSnapshot>, "session"> & {
  session?: Partial<AnswerReviewSessionSnapshot["session"]>;
} = {}):
  AnswerReviewSessionSnapshot {
  const { session, ...rest } = overrides;
  const steps = rest.steps ?? [];
  const last = steps.at(-1);
  const lastMessageId = rest.lastMessageId ?? (last ? last.answerId ?? last.turnId : "answer-1");
  return {
    chat: { activeLeafMessageId: lastMessageId, assistantId: null, projectId: null },
    lastMessageId,
    latestVersionId: "answer-1",
    source: { runId: "run-answer", runTerminal: true, status: "complete" },
    steps,
    ...rest,
    session: {
      authorModel: author, chatId: "chat-1", createdAt: new Date(NOW - 60_000), id: "session-1", maxRounds: 3, mode: "auto",
      reviewers: [reviewer], round: 1, sourceAssistantMessageId: "answer-1", state: "running", stopReason: null, userId: "user-1",
      ...session
    }
  };
}

function review(overrides: Partial<AnswerReviewStepRecord> = {}): AnswerReviewStepRecord {
  const round = overrides.round ?? 1;
  const step = overrides.step ?? 0;
  return {
    answerId: `review-${round}-${step}`, kind: "review", review: { findings: 1, repeats: 0, verdict: "changes_needed" },
    reviewer: step, round, runId: `run-review-${round}-${step}`, runTerminal: true, status: "complete", step,
    turnId: `review-turn-${round}-${step}`, ...overrides
  };
}

function revision(overrides: Partial<AnswerReviewStepRecord> = {}): AnswerReviewStepRecord {
  const round = overrides.round ?? 1;
  return {
    answerId: `revision-${round}`, decisions: true, kind: "revision", round, runId: `run-revision-${round}`, runTerminal: true,
    status: "complete", step: overrides.step ?? 1, turnId: `revision-turn-${round}`, ...overrides
  };
}

const now = new Date(NOW);

describe("automatic review decisions", () => {
  it("waits for the answer under review, past the time limit too, then starts the first review", () => {
    expect(answerReviewDriverDecision(snapshot({ source: { runId: "run-answer", runTerminal: false, status: "running" },
      session: { createdAt: new Date(NOW - ANSWER_REVIEW_AUTO_MAX_MS - 1) } }), now)).toEqual({ kind: "wait" });
    expect(answerReviewDriverDecision(snapshot(), now))
      .toEqual({ kind: "start", next: { kind: "review", reviewer: 0, round: 1, step: 0 } });
  });

  it("waits until the last run's Workspace settled before the next step", () => {
    expect(answerReviewDriverDecision(snapshot({ source: { runId: "run-answer", runTerminal: false, status: "complete" } }), now))
      .toEqual({ kind: "wait" });
    expect(answerReviewDriverDecision(snapshot({ steps: [review({ runTerminal: false })] }), now)).toEqual({ kind: "wait" });
  });

  it("ends the session when its answer failed, was stopped, waits for an approval or generated images", () => {
    for (const [source, stopReason] of [
      [{ runId: "run-answer", runTerminal: true, status: "error" }, "error"],
      [{ runId: "run-answer", runTerminal: true, status: "cancelled" }, "user_stopped"],
      [{ approvalPending: true, runId: "run-answer", runTerminal: true, status: "complete" }, "approval_required"],
      [{ imageOutput: true, runId: "run-answer", runTerminal: true, status: "complete" }, "unsupported"]
    ] as const) {
      expect(answerReviewDriverDecision(snapshot({ source }), now), stopReason).toEqual({ kind: "settle", state: "stopped", stopReason });
    }
  });

  it("runs the reviewers in order, then the revision, and finishes clean early", () => {
    const two = { reviewers: [reviewer, second] };
    expect(answerReviewDriverDecision(snapshot({ session: two, steps: [review()] }), now))
      .toEqual({ kind: "start", next: { kind: "review", reviewer: 1, round: 1, step: 1 } });
    expect(answerReviewDriverDecision(snapshot({ session: two, steps: [review(), review({ step: 1 })] }), now))
      .toEqual({ kind: "start", next: { kind: "revision", round: 1, step: 2 } });
    const clean = review({ review: { findings: 0, repeats: 0, verdict: "clean" } });
    expect(answerReviewDriverDecision(snapshot({ steps: [clean] }), now))
      .toEqual({ kind: "settle", state: "finished", stopReason: "clean" });
  });

  it("starts the next round after a revision and finishes after the last", () => {
    const round1 = [review(), revision()];
    expect(answerReviewDriverDecision(snapshot({ steps: round1 }), now))
      .toEqual({ kind: "start", next: { kind: "review", reviewer: 0, round: 2, step: 0 } });
    expect(answerReviewDriverDecision(snapshot({ session: { maxRounds: 1 }, steps: round1 }), now))
      .toEqual({ kind: "settle", state: "finished", stopReason: "max_rounds" });
  });

  it("finishes with disagreement when every finding of a round repeats one the author rejected", () => {
    const steps = [review(), revision(), review({ review: { findings: 2, repeats: 2, verdict: "changes_needed" }, round: 2 })];
    expect(answerReviewDriverDecision(snapshot({ session: { round: 2 }, steps }), now))
      .toEqual({ kind: "settle", state: "finished", stopReason: "disagreement" });
    // One new finding is still worth a revision.
    const mixed = [review(), revision(), review({ review: { findings: 2, repeats: 1, verdict: "changes_needed" }, round: 2 })];
    expect(answerReviewDriverDecision(snapshot({ session: { round: 2 }, steps: mixed }), now))
      .toEqual({ kind: "start", next: { kind: "revision", round: 2, step: 1 } });
  });

  it("stops at the time limit, stopping a running step but never the answer", () => {
    const late = { createdAt: new Date(NOW - ANSWER_REVIEW_AUTO_MAX_MS) };
    expect(answerReviewDriverDecision(snapshot({ session: late, steps: [review({ review: undefined, runTerminal: false,
      status: "running" })] }), now))
      .toEqual({ kind: "settle", state: "stopped", stopReason: "time_limit", stopRunId: "run-review-1-0" });
    expect(answerReviewDriverDecision(snapshot({ session: late }), now))
      .toEqual({ kind: "settle", state: "stopped", stopReason: "time_limit" });
  });

  it("is superseded when the chat's path moved away from its last message", () => {
    const moved = snapshot({ steps: [review()] });
    expect(answerReviewDriverDecision({ ...moved, chat: { ...moved.chat, activeLeafMessageId: "elsewhere" } }, now))
      .toEqual({ kind: "settle", state: "stopped", stopReason: "superseded" });
  });

  it("never drives a manual session or one that ended", () => {
    expect(answerReviewDriverDecision(snapshot({ session: { maxRounds: null, mode: "manual" } }), now)).toEqual({ kind: "wait" });
    expect(answerReviewDriverDecision(snapshot({ session: { state: "finished", stopReason: "clean" } }), now))
      .toEqual({ kind: "wait" });
  });

  it("names a step's send identically on every retry, and every step differently", () => {
    const id = answerReviewStepAdmissionId("session-1", { round: 1, step: 0 });
    expect(id).toMatch(/^answer-review-[0-9a-f]{40}$/u);
    expect(answerReviewStepAdmissionId("session-1", { round: 1, step: 0 })).toBe(id);
    expect(answerReviewStepAdmissionId("session-1", { round: 1, step: 1 })).not.toBe(id);
    expect(answerReviewStepAdmissionId("session-2", { round: 1, step: 0 })).not.toBe(id);
  });
});

type SessionRow = { controls: unknown; endNotifiedAt: Date | null; round: number; state: string };

function harness(input: Readonly<{ row?: Partial<SessionRow>; runs?: Record<string, unknown> }> = {}) {
  const row: SessionRow = {
    controls: { controls: { mcp: { mode: "off" }, searchPlan: { mode: "all_selected", optionIds: ["author-search"] },
      timeZone: "Europe/Berlin" }, reviewerSearchPlans: [{ mode: "all_selected", optionIds: ["reviewer-search"] }], version: 1 },
    endNotifiedAt: null, round: 1, state: "running", ...input.row
  };
  const prisma = {
    answerReviewSession: {
      findMany: vi.fn(async () => [{ id: "session-1" }]),
      findUnique: vi.fn(async () => ({ controls: row.controls })),
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        if (where.round !== undefined && where.round !== row.round) return { count: 0 };
        if (where.endNotifiedAt === null && row.endNotifiedAt !== null) return { count: 0 };
        if (where.state === "running" && row.state !== "running") return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      })
    },
    modelRun: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => input.runs?.[where.id] ?? null) },
    user: { findUnique: vi.fn(async () => ({ displayName: "Owner", email: null, id: "user-1", role: "USER", status: "active" })) }
  } as unknown as PrismaClient;
  const notifyEnded = vi.fn();
  const stopRun = vi.fn(async () => "stopped");
  const driver = createAnswerReviewDriver({
    now: () => new Date(NOW),
    notifyEnded,
    ownerAuth: (userId) => answerReviewOwnerAuth(prisma, userId),
    prisma,
    steps: () => ({ prisma, sendDeps: {} as never }),
    stopRun
  });
  return { driver, notifyEnded, prisma, row, stopRun };
}

function started(runId = "run-step"): AnswerReviewStepStart {
  return { assistantMessageId: "step-answer", ok: true, response: new Response("data: {}\n\n"), runId, userMessageId: "step-turn" };
}

function refused(code: string, status = 409): AnswerReviewStepStart {
  return { code, ok: false, response: Response.json({ error: code }, { status }) };
}

beforeEach(() => {
  repository.load.mockReset();
  repository.settle.mockReset().mockResolvedValue(true);
  steps.start.mockReset();
});

describe("automatic review driver", () => {
  it("starts the next step as the initiator with the frozen controls and the reviewer's own Search", async () => {
    const { driver } = harness();
    repository.load.mockResolvedValue(snapshot());
    steps.start.mockResolvedValue(started());
    driver.kick("session-1");
    await driver.idle();
    expect(steps.start).toHaveBeenCalledTimes(1);
    const [, request] = steps.start.mock.calls[0] as [unknown, AnswerReviewStepStartInput];
    expect(request).toMatchObject({
      admissionId: answerReviewStepAdmissionId("session-1", { round: 1, step: 0 }),
      controls: { mcp: { mode: "off" }, searchPlan: { mode: "all_selected", optionIds: ["reviewer-search"] }, timeZone: "Europe/Berlin" },
      expectedActiveLeafId: "answer-1",
      expectedMode: "auto",
      kind: "review",
      sessionId: "session-1",
      userId: "user-1"
    });
    // The initiator is resolved again for the send, while active.
    expect(await request.resolveAuth(new Request("http://localhost/"))).toMatchObject({ userId: "user-1" });
  });

  it("gives the author's revision the send's own Search", async () => {
    const { driver } = harness();
    repository.load.mockResolvedValue(snapshot({ steps: [review()] }));
    steps.start.mockResolvedValue(started());
    driver.kick("session-1");
    await driver.idle();
    const [, request] = steps.start.mock.calls[0] as [unknown, AnswerReviewStepStartInput];
    expect(request).toMatchObject({ controls: { searchPlan: { optionIds: ["author-search"] } }, kind: "revision" });
  });

  it("moves to the next round once, guarded by the round it read, before that round's first review", async () => {
    const { driver, row } = harness();
    const round1 = [review(), revision()];
    repository.load.mockImplementation(async () => snapshot({ session: { round: row.round }, steps: round1 }));
    steps.start.mockResolvedValue(started());
    driver.kick("session-1");
    await driver.idle();
    expect(row.round).toBe(2);
    expect(steps.start).toHaveBeenCalledTimes(1);
    expect(steps.start.mock.calls[0]?.[1]).toMatchObject({ kind: "review" });
  });

  it("handles a session's end once: one notification, whatever settled it", async () => {
    const { driver, notifyEnded, row } = harness({ row: { state: "finished" } });
    const ended = snapshot({ session: { state: "finished", stopReason: "clean" }, steps: [review({ review: { findings: 0, repeats: 0,
      verdict: "clean" } })] });
    repository.load.mockResolvedValue(ended);
    driver.kick("session-1");
    await driver.idle();
    driver.kick("session-1");
    await driver.idle();
    expect(notifyEnded).toHaveBeenCalledTimes(1);
    expect(notifyEnded).toHaveBeenCalledWith({ answerFailed: false, chatId: "chat-1", lastRunId: "run-review-1-0", rounds: 1,
      sessionId: "session-1", state: "finished", stopReason: "clean", userId: "user-1" });
    expect(row.endNotifiedAt).toEqual(new Date(NOW));
  });

  it("settles what the steps concluded, then notifies", async () => {
    const { driver, notifyEnded, row } = harness();
    let state: "running" | "stopped" = "running";
    repository.load.mockImplementation(async () => snapshot({ session: state === "running" ? {} : { state, stopReason: "error" },
      source: { runId: "run-answer", runTerminal: true, status: "error" } }));
    repository.settle.mockImplementation(async () => {
      state = "stopped";
      row.state = "stopped";
      return true;
    });
    driver.kick("session-1");
    await driver.idle();
    expect(repository.settle).toHaveBeenCalledWith(expect.anything(), { sessionId: "session-1", state: "stopped", stopReason: "error" });
    expect(notifyEnded).toHaveBeenCalledWith(expect.objectContaining({ answerFailed: true, stopReason: "error" }));
  });

  it("notifies nothing when the user stopped the review or the chat moved on", async () => {
    for (const stopReason of ["user_stopped", "superseded"] as const) {
      const { driver, notifyEnded } = harness({ row: { state: "stopped" } });
      repository.load.mockResolvedValue(snapshot({ session: { state: "stopped", stopReason } }));
      driver.kick("session-1");
      await driver.idle();
      expect(notifyEnded, stopReason).not.toHaveBeenCalled();
    }
  });

  it("waits on a transient refusal and ends on any other", async () => {
    const waiting = harness();
    repository.load.mockResolvedValue(snapshot());
    steps.start.mockResolvedValue(refused("active_run_in_progress"));
    waiting.driver.kick("session-1");
    await waiting.driver.idle();
    expect(repository.settle).not.toHaveBeenCalled();

    const failing = harness();
    steps.start.mockResolvedValue(refused("search_strategy_not_available"));
    failing.driver.kick("session-1");
    await failing.driver.idle();
    expect(repository.settle).toHaveBeenCalledWith(expect.anything(), { sessionId: "session-1", state: "stopped", stopReason: "error" });
  });

  it("supersedes a session whose chat moved before the step could start", async () => {
    const { driver } = harness();
    repository.load.mockResolvedValue(snapshot());
    steps.start.mockResolvedValue(refused("active_leaf_changed"));
    driver.kick("session-1");
    await driver.idle();
    expect(repository.settle).toHaveBeenCalledWith(expect.anything(), { sessionId: "session-1", state: "stopped",
      stopReason: "superseded" });
  });

  it("stops a running step at the time limit, after the session ended", async () => {
    const { driver, stopRun } = harness();
    const running = review({ review: undefined, runTerminal: false, status: "running" });
    repository.load.mockResolvedValueOnce(snapshot({ session: { createdAt: new Date(NOW - ANSWER_REVIEW_AUTO_MAX_MS) },
      steps: [running] })).mockResolvedValue(snapshot({ session: { state: "stopped", stopReason: "time_limit" }, steps: [running] }));
    driver.kick("session-1");
    await driver.idle();
    expect(repository.settle).toHaveBeenCalledWith(expect.anything(), { sessionId: "session-1", state: "stopped",
      stopReason: "time_limit" });
    expect(stopRun).toHaveBeenCalledWith(expect.objectContaining({ code: "answer_review_time_limit", runId: "run-review-1-0",
      userId: "user-1" }));
  });

  it("ends an automatic session whose chat is gone", async () => {
    const { driver, prisma } = harness();
    repository.load.mockResolvedValue(null);
    driver.kick("session-1");
    await driver.idle();
    expect(prisma.answerReviewSession.updateMany).toHaveBeenCalledWith({
      data: { state: "stopped", stopReason: "superseded" }, where: { id: "session-1", mode: "auto", state: "running" }
    });
  });

  it("moves the session of a settled run on: a step's answer or the answer under review", async () => {
    const { driver } = harness({ runs: {
      "run-answer": { assistantMessage: { answerReviewSession: null, answerReviewSources: [{ id: "session-1" }] } },
      "run-other": { assistantMessage: { answerReviewSession: { id: "manual", mode: "manual" }, answerReviewSources: [] } },
      "run-step": { assistantMessage: { answerReviewSession: { id: "session-1", mode: "auto" }, answerReviewSources: [] } }
    } });
    repository.load.mockResolvedValue(snapshot({ steps: [review({ review: undefined, runTerminal: false, status: "running" })] }));
    for (const runId of ["run-answer", "run-step", "run-other", "run-missing"]) await driver.onRunSettled(runId);
    await driver.idle();
    const loaded = repository.load.mock.calls.map((call) => call[1]);
    expect(loaded).toContain("session-1");
    expect(loaded).not.toContain("manual");
  });

  it("stops a session for its initiator only, and its running step with it", async () => {
    const { driver, stopRun } = harness();
    const running = review({ review: undefined, runTerminal: false, status: "running" });
    repository.load.mockResolvedValue(snapshot({ steps: [running] }));
    expect(await driver.stop({ sessionId: "session-1", userId: "someone-else" })).toBeNull();
    expect(repository.settle).not.toHaveBeenCalled();
    await driver.stop({ sessionId: "session-1", userId: "user-1" });
    expect(repository.settle).toHaveBeenCalledWith(expect.anything(), { sessionId: "session-1", state: "stopped",
      stopReason: "user_stopped" });
    expect(stopRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-review-1-0", userId: "user-1" }));
    await driver.idle();
  });

  it("reconciles every running automatic session and every unhandled end", async () => {
    const { driver, prisma } = harness();
    repository.load.mockResolvedValue(snapshot({ steps: [review({ review: undefined, runTerminal: false, status: "running" })] }));
    await driver.tick();
    await driver.idle();
    expect(prisma.answerReviewSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { mode: "auto", OR: [{ state: "running" }, { endNotifiedAt: null, state: { not: "running" } }] }
    }));
    expect(repository.load).toHaveBeenCalledWith(prisma, "session-1");
  });
});
