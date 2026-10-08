import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter, authSessionStore } from "@/lib/server/auth/defaultAuth";
import { resolveSignInMethods } from "@/lib/server/auth/signInMethods";
import { recordSignInMethodOutcome } from "@/lib/server/auth/signInSettings/defaultSignInSettings";
import { createTrustedHeaderSignInHandler } from "@/lib/server/auth/trustedHeader/handlers";
import { createPrismaTrustedHeaderSignInRepository } from "@/lib/server/auth/trustedHeader/repository";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const GET = createTrustedHeaderSignInHandler({
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  recordOutcome: recordSignInMethodOutcome,
  repository: createPrismaTrustedHeaderSignInRepository(prisma),
  resolveMethod: async () => (await resolveSignInMethods()).trusted_header ?? null,
  sessions: authSessionStore
});
