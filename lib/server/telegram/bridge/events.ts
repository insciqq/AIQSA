import type { ThreadArtifactSummary } from "../../../contracts/chats";
import { logEvent } from "../../observability";
import type { TelegramBotSession } from "../dispatcher";

/**
 * What the bridge observes of a run started from Telegram, as typed events,
 * and the process-wide subscriptions later features use (MCP approvals and
 * Agent status, generated files): they follow a run without parsing its
 * stream or touching the bridge.
 *
 * Stream events: `answerDelta` (answer text as it arrives), `answerReset`
 * (the text so far is replaced, e.g. after a follow-up), `approvalRequested`
 * (an MCP approval card), `workspaceActivity` (a projected Workspace or Agent
 * activity entry), `preparing` (a deferred admission the run waits in),
 * `done` (`complete` or `cancelled`) and `failed`. After the terminal event
 * the bridge delivers the final answer, then publishes `delivered`, from the
 * live stream and from recovery after a restart alike.
 */

export type TelegramRunStreamEvent =
  | Readonly<{ type: "answerDelta"; delta: string }>
  | Readonly<{ type: "answerReset" }>
  | Readonly<{ type: "approvalRequested"; card: unknown }>
  | Readonly<{ type: "workspaceActivity"; entry: unknown }>
  | Readonly<{ type: "preparing"; status: string }>
  | Readonly<{ type: "done"; status: "complete" | "cancelled" }>
  | Readonly<{ type: "failed"; code: string | null; message: string | null }>;

export type TelegramRunDeliveredEvent = Readonly<{
  type: "delivered";
  /** The run's terminal status as the chat shows it. */
  status: "complete" | "cancelled" | "error";
  /** Whether the final message reached Telegram (false when it failed or its outcome is unknown). */
  sent: boolean;
  messageIds: readonly number[];
  /** The settled answer's summary (generated files, approval cards), when it has one. */
  artifactSummary?: ThreadArtifactSummary;
}>;

export type TelegramRunEvent = TelegramRunStreamEvent | TelegramRunDeliveredEvent;

export type TelegramRunEventContext = Readonly<{
  runId: string;
  userId: string;
  linkId: string;
  /** The AIQSA chat of the run. */
  chatId: string;
  telegramChatId: number;
  bot: TelegramBotSession;
  source: "live" | "recovery";
}>;

export type TelegramRunListener = (event: TelegramRunEvent, context: TelegramRunEventContext) => Promise<void> | void;

const globalForListeners = globalThis as unknown as { __aiqsaTelegramRunListeners?: Set<TelegramRunListener> };

function listeners(): Set<TelegramRunListener> {
  globalForListeners.__aiqsaTelegramRunListeners ??= new Set();
  return globalForListeners.__aiqsaTelegramRunListeners;
}

/** Follows every Telegram run of this process; returns the unsubscribe function. */
export function onTelegramRunEvent(listener: TelegramRunListener): () => void {
  listeners().add(listener);
  return () => { listeners().delete(listener); };
}

/** Hands one event to every subscriber in order; a failing subscriber never stops the run's delivery. */
export async function publishTelegramRunEvent(event: TelegramRunEvent, context: TelegramRunEventContext): Promise<void> {
  for (const listener of [...listeners()]) {
    try {
      await listener(event, context);
    } catch (error) {
      logEvent("service_operation", {
        code: "telegram_run_listener_failed", error, outcome: "failed", run_id: context.runId, stage: "dispatch", subsystem: "telegram"
      });
    }
  }
}
