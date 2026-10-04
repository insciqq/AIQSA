/** Upper bound on waiting for rendering before printing what is there. */
export const PRINT_SETTLE_TIMEOUT_MS = 20_000;
export const PRINT_SETTLE_POLL_MS = 100;

/**
 * Selectors of content still rendering asynchronously: code highlighting and
 * math mark themselves `data-render-pending`, Mermaid diagrams carry their
 * own state. Failed or fallback renderings are final, not pending.
 */
const PENDING_SELECTOR = '[data-render-pending], [data-mermaid-state="pending"]';

/** Count of pieces inside `root` that have not reached a final state. */
export function pendingPrintWork(root: ParentNode): number {
  let pending = root.querySelectorAll(PENDING_SELECTOR).length;
  // `complete` is true once an image has loaded or failed.
  for (const image of root.querySelectorAll("img")) {
    if (!image.complete) pending += 1;
  }
  return pending;
}

export type PrintSettleOutcome = "aborted" | "settled" | "timeout";

export type PrintSettleOptions = Readonly<{
  root: ParentNode;
  /** Whether web fonts are still loading (`document.fonts.status`). */
  fontsLoading?: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}>;

const defaultWait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Resolves once every highlighted code block, formula, diagram and image in
 * `root` is final and web fonts have loaded, in two checks one poll apart so
 * work that a just-finished step starts is not missed; "timeout" after the
 * cap, so a stuck renderer never blocks printing.
 */
export async function waitForPrintSettle({
  fontsLoading,
  now = Date.now,
  pollMs = PRINT_SETTLE_POLL_MS,
  root,
  signal,
  timeoutMs = PRINT_SETTLE_TIMEOUT_MS,
  wait = defaultWait
}: PrintSettleOptions): Promise<PrintSettleOutcome> {
  const deadline = now() + timeoutMs;
  let quietChecks = 0;
  for (;;) {
    if (signal?.aborted) return "aborted";
    const pending = pendingPrintWork(root) + (fontsLoading?.() ? 1 : 0);
    quietChecks = pending === 0 ? quietChecks + 1 : 0;
    if (quietChecks >= 2) return "settled";
    if (now() >= deadline) return "timeout";
    await wait(pollMs);
  }
}
