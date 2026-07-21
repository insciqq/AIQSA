import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { loadEntitlementsForUser } from "./dbEntitlements";
import { hashPassword, verifyPassword } from "./password";
import { createPrismaAuthRegistrationRepository } from "./registrationRepository";
import { hashToken } from "./token";

async function withRegistrationData<T>(
  run: (input: {
    domain: string;
    email: string;
    groupId: string;
    now: Date;
    repository: ReturnType<typeof createPrismaAuthRegistrationRepository>;
  }) => Promise<T>
): Promise<T> {
  const id = randomUUID();
  const domain = `registration-${id}.example.com`;
  const email = `registration-${id}@${domain}`;
  const group = await prisma.group.create({
    data: {
      name: `registration-${id}`
    }
  });

  await prisma.accessGrant.createMany({
    data: [
      {
        groupId: group.id,
        provider: "openai",
        modelId: "gpt-5.5"
      },
      {
        groupId: group.id,
        searchStrategy: "openai-native-web-search"
      }
    ]
  });

  try {
    return await run({
      domain,
      email,
      groupId: group.id,
      now: new Date("2026-06-14T00:00:00.000Z"),
      repository: createPrismaAuthRegistrationRepository(prisma)
    });
  } finally {
    await prisma.user.deleteMany({
      where: {
        email
      }
    });
    await prisma.authFlowToken.deleteMany({
      where: {
        normalizedEmail: email
      }
    });
    await prisma.authInvite.deleteMany({
      where: {
        normalizedEmail: email
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        value: {
          in: [email, domain]
        }
      }
    });
    await prisma.group.deleteMany({
      where: {
        id: group.id
      }
    });
  }
}

async function register(input: {
  email: string;
  inviteTokenHash?: string;
  repository: ReturnType<typeof createPrismaAuthRegistrationRepository>;
  token: string;
}) {
  return input.repository.registerPasswordUser({
    displayName: "Registration Test",
    email: input.email,
    expiresAt: new Date("2026-06-15T00:00:00.000Z"),
    inviteTokenHash: input.inviteTokenHash,
    normalizedEmail: input.email,
    now: new Date("2026-06-14T00:00:00.000Z"),
    verificationTokenHash: hashToken(input.token)
  });
}

async function verify(input: {
  now: Date;
  password?: string;
  repository: ReturnType<typeof createPrismaAuthRegistrationRepository>;
  token: string;
}) {
  return input.repository.completeEmailVerification({
    now: input.now,
    passwordHash: await hashPassword(input.password ?? "chosen-password"),
    tokenHash: hashToken(input.token)
  });
}

async function createInvite(input: {
  email: string;
  expiresAt?: Date;
  groupId: string;
  token: string;
}) {
  const invite = await prisma.authInvite.create({
    data: {
      defaultGroups: {
        create: {
          groupId: input.groupId
        }
      },
      email: input.email,
      expiresAt: input.expiresAt ?? new Date("2026-06-15T00:00:00.000Z"),
      normalizedEmail: input.email
    }
  });
  const flowToken = await prisma.authFlowToken.create({
    data: {
      expiresAt: input.expiresAt ?? new Date("2026-06-15T00:00:00.000Z"),
      inviteId: invite.id,
      normalizedEmail: input.email,
      purpose: "invite_acceptance",
      sentToEmail: input.email,
      tokenHash: hashToken(input.token)
    }
  });

  return { flowToken, invite };
}

async function acceptInvite(input: {
  displayName?: string;
  now: Date;
  password: string;
  repository: ReturnType<typeof createPrismaAuthRegistrationRepository>;
  sessionToken: string;
  token: string;
}) {
  return input.repository.acceptInvite({
    displayName: input.displayName ?? "Invited User",
    inviteTokenHash: hashToken(input.token),
    now: input.now,
    passwordHash: await hashPassword(input.password),
    session: {
      createdByUserAgent: "Repository Test",
      expiresAt: new Date("2026-06-21T00:00:00.000Z"),
      lastSeenAt: input.now,
      tokenHash: hashToken(input.sessionToken)
    }
  });
}

describe("Prisma registration repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("activates an exact approved email and provisions defaults and grants", async () => {
    await withRegistrationData(async ({ domain, email, groupId, now, repository }) => {
      await prisma.authAccessRule.create({
        data: {
          defaultGroups: {
            create: {
              groupId
            }
          },
          kind: "email",
          value: email
        }
      });
      await register({ email, repository, token: "verify-email-rule" });

      const result = await verify({
        now,
        repository,
        token: "verify-email-rule"
      });
      const user = await prisma.user.findUniqueOrThrow({
        include: {
          folders: true,
          groups: true,
          promptPresets: true,
          settings: true
        },
        where: {
          email
        }
      });
      const entitlements = await loadEntitlementsForUser(user.id);
      const identity = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });

      expect(result).toMatchObject({
        source: "email_rule",
        status: "active"
      });
      expect(user.status).toBe("active");
      expect(user.groups).toHaveLength(1);
      expect(user.settings?.defaultProvider).toBe("openai");
      expect(user.settings?.defaultFolderId).toBeNull();
      expect(user.settings?.defaultPromptPresetId).toBeTruthy();
      expect(user.promptPresets.some((prompt) => prompt.isDefault)).toBe(true);
      expect(user.folders).toHaveLength(0);
      expect(entitlements.modelKeys.has("openai:gpt-5.5")).toBe(true);
      expect(entitlements.searchStrategies.has("openai-native-web-search")).toBe(true);
      expect(identity.emailVerifiedAt).toBeInstanceOf(Date);
      await expect(verifyPassword("chosen-password", identity.passwordHash)).resolves.toBe(true);
    });
  });

  it("activates an exact approved domain only after verification", async () => {
    await withRegistrationData(async ({ domain, email, groupId, now, repository }) => {
      await prisma.authAccessRule.create({
        data: {
          defaultGroups: {
            create: {
              groupId
            }
          },
          kind: "domain",
          value: domain
        }
      });
      await register({ email, repository, token: "verify-domain-rule" });

      await expect(
        prisma.user.findUniqueOrThrow({
          select: {
            status: true
          },
          where: {
            email
          }
        })
      ).resolves.toEqual({
        status: "pending"
      });

      await expect(
        verify({
          now,
          repository,
          token: "verify-domain-rule"
        })
      ).resolves.toMatchObject({
        source: "domain_rule",
        status: "active"
      });
    });
  });

  it("rejects a typo domain before creating auth rows", async () => {
    await withRegistrationData(async ({ domain, email, groupId, repository }) => {
      await prisma.authAccessRule.create({
        data: {
          defaultGroups: {
            create: {
              groupId
            }
          },
          kind: "domain",
          value: domain
        }
      });
      const typoEmail = email.replace(domain, `${domain.replace(".example.com", "")}o.example.com`);

      await expect(register({ email: typoEmail, repository, token: "verify-typo-domain" })).resolves.toEqual({
        error: "registration_not_allowed",
        ok: false
      });
      await expect(
        prisma.user.findUnique({
          where: {
            email: typoEmail
          }
        })
      ).resolves.toBeNull();
      await expect(
        prisma.authFlowToken.count({
          where: {
            normalizedEmail: typoEmail
          }
        })
      ).resolves.toBe(0);
    });
  });

  it("does not accept a registration password and changes credentials only after email proof", async () => {
    await withRegistrationData(async ({ domain, email, groupId, now, repository }) => {
      await prisma.authAccessRule.create({
        data: {
          defaultGroups: {
            create: {
              groupId
            }
          },
          kind: "domain",
          value: domain
        }
      });
      await register({ email, repository, token: "verify-first" });
      const identity = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });
      const legacyHash = await hashPassword("legacy-attacker-password");
      await prisma.authIdentity.update({
        data: {
          passwordHash: legacyHash
        },
        where: {
          id: identity.id
        }
      });

      await register({ email, repository, token: "verify-second" });
      await expect(
        prisma.authIdentity.findUniqueOrThrow({
          select: {
            passwordHash: true
          },
          where: {
            id: identity.id
          }
        })
      ).resolves.toEqual({
        passwordHash: legacyHash
      });

      await verify({
        now,
        password: "verified-owner-password",
        repository,
        token: "verify-second"
      });
      const [verifiedIdentity, verificationTokens] = await Promise.all([
        prisma.authIdentity.findUniqueOrThrow({
          where: {
            id: identity.id
          }
        }),
        prisma.authFlowToken.findMany({
          where: {
            identityId: identity.id,
            purpose: "email_verification"
          }
        })
      ]);

      await expect(verifyPassword("verified-owner-password", verifiedIdentity.passwordHash)).resolves.toBe(true);
      await expect(verifyPassword("legacy-attacker-password", verifiedIdentity.passwordHash)).resolves.toBe(false);
      expect(verificationTokens).toHaveLength(1);
      expect(verificationTokens.every((token) => token.consumedAt instanceof Date)).toBe(true);
      await expect(
        verify({
          now,
          password: "replay-password",
          repository,
          token: "verify-first"
        })
      ).resolves.toBeNull();
    });
  });

  it("replaces a live verification token so only the latest link can establish the password", async () => {
    await withRegistrationData(async ({ domain, email, groupId, now, repository }) => {
      await prisma.authAccessRule.create({
        data: {
          defaultGroups: {
            create: {
              groupId
            }
          },
          kind: "domain",
          value: domain
        }
      });
      await register({ email, repository, token: "verify-race-a" });
      await register({ email, repository, token: "verify-race-b" });

      const results = await Promise.all([
        verify({ now, password: "race-password-a", repository, token: "verify-race-a" }),
        verify({ now, password: "race-password-b", repository, token: "verify-race-b" })
      ]);
      const winnerIndex = results.findIndex((result) => result !== null);
      const identity = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });
      const verificationTokens = await prisma.authFlowToken.findMany({
        where: {
          identityId: identity.id,
          purpose: "email_verification"
        }
      });

      expect(results).toEqual([
        null,
        expect.objectContaining({ status: "active" })
      ]);
      expect(winnerIndex).toBe(1);
      await expect(
        verifyPassword(winnerIndex === 0 ? "race-password-a" : "race-password-b", identity.passwordHash)
      ).resolves.toBe(true);
      await expect(
        verifyPassword(winnerIndex === 0 ? "race-password-b" : "race-password-a", identity.passwordHash)
      ).resolves.toBe(false);
      expect(verificationTokens).toHaveLength(1);
      expect(verificationTokens.every((token) => token.consumedAt instanceof Date)).toBe(true);
    });
  });

  it("leaves verified users pending when no approval rule or invite matches", async () => {
    await withRegistrationData(async ({ email, now, repository }) => {
      const user = await prisma.user.create({
        data: {
          displayName: "Legacy Pending User",
          email,
          status: "pending"
        }
      });
      const identity = await prisma.authIdentity.create({
        data: {
          normalizedEmail: email,
          passwordHash: await hashPassword("registration-password"),
          provider: "password",
          providerAccountId: email,
          userId: user.id
        }
      });
      await prisma.authFlowToken.create({
        data: {
          expiresAt: new Date("2026-06-15T00:00:00.000Z"),
          identityId: identity.id,
          normalizedEmail: email,
          purpose: "email_verification",
          sentToEmail: email,
          tokenHash: hashToken("verify-pending"),
          userId: user.id
        }
      });

      await expect(
        verify({
          now,
          repository,
          token: "verify-pending"
        })
      ).resolves.toMatchObject({
        source: null,
        status: "pending"
      });

      await expect(
        prisma.user.findUniqueOrThrow({
          select: {
            status: true
          },
          where: {
            email
          }
        })
      ).resolves.toEqual({
        status: "pending"
      });
    });
  });

  it("accepts an invite directly, provisions the account, and creates its first session", async () => {
    await withRegistrationData(async ({ email, groupId, now, repository }) => {
      const token = `direct-invite-${email}`;
      const sessionToken = `direct-session-${email}`;
      const { flowToken, invite } = await createInvite({ email, groupId, token });

      const result = await acceptInvite({
        displayName: "Direct Invite User",
        now,
        password: "direct-invite-password",
        repository,
        sessionToken,
        token
      });
      const [user, identity, acceptedInvite, consumedToken, sessions] = await Promise.all([
        prisma.user.findUniqueOrThrow({
          include: {
            folders: true,
            groups: true,
            promptPresets: true,
            settings: true
          },
          where: { email }
        }),
        prisma.authIdentity.findFirstOrThrow({
          where: {
            normalizedEmail: email,
            provider: "password"
          }
        }),
        prisma.authInvite.findUniqueOrThrow({ where: { id: invite.id } }),
        prisma.authFlowToken.findUniqueOrThrow({ where: { id: flowToken.id } }),
        prisma.authSession.findMany({ where: { tokenHash: hashToken(sessionToken) } })
      ]);

      expect(result).toEqual({ userId: user.id });
      expect(user).toMatchObject({ displayName: "Direct Invite User", status: "active" });
      expect(user.groups).toHaveLength(1);
      expect(user.folders).toHaveLength(0);
      expect(user.promptPresets.some((prompt) => prompt.isDefault)).toBe(true);
      expect(user.settings?.defaultFolderId).toBeNull();
      expect(identity.emailVerifiedAt?.getTime()).toBe(now.getTime());
      await expect(verifyPassword("direct-invite-password", identity.passwordHash)).resolves.toBe(true);
      expect(acceptedInvite.acceptedAt?.getTime()).toBe(now.getTime());
      expect(acceptedInvite.acceptedByUserId).toBe(user.id);
      expect(consumedToken.consumedAt?.getTime()).toBe(now.getTime());
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        createdByUserAgent: "Repository Test",
        userId: user.id
      });

      await expect(
        acceptInvite({
          now,
          password: "replayed-password",
          repository,
          sessionToken: "replayed-session",
          token
        })
      ).resolves.toBeNull();
      await expect(prisma.authSession.count({ where: { userId: user.id } })).resolves.toBe(1);
    });
  });

  it("completes a matching unverified identity and invalidates its verification links", async () => {
    await withRegistrationData(async ({ email, groupId, now, repository }) => {
      const inviteToken = `compat-invite-${email}`;
      const { invite } = await createInvite({ email, groupId, token: inviteToken });
      await register({
        email,
        inviteTokenHash: hashToken(inviteToken),
        repository,
        token: "legacy-verification-token"
      });
      const identityBefore = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });

      const result = await acceptInvite({
        displayName: "Completed Invite User",
        now,
        password: "completed-invite-password",
        repository,
        sessionToken: "completed-invite-session",
        token: inviteToken
      });
      const [identity, verificationTokens, acceptedInvite] = await Promise.all([
        prisma.authIdentity.findUniqueOrThrow({ where: { id: identityBefore.id } }),
        prisma.authFlowToken.findMany({
          where: {
            identityId: identityBefore.id,
            purpose: "email_verification"
          }
        }),
        prisma.authInvite.findUniqueOrThrow({ where: { id: invite.id } })
      ]);

      expect(result).not.toBeNull();
      expect(identity.id).toBe(identityBefore.id);
      expect(identity.emailVerifiedAt?.getTime()).toBe(now.getTime());
      await expect(verifyPassword("completed-invite-password", identity.passwordHash)).resolves.toBe(true);
      expect(verificationTokens).toHaveLength(1);
      expect(verificationTokens[0]?.consumedAt?.getTime()).toBe(now.getTime());
      expect(acceptedInvite.acceptedAt?.getTime()).toBe(now.getTime());
      await expect(
        verify({
          now,
          password: "stale-verification-password",
          repository,
          token: "legacy-verification-token"
        })
      ).resolves.toBeNull();
    });
  });

  it("allows exactly one concurrent direct invite acceptance", async () => {
    await withRegistrationData(async ({ email, groupId, now, repository }) => {
      const token = `racing-direct-invite-${email}`;
      await createInvite({ email, groupId, token });
      const attempts = [
        {
          password: "direct-race-password-a",
          sessionToken: "direct-race-session-a"
        },
        {
          password: "direct-race-password-b",
          sessionToken: "direct-race-session-b"
        }
      ];

      const results = await Promise.all(
        attempts.map((attempt) =>
          acceptInvite({
            now,
            password: attempt.password,
            repository,
            sessionToken: attempt.sessionToken,
            token
          })
        )
      );
      const winner = results.findIndex((result) => result !== null);
      const identity = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(winner).toBeGreaterThanOrEqual(0);
      await expect(verifyPassword(attempts[winner]!.password, identity.passwordHash)).resolves.toBe(true);
      await expect(prisma.authSession.count({ where: { userId: identity.userId } })).resolves.toBe(1);
    });
  });

  it("does not repurpose a verified account through an invite", async () => {
    await withRegistrationData(async ({ email, groupId, now, repository }) => {
      const originalPassword = "existing-verified-password";
      const user = await prisma.user.create({
        data: {
          displayName: "Existing Verified User",
          email,
          status: "pending"
        }
      });
      const identity = await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email,
          passwordHash: await hashPassword(originalPassword),
          provider: "password",
          providerAccountId: email,
          userId: user.id
        }
      });
      const token = `verified-account-invite-${email}`;
      const { flowToken, invite } = await createInvite({ email, groupId, token });

      await expect(
        acceptInvite({
          now,
          password: "replacement-password",
          repository,
          sessionToken: "verified-account-session",
          token
        })
      ).resolves.toBeNull();

      const [unchangedIdentity, unchangedInvite, unchangedToken, sessions] = await Promise.all([
        prisma.authIdentity.findUniqueOrThrow({ where: { id: identity.id } }),
        prisma.authInvite.findUniqueOrThrow({ where: { id: invite.id } }),
        prisma.authFlowToken.findUniqueOrThrow({ where: { id: flowToken.id } }),
        prisma.authSession.findMany({ where: { userId: user.id } })
      ]);
      await expect(verifyPassword(originalPassword, unchangedIdentity.passwordHash)).resolves.toBe(true);
      await expect(verifyPassword("replacement-password", unchangedIdentity.passwordHash)).resolves.toBe(false);
      expect(unchangedInvite.acceptedAt).toBeNull();
      expect(unchangedToken.consumedAt).toBeNull();
      expect(sessions).toHaveLength(0);
    });
  });

  it("rolls back invite and account settlement when initial session creation fails", async () => {
    await withRegistrationData(async ({ email, groupId, now }) => {
      const token = `rollback-direct-invite-${email}`;
      const { flowToken, invite } = await createInvite({ email, groupId, token });
      const failingClient = prisma.$extends({
        query: {
          authSession: {
            create() {
              throw new Error("injected_session_create_failure");
            }
          }
        }
      });
      const repository = createPrismaAuthRegistrationRepository(failingClient as unknown as PrismaClient);

      await expect(
        acceptInvite({
          now,
          password: "rolled-back-password",
          repository,
          sessionToken: "rolled-back-session",
          token
        })
      ).rejects.toThrow("injected_session_create_failure");

      const [unchangedInvite, unchangedToken, user] = await Promise.all([
        prisma.authInvite.findUniqueOrThrow({ where: { id: invite.id } }),
        prisma.authFlowToken.findUniqueOrThrow({ where: { id: flowToken.id } }),
        prisma.user.findUnique({ where: { email } })
      ]);
      expect(unchangedInvite.acceptedAt).toBeNull();
      expect(unchangedInvite.acceptedByUserId).toBeNull();
      expect(unchangedToken.consumedAt).toBeNull();
      expect(user).toBeNull();
    });
  });

  it("activates an invited email, consumes the invite token, and rejects replay", async () => {
    await withRegistrationData(async ({ email, groupId, now, repository }) => {
      const inviteToken = `invite-token-${email}`;
      const invite = await prisma.authInvite.create({
        data: {
          defaultGroups: {
            create: {
              groupId
            }
          },
          email,
          expiresAt: new Date("2026-06-15T00:00:00.000Z"),
          normalizedEmail: email
        }
      });
      const inviteFlow = await prisma.authFlowToken.create({
        data: {
          expiresAt: new Date("2026-06-15T00:00:00.000Z"),
          inviteId: invite.id,
          normalizedEmail: email,
          purpose: "invite_acceptance",
          sentToEmail: email,
          tokenHash: hashToken(inviteToken)
        }
      });

      await register({
        email,
        inviteTokenHash: hashToken(inviteToken),
        repository,
        token: "verify-invite"
      });

      const result = await verify({
        now,
        repository,
        token: "verify-invite"
      });
      const [acceptedInvite, consumedInviteFlow] = await Promise.all([
        prisma.authInvite.findUniqueOrThrow({
          where: {
            id: invite.id
          }
        }),
        prisma.authFlowToken.findUniqueOrThrow({
          where: {
            id: inviteFlow.id
          }
        })
      ]);
      const replay = await verify({
        now,
        repository,
        token: "verify-invite"
      });

      expect(result).toMatchObject({
        source: "invite",
        status: "active"
      });
      expect(acceptedInvite.acceptedAt).toBeInstanceOf(Date);
      expect(consumedInviteFlow.consumedAt).toBeInstanceOf(Date);
      expect(replay).toBeNull();
    });
  });

  it("rejects invalid invite tokens before creating auth rows", async () => {
    await withRegistrationData(async ({ email, repository }) => {
      await expect(
        register({
          email,
          inviteTokenHash: hashToken("invalid-invite"),
          repository,
          token: "verify-invalid-invite"
        })
      ).resolves.toEqual({
        error: "invalid_invite_token",
        ok: false
      });
      await expect(
        prisma.user.findUnique({
          where: {
            email
          }
        })
      ).resolves.toBeNull();
      await expect(
        prisma.authFlowToken.count({
          where: {
            normalizedEmail: email
          }
        })
      ).resolves.toBe(0);
    });
  });
});
