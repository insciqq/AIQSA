import {
  CONNECTOR_RECOVERY_BATCH, CONNECTOR_RECOVERY_CONCURRENCY, CONNECTOR_RECOVERY_FOLLOW_MS, CONNECTOR_RECOVERY_GRACE_MS,
  CONNECTOR_RECOVERY_MAX_AGE_MS, CONNECTOR_RECOVERY_SWEEP_INTERVAL_MS, recoverConnectorDeliveries
} from "../../connectors/recovery";
import type { ConnectorRunWait } from "../../connectors/runAdmission";
import type { TelegramSessionProvider } from "../control/session";
import type { TelegramRunLinkRecord, TelegramRunLinkStore } from "../store/runLinks";
import type { TelegramDeliveryInput, TelegramDeliveryResult } from "./delivery";
import type { TelegramRunEvent, TelegramRunEventContext } from "./events";
import { publishTelegramDelivery } from "./runObserver";

/**
 * Deliveries a restart interrupted, or that this process stopped following
 * (D-08), swept at start, once a minute and when the bot is switched on, one
 * sweep at a time, by the connectors' recovery sweep
 * (`lib/server/connectors/recovery.ts`) over `TelegramRunLink` rows: the
 * claim of a run linked before this process started that never settled may
 * already have reached Telegram and settles `unknown`, never resent; a pending
 * one is followed for at most a minute per sweep and, once its run settled,
 * delivered once through the same claim the live path uses. A link too old to
 * matter settles `failed` without a message.
 */

export const TELEGRAM_RECOVERY_BATCH = CONNECTOR_RECOVERY_BATCH;
export const TELEGRAM_RECOVERY_CONCURRENCY = CONNECTOR_RECOVERY_CONCURRENCY;
/** How often the deliveries left pending are swept again. */
export const TELEGRAM_RECOVERY_SWEEP_INTERVAL_MS = CONNECTOR_RECOVERY_SWEEP_INTERVAL_MS;
/** A sweep follows runs still going this long, then leaves them to the next sweep. */
export const TELEGRAM_RECOVERY_FOLLOW_MS = CONNECTOR_RECOVERY_FOLLOW_MS;
/** A run this process linked stays its observer's at least this long, while its admission still hands it over. */
export const TELEGRAM_RECOVERY_GRACE_MS = CONNECTOR_RECOVERY_GRACE_MS;
/** An answer older than this is not sent to Telegram anymore; it stays in AIQSA. */
export const TELEGRAM_RECOVERY_MAX_AGE_MS = CONNECTOR_RECOVERY_MAX_AGE_MS;

export type TelegramRecoveryDeps = Readonly<{
  runLinks: Pick<TelegramRunLinkStore, "claimDelivery" | "listByState" | "settle">;
  sessions: TelegramSessionProvider;
  waitForRun: ConnectorRunWait;
  deliver(input: TelegramDeliveryInput): Promise<TelegramDeliveryResult>;
  publish(event: TelegramRunEvent, context: TelegramRunEventContext): Promise<void>;
  /** Runs this process itself is following; recovery leaves them to it. */
  isLive(runId: string): boolean;
  now?: () => number;
}>;

/** One sweep; the caller runs one at a time, so no claim of a delivery in progress here is taken for an interrupted one. */
export async function recoverTelegramDeliveries(deps: TelegramRecoveryDeps, input: Readonly<{ startedAt: Date }>): Promise<void> {
  await recoverConnectorDeliveries<TelegramRunLinkRecord>({
    // Nothing can be sent while the bot is off; the links wait for the sweep after it is back.
    available: async () => Boolean(await deps.sessions.current()),
    async deliver(row) {
      const delivery = { linkId: row.linkId, runId: row.runId, runLinked: true, telegramChatId: row.telegramChatId, userId: row.userId };
      const result = await deps.deliver(delivery);
      await publishTelegramDelivery(deps.publish, result, {
        linkId: row.linkId, runId: row.runId, source: "recovery", telegramChatId: row.telegramChatId, userId: row.userId
      });
      return result.state;
    },
    isLive: deps.isLive,
    links: deps.runLinks,
    log: {
      deliveryFailed: "telegram_run_delivery_failed", recoveryFailed: "telegram_run_recovery_failed", subsystem: "telegram",
      unknown: "telegram_delivery_unknown"
    },
    ...(deps.now ? { now: deps.now } : {}),
    waitForRun: deps.waitForRun
  }, input);
}
