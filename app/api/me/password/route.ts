import { createChangePasswordHandler } from "@/lib/server/auth/accountHandlers";
import { createPrismaPasswordChangeRepository } from "@/lib/server/auth/accountRepository";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createPrismaLoginRateLimiter } from "@/lib/server/auth/prismaRateLimit";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createChangePasswordHandler({
  rateLimiter: createPrismaLoginRateLimiter({
    keySecret: () => getAuthConfig().sessionSecret,
    prisma
  }),
  repository: createPrismaPasswordChangeRepository(prisma),
  resolveAuth: resolveRequestAuth
});
