import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { memoryPersistenceFailure } from "./errors";
import {
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export type ActiveMemoryScope = Readonly<{
  id: string;
  scopeType: "GLOBAL_USER";
  userId: string;
}>;

export async function ensureGlobalMemoryScope(
  tx: MemoryTransaction,
  settings: LockedMemorySettings
): Promise<ActiveMemoryScope> {
  const existing = await tx.memoryScope.findFirst({
    select: { id: true, scopeType: true, state: true, userId: true },
    where: { scopeType: "GLOBAL_USER", userId: settings.userId }
  });
  if (existing) {
    if (existing.state !== "ACTIVE") {
      return memoryPersistenceFailure("memory_scope_unavailable");
    }
    return { id: existing.id, scopeType: "GLOBAL_USER", userId: existing.userId };
  }
  const created = await tx.memoryScope.create({
    data: { scopeType: "GLOBAL_USER", userId: settings.userId },
    select: { id: true, userId: true }
  });
  return { ...created, scopeType: "GLOBAL_USER" };
}

export async function requireActiveOwnedMemoryScope(
  tx: MemoryTransaction,
  userId: string,
  scopeId: string
): Promise<ActiveMemoryScope> {
  const scope = await tx.memoryScope.findFirst({
    select: { id: true, scopeType: true, userId: true },
    where: {
      id: scopeId,
      scopeType: "GLOBAL_USER",
      state: "ACTIVE",
      userId
    }
  });
  if (!scope) return memoryPersistenceFailure("memory_scope_unavailable");
  return { id: scope.id, scopeType: "GLOBAL_USER", userId: scope.userId };
}

export function createPrismaMemoryScopeRepository(client: PrismaClient = prisma) {
  return Object.freeze({
    async ensureGlobal(userId: string): Promise<ActiveMemoryScope> {
      return withLockedMemoryTransaction(client, userId, ensureGlobalMemoryScope);
    },
    async requireActive(userId: string, scopeId: string): Promise<ActiveMemoryScope> {
      return withLockedMemoryTransaction(client, userId, (tx) =>
        requireActiveOwnedMemoryScope(tx, userId, scopeId));
    }
  });
}
