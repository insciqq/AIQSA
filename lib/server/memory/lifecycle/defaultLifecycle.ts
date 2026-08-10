import { prisma } from "../../prisma";
import { kickDefaultMemoryCoordinator } from "../coordinator/defaultCoordinator";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { defaultMemoryDeletionContributorRegistry } from "../purge/defaultPurge";
import { loadMemorySuppressionKeyring } from "../suppressionKeyring";
import type { MemoryLifecycleMutationRepository } from "./service";
import {
  createPrismaMemoryLifecycleRepository,
  readPrismaMemoryDeletionStatus
} from "./repository";
import { createMemoryLifecycleService } from "./service";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import type { MemoryLifecycleHandlerDeps } from "./handlers";

function configuredMutationRepository(): MemoryLifecycleMutationRepository {
  const configured = loadMemorySuppressionKeyring();
  if (configured.status !== "ready") {
    throw new Error("memory_suppression_keyring_unavailable");
  }
  return createPrismaMemoryLifecycleRepository(
    configured.keyring,
    defaultMemoryDeletionContributorRegistry,
    prisma
  );
}

const mutationRepository: MemoryLifecycleMutationRepository = Object.freeze({
  clearHistory: (userId, input) =>
    configuredMutationRepository().clearHistory(userId, input),
  deleteExplicit: (userId, input) =>
    configuredMutationRepository().deleteExplicit(userId, input),
  forget: (userId, input) => configuredMutationRepository().forget(userId, input),
  status: (userId, deletionId) => readPrismaMemoryDeletionStatus(
    defaultMemoryDeletionContributorRegistry,
    userId,
    deletionId,
    prisma
  )
});

export const defaultMemoryLifecycleService = createMemoryLifecycleService({
  authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
  kick: kickDefaultMemoryCoordinator,
  mutationRepository,
  readRepository: createPrismaExplicitMemoryRepository(prisma)
});

export const defaultMemoryLifecycleHandlerDeps: MemoryLifecycleHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryLifecycleService
};
