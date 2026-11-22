import { z } from "zod";

/**
 * Client-safe contract of the user's memory note (operator decision 2026-11-22), which replaces Personal Memory: one
 * short plain text per user that every ordinary personal turn reads (`UserMemoryNote`). The user edits it in Settings ›
 * Memory. The agent changes it only through `manage_memory`: on an explicit request to remember, change or forget
 * something it changes the note at once and the answer shows a change card with Undo; when the user states a lasting
 * rule without asking, it records an offer only (`MemoryNoteOffer`), and nothing is written until the user accepts the
 * offer card. The old Memory's facts wait as legacy suggestions the user keeps or removes. Three switches govern it,
 * `memoryEnabled` above the other two.
 *
 * Wire values are lower case; the database's enums are their upper-case names. Cards follow the answer cards of
 * `resourceChanges.ts`: an immutable payload in the owner's answer, decoded by the same rules wherever it shows, and
 * Undo is the Settings save guarded by the revision the change left, so it refuses once anything changed the note since.
 */

/**
 * The note's limit in characters, counted as Unicode code points like PostgreSQL `char_length`: the `UserMemoryNote`
 * CHECK holds the same bound. An emoji is one character, so a browser's `maxLength`, which counts UTF-16 units, does
 * not match it; count with `memoryNoteCharacterCount`.
 */
export const MEMORY_NOTE_MAX_CHARACTERS = 6_000;

export const MANAGE_MEMORY_TOOL_NAME = "manage_memory";

/** Legacy suggestions one page lists. */
export const MEMORY_LEGACY_SUGGESTIONS_PAGE_SIZE = 100;

/** Characters of an opaque page cursor. */
export const MEMORY_NOTE_CURSOR_MAX_LENGTH = 512;

/** Who made the note's latest change: the user (Settings, Undo, an accepted offer, a kept suggestion) or the agent. */
export const MEMORY_NOTE_AUTHORS = ["user", "agent"] as const;
export type MemoryNoteAuthor = (typeof MEMORY_NOTE_AUTHORS)[number];

/** What a change or an offer does to the note: append text, replace text in it, or remove text from it. */
export const MEMORY_NOTE_OPERATIONS = ["add", "replace", "remove"] as const;
export type MemoryNoteOperation = (typeof MEMORY_NOTE_OPERATIONS)[number];

/** A change card's action, one per operation. */
export const MEMORY_NOTE_CHANGE_ACTIONS = ["added", "replaced", "removed"] as const;
export type MemoryNoteChangeAction = (typeof MEMORY_NOTE_CHANGE_ACTIONS)[number];

export const MEMORY_NOTE_OFFER_STATES = ["pending", "accepted", "dismissed"] as const;
export type MemoryNoteOfferState = (typeof MEMORY_NOTE_OFFER_STATES)[number];

export const MEMORY_NOTE_OFFER_DECISIONS = ["accept", "dismiss"] as const;
export type MemoryNoteOfferDecision = (typeof MEMORY_NOTE_OFFER_DECISIONS)[number];

/** Where a legacy suggestion came from: a fact the old Memory learned, or a saved fact that did not fit the note. */
export const MEMORY_LEGACY_SUGGESTION_ORIGINS = ["automatic", "saved_overflow"] as const;
export type MemoryLegacySuggestionOrigin = (typeof MEMORY_LEGACY_SUGGESTION_ORIGINS)[number];

export const MEMORY_LEGACY_SUGGESTION_ACTIONS = ["keep", "remove"] as const;
export type MemoryLegacySuggestionAction = (typeof MEMORY_LEGACY_SUGGESTION_ACTIONS)[number];

/** Refusals of the note, offer and suggestion routes; the body is `memoryNoteErrorResponseSchema`, `{ error: code, ... }`. */
export const MEMORY_NOTE_ERROR_CODES = [
  /** The request is malformed or its text is over the limit. */
  "memory_note_invalid",
  /** The change, an accepted offer or a kept suggestion would leave the note over the limit; nothing was written. */
  "memory_note_too_long",
  /** The note changed since the revision the request names (a Settings save or Undo); nothing was written. */
  "memory_note_conflict",
  /** Memory is off for this user (`memoryEnabled`). */
  "memory_disabled",
  /** Unknown, foreign and already removed offers get the same refusal. */
  "memory_note_offer_not_found",
  /** The note no longer holds the text the offer replaces or removes, or the offer was decided otherwise. */
  "memory_note_offer_stale",
  "memory_legacy_suggestion_not_found"
] as const;
export type MemoryNoteErrorCode = (typeof MEMORY_NOTE_ERROR_CODES)[number];

export const MEMORY_NOTE_ERROR_HTTP_STATUS = Object.freeze({
  memory_note_invalid: 400,
  memory_note_too_long: 409,
  memory_note_conflict: 409,
  memory_disabled: 409,
  memory_note_offer_not_found: 404,
  memory_note_offer_stale: 409,
  memory_legacy_suggestion_not_found: 404
} satisfies Record<MemoryNoteErrorCode, number>);

/** Why a text was refused as `memory_note_invalid` beyond its shape: it holds a credential or a saved secret's value. */
export const MEMORY_NOTE_INVALID_REASONS = ["secret"] as const;
export type MemoryNoteInvalidReason = (typeof MEMORY_NOTE_INVALID_REASONS)[number];

/** Characters a refusal's `message` holds at most. */
export const MEMORY_NOTE_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * A refusal's body. `reason` and `message` explain a `memory_note_invalid` whose text holds a credential, which belongs
 * in Settings › Secrets; `characters` and `limit` say how long a `memory_note_too_long` change would have left the note.
 * The routes' other answers (`unauthorized`, `forbidden`, `request_body_too_large`, `memory_note_unavailable` with 503)
 * are generic and not refusals of the note.
 */
export const memoryNoteErrorResponseSchema = z.strictObject({
  error: z.enum(MEMORY_NOTE_ERROR_CODES),
  reason: z.enum(MEMORY_NOTE_INVALID_REASONS).optional(),
  message: z.string().min(1).max(MEMORY_NOTE_ERROR_MESSAGE_MAX_LENGTH).optional(),
  characters: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.literal(MEMORY_NOTE_MAX_CHARACTERS).optional()
});
export type MemoryNoteErrorResponse = z.infer<typeof memoryNoteErrorResponseSchema>;

/** Characters as the note's limit counts them (Unicode code points). */
export function memoryNoteCharacterCount(value: string): number {
  return Array.from(value).length;
}

/** At most `maximum` code points, without counting past what decides it. */
function withinCharacters(value: string, maximum: number): boolean {
  if (value.length <= maximum) return true;
  // Each code point takes one or two UTF-16 units.
  return value.length <= maximum * 2 && memoryNoteCharacterCount(value) <= maximum;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
// PostgreSQL text holds neither; a lone surrogate would be stored changed, and Undo then compares a different text.
const UNSTORABLE_PATTERN = /[\u0000\uD800-\uDFFF]/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

const idSchema = z.string().regex(ID_PATTERN);
const timestampSchema = z.string().max(64)
  .refine((value) => ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), "invalid timestamp");
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveRevisionSchema = revisionSchema.min(1);
const cursorSchema = z.string().min(1).max(MEMORY_NOTE_CURSOR_MAX_LENGTH).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "invalid cursor");

/** The whole note: possibly empty, within the limit, storable. */
export const memoryNoteTextSchema = z.string()
  .refine((value) => withinCharacters(value, MEMORY_NOTE_MAX_CHARACTERS), "the note is over its limit")
  .refine((value) => !UNSTORABLE_PATTERN.test(value), "the note holds characters that cannot be stored");

/** A part of the note a change or offer adds, replaces or removes, or a legacy suggestion: not blank. */
export const memoryNotePassageSchema = memoryNoteTextSchema.refine((value) => value.trim().length > 0, "the text is blank");

/**
 * The note as Settings and the agent read it. Revision 0 is a note never saved: empty, with no author or time. A saved
 * note may be empty again after the user cleared it.
 */
export const memoryNoteSchema = z.strictObject({
  text: memoryNoteTextSchema,
  revision: revisionSchema,
  lastChangedBy: z.enum(MEMORY_NOTE_AUTHORS).nullable(),
  updatedAt: timestampSchema.nullable()
}).refine((note) => note.revision === 0
  ? note.text === "" && note.lastChangedBy === null && note.updatedAt === null
  : note.lastChangedBy !== null && note.updatedAt !== null, "a note never saved is empty and has no author or time");
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

export const EMPTY_MEMORY_NOTE: MemoryNote = Object.freeze({ text: "", revision: 0, lastChangedBy: null, updatedAt: null });

/**
 * A Settings save, and a change card's Undo: the whole new text, guarded by the revision the editor read (0 when no note
 * was saved yet); `memory_note_conflict` when the note moved on since.
 */
export const memoryNoteUpdateSchema = z.strictObject({
  text: memoryNoteTextSchema,
  revision: revisionSchema
});
export type MemoryNoteUpdate = z.infer<typeof memoryNoteUpdateSchema>;

/** The user's three Memory switches (`UserSettings`); each defaults to on. */
export const memorySwitchesSchema = z.strictObject({
  /** Master switch: off, no turn reads the note, and the agent neither changes, offers nor searches past chats. */
  memoryEnabled: z.boolean(),
  /** The agent may search and read the user's past chats (`pastChats.ts`). */
  pastChatSearchEnabled: z.boolean(),
  /** The agent may offer to remember a lasting rule the user stated; explicit requests work without it. */
  memorySuggestionsEnabled: z.boolean()
});
export type MemorySwitches = z.infer<typeof memorySwitchesSchema>;

export const MEMORY_SWITCH_DEFAULTS: MemorySwitches = Object.freeze({
  memoryEnabled: true, pastChatSearchEnabled: true, memorySuggestionsEnabled: true
});

/** A change to some of the switches; the rest keep their values. */
export const memorySwitchesUpdateSchema = memorySwitchesSchema.partial()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), "no switch to change");
export type MemorySwitchesUpdate = z.infer<typeof memorySwitchesUpdateSchema>;

export type MemoryFeatures = Readonly<{
  /** Turns read the note, and the agent may change it on an explicit request. */
  note: boolean;
  pastChatSearch: boolean;
  /** The agent may offer to remember what the user did not ask it to. */
  offers: boolean;
}>;

/** What the switches allow: the master switch turns everything off, the others only their own part. */
export function memoryFeatures(switches: MemorySwitches): MemoryFeatures {
  return {
    note: switches.memoryEnabled,
    pastChatSearch: switches.memoryEnabled && switches.pastChatSearchEnabled,
    offers: switches.memoryEnabled && switches.memorySuggestionsEnabled
  };
}

const CHANGE_ACTION_BY_OPERATION = Object.freeze({
  add: "added", replace: "replaced", remove: "removed"
} satisfies Record<MemoryNoteOperation, MemoryNoteChangeAction>);

/** The change card's action for what was done, as an accepted offer's card names it. */
export function memoryNoteChangeAction(operation: MemoryNoteOperation): MemoryNoteChangeAction {
  return CHANGE_ACTION_BY_OPERATION[operation];
}

/** `before` is the text taken out (replace, remove), `after` the text put in (add, replace); a replacement changes it. */
function beforeAfterFit(operation: MemoryNoteOperation, before: string | null, after: string | null): boolean {
  switch (operation) {
    case "add": return before === null && after !== null;
    case "replace": return before !== null && after !== null && before !== after;
    case "remove": return before !== null && after === null;
  }
}

const operationOf = (action: MemoryNoteChangeAction): MemoryNoteOperation =>
  action === "added" ? "add" : action === "replaced" ? "replace" : "remove";

/**
 * A change the agent made to the note, or that accepting an offer made: it already happened when the card shows.
 * `revision` is the note's revision the change left, which Undo is guarded by; `previousText` is the whole note before
 * it ("" when there was none), which Undo writes back. The note keeps no earlier versions, so the card carries them; it
 * travels only with its owner's answer (shares and exports leave cards out).
 */
export const memoryNoteChangeCardSchema = z.strictObject({
  version: z.literal(1),
  resource: z.literal("memory_note"),
  action: z.enum(MEMORY_NOTE_CHANGE_ACTIONS),
  revision: positiveRevisionSchema,
  before: memoryNotePassageSchema.nullable(),
  after: memoryNotePassageSchema.nullable(),
  previousText: memoryNoteTextSchema
}).refine((card) => beforeAfterFit(operationOf(card.action), card.before, card.after), "before and after do not fit the action");
export type MemoryNoteChangeCard = z.infer<typeof memoryNoteChangeCardSchema>;

/**
 * An offer the agent made: "Remember this for future chats?" with Remember and No thanks. It changed nothing; only the
 * user's decision does, by `offerId` (`MemoryNoteOffer.id`). The payload never changes, so its state is read from the
 * server (`MemoryNoteOfferStatus`).
 */
export const memoryNoteOfferCardSchema = z.strictObject({
  version: z.literal(1),
  resource: z.literal("memory_note"),
  action: z.literal("offered"),
  offerId: idSchema,
  operation: z.enum(MEMORY_NOTE_OPERATIONS),
  before: memoryNotePassageSchema.nullable(),
  after: memoryNotePassageSchema.nullable()
}).refine((card) => beforeAfterFit(card.operation, card.before, card.after), "before and after do not fit the operation");
export type MemoryNoteOfferCard = z.infer<typeof memoryNoteOfferCardSchema>;

export const memoryNoteCardSchema = z.union([memoryNoteChangeCardSchema, memoryNoteOfferCardSchema]);
export type MemoryNoteCard = MemoryNoteChangeCard | MemoryNoteOfferCard;

/** A card from an answer's artifact payload, or null when it is not a valid memory note card. */
export function decodeMemoryNoteCard(value: unknown): MemoryNoteCard | null {
  const result = memoryNoteCardSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** What makes two cards the same, so a repeated delivery shows once: a change is the revision it left, an offer its id. */
export function memoryNoteCardKey(card: MemoryNoteCard): string {
  return card.action === "offered" ? `memory_note:offer:${card.offerId}` : `memory_note:${card.action}:${card.revision}`;
}

/** Whether Undo can still apply: nothing changed the note since this change. */
export function memoryNoteChangeUndoable(card: MemoryNoteChangeCard, current: Pick<MemoryNote, "revision"> | null): boolean {
  return current !== null && current.revision === card.revision;
}

/**
 * The Settings save a change card's Undo sends, on the web and in Telegram alike: the text before the change, guarded by
 * the revision the change left. Null when the note changed since, so Undo sends nothing.
 */
export function memoryNoteUndoUpdate(card: MemoryNoteChangeCard, current: Pick<MemoryNote, "revision"> | null): MemoryNoteUpdate | null {
  return memoryNoteChangeUndoable(card, current) ? { text: card.previousText, revision: card.revision } : null;
}

/** An offer's state as the server holds it; `decidedAt` is set once it is no longer pending. */
export const memoryNoteOfferStatusSchema = z.strictObject({
  offerId: idSchema,
  state: z.enum(MEMORY_NOTE_OFFER_STATES),
  decidedAt: timestampSchema.nullable()
}).refine((status) => (status.state === "pending") === (status.decidedAt === null), "only a pending offer has no decision time");
export type MemoryNoteOfferStatus = z.infer<typeof memoryNoteOfferStatusSchema>;

/** The user's answer to an offer card: Remember or No thanks. */
export const memoryNoteOfferDecisionSchema = z.strictObject({
  decision: z.enum(MEMORY_NOTE_OFFER_DECISIONS)
});
export type MemoryNoteOfferDecisionRequest = z.infer<typeof memoryNoteOfferDecisionSchema>;

/**
 * The answer to a decision: the offer's state, and the change an acceptance made when this request made it, which the
 * card then shows as a change card with Undo. A repeated decision returns the state with no change.
 */
export const memoryNoteOfferDecisionResultSchema = z.strictObject({
  offer: memoryNoteOfferStatusSchema,
  change: memoryNoteChangeCardSchema.nullable()
}).refine((result) => result.change === null || result.offer.state === "accepted", "only an accepted offer made a change");
export type MemoryNoteOfferDecisionResult = z.infer<typeof memoryNoteOfferDecisionResultSchema>;

/** A fact from the old Memory waiting for its owner: Keep moves its text into the note, Remove deletes it. */
export const memoryLegacySuggestionSchema = z.strictObject({
  id: idSchema,
  text: memoryNotePassageSchema,
  origin: z.enum(MEMORY_LEGACY_SUGGESTION_ORIGINS),
  createdAt: timestampSchema
});
export type MemoryLegacySuggestion = z.infer<typeof memoryLegacySuggestionSchema>;

/** One page of the user's legacy suggestions, oldest first; `nextCursor` reads the next. */
export const memoryLegacySuggestionPageSchema = z.strictObject({
  suggestions: z.array(memoryLegacySuggestionSchema).max(MEMORY_LEGACY_SUGGESTIONS_PAGE_SIZE),
  nextCursor: cursorSchema.nullable()
}).refine((page) => new Set(page.suggestions.map((suggestion) => suggestion.id)).size === page.suggestions.length,
  "a suggestion is listed twice");
export type MemoryLegacySuggestionPage = z.infer<typeof memoryLegacySuggestionPageSchema>;

/** Keep or Remove one suggestion; both answer with the note as it is afterwards (`memoryNoteSchema`), changed only by Keep. */
export const memoryLegacySuggestionActionSchema = z.strictObject({
  action: z.enum(MEMORY_LEGACY_SUGGESTION_ACTIONS)
});
export type MemoryLegacySuggestionActionRequest = z.infer<typeof memoryLegacySuggestionActionSchema>;
