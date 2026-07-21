import type { AuthIdentityProvider, Prisma, PrismaClient } from "@prisma/client";
import type { OAuthProviderId } from "../../auth/oauth";
import { normalizeAuthEmail } from "./password";
import { provisionActiveUser } from "./provisioning";
import { findEnabledAccessRuleMatch } from "./registrationRepository";
import { lockAuthIdentity, lockAuthRegistrationEmail, lockAuthUser } from "./transactionLocks";

export type OAuthIdentitySettlementInput = {
  displayName: string;
  email: string;
  now: Date;
  provider: OAuthProviderId;
  providerAccountId: string;
};

export type OAuthIdentitySettlementResult =
  | {
      status: "active";
      userId: string;
    }
  | {
      status: "account_conflict" | "not_allowed" | "pending";
    };

export type OAuthIdentityRepository = {
  settleIdentity(input: OAuthIdentitySettlementInput): Promise<OAuthIdentitySettlementResult>;
};

type OAuthIdentityWithUser = Prisma.AuthIdentityGetPayload<{
  include: {
    user: true;
  };
}>;

function providerValue(provider: OAuthProviderId): AuthIdentityProvider {
  return provider;
}

function fallbackDisplayName(input: OAuthIdentitySettlementInput, normalizedEmail: string): string {
  return input.displayName.trim().slice(0, 160) || normalizedEmail.split("@")[0] || "AIQSA User";
}

async function lockedIdentity(
  tx: Prisma.TransactionClient,
  identity: OAuthIdentityWithUser
): Promise<OAuthIdentityWithUser | null> {
  await lockAuthIdentity(tx, identity.id);
  await lockAuthUser(tx, identity.userId);

  return tx.authIdentity.findUnique({
    include: {
      user: true
    },
    where: {
      id: identity.id
    }
  });
}

async function settlePendingUser(
  tx: Prisma.TransactionClient,
  input: {
    normalizedEmail: string;
    userId: string;
  }
): Promise<OAuthIdentitySettlementResult> {
  const approval = await findEnabledAccessRuleMatch(tx, input.normalizedEmail);

  if (!approval) {
    return {
      status: "pending"
    };
  }

  await tx.user.update({
    data: {
      status: "active"
    },
    where: {
      id: input.userId
    }
  });
  await provisionActiveUser(tx, {
    groups: approval.groups,
    userId: input.userId
  });

  return {
    status: "active",
    userId: input.userId
  };
}

export function createPrismaOAuthIdentityRepository(prisma: PrismaClient): OAuthIdentityRepository {
  return {
    async settleIdentity(input) {
      const normalizedEmail = normalizeAuthEmail(input.email);
      const provider = providerValue(input.provider);

      return prisma.$transaction(async (tx) => {
        await lockAuthRegistrationEmail(tx, normalizedEmail);

        const subjectCandidate = await tx.authIdentity.findUnique({
          include: {
            user: true
          },
          where: {
            provider_providerAccountId: {
              provider,
              providerAccountId: input.providerAccountId
            }
          }
        });

        if (subjectCandidate) {
          const identity = await lockedIdentity(tx, subjectCandidate);

          if (!identity || identity.user.status === "disabled" || identity.user.status === "denied") {
            return {
              status: "not_allowed"
            };
          }

          const currentEmailIdentity = await tx.authIdentity.findUnique({
            select: {
              id: true
            },
            where: {
              provider_normalizedEmail: {
                normalizedEmail,
                provider
              }
            }
          });

          if (currentEmailIdentity && currentEmailIdentity.id !== identity.id) {
            return {
              status: "account_conflict"
            };
          }

          if (identity.user.status === "active") {
            return {
              status: "active",
              userId: identity.userId
            };
          }

          return settlePendingUser(tx, {
            normalizedEmail: identity.normalizedEmail,
            userId: identity.userId
          });
        }

        const emailIdentity = await tx.authIdentity.findUnique({
          where: {
            provider_normalizedEmail: {
              normalizedEmail,
              provider
            }
          }
        });

        if (emailIdentity) {
          return {
            status: "account_conflict"
          };
        }

        let user = await tx.user.findUnique({
          where: {
            email: normalizedEmail
          }
        });

        if (user) {
          await lockAuthUser(tx, user.id);
          user = await tx.user.findUnique({
            where: {
              id: user.id
            }
          });
        }

        if (user?.status === "disabled" || user?.status === "denied") {
          return {
            status: "not_allowed"
          };
        }

        const approval = user?.status === "active" ? null : await findEnabledAccessRuleMatch(tx, normalizedEmail);

        if (!user && !approval) {
          return {
            status: "not_allowed"
          };
        }

        user ??= await tx.user.create({
          data: {
            displayName: fallbackDisplayName(input, normalizedEmail),
            email: normalizedEmail,
            role: "user",
            status: "pending"
          }
        });

        await tx.authIdentity.create({
          data: {
            emailVerifiedAt: input.now,
            normalizedEmail,
            passwordHash: null,
            provider,
            providerAccountId: input.providerAccountId,
            userId: user.id
          }
        });

        if (user.status === "active") {
          return {
            status: "active",
            userId: user.id
          };
        }

        if (!approval) {
          return {
            status: "pending"
          };
        }

        await tx.user.update({
          data: {
            status: "active"
          },
          where: {
            id: user.id
          }
        });
        await provisionActiveUser(tx, {
          groups: approval.groups,
          userId: user.id
        });

        return {
          status: "active",
          userId: user.id
        };
      });
    }
  };
}
