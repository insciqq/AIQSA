import { Prisma } from "@prisma/client";
import { storedUserRequest } from "../runs/turnProvenance";
import {
  EMPTY_MEMORY_NOTE,
  MEMORY_SWITCH_DEFAULTS,
  type MemoryLegacySuggestionOrigin,
  type MemoryNote,
  type MemoryNoteAuthor,
  type MemoryNoteOfferState,
  type MemoryNoteOperation,
  type MemorySwitches,
  type MemorySwitchesUpdate
} from "@/lib/contracts/memoryNote";

/**
 * The durable side of the memory note (`UserMemoryNote`, `MemoryNoteOffer`, `MemoryLegacySuggestion` and the three
 * switches on `UserSettings`), one transaction at a time. Every write runs under the owner lock (`lockOwner`, the
 * `User` row the run settlement locks first too, `lockRunSettlementScope`), so a Settings save, an agent's change, an
 * accepted offer and a kept suggestion serialize per user and each reads the note it changes. Every read and write
 * names the owner, so another user's rows are never found.
 */

/** An offer as stored, with wire values. */
export type StoredMemoryNoteOffer = Readonly<{
  id: string;
  operation: MemoryNoteOperation;
  beforeText: string | null;
  afterText: string | null;
  state: MemoryNoteOfferState;
  decidedAt: Date | null;
}>;

export type StoredMemoryLegacySuggestion = Readonly<{
  id: string;
  text: string;
  origin: MemoryLegacySuggestionOrigin;
  createdAt: Date;
}>;

export type MemoryNoteRunChat = Readonly<{
  assistantMessageId: string | null;
  /** `NORMAL` chats read and change the note; Temporary and Excluded chats neither read nor change it. */
  memoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  /**
   * The run answers the user's own message, as stored: one they wrote, or the continuation of their turn after an MCP
   * Allow. False for a turn the server wrote (a sub-agent wake-up, a browser sign-in request) and a scheduled task's
   * prompt, which never change the note.
   */
  userTurn: boolean;
}>;

/** Where a page of legacy suggestions continues: after this one, oldest first. */
export type MemoryLegacyCursor = Readonly<{ createdAt: Date; id: string }>;

/** One transaction's access to its owner's memory rows. */
export type MemoryNoteRepository = Readonly<{
  /** Takes the owner lock; false when the user is not an active account. */
  lockOwner(userId: string): Promise<boolean>;
  /** Whether the user is an active account, for a read that changes nothing. */
  activeOwner(userId: string): Promise<boolean>;
  readNote(userId: string): Promise<MemoryNote>;
  /**
   * Writes the whole text when the note is still at `expectedRevision` (0: never saved), adding one to the revision;
   * null when it moved on, with nothing written.
   */
  writeNote(userId: string, input: Readonly<{ text: string; expectedRevision: number; author: MemoryNoteAuthor }>): Promise<MemoryNote | null>;
  readSwitches(userId: string): Promise<MemorySwitches>;
  updateSwitches(userId: string, update: MemorySwitchesUpdate): Promise<MemorySwitches>;
  /**
   * The user's own run in its chat: the answer message it writes (null for a sub-agent's run, which answers none) and
   * whether the chat takes part in Memory; null when the run is not theirs.
   */
  runChat(input: Readonly<{ userId: string; chatId: string; runId: string }>): Promise<MemoryNoteRunChat | null>;
  createOffer(input: Readonly<{
    userId: string; chatId: string; runId: string; assistantMessageId: string; toolCallId: string;
    operation: MemoryNoteOperation; beforeText: string | null; afterText: string | null;
  }>): Promise<StoredMemoryNoteOffer>;
  findOffer(userId: string, offerId: string): Promise<StoredMemoryNoteOffer | null>;
  /** Decides a pending offer; null when it is not pending or not the user's. */
  decideOffer(userId: string, offerId: string, state: Exclude<MemoryNoteOfferState, "pending">): Promise<StoredMemoryNoteOffer | null>;
  listLegacy(userId: string, after: MemoryLegacyCursor | null, take: number): Promise<readonly StoredMemoryLegacySuggestion[]>;
  findLegacy(userId: string, id: string): Promise<StoredMemoryLegacySuggestion | null>;
  deleteLegacy(userId: string, id: string): Promise<boolean>;
  deleteAllLegacy(userId: string): Promise<number>;
}>;

export type MemoryNoteRepositoryFactory = (tx: Prisma.TransactionClient) => MemoryNoteRepository;

const AUTHOR_TO_DB = { agent: "AGENT", user: "USER" } as const satisfies Record<MemoryNoteAuthor, string>;
const AUTHOR_FROM_DB = { AGENT: "agent", USER: "user" } as const;
const OPERATION_TO_DB = { add: "ADD", remove: "REMOVE", replace: "REPLACE" } as const satisfies Record<MemoryNoteOperation, string>;
const OPERATION_FROM_DB = { ADD: "add", REMOVE: "remove", REPLACE: "replace" } as const;
const STATE_TO_DB = { accepted: "ACCEPTED", dismissed: "DISMISSED", pending: "PENDING" } as const satisfies Record<MemoryNoteOfferState, string>;
const STATE_FROM_DB = { ACCEPTED: "accepted", DISMISSED: "dismissed", PENDING: "pending" } as const;
const ORIGIN_FROM_DB = { AUTOMATIC: "automatic", SAVED_OVERFLOW: "saved_overflow" } as const;

const noteSelect = { lastChangedBy: true, revision: true, text: true, updatedAt: true } as const;
const switchesSelect = { memoryEnabled: true, memorySuggestionsEnabled: true, pastChatSearchEnabled: true } as const;
const offerSelect = { afterText: true, beforeText: true, decidedAt: true, id: true, operation: true, state: true } as const;
const legacySelect = { createdAt: true, id: true, origin: true, text: true } as const;

type NoteRow = Readonly<{ text: string; revision: number; lastChangedBy: keyof typeof AUTHOR_FROM_DB; updatedAt: Date }>;
type OfferRow = Readonly<{ id: string; operation: keyof typeof OPERATION_FROM_DB; beforeText: string | null; afterText: string | null;
  state: keyof typeof STATE_FROM_DB; decidedAt: Date | null }>;
type LegacyRow = Readonly<{ id: string; text: string; origin: keyof typeof ORIGIN_FROM_DB; createdAt: Date }>;

function noteOf(row: NoteRow | null): MemoryNote {
  return row ? { lastChangedBy: AUTHOR_FROM_DB[row.lastChangedBy], revision: row.revision, text: row.text, updatedAt: row.updatedAt.toISOString() }
    : EMPTY_MEMORY_NOTE;
}

function offerOf(row: OfferRow): StoredMemoryNoteOffer {
  return { afterText: row.afterText, beforeText: row.beforeText, decidedAt: row.decidedAt, id: row.id,
    operation: OPERATION_FROM_DB[row.operation], state: STATE_FROM_DB[row.state] };
}

function legacyOf(row: LegacyRow): StoredMemoryLegacySuggestion {
  return { createdAt: row.createdAt, id: row.id, origin: ORIGIN_FROM_DB[row.origin], text: row.text };
}

/** The note as a client or transaction reads it without the owner lock: revision 0 when none was ever saved. */
export async function readMemoryNote(db: Pick<Prisma.TransactionClient, "userMemoryNote">, userId: string): Promise<MemoryNote> {
  return noteOf(await db.userMemoryNote.findUnique({ select: noteSelect, where: { userId } }));
}

/** The user's switches; the defaults (all on) while they never saved a setting. */
export async function readMemorySwitches(db: Pick<Prisma.TransactionClient, "userSettings">, userId: string): Promise<MemorySwitches> {
  return await db.userSettings.findUnique({ select: switchesSelect, where: { userId } }) ?? MEMORY_SWITCH_DEFAULTS;
}

export function createPrismaMemoryNoteRepository(tx: Prisma.TransactionClient): MemoryNoteRepository {
  return {
    async lockOwner(userId) {
      const owners = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} AND "status" = 'active' FOR UPDATE`);
      return owners.length === 1;
    },

    async activeOwner(userId) {
      return await tx.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } }) !== null;
    },

    readNote: (userId) => readMemoryNote(tx, userId),

    async writeNote(userId, { author, expectedRevision, text }) {
      const lastChangedBy = AUTHOR_TO_DB[author];
      if (expectedRevision === 0) {
        // A note never saved has no row; one saved meanwhile is a conflict, never overwritten.
        const created = await tx.userMemoryNote.createMany({ data: [{ lastChangedBy, text, userId }], skipDuplicates: true });
        if (created.count !== 1) return null;
      } else {
        const updated = await tx.userMemoryNote.updateMany({
          data: { lastChangedBy, revision: { increment: 1 }, text, updatedAt: new Date() },
          where: { revision: expectedRevision, userId }
        });
        if (updated.count !== 1) return null;
      }
      return readMemoryNote(tx, userId);
    },

    readSwitches: (userId) => readMemorySwitches(tx, userId),

    async updateSwitches(userId, update) {
      const data = Object.fromEntries(Object.entries(update).filter(([, value]) => typeof value === "boolean")) as MemorySwitchesUpdate;
      return tx.userSettings.upsert({ create: { userId, ...data }, select: switchesSelect, update: data, where: { userId } });
    },

    async runChat({ chatId, runId, userId }) {
      const run = await tx.modelRun.findFirst({
        select: { assistantMessageId: true, chat: { select: { memoryMode: true, userId: true } },
          userMessage: { select: { scheduledTaskPrompt: true, systemTurnKind: true } } },
        where: { chatId, id: runId, userId }
      });
      if (!run || run.chat.userId !== userId) return null;
      return { assistantMessageId: run.assistantMessageId, memoryMode: run.chat.memoryMode,
        userTurn: storedUserRequest(run.userMessage) };
    },

    async createOffer(input) {
      return offerOf(await tx.memoryNoteOffer.create({
        data: { afterText: input.afterText, assistantMessageId: input.assistantMessageId, beforeText: input.beforeText, chatId: input.chatId,
          operation: OPERATION_TO_DB[input.operation], runId: input.runId, toolCallId: input.toolCallId, userId: input.userId },
        select: offerSelect
      }));
    },

    async findOffer(userId, offerId) {
      const row = await tx.memoryNoteOffer.findFirst({ select: offerSelect, where: { id: offerId, userId } });
      return row ? offerOf(row) : null;
    },

    async decideOffer(userId, offerId, state) {
      const decided = await tx.memoryNoteOffer.updateMany({
        data: { decidedAt: new Date(), state: STATE_TO_DB[state] }, where: { id: offerId, state: "PENDING", userId }
      });
      if (decided.count !== 1) return null;
      const row = await tx.memoryNoteOffer.findFirst({ select: offerSelect, where: { id: offerId, userId } });
      return row ? offerOf(row) : null;
    },

    async listLegacy(userId, after, take) {
      const rows = await tx.memoryLegacySuggestion.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: legacySelect, take,
        where: { userId, ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}) }
      });
      return rows.map(legacyOf);
    },

    async findLegacy(userId, id) {
      const row = await tx.memoryLegacySuggestion.findFirst({ select: legacySelect, where: { id, userId } });
      return row ? legacyOf(row) : null;
    },

    async deleteLegacy(userId, id) {
      return (await tx.memoryLegacySuggestion.deleteMany({ where: { id, userId } })).count === 1;
    },

    async deleteAllLegacy(userId) {
      return (await tx.memoryLegacySuggestion.deleteMany({ where: { userId } })).count;
    }
  };
}
