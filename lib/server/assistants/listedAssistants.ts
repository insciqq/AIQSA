import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminListedAssistant } from "../../contracts/adminAssistants";
import { ASSISTANT_CHAT_COUNT_WINDOW_DAYS, ASSISTANT_FEATURED_LIMIT } from "../../contracts/assistantListing";
import { decodeAssistantAvatarRecipe } from "../../contracts/assistants";
import {
  AssistantListingError,
  countReviewableAssistantListingRequests,
  encodeListingCursor,
  requireActiveAdmin,
  runListingTransaction
} from "./listingShared";
import type { PrismaAssistantRepository } from "./prismaRepository";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Distinct chats with a run of each Assistant in the trailing window. Only the
 * count leaves the database; which chats or users ran it stays private.
 */
export async function loadAssistantRecentChatCounts(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  assistantIds: readonly string[],
  now = new Date()
): Promise<Map<string, number>> {
  const ids = [...new Set(assistantIds)];
  if (ids.length === 0) return new Map();
  const since = new Date(now.getTime() - ASSISTANT_CHAT_COUNT_WINDOW_DAYS * DAY_MS);
  const rows = await db.$queryRaw<Array<{ assistantId: string; chatCount: number }>>(Prisma.sql`
    SELECT run."assistantId", COUNT(DISTINCT run."chatId")::int AS "chatCount"
    FROM "ModelRun" AS run
    WHERE run."assistantId" IN (${Prisma.join(ids)}) AND run."createdAt" >= ${since}
    GROUP BY run."assistantId"
  `);
  return new Map(rows.map((row) => [row.assistantId, row.chatCount]));
}

/** Featured positions (0 first) of live listed Assistants, for lists and the chat strip. */
export async function loadFeaturedAssistantOrders(
  db: Pick<Prisma.TransactionClient, "assistantPublication">
): Promise<Map<string, number>> {
  const rows = await db.assistantPublication.findMany({
    where: { scope: "installation", featuredOrder: { not: null }, assistant: { archivedAt: null } },
    orderBy: [{ featuredOrder: "asc" }, { id: "asc" }], select: { assistantId: true }
  });
  return new Map(rows.map((row, index) => [row.assistantId, index]));
}

/** New Featured order after placing (or removing, for null) one Assistant. */
export function placeFeaturedAssistant(current: readonly string[], assistantId: string, order: number | null): string[] {
  const rest = current.filter((id) => id !== assistantId);
  if (order === null) return rest;
  if (rest.length >= ASSISTANT_FEATURED_LIMIT) throw new AssistantListingError("assistant_featured_limit");
  rest.splice(Math.min(order, rest.length), 0, assistantId);
  return rest;
}

export type ListedCursor = { id: string; createdAt: Date; featuredOrder: number | null };

function listedAfter(cursor: ListedCursor): Prisma.AssistantPublicationWhereInput {
  const later: Prisma.AssistantPublicationWhereInput[] = [
    { createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }
  ];
  return cursor.featuredOrder === null
    ? { featuredOrder: null, OR: later }
    : { OR: [{ featuredOrder: { gt: cursor.featuredOrder } }, { featuredOrder: null },
      ...later.map((condition) => ({ ...condition, featuredOrder: cursor.featuredOrder }))] };
}

export function createListedAssistantService(db: PrismaClient, repository: Pick<PrismaAssistantRepository, "revokePublication">) {
  return {
    list(userId: string, input: { limit: number; cursor?: ListedCursor }) {
      return runListingTransaction(db, async (tx) => {
        await requireActiveAdmin(tx, userId);
        // Installation publications are already visible to everyone; archived
        // definitions are not, so they stay out of the administrator list too.
        const rows = await tx.assistantPublication.findMany({
          where: { scope: "installation", assistant: { archivedAt: null }, ...(input.cursor ? listedAfter(input.cursor) : {}) },
          orderBy: [{ featuredOrder: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }], take: input.limit + 1,
          select: { id: true, createdAt: true, featuredOrder: true, assistant: { select: {
            id: true, name: true, avatar: true, updatedAt: true, owner: { select: { displayName: true } } } } }
        });
        const page = rows.slice(0, input.limit), last = page.at(-1);
        const chatCounts = await loadAssistantRecentChatCounts(tx, page.map((row) => row.assistant.id));
        const featured = await loadFeaturedAssistantOrders(tx);
        const pendingCount = await countReviewableAssistantListingRequests(tx);
        const assistants: AdminListedAssistant[] = page.map((row) => ({
          assistantId: row.assistant.id, name: row.assistant.name, avatar: decodeAssistantAvatarRecipe(row.assistant.avatar),
          ownerDisplayName: row.assistant.owner.displayName, updatedAt: row.assistant.updatedAt.toISOString(),
          listedAt: row.createdAt.toISOString(), featuredOrder: featured.get(row.assistant.id) ?? null,
          chatCount30Days: chatCounts.get(row.assistant.id) ?? 0
        }));
        return { state: "listed" as const, assistants, pendingCount,
          nextCursor: rows.length > input.limit && last
            ? encodeListingCursor({ id: last.id, createdAt: last.createdAt.toISOString(), featuredOrder: last.featuredOrder })
            : null };
      });
    },
    setFeatured(userId: string, assistantId: string, order: number | null) {
      return runListingTransaction(db, async (tx) => {
        await requireActiveAdmin(tx, userId);
        // One global lock serializes Featured writers; unlisting only deletes
        // rows and never needs it, so gaps it leaves are closed on the next write.
        await tx.$queryRaw<Array<{ lock: string }>>`
          SELECT pg_advisory_xact_lock(hashtextextended('aiqsa:assistant-featured-order', 0))::text AS "lock"`;
        const rows = await tx.assistantPublication.findMany({
          where: { scope: "installation", OR: [{ featuredOrder: { not: null } }, { assistantId }] },
          select: { assistantId: true, featuredOrder: true, assistant: { select: { archivedAt: true } } }
        });
        if (!rows.some((row) => row.assistantId === assistantId && !row.assistant.archivedAt)) {
          throw new AssistantListingError("assistant_not_available", 404);
        }
        const current = rows.filter((row) => row.featuredOrder !== null && !row.assistant.archivedAt)
          .sort((left, right) => left.featuredOrder! - right.featuredOrder! || left.assistantId.localeCompare(right.assistantId))
          .map((row) => row.assistantId);
        const next = placeFeaturedAssistant(current, assistantId, order);
        // The partial unique index is not deferrable: clear every position
        // first, then assign the new dense order. Archived entries drop out.
        // Raw writes keep the publication's updatedAt, which is not a Featured fact.
        await tx.$executeRaw`
          UPDATE "AssistantPublication" SET "featuredOrder" = NULL
          WHERE "scope" = 'installation' AND "featuredOrder" IS NOT NULL`;
        for (const [featuredOrder, id] of next.entries()) {
          await tx.$executeRaw`
            UPDATE "AssistantPublication" SET "featuredOrder" = ${featuredOrder}
            WHERE "scope" = 'installation' AND "assistantId" = ${id}`;
        }
        return next.map((id, featuredOrder) => ({ assistantId: id, featuredOrder }));
      });
    },
    unlist(userId: string, assistantId: string) {
      return runListingTransaction(db, async (tx) => {
        await requireActiveAdmin(tx, userId);
        const publication = await tx.assistantPublication.findFirst({ where: { assistantId, scope: "installation" }, select: { id: true } });
        // Deleting the installation publication also removes its Featured position.
        const result = publication
          ? await repository.revokePublication({ actorIsAdmin: true, assistantId, publicationId: publication.id, userId }, tx)
          : "not_found";
        if (result !== "revoked") throw new AssistantListingError("assistant_not_available", 404);
      });
    }
  };
}
export type ListedAssistantService = ReturnType<typeof createListedAssistantService>;
