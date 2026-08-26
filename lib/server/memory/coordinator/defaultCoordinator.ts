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
import { probeMemoryStructuredOutputAuthority } from "../execution";
import { createPrismaMemoryRebuildHandler } from "../rebuild/handler";
import { memoryHistoryClearDeletionHandler } from "../history/purge";
import { createPrismaMemoryFactExtractionHandler } from "../learning/extraction/handler";
import { createPrismaMemoryReclassificationHandler } from "../reclassification/handler";
import { reconcileMemoryFactReclassificationJobs } from "../reclassification/reconcile";
import { createPrismaMemoryRelationHandler } from "../learning/relations/handler";
import { reconcileMemoryFactRelationJobs } from "../learning/relations/reconcile";
import type { MemoryDeletionHandler, MemoryJobHandler } from "./types";
import { ensureDefaultMemoryDeletionComposition } from "../deletionComposition";
import { defaultMemoryWorkerHeartbeat } from "./workerHeartbeat";
import { preflightPrismaMemoryProviderBindings } from "./providerPreflight";
import { createPrismaMemoryRetrievalCutoverRepository } from "../cutover/repository";
import { createPrismaMemorySynthesisHandler } from "../synthesis/handler";
import { reconcileMemorySynthesisWork } from "../synthesis/reconcile";
import { MEMORY_SYNTHESIS_VERSIONS } from "../synthesis/provider";
import {
  reconcileMemoryHistoryBackfills,
  resolveMemoryHistoryBackfillWindow
} from "../history/backfill";

type MemoryCoordinatorGlobal = typeof globalThis & {
  __aiqsaMemoryCoordinator?: MemoryCoordinator;
  __aiqsaMemoryCoordinatorRuntime?: Readonly<{
    policy: MemoryCoordinatorPolicy;
    scheduler: MemoryScheduler;
  }>;
};

export const defaultMemoryCoordinatorRepository =
  createPrismaMemoryCoordinatorRepository(prisma);

type DefaultMemoryReconciliationWork = Readonly<{
  cutover?: () => Promise<unknown>;
  historyBackfill?: () => Promise<unknown>;
  reclassification?: () => Promise<unknown>;
  relations?: () => Promise<unknown>;
  synthesis?: () => Promise<unknown>;
}>;

const defaultMemoryReconciliationWork: DefaultMemoryReconciliationWork =
  Object.freeze({
    cutover: () => createPrismaMemoryRetrievalCutoverRepository(prisma).reconcile(),
    historyBackfill: () => reconcileMemoryHistoryBackfills(
      prisma,
      resolveMemoryHistoryBackfillWindow(
        getDefaultMemoryCoordinatorRuntime().policy.maxJobParallelPerUser
      )
    ),
    reclassification: () => reconcileMemoryFactReclassificationJobs(prisma),
    relations: () => reconcileMemoryFactRelationJobs(prisma),
    synthesis: () => reconcileMemorySynthesisWork(
      prisma,
      new Date(),
      async (userId) => {
        await probeMemoryStructuredOutputAuthority({
          authority: defaultMemoryExecutionAuthority,
          client: prisma,
          role: "MEMORY_SYNTHESIZE",
          userId,
          versions: MEMORY_SYNTHESIS_VERSIONS
        });
        return true;
      }
    )
  });

export async function reconcileDefaultMemoryWork(
  work: DefaultMemoryReconciliationWork = defaultMemoryReconciliationWork
): Promise<void> {
  // Cutover reconciliation inventories content-free identities and admits a
  // durable shadow rebuild. It must never replay source content from this
  // periodic maintenance pass.
  await work.cutover?.();
  await work.historyBackfill?.();
  await work.reclassification?.();
  await work.relations?.();
  await work.synthesis?.();
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
const defaultMemoryRebuildHandler = createPrismaMemoryRebuildHandler(prisma);
const defaultMemoryReclassificationHandler =
  createPrismaMemoryReclassificationHandler(prisma);
const defaultMemoryRelationHandler = createPrismaMemoryRelationHandler(prisma);
const defaultMemorySynthesisHandler = createPrismaMemorySynthesisHandler(prisma);

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
    defaultMemoryRebuildHandler,
    "memory_default_rebuild_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultMemoryReclassificationHandler,
    "memory_default_reclassification_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultMemoryRelationHandler,
    "memory_default_relation_handler_conflict"
  );
  ensureJobHandlerRegistered(
    defaultMemorySynthesisHandler,
    "memory_default_synthesis_handler_conflict"
  );
}

/**
 * Startup/build owner for the active worker manifest.  Keeping this beside
 * default registration means a newly enqueueable kind cannot be introduced
 * without either a handler or an explicit terminalisation policy.
 */
export function assertDefaultMemoryCoordinatorRegistryComplete(): void {
  ensureDefaultMemoryHandlersRegistered();
  defaultMemoryCoordinatorRegistry.assertComplete();
}

/**
 * Check the durable worker boundary before the process starts claiming jobs.
 * Production always executes the rollback-only lifecycle probe; only the
 * repository factory's hermetic test seam may substitute its implementation.
 */
export async function preflightDefaultMemoryCoordinator(input: Readonly<{
  encryptionKey: Buffer;
}>): Promise<void> {
  assertDefaultMemoryCoordinatorRegistryComplete();
  await defaultMemoryCoordinatorRepository.preflight();
  await preflightPrismaMemoryProviderBindings(prisma, input.encryptionKey);
}

function createDefaultMemoryCoordinator(): MemoryCoordinator {
  ensureDefaultMemoryHandlersRegistered();
  const runtime = getDefaultMemoryCoordinatorRuntime();
  return new MemoryCoordinator({
    onDrain: () => defaultMemoryWorkerHeartbeat.beat(),
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
  // Request processes only enqueue durable work. The dedicated worker (or the
  // explicitly started local-development coordinator) polls that queue; a web
  // request must never create a second claimant that bypasses worker preflight.
}

export function stopDefaultMemoryCoordinator(): void {
  getDefaultMemoryCoordinator().stop();
}
