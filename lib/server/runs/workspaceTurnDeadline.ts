/**
 * What a Workspace turn may still need after it stops starting tool work,
 * beyond the in-flight synchronous call: the provider round that may be in
 * flight (its tool batch is then refused), the tool-free final round, and the
 * post-answer handoff (output capture, a browser-session save of at most
 * 30 s, and retirement of guest authority).
 *
 * Basis: long production turns averaged about 30 s per round including tools
 * (58 and 66 rounds in 1 800 s), so an in-flight round is usually well under
 * a minute; a final answer over a long transcript can take a reasoning model
 * one to two minutes; a handoff takes seconds to about a minute. 60 + 120 +
 * 60 s rounded up gives 240 s.
 */
export const WORKSPACE_TURN_TAIL_RESERVE_MS = 240_000;

/**
 * Milliseconds after the turn starts at which a Workspace turn's time budget
 * counts as used up: no further tool batch is dispatched and the next round
 * is the existing forced tool-free final answer, followed by the ordinary
 * handoff. The hard turn deadline stays the safety net.
 *
 * Reserve = one synchronous Workspace call (the longest a call already
 * running can take; it is never aborted early, so its side effects stay
 * unambiguous) + `WORKSPACE_TURN_TAIL_RESERVE_MS`, capped at half the budget
 * so short budgets keep time for actual work. Defaults (1 800 s turn, 120 s
 * call): 360 s reserve, so the final answer is forced after 1 440 s (80 %).
 * A longer in-flight call of another kind (a reasoning Vision request may wait
 * up to 300 s) can still meet the hard deadline.
 */
export function workspaceTurnSoftDeadlineMs(
  turnTimeoutSeconds: number,
  syncToolTimeoutSeconds: number
): number {
  const budgetMs = turnTimeoutSeconds * 1_000;
  const reserveMs = Math.min(
    syncToolTimeoutSeconds * 1_000 + WORKSPACE_TURN_TAIL_RESERVE_MS,
    Math.floor(budgetMs / 2)
  );
  return budgetMs - reserveMs;
}
