import type {
  AnswerReviewMode,
  AnswerReviewState,
  AnswerReviewStepKind,
  AnswerReviewStopReason,
  AnswerReviewVerdict
} from "../contracts/answerReviews";

/**
 * What one step of a session did, from its settled messages: a review step's
 * first valid review card, a revision step's decisions card, and whether the
 * step's answer ended with an MCP approval card still waiting for the user.
 * `running` covers a step whose answer is still preparing or streaming.
 */
export type AnswerReviewStepFacts = Readonly<{
  approvalPending?: true;
  decisions?: true;
  kind: AnswerReviewStepKind;
  review?: Readonly<{ findings: number; verdict: AnswerReviewVerdict }>;
  round: number;
  status: "cancelled" | "complete" | "error" | "running";
  step: number;
}>;

export type AnswerReviewProgressInput = Readonly<{
  maxRounds: number | null;
  mode: AnswerReviewMode;
  /** The current round's reviewers. */
  reviewerCount: number;
  round: number;
  state: AnswerReviewState;
  steps: readonly AnswerReviewStepFacts[];
  stopReason: AnswerReviewStopReason | null;
}>;

export type AnswerReviewNextStep =
  | Readonly<{ kind: "review"; reviewer: number; round: number; step: number }>
  | Readonly<{ kind: "revision"; round: number; step: number }>;

export type AnswerReviewProgress = Readonly<{
  /** The current round's reviews: settled readable ones, of how many, all clean, findings in total. */
  reviews: Readonly<{ clean: boolean; done: number; findings: number; total: number }>;
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
 */
export function answerReviewProgress(input: AnswerReviewProgressInput): AnswerReviewProgress {
  const steps = input.steps.filter((step) => step.round === input.round).sort((left, right) => left.step - right.step);
  const reviewSteps = steps.filter((step) => step.kind === "review" && step.status === "complete" && step.review);
  const total = input.reviewerCount;
  const done = reviewSteps.length;
  const reviews = Object.freeze({
    clean: total > 0 && done >= total && reviewSteps.every((step) => step.review?.verdict === "clean"),
    done,
    findings: reviewSteps.reduce((sum, step) => sum + (step.review?.findings ?? 0), 0),
    total
  });
  const roundComplete = steps.some((step) => step.kind === "revision" && step.status === "complete");
  const result = (fields: Partial<AnswerReviewProgress> & Pick<AnswerReviewProgress, "state" | "stopReason">): AnswerReviewProgress => ({
    next: null, reviews, roundComplete, running: null, settle: false, ...fields
  });
  if (input.state !== "running") return result({ state: input.state, stopReason: input.stopReason });
  const ended = (state: AnswerReviewState, stopReason: AnswerReviewStopReason) => result({ settle: true, state, stopReason });
  const running = steps.find((step) => step.status === "running") ?? null;
  if (running) return result({ running, state: "running", stopReason: null });
  const last = steps.at(-1);
  if (last?.status === "cancelled") return ended("stopped", "user_stopped");
  if (last?.status === "error") return ended("stopped", "error");
  if (last?.approvalPending) return ended("stopped", "approval_required");
  if (last?.kind === "review" && !last.review) return ended("stopped", "review_unreadable");
  if (roundComplete) {
    if (input.mode === "auto" && input.maxRounds !== null && input.round >= input.maxRounds) return ended("finished", "max_rounds");
    // A manual session waits for the user's next round; an automatic one starts it.
    return result({
      next: input.mode === "auto" ? { kind: "review", reviewer: 0, round: input.round + 1, step: 0 } : null,
      state: "running",
      stopReason: null
    });
  }
  if (total > 0 && done >= total) {
    if (reviews.clean) return ended("finished", "clean");
    return result({ next: { kind: "revision", round: input.round, step: total }, state: "running", stopReason: null });
  }
  return result({ next: { kind: "review", reviewer: done, round: input.round, step: done }, state: "running", stopReason: null });
}
