import type { ContentBlock } from "../../../domain/content";
import {
  DISCORD_COPY, DISCORD_EARLIER_MESSAGES_OMITTED, discordEarlierMessagesText, discordOmittedMessagesText
} from "../copy";
import type { DiscordRest } from "../rest";
import type { DiscordConversationKind } from "../store/conversations";
import {
  compareDiscordIds, decodeDiscordContextMessage, discordAttachmentNames, discordAuthorLabel, discordHistoryLine,
  DISCORD_CONTEXT_MESSAGE_TYPES, type DiscordContextMessage, type DiscordMentionNames
} from "./messages";
import type { DiscordRunFacts } from "./runFacts";
import type { DiscordUploads } from "./uploads";

/**
 * A Discord turn's context, always read from Discord REST when the question
 * comes (PRD D-16, O-14, O-15, O-31), so what was deleted by then is gone and
 * what was edited reads as it is now:
 *
 * - the first turn in an existing thread or forum post reads the whole thread
 *   (a thread's starter message lives in its parent channel under the
 *   thread's id; a forum post's is inside the thread), oldest first;
 * - a mention in a channel (and the first turn of a direct message or a
 *   voice-channel chat) reads up to 50 earlier messages, stopping at a gap of
 *   more than 30 minutes or at 6 hours;
 * - every later turn reads what came after the last message a turn included;
 *   conversations bounded by gaps read at most 500 such messages.
 *
 * AIQSA's own posts of this conversation (already its answers in the chat)
 * and its refusal notes are left out; another service's posts are marked
 * `(bot)`. The question is the last block, "Question from …", with the same
 * author's messages of the next 1.5 s joined to it; a Reply's target is always
 * its own block, read fresh, wherever it is. Text over 60 000 characters keeps
 * its tail inline and puts the whole history into `discord-history.md`.
 * Attachments are named in the text; the attachment hook may add them as
 * files (`dc-files`).
 */

export const DISCORD_CONTEXT_TEXT_MAX = 60_000;
export const DISCORD_CHANNEL_WINDOW_MAX = 50;
export const DISCORD_CHANNEL_WINDOW_GAP_MS = 30 * 60_000;
export const DISCORD_CHANNEL_WINDOW_AGE_MS = 6 * 3_600_000;
/** Messages read at most per turn of a conversation bounded by gaps (a channel, a direct message, a voice-channel chat). */
export const DISCORD_GAP_READ_MAX = 500;
/** A thread is read whole up to this bound; its compaction holds the rest. */
export const DISCORD_THREAD_READ_MAX = 10_000;
/** The same author's messages within this window of each other join one question. */
export const DISCORD_MERGE_WINDOW_MS = 1_500;
const MERGE_MAX_MESSAGES = 20;
const QUESTION_TEXT_MAX = 16_000;
const REFERENCE_TEXT_MAX = 8_000;
const PAGE = 100;

export type DiscordContextScope =
  /** The whole thread from its first message; `starterChannelId` is the parent holding a thread's starter message (null for a forum post). */
  | Readonly<{ kind: "thread_start"; threadId: string; starterChannelId: string | null }>
  /** A channel window before the question. */
  | Readonly<{ kind: "channel_window"; channelId: string }>
  /** What came after the last included message; `bounded` stops at 500 messages. */
  | Readonly<{ kind: "delta"; channelId: string; afterId: string; bounded: boolean }>;

export type DiscordAttachmentPlan = Readonly<{
  /** Image and file blocks added after the turn's text. */
  blocks: readonly ContentBlock[];
  /** Short lines added to the text (an attachment that could not be added, say). */
  notes: readonly string[];
}>;

/**
 * The attachments of a turn (PRD D-24, O-33; `dc-files`): the question's own
 * messages, the Reply's target, and the included history, oldest first. The
 * text already names every attachment; the default adds nothing.
 */
export type DiscordAttachmentHook = (input: Readonly<{
  /** The service account the uploads are made as. */
  userId: string;
  question: readonly DiscordContextMessage[];
  reference: DiscordContextMessage | null;
  history: readonly DiscordContextMessage[];
}>) => Promise<DiscordAttachmentPlan>;

export const discordAttachmentNamesOnly: DiscordAttachmentHook = async () => ({ blocks: [], notes: [] });

export type DiscordTurnContext =
  | Readonly<{
    ok: true;
    /** The turn's text first, then the history file and the attachment hook's blocks. */
    blocks: ContentBlock[];
    text: string;
    /** The newest message the turn includes: the question or the last message joined to it. */
    includedUpTo: string;
    /** Messages joined to the question after it. */
    mergedIds: readonly string[];
    /** History messages included (inline or in the file). */
    historyCount: number;
  }>
  | Readonly<{ ok: false; code: "discord_context_unavailable" }>;

export type DiscordContextInput = Readonly<{
  rest: DiscordRest;
  names: DiscordMentionNames;
  facts: Pick<DiscordRunFacts, "aiqsaMessages">;
  /** The conversation whose own answers are left out; null before it exists. */
  conversationId: string | null;
  scope: DiscordContextScope;
  trigger: DiscordContextMessage;
  /** The conversation's header line; null for a follow-up into a running answer. */
  header: string | null;
  mergeWindowMs: number;
  userId: string;
  /** Null: a longer history is cut, not attached (a follow-up carries no file). */
  uploads: DiscordUploads | null;
  attachments: DiscordAttachmentHook;
  maxChars?: number;
  /**
   * The question's server, null in a direct message: the question line then carries the message's Discord link, which
   * tools that need a reference to the asking message (a merge request) can cite. Undefined leaves the link out.
   */
  guildId?: string | null;
}>;

type Read = Readonly<{ messages: DiscordContextMessage[]; omitted: boolean }>;

function decodePage(values: readonly unknown[], names: DiscordMentionNames): DiscordContextMessage[] {
  return values.flatMap((value) => decodeDiscordContextMessage(value, names) ?? [])
    .sort((left, right) => compareDiscordIds(right.id, left.id));
}

/**
 * Reads backwards from `beforeId`, newest first, while `take` keeps saying yes, up to `max` messages;
 * null when the first page cannot be read (the bot may not read this history).
 */
async function readBackwards(input: Readonly<{
  rest: DiscordRest; names: DiscordMentionNames; channelId: string; beforeId: string; max: number; pageSize?: number;
  take(message: DiscordContextMessage, newer: DiscordContextMessage | null): boolean;
}>): Promise<Read | null> {
  const messages: DiscordContextMessage[] = [];
  let cursor = input.beforeId;
  let newer: DiscordContextMessage | null = null;
  for (let page = 0; ; page += 1) {
    const limit = Math.min(input.pageSize ?? PAGE, PAGE);
    const answer = await input.rest.listChannelMessages(input.channelId, { before: cursor, limit });
    if (!answer.ok) return page === 0 ? null : { messages, omitted: true };
    const decoded = decodePage(answer.value, input.names);
    for (const message of decoded) {
      if (!input.take(message, newer)) return { messages, omitted: false };
      if (messages.length >= input.max) return { messages, omitted: true };
      messages.push(message);
      newer = message;
    }
    if (answer.value.length < limit || decoded.length === 0) return { messages, omitted: false };
    cursor = decoded[decoded.length - 1]!.id;
  }
}

async function readScope(input: DiscordContextInput): Promise<Read | null> {
  const { names, rest, scope, trigger } = input;
  switch (scope.kind) {
    case "thread_start": {
      const read = await readBackwards({ channelId: scope.threadId, beforeId: trigger.id, max: DISCORD_THREAD_READ_MAX, names, rest, take: () => true });
      if (!read || read.omitted || !scope.starterChannelId) return read;
      // A thread started from a message keeps that message in its parent channel, under the thread's id.
      const starter = await rest.getChannelMessage(scope.starterChannelId, scope.threadId);
      const decoded = starter.ok ? decodeDiscordContextMessage(starter.value, names) : null;
      return decoded && decoded.id !== trigger.id ? { messages: [...read.messages, decoded], omitted: false } : read;
    }
    case "channel_window":
      return readBackwards({
        channelId: scope.channelId, beforeId: trigger.id, max: DISCORD_CHANNEL_WINDOW_MAX, names, pageSize: DISCORD_CHANNEL_WINDOW_MAX, rest,
        take: (message, newer) => trigger.createdAt.getTime() - message.createdAt.getTime() <= DISCORD_CHANNEL_WINDOW_AGE_MS &&
          (newer ?? trigger).createdAt.getTime() - message.createdAt.getTime() <= DISCORD_CHANNEL_WINDOW_GAP_MS
      });
    case "delta":
      if (compareDiscordIds(scope.afterId, trigger.id) >= 0) return { messages: [], omitted: false };
      return readBackwards({
        channelId: scope.channelId, beforeId: trigger.id, max: scope.bounded ? DISCORD_GAP_READ_MAX : DISCORD_THREAD_READ_MAX, names, rest,
        take: (message) => compareDiscordIds(message.id, scope.afterId) > 0
      });
  }
}

/** The same author's messages right after the question, each within the window of the one before. */
async function mergedAfter(input: DiscordContextInput): Promise<DiscordContextMessage[]> {
  if (input.mergeWindowMs <= 0) return [];
  const answer = await input.rest.listChannelMessages(input.trigger.channelId, { after: input.trigger.id, limit: MERGE_MAX_MESSAGES });
  if (!answer.ok) return [];
  const later = decodePage(answer.value, input.names).reverse();
  const merged: DiscordContextMessage[] = [];
  let previous = input.trigger;
  for (const message of later) {
    if (message.authorId !== input.trigger.authorId || !DISCORD_CONTEXT_MESSAGE_TYPES.has(message.type) ||
      message.createdAt.getTime() - previous.createdAt.getTime() > input.mergeWindowMs) break;
    merged.push(message);
    previous = message;
  }
  return merged;
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The message's web link; `@me` stands for a direct message's server. */
export function discordMessageLink(guildId: string | null, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

export async function readDiscordTurnContext(input: DiscordContextInput): Promise<DiscordTurnContext> {
  const maxChars = input.maxChars ?? DISCORD_CONTEXT_TEXT_MAX;
  const [read, merged] = await Promise.all([readScope(input), mergedAfter(input)]);
  if (!read) return { code: "discord_context_unavailable", ok: false };
  const candidates = read.messages.filter((message) => DISCORD_CONTEXT_MESSAGE_TYPES.has(message.type))
    .sort((left, right) => compareDiscordIds(left.id, right.id));

  let reference: DiscordContextMessage | null = null;
  let referenceMissing = false;
  if (input.trigger.referenceId) {
    const answer = await input.rest.getChannelMessage(input.trigger.referenceChannelId ?? input.trigger.channelId, input.trigger.referenceId);
    reference = answer.ok ? decodeDiscordContextMessage(answer.value, input.names) : null;
    referenceMissing = reference === null;
  }

  // AIQSA's own posts: answers of this conversation are its chat's answers already, refusal notes are noise.
  const botPosts = [...candidates, ...(reference ? [reference] : [])].filter((message) => message.authorId === input.names.botUserId);
  const own = botPosts.length > 0 ? await input.facts.aiqsaMessages(botPosts.map((message) => message.id)) : new Map<string, string | null>();
  const hidden = (message: DiscordContextMessage) => own.has(message.id) &&
    (own.get(message.id) === null || own.get(message.id) === input.conversationId);
  const history = candidates.filter((message) => !hidden(message));
  const question = [input.trigger, ...merged];

  const plan = await input.attachments({ history, question, reference, userId: input.userId });
  const lines = history.map(discordHistoryLine);
  const questionText = bounded(question.map((message) => `${message.text}${discordAttachmentNames(message)}`).join("\n"), QUESTION_TEXT_MAX);
  const tail: string[] = [];
  if (input.trigger.referenceId) {
    if (reference && own.has(reference.id)) {
      tail.push(`Replying to your earlier answer, message ${reference.id}:\n${bounded(reference.text, REFERENCE_TEXT_MAX)}`);
    } else if (reference) {
      tail.push(`Replying to ${discordAuthorLabel(reference)}, message ${reference.id}:\n${bounded(reference.text, REFERENCE_TEXT_MAX)}${discordAttachmentNames(reference)}`);
    } else if (referenceMissing) {
      tail.push(`Replying to message ${input.trigger.referenceId}, which can no longer be read.`);
    }
  }
  const link = input.guildId === undefined ? "" : `, message ${discordMessageLink(input.guildId, input.trigger.channelId, input.trigger.id)}`;
  tail.push(`Question from ${discordAuthorLabel(input.trigger)}${link}:\n${questionText}`);
  if (plan.notes.length > 0) tail.push(plan.notes.join("\n"));

  const label = input.scope.kind === "delta" ? "Messages since your last reply:" : "Earlier messages:";
  const head = input.header ? [input.header] : [];
  const blocks: ContentBlock[] = [];
  const fixed = [...head, ...tail].join("\n\n").length + label.length + 64;
  let shown = lines;
  let note: string | null = read.omitted ? DISCORD_EARLIER_MESSAGES_OMITTED : null;
  if (fixed + lines.join("\n").length > maxChars) {
    const budget = Math.max(0, maxChars - fixed - 200);
    const kept: string[] = [];
    let used = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (used + line.length + 1 > budget) break;
      kept.unshift(line);
      used += line.length + 1;
    }
    const earlier = lines.length - kept.length;
    shown = kept;
    const file = input.uploads && earlier > 0
      ? await input.uploads.uploadFile({
        data: new TextEncoder().encode([...head, `${label}\n${lines.join("\n")}`].join("\n\n")),
        fileName: DISCORD_COPY.historyAttachmentName, mimeType: "text/markdown", userId: input.userId
      }).catch(() => null)
      : null;
    if (file?.ok) {
      blocks.push(file.block);
      note = discordEarlierMessagesText(earlier);
    } else if (earlier > 0) {
      note = discordOmittedMessagesText(earlier);
    }
  }
  const historyPart = shown.length > 0 || note ? [`${label}\n${[...(note ? [note] : []), ...shown].join("\n")}`] : [];
  const text = [...head, ...historyPart, ...tail].join("\n\n");
  return {
    blocks: [{ text, type: "text" }, ...blocks, ...plan.blocks],
    historyCount: history.length,
    includedUpTo: (merged.at(-1) ?? input.trigger).id,
    mergedIds: merged.map((message) => message.id),
    ok: true,
    text
  };
}

// ---------------------------------------------------------------------------
// Names for the conversation's header

export const DISCORD_NAMES_TTL_MS = 10 * 60_000;
const NAMES_MAX_ENTRIES = 2_000;

export type DiscordNames = Readonly<{
  channel(channelId: string): Promise<string | null>;
  guild(guildId: string): Promise<string | null>;
}>;

/** Channel, thread and server names for headers, read through REST and kept ten minutes. */
export function createDiscordNames(input: Readonly<{ rest: () => DiscordRest; now?: () => number; ttlMs?: number }>): DiscordNames {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DISCORD_NAMES_TTL_MS;
  const channels = new Map<string, { name: string | null; expiresAt: number }>();
  let guilds: { names: Map<string, string>; expiresAt: number } | null = null;
  return Object.freeze({
    async channel(channelId: string) {
      const cached = channels.get(channelId);
      if (cached && cached.expiresAt > now()) return cached.name;
      const answer = await input.rest().getChannel(channelId);
      if (!answer.ok) return null;
      const name = answer.value.name?.trim().slice(0, 100) || null;
      channels.delete(channelId);
      channels.set(channelId, { expiresAt: now() + ttlMs, name });
      while (channels.size > NAMES_MAX_ENTRIES) channels.delete(channels.keys().next().value as string);
      return name;
    },
    async guild(guildId: string) {
      if (!guilds || guilds.expiresAt <= now()) {
        const answer = await input.rest().listCurrentUserGuilds();
        if (!answer.ok) return null;
        guilds = { expiresAt: now() + ttlMs, names: new Map(answer.value.map((guild) => [guild.id, guild.name.slice(0, 100)])) };
      }
      return guilds.names.get(guildId) ?? null;
    }
  });
}

/** The conversation's header line, as the run reads it (names are Discord's, never logged). */
export function discordConversationHeader(input: Readonly<{
  kind: DiscordConversationKind;
  channelName: string | null;
  parentName: string | null;
  guildName: string | null;
  /** The direct message's other person. */
  partner?: Pick<DiscordContextMessage, "authorId" | "authorName" | "bot">;
}>): string {
  const server = input.guildName ? `, server "${input.guildName}"` : "";
  const channel = input.channelName ?? "unnamed";
  const parent = input.parentName ? ` in #${input.parentName}` : "";
  switch (input.kind) {
    case "dm": return `Discord direct message${input.partner ? ` with ${discordAuthorLabel(input.partner)}` : ""}.`;
    case "thread": return `Discord thread "${channel}"${parent}${server}.`;
    case "forum_post": return `Discord forum post "${channel}"${parent}${server}.`;
    case "voice_chat": return `Discord voice channel chat #${channel}${server}.`;
    case "channel": return `Discord channel #${channel}${server}.`;
  }
}
