import type { ComposerSessionKey } from "./composerSessionStore";
import { randomUUID } from "@/lib/browser/randomUUID";
import { decodeComposerComments, type PendingComposerComment } from "./composerComments";

export const COMPOSER_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const COMPOSER_DRAFT_MAX_RECORDS = 50;
// Bounds are serialized UTF-16 code units, including record metadata. The
// record bound is the only bound on one chat's unsent text and comments
// (operator, 2026-09-30); the entry holds at least two full records.
export const COMPOSER_DRAFT_MAX_RECORD_SIZE = 512 * 1024;
export const COMPOSER_DRAFT_MAX_ENTRY_SIZE = 1024 * 1024;
const DRAFT_EPOCH_PREFIX = "aiqsa.composerDraftEpoch.v1:";
const DRAFT_EPOCH_MAX_SIZE = 128;
const MAX_DRAFT_EPOCHS = 50;

export type StoredComposerDraft = Readonly<{
  sessionKey: ComposerSessionKey;
  draft: string;
  comments?: readonly PendingComposerComment[];
  savedAt: number;
}>;

export type StoredComposerInput = Readonly<{ draft: string; comments?: readonly PendingComposerComment[] }>;

export function composerDraftStorageKey(accountId: string): string {
  return `aiqsa.composerDrafts.v1:${encodeURIComponent(accountId)}`;
}

export function isStoredComposerSessionKey(value: unknown): value is ComposerSessionKey {
  if (typeof value !== "string" || value.length > 512) return false;
  if (!/^(?:chat:[^:]+|blank:(?:(?:excluded:)?(?:root|folder:[^:]+)|project:[^:]+:(?:root|folder:[^:]+)))$/u.test(value)) return false;
  try { return value.split(":").every(segment => Boolean(decodeURIComponent(segment))); } catch { return false; }
}

function storedRecord(sessionKey: ComposerSessionKey, input: StoredComposerInput, savedAt: number): StoredComposerDraft {
  const comments = decodeComposerComments(input.comments);
  return { sessionKey, draft: input.draft, ...(comments.length ? { comments } : {}), savedAt };
}

function recordFits(record: StoredComposerDraft): boolean {
  return JSON.stringify(record).length <= COMPOSER_DRAFT_MAX_RECORD_SIZE;
}

/** Whether this unsent input fits one stored record. Checked before a comment
 * is added or changed, so the user is told instead of losing a stored copy. */
export function composerInputFitsStoredRecord(sessionKey: ComposerSessionKey, input: StoredComposerInput, now = Date.now()): boolean {
  return recordFits(storedRecord(sessionKey, input, now));
}

// Session keys whose latest input was too large to store, per account. The
// previous stored copy stays; the composer says a reload restores that copy.
const refusedRecords = new Set<string>();
const refusalListeners = new Set<() => void>();
const refusalKey = (accountId: string, sessionKey: ComposerSessionKey) => `${accountId}\n${sessionKey}`;

function setRefused(accountId: string, sessionKey: ComposerSessionKey, refused: boolean): void {
  const id = refusalKey(accountId, sessionKey);
  if (refusedRecords.has(id) === refused) return;
  if (refused) refusedRecords.add(id);
  else refusedRecords.delete(id);
  for (const listener of refusalListeners) listener();
}

export function subscribeComposerDraftRefusals(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => { refusalListeners.delete(listener); };
}

export function composerDraftTooLargeToStore(accountId: string, sessionKey: ComposerSessionKey): boolean {
  return refusedRecords.has(refusalKey(accountId, sessionKey));
}

function serialize(records: readonly StoredComposerDraft[], epoch?: string | null): string {
  return JSON.stringify({ version: 1, ...(epoch ? { epoch } : {}), records });
}

function bounded(records: readonly StoredComposerDraft[], epoch?: string | null): StoredComposerDraft[] {
  const result = [...records].sort((a, b) => a.savedAt - b.savedAt)
    // Structural guard for a corrupt or foreign entry; writes never add one.
    .filter(recordFits)
    .slice(-COMPOSER_DRAFT_MAX_RECORDS);
  while (result.length && serialize(result, epoch).length > COMPOSER_DRAFT_MAX_ENTRY_SIZE) result.shift();
  return result;
}

/** Returns the records the committed document holds, or null when storage
 * refused every attempt. */
function save(accountId: string, records: readonly StoredComposerDraft[], epoch?: string | null): readonly StoredComposerDraft[] | null {
  if (typeof window === "undefined") return null;
  // Quota failure may be resolved by evicting the oldest draft. An unavailable
  // storage still leaves the composer fully usable in memory.
  const remaining = bounded(records, epoch);
  while (true) {
    try {
      if (remaining.length || epoch) window.localStorage.setItem(composerDraftStorageKey(accountId), serialize(remaining, epoch));
      else window.localStorage.removeItem(composerDraftStorageKey(accountId));
      return remaining;
    } catch {
      if (!remaining.length) return null;
      remaining.shift();
    }
  }
}

export function readComposerDrafts(accountId: string, now = Date.now()): StoredComposerDraft[] {
  if (typeof window === "undefined" || !accountId) return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(composerDraftStorageKey(accountId));
  } catch {
    // Storage can be blocked independently of the rest of the browser state.
    return [];
  }
  try {
    if (!raw) return [];
    if (raw.length > COMPOSER_DRAFT_MAX_ENTRY_SIZE) { save(accountId, []); return []; }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 ||
      !("records" in parsed) || !Array.isArray(parsed.records)) { save(accountId, []); return []; }
    const byKey = new Map<ComposerSessionKey, StoredComposerDraft>();
    for (const record of parsed.records) {
      if (!record || typeof record !== "object" || !isStoredComposerSessionKey(record.sessionKey) ||
        typeof record.draft !== "string" || typeof record.savedAt !== "number" ||
        !Number.isFinite(record.savedAt) || record.savedAt > now || now - record.savedAt >= COMPOSER_DRAFT_MAX_AGE_MS) continue;
      // One invalid comment is dropped alone; the text and the rest survive.
      const decoded = storedRecord(record.sessionKey, { draft: record.draft, comments: record.comments }, record.savedAt);
      if (!decoded.draft && !decoded.comments) continue;
      if (!byKey.has(decoded.sessionKey) || byKey.get(decoded.sessionKey)!.savedAt <= decoded.savedAt) byKey.set(decoded.sessionKey, decoded);
    }
    const epoch = "epoch" in parsed && typeof parsed.epoch === "string" && /^[a-f\d-]{36}$/u.test(parsed.epoch) ? parsed.epoch : null;
    // An interrupted stale writer may have written after logout but before its
    // post-write fence check. Never restore that text in a later document.
    const fence = readComposerDraftEpochState(accountId);
    if (epoch && fence.available && epoch !== fence.epoch) { save(accountId, []); return []; }
    const records = bounded([...byKey.values()], epoch);
    if (serialize(records, epoch) !== raw) save(accountId, records, epoch);
    return records;
  } catch {
    save(accountId, []);
    return [];
  }
}

export type ComposerDraftWriteResult = Readonly<{
  /** Keys whose input exceeds the record bound; their previous copy is kept. */
  tooLarge: readonly ComposerSessionKey[];
  /** Keys whose change did not reach storage: storage or its fence was
   * unavailable, `setItem` failed, or quota eviction dropped the new record.
   * The caller keeps them pending; `tooLarge` keys are never listed. */
  unsaved: readonly ComposerSessionKey[];
}>;

/** Merge only changed keys into the latest document; other tabs' untouched
 * drafts survive, while the last write of a changed key wins. Input above the
 * record bound is never stored and never deletes the previous stored copy. */
export function writeComposerDrafts(accountId: string, updates: ReadonlyMap<ComposerSessionKey, string | StoredComposerInput | null>, now = Date.now()): ComposerDraftWriteResult {
  const tooLarge: ComposerSessionKey[] = [];
  const unwritten = () => ({ tooLarge, unsaved: [...updates.keys()] });
  if (!accountId) return unwritten();
  const epochState = readComposerDraftEpochState(accountId);
  if (!epochState.available) return unwritten();
  const epoch = epochState.epoch;
  const current = readComposerDrafts(accountId, now);
  const records = new Map(current.map(record => [record.sessionKey, record]));
  for (const [sessionKey, update] of updates) {
    const input = typeof update === "string" ? { draft: update } : update;
    const record = input && isStoredComposerSessionKey(sessionKey) ? storedRecord(sessionKey, input, now) : null;
    if (record && !recordFits(record)) {
      tooLarge.push(sessionKey);
      setRefused(accountId, sessionKey, true);
      continue;
    }
    setRefused(accountId, sessionKey, false);
    records.delete(sessionKey);
    if (record && (record.draft || record.comments)) records.set(sessionKey, record);
  }
  const committed = save(accountId, [...records.values()], epoch);
  const committedKeys = new Set(committed?.map(record => record.sessionKey));
  const unsaved = [...updates.keys()].filter(key => !tooLarge.includes(key) &&
    (!committed || records.has(key) && !committedKeys.has(key)));
  return { tooLarge, unsaved };
}

export function clearComposerDrafts(accountId: string): void {
  save(accountId, []);
  const prefix = refusalKey(accountId, "" as ComposerSessionKey);
  const cleared = [...refusedRecords].filter(id => id.startsWith(prefix));
  for (const id of cleared) refusedRecords.delete(id);
  if (cleared.length) for (const listener of refusalListeners) listener();
}

export function composerDraftEpochKey(accountId: string): string {
  return `${DRAFT_EPOCH_PREFIX}${encodeURIComponent(accountId)}`;
}

/** Separate content-free fence: a stale draft write cannot overwrite logout.
 * Sign-out replaces the epoch and marks it signed out; a later sign-in keeps
 * that epoch and clears the mark. The first fence of an account is the same
 * constant in every tab, so tabs creating it at the same moment agree. */
export const COMPOSER_DRAFT_INITIAL_EPOCH = "00000000-0000-0000-0000-000000000000";

export type ComposerDraftEpochState = Readonly<{
  available: boolean;
  epoch: string | null;
  /** Epoch-rotation time; 0 for the initial fence. */
  savedAt: number;
  signedOut: boolean;
}>;

export function readComposerDraftEpoch(accountId: string): string | null {
  return readComposerDraftEpochState(accountId).epoch;
}

export function readComposerDraftEpochState(accountId: string): ComposerDraftEpochState {
  const unavailable = { available: false, epoch: null, savedAt: 0, signedOut: false };
  if (typeof window === "undefined") return unavailable;
  try {
    const raw = window.localStorage.getItem(composerDraftEpochKey(accountId));
    if (!raw) return { available: true, epoch: null, savedAt: 0, signedOut: false };
    if (raw.length > DRAFT_EPOCH_MAX_SIZE) return unavailable;
    const value = JSON.parse(raw) as { epoch?: unknown; savedAt?: unknown; signedOut?: unknown };
    if (!("epoch" in value)) return { available: true, epoch: null, savedAt: 0, signedOut: false };
    if (typeof value?.epoch !== "string" || !/^[a-f\d-]{36}$/u.test(value.epoch)) return unavailable;
    const savedAt = typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : 0;
    return { available: true, epoch: value.epoch, savedAt, signedOut: value.signedOut === true };
  } catch { return unavailable; }
}

function writeComposerDraftEpoch(accountId: string, epoch: string, savedAt: number, signedOut: boolean): string | null {
  if (typeof window === "undefined") return null;
  try {
    window.localStorage.setItem(composerDraftEpochKey(accountId), JSON.stringify({ epoch, savedAt, ...(signedOut ? { signedOut } : {}) }));
  } catch { return null; }
  try {
    const older = Object.keys(window.localStorage)
      .filter(key => key.startsWith(DRAFT_EPOCH_PREFIX) && key !== composerDraftEpochKey(accountId))
      .map(key => {
        try {
          const raw = window.localStorage.getItem(key);
          const value = raw && raw.length <= DRAFT_EPOCH_MAX_SIZE ? JSON.parse(raw) as { savedAt?: unknown } : null;
          return { key, savedAt: typeof value?.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : 0 };
        } catch { return { key, savedAt: 0 }; }
      }).sort((a, b) => b.savedAt - a.savedAt);
    for (const record of older.slice(MAX_DRAFT_EPOCHS - 1)) window.localStorage.removeItem(record.key);
  } catch { /* The newly written fence remains valid if cleanup is unavailable. */ }
  return epoch;
}

/** First fence of an account. Byte-identical in every tab: concurrent
 * creators neither change the value nor raise a storage event. */
export function createInitialComposerDraftEpoch(accountId: string): string | null {
  return writeComposerDraftEpoch(accountId, COMPOSER_DRAFT_INITIAL_EPOCH, 0, false);
}

/** Rotates to a new epoch without a sign-out mark; tabs holding the old one
 * drop their in-memory drafts before they may write again. */
export function replaceComposerDraftEpoch(accountId: string): string | null {
  return writeComposerDraftEpoch(accountId, randomUUID(), Date.now(), false);
}

/** Explicit sign-out: a new epoch that no tab holds, marked signed out. */
export function signOutComposerDraftEpoch(accountId: string): string | null {
  return writeComposerDraftEpoch(accountId, randomUUID(), Date.now(), true);
}

/** A sign-in after a sign-out keeps the epoch and clears the mark, so tabs
 * revoked by that sign-out may start again with emptied memory. */
export function resumeComposerDraftEpoch(accountId: string, epoch: string): string | null {
  return writeComposerDraftEpoch(accountId, epoch, Date.now(), false);
}

const DRAFT_STORAGE_PREFIX = "aiqsa.composerDrafts.v1:";

/** Sign-out fallback when the caller cannot name the account: removes every
 * account's fence, then every draft entry, of this browser profile. A removed
 * fence invalidates the tabs holding it exactly like a replaced one. */
export function clearAllComposerDraftStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const keys = Object.keys(window.localStorage);
    for (const key of keys) if (key.startsWith(DRAFT_EPOCH_PREFIX)) window.localStorage.removeItem(key);
    for (const key of keys) if (key.startsWith(DRAFT_STORAGE_PREFIX)) window.localStorage.removeItem(key);
  } catch { /* Unavailable storage holds no draft to remove. */ }
}
