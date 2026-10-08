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

  it("keeps the durable conclusion of an ended session", () => {
    expect(answerReviewProgress(session({ state: "stopped", steps: [review()], stopReason: "budget" }))).toMatchObject({
      next: null, settle: false, state: "stopped", stopReason: "budget"
    });
  });
});
