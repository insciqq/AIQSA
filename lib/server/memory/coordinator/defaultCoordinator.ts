import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import { prisma } from "../../prisma";
import { createPrismaMemoryExplicitEmbeddingHandler } from "../embedding/handler";
import { createPrismaMemoryHistoryIndexHandler } from "../history/handler";
import { createPrismaMemoryEpisodeExtractionHandler } from "../history/episode/handler";
import { ensureDefaultMemoryPurgeHandlerRegistered } from "../purge/defaultPurge";
import { MemoryCoordinator } from "./coordinator";
import {
  loadMemoryCoordinatorPolicy,
  type MemoryCoordinatorPolicy
} from "./policy";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import { defaultMemoryCoordinatorRegistry } from "./registry";
import {
  createPrismaMemorySchedulerUsageSource,
  MemoryScheduler,
  type MemorySchedulerBudgetStatus
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
import {
  createPrismaMemoryGlobalDreamHandler,
  reconcileGlobalDreamJobs
} from "../globalDream";
import {
  createPrismaMemoryWorkingSetProfileHandler,
  reconcileMemoryWorkingSetJobs
} from "../profile";
import type { MemoryDeletionHandler, MemoryJobHandler } from "./types";
import { MEMORY_PHASE7_CAPABILITY_POLICY } from "../capabilityPolicy";
import { ensureDefaultMemoryPhase8Composition } from "../phase8Composition";

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
    "EXTRACT_EPISODE",
    "EXTRACT_FACTS",
    "CONSOLIDATE_CANDIDATE",
    "VERIFY_CANDIDATE",
    "GLOBAL_DREAM",
    "RECALCULATE_WORKING_SET",
    "REBUILD_INDEX"
  ] satisfies readonly MemoryJobKind[])
});

export const defaultMemoryCoordinatorRepository =
  createPrismaMemoryCoordinatorRepository(prisma);

// The current coordinator composes the optional vector leaf, but an installation needs
// an exact signed qualification entry before the handler can leave its durable
// waiting state. Registry absence, expiry, or drift remains deliberately fail-closed.
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
const defaultFactExtractionHandler = createPrismaMemoryFactExtractionHandler(
  defaultMemoryExecutionAuthority,
  prisma
);
const defaultFactDecisionHandlers = createPrismaMemoryFactDecisionHandlers(
  defaultMemoryExecutionAuthority,
  prisma
);
const defaultGlobalDreamHandler = createPrismaMemoryGlobalDreamHandler(
  defaultMemoryExecutionAuthority,
  prisma
);
const defaultWorkingSetProfileHandler = createPrismaMemoryWorkingSetProfileHandler(
  defaultMemoryExecutionAuthority,
  prisma,
  {
    profileEnabled: MEMORY_PHASE7_CAPABILITY_POLICY.profileWorkingSet.enabled
  }
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
      policy,
      usageSource: createPrismaMemorySchedulerUsageSource(prisma)
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

export function ensureDefaultMemoryHandlersRegistered(): void {
  ensureDefaultMemoryPhase2HandlersRegistered();
  ensureDeletionHandlerRegistered(
    memoryHistoryClearDeletionHandler,
    "memory_default_history_clear_handler_conflict"
  );
  ensureDefaultMemoryPhase8Composition(kickDefaultMemoryCoordinator);
  ensureJobHandlerRegistered(
    defaultHistoryIndexHandler,
    "memory_default_history_index_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultEpisodeExtractionHandler,
    "memory_default_episode_handler_conflict"
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
    defaultGlobalDreamHandler,
    "memory_default_global_dream_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultWorkingSetProfileHandler,
    "memory_default_working_set_profile_handler_conflict"
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
    reconcileWork: async () => {
      await Promise.all([
        reconcileMemoryHistoryBackfills(prisma),
        reconcileMemoryFactCandidateJobs(prisma),
        reconcileGlobalDreamJobs(prisma),
        reconcileMemoryWorkingSetJobs(prisma)
      ]);
    },
    registry: defaultMemoryCoordinatorRegistry,
    repository: defaultMemoryCoordinatorRepository,
    scheduler: runtime.scheduler
  });
}

export async function readDefaultMemorySchedulerStatus(
  userId?: string
): Promise<MemorySchedulerBudgetStatus> {
  return getDefaultMemoryCoordinatorRuntime().scheduler.status(new Date(), userId);
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
