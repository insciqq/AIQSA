import type { PrismaClient } from "@prisma/client";
import type { AuthSessionStore } from "./requestAuth";

export function createPrismaAuthSessionStore(prisma: PrismaClient): AuthSessionStore {
  return {
    async createSession(input) {
      return prisma.authSession.create({
        data: {
          createdByIp: input.createdByIp ?? null,
          createdByUserAgent: input.createdByUserAgent ?? null,
          expiresAt: input.expiresAt,
          lastSeenAt: input.lastSeenAt ?? null,
          tokenHash: input.tokenHash,
          userId: input.userId
        },
        include: {
          user: true
        }
      });
    },
    async deleteExpiredSessions(now) {
      const result = await prisma.authSession.deleteMany({
        where: {
          expiresAt: {
            lt: now
          }
        }
      });

      return result.count;
    },
    async findSessionByTokenHash(tokenHash) {
      return prisma.authSession.findUnique({
        include: {
          user: true
        },
        where: {
          tokenHash
        }
      });
    },
    async revokeSessionByTokenHash(input) {
      const result = await prisma.authSession.updateMany({
        data: {
          revokedAt: input.revokedAt,
          revokedReason: input.revokedReason
        },
        where: {
          revokedAt: null,
          tokenHash: input.tokenHash
        }
      });

      return result.count;
    },
    async revokeUserSessions(input) {
      const result = await prisma.authSession.updateMany({
        data: {
          revokedAt: input.revokedAt,
          revokedReason: input.revokedReason
        },
        where: {
          revokedAt: null,
          userId: input.userId
        }
      });

      return result.count;
    }
  };
}
