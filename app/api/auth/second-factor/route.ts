import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter } from "@/lib/server/auth/defaultAuth";
import { getTotpKeys } from "@/lib/server/auth/totp";
import { createSecondFactorSignInHandler } from "@/lib/server/auth/totpHandlers";
import { createPrismaSecondFactorSignInRepository } from "@/lib/server/auth/totpRepository";
import { readSignInPolicy } from "@/lib/server/auth/signInSettings/defaultSignInSettings";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const POST = createSecondFactorSignInHandler({
  getConfig: () => getAuthConfig(),
  getKeys: () => getTotpKeys(),
  rateLimiter: authRateLimiter,
  repository: createPrismaSecondFactorSignInRepository(prisma),
  signInPolicy: readSignInPolicy
});
