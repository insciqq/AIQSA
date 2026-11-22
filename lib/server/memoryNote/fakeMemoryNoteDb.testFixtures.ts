import {
  MEMORY_SWITCH_DEFAULTS,
  type MemoryLegacySuggestionOrigin,
  type MemoryNoteAuthor,
  type MemoryNoteOfferState,
  type MemoryNoteOperation,
  type MemorySwitches
} from "@/lib/contracts/memoryNote";
import type { MemoryNoteRepository, MemoryNoteRunChat, StoredMemoryLegacySuggestion, StoredMemoryNoteOffer } from "./store";

type NoteRow = { text: string; revision: number; lastChangedBy: MemoryNoteAuthor; updatedAt: Date };
type OfferRow = StoredMemoryNoteOffer & { userId: string; chatId: string; runId: string; assistantMessageId: string; toolCallId: string };
type LegacyRow = StoredMemoryLegacySuggestion & { userId: string };
type State = {
  active: Set<string>;
  notes: Map<string, NoteRow>;
  settings: Map<string, MemorySwitches>;
  runs: Map<string, { userId: string; chatId: string; assistantMessageId: string | null; memoryMode?: MemoryNoteRunChat["memoryMode"];
    userTurn?: boolean }>;
  offers: OfferRow[];
  legacy: LegacyRow[];
};

/**
 * The memory note's rows in memory, behind the same repository the Prisma one implements (`store.ts`), with a
 * `$transaction` that rolls every change back when its work throws, as PostgreSQL does. Each owner's rows are kept apart
 * exactly as the real queries name the owner.
 */
export function fakeMemoryNoteDb(input: Readonly<{ activeUsers: readonly string[] }>) {
  const state: State = {
    active: new Set(input.activeUsers), legacy: [], notes: new Map(), offers: [], runs: new Map(), settings: new Map()
  };
  let clock = Date.parse("2026-11-22T10:00:00.000Z");
  const now = () => new Date(clock += 1_000);
  let offers = 0;
  let locks = 0;

  const readNote = async (userId: string) => {
    const row = state.notes.get(userId);
    return row ? { lastChangedBy: row.lastChangedBy, revision: row.revision, text: row.text, updatedAt: row.updatedAt.toISOString() }
      : { lastChangedBy: null, revision: 0, text: "", updatedAt: null };
  };

  const repository = (): MemoryNoteRepository => ({
    async lockOwner(userId) {
      locks += 1;
      return state.active.has(userId);
    },
    async activeOwner(userId) {
      return state.active.has(userId);
    },
    readNote,
    async writeNote(userId, { author, expectedRevision, text }) {
      const row = state.notes.get(userId);
      if ((row?.revision ?? 0) !== expectedRevision) return null;
      // The database's CHECK.
      if (Array.from(text).length > 6_000) throw new Error("synthetic_check_violation");
      state.notes.set(userId, { lastChangedBy: author, revision: expectedRevision + 1, text, updatedAt: now() });
      return readNote(userId);
    },
    async readSwitches(userId) {
      return state.settings.get(userId) ?? MEMORY_SWITCH_DEFAULTS;
    },
    async updateSwitches(userId, update) {
      const next = { ...(state.settings.get(userId) ?? MEMORY_SWITCH_DEFAULTS) };
      for (const [key, value] of Object.entries(update)) if (typeof value === "boolean") next[key as keyof MemorySwitches] = value;
      state.settings.set(userId, next);
      return next;
    },
    async runChat({ chatId, runId, userId }) {
      const run = state.runs.get(runId);
      return run && run.userId === userId && run.chatId === chatId
        ? { assistantMessageId: run.assistantMessageId, memoryMode: run.memoryMode ?? "NORMAL", userTurn: run.userTurn ?? true } : null;
    },
    async createOffer(offer) {
      if (state.offers.some((row) => row.runId === offer.runId && row.toolCallId === offer.toolCallId)) throw new Error("synthetic_unique_violation");
      offers += 1;
      const row: OfferRow = { ...offer, decidedAt: null, id: `offer-${offers}`, state: "pending" };
      state.offers.push(row);
      return row;
    },
    async findOffer(userId, offerId) {
      return state.offers.find((row) => row.id === offerId && row.userId === userId) ?? null;
    },
    async decideOffer(userId, offerId, decided) {
      const index = state.offers.findIndex((row) => row.id === offerId && row.userId === userId && row.state === "pending");
      if (index === -1) return null;
      state.offers[index] = { ...state.offers[index]!, decidedAt: now(), state: decided };
      return state.offers[index]!;
    },
    async listLegacy(userId, after, take) {
      return state.legacy.filter((row) => row.userId === userId && (!after || row.createdAt > after.createdAt ||
        (row.createdAt.getTime() === after.createdAt.getTime() && row.id > after.id)))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1)).slice(0, take);
    },
    async findLegacy(userId, id) {
      return state.legacy.find((row) => row.id === id && row.userId === userId) ?? null;
    },
    async deleteLegacy(userId, id) {
      const before = state.legacy.length;
      state.legacy = state.legacy.filter((row) => !(row.id === id && row.userId === userId));
      return state.legacy.length < before;
    },
    async deleteAllLegacy(userId) {
      const before = state.legacy.length;
      state.legacy = state.legacy.filter((row) => row.userId !== userId);
      return before - state.legacy.length;
    }
  });

  const db = {
    async $transaction<T>(work: (tx: never) => Promise<T>): Promise<T> {
      const saved = structuredClone({ ...state, active: [...state.active] });
      try {
        return await work({} as never);
      } catch (error) {
        state.notes = saved.notes;
        state.settings = saved.settings;
        state.runs = saved.runs;
        state.offers = saved.offers;
        state.legacy = saved.legacy;
        throw error;
      }
    },
    workspaceSecret: { findMany: async () => [] }
  };

  return {
    db: db as never,
    repository,
    state,
    locks: () => locks,
    /** A run of the user's chat that answers `assistantMessageId` (null: a sub-agent's run). */
    run(runId: string, userId: string, chatId: string, assistantMessageId: string | null = `answer-${runId}`) {
      state.runs.set(runId, { assistantMessageId, chatId, userId });
    },
    note(userId: string, text: string, revision = 1, lastChangedBy: MemoryNoteAuthor = "user") {
      state.notes.set(userId, { lastChangedBy, revision, text, updatedAt: now() });
    },
    legacy(userId: string, id: string, text: string, origin: MemoryLegacySuggestionOrigin = "automatic") {
      state.legacy.push({ createdAt: now(), id, origin, text, userId });
    },
    offer(userId: string, operation: MemoryNoteOperation, beforeText: string | null, afterText: string | null,
      offerState: MemoryNoteOfferState = "pending") {
      offers += 1;
      const row: OfferRow = { afterText, assistantMessageId: "answer", beforeText, chatId: "chat", decidedAt: offerState === "pending" ? null : now(),
        id: `offer-${offers}`, operation, runId: `run-${offers}`, state: offerState, toolCallId: `call-${offers}`, userId };
      state.offers.push(row);
      return row.id;
    }
  };
}
