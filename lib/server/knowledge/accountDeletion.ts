import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { drainKnowledgeDeletionJobs } from "./deletionProcessor";

export type AccountKnowledgeDeletionAdvance = Readonly<{
  admitted: boolean;
  deletionPending: boolean;
  readyForUserDeletion: boolean;
}>;

export type AccountKnowledgeDeletionHook = Readonly<{
  advance: (
    tx: Prisma.TransactionClient,
    input: Readonly<{ now: Date; userId: string }>
  ) => Promise<AccountKnowledgeDeletionAdvance>;
  kick: () => void;
}>;

type KnowledgeTarget = Readonly<{
  deletionRequestedAt: Date | null;
  id: string;
  targetType: "BASE" | "SOURCE";
}>;

export async function countAccountKnowledgeOwnedData(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<number> {
  const [bases, sources, obligations] = await Promise.all([
    tx.knowledgeBase.count({ where: { ownerUserId: userId } }),
    tx.knowledgeSource.count({ where: { ownerUserId: userId } }),
    tx.knowledgeDeletionJob.count({ where: { ownerUserId: userId } })
  ]);
  return bases + sources + obligations;
}

export async function loadAccountKnowledgeOwnedCounts(
  client: PrismaClient
): Promise<Map<string, number>> {
  const [bases, sources, obligations] = await Promise.all([
    client.knowledgeBase.groupBy({
      _count: { _all: true },
      by: ["ownerUserId"]
    }),
    client.knowledgeSource.groupBy({
      _count: { _all: true },
      by: ["ownerUserId"]
    }),
    client.knowledgeDeletionJob.groupBy({
      _count: { _all: true },
      by: ["ownerUserId"]
    })
  ]);
  const counts = new Map<string, number>();
  for (const row of [...bases, ...sources, ...obligations]) {
    counts.set(row.ownerUserId, (counts.get(row.ownerUserId) ?? 0) + row._count._all);
  }
  return counts;
}

async function listTargets(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<KnowledgeTarget[]> {
  const [bases, sources] = await Promise.all([
    tx.knowledgeBase.findMany({
      orderBy: { id: "asc" },
      select: { deletionRequestedAt: true, id: true },
      where: { ownerUserId: userId }
    }),
    tx.knowledgeSource.findMany({
      orderBy: { id: "asc" },
      select: { deletionRequestedAt: true, id: true },
      where: { ownerUserId: userId }
    })
  ]);
  return [
    ...sources.map((source) => ({ ...source, targetType: "SOURCE" as const })),
    ...bases.map((base) => ({ ...base, targetType: "BASE" as const }))
  ];
}

async function stageTargets(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; targets: readonly KnowledgeTarget[]; userId: string }>
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeSource"
    SET
      "trashedAt" = COALESCE("trashedAt", ${input.now}),
      "deletionRequestedAt" = ${input.now},
      "version" = "version" + 1,
      "updatedAt" = ${input.now}
    WHERE "ownerUserId" = ${input.userId}
      AND "deletionRequestedAt" IS NULL
  `);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeBase"
    SET
      "trashedAt" = COALESCE("trashedAt", ${input.now}),
      "deletionRequestedAt" = ${input.now},
      "version" = "version" + 1,
      "updatedAt" = ${input.now}
    WHERE "ownerUserId" = ${input.userId}
      AND "deletionRequestedAt" IS NULL
  `);
  await tx.knowledgeDeletionJob.createMany({
    data: input.targets.map((target) => ({
      id: randomUUID(),
      ownerUserId: input.userId,
      targetId: target.id,
      targetType: target.targetType
    })),
    skipDuplicates: true
  });
}

async function advanceAccountKnowledgeDeletion(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; userId: string }>
): Promise<AccountKnowledgeDeletionAdvance> {
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("knowledge_account_deletion_clock_invalid");
  }

  const targets = await listTargets(tx, input.userId);
  if (targets.length > 0) {
    await stageTargets(tx, { ...input, targets });
    return { admitted: true, deletionPending: true, readyForUserDeletion: false };
  }

  const obligations = await tx.knowledgeDeletionJob.findMany({
    select: { id: true, state: true },
    where: { ownerUserId: input.userId }
  });
  if (obligations.length === 0) {
    return { admitted: false, deletionPending: false, readyForUserDeletion: true };
  }
  if (obligations.some((obligation) => obligation.state !== "SUCCEEDED")) {
    return { admitted: true, deletionPending: true, readyForUserDeletion: false };
  }

  const pendingObjects = await tx.knowledgeDeletionObject.count({
    where: {
      disposition: "PENDING",
      job: { ownerUserId: input.userId }
    }
  });
  if (pendingObjects > 0) {
    throw new Error("knowledge_account_deletion_settlement_invalid");
  }
  await tx.knowledgeDeletionJob.deleteMany({
    where: { ownerUserId: input.userId, state: "SUCCEEDED" }
  });
  return { admitted: false, deletionPending: false, readyForUserDeletion: true };
}

export function createAccountKnowledgeDeletionHook(input: Readonly<{
  kick: () => void;
}>): AccountKnowledgeDeletionHook {
  return Object.freeze({
    advance: advanceAccountKnowledgeDeletion,
    kick: input.kick
  });
}

let deletionWorkerRunning = false;
let deletionWorkerRerun = false;

export function kickDefaultKnowledgeDeletionWorker(): void {
  if (deletionWorkerRunning) {
    deletionWorkerRerun = true;
    return;
  }
  deletionWorkerRunning = true;
  void (async () => {
    try {
      do {
        deletionWorkerRerun = false;
        await drainKnowledgeDeletionJobs({ client: prisma });
      } while (deletionWorkerRerun);
    } catch {
      console.error("Knowledge deletion worker could not drain queued work.");
    } finally {
      deletionWorkerRunning = false;
    }
  })();
}

const defaultAccountKnowledgeDeletionHook = createAccountKnowledgeDeletionHook({
  kick: kickDefaultKnowledgeDeletionWorker
});

export function getDefaultAccountKnowledgeDeletionHook(): AccountKnowledgeDeletionHook {
  return defaultAccountKnowledgeDeletionHook;
}
