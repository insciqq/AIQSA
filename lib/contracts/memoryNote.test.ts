import { describe, expect, it } from "vitest";
import { decodeResourceChangeCard } from "./resourceChanges";
import {
  EMPTY_MEMORY_NOTE,
  MEMORY_NOTE_ERROR_CODES,
  MEMORY_NOTE_ERROR_HTTP_STATUS,
  MEMORY_NOTE_MAX_CHARACTERS,
  MEMORY_SWITCH_DEFAULTS,
  decodeMemoryNoteCard,
  memoryFeatures,
  memoryLegacySuggestionActionSchema,
  memoryLegacySuggestionPageSchema,
  memoryLegacySuggestionSchema,
  memoryNoteCardKey,
  memoryNoteChangeAction,
  memoryNoteChangeCardSchema,
  memoryNoteCharacterCount,
  memoryNoteOfferDecisionResultSchema,
  memoryNoteOfferDecisionSchema,
  memoryNoteOfferStatusSchema,
  memoryNoteSchema,
  memoryNoteUndoUpdate,
  memoryNoteUpdateSchema,
  memorySwitchesSchema,
  memorySwitchesUpdateSchema,
  type MemoryNoteChangeCard
} from "./memoryNote";

const note = { text: "Answer in metric units.", revision: 3, lastChangedBy: "agent", updatedAt: "2026-11-22T10:00:00.000Z" } as const;
const added: MemoryNoteChangeCard = {
  version: 1, resource: "memory_note", action: "added", revision: 4, before: null, after: "Call me Sam.", previousText: note.text
};
const offer = { version: 1, resource: "memory_note", action: "offered", offerId: "offer_1", operation: "add", before: null,
  after: "Prefers short answers." } as const;
const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("memory note", () => {
  it("counts the limit in code points, as the database's char_length does", () => {
    expect(MEMORY_NOTE_MAX_CHARACTERS).toBe(6_000);
    expect(memoryNoteCharacterCount("a😀b")).toBe(3);
    const emoji = "😀".repeat(MEMORY_NOTE_MAX_CHARACTERS);
    expect(emoji.length).toBe(2 * MEMORY_NOTE_MAX_CHARACTERS);
    expect(ok(memoryNoteSchema, { ...note, text: emoji })).toBe(true);
    expect(ok(memoryNoteSchema, { ...note, text: `${emoji}a` })).toBe(false);
    expect(ok(memoryNoteSchema, { ...note, text: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS) })).toBe(true);
    expect(ok(memoryNoteSchema, { ...note, text: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1) })).toBe(false);
  });

  it("decodes saved and never-saved notes strictly", () => {
    expect(memoryNoteSchema.parse(note)).toEqual(note);
    expect(memoryNoteSchema.parse(EMPTY_MEMORY_NOTE)).toEqual(EMPTY_MEMORY_NOTE);
    expect(ok(memoryNoteSchema, { ...note, text: "" })).toBe(true);
    expect(ok(memoryNoteSchema, { ...note, extra: true })).toBe(false);
    expect(ok(memoryNoteSchema, { ...EMPTY_MEMORY_NOTE, text: "unsaved" })).toBe(false);
    expect(ok(memoryNoteSchema, { ...EMPTY_MEMORY_NOTE, lastChangedBy: "user" })).toBe(false);
    expect(ok(memoryNoteSchema, { ...note, lastChangedBy: null })).toBe(false);
    expect(ok(memoryNoteSchema, { ...note, lastChangedBy: "AGENT" })).toBe(false);
    expect(ok(memoryNoteSchema, { ...note, updatedAt: "yesterday" })).toBe(false);
    expect(ok(memoryNoteSchema, { ...note, text: "nul\u0000" })).toBe(false);
    expect(ok(memoryNoteSchema, { ...note, text: "lone \uD83D surrogate" })).toBe(false);
  });

  it("guards a Settings save by the revision the editor read", () => {
    expect(memoryNoteUpdateSchema.parse({ text: "", revision: 0 })).toEqual({ text: "", revision: 0 });
    expect(ok(memoryNoteUpdateSchema, { text: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1), revision: 1 })).toBe(false);
    expect(ok(memoryNoteUpdateSchema, { text: "a" })).toBe(false);
    expect(ok(memoryNoteUpdateSchema, { text: "a", revision: -1 })).toBe(false);
    expect(ok(memoryNoteUpdateSchema, { text: "a", revision: 1, lastChangedBy: "agent" })).toBe(false);
  });

  it("lets the master switch turn every part off and each other switch only its own", () => {
    expect(memorySwitchesSchema.parse(MEMORY_SWITCH_DEFAULTS)).toEqual({ memoryEnabled: true, pastChatSearchEnabled: true,
      memorySuggestionsEnabled: true });
    expect(ok(memorySwitchesSchema, { ...MEMORY_SWITCH_DEFAULTS, useMemoryFacts: true })).toBe(false);
    expect(memoryFeatures(MEMORY_SWITCH_DEFAULTS)).toEqual({ note: true, pastChatSearch: true, offers: true });
    expect(memoryFeatures({ ...MEMORY_SWITCH_DEFAULTS, memoryEnabled: false })).toEqual({ note: false, pastChatSearch: false, offers: false });
    expect(memoryFeatures({ ...MEMORY_SWITCH_DEFAULTS, pastChatSearchEnabled: false })).toEqual({ note: true, pastChatSearch: false, offers: true });
    expect(memoryFeatures({ ...MEMORY_SWITCH_DEFAULTS, memorySuggestionsEnabled: false })).toEqual({ note: true, pastChatSearch: true, offers: false });
  });

  it("changes some switches at a time, never none or unknown ones", () => {
    expect(memorySwitchesUpdateSchema.parse({ pastChatSearchEnabled: false })).toEqual({ pastChatSearchEnabled: false });
    expect(ok(memorySwitchesUpdateSchema, {})).toBe(false);
    expect(ok(memorySwitchesUpdateSchema, { referenceChatHistory: false })).toBe(false);
    expect(ok(memorySwitchesUpdateSchema, { memoryEnabled: "no" })).toBe(false);
  });
});

describe("memory note cards", () => {
  it("decodes change cards whose before and after fit their action", () => {
    expect(decodeMemoryNoteCard(added)).toEqual(added);
    const replaced = { ...added, action: "replaced", before: "Call me Sam.", after: "Call me Alex.", previousText: "Call me Sam." };
    expect(decodeMemoryNoteCard(replaced)).toEqual(replaced);
    const removed = { ...added, action: "removed", before: "Call me Sam.", after: null, previousText: "Call me Sam." };
    expect(decodeMemoryNoteCard(removed)).toEqual(removed);
    expect(decodeMemoryNoteCard({ ...added, previousText: "" })).toMatchObject({ previousText: "" });
    expect(decodeMemoryNoteCard({ ...added, before: "x" })).toBeNull();
    expect(decodeMemoryNoteCard({ ...added, after: null })).toBeNull();
    expect(decodeMemoryNoteCard({ ...replaced, after: replaced.before })).toBeNull();
    expect(decodeMemoryNoteCard({ ...removed, after: "x" })).toBeNull();
    expect(decodeMemoryNoteCard({ ...added, after: "   " })).toBeNull();
    expect(decodeMemoryNoteCard({ ...added, after: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1) })).toBeNull();
    expect(decodeMemoryNoteCard({ ...added, revision: 0 })).toBeNull();
    expect(decodeMemoryNoteCard({ ...added, undoable: true })).toBeNull();
    expect(decodeMemoryNoteCard({ ...added, version: 2 })).toBeNull();
  });

  it("decodes offer cards, which carry their offer and no revision", () => {
    expect(decodeMemoryNoteCard(offer)).toEqual(offer);
    expect(decodeMemoryNoteCard({ ...offer, operation: "replace", before: "Prefers long answers." })).toMatchObject({ operation: "replace" });
    expect(decodeMemoryNoteCard({ ...offer, operation: "remove", before: "Lives in Berlin.", after: null })).toMatchObject({ operation: "remove" });
    expect(decodeMemoryNoteCard({ ...offer, operation: "remove" })).toBeNull();
    expect(decodeMemoryNoteCard({ ...offer, state: "pending" })).toBeNull();
    expect(decodeMemoryNoteCard({ ...offer, revision: 1 })).toBeNull();
    expect(decodeMemoryNoteCard({ ...offer, offerId: "not an id" })).toBeNull();
  });

  it("travels with the answer's resource change cards and decodes only as itself", () => {
    const instructions = { version: 1, resource: "instructions", action: "created", presetId: "p1", revision: 1, name: "Mine", diff: null,
      previousText: null };
    expect(decodeResourceChangeCard(instructions)).not.toBeNull();
    expect(decodeMemoryNoteCard(instructions)).toBeNull();
    expect(decodeResourceChangeCard(added)).toEqual(added);
    expect(decodeResourceChangeCard({ ...added, resource: "instructions" })).toBeNull();
  });

  it("keys a change by the revision it left and an offer by its id", () => {
    expect(memoryNoteCardKey(added)).toBe("memory_note:added:4");
    expect(memoryNoteCardKey(memoryNoteChangeCardSchema.parse({ ...added, action: "removed", before: "x", after: null })))
      .toBe("memory_note:removed:4");
    expect(memoryNoteCardKey(offer)).toBe("memory_note:offer:offer_1");
    expect(memoryNoteChangeAction("add")).toBe("added");
    expect(memoryNoteChangeAction("replace")).toBe("replaced");
    expect(memoryNoteChangeAction("remove")).toBe("removed");
  });

  it("undoes a change only while the note is still at the revision it left", () => {
    expect(memoryNoteUndoUpdate(added, { revision: 4 })).toEqual({ text: note.text, revision: 4 });
    expect(memoryNoteUpdateSchema.parse(memoryNoteUndoUpdate(added, { revision: 4 }))).toBeTruthy();
    expect(memoryNoteUndoUpdate(added, { revision: 5 })).toBeNull();
    expect(memoryNoteUndoUpdate(added, null)).toBeNull();
  });
});

describe("memory note offers", () => {
  it("has a decision time exactly when the offer is decided", () => {
    expect(ok(memoryNoteOfferStatusSchema, { offerId: "offer_1", state: "pending", decidedAt: null })).toBe(true);
    expect(ok(memoryNoteOfferStatusSchema, { offerId: "offer_1", state: "accepted", decidedAt: "2026-11-22T10:01:00Z" })).toBe(true);
    expect(ok(memoryNoteOfferStatusSchema, { offerId: "offer_1", state: "dismissed", decidedAt: null })).toBe(false);
    expect(ok(memoryNoteOfferStatusSchema, { offerId: "offer_1", state: "pending", decidedAt: "2026-11-22T10:01:00Z" })).toBe(false);
    expect(ok(memoryNoteOfferStatusSchema, { offerId: "offer_1", state: "expired", decidedAt: null })).toBe(false);
  });

  it("answers a decision with a change card only for an acceptance", () => {
    expect(memoryNoteOfferDecisionSchema.parse({ decision: "accept" })).toEqual({ decision: "accept" });
    expect(ok(memoryNoteOfferDecisionSchema, { decision: "later" })).toBe(false);
    expect(ok(memoryNoteOfferDecisionSchema, { decision: "accept", offerId: "offer_1" })).toBe(false);
    const accepted = { offerId: "offer_1", state: "accepted", decidedAt: "2026-11-22T10:01:00.000Z" };
    expect(ok(memoryNoteOfferDecisionResultSchema, { offer: accepted, change: added })).toBe(true);
    expect(ok(memoryNoteOfferDecisionResultSchema, { offer: accepted, change: null })).toBe(true);
    expect(ok(memoryNoteOfferDecisionResultSchema, { offer: { ...accepted, state: "dismissed" }, change: added })).toBe(false);
  });
});

describe("legacy suggestions", () => {
  const suggestion = { id: "s1", text: "Has a dog named Rex.", origin: "automatic", createdAt: "2026-11-22T09:00:00.000Z" };

  it("decodes non-blank suggestions that fit the note", () => {
    expect(memoryLegacySuggestionSchema.parse(suggestion)).toEqual(suggestion);
    expect(ok(memoryLegacySuggestionSchema, { ...suggestion, origin: "saved_overflow" })).toBe(true);
    expect(ok(memoryLegacySuggestionSchema, { ...suggestion, origin: "SAVED" })).toBe(false);
    expect(ok(memoryLegacySuggestionSchema, { ...suggestion, text: " " })).toBe(false);
    expect(ok(memoryLegacySuggestionSchema, { ...suggestion, text: "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1) })).toBe(false);
    expect(ok(memoryLegacySuggestionSchema, { ...suggestion, confidence: 0.9 })).toBe(false);
  });

  it("pages suggestions once each and takes Keep or Remove", () => {
    expect(ok(memoryLegacySuggestionPageSchema, { suggestions: [suggestion], nextCursor: null })).toBe(true);
    expect(ok(memoryLegacySuggestionPageSchema, { suggestions: [suggestion, suggestion], nextCursor: null })).toBe(false);
    expect(ok(memoryLegacySuggestionPageSchema, { suggestions: [], nextCursor: "" })).toBe(false);
    const many = Array.from({ length: 101 }, (_, index) => ({ ...suggestion, id: `s${index}` }));
    expect(ok(memoryLegacySuggestionPageSchema, { suggestions: many, nextCursor: "next" })).toBe(false);
    expect(ok(memoryLegacySuggestionActionSchema, { action: "keep" })).toBe(true);
    expect(ok(memoryLegacySuggestionActionSchema, { action: "edit" })).toBe(false);
  });
});

describe("memory note errors", () => {
  it("gives every refusal a status", () => {
    for (const code of MEMORY_NOTE_ERROR_CODES) expect(MEMORY_NOTE_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(Object.keys(MEMORY_NOTE_ERROR_HTTP_STATUS).sort()).toEqual([...MEMORY_NOTE_ERROR_CODES].sort());
  });
});
