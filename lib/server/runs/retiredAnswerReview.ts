/**
 * Whether an accepted run, as stored, was a step of an answer review
 * session (Answer Review was removed, operator decision 2026-10-25): its turn
 * is the server's and its report tool is gone, so it is never started or
 * replayed. Reviewed answers stay readable (`lib/server/chats/legacyAnswerReviews.ts`).
 */
export function isRetiredAnswerReviewStep(request: unknown): boolean {
  return typeof request === "object" && request !== null && !Array.isArray(request) &&
    (request as Record<string, unknown>).answerReviewStep !== undefined;
}
