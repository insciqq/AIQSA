import { Prisma, type PrismaClient } from "@prisma/client";

export class AssistantListingError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly skillNames?: readonly string[]) {
    super(code);
    this.name = "AssistantListingError";
  }
}

const PENDING_INDEX = "AssistantListingRequest_pending_assistant_key";

/** Deadlocks, serialization failures and a lost pending-request race retry twice. */
export async function runListingTransaction<T>(db: PrismaClient, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(write); }
    catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" ||
        (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))) ||
        (error.code === "P2002" && (error.meta?.target === PENDING_INDEX ||
          Array.isArray(error.meta?.target) && error.meta.target.length === 1 && error.meta.target[0] === "assistantId")));
      if (!retryable) throw error;
      if (attempt >= 2) throw new AssistantListingError("assistant_listing_request_conflict");
    }
  }
}

export async function requireActiveAdmin(tx: Prisma.TransactionClient, userId: string) {
  const [admin] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} AND "role" = 'admin' AND "status" = 'active' FOR SHARE`;
  if (!admin) throw new AssistantListingError("forbidden", 403);
}

/** Pending requests an administrator can still decide; outdated ones wait for the owner. */
export async function countReviewableAssistantListingRequests(db: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "AssistantListingRequest" AS request
    INNER JOIN "AssistantDefinition" AS definition ON definition."id" = request."assistantId"
    WHERE request."state" = 'pending' AND definition."archivedAt" IS NULL
      AND definition."version" = request."definitionVersion"`;
  return row?.count ?? 0;
}

export function encodeListingCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
