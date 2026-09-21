import { getAuthConfig } from "../auth/config";
import { resolveLoginRateLimitIdentity } from "../auth/clientIdentity";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import type { LoginRateLimiter } from "../auth/rateLimit";
import { prisma } from "../prisma";

const limiter = createPrismaLoginRateLimiter({ prisma, keySecret: () => getAuthConfig().sessionSecret, maxAttempts: 120, windowMs: 60_000 });

/** Called before token validation/lookup for both the page and content route. */
export async function publicArtifactRateLimit(request: Request, rateLimiter: LoginRateLimiter = limiter) {
  const identity = resolveLoginRateLimitIdentity(request, getAuthConfig());
  if (identity.status === "unavailable") return { allowed: false, retryAfterSeconds: 60 };
  // Direct loopback has no remote identity; still bound its combined workload.
  return rateLimiter.check(`artifact-public:${identity.status === "available" ? identity.key : "loopback"}`);
}
