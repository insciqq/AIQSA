import type { PrismaClient } from "@prisma/client";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService, type ExplicitMemoryFactRepository } from "../explicit/service";
import { createPrismaMemoryLifecycleRepository, readPrismaMemoryDeletionStatus } from "../lifecycle/repository";
import { createMemoryLifecycleService, type MemoryLifecycleMutationRepository } from "../lifecycle/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { resolveMemoryExplicitEquivalentTarget } from "../persistence/explicitEquivalence";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { defaultMemoryDeletionContributorRegistry } from "../purge/defaultPurge";
import { loadMemorySuppressionKeyring } from "../suppressionKeyring";

/** Every authority/read/write shares the supplied client. Key material is loaded
 * lazily, after source validation, just like the interactive service composition. */
export function createMemoryCommandServices(client: PrismaClient) {
  function keyring() {
    const configured = loadMemorySuppressionKeyring();
    if (configured.status !== "ready") throw new Error("memory_suppression_keyring_unavailable");
    return configured.keyring;
  }
  const fact = () => createPrismaMemoryFactRepository(keyring(), client);
  const lifecycle = () => createPrismaMemoryLifecycleRepository(keyring(), defaultMemoryDeletionContributorRegistry, client);
  const factRepository: ExplicitMemoryFactRepository = {
    edit: (userId, input) => fact().edit(userId, input),
    move: (userId, input) => fact().move(userId, input),
    resolve: (userId, input) => fact().resolve(userId, input),
    save: (userId, input) => fact().save(userId, input)
  };
  const mutationRepository: MemoryLifecycleMutationRepository = {
    clearHistory: (userId, input) => lifecycle().clearHistory(userId, input),
    deleteAllReusable: (userId, input) => lifecycle().deleteAllReusable(userId, input),
    deleteExplicit: (userId, input) => lifecycle().deleteExplicit(userId, input),
    deleteLearned: (userId, input) => lifecycle().deleteLearned(userId, input),
    forget: (userId, input) => lifecycle().forget(userId, input),
    status: (userId, deletionId) => readPrismaMemoryDeletionStatus(defaultMemoryDeletionContributorRegistry, userId, deletionId, client)
  };
  const authorizationRepository = createPrismaMemoryMutationAuthorizationRepository(client);
  const readRepository = createPrismaExplicitMemoryRepository(client);
  return {
    explicitService: createExplicitMemoryService({
      authorizationRepository, factRepository, readRepository,
      resolveEquivalentTarget: (userId, target, now) => resolveMemoryExplicitEquivalentTarget(client, userId, target, now),
      scopeRepository: createPrismaMemoryScopeRepository(client)
    }),
    lifecycleService: createMemoryLifecycleService({ authorizationRepository, mutationRepository, readRepository,
      // This code already runs in the polling worker. Enqueued deletion work is
      // picked up through the same durable coordinator, without another process.
      kick: () => {} })
  };
}
