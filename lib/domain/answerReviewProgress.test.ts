import { describe, expect, it } from "vitest";
import { answerReviewProgress, type AnswerReviewProgressInput, type AnswerReviewStepFacts } from "./answerReviewProgress";

const session = (overrides: Partial<AnswerReviewProgressInput> = {}): AnswerReviewProgressInput => ({
  maxRounds: null, mode: "manual", reviewerCount: 1, round: 1, state: "running", steps: [], stopReason: null, ...overrides
});
const review = (overrides: Partial<AnswerReviewStepFacts> = {}): AnswerReviewStepFacts => ({
  kind: "review", review: { findings: 1, verdict: "changes_needed" }, round: 1, status: "complete", step: 0, ...overrides
});
const revision = (overrides: Partial<AnswerReviewStepFacts> = {}): AnswerReviewStepFacts => ({
  decisions: true, kind: "revision", round: 1, status: "complete", step: 1, ...overrides
});

describe("answer review progress", () => {
  it("starts a round with its first reviewer", () => {
    expect(answerReviewProgress(session())).toMatchObject({
      next: { kind: "review", reviewer: 0, round: 1, step: 0 }, settle: false, state: "running"
    });
  });

  it("runs the round's reviewers in order before the revision", () => {
    const first = review();
    expect(answerReviewProgress(session({ reviewerCount: 2, steps: [first] })).next)
      .toEqual({ kind: "review", reviewer: 1, round: 1, step: 1 });
    expect(answerReviewProgress(session({ reviewerCount: 2, steps: [first, review({ step: 1 })] })).next)
      .toEqual({ kind: "revision", round: 1, step: 2 });
  });

  it("finishes clean when every reviewer of the round reports no substantive issue", () => {
    const clean = review({ review: { findings: 0, verdict: "clean" } });
    expect(answerReviewProgress(session({ steps: [clean] }))).toMatchObject({
      next: null, settle: true, state: "finished", stopReason: "clean"
    });
    // One reviewer with findings is enough for a revision.
    expect(answerReviewProgress(session({ reviewerCount: 2, steps: [clean, review({ step: 1 })] })).next)
      .toMatchObject({ kind: "revision" });
  });

  it("shows a running step and offers nothing next", () => {
    const progress = answerReviewProgress(session({ steps: [review({ review: undefined, status: "running" })] }));
    expect(progress).toMatchObject({ next: null, running: { kind: "review" }, settle: false, state: "running" });
  });

  it("ends the session when its last step was stopped, failed, gated or unreadable", () => {
    for (const [step, stopReason] of [
      [review({ status: "cancelled" }), "user_stopped"],
      [review({ status: "error" }), "error"],
      [review({ approvalPending: true }), "approval_required"],
      [review({ review: undefined }), "review_unreadable"],
      [revision({ status: "cancelled" }), "user_stopped"]
    ] as const) {
      const steps = step.kind === "revision" ? [review(), step] : [step];
      expect(answerReviewProgress(session({ steps })), stopReason).toMatchObject({ settle: true, state: "stopped", stopReason });
    }
  });

  it("keeps a manual session open after its revision for a further round", () => {
    expect(answerReviewProgress(session({ steps: [review(), revision()] }))).toMatchObject({
      next: null, roundComplete: true, settle: false, state: "running"
    });
  });

  it("reads only the current round", () => {
    const earlier = [review(), revision()];
    expect(answerReviewProgress(session({ round: 2, steps: earlier })).next).toEqual({ kind: "review", reviewer: 0, round: 2, step: 0 });
  });

  it("lets an automatic session start its next round or finish at its last", () => {
    const steps = [review(), revision()];
    expect(answerReviewProgress(session({ maxRounds: 3, mode: "auto", steps })).next)
      .toEqual({ kind: "review", reviewer: 0, round: 2, step: 0 });
    expect(answerReviewProgress(session({ maxRounds: 1, mode: "auto", steps }))).toMatchObject({
      settle: true, state: "finished", stopReason: "max_rounds"
    });
  });

  it("waits for an automatic session's answer and ends the session when the answer cannot be reviewed", () => {
    const auto = (source: AnswerReviewProgressInput["source"]) => answerReviewProgress(session({ maxRounds: 3, mode: "auto", source }));
    expect(auto({ status: "running" })).toMatchObject({ awaitingAnswer: true, next: null, settle: false, state: "running" });
    expect(auto({ status: "complete" })).toMatchObject({ awaitingAnswer: false, next: { kind: "review", reviewer: 0, round: 1 } });
    expect(auto({ status: "cancelled" })).toMatchObject({ settle: true, state: "stopped", stopReason: "user_stopped" });
    expect(auto({ status: "error" })).toMatchObject({ settle: true, state: "stopped", stopReason: "error" });
    expect(auto({ approvalPending: true, status: "complete" })).toMatchObject({ stopReason: "approval_required" });
    expect(auto({ imageOutput: true, status: "complete" })).toMatchObject({ state: "stopped", stopReason: "unsupported" });
    // Once a step ran, the answer completed: its facts no longer matter.
    expect(answerReviewProgress(session({ maxRounds: 3, mode: "auto", source: { status: "error" }, steps: [review()] })).next)
      .toMatchObject({ kind: "revision" });
    // A manual session never waits for its (finished) answer.
    expect(answerReviewProgress(session({ source: { status: "running" } })).awaitingAnswer).toBe(false);
  });

  it("finishes an automatic round with disagreement when every finding repeats one the author rejected", () => {
    const auto = (reviews: readonly AnswerReviewStepFacts[], mode: "auto" | "manual" = "auto") => answerReviewProgress(session({
      maxRounds: mode === "auto" ? 3 : null, mode, reviewerCount: reviews.length, round: 2,
      steps: [review(), revision(), ...reviews]
    }));
    const repeating = review({ review: { findings: 2, repeats: 2, verdict: "changes_needed" }, round: 2 });
    expect(auto([repeating])).toMatchObject({ reviews: { findings: 2, repeats: 2 }, settle: true, state: "finished",
      stopReason: "disagreement" });
    // A new finding from either reviewer still earns a revision.
    expect(auto([repeating, review({ review: { findings: 1, repeats: 0, verdict: "changes_needed" }, round: 2, step: 1 })]).next)
      .toEqual({ kind: "revision", round: 2, step: 2 });
    // A manual session leaves that judgment to the user.
    expect(auto([repeating], "manual").next).toEqual({ kind: "revision", round: 2, step: 1 });
  });

  it("never lets an automatic session run past its answer and nine steps", () => {
    const steps: AnswerReviewStepFacts[] = [];
    for (let round = 1; round <= 3; round += 1) {
      steps.push(review({ round }), review({ round, step: 1 }), revision({ round, step: 2 }));
    }
    // Three full rounds of two reviewers end at the last round.
    expect(answerReviewProgress(session({ maxRounds: 3, mode: "auto", reviewerCount: 2, round: 3, steps }))).toMatchObject({
      state: "finished", stopReason: "max_rounds"
    });
    // Should the steps ever exceed the ceiling, no further step starts.
    expect(answerReviewProgress(session({ maxRounds: 3, mode: "auto", reviewerCount: 2, round: 3, steps: steps.slice(0, 8)
      .concat(review({ round: 3, step: 1 })) }))).toMatchObject({ next: null, state: "finished", stopReason: "max_rounds" });
  });

  it("keeps the durable conclusion of an ended session", () => {
    expect(answerReviewProgress(session({ state: "stopped", steps: [review()], stopReason: "budget" }))).toMatchObject({
      next: null, settle: false, state: "stopped", stopReason: "budget"
    });
  });
});
