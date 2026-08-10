import { getAuthConfig } from "../../auth/config";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "../../auth/prismaRateLimit";
import { prisma } from "../../prisma";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { loadMemorySuppressionKeyring } from "../suppressionKeyring";
import type { ExplicitMemoryHandlerDeps } from "./handlers";
import { createPrismaExplicitMemoryRepository } from "./repository";
import {
  createExplicitMemoryService,
  type ExplicitMemoryFactRepository
} from "./service";

const authorizationRepository =
  createPrismaMemoryMutationAuthorizationRepository(prisma);
const readRepository = createPrismaExplicitMemoryRepository(prisma);
const scopeRepository = createPrismaMemoryScopeRepository(prisma);

function configuredFactRepository(): ExplicitMemoryFactRepository {
  const configured = loadMemorySuppressionKeyring();
  if (configured.status !== "ready") {
    throw new Error("memory_suppression_keyring_unavailable");
  }
  return createPrismaMemoryFactRepository(configured.keyring, prisma);
}

const factRepository: ExplicitMemoryFactRepository = Object.freeze({
  edit: (userId, input) => configuredFactRepository().edit(userId, input),
  move: (userId, input) => configuredFactRepository().move(userId, input),
  save: (userId, input) => configuredFactRepository().save(userId, input)
});

export const defaultExplicitMemoryService = createExplicitMemoryService({
  authorizationRepository,
  factRepository,
  readRepository,
  scopeRepository
});

export const defaultMemoryMutationAuthorizationRateLimiter =
  createPrismaLoginRateLimiter({
    keySecret: () => getAuthConfig().sessionSecret,
    maxAttempts: 30,
    prisma,
    windowMs: 60_000
  });

export const defaultExplicitMemoryHandlerDeps: ExplicitMemoryHandlerDeps = {
  mutationRateLimiter: defaultMemoryMutationAuthorizationRateLimiter,
  resolveAuth: resolveRequestAuth,
  service: defaultExplicitMemoryService
};
