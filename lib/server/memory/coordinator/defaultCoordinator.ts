import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import { prisma } from "../../prisma";
import { createPrismaMemoryItemEmbeddingHandler } from "../embedding/handler";
import { createPrismaMemoryHistoryIndexHandler } from "../history/handler";
import { ensureDefaultMemoryPurgeHandlerRegistered } from "../purge/defaultPurge";
import { MemoryCoordinator } from "./coordinator";
import {
  loadMemoryCoordinatorPolicy,
  type MemoryCoordinatorPolicy
} from "./policy";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import { defaultMemoryCoordinatorRegistry } from "./registry";
import {
  MemoryScheduler
} from "./scheduler";
import { createS3StorageAdapter } from "../../uploads/storage";
import { createPrismaTemporaryChatDeletionHandler } from "../temporaryDeletion";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createPrismaMemoryRebuildHandler } from "../rebuild/handler";
import { memoryHistoryClearDeletionHandler } from "../history/purge";
import { reconcileMemoryHistoryBackfills } from "../history/backfill";
import { createPrismaMemoryFactExtractionHandler } from "../learning/extraction/handler";
import { createPrismaMemoryFactDecisionHandlers } from "../learning/consolidation/handler";
import { reconcileMemoryFactCandidateJobs } from "../learning/consolidation/repository";
import type { MemoryDeletionHandler, MemoryJobHandler } from "./types";
import { ensureDefaultMemoryDeletionComposition } from "../deletionComposition";

type MemoryCoordinatorGlobal = typeof globalThis & {
  __aiqsaMemoryCoordinator?: MemoryCoordinator;
  __aiqsaMemoryCoordinatorRuntime?: Readonly<{
    policy: MemoryCoordinatorPolicy;
    scheduler: MemoryScheduler;
  }>;
};

export const DEFAULT_MEMORY_COORDINATOR_MANIFEST = Object.freeze({
  deletionOperations: Object.freeze([
    "FORGET_PURGE",
    "TEMPORARY_DELETE",
    "BULK_CLEAR",
    "SOURCE_PURGE",
    "ACCOUNT_MEMORY_DELETE"
  ] satisfies readonly MemoryDeletionOperation[]),
  jobKinds: Object.freeze([
    "EMBED_ITEMS",
    "INDEX_HISTORY",
    "EXTRACT_FACTS",
    "CONSOLIDATE_CANDIDATE",
    "VERIFY_CANDIDATE",
    "REBUILD_INDEX"
  ] satisfies readonly MemoryJobKind[])
});

export const defaultMemoryCoordinatorRepository =
  createPrismaMemoryCoordinatorRepository(prisma);

type DefaultMemoryReconciliationWork = Readonly<{
  candidates: () => Promise<unknown>;
  history: () => Promise<unknown>;
}>;

const defaultMemoryReconciliationWork: DefaultMemoryReconciliationWork =
  Object.freeze({
    candidates: () => reconcileMemoryFactCandidateJobs(prisma),
    history: () => reconcileMemoryHistoryBackfills(prisma)
  });

export async function reconcileDefaultMemoryWork(
  work: DefaultMemoryReconciliationWork = defaultMemoryReconciliationWork
): Promise<void> {
  // Every discovery path takes the same owner-local SERIALIZABLE settings lock.
  // Running them concurrently creates self-conflicts, retries, and retained dev
  // tracing allocations without increasing useful owner-level throughput.
  await work.history();
  await work.candidates();
}

// Provider-backed work validates current destination, credential, transport,
// schema, and vector-space compatibility through the shared execution boundary.
const defaultItemEmbeddingHandler = createPrismaMemoryItemEmbeddingHandler(
  defaultMemoryExecutionAuthority,
  prisma
);

const defaultTemporaryChatDeletionHandler =
  createPrismaTemporaryChatDeletionHandler(createS3StorageAdapter(), prisma);

const defaultHistoryIndexHandler = createPrismaMemoryHistoryIndexHandler(prisma);
const defaultFactExtractionHandler = createPrismaMemoryFactExtractionHandler(
  defaultMemoryExecutionAuthority,
  prisma
);
const defaultFactDecisionHandlers = createPrismaMemoryFactDecisionHandlers(
  defaultMemoryExecutionAuthority,
  prisma
);
const defaultMemoryRebuildHandler = createPrismaMemoryRebuildHandler(prisma);

function getDefaultMemoryCoordinatorRuntime(): Readonly<{
  policy: MemoryCoordinatorPolicy;
  scheduler: MemoryScheduler;
}> {
  const scope = globalThis as MemoryCoordinatorGlobal;
  if (scope.__aiqsaMemoryCoordinatorRuntime) {
    return scope.__aiqsaMemoryCoordinatorRuntime;
  }
  const policy = loadMemoryCoordinatorPolicy();
  const runtime = Object.freeze({
    policy,
    scheduler: new MemoryScheduler({
      policy
    })
  });
  scope.__aiqsaMemoryCoordinatorRuntime = runtime;
  return runtime;
}

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

export function ensureDefaultMemoryCoreHandlersRegistered(): void {
  ensureDefaultMemoryPurgeHandlerRegistered();
  ensureDeletionHandlerRegistered(
    defaultTemporaryChatDeletionHandler,
    "memory_default_temporary_deletion_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultItemEmbeddingHandler,
    "memory_default_embedding_handler_conflict"
  );
}

export function ensureDefaultMemoryHandlersRegistered(): void {
  ensureDefaultMemoryCoreHandlersRegistered();
  ensureDeletionHandlerRegistered(
    memoryHistoryClearDeletionHandler,
    "memory_default_history_clear_handler_conflict"
  );
  ensureDefaultMemoryDeletionComposition(kickDefaultMemoryCoordinator);
  ensureJobHandlerRegistered(
    defaultHistoryIndexHandler,
    "memory_default_history_index_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultFactExtractionHandler,
    "memory_default_fact_extraction_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultFactDecisionHandlers.consolidation,
    "memory_default_fact_consolidation_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultFactDecisionHandlers.verification,
    "memory_default_fact_verification_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultMemoryRebuildHandler,
    "memory_default_rebuild_handler_conflict"
  );
}

function createDefaultMemoryCoordinator(): MemoryCoordinator {
  ensureDefaultMemoryHandlersRegistered();
  const runtime = getDefaultMemoryCoordinatorRuntime();
  return new MemoryCoordinator({
    policy: runtime.policy,
    reconcileWork: reconcileDefaultMemoryWork,
    registry: defaultMemoryCoordinatorRegistry,
    repository: defaultMemoryCoordinatorRepository,
    scheduler: runtime.scheduler
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
