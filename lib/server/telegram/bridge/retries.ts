/**
 * When a final answer that provably never reached Telegram (`deliverTelegramRun`
 * hands its link back `pending`) is tried again. The hour after its run
 * settled bounds it durably: the failed try past it settles the link `failed`.
 * The wait between tries is this process's own: a minute after a failure,
 * doubling up to five, so the sweeps never hammer a Telegram that is down and
 * still deliver within minutes once it answers again. A restart forgets the
 * waits, so its first sweep tries every such link once.
 */

/** How long after its run settled an answer that never reached Telegram is still tried. */
export const TELEGRAM_DELIVERY_RETRY_WINDOW_MS = 60 * 60_000;
export const TELEGRAM_DELIVERY_RETRY_MIN_MS = 60_000;
export const TELEGRAM_DELIVERY_RETRY_MAX_MS = 5 * 60_000;
/** Runs whose wait is remembered; an older one forgotten is only tried sooner. */
const WAITS_KEPT = 1_000;

export type TelegramDeliveryRetries = Readonly<{
  /** Records a try that left the answer with Telegram unsent at `at`. */
  defer(runId: string, at: number): void;
  /** Whether a sweep at `at` may try the run's delivery. */
  due(runId: string, at: number): boolean;
  /** The delivery settled (or another took it): its wait is over. */
  forget(runId: string): void;
}>;

export function createTelegramDeliveryRetries(): TelegramDeliveryRetries {
  const waits = new Map<string, Readonly<{ failures: number; nextAt: number }>>();
  return Object.freeze({
    defer(runId: string, at: number) {
      const failures = (waits.get(runId)?.failures ?? 0) + 1;
      const wait = Math.min(TELEGRAM_DELIVERY_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 16), TELEGRAM_DELIVERY_RETRY_MAX_MS);
      // Newest last, so the oldest wait is the one forgotten.
      waits.delete(runId);
      waits.set(runId, { failures, nextAt: at + wait });
      while (waits.size > WAITS_KEPT) waits.delete(waits.keys().next().value as string);
    },
    due(runId: string, at: number) {
      const wait = waits.get(runId);
      return !wait || at >= wait.nextAt;
    },
    forget(runId: string) {
      waits.delete(runId);
    }
  });
}
