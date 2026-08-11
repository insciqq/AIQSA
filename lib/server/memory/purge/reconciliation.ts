import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { parseMemoryPurgeTarget } from "./contract";
import type {
  MemoryDeletionContributorRegistry,
  MemoryDeletionProgress
} from "./registry";

export type MemoryDeletionAuditSnapshot = Readonly<{
  completedAt: Date | null;
  id: string;
  lastAuditAt: Date | null;
  memoryGeneration: number;
  operation: "FORGET_PURGE";
  progress: MemoryDeletionProgress;
  state: "BLOCKED_REQUIRES_ADMIN" | "PENDING" | "RETRY_WAIT" | "RUNNING" | "SUCCEEDED";
  targetId: string;
  targetType: string;
  updatedAt: Date;
  userId: string;
}>;

const auditRowSelect = {
  completedAt: true,
  id: true,
  lastAuditAt: true,
  memoryGeneration: true,
  operation: true,
  state: true,
  targetId: true,
  targetType: true,
  updatedAt: true,
  userId: true
} as const;

export async function auditMemoryDeletion(
  registry: MemoryDeletionContributorRegistry,
  deletionId: string,
  userId: string,
  client: PrismaClient = prisma,
  now = new Date()
): Promise<MemoryDeletionAuditSnapshot | null> {
  return client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "MemoryDeletionOutbox"
      WHERE "id" = ${deletionId} AND "userId" = ${userId}
      FOR UPDATE
    `);
    if (!locked[0]) return null;
    let row = await tx.memoryDeletionOutbox.findFirst({
      select: auditRowSelect,
      where: { id: deletionId, userId }
    });
    if (!row || row.operation !== "FORGET_PURGE") return null;
    const target = parseMemoryPurgeTarget(row);
    if (!target) return null;
    const progress = await registry.inspect(tx, target);
    if (row.state === "SUCCEEDED") {
      if (progress.complete) {
        row = await tx.memoryDeletionOutbox.update({
          data: { lastAuditAt: now, updatedAt: now },
          select: auditRowSelect,
          where: { id: row.id }
        });
      } else {
        row = await tx.memoryDeletionOutbox.update({
          data: {
            completedAt: null,
            errorCode: "memory_purge_incomplete",
            lastAuditAt: now,
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            state: "PENDING",
            updatedAt: now
          },
          select: auditRowSelect,
          where: { id: row.id }
        });
      }
    } else {
      row = await tx.memoryDeletionOutbox.update({
        data: { lastAuditAt: now, updatedAt: now },
        select: auditRowSelect,
        where: { id: row.id }
      });
    }
    return {
      ...row,
      operation: "FORGET_PURGE",
      progress
    };
  });
}

export async function reconcileCompletedMemoryDeletionAudits(input: Readonly<{
  client?: PrismaClient;
  limit?: number;
  now?: Date;
  registry: MemoryDeletionContributorRegistry;
}>): Promise<Readonly<{ checked: number; reopened: number }>> {
  const client = input.client ?? prisma;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("memory_deletion_audit_limit_invalid");
  }
  const now = input.now ?? new Date();
  const rows = await client.memoryDeletionOutbox.findMany({
    orderBy: [{ lastAuditAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true },
    take: limit,
    where: {
      AND: [
        { OR: [{ lastAuditAt: null }, { lastAuditAt: { lt: now } }] },
        {
          OR: [
            { targetType: { startsWith: "MEMORY_FACT@" } },
            { targetType: { startsWith: "EXPLICIT_SET@" } }
          ]
        }
      ],
      operation: "FORGET_PURGE",
      state: "SUCCEEDED"
    }
  });
  let reopened = 0;
  for (const row of rows) {
    const audited = await auditMemoryDeletion(
      input.registry,
      row.id,
      row.userId,
      client,
      now
    );
    if (audited?.state === "PENDING") reopened += 1;
  }
  return { checked: rows.length, reopened };
}
