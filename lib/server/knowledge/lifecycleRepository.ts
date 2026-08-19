import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";

export type KnowledgeLifecycleWriteResult =
  | Readonly<{ kind: "invalid_state" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "version_conflict" }>;

export type KnowledgePermanentDeletionResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_trashed" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "version_conflict" }>;

type Target = "base" | "source";

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

async function serializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < 2 && isSerializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("knowledge_lifecycle_retry_exhausted");
}

export function createPrismaKnowledgeLifecycleRepository(client: PrismaClient = prisma) {
  async function bumpSourceMembershipBases(
    tx: Prisma.TransactionClient,
    sourceId: string
  ): Promise<void> {
    await tx.knowledgeBase.updateMany({
      data: {
        sourceRevision: { increment: 1 },
        version: { increment: 1 }
      },
      where: {
        sourceMemberships: { some: { removedAt: null, sourceId } }
      }
    });
  }

  type StateClient = Pick<Prisma.TransactionClient, "knowledgeBase" | "knowledgeSource">;

  async function baseState(stateClient: StateClient, userId: string, id: string) {
    return stateClient.knowledgeBase.findFirst({
      select: { deletionRequestedAt: true, trashedAt: true, version: true },
      where: { id, ownerUserId: userId }
    });
  }

  async function sourceState(stateClient: StateClient, userId: string, id: string) {
    return stateClient.knowledgeSource.findFirst({
      select: { deletionRequestedAt: true, trashedAt: true, version: true },
      where: { id, ownerUserId: userId }
    });
  }

  async function lifecycleMiss(
    target: Target,
    userId: string,
    id: string,
    expectedVersion: number,
    desiredTrashed: boolean,
    stateClient: StateClient = client
  ): Promise<KnowledgeLifecycleWriteResult> {
    const state = target === "base"
      ? await baseState(stateClient, userId, id)
      : await sourceState(stateClient, userId, id);
    if (!state) return { kind: "not_found" };
    if (!state.deletionRequestedAt && (state.trashedAt !== null) === desiredTrashed) {
      return { kind: "ok" };
    }
    if (state.version !== expectedVersion) return { kind: "version_conflict" };
    return { kind: "invalid_state" };
  }

  async function deletionMiss(
    target: Target,
    userId: string,
    id: string,
    expectedVersion: number,
    stateClient: StateClient = client
  ): Promise<KnowledgePermanentDeletionResult> {
    const state = target === "base"
      ? await baseState(stateClient, userId, id)
      : await sourceState(stateClient, userId, id);
    if (!state) return { kind: "not_found" };
    if (state.deletionRequestedAt) return { kind: "pending" };
    if (state.version !== expectedVersion) return { kind: "version_conflict" };
    return { kind: "not_trashed" };
  }

  const repository = {
    async permanentlyDeleteBase(
      userId: string,
      id: string,
      expectedVersion: number
    ): Promise<KnowledgePermanentDeletionResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const now = new Date();
        const updated = await tx.knowledgeBase.updateMany({
          data: { deletionRequestedAt: now, version: { increment: 1 } },
          where: {
            deletionRequestedAt: null,
            id,
            ownerUserId: userId,
            trashedAt: { not: null },
            version: expectedVersion
          }
        });
        if (updated.count !== 1) {
          return deletionMiss("base", userId, id, expectedVersion, tx);
        }
        await tx.knowledgeDeletionJob.create({
          data: { ownerUserId: userId, targetId: id, targetType: "BASE" }
        });
        return { kind: "pending" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async permanentlyDeleteSource(
      userId: string,
      id: string,
      expectedVersion: number
    ): Promise<KnowledgePermanentDeletionResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const now = new Date();
        const updated = await tx.knowledgeSource.updateMany({
          data: { deletionRequestedAt: now, version: { increment: 1 } },
          where: {
            deletionRequestedAt: null,
            id,
            ownerUserId: userId,
            trashedAt: { not: null },
            version: expectedVersion
          }
        });
        if (updated.count !== 1) {
          return deletionMiss("source", userId, id, expectedVersion, tx);
        }
        await tx.knowledgeDeletionJob.create({
          data: { ownerUserId: userId, targetId: id, targetType: "SOURCE" }
        });
        return { kind: "pending" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async restoreBase(
      userId: string,
      id: string,
      expectedVersion: number
    ): Promise<KnowledgeLifecycleWriteResult> {
      const updated = await client.knowledgeBase.updateMany({
        data: { trashedAt: null, version: { increment: 1 } },
        where: {
          deletionRequestedAt: null,
          id,
          ownerUserId: userId,
          trashedAt: { not: null },
          version: expectedVersion
        }
      });
      return updated.count === 1
        ? { kind: "ok" }
        : lifecycleMiss("base", userId, id, expectedVersion, false);
    },

    async restoreSource(
      userId: string,
      id: string,
      expectedVersion: number
    ): Promise<KnowledgeLifecycleWriteResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const updated = await tx.knowledgeSource.updateMany({
          data: { trashedAt: null, version: { increment: 1 } },
          where: {
            deletionRequestedAt: null,
            id,
            ownerUserId: userId,
            trashedAt: { not: null },
            version: expectedVersion
          }
        });
        if (updated.count !== 1) {
          return lifecycleMiss("source", userId, id, expectedVersion, false, tx);
        }
        await bumpSourceMembershipBases(tx, id);
        return { kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async trashBase(
      userId: string,
      id: string,
      expectedVersion: number
    ): Promise<KnowledgeLifecycleWriteResult> {
      const updated = await client.knowledgeBase.updateMany({
        data: { trashedAt: new Date(), version: { increment: 1 } },
        where: {
          deletionRequestedAt: null,
          id,
          ownerUserId: userId,
          trashedAt: null,
          version: expectedVersion
        }
      });
      return updated.count === 1
        ? { kind: "ok" }
        : lifecycleMiss("base", userId, id, expectedVersion, true);
    },

    async trashSource(
      userId: string,
      id: string,
      expectedVersion: number
    ): Promise<KnowledgeLifecycleWriteResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const updated = await tx.knowledgeSource.updateMany({
          data: { trashedAt: new Date(), version: { increment: 1 } },
          where: {
            deletionRequestedAt: null,
            id,
            ownerUserId: userId,
            trashedAt: null,
            version: expectedVersion
          }
        });
        if (updated.count !== 1) {
          return lifecycleMiss("source", userId, id, expectedVersion, true, tx);
        }
        await bumpSourceMembershipBases(tx, id);
        return { kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    }
  };

  return repository;
}

export type PrismaKnowledgeLifecycleRepository = ReturnType<
  typeof createPrismaKnowledgeLifecycleRepository
>;
