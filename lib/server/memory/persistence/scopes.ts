import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryScopeSelection, MemoryScopeType } from "../../../contracts/memory";
import { prisma } from "../../prisma";
import { memoryPersistenceFailure } from "./errors";
import {
  type LockedMemorySettings,
  lockMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export type ActiveMemoryScope = Readonly<{
  id: string;
  scopeType: MemoryScopeType;
  targetIdSnapshot: string | null;
  userId: string;
}>;

type ScopeTarget = Readonly<{
  displaySnapshot: string;
  id: string;
}>;

function activeScope(
  row: Readonly<{
    id: string;
    scopeType: MemoryScopeType;
    targetIdSnapshot: string | null;
    userId: string;
  }>
): ActiveMemoryScope {
  return {
    id: row.id,
    scopeType: row.scopeType,
    targetIdSnapshot: row.targetIdSnapshot,
    userId: row.userId
  };
}

async function requireAvailableTarget(
  tx: MemoryTransaction,
  userId: string,
  selection: Exclude<MemoryScopeSelection, Readonly<{ type: "GLOBAL_USER" }>>,
  lockTarget: boolean
): Promise<ScopeTarget> {
  const lock = lockTarget ? Prisma.sql`FOR SHARE` : Prisma.empty;
  if (selection.type === "FOLDER") {
    const [target] = await tx.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
      SELECT "id", "name"
      FROM "Folder"
      WHERE "id" = ${selection.targetId} AND "userId" = ${userId}
      ${lock}
    `);
    if (!target) return memoryPersistenceFailure("memory_scope_unavailable");
    return { displaySnapshot: target.name, id: target.id };
  }
  if (selection.type === "ASSISTANT") {
    const [target] = await tx.$queryRaw<Array<{ id: string; name: string | null }>>(Prisma.sql`
      SELECT definition."id", revision."name"
      FROM "AssistantDefinition" AS definition
      LEFT JOIN "AssistantRevision" AS revision
        ON revision."assistantId" = definition."id"
       AND revision."id" = definition."currentRevisionId"
      WHERE definition."id" = ${selection.targetId}
        AND definition."ownerUserId" = ${userId}
        AND definition."archivedAt" IS NULL
      ${lockTarget ? Prisma.sql`FOR SHARE OF definition` : Prisma.empty}
    `);
    if (!target) return memoryPersistenceFailure("memory_scope_unavailable");
    return { displaySnapshot: target.name ?? "Assistant", id: target.id };
  }
  const [target] = await tx.$queryRaw<Array<{ id: string; title: string }>>(Prisma.sql`
    SELECT "id", "title"
    FROM "Chat"
    WHERE "id" = ${selection.targetId}
      AND "userId" = ${userId}
      AND "memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
    ${lock}
  `);
  if (!target) return memoryPersistenceFailure("memory_scope_unavailable");
  return { displaySnapshot: target.title, id: target.id };
}

export async function ensureGlobalMemoryScope(
  tx: MemoryTransaction,
  settings: LockedMemorySettings
): Promise<ActiveMemoryScope> {
  const existing = await tx.memoryScope.findFirst({
    select: {
      id: true,
      scopeType: true,
      state: true,
      targetIdSnapshot: true,
      userId: true
    },
    where: { scopeType: "GLOBAL_USER", userId: settings.userId }
  });
  if (existing) {
    if (existing.state !== "ACTIVE") {
      return memoryPersistenceFailure("memory_scope_unavailable");
    }
    return activeScope(existing);
  }
  const created = await tx.memoryScope.create({
    data: { scopeType: "GLOBAL_USER", userId: settings.userId },
    select: { id: true, scopeType: true, targetIdSnapshot: true, userId: true }
  });
  return activeScope(created);
}

export async function ensureActiveMemoryScope(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  selection: MemoryScopeSelection
): Promise<ActiveMemoryScope> {
  if (selection.type === "GLOBAL_USER") {
    return ensureGlobalMemoryScope(tx, settings);
  }
  const target = await requireAvailableTarget(tx, settings.userId, selection, false);
  return ensureActiveTargetMemoryScope(tx, settings, selection, target);
}

async function ensureActiveTargetMemoryScope(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  selection: Exclude<MemoryScopeSelection, Readonly<{ type: "GLOBAL_USER" }>>,
  target: ScopeTarget
): Promise<ActiveMemoryScope> {
  const existing = await tx.memoryScope.findFirst({
    select: {
      id: true,
      scopeType: true,
      state: true,
      targetIdSnapshot: true,
      userId: true
    },
    where: {
      scopeType: selection.type,
      targetIdSnapshot: target.id,
      userId: settings.userId
    }
  });
  if (existing) {
    if (existing.state !== "ACTIVE") {
      return memoryPersistenceFailure("memory_scope_unavailable");
    }
    return activeScope(existing);
  }
  const created = await tx.memoryScope.create({
    data: {
      ...(selection.type === "FOLDER" ? { folderId: target.id } : {}),
      ...(selection.type === "ASSISTANT" ? { assistantId: target.id } : {}),
      ...(selection.type === "CHAT" ? { chatId: target.id } : {}),
      scopeType: selection.type,
      targetDisplaySnapshot: target.displaySnapshot.slice(0, 256),
      targetIdSnapshot: target.id,
      userId: settings.userId
    },
    select: { id: true, scopeType: true, targetIdSnapshot: true, userId: true }
  });
  return activeScope(created);
}

export async function requireActiveOwnedMemoryScope(
  tx: MemoryTransaction,
  userId: string,
  scopeId: string
): Promise<ActiveMemoryScope> {
  const [scope] = await tx.$queryRaw<Array<{
    id: string;
    scopeType: MemoryScopeType;
    targetIdSnapshot: string | null;
    userId: string;
  }>>(Prisma.sql`
    SELECT "id", "userId", "scopeType"::text AS "scopeType", "targetIdSnapshot"
    FROM "MemoryScope"
    WHERE "id" = ${scopeId}
      AND "userId" = ${userId}
      AND "state" = 'ACTIVE'::"MemoryScopeState"
    FOR SHARE
  `);
  if (!scope) return memoryPersistenceFailure("memory_scope_unavailable");
  if (scope.scopeType === "GLOBAL_USER") return activeScope(scope);
  if (!scope.targetIdSnapshot) {
    return memoryPersistenceFailure("memory_scope_unavailable");
  }
  await requireAvailableTarget(tx, userId, {
    targetId: scope.targetIdSnapshot,
    type: scope.scopeType
  }, false);
  return activeScope(scope);
}

export function createPrismaMemoryScopeRepository(client: PrismaClient = prisma) {
  return Object.freeze({
    async ensure(
      userId: string,
      selection: MemoryScopeSelection
    ): Promise<ActiveMemoryScope> {
      if (selection.type === "GLOBAL_USER") {
        return withLockedMemoryTransaction(client, userId, ensureGlobalMemoryScope);
      }
      return client.$transaction(async (tx) => {
        const target = await requireAvailableTarget(tx, userId, selection, true);
        const settings = await lockMemorySettings(tx, userId, true);
        return ensureActiveTargetMemoryScope(tx, settings, selection, target);
      });
    },
    async ensureGlobal(userId: string): Promise<ActiveMemoryScope> {
      return withLockedMemoryTransaction(client, userId, ensureGlobalMemoryScope);
    },
    async requireActive(userId: string, scopeId: string): Promise<ActiveMemoryScope> {
      return withLockedMemoryTransaction(client, userId, (tx) =>
        requireActiveOwnedMemoryScope(tx, userId, scopeId));
    }
  });
}
