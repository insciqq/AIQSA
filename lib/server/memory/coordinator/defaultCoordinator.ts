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

type MemoryCoordinatorGlobal = typeof globalThis & {
  __aiqsaMemoryCoordinator?: MemoryCoordinator;
};

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

export function ensureDefaultMemoryPhase2HandlersRegistered(): void {
  ensureDefaultMemoryPurgeHandlerRegistered();
  const deletion = defaultMemoryCoordinatorRegistry.deletionHandler("TEMPORARY_DELETE");
  if (!deletion) {
    defaultMemoryCoordinatorRegistry.registerDeletion(
      defaultTemporaryChatDeletionHandler
    );
  } else if (deletion !== defaultTemporaryChatDeletionHandler) {
    throw new Error("memory_default_temporary_deletion_handler_conflict");
  }
  const existing = defaultMemoryCoordinatorRegistry.jobHandler("EMBED_ITEMS");
  if (existing === defaultExplicitEmbeddingHandler) return;
  if (existing) throw new Error("memory_default_embedding_handler_conflict");
  defaultMemoryCoordinatorRegistry.registerJob(defaultExplicitEmbeddingHandler);
}

export function ensureDefaultMemoryPhase4HandlersRegistered(): void {
  ensureDefaultMemoryPhase2HandlersRegistered();
  const historyClear = defaultMemoryCoordinatorRegistry.deletionHandler("BULK_CLEAR");
  if (!historyClear) {
    defaultMemoryCoordinatorRegistry.registerDeletion(memoryHistoryClearDeletionHandler);
  } else if (historyClear !== memoryHistoryClearDeletionHandler) {
    throw new Error("memory_default_history_clear_handler_conflict");
  }
  const historySource = defaultMemoryCoordinatorRegistry.deletionHandler("SOURCE_PURGE");
  if (!historySource) {
    defaultMemoryCoordinatorRegistry.registerDeletion(memoryHistorySourceDeletionHandler);
  } else if (historySource !== memoryHistorySourceDeletionHandler) {
    throw new Error("memory_default_history_source_handler_conflict");
  }
  const history = defaultMemoryCoordinatorRegistry.jobHandler("INDEX_HISTORY");
  if (!history) {
    defaultMemoryCoordinatorRegistry.registerJob(defaultHistoryIndexHandler);
  } else if (history !== defaultHistoryIndexHandler) {
    throw new Error("memory_default_history_index_handler_conflict");
  }
  const episode = defaultMemoryCoordinatorRegistry.jobHandler("EXTRACT_EPISODE");
  if (!episode) {
    defaultMemoryCoordinatorRegistry.registerJob(defaultEpisodeExtractionHandler);
  } else if (episode !== defaultEpisodeExtractionHandler) {
    throw new Error("memory_default_episode_handler_conflict");
  }
  const rebuild = defaultMemoryCoordinatorRegistry.jobHandler("REBUILD_INDEX");
  if (!rebuild) {
    defaultMemoryCoordinatorRegistry.registerJob(defaultMemoryRebuildHandler);
  } else if (rebuild !== defaultMemoryRebuildHandler) {
    throw new Error("memory_default_rebuild_handler_conflict");
  }
}

function createDefaultMemoryCoordinator(): MemoryCoordinator {
  ensureDefaultMemoryPhase4HandlersRegistered();
  return new MemoryCoordinator({
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
