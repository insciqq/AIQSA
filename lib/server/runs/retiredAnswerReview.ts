/**
 * Answer Review is removed (operator decision 2026-10-25): a request that
 * still asks for automatic review, from a tab of the previous release, is
 * refused with this code, never answered or saved without it. Reviewed
 * answers recorded before then stay readable (`lib/server/chats/legacyAnswerReviews.ts`).
 */
export const ANSWER_REVIEW_REMOVED = "answer_review_removed";

/** Whether a send, regeneration or chat update still asks for automatic review; absent or null asks for nothing. */
export function requestsAnswerReview(body: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return body !== null && body !== undefined && body.answerReview !== undefined && body.answerReview !== null;
}

/**
 * Whether an accepted run, as stored, was a step of an answer review
 * session: its turn is the server's and its report tool is gone, so it is
 * never started or replayed.
 */
export function isRetiredAnswerReviewStep(request: unknown): boolean {
  return typeof request === "object" && request !== null && !Array.isArray(request) &&
    (request as Record<string, unknown>).answerReviewStep !== undefined;
}
