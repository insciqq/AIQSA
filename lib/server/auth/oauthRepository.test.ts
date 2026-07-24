import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { hashPassword } from "./password";
import { createPrismaOAuthIdentityRepository } from "./oauthRepository";
import { hashToken } from "./token";

async function withOAuthData<T>(
  run: (input: {
    domain: string;
    email: string;
    groupId: string;
    now: Date;
    repository: ReturnType<typeof createPrismaOAuthIdentityRepository>;
  }) => Promise<T>
): Promise<T> {
  const id = randomUUID();
  const domain = `oauth-${id}.example.com`;
  const email = `oauth-${id}@${domain}`;
  const group = await prisma.group.create({
    data: {
      name: `oauth-${id}`
    }
  });

  try {
    return await run({
      domain,
      email,
      groupId: group.id,
      now: new Date("2026-07-18T12:00:00.000Z"),
      repository: createPrismaOAuthIdentityRepository(prisma)
    });
  } finally {
    await prisma.user.deleteMany({
      where: {
        email: {
          in: [email, `changed-${email}`]
        }
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

describe("Prisma OAuth identity repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("merges Google and Yandex identities into the existing password user and preserves chats", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      const user = await prisma.user.create({
        data: {
          displayName: "Existing User",
          email,
          status: "active"
        }
      });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email,
          passwordHash: await hashPassword("existing-password"),
          provider: "password",
          providerAccountId: email,
          userId: user.id
        }
      });
      const chat = await prisma.chat.create({
        data: {
          title: "Existing chat",
          userId: user.id
        }
      });

      const google = await repository.settleIdentity({
        displayName: "Google Name",
        email: email.toUpperCase(),
        now,
        provider: "google",
        providerAccountId: "google-subject"
      });
      const yandex = await repository.settleIdentity({
        displayName: "Yandex Name",
        email,
        now,
        provider: "yandex",
        providerAccountId: "yandex-subject"
      });
      const [users, identities, preservedChat] = await Promise.all([
        prisma.user.findMany({ where: { email } }),
        prisma.authIdentity.findMany({ where: { userId: user.id } }),
        prisma.chat.findUnique({ where: { id: chat.id } })
      ]);

      expect(google).toEqual({ status: "active", userId: user.id });
      expect(yandex).toEqual({ status: "active", userId: user.id });
      expect(users).toHaveLength(1);
      expect(identities.map((identity) => identity.provider).sort()).toEqual(["google", "password", "yandex"]);
      expect(preservedChat?.userId).toBe(user.id);
    });
  });

  it("uses an already linked stable provider subject even when its current email changes", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      const user = await prisma.user.create({
        data: {
          displayName: "Linked User",
          email,
          status: "active"
        }
      });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email,
          provider: "google",
          providerAccountId: "stable-subject",
          userId: user.id
        }
      });

      await expect(
        repository.settleIdentity({
          displayName: "Changed Name",
          email: `changed-${email}`,
          now,
          provider: "google",
          providerAccountId: "stable-subject"
        })
      ).resolves.toEqual({
        status: "active",
        userId: user.id
      });
      await expect(
        prisma.user.findUnique({
          where: {
            email: `changed-${email}`
          }
        })
      ).resolves.toBeNull();
    });
  });

  it("rejects a stable provider subject whose current email is bound to another subject", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      const changedEmail = `changed-${email}`;
      const originalUser = await prisma.user.create({
        data: {
          displayName: "Original Subject User",
          email,
          status: "active"
        }
      });
      const conflictingUser = await prisma.user.create({
        data: {
          displayName: "Conflicting Subject User",
          email: changedEmail,
          status: "active"
        }
      });
      const originalIdentity = await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email,
          provider: "google",
          providerAccountId: "original-stable-subject",
          userId: originalUser.id
        }
      });
      const conflictingIdentity = await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: changedEmail,
          provider: "google",
          providerAccountId: "conflicting-stable-subject",
          userId: conflictingUser.id
        }
      });

      await expect(
        repository.settleIdentity({
          displayName: "Original Subject User",
          email: changedEmail,
          now,
          provider: "google",
          providerAccountId: "original-stable-subject"
        })
      ).resolves.toEqual({
        status: "account_conflict"
      });
      await expect(
        prisma.authIdentity.findMany({
          orderBy: {
            id: "asc"
          },
          select: {
            id: true,
            normalizedEmail: true,
            providerAccountId: true,
            userId: true
          },
          where: {
            id: {
              in: [originalIdentity.id, conflictingIdentity.id]
            }
          }
        })
      ).resolves.toEqual(
        [
          {
            id: originalIdentity.id,
            normalizedEmail: email,
            providerAccountId: "original-stable-subject",
            userId: originalUser.id
          },
          {
            id: conflictingIdentity.id,
            normalizedEmail: changedEmail,
            providerAccountId: "conflicting-stable-subject",
            userId: conflictingUser.id
          }
        ].sort((left, right) => left.id.localeCompare(right.id))
      );
    });
  });

  it("activates and provisions a new OAuth user through an exact domain rule", async () => {
    await withOAuthData(async ({ domain, email, groupId, now, repository }) => {
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

      const result = await repository.settleIdentity({
        displayName: "New OAuth User",
        email,
        now,
        provider: "yandex",
        providerAccountId: "new-yandex-subject"
      });
      const user = await prisma.user.findUniqueOrThrow({
        include: {
          authIdentities: true,
          folders: true,
          groups: true,
          settings: true
        },
        where: {
          email
        }
      });

      expect(result).toEqual({ status: "active", userId: user.id });
      expect(user.status).toBe("active");
      expect(user.authIdentities).toHaveLength(1);
      expect(user.authIdentities[0]).toMatchObject({
        normalizedEmail: email,
        provider: "yandex",
        providerAccountId: "new-yandex-subject"
      });
      expect(user.authIdentities[0]?.emailVerifiedAt?.getTime()).toBe(now.getTime());
      expect(user.groups).toHaveLength(1);
      expect(user.folders).toHaveLength(0);
      expect(user.settings?.defaultFolderId).toBeNull();
    });
  });

  it("creates no account for a new email without an access rule and does not weaken an open invite", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      const invite = await prisma.authInvite.create({
        data: {
          email,
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          normalizedEmail: email
        }
      });
      const inviteToken = await prisma.authFlowToken.create({
        data: {
          expiresAt: invite.expiresAt,
          inviteId: invite.id,
          normalizedEmail: email,
          purpose: "invite_acceptance",
          sentToEmail: email,
          tokenHash: hashToken(`oauth-invite-${email}`)
        }
      });

      await expect(
        repository.settleIdentity({
          displayName: "Disallowed User",
          email,
          now,
          provider: "google",
          providerAccountId: "disallowed-subject"
        })
      ).resolves.toEqual({
        status: "not_allowed"
      });
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);
      await expect(
        prisma.authIdentity.count({
          where: {
            normalizedEmail: email
          }
        })
      ).resolves.toBe(0);
      await expect(
        prisma.authInvite.findUniqueOrThrow({
          where: {
            id: invite.id
          }
        })
      ).resolves.toMatchObject({
        acceptedAt: null,
        acceptedByUserId: null
      });
      await expect(
        prisma.authFlowToken.findUniqueOrThrow({
          where: {
            id: inviteToken.id
          }
        })
      ).resolves.toMatchObject({
        consumedAt: null
      });
    });
  });

  it("does not attach an OAuth identity or return access for a disabled existing user", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      await prisma.user.create({
        data: {
          displayName: "Disabled User",
          email,
          status: "disabled"
        }
      });

      await expect(
        repository.settleIdentity({
          displayName: "Disabled OAuth User",
          email,
          now,
          provider: "yandex",
          providerAccountId: "disabled-subject"
        })
      ).resolves.toEqual({
        status: "not_allowed"
      });
      await expect(
        prisma.authIdentity.count({
          where: {
            normalizedEmail: email,
            provider: "yandex"
          }
        })
      ).resolves.toBe(0);
    });
  });

  it("keeps a pending user pending but links the provider identity for later approval", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      const user = await prisma.user.create({
        data: {
          displayName: "Pending User",
          email,
          status: "pending"
        }
      });

      await expect(
        repository.settleIdentity({
          displayName: "OAuth Pending User",
          email,
          now,
          provider: "google",
          providerAccountId: "pending-subject"
        })
      ).resolves.toEqual({
        status: "pending"
      });
      await expect(
        prisma.authIdentity.findUnique({
          where: {
            provider_providerAccountId: {
              provider: "google",
              providerAccountId: "pending-subject"
            }
          }
        })
      ).resolves.toMatchObject({
        userId: user.id
      });
    });
  });

  it("rejects a different provider subject for an already linked provider email", async () => {
    await withOAuthData(async ({ email, now, repository }) => {
      const user = await prisma.user.create({
        data: {
          displayName: "Conflict User",
          email,
          status: "active"
        }
      });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email,
          provider: "google",
          providerAccountId: "original-subject",
          userId: user.id
        }
      });

      await expect(
        repository.settleIdentity({
          displayName: "Different Google Account",
          email,
          now,
          provider: "google",
          providerAccountId: "different-subject"
        })
      ).resolves.toEqual({
        status: "account_conflict"
      });
      await expect(
        prisma.authIdentity.count({
          where: {
            normalizedEmail: email,
            provider: "google"
          }
        })
      ).resolves.toBe(1);
    });
  });
});
