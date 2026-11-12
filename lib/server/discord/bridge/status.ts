import type { ConnectorRunStreamEvent } from "../../connectors/runEvents";
import { DISCORD_BRIDGE_COPY, discordUsingServerText } from "../copy";
import { formatDiscordStatus } from "../render";
import { discordStableNonce, type DiscordLinkButton, type DiscordRest, type DiscordRestFailure } from "../rest";
import type { DiscordUploadFile } from "../transport";

/**
 * One question's visible progress in Discord (PRD D-19, O-17): 👀 on the
 * question and "typing…" every 8 s until the status exists; once the run is
 * admitted, one status message (a Reply when the question is in the same
 * channel, without pinging anyone) reading "Working · 0:12 — Searching the
 * web", edited at most every 5 s and only when its text changed; at the end
 * the same message is edited into the answer (or the failure), 👀 comes off
 * and ✅ or ❌ goes on. Activities are short fixed labels from the run's
 * events, never tool arguments; an MCP server is named by its display name,
 * redacted and escaped. Every created message has a stable nonce, so a repeat
 * after an ambiguous failure never posts twice.
 */

export const DISCORD_STATUS_EDIT_INTERVAL_MS = 5_000;
export const DISCORD_TYPING_INTERVAL_MS = 8_000;
export const DISCORD_REACTION_SEEN = "👀";
export const DISCORD_REACTION_DONE = "✅";
export const DISCORD_REACTION_FAILED = "❌";

/** The activity a run event names; undefined keeps the current one. */
export function discordActivityLabel(event: ConnectorRunStreamEvent): string | null | undefined {
  switch (event.type) {
    case "answerDelta": return DISCORD_BRIDGE_COPY.activityWriting;
    case "answerReset": return DISCORD_BRIDGE_COPY.activityThinking;
    case "searchActivity": return DISCORD_BRIDGE_COPY.activitySearching;
    case "compaction": return DISCORD_BRIDGE_COPY.activityCompacting;
    case "toolActivity": {
      if (event.settled) return DISCORD_BRIDGE_COPY.activityThinking;
      if (event.toolName === "call_subagent") return DISCORD_BRIDGE_COPY.activitySubagent;
      switch (event.origin) {
        case "web_search": return DISCORD_BRIDGE_COPY.activitySearching;
        case "web_fetch": return DISCORD_BRIDGE_COPY.activityReading;
        case "discovery": return DISCORD_BRIDGE_COPY.activityFindingTools;
        case "skill": return DISCORD_BRIDGE_COPY.activitySkill;
        case "image": return DISCORD_BRIDGE_COPY.activityImage;
        case "mcp": return event.serverName ? discordUsingServerText(event.serverName) : DISCORD_BRIDGE_COPY.activityTool;
        default: return DISCORD_BRIDGE_COPY.activityTool;
      }
    }
    default: return undefined;
  }
}

export type DiscordFinalMessage = Readonly<{
  content: string;
  buttons?: readonly (readonly DiscordLinkButton[])[];
  files?: readonly DiscordUploadFile[];
}>;

/** How the final message went: `sent` with its id, or Discord's failure as the REST client reported it. */
export type DiscordFinalOutcome =
  | Readonly<{ kind: "sent"; messageId: string }>
  | Readonly<{ kind: "failed"; failure: DiscordRestFailure }>;

export type DiscordStatusMessage = Readonly<{
  /** "typing…" in the answer channel now and every 8 s until the status is posted or the status stops. */
  startTyping(): void;
  /** Posts the status; its message id, or null when Discord did not take it (the answer is then posted on its own). */
  post(): Promise<string | null>;
  setActivity(label: string | null | undefined): void;
  /** Edits the status into the final message (or posts it with the answer's nonce); the status stops. */
  finish(message: DiscordFinalMessage): Promise<DiscordFinalOutcome>;
  messageId(): string | null;
  /** Secrets replaced in status lines so far. */
  redactions(): number;
  stop(): void;
}>;

export type DiscordStatusInput = Readonly<{
  rest: () => DiscordRest;
  /** Where the status and the answer go: the conversation's thread or channel. */
  answerChannelId: string;
  questionMessageId: string;
  /** The question, when it is in the answer channel: the status replies to it. */
  replyTo: string | null;
  /** The run's start, for the clock. */
  startedAt: number;
  /** A status posted before (recovery): edited, never posted again. */
  existingMessageId?: string | null;
  onPosted?(messageId: string, at: number): void;
  now?: () => number;
  editIntervalMs?: number;
  typingIntervalMs?: number;
}>;

export function createDiscordStatusMessage(input: DiscordStatusInput): DiscordStatusMessage {
  const now = input.now ?? Date.now;
  const editIntervalMs = input.editIntervalMs ?? DISCORD_STATUS_EDIT_INTERVAL_MS;
  const typingIntervalMs = input.typingIntervalMs ?? DISCORD_TYPING_INTERVAL_MS;
  let messageId = input.existingMessageId ?? null;
  let shown: string | null = null;
  let activity: string | null = null;
  let redactions = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let typing: ReturnType<typeof setInterval> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  function line(): string {
    const status = formatDiscordStatus(now() - input.startedAt, activity);
    redactions += status.redactions;
    return status.content;
  }

  function stopTyping(): void {
    if (typing) clearInterval(typing);
    typing = null;
  }

  function stopTicker(): void {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  function type(): void {
    void input.rest().triggerTyping(input.answerChannelId).catch(() => undefined);
  }

  function tick(): void {
    if (stopped || !messageId) return;
    chain = chain.then(async () => {
      if (stopped || !messageId) return;
      const content = line();
      if (content === shown) return;
      const edited = await input.rest().editMessage(input.answerChannelId, messageId, { content });
      // A status Discord no longer takes (deleted, the bot switched off) stops changing; the answer still tries once.
      if (edited.ok) shown = content;
      else if (edited.delivery !== "unknown") stopTicker();
    }).catch(() => undefined);
  }

  return Object.freeze({
    startTyping() {
      if (stopped || typing || messageId) return;
      type();
      typing = setInterval(type, typingIntervalMs);
      typing.unref?.();
    },

    async post() {
      if (stopped) return messageId;
      if (!messageId) {
        const content = line();
        const created = await input.rest().createMessage(input.answerChannelId, {
          content, ...(input.replyTo ? { replyTo: input.replyTo } : {})
        }, { nonce: discordStableNonce(input.questionMessageId, "s") });
        if (!created.ok) {
          stopTyping();
          return null;
        }
        messageId = created.value.id;
        shown = content;
        input.onPosted?.(messageId, now());
      }
      stopTyping();
      if (!stopped && !ticker) {
        ticker = setInterval(tick, editIntervalMs);
        ticker.unref?.();
      }
      return messageId;
    },

    setActivity(label) {
      if (label !== undefined) activity = label;
    },

    async finish(message) {
      stopped = true;
      stopTyping();
      stopTicker();
      await chain;
      const rest = input.rest();
      const payload = { content: message.content, ...(message.buttons ? { buttons: message.buttons } : {}),
        ...(message.files?.length ? { files: message.files } : {}) };
      if (messageId) {
        const edited = await rest.editMessage(input.answerChannelId, messageId, payload);
        if (edited.ok) return { kind: "sent" as const, messageId: edited.value.id };
        // The status is gone (deleted by someone): the answer is posted on its own, once.
        if (!(edited.delivery === "refused" && edited.status === 404)) return { failure: edited, kind: "failed" as const };
      }
      const created = await rest.createMessage(input.answerChannelId, { ...payload, ...(input.replyTo ? { replyTo: input.replyTo } : {}) },
        { nonce: discordStableNonce(input.questionMessageId, "a") });
      if (!created.ok) return { failure: created, kind: "failed" as const };
      messageId = created.value.id;
      return { kind: "sent" as const, messageId: created.value.id };
    },

    messageId: () => messageId,
    redactions: () => redactions,

    stop() {
      stopped = true;
      stopTyping();
      stopTicker();
    }
  });
}

/** Reactions on a message, one after another (PRD D-05); failures are left alone (the answer itself matters). */
export async function discordReact(rest: DiscordRest, input: Readonly<{
  channelId: string; messageId: string; add?: readonly string[]; remove?: readonly string[];
}>): Promise<boolean> {
  let ok = true;
  for (const emoji of input.remove ?? []) {
    const removed = await rest.removeOwnReaction(input.channelId, input.messageId, emoji).catch(() => null);
    ok &&= removed?.ok === true;
  }
  for (const emoji of input.add ?? []) {
    const added = await rest.addOwnReaction(input.channelId, input.messageId, emoji).catch(() => null);
    ok &&= added?.ok === true;
  }
  return ok;
}
