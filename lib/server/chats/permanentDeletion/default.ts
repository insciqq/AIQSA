import { getAuthConfig } from "../../auth/config";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "../../auth/prismaRateLimit";
import { prisma } from "../../prisma";
import type { PermanentChatDeletionHandlerDeps } from "./handlers";
import { createPrismaPermanentChatDeletionRepository } from "./repository";
import {
  createPermanentChatDeletionService,
  permanentChatDeletionCapability
} from "./service";

export { permanentChatDeletionCapability };

const repository = createPrismaPermanentChatDeletionRepository(prisma);

export const defaultPermanentChatDeletionService =
  createPermanentChatDeletionService({
    capability: permanentChatDeletionCapability,
    repository,
    // Imported on first use: the deletion routes must not load the run pipeline's defaults.
    stopSubagents: async (scope) => (await import("../../runs/subagentBackground/default"))
      .getDefaultSubagentBackground().control.stopChat(scope)
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
