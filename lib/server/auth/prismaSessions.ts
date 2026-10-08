import type { PrismaClient } from "@prisma/client";
import type { AuthSessionStore } from "./requestAuth";
import { issueSignInSession } from "./signInCompletion";

export function createPrismaAuthSessionStore(prisma: PrismaClient): AuthSessionStore {
  return {
    async createSession(input) {
      const { signInMethod, userId, ...session } = input;

      if (signInMethod) {
        // Sign-ins without a transaction of their own (bootstrap token, Google and Yandex)
        // end here: the completion seam and the insert share one transaction. None of them
        // asks for a second factor, so a challenge here is a programming error.
        return prisma.$transaction(async (tx) => {
          const issued = await issueSignInSession(tx, { session, signInMethod, userId });

          if (issued.kind !== "session") {
            throw new Error("sign_in_second_factor_unsupported");
          }

          return issued.session;
        });
      }

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
    async touchSessionActivity(input) {
      await prisma.authSession.updateMany({
        data: { lastSeenAt: input.lastSeenAt },
        where: {
          expiresAt: { gt: input.lastSeenAt },
          id: input.sessionId,
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lt: input.staleBefore } }
          ],
          revokedAt: null,
          userId: input.userId
        }
      });
    }
  };
}
