import { prisma } from "../../prisma";
import {
  MEMORY_CAPABILITY_QUALIFICATION_REGISTRY
} from "../../../evaluation/memory/qualification";
import { MEMORY_EVALUATION_SCORER_VERSION } from "../../../evaluation/memory/contracts";
import { createPrismaMemoryExplicitEmbeddingHandler } from "../embedding/handler";
import { ensureDefaultMemoryPurgeHandlerRegistered } from "../purge/defaultPurge";
import { MemoryCoordinator } from "./coordinator";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import { defaultMemoryCoordinatorRegistry } from "./registry";
import { createS3StorageAdapter } from "../../uploads/storage";
import { createPrismaTemporaryChatDeletionHandler } from "../temporaryDeletion";

type MemoryCoordinatorGlobal = typeof globalThis & {
  __aiqsaMemoryCoordinator?: MemoryCoordinator;
};

export const defaultMemoryCoordinatorRepository =
  createPrismaMemoryCoordinatorRepository(prisma);

// Phase 2 composes the optional vector leaf, but an installation still needs
// an exact signed qualification entry before the handler can leave its durable
// waiting state. The code-owned registry is empty by default and verification
// is deliberately fail-closed until an operator-approved authority is wired.
const defaultExplicitEmbeddingHandler = createPrismaMemoryExplicitEmbeddingHandler({
  qualification: {
    corpusHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    corpusVersion: "memory-qualification-registry-v1",
    registry: MEMORY_CAPABILITY_QUALIFICATION_REGISTRY,
    scorerVersion: MEMORY_EVALUATION_SCORER_VERSION,
    suiteVersion: "memory-explicit-phase2-v1",
    verifySignature: () => false
  }
}, prisma);

const defaultTemporaryChatDeletionHandler =
  createPrismaTemporaryChatDeletionHandler(createS3StorageAdapter(), prisma);

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

function createDefaultMemoryCoordinator(): MemoryCoordinator {
  ensureDefaultMemoryPhase2HandlersRegistered();
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
