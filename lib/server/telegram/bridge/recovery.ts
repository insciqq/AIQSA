import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramSessionProvider } from "../control/session";
import type { TelegramRunLinkRecord, TelegramRunLinkStore } from "../store/runLinks";
import type { TelegramRunWait } from "./admission";
import type { TelegramDeliveryInput, TelegramDeliveryResult } from "./delivery";
import type { TelegramRunEvent, TelegramRunEventContext } from "./events";
import { publishTelegramDelivery } from "./runObserver";

/**
 * Deliveries a restart interrupted (D-08). Runs linked to Telegram before
 * this process started are found by their `TelegramRunLink`: a claim that
 * never settled may already have reached Telegram and settles `unknown`,
 * never resent; a pending one is followed (bounded) until its run settles,
 * then delivered once through the same claim the live path uses. A link too
 * old to matter settles `failed` without a message.
 */

export const TELEGRAM_RECOVERY_BATCH = 500;
export const TELEGRAM_RECOVERY_CONCURRENCY = 4;
/** A run is followed this long after the restart before recovery leaves it to the next one. */
export const TELEGRAM_RECOVERY_FOLLOW_MS = 30 * 60_000;
/** An answer older than this is not sent to Telegram anymore; it stays in AIQSA. */
export const TELEGRAM_RECOVERY_MAX_AGE_MS = 24 * 3_600_000;

export type TelegramRecoveryDeps = Readonly<{
  runLinks: Pick<TelegramRunLinkStore, "claimDelivery" | "listByState" | "settle">;
  sessions: TelegramSessionProvider;
  waitForRun: TelegramRunWait;
  deliver(input: TelegramDeliveryInput): Promise<TelegramDeliveryResult>;
  publish(event: TelegramRunEvent, context: TelegramRunEventContext): Promise<void>;
  /** Runs this process itself is following; recovery leaves them to it. */
  isLive(runId: string): boolean;
  now?: () => number;
}>;

/** Content-free: run identity, stable codes and counts only. */
function log(fields: Readonly<{
  code?: string; count?: number; error?: unknown; outcome: "completed" | "failed" | "skipped" | "waiting"; runId?: string;
}>): void {
  logEvent("service_operation", {
    ...(fields.code ? { code: fields.code } : {}), ...(fields.count === undefined ? {} : { count: fields.count }),
    ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    outcome: fields.outcome, ...(fields.runId ? { run_id: fields.runId } : {}), stage: "recovery", subsystem: "telegram"
  });
}

export async function recoverTelegramDeliveries(deps: TelegramRecoveryDeps, input: Readonly<{ startedAt: Date }>): Promise<void> {
  const now = deps.now ?? Date.now;
  // Nothing can be sent while the bot is off; the links wait for the next start.
  if (!(await deps.sessions.current())) return;
  const before = (row: TelegramRunLinkRecord) => row.createdAt.getTime() < input.startedAt.getTime() && !deps.isLive(row.runId);

  const claimed = (await deps.runLinks.listByState({ limit: TELEGRAM_RECOVERY_BATCH, state: "claimed" })).filter(before);
  for (const row of claimed) {
    await deps.runLinks.settle({ at: new Date(now()), runId: row.runId, state: "unknown" });
    log({ code: "telegram_delivery_unknown", outcome: "skipped", runId: row.runId });
  }

  const pending = (await deps.runLinks.listByState({ limit: TELEGRAM_RECOVERY_BATCH, state: "pending" })).filter(before);
  if (pending.length > 0) log({ count: pending.length, outcome: "waiting" });
  const deadline = now() + TELEGRAM_RECOVERY_FOLLOW_MS;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length) {
      const row = pending[next++]!;
      try {
        await recoverOne(row);
      } catch (error) {
        log({ code: "telegram_run_recovery_failed", error, outcome: "failed", runId: row.runId });
      }
    }
  }

  async function recoverOne(row: TelegramRunLinkRecord): Promise<void> {
    if (now() - row.createdAt.getTime() > TELEGRAM_RECOVERY_MAX_AGE_MS) {
      if (await deps.runLinks.claimDelivery(row.runId)) await deps.runLinks.settle({ at: new Date(now()), runId: row.runId, state: "failed" });
      log({ code: "telegram_run_delivery_failed", outcome: "skipped", runId: row.runId });
      return;
    }
    const settled = await deps.waitForRun({ deadline, runId: row.runId, userId: row.userId });
    if (!settled) {
      log({ outcome: "waiting", runId: row.runId });
      return;
    }
    const delivery = { linkId: row.linkId, runId: row.runId, runLinked: true, telegramChatId: row.telegramChatId, userId: row.userId };
    const result = await deps.deliver(delivery);
    await publishTelegramDelivery(deps.publish, result, {
      linkId: row.linkId, runId: row.runId, source: "recovery", telegramChatId: row.telegramChatId, userId: row.userId
    });
    if (result.state !== "skipped") log({ code: result.state === "delivered" ? undefined : "telegram_run_delivery_failed", outcome: "completed", runId: row.runId });
  }

  await Promise.all(Array.from({ length: Math.min(TELEGRAM_RECOVERY_CONCURRENCY, pending.length) }, () => worker()));
}
