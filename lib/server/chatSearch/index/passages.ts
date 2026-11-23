import { createHash } from "node:crypto";
import { clipPastChatLine, PAST_CHATS_LIMITS } from "../../../contracts/pastChats";
import { chatExportText } from "../../../domain/chatExport";
import { titleFromMessageContent } from "../../chats/titlePolicy";
import { savedSecretLineFeeds } from "../../redaction/savedSecrets";
import { redactSecretsAndSavedValues } from "../../redaction/screen";
import type { ChatSearchEligibilityFields } from "../eligibility";

/**
 * How a chat becomes past-chat search passages: one unit per turn of its active branch, a user message and the final
 * answer of its completed run, a long turn as overlapping windows. Every passage carries the chat's title and the
 * turn's file names, so they are searchable words; reasoning, tool arguments, tool results and tool events never are.
 *
 * The title is part of the embedded text (decision 2026-11-22): a passage's text is exactly what is embedded and its
 * `contentHash` is the hash of that text, so a later window of a long chat ("and now the second one") still carries
 * its topic into vector search. The cost is that renaming a chat re-embeds that chat's passages, a few calls at the
 * measured sizes, while a turn whose text did not change is never embedded again.
 *
 * Secrets never reach a passage: each message is screened for the owner's saved secret values and for recognized
 * secrets together before it is cut into windows, so a secret on a window boundary stays whole, and every finished passage
 * (title and file names included) is screened once more, so a join cannot form one either.
 *
 * The title a passage carries is the chat's search title (`chatSearchTitle`), and search results show the one their
 * passage carries (`chatSearchPassageTitle`), so a result never names a chat by more than its passages hold.
 */

export const CHAT_SEARCH_PASSAGE_LIMITS = Object.freeze({
  /** A window's body: aimed at, at most, and repeated from the previous window (old Memory's segment sizes). */
  windowTargetChars: 3_000,
  windowMaxChars: 4_000,
  windowOverlapChars: 400,
  /** A message's text scanned for secrets; the rest is withheld unscanned and never indexed. */
  messageScanChars: 100_000,
  /** A message's text indexed; a longer message is cut there, so one turn makes at most a few dozen windows. */
  messageIndexedChars: 60_000,
  /** The question a later window of a long answer repeats as its context. */
  contextQuestionChars: 300,
  /** File names one turn lists, and the line they form. */
  fileNamesPerTurn: PAST_CHATS_LIMITS.readNamesPerMessage,
  fileNamesLineChars: 1_000
});

/** Server-written user turns whose answer is the user's to search, without the turn's own text (it is not their speech). */
const ANSWER_ONLY_TURN_KINDS: ReadonlySet<string> = new Set([
  "mcp_approval_continuation", "subagent_callback", "browser_sign_in_request"
]);

const TITLE_LABEL = "Chat:";
const USER_LABEL = "User: ";
const ASSISTANT_LABEL = "Assistant: ";
const SEGMENT_SEPARATOR = "\n\n";
const HEADER_END = "\n\n";
const CONTINUED = "…";
const REDACTION_MARKER = /\[REDACTED(?::[A-Z_]+|_SECRET)\]/gu;
// C0 controls other than tab and line feed, DEL, and the bidirectional overrides and isolates.
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/gu;

export type ChatSearchSourceMessage = Readonly<{
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  content: unknown;
  createdAt: Date;
  systemTurnKind: string | null;
  scheduledTaskPrompt: boolean;
}>;

/** Where a chat's stored title came from, which decides its search title (`chatSearchTitle`). */
export type ChatSearchTitleOrigin = Readonly<{
  /**
   * The server set the title, never the owner: at creation, from the first message's first line (`titleRevision`
   * still 0, a branch copy's included) or by the title model from the first turn.
   */
  serverSet: boolean;
  /** The chat's first user message, which a server-set title is made from; null when not needed or there is none. */
  firstMessage: Readonly<{ content: unknown; excluded: boolean }> | null;
}>;

/** What the indexer reads of one chat, all from one consistent snapshot. */
export type ChatSearchChatSnapshot = Readonly<{
  chatId: string;
  title: string;
  titleOrigin: ChatSearchTitleOrigin;
  activeLeafMessageId: string | null;
  eligibility: ChatSearchEligibilityFields;
  /** The active branch, root first, without the messages kept out of search (`ChatSearchExcludedMessage`). */
  path: readonly ChatSearchSourceMessage[];
  /** Names of the ready files on each path message, oldest first: uploads on user messages, generated files on answers. */
  fileNames: ReadonlyMap<string, readonly string[]>;
}>;

/** One passage as the index should hold it; `(userMessageId, ordinal)` is its key within the chat. */
export type ChatSearchPassageDraft = Readonly<{
  userMessageId: string;
  assistantMessageId: string;
  turnAt: Date;
  ordinal: number;
  text: string;
  contentHash: string;
}>;

type Turn = Readonly<{ answer: ChatSearchSourceMessage; answerOnly: boolean; user: ChatSearchSourceMessage }>;
type Range = Readonly<{ end: number; start: number }>;
type Segment = Readonly<{ label: string; labelStart: number; textEnd: number; textStart: number; user: boolean }>;

export function chatSearchContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The turns of an active branch that the index holds, in order. */
export function chatSearchTurns(path: readonly ChatSearchSourceMessage[]): readonly Turn[] {
  const turns: Turn[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const user = path[index]!;
    const answer = path[index + 1]!;
    if (user.role !== "user" || answer.role !== "assistant" || answer.parentMessageId !== user.id) continue;
    // Only a settled answer: a streaming, failed or stopped one is not the turn's final answer.
    if (answer.status !== "complete") continue;
    // A scheduled task's prompt and every answer to it stay out, as they stayed out of Memory.
    if (user.scheduledTaskPrompt) continue;
    if (user.systemTurnKind !== null && !ANSWER_ONLY_TURN_KINDS.has(user.systemTurnKind)) continue;
    turns.push({ answer, answerOnly: user.systemTurnKind !== null, user });
  }
  return turns;
}

function surrogateSafe(value: string, index: number): number {
  const bounded = Math.max(0, Math.min(index, value.length));
  if (bounded > 0 && bounded < value.length) {
    const previous = value.charCodeAt(bounded - 1);
    const next = value.charCodeAt(bounded);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return bounded - 1;
  }
  return bounded;
}

function markerRanges(value: string): Range[] {
  return [...value.matchAll(REDACTION_MARKER)].map((match) => ({ end: match.index + match[0].length, start: match.index }));
}

/**
 * An end `index` moved out of any protected range: before the range when that keeps the window non-empty, else
 * after it when that stays within `limit`, else before it.
 */
function outsideEnd(index: number, ranges: readonly Range[], windowStart: number, limit: number): number {
  const containing = ranges.find((range) => index > range.start && index < range.end);
  if (!containing) return index;
  if (containing.start > windowStart) return containing.start;
  return containing.end <= limit ? containing.end : containing.start;
}

/** At most `maximum` UTF-16 units, cut between code points and outside redaction markers, marked when cut. */
function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const end = surrogateSafe(value, outsideEnd(maximum, markerRanges(value), 0, maximum));
  return `${value.slice(0, end).trimEnd()} ${CONTINUED}`;
}

/** The normalization searchable text gets: line breaks as LF, unsafe controls as spaces. */
function normalizedText(value: string): string {
  return savedSecretLineFeeds(value).replace(UNSAFE_CONTROLS, " ");
}

/**
 * The saved values beside the forms they take in normalized text, once each, so a value saved with CRLF line endings
 * or a control character still matches the text it was normalized into (review 2026-11-23).
 */
function normalizedSavedValues(savedSecretValues: readonly string[]): readonly string[] {
  const forms = new Set(savedSecretValues);
  for (const value of savedSecretValues) {
    const normalized = normalizedText(value);
    if (normalized !== value && normalized.trim()) forms.add(normalized);
  }
  return [...forms];
}

/**
 * A message's searchable text: its text blocks, normalized, screened for secrets and bounded. The saved values are
 * normalized as the text is, so a value saved with CRLF line endings or a control character still matches, and the
 * values and recognized secrets are found in the same normalized text and replaced together
 * (`redactSecretsAndSavedValues`), so neither can break the other.
 */
export function chatSearchMessageText(content: unknown, savedSecretValues: readonly string[]): string {
  const normalized = normalizedText(chatExportText(content));
  if (!normalized.trim()) return "";
  // A secret on a scan window's boundary stays whole, and text past the scan bound is withheld behind a marker.
  const redacted = redactSecretsAndSavedValues(normalized, normalizedSavedValues(savedSecretValues), {
    maxCodeUnits: CHAT_SEARCH_PASSAGE_LIMITS.messageScanChars,
    windowCodeUnits: CHAT_SEARCH_PASSAGE_LIMITS.messageScanChars
  }).text.trim();
  return boundedText(redacted, CHAT_SEARCH_PASSAGE_LIMITS.messageIndexedChars);
}

function cleanLine(value: string, maximum: number): string {
  return clipPastChatLine(value.replace(BIDI_CONTROLS, " "), maximum);
}

/**
 * One line of a passage's header (the chat's title, a file name): screened whole first, then made one line and
 * clipped, since a secret clipped first is no longer recognized and its start would stay (review 2026-11-23).
 */
function headerLine(value: string, savedForms: readonly string[], maximum: number): string {
  const screened = redactSecretsAndSavedValues(value, savedForms, {
    maxCodeUnits: CHAT_SEARCH_PASSAGE_LIMITS.messageScanChars,
    windowCodeUnits: CHAT_SEARCH_PASSAGE_LIMITS.messageScanChars
  }).text;
  return cleanLine(screened, maximum);
}

function turnFileNames(turn: Turn, fileNames: ReadonlyMap<string, readonly string[]>, savedForms: readonly string[]): string[] {
  const names: string[] = [];
  let length = 0;
  for (const raw of [...(fileNames.get(turn.user.id) ?? []), ...(fileNames.get(turn.answer.id) ?? [])]) {
    const name = headerLine(raw, savedForms, PAST_CHATS_LIMITS.fileNameChars);
    if (!name || names.includes(name)) continue;
    if (names.length >= CHAT_SEARCH_PASSAGE_LIMITS.fileNamesPerTurn) break;
    if (length + name.length + 2 > CHAT_SEARCH_PASSAGE_LIMITS.fileNamesLineChars) break;
    names.push(name);
    length += name.length + 2;
  }
  return names;
}

/** A message's first line as the fallback title takes it (`titleFromMessageContent`). */
function firstLineTitle(text: string): string {
  return titleFromMessageContent({ blocks: [{ text, type: "text" }] });
}

/**
 * The title past-chat search knows a chat by, in passage headers, results and reads alike: the stored title, except
 * that a title the server made from the first message never brings back what search withholds of that message. A new
 * chat is named after its first message's first line, and the title model names it after its first turn, so when that
 * message is kept out of search (`ChatSearchExcludedMessage`) the chat goes untitled (""), and when screening changes
 * its first line (a secret saved or recognized there) the screened line takes the place of the line as written, or
 * the chat goes untitled when its title does not hold that line. A title the owner set is the owner's words and stays.
 * Wherever the result is shown it is screened again, like any title.
 */
export function chatSearchTitle(title: string, origin: ChatSearchTitleOrigin, savedSecretValues: readonly string[]): string {
  const first = origin.firstMessage;
  if (!origin.serverSet || first === null) return title;
  if (first.excluded) return "";
  const written = firstLineTitle(chatExportText(first.content));
  const screened = firstLineTitle(chatSearchMessageText(first.content, savedSecretValues));
  if (written === screened) return title;
  return written && title.includes(written) ? title.replaceAll(written, () => screened) : "";
}

/** The header every passage of a turn starts with; it always ends with a blank line (`chatSearchPassageBody`). */
function passageHeader(title: string, files: readonly string[], savedForms: readonly string[]): string {
  const chat = `${TITLE_LABEL} ${headerLine(title, savedForms, PAST_CHATS_LIMITS.titleChars)}`.trimEnd();
  return files.length > 0 ? `${chat}\nFiles: ${files.join(", ")}${HEADER_END}` : `${chat}${HEADER_END}`;
}

/** A passage's text without its header (the chat's title and the turn's file names): the turn's own words. */
export function chatSearchPassageBody(text: string): string {
  const end = text.indexOf(HEADER_END);
  return end === -1 ? text : text.slice(end + HEADER_END.length);
}

/** The search title a passage's header names (`chatSearchTitle`, one line, screened); "" for none. */
export function chatSearchPassageTitle(text: string): string {
  if (!text.startsWith(TITLE_LABEL)) return "";
  const end = text.indexOf("\n");
  return text.slice(TITLE_LABEL.length, end === -1 ? text.length : end).trim();
}

function nextBoundary(value: string, from: number, hardEnd: number): number | null {
  const paragraph = value.indexOf("\n\n", from);
  if (paragraph !== -1 && paragraph <= hardEnd) return paragraph;
  for (let index = from; index < hardEnd; index += 1) {
    if (!".!?…".includes(value[index] ?? "")) continue;
    let end = index + 1;
    while (end < hardEnd && "\"'»”)]".includes(value[end] ?? "")) end += 1;
    if (end >= value.length || /\s/u.test(value[end] ?? "")) return end;
  }
  for (let index = from; index < hardEnd; index += 1) {
    if (/\s/u.test(value[index] ?? "")) return index;
  }
  return null;
}

/** A window's start inside the overlap, moved to the beginning of a word when one starts soon after. */
function overlapStart(value: string, from: number, end: number): number {
  const limit = Math.min(end - 1, from + 100);
  for (let index = from; index < limit; index += 1) {
    if (/\s/u.test(value[index] ?? "") && !/\s/u.test(value[index + 1] ?? "")) return index + 1;
  }
  return from;
}

/** Overlapping windows of `body`, never cut inside a protected range (labels, redaction markers) or a surrogate pair. */
export function chatSearchWindowSpans(body: string, protectedRanges: readonly Range[]): readonly Range[] {
  const { windowMaxChars: maximum, windowOverlapChars: overlap, windowTargetChars: target } = CHAT_SEARCH_PASSAGE_LIMITS;
  if (body.length <= maximum) return [{ end: body.length, start: 0 }];
  const spans: Range[] = [];
  let start = 0;
  while (start < body.length) {
    const targetEnd = Math.min(body.length, start + target);
    const hardEnd = Math.min(body.length, start + maximum);
    let end = targetEnd === body.length ? body.length : nextBoundary(body, targetEnd, hardEnd) ?? targetEnd;
    end = surrogateSafe(body, outsideEnd(end, protectedRanges, start, hardEnd));
    if (end <= start) end = surrogateSafe(body, hardEnd) > start ? surrogateSafe(body, hardEnd) : Math.min(body.length, start + 2);
    spans.push({ end, start });
    if (end >= body.length) break;
    let next = overlapStart(body, Math.max(start + 1, end - overlap), end);
    const containing = protectedRanges.find((range) => next > range.start && next < range.end);
    if (containing) next = containing.start;
    next = surrogateSafe(body, next);
    start = next > start && next < end ? next : end;
  }
  return spans;
}

function turnPassages(
  turn: Turn,
  title: string,
  fileNames: ReadonlyMap<string, readonly string[]>,
  savedSecretValues: readonly string[]
): ChatSearchPassageDraft[] {
  const question = turn.answerOnly ? "" : chatSearchMessageText(turn.user.content, savedSecretValues);
  const answer = chatSearchMessageText(turn.answer.content, savedSecretValues);
  const savedForms = normalizedSavedValues(savedSecretValues);
  const files = turnFileNames(turn, fileNames, savedForms);
  if (!question && !answer && files.length === 0) return [];

  let body = "";
  const segments: Segment[] = [];
  for (const [label, text, user] of [[USER_LABEL, question, true], [ASSISTANT_LABEL, answer, false]] as const) {
    if (!text) continue;
    if (body) body += SEGMENT_SEPARATOR;
    const labelStart = body.length;
    body += label + text;
    segments.push({ label, labelStart, textEnd: body.length, textStart: labelStart + label.length, user });
  }
  const protectedRanges = [
    ...segments.map((segment) => ({ end: segment.textStart, start: segment.labelStart })),
    ...markerRanges(body)
  ];
  const header = passageHeader(title, files, savedForms);
  const userSegment = segments.find((segment) => segment.user);
  const context = userSegment
    ? `${USER_LABEL}${boundedText(question, CHAT_SEARCH_PASSAGE_LIMITS.contextQuestionChars)}${SEGMENT_SEPARATOR}`
    : "";

  return chatSearchWindowSpans(body, protectedRanges).map((span, ordinal) => {
    // The message the window starts in, or the next one when it starts between two.
    const segment = segments.find((candidate) => span.start < candidate.textEnd);
    const slice = body.slice(span.start, span.end);
    // A window that starts inside a message names whose words it continues; one in an answer repeats the question.
    let prefix = "";
    if (segment && span.start > segment.labelStart) {
      prefix = `${segment.user ? "" : context}${segment.label}${CONTINUED}`;
    } else if (segment && !segment.user) {
      prefix = context;
    }
    const raw = `${header}${prefix}${slice.trim()}`;
    // Once more as a whole, in one pass, so no join of header, context and window forms a secret either.
    const text = redactSecretsAndSavedValues(raw, savedForms).text;
    return {
      assistantMessageId: turn.answer.id,
      contentHash: chatSearchContentHash(text),
      ordinal,
      text,
      turnAt: turn.user.createdAt,
      userMessageId: turn.user.id
    };
  });
}

/**
 * The passages the index should hold for an eligible chat as the snapshot shows it (the pass checks
 * `chatSearchEligible` first); a chat without an active branch has none. Deterministic: the same snapshot and saved
 * values give the same texts and hashes.
 */
export function buildChatSearchPassages(
  snapshot: ChatSearchChatSnapshot,
  savedSecretValues: readonly string[]
): readonly ChatSearchPassageDraft[] {
  if (snapshot.activeLeafMessageId === null) return [];
  const title = chatSearchTitle(snapshot.title, snapshot.titleOrigin, savedSecretValues);
  return chatSearchTurns(snapshot.path).flatMap((turn) =>
    turnPassages(turn, title, snapshot.fileNames, savedSecretValues));
}
