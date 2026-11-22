import type { Prisma, PrismaClient } from "@prisma/client";
import {
  MEMORY_LEGACY_SUGGESTIONS_PAGE_SIZE,
  MEMORY_NOTE_CURSOR_MAX_LENGTH,
  memoryNoteChangeAction,
  type MemoryLegacySuggestionAction,
  type MemoryLegacySuggestionPage,
  type MemoryNote,
  type MemoryNoteChangeCard,
  type MemoryNoteErrorCode,
  type MemoryNoteOfferDecision,
  type MemoryNoteOfferDecisionResult,
  type MemoryNoteOfferStatus,
  type MemoryNoteUpdate,
  type MemorySwitches,
  type MemorySwitchesUpdate
} from "@/lib/contracts/memoryNote";
import { applyMemoryNoteEdit, memoryNoteEditInsertion, memoryNoteEditOf, type MemoryNoteEditResult } from "./edit";
import { loadMemoryNoteSavedSecrets, memoryNoteTextHoldsSecret, type MemoryNoteSavedSecrets } from "./secrets";
import {
  createPrismaMemoryNoteRepository,
  type MemoryLegacyCursor,
  type MemoryNoteRepository,
  type MemoryNoteRepositoryFactory,
  type StoredMemoryNoteOffer
} from "./store";

/**
 * What Settings › Memory, an answer's note cards and their Telegram messages do with the user's memory note (operator
 * decision 2026-11-22): read and save the note under the revision the editor read, the three switches, the user's
 * decision on an offer the agent made, and the old Memory's facts waiting as legacy suggestions. The agent's own
 * changes go through `agentMemoryNote.ts` with the same edit rules, limit and secret screen. Every operation names the
 * signed-in owner, so another user's offers and suggestions are the same refusal as missing ones.
 */

export type MemoryNoteServiceErrorCode = MemoryNoteErrorCode | "memory_note_unavailable";

export class MemoryNoteError extends Error {
  constructor(
    readonly code: MemoryNoteServiceErrorCode,
    readonly details: Readonly<{ characters?: number; reason?: "secret" }> = {}
  ) {
    super(code);
    this.name = "MemoryNoteError";
  }
}

export type MemoryNoteService = Readonly<{
  read(userId: string): Promise<MemoryNote>;
  /** Saves the whole text when the note is still at `update.revision`; the Settings editor and Undo. */
  save(userId: string, update: MemoryNoteUpdate): Promise<MemoryNote>;
  switches(userId: string): Promise<MemorySwitches>;
  updateSwitches(userId: string, update: MemorySwitchesUpdate): Promise<MemorySwitches>;
  offerStatus(userId: string, offerId: string): Promise<MemoryNoteOfferStatus>;
  decideOffer(userId: string, offerId: string, decision: MemoryNoteOfferDecision): Promise<MemoryNoteOfferDecisionResult>;
  legacyPage(userId: string, cursor: string | null): Promise<MemoryLegacySuggestionPage>;
  /** Keep appends the suggestion to the note and deletes it; Remove deletes it. Either way the note as it is afterwards. */
  legacyAction(userId: string, suggestionId: string, action: MemoryLegacySuggestionAction): Promise<MemoryNote>;
  removeAllLegacy(userId: string): Promise<number>;
}>;

export type MemoryNoteServiceDeps = Readonly<{
  db: Pick<PrismaClient, "$transaction" | "workspaceSecret">;
  /** The owner's saved secret values the screen compares (`loadMemoryNoteSavedSecrets` over this database by default). */
  savedSecrets?: MemoryNoteSavedSecrets;
  repository?: MemoryNoteRepositoryFactory;
}>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** The offer's state as the card reads it. */
export function memoryNoteOfferStatus(offer: StoredMemoryNoteOffer): MemoryNoteOfferStatus {
  return { decidedAt: offer.decidedAt?.toISOString() ?? null, offerId: offer.id, state: offer.state };
}

/** The change card of an edit that left `revision`, over the note that was `previousText` before it. */
export function memoryNoteChangeCard(edit: MemoryNoteEditResult, previousText: string, revision: number): MemoryNoteChangeCard {
  return { action: memoryNoteChangeAction(edit.operation), after: edit.after, before: edit.before, previousText, resource: "memory_note", revision,
    version: 1 };
}

/** An opaque page cursor: the last suggestion's time and id. */
export function encodeMemoryLegacyCursor(cursor: MemoryLegacyCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id]), "utf8").toString("base64url");
}

export function decodeMemoryLegacyCursor(value: string): MemoryLegacyCursor | null {
  if (value.length > MEMORY_NOTE_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [time, id] = parsed as unknown[];
    if (typeof time !== "string" || typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    const createdAt = new Date(time);
    return Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== time ? null : { createdAt, id };
  } catch {
    return null;
  }
}

const tooLong = (characters: number) => new MemoryNoteError("memory_note_too_long", { characters });
const secretRefused = () => new MemoryNoteError("memory_note_invalid", { reason: "secret" });

export function createMemoryNoteService(deps: MemoryNoteServiceDeps): MemoryNoteService {
  const repository = deps.repository ?? createPrismaMemoryNoteRepository;
  const savedSecrets = deps.savedSecrets ?? ((userId: string) => loadMemoryNoteSavedSecrets(deps.db, userId));

  /** One transaction under the owner lock (`lock`), or a read that only checks the owner is active; an inactive one is unavailable. */
  async function transaction<T>(userId: string, lock: boolean, work: (repo: MemoryNoteRepository) => Promise<T>): Promise<T> {
    return deps.db.$transaction(async (tx: Prisma.TransactionClient) => {
      const repo = repository(tx);
      if (!await (lock ? repo.lockOwner(userId) : repo.activeOwner(userId))) throw new MemoryNoteError("memory_note_unavailable");
      return work(repo);
    });
  }
  const locked = <T>(userId: string, work: (repo: MemoryNoteRepository) => Promise<T>) => transaction(userId, true, work);
  const reading = <T>(userId: string, work: (repo: MemoryNoteRepository) => Promise<T>) => transaction(userId, false, work);

  async function screen(userId: string, text: string | null): Promise<void> {
    if (text !== null && memoryNoteTextHoldsSecret(text, await savedSecrets(userId))) throw secretRefused();
  }

  return {
    read: (userId) => reading(userId, (repo) => repo.readNote(userId)),

    async save(userId, update) {
      await screen(userId, update.text);
      return locked(userId, async (repo) => {
        const current = await repo.readNote(userId);
        if (current.revision !== update.revision) throw new MemoryNoteError("memory_note_conflict");
        // The same text writes nothing, so an unchanged save leaves Undo of the agent's last change working.
        if (current.text === update.text) return current;
        const written = await repo.writeNote(userId, { author: "user", expectedRevision: current.revision, text: update.text });
        if (!written) throw new MemoryNoteError("memory_note_conflict");
        return written;
      });
    },

    switches: (userId) => reading(userId, (repo) => repo.readSwitches(userId)),

    updateSwitches: (userId, update) => locked(userId, (repo) => repo.updateSwitches(userId, update)),

    async offerStatus(userId, offerId) {
      if (!ID_PATTERN.test(offerId)) throw new MemoryNoteError("memory_note_offer_not_found");
      return reading(userId, async (repo) => {
        const offer = await repo.findOffer(userId, offerId);
        if (!offer) throw new MemoryNoteError("memory_note_offer_not_found");
        return memoryNoteOfferStatus(offer);
      });
    },

    async decideOffer(userId, offerId, decision) {
      if (!ID_PATTERN.test(offerId)) throw new MemoryNoteError("memory_note_offer_not_found");
      // Read before the lock: an acceptance screens the text it puts in against the owner's saved secrets as they are now.
      const values = decision === "accept" ? await savedSecrets(userId) : [];
      return locked(userId, async (repo) => {
        const offer = await repo.findOffer(userId, offerId);
        if (!offer) throw new MemoryNoteError("memory_note_offer_not_found");
        const settled = decision === "accept" ? "accepted" : "dismissed";
        // A repeated decision answers with the state and no change; the other decision came first.
        if (offer.state === settled) return { change: null, offer: memoryNoteOfferStatus(offer) };
        if (offer.state !== "pending") throw new MemoryNoteError("memory_note_offer_stale");
        if (decision === "dismiss") {
          const dismissed = await repo.decideOffer(userId, offerId, "dismissed");
          if (!dismissed) throw new MemoryNoteError("memory_note_offer_stale");
          return { change: null, offer: memoryNoteOfferStatus(dismissed) };
        }
        if (!(await repo.readSwitches(userId)).memoryEnabled) throw new MemoryNoteError("memory_disabled");
        const edit = memoryNoteEditOf(offer.operation, offer.beforeText, offer.afterText);
        if (!edit) throw new MemoryNoteError("memory_note_offer_stale");
        const insertion = memoryNoteEditInsertion(edit);
        if (insertion !== null && memoryNoteTextHoldsSecret(insertion, values)) throw secretRefused();
        const current = await repo.readNote(userId);
        const applied = applyMemoryNoteEdit(current.text, edit);
        if ("code" in applied) {
          // Nothing is written and the offer stays pending: the user may make room, or fix the note, and accept again.
          if (applied.code === "memory_note_too_long") throw tooLong(applied.characters);
          throw new MemoryNoteError("memory_note_offer_stale");
        }
        // The user's decision writes it, so the user made this change.
        const written = await repo.writeNote(userId, { author: "user", expectedRevision: current.revision, text: applied.text });
        const accepted = written && await repo.decideOffer(userId, offerId, "accepted");
        if (!written || !accepted) throw new MemoryNoteError("memory_note_offer_stale");
        return { change: memoryNoteChangeCard(applied, current.text, written.revision), offer: memoryNoteOfferStatus(accepted) };
      });
    },

    async legacyPage(userId, cursor) {
      const after = cursor === null ? null : decodeMemoryLegacyCursor(cursor);
      if (cursor !== null && !after) throw new MemoryNoteError("memory_note_invalid");
      return reading(userId, async (repo) => {
        const rows = await repo.listLegacy(userId, after, MEMORY_LEGACY_SUGGESTIONS_PAGE_SIZE + 1);
        const page = rows.slice(0, MEMORY_LEGACY_SUGGESTIONS_PAGE_SIZE);
        const last = page.at(-1);
        return {
          nextCursor: rows.length > MEMORY_LEGACY_SUGGESTIONS_PAGE_SIZE && last ? encodeMemoryLegacyCursor(last) : null,
          suggestions: page.map((row) => ({ createdAt: row.createdAt.toISOString(), id: row.id, origin: row.origin, text: row.text }))
        };
      });
    },

    async legacyAction(userId, suggestionId, action) {
      if (!ID_PATTERN.test(suggestionId)) throw new MemoryNoteError("memory_legacy_suggestion_not_found");
      const values = action === "keep" ? await savedSecrets(userId) : [];
      return locked(userId, async (repo) => {
        const suggestion = await repo.findLegacy(userId, suggestionId);
        if (!suggestion) throw new MemoryNoteError("memory_legacy_suggestion_not_found");
        if (action === "remove") {
          await repo.deleteLegacy(userId, suggestionId);
          return repo.readNote(userId);
        }
        if (memoryNoteTextHoldsSecret(suggestion.text, values)) throw secretRefused();
        const current = await repo.readNote(userId);
        const applied = applyMemoryNoteEdit(current.text, { kind: "add", text: suggestion.text });
        if ("code" in applied) {
          if (applied.code === "memory_note_too_long") throw tooLong(applied.characters);
          throw new MemoryNoteError("memory_note_invalid");
        }
        const written = await repo.writeNote(userId, { author: "user", expectedRevision: current.revision, text: applied.text });
        if (!written) throw new MemoryNoteError("memory_note_conflict");
        await repo.deleteLegacy(userId, suggestionId);
        return written;
      });
    },

    removeAllLegacy: (userId) => locked(userId, (repo) => repo.deleteAllLegacy(userId))
  };
}
