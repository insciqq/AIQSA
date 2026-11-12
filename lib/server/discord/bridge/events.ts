import type { ThreadArtifactSummary } from "../../../contracts/chats";
import { createConnectorRunEventHub, type ConnectorRunListener, type ConnectorRunStreamEvent } from "../../connectors/runEvents";

/**
 * What the bridge observes of a Discord question's run, for later features
 * (the journal's feedback, answer files): the connectors' stream events while
 * the run goes on, then `delivered` once the answer (or its failure) reached
 * Discord or could not, from the live path and from recovery alike. They
 * follow a run without parsing its stream or touching the bridge.
 */

export type DiscordRunDeliveredEvent = Readonly<{
  type: "delivered";
  /** The run's terminal status as the chat shows it; `error` also for a run that could no longer be read. */
  status: "complete" | "cancelled" | "error";
  /** Whether the final message reached Discord (false when it failed, was refused or its outcome is unknown). */
  sent: boolean;
  /** The message that holds the answer (the status message edited into it). */
  answerMessageId: string | null;
  artifactSummary?: ThreadArtifactSummary;
}>;

export type DiscordRunEvent = ConnectorRunStreamEvent | DiscordRunDeliveredEvent;

export type DiscordRunEventContext = Readonly<{
  runId: string;
  /** The service account. */
  userId: string;
  chatId: string;
  questionMessageId: string;
  /** Where the question was posted. */
  questionChannelId: string;
  /** Where the answer goes: the conversation's thread or channel. */
  answerChannelId: string;
  guildId: string | null;
  discordUserId: string;
  test: boolean;
  source: "live" | "recovery";
}>;

export type DiscordRunListener = ConnectorRunListener<DiscordRunEvent, DiscordRunEventContext>;

const hub = createConnectorRunEventHub<DiscordRunEvent, DiscordRunEventContext>({
  listenerFailedCode: "discord_run_listener_failed", slot: "__aiqsaDiscordRunListeners", subsystem: "discord"
});

/** Follows every Discord run of this process; returns the unsubscribe function. */
export function onDiscordRunEvent(listener: DiscordRunListener): () => void {
  return hub.on(listener);
}

/** Hands one event to every subscriber in order; a failing subscriber never stops the answer's delivery. */
export function publishDiscordRunEvent(event: DiscordRunEvent, context: DiscordRunEventContext): Promise<void> {
  return hub.publish(event, context);
}
