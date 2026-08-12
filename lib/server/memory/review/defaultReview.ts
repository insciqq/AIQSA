import { getAuthConfig } from "../../auth/config";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "../../auth/prismaRateLimit";
import { prisma } from "../../prisma";
import { createPrismaMemoryFeedbackRepository } from "./feedbackRepository";
import type { MemoryReviewHandlerDeps } from "./handlers";
import { createMemoryReviewService } from "./service";

export const defaultMemoryReviewService = createMemoryReviewService(
  createPrismaMemoryFeedbackRepository(prisma)
);

export const defaultMemoryReviewRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: 60,
  prisma,
  windowMs: 60_000
});

export const defaultMemoryReviewHandlerDeps: MemoryReviewHandlerDeps = {
  mutationRateLimiter: defaultMemoryReviewRateLimiter,
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryReviewService
};
