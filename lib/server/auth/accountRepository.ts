import type { Prisma, PrismaClient } from "@prisma/client";
import type { AccountProfileRepository, PasswordChangeRepository } from "./accountHandlers";
import type { SafeUserWithGroups } from "./handlers";
import { lockAuthIdentity } from "./transactionLocks";

type AccountPrismaClient = Pick<PrismaClient, "$transaction" | "authIdentity" | "authSession" | "user">;

/**
 * A registration request creates a password identity before anyone proves ownership of the email.
 * Only email proof sets its hash, so an account has a password only once both are present.
 */
const usablePasswordIdentityWhere = {
  emailVerifiedAt: { not: null },
  passwordHash: { not: null },
  provider: "password"
} satisfies Prisma.AuthIdentityWhereInput;

const profileSelect = {
  authIdentities: {
    select: { id: true },
    where: usablePasswordIdentityWhere
  },
  displayName: true,
  email: true,
  role: true,
  status: true
};

type ProfileRow = {
  authIdentities: { id: string }[];
  displayName: string;
  email: string | null;
  role: string;
  status: string;
};

function serializeProfile(user: ProfileRow | null) {
  if (!user || user.status !== "active") return null;
  return {
    displayName: user.displayName,
    email: user.email,
    hasPassword: user.authIdentities.length > 0,
    role: user.role
  };
}

export async function findAccountUserWithGroups(
  prisma: Pick<PrismaClient, "user">,
  userId: string
): Promise<SafeUserWithGroups | null> {
  const user = await prisma.user.findUnique({
    include: {
      authIdentities: {
        select: { id: true },
        where: usablePasswordIdentityWhere
      },
      groups: {
        include: {
          group: true
        }
      }
    },
    where: {
      id: userId
    }
  });

  if (!user) {
    return null;
  }

  return {
    displayName: user.displayName,
    email: user.email,
    groups: user.groups.map((membership) => ({
      groupId: membership.groupId,
      name: membership.group.name,
      role: membership.role
    })),
    hasPassword: user.authIdentities.length > 0,
    id: user.id,
    role: user.role,
    status: user.status
  };
}

export function createPrismaAccountProfileRepository(
  prisma: AccountPrismaClient
): AccountProfileRepository {
  return {
    async updateDisplayName(userId, displayName) {
      const updated = await prisma.user.updateMany({
        data: { displayName },
        where: { id: userId, status: "active" }
      });
      if (updated.count !== 1) return null;
      return serializeProfile(await prisma.user.findUnique({
        select: profileSelect,
        where: { id: userId }
      }));
    }
  };
}

export function createPrismaPasswordChangeRepository(
  prisma: AccountPrismaClient
): PasswordChangeRepository {
  return {
    async findPasswordIdentityByUserId(userId) {
      const identity = await prisma.authIdentity.findFirst({
        select: { id: true, passwordHash: true },
        where: { ...usablePasswordIdentityWhere, userId }
      });
      return identity ? { id: identity.id, passwordHash: identity.passwordHash } : null;
    },
    async changePassword(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthIdentity(tx, input.identityId);
        const identity = await tx.authIdentity.findUnique({
          select: { passwordHash: true, provider: true, userId: true },
          where: { id: input.identityId }
        });
        if (
          !identity ||
          identity.provider !== "password" ||
          identity.passwordHash !== input.expectedPasswordHash
        ) {
          return false;
        }
        await tx.authIdentity.update({
          data: { passwordHash: input.passwordHash },
          where: { id: input.identityId }
        });
        await tx.authSession.updateMany({
          data: {
            revokedAt: input.now,
            revokedReason: "password_change"
          },
          where: {
            id: { not: input.keepSessionId },
            revokedAt: null,
            userId: identity.userId
          }
        });
        return true;
      });
    }
  };
}
