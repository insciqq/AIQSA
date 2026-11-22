import { z } from "zod";

/**
 * Client-safe contract of past-chat search (operator decision 2026-11-22), which replaces Personal Memory's chat
 * history recall: the agent's `search_past_chats` and `read_past_chat` tools over the owner's own ordinary chats, and
 * the past-chat sources an answer shows. The index (`ChatSearchPassage`) holds each turn of a chat's active branch, a
 * user message and its final answer, with the chat's title and the turn's file names, secret-redacted. Search merges
 * `simple` full-text search and vector search by reciprocal rank fusion, then the reranker when one is set. The user's
 * `memoryEnabled` and `pastChatSearchEnabled` switches (`memoryNote.ts`) must both be on.
 *
 * Tool arguments are snake_case like the other tools'; results and sources are camelCase. A result never carries
 * scores, ranks or other execution details: its order is its rank.
 */

export const SEARCH_PAST_CHATS_TOOL_NAME = "search_past_chats";
export const READ_PAST_CHAT_TOOL_NAME = "read_past_chat";

/** UTF-16 lengths the decoders accept; producers clip with `clipPastChatText` and titles and names with `clipPastChatLine`. */
export const PAST_CHATS_LIMITS = Object.freeze({
  queryChars: 500,
  /** Results a search returns without `limit`, and at most. */
  searchResultsDefault: 8,
  searchResultsMax: 20,
  /** One result's excerpt: the matching window around the match, or the start of a recent chat's latest turn. */
  excerptChars: 1_200,
  titleChars: 300,
  /** Past-chat sources one answer shows; later ones are left out. */
  sourcesPerAnswer: 20,
  /** Messages one read returns, and characters of their texts together, so a page fits one tool result. */
  readWindowMessages: 20,
  readWindowChars: 24_000,
  /** One message's text in a read; a longer one is clipped and marked. */
  readMessageChars: 6_000,
  /** File and tool names one message lists, and their lengths. */
  readNamesPerMessage: 20,
  fileNameChars: 255,
  toolNameChars: 128
});

/** Refusals the tools answer with, as the tool error's code. */
export const PAST_CHATS_TOOL_ERROR_CODES = [
  /** Memory or past-chat search is off for this user. */
  "past_chats_disabled",
  "past_chats_arguments_invalid",
  /** Unknown, foreign, deleted and excluded chats and messages get the same refusal. */
  "past_chat_not_found",
  /** Search could not run now; nothing was found or left out silently. */
  "past_chats_unavailable"
] as const;
export type PastChatsToolErrorCode = (typeof PAST_CHATS_TOOL_ERROR_CODES)[number];

/** How a search ranked its results: by relevance to the query, or the most recent chats when it had none. */
export const PAST_CHAT_SEARCH_MODES = ["relevance", "recent"] as const;
export type PastChatSearchMode = (typeof PAST_CHAT_SEARCH_MODES)[number];

export const PAST_CHAT_MESSAGE_ROLES = ["user", "assistant"] as const;
export type PastChatMessageRole = (typeof PAST_CHAT_MESSAGE_ROLES)[number];

/** At most `maximum` UTF-16 units, cut between code points and marked with an ellipsis. */
export function clipPastChatText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let clipped = "";
  for (const character of value) {
    if (clipped.length + character.length > maximum - 1) break;
    clipped += character;
  }
  return `${clipped}…`;
}

/** A title or name as one line the decoders accept: control characters and runs of spaces become one space, clipped. */
export function clipPastChatLine(value: string, maximum: number): string {
  return clipPastChatText(value.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim(), maximum);
}

/** The chat page a source opens. */
export function pastChatPath(chatId: string): string {
  return `/c/${encodeURIComponent(chatId)}`;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const limits = PAST_CHATS_LIMITS;

const idSchema = z.string().regex(ID_PATTERN);
const timestampSchema = z.string().max(64)
  .refine((value) => ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), "invalid timestamp");

/** A calendar day, YYYY-MM-DD, that exists. */
const dateSchema = z.string().refine((value) => {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "invalid date");

function text(maximum: number) {
  return z.string().max(maximum).refine((value) => !value.includes("\0"), "text contains a null byte");
}

function line(maximum: number) {
  return z.string().min(1).max(maximum).refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), "invalid name");
}

/**
 * `search_past_chats`. With a `query`, excerpts of the user's past chats ranked by relevance; without one (absent,
 * null or blank), the most recent chats. `after` keeps turns on or after that day and `before` those before it, in the
 * time zone the turn context states; `limit` caps the results (default `searchResultsDefault`). Null stands for
 * absent, as models send.
 */
export const searchPastChatsInputSchema = z.strictObject({
  query: text(limits.queryChars).nullish(),
  after: dateSchema.nullish(),
  before: dateSchema.nullish(),
  limit: z.number().int().min(1).max(limits.searchResultsMax).nullish()
}).refine((input) => !input.after || !input.before || input.after < input.before, "after must be an earlier day than before");
export type SearchPastChatsInput = z.infer<typeof searchPastChatsInputSchema>;

/** How a search with these arguments ranks: a query that is not blank searches by relevance. */
export function pastChatSearchMode(input: Pick<SearchPastChatsInput, "query">): PastChatSearchMode {
  return input.query?.trim() ? "relevance" : "recent";
}

/**
 * `read_past_chat`: a bounded window of one past chat's active branch, oldest first. With `around_message_id` the window
 * holds that message; `before_message_id` reads the messages before it and `after_message_id` those after it, for
 * paging from a window's first or last message; with none, the chat's beginning. At most one of the three.
 */
export const readPastChatInputSchema = z.strictObject({
  chat_id: idSchema,
  around_message_id: idSchema.nullish(),
  before_message_id: idSchema.nullish(),
  after_message_id: idSchema.nullish()
}).refine((input) => [input.around_message_id, input.before_message_id, input.after_message_id]
  .filter((value) => value !== undefined && value !== null).length <= 1, "pass at most one of around_message_id, before_message_id and after_message_id");
export type ReadPastChatInput = z.infer<typeof readPastChatInputSchema>;

/**
 * One place in a past chat: a search result, and the source an answer shows under it. `date` is the turn's time,
 * `messageId` the turn's user message (`read_past_chat`'s `around_message_id` opens it), and `excerpt` the text found.
 * The title is the chat's current one.
 */
export const pastChatExcerptSchema = z.strictObject({
  chatId: idSchema,
  chatTitle: line(limits.titleChars),
  date: timestampSchema,
  messageId: idSchema,
  excerpt: z.string().min(1).max(limits.excerptChars).refine((value) => value.trim().length > 0 && !value.includes("\0"), "invalid excerpt")
});
export type PastChatExcerpt = z.infer<typeof pastChatExcerptSchema>;
/** A past-chat source shown under an answer. */
export type PastChatSource = PastChatExcerpt;

/**
 * `search_past_chats`' result, best first. A turn appears once; a recent-chats listing names each chat once, by its
 * latest turn.
 */
export const searchPastChatsResultSchema = z.strictObject({
  mode: z.enum(PAST_CHAT_SEARCH_MODES),
  results: z.array(pastChatExcerptSchema).max(limits.searchResultsMax)
}).refine((result) => new Set(result.results.map((item) => `${item.chatId}:${item.messageId}`)).size === result.results.length,
  "a turn appears twice")
  .refine((result) => result.mode !== "recent" || new Set(result.results.map((item) => item.chatId)).size === result.results.length,
    "a recent chat appears twice");
export type SearchPastChatsResult = z.infer<typeof searchPastChatsResultSchema>;

/**
 * One message of a read window: its text (clipped to `readMessageChars` when `clipped`), the names of the files the
 * user attached and the answer generated, and the tools the answer called, by name only: never tool arguments,
 * results or file contents.
 */
export const pastChatMessageSchema = z.strictObject({
  messageId: idSchema,
  role: z.enum(PAST_CHAT_MESSAGE_ROLES),
  date: timestampSchema,
  text: text(limits.readMessageChars),
  clipped: z.boolean(),
  attachments: z.array(line(limits.fileNameChars)).max(limits.readNamesPerMessage),
  generatedFiles: z.array(line(limits.fileNameChars)).max(limits.readNamesPerMessage),
  tools: z.array(line(limits.toolNameChars)).max(limits.readNamesPerMessage)
});
export type PastChatMessage = z.infer<typeof pastChatMessageSchema>;

/** `read_past_chat`'s result: the window, oldest first, and whether the branch goes on before and after it. */
export const readPastChatResultSchema = z.strictObject({
  chatId: idSchema,
  chatTitle: line(limits.titleChars),
  messages: z.array(pastChatMessageSchema).max(limits.readWindowMessages),
  hasEarlier: z.boolean(),
  hasLater: z.boolean()
}).refine((result) => new Set(result.messages.map((message) => message.messageId)).size === result.messages.length, "a message appears twice")
  .refine((result) => result.messages.reduce((sum, message) => sum + message.text.length, 0) <= limits.readWindowChars,
    "the window's texts are over their limit");
export type ReadPastChatResult = z.infer<typeof readPastChatResultSchema>;

export function decodePastChatSource(value: unknown): PastChatSource | null {
  const result = pastChatExcerptSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** An answer's past-chat sources from its payloads: decoded, in order, each turn once, bounded. */
export function foldPastChatSources(values: readonly unknown[]): PastChatSource[] {
  const sources = new Map<string, PastChatSource>();
  for (const value of values) {
    const source = decodePastChatSource(value);
    if (!source) continue;
    const key = `${source.chatId}:${source.messageId}`;
    if (!sources.has(key) && sources.size < limits.sourcesPerAnswer) sources.set(key, source);
  }
  return [...sources.values()];
}
