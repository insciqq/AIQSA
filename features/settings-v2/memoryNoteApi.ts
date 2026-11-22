import {
  MEMORY_NOTE_ERROR_CODES,
  memoryLegacySuggestionPageSchema,
  memoryNoteOfferDecisionResultSchema,
  memoryNoteOfferStatusSchema,
  memoryNoteSchema,
  memorySwitchesSchema,
  type MemoryLegacySuggestionAction,
  type MemoryLegacySuggestionPage,
  type MemoryNote,
  type MemoryNoteErrorCode,
  type MemoryNoteOfferDecision,
  type MemoryNoteOfferDecisionResult,
  type MemoryNoteOfferStatus,
  type MemoryNoteUpdate,
  type MemorySwitches,
  type MemorySwitchesUpdate
} from "@/lib/contracts/memoryNote";
import type { ZodType } from "zod";

/**
 * The browser's calls to the memory note's owner routes (`app/api/me/memory/...`): Settings › Memory and the note's
 * answer cards both go through here, so the paths live in one place. Every response is decoded with its contract; a
 * malformed one is a failure with no code, never guessed state.
 */

export const MEMORY_NOTE_ROUTES = Object.freeze({
  note: "/api/me/memory/note",
  preferences: "/api/me/memory/preferences",
  offer: (offerId: string) => `/api/me/memory/offers/${encodeURIComponent(offerId)}`,
  legacy: "/api/me/memory/legacy",
  legacyItem: (id: string) => `/api/me/memory/legacy/${encodeURIComponent(id)}`
});

/** Settings › Memory, as a card links to it. */
export const MEMORY_LIBRARY_PATH = "/?library=memory";

/** A refused or failed request: the route's stable code when it sent one of the note's codes, else null. */
export class MemoryNoteApiError extends Error {
  constructor(readonly code: MemoryNoteErrorCode | null, readonly status: number) {
    super(code ?? `memory_note_http_${status}`);
    this.name = "MemoryNoteApiError";
  }
}

const knownCode = (value: unknown): MemoryNoteErrorCode | null =>
  typeof value === "string" && (MEMORY_NOTE_ERROR_CODES as readonly string[]).includes(value) ? value as MemoryNoteErrorCode : null;

async function request<T>(path: string, schema: ZodType<T> | null, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : undefined
  });
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body ? knownCode((body as { error: unknown }).error) : null;
    throw new MemoryNoteApiError(code, response.status);
  }
  if (!schema) return undefined as T;
  const decoded = schema.safeParse(body);
  if (!decoded.success) throw new MemoryNoteApiError(null, response.status);
  return decoded.data;
}

const json = (value: unknown) => JSON.stringify(value);

export function readMemoryNote(signal?: AbortSignal): Promise<MemoryNote> {
  return request(MEMORY_NOTE_ROUTES.note, memoryNoteSchema, { signal });
}

/** The whole text, guarded by the revision the editor read: `memory_note_conflict` once the note moved on. */
export function saveMemoryNote(update: MemoryNoteUpdate): Promise<MemoryNote> {
  return request(MEMORY_NOTE_ROUTES.note, memoryNoteSchema, { body: json(update), method: "PUT" });
}

export function readMemorySwitches(signal?: AbortSignal): Promise<MemorySwitches> {
  return request(MEMORY_NOTE_ROUTES.preferences, memorySwitchesSchema, { signal });
}

export function updateMemorySwitches(update: MemorySwitchesUpdate): Promise<MemorySwitches> {
  return request(MEMORY_NOTE_ROUTES.preferences, memorySwitchesSchema, { body: json(update), method: "PATCH" });
}

/** An offer's state as the server holds it, so a reloaded answer shows its settled card. */
export function readMemoryNoteOffer(offerId: string, signal?: AbortSignal): Promise<MemoryNoteOfferStatus> {
  return request(MEMORY_NOTE_ROUTES.offer(offerId), memoryNoteOfferStatusSchema, { signal });
}

/** Remember or No thanks; `memory_note_offer_stale` when the offer no longer fits the note or was decided otherwise. */
export function decideMemoryNoteOffer(offerId: string, decision: MemoryNoteOfferDecision): Promise<MemoryNoteOfferDecisionResult> {
  return request(MEMORY_NOTE_ROUTES.offer(offerId), memoryNoteOfferDecisionResultSchema, { body: json({ decision }), method: "POST" });
}

export function readMemoryLegacySuggestions(cursor: string | null, signal?: AbortSignal): Promise<MemoryLegacySuggestionPage> {
  const path = cursor ? `${MEMORY_NOTE_ROUTES.legacy}?cursor=${encodeURIComponent(cursor)}` : MEMORY_NOTE_ROUTES.legacy;
  return request(path, memoryLegacySuggestionPageSchema, { signal });
}

/** Keep answers with the note the suggestion went into; Remove answers with nothing. */
export async function actOnMemoryLegacySuggestion(id: string, action: MemoryLegacySuggestionAction): Promise<MemoryNote | null> {
  if (action === "keep") return request(MEMORY_NOTE_ROUTES.legacyItem(id), memoryNoteSchema, { body: json({ action }), method: "POST" });
  await request(MEMORY_NOTE_ROUTES.legacyItem(id), null, { body: json({ action }), method: "POST" });
  return null;
}

export async function removeAllMemoryLegacySuggestions(): Promise<void> {
  await request(MEMORY_NOTE_ROUTES.legacy, null, { method: "DELETE" });
}
