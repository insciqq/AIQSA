import { Prisma, type PrismaClient } from "@prisma/client";
import { authEmailDomain, normalizeAuthDomain } from "./password";
import { provisionActiveUser, type ProvisioningGroupInput } from "./provisioning";
import type { CreateAuthSessionInput } from "./requestAuth";
import {
  lockAuthFlowToken,
  lockAuthIdentity,
  lockAuthInvite,
  lockAuthRegistrationEmail,
  lockAuthUser
} from "./transactionLocks";

export type ActivationSource = "domain_rule" | "email_rule" | "invite";

export type RegistrationFailureCode = "invalid_invite_token" | "registration_not_allowed";

export type RegistrationResult =
  | {
      ok: true;
      sentToEmail: string | null;
    }
  | {
      error: RegistrationFailureCode;
      ok: false;
    };

export type VerificationResult = {
  source: ActivationSource | null;
  status: "active" | "pending";
  userId: string;
};

export type RegisterPasswordUserInput = {
  displayName: string;
  email: string;
  expiresAt: Date;
  inviteTokenHash?: string | null;
  normalizedEmail: string;
  now: Date;
  verificationTokenHash: string;
};

export type AcceptInviteInput = {
  displayName: string;
  inviteTokenHash: string;
  now: Date;
  passwordHash: string;
  session: Omit<CreateAuthSessionInput, "userId">;
};

export type InviteAcceptanceResult = {
  userId: string;
};

export type AuthRegistrationRepository = {
  acceptInvite(input: AcceptInviteInput): Promise<InviteAcceptanceResult | null>;
  completeEmailVerification(input: {
    now: Date;
    passwordHash: string;
    tokenHash: string;
  }): Promise<VerificationResult | null>;
  registerPasswordUser(input: RegisterPasswordUserInput): Promise<RegistrationResult>;
};

type GroupDefault = ProvisioningGroupInput;

export type ApprovalMatch = {
  groups: GroupDefault[];
  source: ActivationSource;
};

type InviteTokenMetadata = {
  inviteFlowTokenId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inviteTokenMetadata(value: unknown): InviteTokenMetadata {
  if (!isRecord(value)) {
    return {};
  }

  return typeof value.inviteFlowTokenId === "string" ? { inviteFlowTokenId: value.inviteFlowTokenId } : {};
}

function metadata(value: InviteTokenMetadata): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function groupDefaults(groups: { groupId: string; role: string }[]): GroupDefault[] {
  return groups.map((group) => ({
    groupId: group.groupId,
    role: group.role
  }));
}

function displayNameFromEmail(normalizedEmail: string): string {
  const localPart = normalizedEmail.split("@")[0]?.trim();

  return localPart || "AIQSA User";
}

async function findValidInviteToken(
  tx: Prisma.TransactionClient,
  input: {
    inviteTokenHash?: string | null;
    normalizedEmail: string;
    now: Date;
  }
) {
  if (!input.inviteTokenHash) {
    return null;
  }

  const token = await tx.authFlowToken.findUnique({
    include: {
      invite: true
    },
    where: {
      tokenHash: input.inviteTokenHash
    }
  });

  if (
    !token ||
    token.purpose !== "invite_acceptance" ||
    token.consumedAt ||
    token.expiresAt <= input.now ||
    !token.invite ||
    token.invite.acceptedAt ||
    token.invite.revokedAt ||
    token.invite.expiresAt <= input.now ||
    token.invite.normalizedEmail !== input.normalizedEmail
  ) {
    return null;
  }

  return token;
}

export async function findEnabledAccessRuleMatch(
  tx: Prisma.TransactionClient,
  normalizedEmail: string
): Promise<ApprovalMatch | null> {
  const emailRule = await tx.authAccessRule.findFirst({
    include: {
      defaultGroups: true
    },
    where: {
      enabled: true,
      kind: "email",
      value: normalizedEmail
    }
  });

  if (emailRule) {
    return {
      groups: groupDefaults(emailRule.defaultGroups),
      source: "email_rule"
    };
  }

  const domain = authEmailDomain(normalizedEmail);

  if (!domain) {
    return null;
  }

  const domainRule = await tx.authAccessRule.findFirst({
    include: {
      defaultGroups: true
    },
    where: {
      enabled: true,
      kind: "domain",
      value: normalizeAuthDomain(domain)
    }
  });

  return domainRule
    ? {
        groups: groupDefaults(domainRule.defaultGroups),
        source: "domain_rule"
      }
    : null;
}

async function findApprovalMatch(
  tx: Prisma.TransactionClient,
  input: {
    inviteId: string | null;
    inviteMetadata: InviteTokenMetadata;
    normalizedEmail: string;
    now: Date;
    userId: string;
  }
): Promise<ApprovalMatch | null> {
  const ruleMatch = await findEnabledAccessRuleMatch(tx, input.normalizedEmail);

  if (ruleMatch) {
    return ruleMatch;
  }

  if (!input.inviteId || !input.inviteMetadata.inviteFlowTokenId) {
    return null;
  }

  const inviteToken = await tx.authFlowToken.findUnique({
    include: {
      invite: {
        include: {
          defaultGroups: true
        }
      }
    },
    where: {
      id: input.inviteMetadata.inviteFlowTokenId
    }
  });

  if (
    !inviteToken ||
    inviteToken.purpose !== "invite_acceptance" ||
    inviteToken.inviteId !== input.inviteId ||
    inviteToken.consumedAt ||
    inviteToken.expiresAt <= input.now ||
    !inviteToken.invite ||
    inviteToken.invite.acceptedAt ||
    inviteToken.invite.revokedAt ||
    inviteToken.invite.expiresAt <= input.now ||
    inviteToken.invite.normalizedEmail !== input.normalizedEmail
  ) {
    return null;
  }

  const consumed = await tx.authFlowToken.updateMany({
    data: {
      consumedAt: input.now
    },
    where: {
      consumedAt: null,
      id: inviteToken.id
    }
  });

  if (consumed.count !== 1) {
    return null;
  }

  await tx.authInvite.update({
    data: {
      acceptedAt: input.now,
      acceptedByUserId: input.userId
    },
    where: {
      id: inviteToken.invite.id
    }
  });

  return {
    groups: groupDefaults(inviteToken.invite.defaultGroups),
    source: "invite"
  };
}

export function createPrismaAuthRegistrationRepository(prisma: PrismaClient): AuthRegistrationRepository {
  return {
    async acceptInvite(input) {
      return prisma.$transaction(async (tx) => {
        const candidate = await tx.authFlowToken.findUnique({
          select: {
            id: true,
            inviteId: true,
            normalizedEmail: true
          },
          where: {
            tokenHash: input.inviteTokenHash
          }
        });

        if (!candidate?.inviteId || !candidate.normalizedEmail) {
          return null;
        }

        await lockAuthRegistrationEmail(tx, candidate.normalizedEmail);

        let identity = await tx.authIdentity.findUnique({
          where: {
            provider_normalizedEmail: {
              normalizedEmail: candidate.normalizedEmail,
              provider: "password"
            }
          }
        });

        if (identity) {
          await lockAuthIdentity(tx, identity.id);
          identity = await tx.authIdentity.findUnique({
            where: {
              id: identity.id
            }
          });
        }

        let user = identity
          ? await tx.user.findUnique({
              where: {
                id: identity.userId
              }
            })
          : await tx.user.findUnique({
              where: {
                email: candidate.normalizedEmail
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

        await lockAuthFlowToken(tx, candidate.id);
        await lockAuthInvite(tx, candidate.inviteId);

        const inviteToken = await tx.authFlowToken.findUnique({
          include: {
            invite: {
              include: {
                defaultGroups: true
              }
            }
          },
          where: {
            id: candidate.id
          }
        });

        if (
          !inviteToken ||
          inviteToken.purpose !== "invite_acceptance" ||
          inviteToken.consumedAt ||
          inviteToken.expiresAt <= input.now ||
          inviteToken.inviteId !== candidate.inviteId ||
          inviteToken.normalizedEmail !== candidate.normalizedEmail ||
          !inviteToken.invite ||
          inviteToken.invite.acceptedAt ||
          inviteToken.invite.revokedAt ||
          inviteToken.invite.expiresAt <= input.now ||
          inviteToken.invite.normalizedEmail !== candidate.normalizedEmail ||
          Boolean(identity && !user) ||
          Boolean(identity && identity.userId !== user?.id) ||
          Boolean(identity && (identity.provider !== "password" || identity.emailVerifiedAt)) ||
          Boolean(user && (user.email !== candidate.normalizedEmail || user.status !== "pending"))
        ) {
          return null;
        }

        const consumed = await tx.authFlowToken.updateMany({
          data: {
            consumedAt: input.now
          },
          where: {
            consumedAt: null,
            id: inviteToken.id
          }
        });

        if (consumed.count !== 1) {
          return null;
        }

        if (!user) {
          user = await tx.user.create({
            data: {
              displayName: input.displayName || displayNameFromEmail(candidate.normalizedEmail),
              email: candidate.normalizedEmail,
              role: "user",
              status: "pending"
            }
          });
        }

        if (!identity) {
          identity = await tx.authIdentity.create({
            data: {
              emailVerifiedAt: input.now,
              normalizedEmail: candidate.normalizedEmail,
              passwordHash: input.passwordHash,
              provider: "password",
              providerAccountId: candidate.normalizedEmail,
              userId: user.id
            }
          });
        } else {
          identity = await tx.authIdentity.update({
            data: {
              emailVerifiedAt: input.now,
              passwordHash: input.passwordHash
            },
            where: {
              id: identity.id
            }
          });
        }

        await tx.authFlowToken.updateMany({
          data: {
            consumedAt: input.now
          },
          where: {
            consumedAt: null,
            identityId: identity.id,
            purpose: "email_verification"
          }
        });

        user = await tx.user.update({
          data: {
            ...(input.displayName ? { displayName: input.displayName } : {}),
            status: "active"
          },
          where: {
            id: user.id
          }
        });

        await tx.authInvite.update({
          data: {
            acceptedAt: input.now,
            acceptedByUserId: user.id
          },
          where: {
            id: inviteToken.invite.id
          }
        });
        await provisionActiveUser(tx, {
          groups: groupDefaults(inviteToken.invite.defaultGroups),
          userId: user.id
        });
        await tx.authSession.create({
          data: {
            ...input.session,
            userId: user.id
          }
        });

        return {
          userId: user.id
        };
      });
    },
    async completeEmailVerification(input) {
      return prisma.$transaction(async (tx) => {
        const candidate = await tx.authFlowToken.findUnique({
          select: {
            identityId: true
          },
          where: {
            tokenHash: input.tokenHash
          }
        });

        if (!candidate?.identityId) {
          return null;
        }

        const identityOwner = await tx.authIdentity.findUnique({
          select: {
            userId: true
          },
          where: {
            id: candidate.identityId
          }
        });

        if (!identityOwner) {
          return null;
        }

        await lockAuthUser(tx, identityOwner.userId);
        await lockAuthIdentity(tx, candidate.identityId);

        const flowToken = await tx.authFlowToken.findUnique({
          include: {
            identity: {
              include: {
                user: true
              }
            }
          },
          where: {
            tokenHash: input.tokenHash
          }
        });

        if (
          !flowToken ||
          flowToken.purpose !== "email_verification" ||
          flowToken.consumedAt ||
          flowToken.expiresAt <= input.now ||
          !flowToken.identity ||
          !flowToken.userId ||
          flowToken.userId !== flowToken.identity.userId ||
          (flowToken.normalizedEmail !== null &&
            flowToken.normalizedEmail !== flowToken.identity.normalizedEmail) ||
          flowToken.identity.emailVerifiedAt ||
          flowToken.identity.provider !== "password" ||
          flowToken.identity.user.status === "disabled" ||
          flowToken.identity.user.status === "denied"
        ) {
          return null;
        }

        const selectedToken = await tx.authFlowToken.updateMany({
          data: {
            consumedAt: input.now
          },
          where: {
            consumedAt: null,
            id: flowToken.id
          }
        });

        if (selectedToken.count !== 1) {
          return null;
        }

        await tx.authFlowToken.updateMany({
          data: {
            consumedAt: input.now
          },
          where: {
            consumedAt: null,
            identityId: flowToken.identity.id,
            purpose: "email_verification"
          }
        });

        await tx.authIdentity.update({
          data: {
            emailVerifiedAt: input.now,
            passwordHash: input.passwordHash
          },
          where: {
            id: flowToken.identity.id
          }
        });

        if (flowToken.identity.user.status === "active") {
          await provisionActiveUser(tx, {
            userId: flowToken.userId
          });

          return {
            source: null,
            status: "active",
            userId: flowToken.userId
          };
        }

        const normalizedEmail = flowToken.normalizedEmail ?? flowToken.identity.normalizedEmail;
        const approval = await findApprovalMatch(tx, {
          inviteId: flowToken.inviteId,
          inviteMetadata: inviteTokenMetadata(flowToken.metadata),
          normalizedEmail,
          now: input.now,
          userId: flowToken.userId
        });

        if (!approval) {
          return {
            source: null,
            status: "pending",
            userId: flowToken.userId
          };
        }

        await tx.user.update({
          data: {
            status: "active"
          },
          where: {
            id: flowToken.userId
          }
        });
        await provisionActiveUser(tx, {
          groups: approval.groups,
          userId: flowToken.userId
        });

        return {
          source: approval.source,
          status: "active",
          userId: flowToken.userId
        };
      });
    },
    async registerPasswordUser(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthRegistrationEmail(tx, input.normalizedEmail);

        const inviteToken = await findValidInviteToken(tx, {
          inviteTokenHash: input.inviteTokenHash,
          normalizedEmail: input.normalizedEmail,
          now: input.now
        });

        if (input.inviteTokenHash && !inviteToken) {
          return {
            error: "invalid_invite_token",
            ok: false
          };
        }

        if (!inviteToken && !(await findEnabledAccessRuleMatch(tx, input.normalizedEmail))) {
          return {
            error: "registration_not_allowed",
            ok: false
          };
        }

        let identity = await tx.authIdentity.findUnique({
          include: {
            user: true
          },
          where: {
            provider_normalizedEmail: {
              normalizedEmail: input.normalizedEmail,
              provider: "password"
            }
          }
        });

        if (identity) {
          await lockAuthIdentity(tx, identity.id);
          identity = await tx.authIdentity.findUnique({
            include: {
              user: true
            },
            where: {
              id: identity.id
            }
          });
        }

        if (!identity) {
          const existingUser = await tx.user.findUnique({
            where: {
              email: input.normalizedEmail
            }
          });

          if (existingUser?.status === "disabled" || existingUser?.status === "denied") {
            return {
              ok: true,
              sentToEmail: null
            };
          }

          const user =
            existingUser ??
            (await tx.user.create({
              data: {
                displayName: input.displayName || displayNameFromEmail(input.normalizedEmail),
                email: input.normalizedEmail,
                role: "user",
                status: "pending"
              }
            }));

          if (existingUser && input.displayName && existingUser.status === "pending") {
            await tx.user.update({
              data: {
                displayName: input.displayName
              },
              where: {
                id: existingUser.id
              }
            });
          }

          identity = await tx.authIdentity.create({
            data: {
              normalizedEmail: input.normalizedEmail,
              provider: "password",
              providerAccountId: input.normalizedEmail,
              userId: user.id
            },
            include: {
              user: true
            }
          });
        }

        if (identity.user.status === "disabled" || identity.user.status === "denied") {
          return {
            ok: true,
            sentToEmail: null
          };
        }

        if (identity.emailVerifiedAt) {
          return {
            ok: true,
            sentToEmail: null
          };
        }

        if (input.displayName) {
          await tx.user.update({
            data: {
              displayName: input.displayName
            },
            where: {
              id: identity.userId
            }
          });
        }

        await tx.authFlowToken.deleteMany({
          where: {
            consumedAt: null,
            identityId: identity.id,
            purpose: "email_verification"
          }
        });

        await tx.authFlowToken.create({
          data: {
            expiresAt: input.expiresAt,
            identityId: identity.id,
            inviteId: inviteToken?.inviteId ?? null,
            metadata: metadata(
              inviteToken
                ? {
                    inviteFlowTokenId: inviteToken.id
                  }
                : {}
            ),
            normalizedEmail: input.normalizedEmail,
            purpose: "email_verification",
            sentToEmail: identity.user.email ?? input.email,
            tokenHash: input.verificationTokenHash,
            userId: identity.userId
          }
        });

        return {
          ok: true,
          sentToEmail: identity.user.email ?? input.email
        };
      });
    }
  };
}
