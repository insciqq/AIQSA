import type { ThreadArtifactSummary } from "../../../contracts/chats";
import { createConnectorRunEventHub, type ConnectorRunListener, type ConnectorRunStreamEvent } from "../../connectors/runEvents";
import type { TelegramBotSession } from "../dispatcher";

/**
 * What the bridge observes of a run started from Telegram, as typed events
 * (the connectors' stream events, `lib/server/connectors/runEvents.ts`), and
 * the process-wide subscriptions later features use (MCP approvals and
 * Workspace status, generated files): they follow a run without parsing its
 * stream or touching the bridge. After the terminal event the bridge delivers
 * the final answer, then publishes `delivered`, from the live stream and from
 * recovery after a restart alike.
 */

export type TelegramRunStreamEvent = ConnectorRunStreamEvent;

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

export type TelegramRunListener = ConnectorRunListener<TelegramRunEvent, TelegramRunEventContext>;

const hub = createConnectorRunEventHub<TelegramRunEvent, TelegramRunEventContext>({
  listenerFailedCode: "telegram_run_listener_failed", slot: "__aiqsaTelegramRunListeners", subsystem: "telegram"
});

/** Follows every Telegram run of this process; returns the unsubscribe function. */
export function onTelegramRunEvent(listener: TelegramRunListener): () => void {
  return hub.on(listener);
}

/** Hands one event to every subscriber in order; a failing subscriber never stops the run's delivery. */
export function publishTelegramRunEvent(event: TelegramRunEvent, context: TelegramRunEventContext): Promise<void> {
  return hub.publish(event, context);
}
