import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { chatSearchEligibilityFields, chatSearchEligibilitySelect } from "../eligibility";
import type { ChatSearchChatSnapshot, ChatSearchSourceMessage } from "./passages";
import { planChatSearchPassages, type StoredChatSearchPassage } from "./plan";
import { chatSearchSavedSecretValues } from "./savedSecrets";
import type {
  ChatSearchClaim,
  ChatSearchIndexStore,
  ChatSearchReconcileOutcome,
  ChatSearchReconcileTarget,
  ChatSearchSettlement
} from "./store";

/**
 * The indexer's PostgreSQL store. Lock order matches the chat's writers, which lock the chat row before they mark it
 * dirty (run settlement, message edits and deletions): a reconcile takes the chat row (`FOR KEY SHARE`, which its
 * passage keys need anyway), then the state row, then passages; `clearChatSearch` takes the state row before passages.
 * Provider calls happen outside any transaction, and vector writes are single statements guarded by the passage's
 * text hash.
 */

/** A path longer than this is not followed further (the schema allows no cycle; this bounds a broken one). */
const MAX_PATH_DEPTH = 20_000;

type PathRow = {
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  content: unknown;
  createdAt: Date;
  systemTurnKind: string | null;
  scheduledTaskPrompt: boolean;
  answerReviewSessionId: string | null;
};

/** A timestamp as the `timestamp(3)` columns hold it: UTC wall time, the zone ignored by the cast. */
function timestamp(value: Date): Prisma.Sql {
  return Prisma.sql`CAST(${value.toISOString()} AS timestamp(3))`;
}

function sameVersion(dirtyAt: Date | null, claim: ChatSearchClaim): boolean {
  return dirtyAt !== null && dirtyAt.getTime() === claim.dirtyAt.getTime();
}

async function clearChat(tx: Prisma.TransactionClient, chatId: string): Promise<void> {
  await tx.$executeRaw`DELETE FROM "ChatSearchState" WHERE "chatId" = ${chatId}`;
  await tx.$executeRaw`DELETE FROM "ChatSearchPassage" WHERE "chatId" = ${chatId}`;
}

async function applyPassages(
  tx: Prisma.TransactionClient,
  claim: ChatSearchClaim,
  target: Extract<ChatSearchReconcileTarget, { kind: "passages" }>
): Promise<ChatSearchReconcileOutcome> {
  const stored = await tx.$queryRaw<StoredChatSearchPassage[]>`
    SELECT "id", "userMessageId", "ordinal", "assistantMessageId", "turnAt", "contentHash"
    FROM "ChatSearchPassage" WHERE "chatId" = ${claim.chatId}`;
  const plan = planChatSearchPassages(stored, target.passages);
  if (plan.deletes.length > 0) {
    await tx.$executeRaw`
      DELETE FROM "ChatSearchPassage" WHERE "chatId" = ${claim.chatId} AND "id" = ANY(${[...plan.deletes]}::text[])`;
  }
  if (plan.updates.length > 0) {
    await tx.$executeRaw`
      UPDATE "ChatSearchPassage" AS passage SET
        "assistantMessageId" = row.assistant,
        "turnAt" = CAST(row.turn AS timestamp(3)),
        "text" = row.body,
        "contentHash" = row.hash,
        "embedding" = CASE WHEN row.changed THEN NULL ELSE passage."embedding" END,
        "embeddingProviderModelId" = CASE WHEN row.changed THEN NULL ELSE passage."embeddingProviderModelId" END,
        "embeddingDimension" = CASE WHEN row.changed THEN NULL ELSE passage."embeddingDimension" END
      FROM unnest(
        ${plan.updates.map((update) => update.id)}::text[],
        ${plan.updates.map((update) => update.assistantMessageId)}::text[],
        ${plan.updates.map((update) => update.turnAt.toISOString())}::text[],
        ${plan.updates.map((update) => update.text)}::text[],
        ${plan.updates.map((update) => update.contentHash)}::text[],
        ${plan.updates.map((update) => update.textChanged)}::boolean[]
      ) AS row(id, assistant, turn, body, hash, changed)
      WHERE passage."id" = row.id AND passage."chatId" = ${claim.chatId}`;
  }
  if (plan.inserts.length > 0) {
    await tx.$executeRaw`
      INSERT INTO "ChatSearchPassage"
        ("id", "userId", "chatId", "userMessageId", "assistantMessageId", "turnAt", "ordinal", "text", "contentHash")
      SELECT row.id, ${claim.userId}, ${claim.chatId}, row.question, row.assistant, CAST(row.turn AS timestamp(3)),
        row.position, row.body, row.hash
      FROM unnest(
        ${plan.inserts.map(() => randomUUID())}::text[],
        ${plan.inserts.map((insert) => insert.userMessageId)}::text[],
        ${plan.inserts.map((insert) => insert.assistantMessageId)}::text[],
        ${plan.inserts.map((insert) => insert.turnAt.toISOString())}::text[],
        ${plan.inserts.map((insert) => insert.ordinal)}::integer[],
        ${plan.inserts.map((insert) => insert.text)}::text[],
        ${plan.inserts.map((insert) => insert.contentHash)}::text[]
      ) AS row(id, question, assistant, turn, position, body, hash)`;
  }
  await tx.$executeRaw`
    UPDATE "ChatSearchState" SET "indexedLeafMessageId" = ${target.leafMessageId}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "chatId" = ${claim.chatId}`;
  return {
    deleted: plan.deletes.length, inserted: plan.inserts.length, kind: "applied",
    unchanged: plan.unchanged, updated: plan.updates.length
  };
}

export function createPrismaChatSearchIndexStore(db: PrismaClient): ChatSearchIndexStore {
  /** Whether the chat is gone or fenced for permanent deletion, as committed now. */
  const chatGone = async (chatId: string): Promise<boolean> => {
    const chat = await db.chat.findUnique({ select: { permanentDeletionAt: true }, where: { id: chatId } });
    return chat === null || chat.permanentDeletionAt !== null;
  };

  return {
    async claimDue({ leaseUntil, limit, now, ownerIds }) {
      const owners = ownerIds ? Prisma.sql`AND state."userId" = ANY(${[...ownerIds]}::text[])` : Prisma.empty;
      const rows = await db.$queryRaw<Array<{ attemptCount: number; chatId: string; dirtyAt: Date; userId: string }>>`
        WITH due AS (
          SELECT state."chatId" FROM "ChatSearchState" AS state
          WHERE state."dirtyAt" IS NOT NULL
            AND (state."nextAttemptAt" IS NULL OR state."nextAttemptAt" <= ${timestamp(now)})
            ${owners}
          ORDER BY state."dirtyAt" DESC, state."chatId"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "ChatSearchState" AS state
        SET "nextAttemptAt" = ${timestamp(leaseUntil)}, "updatedAt" = CURRENT_TIMESTAMP
        FROM due WHERE state."chatId" = due."chatId"
        RETURNING state."chatId", state."userId", state."dirtyAt", state."attemptCount"`;
      return rows.sort((left, right) => right.dirtyAt.getTime() - left.dirtyAt.getTime() || left.chatId.localeCompare(right.chatId));
    },

    async loadSnapshot(chatId) {
      return db.$transaction(async (tx): Promise<ChatSearchChatSnapshot | null> => {
        const chat = await tx.chat.findUnique({
          select: { activeLeafMessageId: true, title: true, ...chatSearchEligibilitySelect },
          where: { id: chatId }
        });
        if (!chat) return null;
        const path: ChatSearchSourceMessage[] = chat.activeLeafMessageId === null ? [] : (await tx.$queryRaw<PathRow[]>`
          WITH RECURSIVE path AS (
            SELECT message."id", message."parentMessageId", message."role", message."status"::text AS "status",
              message."content", message."createdAt", message."systemTurnKind"::text AS "systemTurnKind",
              message."scheduledTaskPrompt", message."answerReviewSessionId", 0 AS "depth"
            FROM "Message" AS message
            WHERE message."chatId" = ${chatId} AND message."id" = ${chat.activeLeafMessageId}
            UNION ALL
            SELECT parent."id", parent."parentMessageId", parent."role", parent."status"::text,
              parent."content", parent."createdAt", parent."systemTurnKind"::text,
              parent."scheduledTaskPrompt", parent."answerReviewSessionId", path."depth" + 1
            FROM path
            INNER JOIN "Message" AS parent ON parent."chatId" = ${chatId} AND parent."id" = path."parentMessageId"
            WHERE path."depth" < ${MAX_PATH_DEPTH}
          )
          SELECT "id", "parentMessageId", "role", "status", "content", "createdAt", "systemTurnKind",
            "scheduledTaskPrompt", "answerReviewSessionId"
          FROM path ORDER BY "depth" DESC`);
        const files = path.length === 0 ? [] : await tx.attachment.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { fileName: true, messageId: true },
          where: { chatId, messageId: { in: path.map((message) => message.id) }, status: "ready" }
        });
        const fileNames = new Map<string, string[]>();
        for (const file of files) {
          if (!file.messageId) continue;
          fileNames.set(file.messageId, [...(fileNames.get(file.messageId) ?? []), file.fileName]);
        }
        return {
          activeLeafMessageId: chat.activeLeafMessageId,
          chatId,
          eligibility: chatSearchEligibilityFields(chat),
          fileNames,
          path,
          title: chat.title
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    loadSavedSecretValues(userId) {
      return chatSearchSavedSecretValues(db, userId);
    },

    async reconcile(claim, target) {
      try {
        return await db.$transaction(async (tx): Promise<ChatSearchReconcileOutcome> => {
          const chat = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Chat" WHERE "id" = ${claim.chatId} AND "userId" = ${claim.userId} FOR KEY SHARE`;
          if (chat.length === 0) return { kind: "gone" };
          const [state] = await tx.$queryRaw<Array<{ dirtyAt: Date | null }>>`
            SELECT "dirtyAt" FROM "ChatSearchState" WHERE "chatId" = ${claim.chatId} FOR UPDATE`;
          if (!state) return { kind: "gone" };
          if (!sameVersion(state.dirtyAt, claim)) return { kind: "stale" };
          if (target.kind === "clear") {
            await clearChat(tx, claim.chatId);
            return { kind: "cleared" };
          }
          return applyPassages(tx, claim, target);
        });
      } catch (error) {
        // The insert guard refuses passages in a chat fenced for permanent deletion (SQLSTATE 23514): the chat is
        // gone, not a failure to retry. Any other error is one, whatever its code.
        if (!await chatGone(claim.chatId)) throw error;
        await db.$transaction((tx) => clearChat(tx, claim.chatId));
        return { kind: "gone" };
      }
    },

    async passagesToEmbed({ chatId, limit, providerModelId }) {
      return db.$queryRaw<Array<{ contentHash: string; id: string; text: string }>>`
        SELECT "id", "text", "contentHash" FROM "ChatSearchPassage"
        WHERE "chatId" = ${chatId}
          AND ("embedding" IS NULL OR "embeddingProviderModelId" IS DISTINCT FROM ${providerModelId})
        ORDER BY "turnAt" DESC, "ordinal" ASC, "id" ASC
        LIMIT ${limit}`;
    },

    async writeEmbeddings({ chatId, dimension, providerModelId, vectors }) {
      if (vectors.length === 0) return 0;
      return db.$executeRaw`
        UPDATE "ChatSearchPassage" AS passage SET
          "embedding" = CAST(row.vector AS vector),
          "embeddingProviderModelId" = ${providerModelId},
          "embeddingDimension" = ${dimension}
        FROM unnest(
          ${vectors.map((entry) => entry.id)}::text[],
          ${vectors.map((entry) => entry.contentHash)}::text[],
          ${vectors.map((entry) => JSON.stringify(entry.vector))}::text[]
        ) AS row(id, hash, vector)
        WHERE passage."id" = row.id AND passage."chatId" = ${chatId} AND passage."contentHash" = row.hash`;
    },

    async settle(claim, settlement: ChatSearchSettlement) {
      const fields = settlement.kind === "clean"
        ? Prisma.sql`"dirtyAt" = NULL, "nextAttemptAt" = NULL, "attemptCount" = 0, "lastErrorCode" = ${settlement.note}`
        : settlement.kind === "more"
          ? Prisma.sql`"nextAttemptAt" = NULL, "attemptCount" = 0, "lastErrorCode" = NULL`
          : Prisma.sql`"nextAttemptAt" = ${timestamp(settlement.retryAt)},
              "attemptCount" = LEAST("attemptCount" + 1, 1000000), "lastErrorCode" = ${settlement.code}`;
      const settled = await db.$executeRaw`
        UPDATE "ChatSearchState" SET ${fields}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "chatId" = ${claim.chatId} AND "dirtyAt" = ${timestamp(claim.dirtyAt)}`;
      return settled === 1;
    }
  };
}
