import { randomInt, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";

const batchInclude = {
  items: {
    include: { parts: { orderBy: { partNumber: "asc" as const } } },
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }]
  }
} satisfies Prisma.KnowledgeUploadBatchInclude;

type BatchRow = Prisma.KnowledgeUploadBatchGetPayload<{ include: typeof batchInclude }>;
type ItemRow = BatchRow["items"][number];

export type KnowledgeUploadSourceState = Readonly<{
  currentVersionId: string | null;
  pendingVersionId: string | null;
  versionStates: Array<Readonly<{
    errorCode: string | null;
    id: string;
    state: "failed" | "pending" | "processing" | "ready";
    updatedAt: Date;
    warningCodes: string[];
  }>>;
}>;

export type KnowledgeUploadItemRecord = ItemRow & Readonly<{
  sourceState: KnowledgeUploadSourceState | null;
}>;

export type KnowledgeUploadBatchRecord = Omit<BatchRow, "items"> & Readonly<{
  items: KnowledgeUploadItemRecord[];
}>;

export type KnowledgeUploadAdmissionItem = Readonly<{
  checksumHint: string | null;
  clientFileId: string;
  declaredByteSize: number;
  declaredMimeType: string;
  fileName: string;
  id: string;
  multipartUploadId: string | null;
  normalizedMimeType: string;
  parts: Array<Readonly<{ byteOffset: number; byteSize: number; partNumber: number }>>;
  sessionExpiresAt: Date;
  storageKey: string;
  transport: "MULTIPART" | "PROXY";
}>;

export type KnowledgeUploadPrivateTarget = ItemRow & Readonly<{
  knowledgeBaseId: string;
  ownerUserId: string;
}>;

export type KnowledgeUploadCleanup = Readonly<{
  multipartUploadId: string | null;
  storageKey: string | null;
  transport: "MULTIPART" | "PROXY";
}>;

type LockedUploadItem = Readonly<{
  attemptNumber: number;
  batchId: string;
  declaredByteSize: number;
  documentId: string | null;
  documentVersionId: string | null;
  id: string;
  multipartUploadId: string | null;
  sourceId: string | null;
  sourceVersionId: string | null;
  state: "CANCELLED" | "NEEDS_ATTENTION" | "PROCESSING" | "QUEUED" | "REUSED" | "STORED" | "UPLOADING";
  storageKey: string | null;
  transport: "MULTIPART" | "PROXY";
}>;

type LockedUploadBase = Readonly<{
  activeIndexGenerationId: string | null;
  archivedAt: Date | null;
  deletionRequestedAt: Date | null;
  ownerUserId: string;
  profileRevisionId: string | null;
  trashedAt: Date | null;
}>;

// A browser may settle a whole upload batch concurrently, while every item
// deliberately updates the same Base revision under Serializable isolation.
// Retry the complete rollback-safe transaction with jitter so a burst drains
// instead of making all waiters collide again immediately.
const SERIALIZABLE_ATTEMPTS = 24;
const SERIALIZABLE_RETRY_BASE_DELAY_MS = 25;
const SERIALIZABLE_RETRY_MAX_DELAY_MS = 500;

type SerializationRetryDelay = (retryOrdinal: number) => Promise<void>;

async function waitForSerializationRetry(retryOrdinal: number): Promise<void> {
  const ceiling = Math.min(
    SERIALIZABLE_RETRY_MAX_DELAY_MS,
    SERIALIZABLE_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryOrdinal - 1))
  );
  await new Promise<void>((resolve) =>
    setTimeout(resolve, randomInt(1, ceiling + 1)));
}

function serializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === "P2034" ||
    error.code === "P2010" &&
      (error.meta?.code === "40001" || error.meta?.code === "40P01")
  );
}

function uniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function serializable<T>(
  operation: () => Promise<T>,
  retryDelay: SerializationRetryDelay
): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && serializationConflict(error)) {
        await retryDelay(attempt + 1);
        continue;
      }
      throw error;
    }
  }
  throw new Error("knowledge_upload_serializable_retry_exhausted");
}

async function stageUploadCleanup(
  tx: Prisma.TransactionClient,
  cleanup: KnowledgeUploadCleanup
): Promise<void> {
  if (!cleanup.storageKey) return;
  await tx.attachmentDeletionJob.upsert({
    create: {
      multipartUploadId: cleanup.multipartUploadId,
      storageKey: cleanup.storageKey
    },
    update: cleanup.multipartUploadId
      ? { multipartUploadId: cleanup.multipartUploadId }
      : {},
    where: { storageKey: cleanup.storageKey }
  });
}

async function withSourceState(
  client: Prisma.TransactionClient | PrismaClient,
  batches: readonly BatchRow[]
): Promise<KnowledgeUploadBatchRecord[]> {
  const sourceIds = [...new Set(batches.flatMap(({ items }) =>
    items.flatMap(({ sourceId }) => sourceId ? [sourceId] : [])))];
  const sources = sourceIds.length === 0
    ? []
    : await client.knowledgeSource.findMany({
        select: {
          currentVersionId: true,
          id: true,
          pendingVersionId: true,
          versions: {
            select: {
              artifacts: {
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                  errorCode: true,
                  id: true,
                  state: true,
                  updatedAt: true,
                  warningCodes: true
                }
              },
              id: true
            }
          }
        },
        where: { id: { in: sourceIds } }
      });
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  return batches.map((batch) => ({
    ...batch,
    items: batch.items.map((item) => {
      const source = item.sourceId ? sourcesById.get(item.sourceId) : undefined;
      const sourceState = source
        ? {
            currentVersionId: source.currentVersionId,
            pendingVersionId: source.pendingVersionId,
            versionStates: source.versions.flatMap((version) => {
              const artifact = item.sourceArtifactId
                ? version.artifacts.find(({ id }) => id === item.sourceArtifactId)
                : version.artifacts[0];
              return artifact
                ? [{
                    errorCode: artifact.errorCode,
                    id: version.id,
                    state: artifact.state,
                    updatedAt: artifact.updatedAt,
                    warningCodes: [...artifact.warningCodes]
                  }]
                : [];
            })
          } satisfies KnowledgeUploadSourceState
        : null;
      return { ...item, sourceState };
    })
  }));
}

export function knowledgeUploadAdmissionMatches(
  existing: KnowledgeUploadBatchRecord,
  items: readonly KnowledgeUploadAdmissionItem[],
  knowledgeBaseId: string
): boolean {
  if (existing.knowledgeBaseId !== knowledgeBaseId || existing.items.length !== items.length) {
    return false;
  }
  const byClientId = new Map(existing.items.map((item) => [item.clientFileId, item]));
  return items.every((item) => {
    const current = byClientId.get(item.clientFileId);
    return current !== undefined && current.declaredByteSize === item.declaredByteSize &&
      current.declaredMimeType === item.declaredMimeType && current.fileName === item.fileName &&
      current.normalizedMimeType === item.normalizedMimeType &&
      (current.checksumHint?.trim() ?? null) === item.checksumHint;
  });
}

async function lockItem(
  tx: Prisma.TransactionClient,
  input: Readonly<{ batchId: string; itemId: string; knowledgeBaseId: string; userId: string }>
): Promise<LockedUploadItem | null> {
  const rows = await tx.$queryRaw<LockedUploadItem[]>`
    SELECT
      item."id",
      item."batchId",
      item."attemptNumber",
      item."declaredByteSize",
      item."storageKey",
      item."transport"::text AS "transport",
      item."multipartUploadId",
      item."state"::text AS "state",
      item."sourceId",
      item."sourceVersionId",
      item."documentId",
      item."documentVersionId"
    FROM "KnowledgeUploadItem" AS item
    INNER JOIN "KnowledgeUploadBatch" AS batch ON batch."id" = item."batchId"
    WHERE item."id" = ${input.itemId}
      AND item."batchId" = ${input.batchId}
      AND batch."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND batch."ownerUserId" = ${input.userId}
    FOR UPDATE OF item
  `;
  return rows[0] ?? null;
}

export function createPrismaKnowledgeUploadRepository(
  client: PrismaClient = prisma,
  options: Readonly<{ serializationRetryDelay?: SerializationRetryDelay }> = {}
) {
  const serializationRetryDelay = options.serializationRetryDelay ??
    waitForSerializationRetry;
  async function readBatch(where: Prisma.KnowledgeUploadBatchWhereInput): Promise<KnowledgeUploadBatchRecord | null> {
    const row = await client.knowledgeUploadBatch.findFirst({ include: batchInclude, where });
    return row ? (await withSourceState(client, [row]))[0]! : null;
  }

  return {
    async claimProxyStream(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      itemId: string;
      knowledgeBaseId: string;
      now: Date;
      storageKey: string;
      userId: string;
    }>): Promise<"expired" | "not_found" | "ok"> {
      const item = await this.getTarget(input);
      if (!item || item.transport !== "PROXY" || item.state !== "QUEUED" ||
        item.attemptNumber !== input.attemptNumber || item.storageKey !== input.storageKey) {
        return "not_found";
      }
      if (item.sessionExpiresAt <= input.now) return "expired";
      const updated = await client.knowledgeUploadItem.updateMany({
        data: { state: "UPLOADING" },
        where: {
          attemptNumber: input.attemptNumber,
          batch: {
            id: input.batchId,
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.userId
          },
          id: input.itemId,
          sessionExpiresAt: { gt: input.now },
          state: "QUEUED",
          storageKey: input.storageKey,
          transport: "PROXY"
        }
      });
      return updated.count === 1 ? "ok" : "not_found";
    },

    async cancel(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      itemId: string;
      knowledgeBaseId: string;
      now: Date;
      userId: string;
    }>): Promise<
      | Readonly<{ cleanup: KnowledgeUploadCleanup | null; kind: "ok" }>
      | Readonly<{ kind: "not_found" | "settled" }>
    > {
      return serializable(() => client.$transaction(async (tx) => {
        const item = await lockItem(tx, input);
        if (!item) return { kind: "not_found" } as const;
        if (item.attemptNumber !== input.attemptNumber) return { kind: "not_found" } as const;
        if (item.state === "PROCESSING" || item.state === "REUSED") {
          return { kind: "settled" } as const;
        }
        if (item.state === "CANCELLED") return { cleanup: null, kind: "ok" } as const;
        const cleanup = {
          multipartUploadId: item.multipartUploadId,
          storageKey: item.storageKey,
          transport: item.transport
        };
        await stageUploadCleanup(tx, cleanup);
        await tx.knowledgeUploadPart.deleteMany({ where: { uploadItemId: item.id } });
        await tx.knowledgeUploadItem.update({
          data: {
            cancelledAt: input.now,
            errorCode: null,
            multipartUploadId: null,
            state: "CANCELLED",
            storageKey: null,
            uploadedByteSize: 0
          },
          where: { id: item.id }
        });
        return { cleanup, kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      serializationRetryDelay);
    },

    async checkpointPart(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      byteSize: number;
      etag: string;
      itemId: string;
      knowledgeBaseId: string;
      now: Date;
      partNumber: number;
      userId: string;
    }>): Promise<"conflict" | "expired" | "not_found" | "ok"> {
      return serializable(() => client.$transaction(async (tx) => {
        const item = await lockItem(tx, input);
        if (!item || item.transport !== "MULTIPART" ||
          item.attemptNumber !== input.attemptNumber) return "not_found" as const;
        const current = await tx.knowledgeUploadItem.findUnique({
          select: { sessionExpiresAt: true },
          where: { id: item.id }
        });
        if (!current || item.state !== "QUEUED" && item.state !== "UPLOADING") {
          return "conflict" as const;
        }
        if (current.sessionExpiresAt <= input.now) return "expired" as const;
        const part = await tx.knowledgeUploadPart.findUnique({
          where: {
            uploadItemId_partNumber: {
              partNumber: input.partNumber,
              uploadItemId: item.id
            }
          }
        });
        if (!part || part.byteSize !== input.byteSize) return "conflict" as const;
        await tx.knowledgeUploadPart.update({
          data: { completedAt: input.now, etag: input.etag },
          where: {
            uploadItemId_partNumber: {
              partNumber: input.partNumber,
              uploadItemId: item.id
            }
          }
        });
        const completed = await tx.knowledgeUploadPart.aggregate({
          _sum: { byteSize: true },
          where: { completedAt: { not: null }, uploadItemId: item.id }
        });
        await tx.knowledgeUploadItem.update({
          data: {
            state: "UPLOADING",
            uploadedByteSize: Math.min(
              item.declaredByteSize,
              completed._sum.byteSize ?? 0
            )
          },
          where: { id: item.id }
        });
        return "ok" as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      serializationRetryDelay);
    },

    async createBatch(input: Readonly<{
      batchId: string;
      clientBatchId: string;
      items: readonly KnowledgeUploadAdmissionItem[];
      knowledgeBaseId: string;
      userId: string;
    }>): Promise<
      | Readonly<{ batch: KnowledgeUploadBatchRecord; kind: "created" | "existing" }>
      | Readonly<{ kind: "conflict" | "not_found" }>
    > {
      try {
        const created = await serializable(() => client.$transaction(async (tx) => {
          const base = await tx.knowledgeBase.findFirst({
            select: { id: true },
            where: {
              activeIndexGenerationId: { not: null },
              archivedAt: null,
              deletionRequestedAt: null,
              id: input.knowledgeBaseId,
              ownerUserId: input.userId,
              trashedAt: null
            }
          });
          if (!base) return null;
          return tx.knowledgeUploadBatch.create({
            data: {
              clientBatchId: input.clientBatchId,
              id: input.batchId,
              items: {
                create: input.items.map((item) => ({
                  attemptNumber: 1,
                  checksumHint: item.checksumHint,
                  clientFileId: item.clientFileId,
                  declaredByteSize: item.declaredByteSize,
                  declaredMimeType: item.declaredMimeType,
                  fileName: item.fileName,
                  id: item.id,
                  multipartUploadId: item.multipartUploadId,
                  normalizedMimeType: item.normalizedMimeType,
                  parts: { create: item.parts },
                  sessionExpiresAt: item.sessionExpiresAt,
                  storageKey: item.storageKey,
                  transport: item.transport
                }))
              },
              knowledgeBaseId: input.knowledgeBaseId,
              ownerUserId: input.userId
            },
            include: batchInclude
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
        serializationRetryDelay);
        if (!created) return { kind: "not_found" };
        return {
          batch: (await withSourceState(client, [created]))[0]!,
          kind: "created"
        };
      } catch (error) {
        if (!uniqueConflict(error)) throw error;
        const existing = await readBatch({
          clientBatchId: input.clientBatchId,
          ownerUserId: input.userId
        });
        return existing && knowledgeUploadAdmissionMatches(existing, input.items, input.knowledgeBaseId)
          ? { batch: existing, kind: "existing" }
          : { kind: "conflict" };
      }
    },

    getBatch(userId: string, knowledgeBaseId: string, batchId: string) {
      return readBatch({ id: batchId, knowledgeBaseId, ownerUserId: userId });
    },

    getByClientBatchId(userId: string, clientBatchId: string) {
      return readBatch({ clientBatchId, ownerUserId: userId });
    },

    async getTarget(input: Readonly<{
      batchId: string;
      itemId: string;
      knowledgeBaseId: string;
      userId: string;
    }>): Promise<KnowledgeUploadPrivateTarget | null> {
      const item = await client.knowledgeUploadItem.findFirst({
        include: { parts: { orderBy: { partNumber: "asc" } } },
        where: {
          batch: {
            id: input.batchId,
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.userId
          },
          id: input.itemId
        }
      });
      return item ? {
        ...item,
        knowledgeBaseId: input.knowledgeBaseId,
        ownerUserId: input.userId
      } : null;
    },

    async listBatches(userId: string, knowledgeBaseId: string): Promise<KnowledgeUploadBatchRecord[]> {
      const rows = await client.knowledgeUploadBatch.findMany({
        include: batchInclude,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 20,
        where: { knowledgeBaseId, ownerUserId: userId }
      });
      return withSourceState(client, rows);
    },

    async markAttention(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      errorCode: string;
      itemId: string;
      knowledgeBaseId: string;
      storageKey: string;
      userId: string;
    }>): Promise<boolean> {
      const updated = await client.knowledgeUploadItem.updateMany({
        data: { errorCode: input.errorCode, state: "NEEDS_ATTENTION" },
        where: {
          batch: {
            id: input.batchId,
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.userId
          },
          attemptNumber: input.attemptNumber,
          id: input.itemId,
          state: { in: ["QUEUED", "UPLOADING", "STORED", "NEEDS_ATTENTION"] },
          storageKey: input.storageKey
        }
      });
      return updated.count === 1;
    },

    async markStored(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      itemId: string;
      knowledgeBaseId: string;
      storageKey: string;
      userId: string;
    }>): Promise<boolean> {
      const item = await this.getTarget(input);
      if (!item) return false;
      if (item.state === "STORED" && item.attemptNumber === input.attemptNumber &&
        item.storageKey === input.storageKey) return true;
      const updated = await client.knowledgeUploadItem.updateMany({
        data: { state: "STORED", uploadedByteSize: item.declaredByteSize },
        where: {
          attemptNumber: input.attemptNumber,
          batch: {
            id: input.batchId,
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.userId
          },
          id: input.itemId,
          state: { in: ["QUEUED", "UPLOADING"] },
          storageKey: input.storageKey
        }
      });
      return updated.count === 1;
    },

    async retry(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      itemId: string;
      knowledgeBaseId: string;
      multipartUploadId: string | null;
      now: Date;
      parts: Array<Readonly<{ byteOffset: number; byteSize: number; partNumber: number }>>;
      sessionExpiresAt: Date;
      storageKey: string;
      transport: "MULTIPART" | "PROXY";
      userId: string;
    }>): Promise<
      | Readonly<{ cleanup: KnowledgeUploadCleanup; kind: "ok" }>
      | Readonly<{ kind: "conflict" | "not_found" }>
    > {
      return serializable(() => client.$transaction(async (tx) => {
        const item = await lockItem(tx, input);
        if (!item) return { kind: "not_found" } as const;
        if (item.attemptNumber !== input.attemptNumber) {
          return { kind: "conflict" } as const;
        }
        const current = await tx.knowledgeUploadItem.findUnique({
          select: { sessionExpiresAt: true },
          where: { id: item.id }
        });
        const retryable = item.state === "NEEDS_ATTENTION" ||
          (item.state === "UPLOADING" && item.transport === "PROXY") ||
          ((item.state === "QUEUED" || item.state === "UPLOADING") &&
            current !== null && current.sessionExpiresAt <= input.now);
        if (!retryable) return { kind: "conflict" } as const;
        const cleanup = {
          multipartUploadId: item.multipartUploadId,
          storageKey: item.storageKey,
          transport: item.transport
        };
        await stageUploadCleanup(tx, cleanup);
        await tx.knowledgeUploadPart.deleteMany({ where: { uploadItemId: item.id } });
        if (input.parts.length > 0) {
          await tx.knowledgeUploadPart.createMany({
            data: input.parts.map((part) => ({ ...part, uploadItemId: item.id }))
          });
        }
        await tx.knowledgeUploadItem.update({
          data: {
            attemptNumber: { increment: 1 },
            cancelledAt: null,
            errorCode: null,
            multipartUploadId: input.multipartUploadId,
            sessionExpiresAt: input.sessionExpiresAt,
            state: "QUEUED",
            storageKey: input.storageKey,
            transport: input.transport,
            uploadedByteSize: 0
          },
          where: { id: item.id }
        });
        return { cleanup, kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      serializationRetryDelay);
    },

    async settle(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      byteSize: number;
      checksum: string;
      fileName: string;
      itemId: string;
      knowledgeBaseId: string;
      mimeType: string;
      normalizedTextStorageKey: string;
      now: Date;
      sourceArtifactId: string;
      sourceId: string;
      sourceVersionId: string;
      userId: string;
    }>): Promise<
      | Readonly<{ cleanupStorageKey: string; kind: "created" | "reused"; sourceId: string }>
      | Readonly<{ kind: "already_settled"; sourceId: string }>
      | Readonly<{ kind: "conflict" | "not_found" }>
    > {
      return serializable(() => client.$transaction(async (tx) => {
        const item = await lockItem(tx, input);
        if (!item) return { kind: "not_found" } as const;
        if (item.attemptNumber !== input.attemptNumber) return { kind: "conflict" } as const;
        if ((item.state === "PROCESSING" || item.state === "REUSED") && item.sourceId) {
          return { kind: "already_settled", sourceId: item.sourceId } as const;
        }
        if (item.state !== "STORED") {
          return { kind: "conflict" } as const;
        }
        if (!item.storageKey || item.declaredByteSize !== input.byteSize) {
          return { kind: "conflict" } as const;
        }
        const bases = await tx.$queryRaw<LockedUploadBase[]>`
          SELECT
            base."ownerUserId",
            base."archivedAt",
            base."trashedAt",
            base."deletionRequestedAt",
            base."activeIndexGenerationId",
            generation."profileRevisionId"
          FROM "KnowledgeBase" AS base
          LEFT JOIN "KnowledgeIndexGeneration" AS generation
            ON generation."knowledgeBaseId" = base."id"
           AND generation."id" = base."activeIndexGenerationId"
          WHERE base."id" = ${input.knowledgeBaseId}
            AND base."ownerUserId" = ${input.userId}
          FOR UPDATE OF base
        `;
        const base = bases[0];
        if (!base || base.archivedAt || base.trashedAt || base.deletionRequestedAt ||
          !base.activeIndexGenerationId || !base.profileRevisionId) {
          return { kind: "not_found" } as const;
        }
        const duplicate = await tx.knowledgeSource.findFirst({
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          select: { id: true },
          where: {
            currentVersion: {
              is: {
                artifacts: {
                  some: {
                    profileRevisionId: base.profileRevisionId,
                    state: "ready"
                  }
                },
                byteSize: input.byteSize,
                checksum: input.checksum
              }
            },
            deletionRequestedAt: null,
            ownerUserId: input.userId,
            trashedAt: null
          }
        });
        if (duplicate) {
          const membership = await tx.knowledgeBaseSource.findUnique({
            where: {
              knowledgeBaseId_sourceId: {
                knowledgeBaseId: input.knowledgeBaseId,
                sourceId: duplicate.id
              }
            }
          });
          let membershipChanged = false;
          if (!membership) {
            await tx.knowledgeBaseSource.create({
              data: {
                knowledgeBaseId: input.knowledgeBaseId,
                ownerUserId: input.userId,
                sourceId: duplicate.id
              }
            });
            membershipChanged = true;
          } else if (membership.removedAt) {
            await tx.knowledgeBaseSource.update({
              data: { removedAt: null },
              where: {
                knowledgeBaseId_sourceId: {
                  knowledgeBaseId: input.knowledgeBaseId,
                  sourceId: duplicate.id
                }
              }
            });
            membershipChanged = true;
          }
          if (membershipChanged) {
            await tx.knowledgeBase.update({
              data: { version: { increment: 1 } },
              where: { id: input.knowledgeBaseId }
            });
          }
          await stageUploadCleanup(tx, {
            multipartUploadId: item.multipartUploadId,
            storageKey: item.storageKey,
            transport: item.transport
          });
          await tx.knowledgeUploadPart.deleteMany({ where: { uploadItemId: item.id } });
          await tx.knowledgeUploadItem.update({
            data: {
              errorCode: null,
              multipartUploadId: null,
              settledAt: input.now,
              sourceId: duplicate.id,
              state: "REUSED",
              storageKey: null,
              uploadedByteSize: input.byteSize
            },
            where: { id: item.id }
          });
          return {
            cleanupStorageKey: item.storageKey,
            kind: "reused",
            sourceId: duplicate.id
          } as const;
        }

        await tx.knowledgeSource.create({
          data: {
            id: input.sourceId,
            name: input.fileName,
            ownerUserId: input.userId
          }
        });
        await tx.knowledgeSourceVersion.create({
          data: {
            byteSize: input.byteSize,
            checksum: input.checksum,
            fileName: input.fileName,
            id: input.sourceVersionId,
            mimeType: input.mimeType,
            originalStorageKey: item.storageKey,
            ownerUserId: input.userId,
            sourceId: input.sourceId,
            versionNumber: 1
          }
        });
        await tx.knowledgeSource.update({
          data: { pendingVersionId: input.sourceVersionId },
          where: { id: input.sourceId }
        });
        await tx.knowledgeSourceIndexArtifact.create({
          data: {
            id: input.sourceArtifactId,
            nextAttemptAt: input.now,
            normalizedTextStorageKey: input.normalizedTextStorageKey,
            processingStage: "queued",
            profileRevisionId: base.profileRevisionId,
            sourceVersionId: input.sourceVersionId,
            state: "pending"
          }
        });
        await tx.knowledgeBaseSource.create({
          data: {
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.userId,
            sourceId: input.sourceId
          }
        });
        await tx.knowledgeBase.update({
          data: { version: { increment: 1 } },
          where: { id: input.knowledgeBaseId }
        });
        await tx.knowledgeUploadPart.deleteMany({ where: { uploadItemId: item.id } });
        await tx.knowledgeUploadItem.update({
          data: {
            errorCode: null,
            multipartUploadId: null,
            settledAt: input.now,
            sourceArtifactId: input.sourceArtifactId,
            sourceId: input.sourceId,
            sourceVersionId: input.sourceVersionId,
            state: "PROCESSING",
            storageKey: null,
            uploadedByteSize: input.byteSize
          },
          where: { id: item.id }
        });
        return {
          cleanupStorageKey: item.storageKey,
          kind: "created",
          sourceId: input.sourceId
        } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
      serializationRetryDelay);
    },

    async start(input: Readonly<{
      attemptNumber: number;
      batchId: string;
      itemId: string;
      knowledgeBaseId: string;
      now: Date;
      userId: string;
    }>): Promise<"expired" | "not_found" | "ok"> {
      const item = await this.getTarget(input);
      if (!item || item.state !== "QUEUED" && item.state !== "UPLOADING") return "not_found";
      if (item.attemptNumber !== input.attemptNumber) return "not_found";
      if (item.sessionExpiresAt <= input.now) return "expired";
      if (item.transport === "PROXY") return item.state === "QUEUED" ? "ok" : "not_found";
      const updated = await client.knowledgeUploadItem.updateMany({
        data: { state: "UPLOADING" },
        where: {
          attemptNumber: input.attemptNumber,
          batch: {
            id: input.batchId,
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.userId
          },
          id: item.id,
          sessionExpiresAt: { gt: input.now },
          state: { in: ["QUEUED", "UPLOADING"] },
          transport: "MULTIPART"
        }
      });
      return updated.count === 1 ? "ok" : "not_found";
    }
  };
}

export type PrismaKnowledgeUploadRepository = ReturnType<typeof createPrismaKnowledgeUploadRepository>;

export function newKnowledgeUploadSettlementIds(): Readonly<{
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
}> {
  return {
    sourceArtifactId: randomUUID(),
    sourceId: randomUUID(),
    sourceVersionId: randomUUID()
  };
}
