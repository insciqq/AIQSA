import {
  Prisma,
  type MemoryEmbeddingBatchItemState,
  type MemoryExecutionState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import type { LockedMemorySettings, MemoryTransaction } from
  "../persistence/transaction";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import type {
  MemoryItemEmbeddingPin,
  MemoryItemEmbeddingTarget
} from "./contract";
import {
  createPrismaMemoryItemEmbeddingRepository,
  type MemoryItemEmbeddingRepository,
  type MemoryItemEmbeddingSettlement
} from "./repository";

export type MemoryEmbeddingBatchBinding = Readonly<{
  acceptedOutputHash: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  secretFreeExecutionSnapshot: Prisma.JsonValue;
  state: MemoryExecutionState;
}>;

export type MemoryEmbeddingBatchStoredItem = Readonly<{
  acceptedOutputHash: string | null;
  completedAt: Date | null;
  errorCode: string | null;
  executionBindingId: string | null;
  id: string;
  indexGenerationId: string;
  inputHash: string | null;
  memoryJobId: string;
  ordinal: number;
  resultDimension: number | null;
  resultVector: readonly number[] | null;
  searchEntryId: string;
  state: MemoryEmbeddingBatchItemState;
  target: MemoryItemEmbeddingTarget | null;
  triggerIdentityHash: string;
  userId: string;
}>;

export type MemoryEmbeddingBatchApplyResult = Readonly<{
  childState: "SETTLED" | "STALE";
  settlement: MemoryItemEmbeddingSettlement;
}>;

function vectorFromJson(value: Prisma.JsonValue | null): readonly number[] | null {
  if (value === null || !Array.isArray(value)) return null;
  return value.every((entry) =>
    typeof entry === "number" && Number.isFinite(entry))
    ? value as number[]
    : null;
}

export function createPrismaMemoryEmbeddingBatchRepository(
  client: PrismaClient = prisma,
  itemRepository: MemoryItemEmbeddingRepository =
    createPrismaMemoryItemEmbeddingRepository(client)
) {
  return Object.freeze({
    async applyResult(
      tx: MemoryTransaction,
      settings: LockedMemorySettings,
      item: MemoryEmbeddingBatchStoredItem,
      target: MemoryItemEmbeddingTarget,
      pin: MemoryItemEmbeddingPin,
      now: Date
    ): Promise<MemoryEmbeddingBatchApplyResult> {
      if (
        item.state !== "RESULT_READY" ||
        !item.executionBindingId ||
        !item.acceptedOutputHash ||
        !item.inputHash ||
        !item.resultVector ||
        !item.resultDimension
      ) {
        throw new Error("memory_embedding_batch_result_invalid");
      }
      const settlement = await itemRepository.applyReady(
        tx,
        settings,
        target,
        pin,
        item.resultVector,
        now
      );
      const childState = settlement === "APPLIED" || settlement === "READY"
        ? "SETTLED"
        : "STALE";
      const updated = await tx.memoryEmbeddingBatchItem.updateMany({
        data: {
          completedAt: now,
          errorCode: childState === "STALE"
            ? "memory_embedding_batch_target_stale"
            : null,
          resultDimension: null,
          resultVector: Prisma.DbNull,
          state: childState
        },
        where: {
          acceptedOutputHash: item.acceptedOutputHash,
          executionBindingId: item.executionBindingId,
          id: item.id,
          inputHash: item.inputHash,
          state: "RESULT_READY",
          userId: item.userId
        }
      });
      if (updated.count !== 1) {
        throw new Error("memory_embedding_batch_result_conflict");
      }
      return { childState, settlement };
    },

    bindings(
      userId: string,
      memoryJobId: string
    ): Promise<readonly MemoryEmbeddingBatchBinding[]> {
      return client.memoryExecutionBinding.findMany({
        orderBy: [{ ordinal: "asc" }, { id: "asc" }],
        select: {
          acceptedOutputHash: true,
          id: true,
          inputHash: true,
          ordinal: true,
          secretFreeExecutionSnapshot: true,
          state: true
        },
        where: {
          logicalRole: "MEMORY_DOCUMENT_EMBED",
          memoryJobId,
          ownerType: "JOB",
          relationsDetachedAt: null,
          userId
        }
      });
    },

    async load(
      userId: string,
      memoryJobId: string
    ): Promise<readonly MemoryEmbeddingBatchStoredItem[]> {
      const rows = await client.memoryEmbeddingBatchItem.findMany({
        orderBy: [{ ordinal: "asc" }, { id: "asc" }],
        where: { memoryJobId, userId }
      });
      return Promise.all(rows.map(async (row) => ({
        ...row,
        resultVector: vectorFromJson(row.resultVector),
        target: await itemRepository.loadTarget(userId, row.searchEntryId)
      })));
    },

    mark(
      userId: string,
      itemIds: readonly string[],
      state: Extract<
        MemoryEmbeddingBatchItemState,
        "FAILED" | "OUTCOME_UNKNOWN" | "STALE"
      >,
      errorCode: string,
      now: Date
    ): Promise<number> {
      if (itemIds.length === 0) return Promise.resolve(0);
      return withLockedMemoryTransaction(client, userId, async (tx) => {
        const updated = await tx.memoryEmbeddingBatchItem.updateMany({
          data: {
            completedAt: now,
            errorCode,
            resultDimension: null,
            resultVector: Prisma.DbNull,
            state
          },
          where: {
            id: { in: [...itemIds] },
            state: { in: ["PENDING", "RESULT_READY"] },
            userId
          }
        });
        return updated.count;
      });
    },

    async persistResult(
      tx: MemoryTransaction,
      input: Readonly<{
        acceptedOutputHash: string;
        bindingId: string;
        dimension: number;
        inputHash: string;
        itemIds: readonly string[];
        userId: string;
        vectors: readonly (readonly number[])[];
      }>
    ): Promise<void> {
      if (
        input.itemIds.length < 1 ||
        input.itemIds.length !== input.vectors.length
      ) {
        throw new Error("memory_embedding_batch_result_invalid");
      }
      for (let ordinal = 0; ordinal < input.itemIds.length; ordinal += 1) {
        const id = input.itemIds[ordinal]!;
        const vector = input.vectors[ordinal]!;
        const current = await tx.memoryEmbeddingBatchItem.findFirst({
          select: {
            acceptedOutputHash: true,
            executionBindingId: true,
            inputHash: true,
            resultDimension: true,
            resultVector: true,
            state: true
          },
          where: { id, userId: input.userId }
        });
        const replayed = current &&
          (current.state === "RESULT_READY" || current.state === "SETTLED") &&
          current.inputHash === input.inputHash &&
          current.executionBindingId === input.bindingId &&
          current.acceptedOutputHash === input.acceptedOutputHash &&
          (current.state === "SETTLED" || (
            current.resultDimension === input.dimension &&
            JSON.stringify(current.resultVector) === JSON.stringify(vector)
          ));
        if (replayed) continue;
        // Deletion, exclusion, or generation reset may cascade the child while
        // the provider request is in flight. The provider usage still settles,
        // but there is deliberately no recovery vector left to persist or
        // later authorize against the removed source.
        if (!current) continue;
        const updated = await tx.memoryEmbeddingBatchItem.updateMany({
          data: {
            acceptedOutputHash: input.acceptedOutputHash,
            errorCode: null,
            executionBindingId: input.bindingId,
            inputHash: input.inputHash,
            resultDimension: input.dimension,
            resultVector: [...vector] as Prisma.InputJsonValue,
            state: "RESULT_READY"
          },
          where: { id, state: "PENDING", userId: input.userId }
        });
        if (updated.count !== 1) {
          throw new Error("memory_embedding_batch_result_conflict");
        }
      }
    },

    retryableFailure(
      userId: string,
      itemIds: readonly string[],
      errorCode: string
    ): Promise<number> {
      if (itemIds.length === 0) return Promise.resolve(0);
      return withLockedMemoryTransaction(client, userId, async (tx) => {
        const updated = await tx.memoryEmbeddingBatchItem.updateMany({
          data: { errorCode },
          where: {
            id: { in: [...itemIds] },
            state: "PENDING",
            userId
          }
        });
        return updated.count;
      });
    }
  });
}

export type MemoryEmbeddingBatchRepository = ReturnType<
  typeof createPrismaMemoryEmbeddingBatchRepository
>;
