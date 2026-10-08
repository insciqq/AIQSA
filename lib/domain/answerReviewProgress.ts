import {
  ANSWER_REVIEW_AUTO_MAX_RUNS,
  type AnswerReviewMode,
  type AnswerReviewState,
  type AnswerReviewStepKind,
  type AnswerReviewStopReason,
  type AnswerReviewVerdict
} from "../contracts/answerReviews";

/**
 * What one step of a session did, from its settled messages: a review step's
 * first valid review card (its findings, and how many of them repeat a
 * finding the author rejected earlier), a revision step's decisions card, and
 * whether the step's answer ended with an MCP approval card still waiting for
 * the user. `running` covers a step whose answer is still preparing or streaming.
 */
export type AnswerReviewStepFacts = Readonly<{
  approvalPending?: true;
  decisions?: true;
  kind: AnswerReviewStepKind;
  review?: Readonly<{ findings: number; repeats?: number; verdict: AnswerReviewVerdict }>;
  round: number;
  status: "cancelled" | "complete" | "error" | "running";
  step: number;
}>;

/** The answer an automatic session reviews, as its message left it. */
export type AnswerReviewSourceFacts = Readonly<{
  approvalPending?: true;
  /** The answer generated images: no revision could carry them. */
  imageOutput?: true;
  status: "cancelled" | "complete" | "error" | "running";
}>;

export type AnswerReviewProgressInput = Readonly<{
  maxRounds: number | null;
  mode: AnswerReviewMode;
  /** The current round's reviewers. */
  reviewerCount: number;
  round: number;
  /** An automatic session's answer; until it completes no step starts. */
  source?: AnswerReviewSourceFacts;
  state: AnswerReviewState;
  steps: readonly AnswerReviewStepFacts[];
  stopReason: AnswerReviewStopReason | null;
}>;

export type AnswerReviewNextStep =
  | Readonly<{ kind: "review"; reviewer: number; round: number; step: number }>
  | Readonly<{ kind: "revision"; round: number; step: number }>;

export type AnswerReviewProgress = Readonly<{
  /** An automatic session waits for the answer it reviews. */
  awaitingAnswer: boolean;
  /**
   * The current round's reviews: settled readable ones, of how many, all
   * clean, findings in total and how many of them repeat a rejected finding.
   */
  reviews: Readonly<{ clean: boolean; done: number; findings: number; repeats: number; total: number }>;
  /** The current round's revision settled: a further round may start. */
  roundComplete: boolean;
  running: AnswerReviewStepFacts | null;
  /** The step that comes next while the session runs and no step is running. */
  next: AnswerReviewNextStep | null;
  /** The row is still running but its steps already ended the session: persist `state`/`stopReason`. */
  settle: boolean;
  state: AnswerReviewState;
  stopReason: AnswerReviewStopReason | null;
}>;

/**
 * The one reading of a session's progress, shared by the server (step start,
 * settlement, the automatic driver) and the transcript. A round runs its
 * reviewers in order (step = reviewer position), then the author's revision
 * (step = the round's reviewer count). A step that was stopped, failed, ended
 * with an approval card or, for a review, never reported its review ends the
 * session; reviews that all report no substantive issue finish it.
 *
 * An automatic session also starts only once its answer completed (one that
 * failed, was stopped, waits for an approval or generated images ends it),
 * runs its next round after each revision up to `maxRounds`, finishes with
 * `disagreement` when every finding of a round repeats one the author already
 * rejected, and never goes past its run ceiling (its answer and every step).
 */
export function answerReviewProgress(input: AnswerReviewProgressInput): AnswerReviewProgress {
  const steps = input.steps.filter((step) => step.round === input.round).sort((left, right) => left.step - right.step);
  const reviewSteps = steps.filter((step) => step.kind === "review" && step.status === "complete" && step.review);
  const total = input.reviewerCount;
  const done = reviewSteps.length;
  const findings = reviewSteps.reduce((sum, step) => sum + (step.review?.findings ?? 0), 0);
  const reviews = Object.freeze({
    clean: total > 0 && done >= total && reviewSteps.every((step) => step.review?.verdict === "clean"),
    done,
    findings,
    repeats: reviewSteps.reduce((sum, step) => sum + Math.min(step.review?.repeats ?? 0, step.review?.findings ?? 0), 0),
    total
  });
  const roundComplete = steps.some((step) => step.kind === "revision" && step.status === "complete");
  const auto = input.mode === "auto";
  const result = (fields: Partial<AnswerReviewProgress> & Pick<AnswerReviewProgress, "state" | "stopReason">): AnswerReviewProgress => ({
    awaitingAnswer: false, next: null, reviews, roundComplete, running: null, settle: false, ...fields
  });
  if (input.state !== "running") return result({ state: input.state, stopReason: input.stopReason });
  const ended = (state: AnswerReviewState, stopReason: AnswerReviewStopReason) => result({ settle: true, state, stopReason });
  // An automatic session never runs more than its answer and nine steps.
  const proceed = (next: AnswerReviewNextStep) => auto && 1 + input.steps.length >= ANSWER_REVIEW_AUTO_MAX_RUNS
    ? ended("finished", "max_rounds")
    : result({ next, state: "running", stopReason: null });
  const running = steps.find((step) => step.status === "running") ?? null;
  if (running) return result({ running, state: "running", stopReason: null });
  if (auto && input.source && input.steps.length === 0) {
    if (input.source.status === "running") return result({ awaitingAnswer: true, state: "running", stopReason: null });
    if (input.source.status === "cancelled") return ended("stopped", "user_stopped");
    if (input.source.status === "error") return ended("stopped", "error");
    if (input.source.approvalPending) return ended("stopped", "approval_required");
    if (input.source.imageOutput) return ended("stopped", "unsupported");
  }
  const last = steps.at(-1);
  if (last?.status === "cancelled") return ended("stopped", "user_stopped");
  if (last?.status === "error") return ended("stopped", "error");
  if (last?.approvalPending) return ended("stopped", "approval_required");
  if (last?.kind === "review" && !last.review) return ended("stopped", "review_unreadable");
  if (roundComplete) {
    if (auto && input.maxRounds !== null && input.round >= input.maxRounds) return ended("finished", "max_rounds");
    // A manual session waits for the user's next round; an automatic one starts it.
    return auto ? proceed({ kind: "review", reviewer: 0, round: input.round + 1, step: 0 })
      : result({ state: "running", stopReason: null });
  }
  if (total > 0 && done >= total) {
    if (reviews.clean) return ended("finished", "clean");
    // The reviewers only insist on what the author already rejected: both positions stand.
    if (auto && findings > 0 && reviews.repeats >= findings) return ended("finished", "disagreement");
    return proceed({ kind: "revision", round: input.round, step: total });
  }
  return proceed({ kind: "review", reviewer: done, round: input.round, step: done });
}
