import { getAuthConfig } from "../../auth/config";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "../../auth/prismaRateLimit";
import { prisma } from "../../prisma";
import { kickDefaultMemoryCoordinator } from "../../memory/coordinator/defaultCoordinator";
import { createPrismaMemoryMutationAuthorizationRepository } from "../../memory/persistence/authorizations";
import {
  defaultPermanentChatDeletionCapability,
  tryEnsureDefaultMemoryDeletionComposition
} from "../../memory/deletionComposition";
import type { PermanentChatDeletionHandlerDeps } from "./handlers";
import { createPrismaPermanentChatDeletionRepository } from "./repository";
import {
  createPermanentChatDeletionService,
  type PermanentChatDeletionCapability
} from "./service";

/** Admission stays feature-dark until the complete deletion composition opens. */
export const permanentChatDeletionCapability: PermanentChatDeletionCapability =
  defaultPermanentChatDeletionCapability;

tryEnsureDefaultMemoryDeletionComposition(kickDefaultMemoryCoordinator);

const repository = createPrismaPermanentChatDeletionRepository(prisma);
const authorizationRepository =
  createPrismaMemoryMutationAuthorizationRepository(prisma);

export const defaultPermanentChatDeletionService =
  createPermanentChatDeletionService({
    authorizationRepository,
    capability: permanentChatDeletionCapability,
    kick: kickDefaultMemoryCoordinator,
    repository
  });

export const defaultPermanentChatDeletionRateLimiter =
  createPrismaLoginRateLimiter({
    keySecret: () => getAuthConfig().sessionSecret,
    maxAttempts: 12,
    prisma,
    windowMs: 60_000
  });

export const defaultPermanentChatDeletionHandlerDeps:
PermanentChatDeletionHandlerDeps = Object.freeze({
  capability: permanentChatDeletionCapability,
  mutationRateLimiter: defaultPermanentChatDeletionRateLimiter,
  resolveAuth: resolveRequestAuth,
  service: defaultPermanentChatDeletionService
});
