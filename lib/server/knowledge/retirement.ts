import { Prisma, type PrismaClient } from "@prisma/client";
import { createAccountKnowledgeDeletionHook, type AccountKnowledgeDeletionHook } from "./accountDeletion";
import { drainKnowledgeDeletionJobs, type KnowledgeDeletionDrainSummary } from "./deletionProcessor";

/*
 * Knowledge was removed together with its data (operator decision
 * 2026-10-23); neither installation had a Knowledge base left. Whatever
 * remains (bases, documents, deletion obligations, also after a restore) is
 * deleted through the account Knowledge deletion path: an owner's bases and
 * documents are staged as deletion jobs, the jobs delete rows and stored
 * objects (the object pass settles those), and settled obligations are
 * cleared. Every step is idempotent and claims its work, so it runs safely
 * beside account deletion and `npm run prune`. The passages Knowledge kept in
 * OpenSearch go with OpenSearch, removed in the same release. The tables stay
 * until a later release drops them.
 */

/** Owners one pass stages or settles; the rest follow in later passes. */
export const KNOWLEDGE_RETIREMENT_OWNER_BATCH = 20;

export type KnowledgeRetirementPass = Readonly<{
  /** Owners whose remaining Knowledge this pass staged or settled. */
  owners: number;
  /** Owners whose step failed; they are retried in a later pass. */
  failedOwners: number;
  drain: KnowledgeDeletionDrainSummary | null;
  /** Nothing is left. */
  done: boolean;
}>;

export type KnowledgeRetirementDeps = Readonly<{
  client: PrismaClient;
  advance?: AccountKnowledgeDeletionHook["advance"];
  drain?: () => Promise<KnowledgeDeletionDrainSummary>;
  now?: () => Date;
  ownerBatch?: number;
}>;

/**
 * One bounded pass per call. Once the last owner is gone it reports done
 * once and then does nothing more for the life of the process; a restored
 * backup is picked up by the next process.
 */
export function createKnowledgeRetirement(deps: KnowledgeRetirementDeps) {
  const advance = deps.advance ?? createAccountKnowledgeDeletionHook({ kick: () => undefined }).advance;
  const drain = deps.drain ?? (() => drainKnowledgeDeletionJobs({ client: deps.client }));
  const now = deps.now ?? (() => new Date());
  const ownerBatch = Math.max(1, deps.ownerBatch ?? KNOWLEDGE_RETIREMENT_OWNER_BATCH);
  let after = "";
  let finished = false;

  return async function retireKnowledge(signal?: AbortSignal): Promise<KnowledgeRetirementPass | null> {
    if (finished) return null;
    const owners = await deps.client.$queryRaw<Array<{ ownerUserId: string }>>(Prisma.sql`
      SELECT owner."ownerUserId"
      FROM (
        SELECT "ownerUserId" FROM "KnowledgeBase"
        UNION SELECT "ownerUserId" FROM "KnowledgeSource"
        UNION SELECT "ownerUserId" FROM "KnowledgeDeletionJob"
      ) AS owner
      WHERE owner."ownerUserId" > ${after}
      ORDER BY owner."ownerUserId"
      LIMIT ${ownerBatch}
    `);
    if (owners.length === 0) {
      if (after !== "") {
        after = "";
        return null;
      }
      finished = true;
      return { done: true, drain: null, failedOwners: 0, owners: 0 };
    }
    // A rotating keyset: an owner whose step keeps failing never starves the rest.
    after = owners.length < ownerBatch ? "" : owners.at(-1)!.ownerUserId;
    let failedOwners = 0;
    for (const { ownerUserId } of owners) {
      signal?.throwIfAborted();
      try {
        await deps.client.$transaction((tx) => advance(tx, { now: now(), userId: ownerUserId }));
      } catch {
        failedOwners += 1;
      }
    }
    signal?.throwIfAborted();
    return { done: false, drain: await drain(), failedOwners, owners: owners.length };
  };
}
