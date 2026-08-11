import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import { prisma } from "../../prisma";
import { createPrismaMemoryExplicitEmbeddingHandler } from "../embedding/handler";
import { createPrismaMemoryHistoryIndexHandler } from "../history/handler";
import { createPrismaMemoryEpisodeExtractionHandler } from "../history/episode/handler";
import { ensureDefaultMemoryPurgeHandlerRegistered } from "../purge/defaultPurge";
import { MemoryCoordinator } from "./coordinator";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import { defaultMemoryCoordinatorRegistry } from "./registry";
import { createS3StorageAdapter } from "../../uploads/storage";
import { createPrismaTemporaryChatDeletionHandler } from "../temporaryDeletion";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createPrismaMemoryRebuildHandler } from "../rebuild/handler";
import {
  memoryHistoryClearDeletionHandler,
  memoryHistorySourceDeletionHandler
} from "../history/purge";
import { reconcileMemoryHistoryBackfills } from "../history/backfill";
import type { MemoryDeletionHandler, MemoryJobHandler } from "./types";

type MemoryCoordinatorGlobal = typeof globalThis & {
  __aiqsaMemoryCoordinator?: MemoryCoordinator;
};

export const DEFAULT_MEMORY_PHASE4_COORDINATOR_MANIFEST = Object.freeze({
  deletionOperations: Object.freeze([
    "FORGET_PURGE",
    "TEMPORARY_DELETE",
    "BULK_CLEAR",
    "SOURCE_PURGE"
  ] satisfies readonly MemoryDeletionOperation[]),
  jobKinds: Object.freeze([
    "EMBED_ITEMS",
    "INDEX_HISTORY",
    "EXTRACT_EPISODE",
    "REBUILD_INDEX"
  ] satisfies readonly MemoryJobKind[])
});

export const defaultMemoryCoordinatorRepository =
  createPrismaMemoryCoordinatorRepository(prisma);

// Phase 2 composes the optional vector leaf, but an installation still needs
// an exact signed qualification entry before the handler can leave its durable
// waiting state. The code-owned registry is empty by default and verification
// is deliberately fail-closed until an operator-approved authority is wired.
const defaultExplicitEmbeddingHandler = createPrismaMemoryExplicitEmbeddingHandler(
  defaultMemoryExecutionAuthority,
  prisma
);

const defaultTemporaryChatDeletionHandler =
  createPrismaTemporaryChatDeletionHandler(createS3StorageAdapter(), prisma);

const defaultHistoryIndexHandler = createPrismaMemoryHistoryIndexHandler(prisma);
const defaultEpisodeExtractionHandler = createPrismaMemoryEpisodeExtractionHandler(
  defaultMemoryExecutionAuthority,
  prisma
);
const defaultMemoryRebuildHandler = createPrismaMemoryRebuildHandler(prisma);

function ensureDeletionHandlerRegistered(
  handler: MemoryDeletionHandler,
  conflictCode: string
): void {
  const existing = defaultMemoryCoordinatorRegistry.deletionHandler(handler.operation);
  if (!existing) {
    defaultMemoryCoordinatorRegistry.registerDeletion(handler);
  } else if (existing !== handler) {
    throw new Error(conflictCode);
  }
}

function ensureJobHandlerRegistered(
  handler: MemoryJobHandler,
  conflictCode: string
): void {
  const existing = defaultMemoryCoordinatorRegistry.jobHandler(handler.kind);
  if (!existing) {
    defaultMemoryCoordinatorRegistry.registerJob(handler);
  } else if (existing !== handler) {
    throw new Error(conflictCode);
  }
}

export function ensureDefaultMemoryPhase2HandlersRegistered(): void {
  ensureDefaultMemoryPurgeHandlerRegistered();
  ensureDeletionHandlerRegistered(
    defaultTemporaryChatDeletionHandler,
    "memory_default_temporary_deletion_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultExplicitEmbeddingHandler,
    "memory_default_embedding_handler_conflict"
  );
}

export function ensureDefaultMemoryPhase4HandlersRegistered(): void {
  ensureDefaultMemoryPhase2HandlersRegistered();
  ensureDeletionHandlerRegistered(
    memoryHistoryClearDeletionHandler,
    "memory_default_history_clear_handler_conflict"
  );
  ensureDeletionHandlerRegistered(
    memoryHistorySourceDeletionHandler,
    "memory_default_history_source_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultHistoryIndexHandler,
    "memory_default_history_index_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultEpisodeExtractionHandler,
    "memory_default_episode_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultMemoryRebuildHandler,
    "memory_default_rebuild_handler_conflict"
  );
}

function createDefaultMemoryCoordinator(): MemoryCoordinator {
  ensureDefaultMemoryPhase4HandlersRegistered();
  return new MemoryCoordinator({
    reconcileWork: async () => {
      await reconcileMemoryHistoryBackfills(prisma);
    },
    registry: defaultMemoryCoordinatorRegistry,
    repository: defaultMemoryCoordinatorRepository
  });
}

export function getDefaultMemoryCoordinator(): MemoryCoordinator {
  const scope = globalThis as MemoryCoordinatorGlobal;
  const coordinator = scope.__aiqsaMemoryCoordinator ?? createDefaultMemoryCoordinator();
  scope.__aiqsaMemoryCoordinator = coordinator;
  return coordinator;
}

export function startDefaultMemoryCoordinator(): MemoryCoordinator {
  const coordinator = getDefaultMemoryCoordinator();
  coordinator.start();
  return coordinator;
}

export function kickDefaultMemoryCoordinator(): void {
  startDefaultMemoryCoordinator().kick();
}

export function stopDefaultMemoryCoordinator(): void {
  getDefaultMemoryCoordinator().stop();
}
