import { getAuthConfig } from "../../auth/config";
import { createPrismaLoginRateLimiter } from "../../auth/prismaRateLimit";
import { prisma } from "../../prisma";

export const defaultMemoryReviewRateLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret,
  maxAttempts: 60,
  prisma,
  windowMs: 60_000
});
