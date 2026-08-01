import { createTokenLoginHandler } from "@/lib/server/auth/handlers";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authRateLimiter, authSessionStore } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const POST = createTokenLoginHandler({
  findUserById: (userId) =>
    prisma.user.findUnique({
      select: {
        displayName: true,
        email: true,
        id: true,
        role: true,
        status: true
      },
      where: {
        id: userId
      }
    }),
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  sessions: authSessionStore
});
