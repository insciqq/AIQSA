import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { createPrismaAdminRepository } from "./adminRepository";
import { loadEntitlementsForUser } from "./dbEntitlements";
import { hashPassword, isPlausibleEmail } from "./password";
import { createPrismaAuthRegistrationRepository } from "./registrationRepository";
import { hashToken } from "./token";
import { createPrismaProjectRepository } from "../projects/prismaRepository";

function startBarrier(parties: number) {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    waiting += 1;
    if (waiting === parties) {
      release();
    }
    await released;
  };
}

async function withAdminData<T>(
  run: (input: {
    adminId: string;
    domain: string;
    groupId: string;
    repository: ReturnType<typeof createPrismaAdminRepository>;
  }) => Promise<T>
): Promise<T> {
  const id = randomUUID();
  const domain = `admin-${id}.example.com`;
  const admin = await prisma.user.create({
    data: {
      displayName: "Admin Test Operator",
      email: `operator@${domain}`,
      role: "admin",
      status: "active"
    }
  });
  const groupNamePrefix = `admin-test-${id}`;
  const group = await prisma.group.create({
    data: {
      name: groupNamePrefix
    }
  });

  try {
    return await run({
      adminId: admin.id,
      domain,
      groupId: group.id,
      repository: createPrismaAdminRepository(prisma)
    });
  } finally {
    await prisma.authFlowToken.deleteMany({
      where: {
        normalizedEmail: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.authInvite.deleteMany({
      where: {
        normalizedEmail: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        OR: [
          {
            value: domain
          },
          {
            value: {
              endsWith: `@${domain}`
            }
          }
        ]
      }
    });
    await prisma.authSession.deleteMany({
      where: {
        user: {
          email: {
            endsWith: `@${domain}`
          }
        }
      }
    });
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.searchOption.deleteMany({
      where: { optionId: { contains: id } }
    });
    await prisma.providerConnection.deleteMany({
      where: { id: { contains: id } }
    });
    await prisma.group.deleteMany({
      where: {
        OR: [
          {
            id: group.id
          },
          {
            name: {
              contains: id
            }
          }
        ]
      }
    });
  }
}

async function createPasswordUser(input: {
  displayName: string;
  domain: string;
  emailLocalPart: string;
  status: "active" | "denied" | "disabled" | "pending";
  verified?: boolean;
}) {
  const email = `${input.emailLocalPart}@${input.domain}`;

  return prisma.user.create({
    data: {
      authIdentities: {
        create: {
          emailVerifiedAt: input.verified === false ? null : new Date("2026-06-14T00:00:00.000Z"),
          normalizedEmail: email,
          passwordHash: "test-password-hash",
          provider: "password",
          providerAccountId: email
        }
      },
      displayName: input.displayName,
      email,
      status: input.status
    }
  });
}

describe("Prisma-backed admin repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("approves verified pending users and provisions default workspace data", async () => {
    await withAdminData(async ({ domain, groupId, repository }) => {
      const user = await createPasswordUser({
        displayName: "Pending Admin Test User",
        domain,
        emailLocalPart: "pending",
        status: "pending"
      });

      await expect(
        repository.approveUser({
          groupIds: [groupId],
          userId: user.id
        })
      ).resolves.toBe("approved");

      const approved = await prisma.user.findUniqueOrThrow({
        include: {
          assistantDefinitions: true,
          folders: true,
          groups: true,
          settings: true
        },
        where: {
          id: user.id
        }
      });

      expect(approved.status).toBe("active");
      expect(approved.groups).toHaveLength(1);
      expect(approved.groups[0]?.groupId).toBe(groupId);
      expect(approved.folders).toHaveLength(0);
      expect(approved.assistantDefinitions).toHaveLength(0);
      expect(approved.settings?.defaultProviderModelId).toBeNull();
      expect(approved.settings?.defaultFolderId).toBeNull();
    });
  });

  it("refuses to approve unverified users", async () => {
    await withAdminData(async ({ domain, repository }) => {
      const user = await createPasswordUser({
        displayName: "Unverified Admin Test User",
        domain,
        emailLocalPart: "unverified",
        status: "pending",
        verified: false
      });

      await expect(
        repository.approveUser({
          userId: user.id
        })
      ).resolves.toBe("not_verified");

      await expect(
        prisma.user.findUniqueOrThrow({
          select: {
            status: true
          },
          where: {
            id: user.id
          }
        })
      ).resolves.toEqual({
        status: "pending"
      });
    });
  });

  it("rolls back approval and workspace provisioning when a requested group does not exist", async () => {
    await withAdminData(async ({ domain, groupId, repository }) => {
      const user = await createPasswordUser({
        displayName: "Approval Rollback User",
        domain,
        emailLocalPart: "approval-rollback",
        status: "pending"
      });

      await expect(
        repository.approveUser({
          groupIds: [groupId, randomUUID()],
          userId: user.id
        })
      ).rejects.toThrow();

      await expect(
        prisma.user.findUniqueOrThrow({
          include: {
            assistantDefinitions: true,
            folders: true,
            groups: true,
            settings: true
          },
          where: {
            id: user.id
          }
        })
      ).resolves.toMatchObject({
        assistantDefinitions: [],
        folders: [],
        groups: [],
        settings: null,
        status: "pending"
      });
    });
  });

  it("rejects pending users and disables active users with revoked sessions", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const pending = await createPasswordUser({
        displayName: "Reject Admin Test User",
        domain,
        emailLocalPart: "reject",
        status: "pending"
      });
      const active = await createPasswordUser({
        displayName: "Disable Admin Test User",
        domain,
        emailLocalPart: "disable",
        status: "active"
      });

      await prisma.authSession.createMany({
        data: [
          {
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            tokenHash: hashToken("reject-session"),
            userId: pending.id
          },
          {
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            tokenHash: hashToken("disable-session"),
            userId: active.id
          }
        ]
      });

      await expect(
        repository.rejectUser({
          revokedByUserId: adminId,
          userId: pending.id
        })
      ).resolves.toBe("rejected");
      await expect(
        repository.disableUser({
          revokedByUserId: adminId,
          userId: active.id
        })
      ).resolves.toBe("disabled");

      const [rejected, disabled, sessions] = await Promise.all([
        prisma.user.findUniqueOrThrow({
          select: {
            status: true
          },
          where: {
            id: pending.id
          }
        }),
        prisma.user.findUniqueOrThrow({
          select: {
            status: true
          },
          where: {
            id: active.id
          }
        }),
        prisma.authSession.findMany({
          orderBy: {
            tokenHash: "asc"
          },
          where: {
            userId: {
              in: [pending.id, active.id]
            }
          }
        })
      ]);

      expect(rejected.status).toBe("denied");
      expect(disabled.status).toBe("disabled");
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.revokedAt && session.revokedByUserId === adminId)).toBe(true);
      expect(sessions.every((session) => session.revokedReason === "admin_revoke_user")).toBe(true);
    });
  });

  it("forbids self-disable before changing status or sessions", async () => {
    await withAdminData(async ({ adminId, repository }) => {
      const tokenHash = hashToken(`self-disable-${adminId}`);
      await prisma.authSession.create({
        data: {
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          tokenHash,
          userId: adminId
        }
      });

      await expect(
        repository.disableUser({
          revokedByUserId: adminId,
          userId: adminId
        })
      ).resolves.toBe("self_disable_forbidden");

      await expect(
        prisma.user.findUniqueOrThrow({
          select: { status: true },
          where: { id: adminId }
        })
      ).resolves.toEqual({ status: "active" });
      await expect(
        prisma.authSession.findUniqueOrThrow({
          select: { revokedAt: true },
          where: { tokenHash }
        })
      ).resolves.toEqual({ revokedAt: null });
    });
  });

  it("serializes reciprocal fixture-admin disables without revoking an unrelated user session", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const peerAdmin = await prisma.user.create({
        data: {
          displayName: "Peer Admin Test Operator",
          email: `peer-operator@${domain}`,
          role: "admin",
          status: "active"
        }
      });
      const sentinelUser = await prisma.user.create({
        data: {
          displayName: "Unrelated Session Sentinel",
          email: `session-sentinel@${domain}`,
          role: "user",
          status: "active"
        }
      });
      const sentinelTokenHash = hashToken(`unrelated-user-session-${domain}`);
      await prisma.authSession.create({
        data: {
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          tokenHash: sentinelTokenHash,
          userId: sentinelUser.id
        }
      });

      try {
        const results = await Promise.all([
          repository.disableUser({
            revokedByUserId: adminId,
            userId: peerAdmin.id
          }),
          repository.disableUser({
            revokedByUserId: peerAdmin.id,
            userId: adminId
          })
        ]);
        const users = await prisma.user.findMany({
          select: {
            id: true,
            status: true
          },
          where: {
            id: {
              in: [adminId, peerAdmin.id]
            }
          }
        });

        expect(results.sort()).toEqual(["disabled", "last_admin_forbidden"]);
        expect(users.filter((user) => user.status === "active")).toHaveLength(1);
        expect(users.filter((user) => user.status === "disabled")).toHaveLength(1);
        await expect(
          prisma.authSession.findUniqueOrThrow({
            select: {
              revokedAt: true,
              revokedByUserId: true,
              revokedReason: true
            },
            where: {
              tokenHash: sentinelTokenHash
            }
          })
        ).resolves.toEqual({
          revokedAt: null,
          revokedByUserId: null,
          revokedReason: null
        });
      } finally {
        await prisma.authSession.deleteMany({
          where: {
            tokenHash: sentinelTokenHash
          }
        });
        await prisma.user.deleteMany({
          where: {
            id: sentinelUser.id
          }
        });
      }
    });
  });

  it("rolls back disable and reject when session revocation fails", async () => {
    await withAdminData(async ({ adminId, domain }) => {
      const active = await createPasswordUser({
        displayName: "Disable Rollback User",
        domain,
        emailLocalPart: "disable-rollback",
        status: "active"
      });
      const pending = await createPasswordUser({
        displayName: "Reject Rollback User",
        domain,
        emailLocalPart: "reject-rollback",
        status: "pending"
      });
      await prisma.authSession.createMany({
        data: [active.id, pending.id].map((userId) => ({
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          tokenHash: hashToken(`rollback-session-${userId}`),
          userId
        }))
      });
      const failingClient = prisma.$extends({
        query: {
          authSession: {
            updateMany() {
              throw new Error("injected_admin_session_revoke_failure");
            }
          }
        }
      });
      const repository = createPrismaAdminRepository(failingClient as unknown as PrismaClient);

      await expect(
        repository.disableUser({
          revokedByUserId: adminId,
          userId: active.id
        })
      ).rejects.toThrow("injected_admin_session_revoke_failure");
      await expect(
        repository.rejectUser({
          revokedByUserId: adminId,
          userId: pending.id
        })
      ).rejects.toThrow("injected_admin_session_revoke_failure");

      const [users, sessions] = await Promise.all([
        prisma.user.findMany({
          orderBy: { id: "asc" },
          select: { id: true, status: true },
          where: { id: { in: [active.id, pending.id] } }
        }),
        prisma.authSession.findMany({
          where: { userId: { in: [active.id, pending.id] } }
        })
      ]);

      const userStatuses = new Map(users.map((user) => [user.id, user.status]));
      expect(userStatuses.get(active.id)).toBe("active");
      expect(userStatuses.get(pending.id)).toBe("pending");
      expect(sessions.every((session) => session.revokedAt === null)).toBe(true);
    });
  });

  it("serializes email verification with a concurrent admin rejection", async () => {
    await withAdminData(async ({ adminId, domain, groupId, repository }) => {
      const email = `verification-reject@${domain}`;
      const user = await createPasswordUser({
        displayName: "Verification Reject Race",
        domain,
        emailLocalPart: "verification-reject",
        status: "pending",
        verified: false
      });
      const identity = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });
      const now = new Date("2026-07-18T00:00:00.000Z");
      await Promise.all([
        prisma.authAccessRule.create({
          data: {
            defaultGroups: {
              create: {
                groupId
              }
            },
            kind: "email",
            value: email
          }
        }),
        prisma.authFlowToken.create({
          data: {
            expiresAt: new Date("2026-07-19T00:00:00.000Z"),
            identityId: identity.id,
            normalizedEmail: email,
            purpose: "email_verification",
            sentToEmail: email,
            tokenHash: hashToken("verification-reject-token"),
            userId: user.id
          }
        })
      ]);
      const registration = createPrismaAuthRegistrationRepository(prisma);
      const verificationPasswordHash = await hashPassword("verification-race-password");
      const waitForStart = startBarrier(2);
      const [verification, rejection] = await Promise.all([
        (async () => {
          await waitForStart();
          return registration.completeEmailVerification({
            now,
            passwordHash: verificationPasswordHash,
            tokenHash: hashToken("verification-reject-token")
          });
        })(),
        (async () => {
          await waitForStart();
          return repository.rejectUser({
            revokedByUserId: adminId,
            userId: user.id
          });
        })()
      ]);
      const settled = await prisma.user.findUnique({
        select: { status: true },
        where: { id: user.id }
      });

      if (rejection === "rejected") {
        expect(verification).toBeNull();
        expect(settled).toEqual({ status: "denied" });
      } else {
        expect(rejection).toBe("not_found");
        expect(verification).toMatchObject({ status: "active" });
        expect(settled).toEqual({ status: "active" });
      }
    });
  });

  it("serializes email verification with guarded stale-user deletion without a lock inversion", async () => {
    await withAdminData(async ({ adminId, domain, groupId, repository }) => {
      const email = `verification-delete@${domain}`;
      const user = await createPasswordUser({
        displayName: "Verification Delete Race",
        domain,
        emailLocalPart: "verification-delete",
        status: "pending",
        verified: false
      });
      const identity = await prisma.authIdentity.findFirstOrThrow({
        where: {
          normalizedEmail: email,
          provider: "password"
        }
      });
      const now = new Date("2026-07-18T00:00:00.000Z");
      await Promise.all([
        prisma.authAccessRule.create({
          data: {
            defaultGroups: {
              create: { groupId }
            },
            kind: "email",
            value: email
          }
        }),
        prisma.authFlowToken.create({
          data: {
            expiresAt: new Date("2026-07-19T00:00:00.000Z"),
            identityId: identity.id,
            normalizedEmail: email,
            purpose: "email_verification",
            sentToEmail: email,
            tokenHash: hashToken("verification-delete-token"),
            userId: user.id
          }
        })
      ]);
      const registration = createPrismaAuthRegistrationRepository(prisma);
      const passwordHash = await hashPassword("verification-delete-password");
      const barrier = startBarrier(2);
      const [verification, deletion] = await Promise.all([
        (async () => {
          await barrier();
          return registration.completeEmailVerification({
            now,
            passwordHash,
            tokenHash: hashToken("verification-delete-token")
          });
        })(),
        (async () => {
          await barrier();
          return repository.deleteStaleUser({
            actingAdminUserId: adminId,
            userId: user.id
          });
        })()
      ]);
      const stored = await prisma.user.findUnique({
        select: { status: true },
        where: { id: user.id }
      });

      if (deletion === "deleted") {
        expect(verification).toBeNull();
        expect(stored).toBeNull();
      } else {
        expect(deletion).toBe("user_active");
        expect(verification).toMatchObject({ status: "active" });
        expect(stored).toEqual({ status: "active" });
      }
    });
  });

  it("serializes approval, rejection, and stale deletion on the user row", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const approvalTarget = await createPasswordUser({
        displayName: "Approval Reject Race",
        domain,
        emailLocalPart: "approval-reject",
        status: "pending"
      });
      const approvalBarrier = startBarrier(2);
      const [approval, rejection] = await Promise.all([
        (async () => {
          await approvalBarrier();
          return repository.approveUser({ userId: approvalTarget.id });
        })(),
        (async () => {
          await approvalBarrier();
          return repository.rejectUser({
            revokedByUserId: adminId,
            userId: approvalTarget.id
          });
        })()
      ]);
      const approvalTargetAfter = await prisma.user.findUniqueOrThrow({
        select: { status: true },
        where: { id: approvalTarget.id }
      });

      expect([approval, rejection]).not.toEqual(["approved", "rejected"]);
      expect(approvalTargetAfter.status).toBe(approval === "approved" ? "active" : "denied");

      const disableTarget = await createPasswordUser({
        displayName: "Approval Disable Race",
        domain,
        emailLocalPart: "approval-disable",
        status: "pending"
      });
      const disableBarrier = startBarrier(2);
      const [disableApproval, disableResult] = await Promise.all([
        (async () => {
          await disableBarrier();
          return repository.approveUser({ userId: disableTarget.id });
        })(),
        (async () => {
          await disableBarrier();
          return repository.disableUser({
            revokedByUserId: adminId,
            userId: disableTarget.id
          });
        })()
      ]);

      expect(disableResult).toBe("disabled");
      expect(["approved", "not_found"]).toContain(disableApproval);
      await expect(
        prisma.user.findUniqueOrThrow({
          select: { status: true },
          where: { id: disableTarget.id }
        })
      ).resolves.toEqual({ status: "disabled" });

      const deletionTarget = await createPasswordUser({
        displayName: "Approval Delete Race",
        domain,
        emailLocalPart: "approval-delete",
        status: "pending"
      });
      const deletionBarrier = startBarrier(2);
      const [deleteResult, approveResult] = await Promise.all([
        (async () => {
          await deletionBarrier();
          return repository.deleteStaleUser({
            actingAdminUserId: adminId,
            userId: deletionTarget.id
          });
        })(),
        (async () => {
          await deletionBarrier();
          return repository.approveUser({ userId: deletionTarget.id });
        })()
      ]);

      if (deleteResult === "deleted") {
        expect(approveResult).toBe("not_found");
        await expect(prisma.user.findUnique({ where: { id: deletionTarget.id } })).resolves.toBeNull();
      } else {
        expect(deleteResult).toBe("user_active");
        expect(approveResult).toBe("approved");
        await expect(
          prisma.user.findUniqueOrThrow({
            select: { status: true },
            where: { id: deletionTarget.id }
          })
        ).resolves.toEqual({ status: "active" });
      }
    });
  });

  it("does not delete a stale user after a concurrent owned-data insert settles", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const target = await createPasswordUser({
        displayName: "Owned Data Delete Race",
        domain,
        emailLocalPart: "owned-data-delete",
        status: "pending",
        verified: false
      });
      const waitForStart = startBarrier(2);
      const [deletion, chatCreation] = await Promise.allSettled([
        (async () => {
          await waitForStart();
          return repository.deleteStaleUser({
            actingAdminUserId: adminId,
            userId: target.id
          });
        })(),
        (async () => {
          await waitForStart();
          return prisma.chat.create({
            data: {
              title: "Concurrent owned chat",
              userId: target.id
            }
          });
        })()
      ]);

      if (chatCreation.status === "fulfilled") {
        expect(deletion).toEqual({
          status: "fulfilled",
          value: "user_has_owned_data"
        });
        await expect(prisma.user.findUnique({ where: { id: target.id } })).resolves.not.toBeNull();
      } else {
        expect(deletion).toEqual({
          status: "fulfilled",
          value: "deleted"
        });
        await expect(prisma.user.findUnique({ where: { id: target.id } })).resolves.toBeNull();
      }
    });
  });

  it("creates access rules and invites with creators, group defaults, and hashed invite tokens", async () => {
    await withAdminData(async ({ adminId, domain, groupId, repository }) => {
      const rule = await repository.createAccessRule({
        createdByUserId: adminId,
        groupIds: [groupId],
        kind: "domain",
        value: ` ${domain.toUpperCase()} `
      });
      const invite = await repository.createInvite({
        createdByUserId: adminId,
        email: `Friend@${domain}`,
        expiresAt: new Date("2026-06-21T00:00:00.000Z"),
        groupIds: [groupId],
        tokenHash: hashToken("raw-invite-token")
      });

      expect(rule).toMatchObject({
        kind: "domain",
        value: domain
      });
      expect(rule?.defaultGroups).toHaveLength(1);
      expect(invite).toMatchObject({
        email: `Friend@${domain}`,
        normalizedEmail: `friend@${domain}`
      });
      expect(isPlausibleEmail(invite!.normalizedEmail)).toBe(true);
      expect(invite?.defaultGroups).toHaveLength(1);

      await expect(
        repository.createAccessRule({
          createdByUserId: adminId,
          kind: "domain",
          value: "not-a-domain"
        })
      ).resolves.toBeNull();

      const [storedRule, storedInvite, flowToken] = await Promise.all([
        prisma.authAccessRule.findUniqueOrThrow({
          where: {
            id: rule!.id
          }
        }),
        prisma.authInvite.findUniqueOrThrow({
          where: {
            id: invite!.id
          }
        }),
        prisma.authFlowToken.findFirstOrThrow({
          where: {
            inviteId: invite!.id
          }
        })
      ]);

      expect(storedRule.createdByUserId).toBe(adminId);
      expect(storedInvite.createdByUserId).toBe(adminId);
      expect(flowToken.tokenHash).toBe(hashToken("raw-invite-token"));
      expect(flowToken.tokenHash).not.toBe("raw-invite-token");

      await expect(repository.revokeInvite(invite!.id)).resolves.toBe(true);
      await expect(
        prisma.authInvite.findUniqueOrThrow({
          select: {
            revokedAt: true
          },
          where: {
            id: invite!.id
          }
        })
      ).resolves.toMatchObject({
        revokedAt: expect.any(Date)
      });
    });
  });

  it("rejects invite addresses that password login and reset cannot accept", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      for (const email of ["user@internal", "user@example", "@example.com", `user @${domain}`]) {
        expect(isPlausibleEmail(email)).toBe(false);
        await expect(
          repository.createInvite({
            createdByUserId: adminId,
            email,
            expiresAt: new Date("2026-07-19T00:00:00.000Z"),
            tokenHash: hashToken(`invalid-invite-${email}`)
          })
        ).resolves.toBeNull();
      }

      await expect(
        prisma.authInvite.count({
          where: {
            createdByUserId: adminId
          }
        })
      ).resolves.toBe(0);
    });
  });

  it("rolls back a rule re-upsert when a replacement default group does not exist", async () => {
    await withAdminData(async ({ adminId, domain, groupId, repository }) => {
      const rule = await repository.createAccessRule({
        createdByUserId: adminId,
        groupIds: [groupId],
        kind: "domain",
        value: domain
      });

      await prisma.authAccessRule.update({
        data: {
          enabled: false
        },
        where: {
          id: rule!.id
        }
      });

      await expect(
        repository.createAccessRule({
          createdByUserId: adminId,
          groupIds: [groupId, randomUUID()],
          kind: "domain",
          value: domain
        })
      ).rejects.toThrow();

      const stored = await prisma.authAccessRule.findUniqueOrThrow({
        include: {
          defaultGroups: true
        },
        where: {
          kind_value: {
            kind: "domain",
            value: domain
          }
        }
      });

      expect(stored).toMatchObject({
        enabled: false,
        id: rule!.id
      });
      expect(stored.defaultGroups).toEqual([
        expect.objectContaining({
          groupId,
          role: "member"
        })
      ]);
    });
  });

  it("rolls back invite, default-group, and token rows when a requested group does not exist", async () => {
    await withAdminData(async ({ adminId, domain, groupId, repository }) => {
      const email = `invite-rollback@${domain}`;
      const tokenHash = hashToken(`invite-rollback-${domain}`);

      await expect(
        repository.createInvite({
          createdByUserId: adminId,
          email,
          expiresAt: new Date("2026-07-19T00:00:00.000Z"),
          groupIds: [groupId, randomUUID()],
          tokenHash
        })
      ).rejects.toThrow();

      const [inviteCount, defaultGroupCount, tokenCount] = await Promise.all([
        prisma.authInvite.count({
          where: {
            normalizedEmail: email
          }
        }),
        prisma.authInviteGroup.count({
          where: {
            groupId
          }
        }),
        prisma.authFlowToken.count({
          where: {
            tokenHash
          }
        })
      ]);

      expect({ defaultGroupCount, inviteCount, tokenCount }).toEqual({
        defaultGroupCount: 0,
        inviteCount: 0,
        tokenCount: 0
      });
    });
  });

  it("manages groups, memberships, grants, and archived entitlement cutoff", async () => {
    await withAdminData(async ({ adminId, domain, groupId, repository }) => {
      const user = await createPasswordUser({
        displayName: "Entitlement Admin Test User",
        domain,
        emailLocalPart: "entitled",
        status: "active"
      });
      const group = await repository.createGroup({
        name: `admin-test-extra-${domain}`
      });
      const fakeModel = await prisma.providerModel.findFirstOrThrow({
        select: { connectionId: true, id: true },
        where: { enabled: true, connection: { enabled: true, family: "fake" } }
      });
      const searchConnectionId = `admin-test-search-source-${domain}`;
      const searchOptionId = `admin-test-search-option-${domain}`;
      await prisma.providerConnection.create({
        data: {
          activeConfig: {},
          activeVersion: 1,
          activatedAt: new Date(),
          displayName: "Entitlement Search fixture source",
          enabled: true,
          family: "admin_test_search_fixture",
          id: searchConnectionId
        }
      });
      await prisma.searchOption.create({
        data: {
          description: "Entitlement Search fixture.",
          displayName: "Entitlement Search fixture",
          kind: "web_search",
          optionId: searchOptionId,
          sourceConnectionId: searchConnectionId
        }
      });

      expect(group).toMatchObject({
        archivedAt: null,
        name: `admin-test-extra-${domain}`
      });

      const renamed = await repository.renameGroup({
        groupId: group!.id,
        name: `admin-test-renamed-${domain}`
      });

      expect(renamed?.name).toBe(`admin-test-renamed-${domain}`);
      await expect(
        repository.setUserGroups({
          groupIds: [groupId, group!.id],
          userId: user.id
        })
      ).resolves.toBe(true);
      await expect(
        repository.setGroupGrant({
          enabled: true,
          groupId: group!.id,
          modelId: fakeModel.id,
          provider: fakeModel.connectionId
        })
      ).resolves.toBe(true);
      await expect(
        repository.setGroupGrant({
          enabled: true,
          groupId: group!.id,
          searchStrategy: searchOptionId
        })
      ).resolves.toBe(true);

      const entitled = await loadEntitlementsForUser(user.id);
      expect(entitled.modelKeys.has(`${fakeModel.connectionId}:${fakeModel.id}`)).toBe(true);
      expect(entitled.searchStrategies.has(searchOptionId)).toBe(true);

      const dashboard = await repository.listDashboard(adminId);
      const dashboardUser = dashboard.users.find((candidate) => candidate.id === user.id);
      expect(dashboard.groups.find((candidate) => candidate.id === group!.id)?.accessGrants).toHaveLength(2);
      expect(dashboardUser?.effectiveEntitlements.models).toContainEqual({
        modelId: fakeModel.id,
        provider: fakeModel.connectionId
      });

      await expect(repository.archiveGroup(group!.id)).resolves.toBe(true);
      const afterArchive = await loadEntitlementsForUser(user.id);
      expect(afterArchive.modelKeys.has("openai:gpt-5.5")).toBe(false);
      expect(afterArchive.searchStrategies.has(searchOptionId)).toBe(false);
      await expect(
        repository.setGroupGrant({
          enabled: true,
          groupId: group!.id,
          provider: fakeModel.connectionId
        })
      ).resolves.toBe(false);
    });
  });

  it("deletes stale users only when they are not active, not self, and have no app-owned data", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const stale = await createPasswordUser({
        displayName: "Delete Admin Test User",
        domain,
        emailLocalPart: "delete-me",
        status: "pending",
        verified: false
      });
      const active = await createPasswordUser({
        displayName: "Active Delete Block User",
        domain,
        emailLocalPart: "active-delete-block",
        status: "active"
      });
      const withData = await createPasswordUser({
        displayName: "Owned Data Delete Block User",
        domain,
        emailLocalPart: "owned-data-delete-block",
        status: "disabled"
      });

      await prisma.chat.create({
        data: {
          title: "Deletion blocker",
          userId: withData.id
        }
      });

      await expect(
        repository.deleteStaleUser({
          actingAdminUserId: adminId,
          userId: stale.id
        })
      ).resolves.toBe("deleted");
      await expect(
        prisma.user.findUnique({
          where: {
            id: stale.id
          }
        })
      ).resolves.toBeNull();
      await expect(
        repository.deleteStaleUser({
          actingAdminUserId: adminId,
          userId: adminId
        })
      ).resolves.toBe("self_delete_forbidden");
      await expect(
        repository.deleteStaleUser({
          actingAdminUserId: adminId,
          userId: active.id
        })
      ).resolves.toBe("user_active");
      await expect(
        repository.deleteStaleUser({
          actingAdminUserId: adminId,
          userId: withData.id
        })
      ).resolves.toBe("user_has_owned_data");
    });
  });

  it("does not treat Project-owned run evidence as account-owned deletion data", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const participant = await createPasswordUser({
        displayName: "Former Project Participant",
        domain,
        emailLocalPart: "former-project-participant",
        status: "active"
      });
      const projects = createPrismaProjectRepository(prisma);
      const created = await projects.create({
        actorDisplayName: "Admin Test Operator",
        description: "Project evidence account-deletion fixture",
        name: `Deletion evidence ${randomUUID()}`,
        userId: adminId
      });
      if (created.kind !== "ok") throw new Error(`project_fixture_create_${created.kind}`);
      const projectId = created.value.id;

      try {
        const granted = await projects.addGrant({
          actorDisplayName: "Admin Test Operator",
          expectedAccessRevision: created.value.accessRevision,
          projectId,
          role: "CONTRIBUTOR",
          targetUserId: participant.id,
          userId: adminId
        });
        if (granted.kind !== "ok") throw new Error(`project_fixture_grant_${granted.kind}`);
        const accepted = await projects.getDetail(participant.id, projectId);
        if (!accepted) throw new Error("project_fixture_member_detail_missing");
        const chat = await prisma.chat.create({
          data: {
            createdByDisplayName: participant.displayName,
            createdByUserId: participant.id,
            memoryMode: "EXCLUDED",
            projectId,
            title: "Shared evidence",
            userId: null
          }
        });
        const userMessage = await prisma.message.create({
          data: {
            authorDisplayName: participant.displayName,
            authorProjectRole: "CONTRIBUTOR",
            authorUserId: participant.id,
            chatId: chat.id,
            content: { blocks: [{ text: "Shared question", type: "text" }] },
            role: "user",
            status: "complete"
          }
        });
        const assistantMessage = await prisma.message.create({
          data: {
            chatId: chat.id,
            content: { blocks: [{ text: "Shared answer", type: "text" }] },
            modelId: "fake-qsa",
            parentMessageId: userMessage.id,
            provider: "fake",
            role: "assistant",
            status: "complete"
          }
        });
        const run = await prisma.$transaction(async (tx) => {
          const acceptedRun = await tx.modelRun.create({
            data: {
              assistantMessageId: assistantMessage.id,
              chatId: chat.id,
              modelId: "fake-qsa",
              normalizedRequest: {},
              provider: "fake",
              status: "complete",
              userId: participant.id,
              userMessageId: userMessage.id
            }
          });
          await tx.projectRunBinding.create({
            data: {
              acceptedRole: "CONTRIBUTOR",
              accessRevision: accepted.accessRevision,
              initiatorUserId: participant.id,
              instructionsRevision: accepted.instructionsRevision,
              memoryRevision: accepted.memoryRevision,
              modelRunId: acceptedRun.id,
              personalMemoryDisabled: true,
              policyRevision: accepted.policyRevision,
              projectId
            }
          });
          return acceptedRun;
        });
        await prisma.user.update({
          data: { status: "disabled" },
          where: { id: participant.id }
        });

        const dashboard = await repository.listDashboard(adminId);
        expect(dashboard.users.find((user) => user.id === participant.id)?.deletion)
          .toMatchObject({ canDelete: true, reason: null });
        await expect(repository.deleteStaleUser({
          actingAdminUserId: adminId,
          userId: participant.id
        })).resolves.toBe("deleted");
        await expect(prisma.modelRun.findUnique({ where: { id: run.id } })).resolves.not.toBeNull();
      } finally {
        const deleted = await projects.delete({
          actorDisplayName: "Admin Test Operator",
          projectId,
          userId: adminId
        });
        if (deleted.kind !== "ok" && deleted.kind !== "not_found") {
          throw new Error(`project_fixture_delete_${deleted.kind}`);
        }
      }
    });
  });

  it("returns not_found for missing guarded-delete targets", async () => {
    await withAdminData(async ({ adminId, repository }) => {
      await expect(
        repository.deleteStaleUser({
          actingAdminUserId: adminId,
          userId: randomUUID()
        })
      ).resolves.toBe("not_found");
      await expect(repository.deleteEmptyGroup(randomUUID())).resolves.toBe("not_found");
      await expect(
        repository.deleteStaleInvite({
          inviteId: randomUUID(),
          now: new Date("2026-06-14T00:00:00.000Z")
        })
      ).resolves.toBe("not_found");
    });
  });

  it("blocks stale user deletion for settings, grants, and current MCP configuration", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const withSettings = await createPasswordUser({
        displayName: "Settings Delete Block User",
        domain,
        emailLocalPart: "settings-delete-block",
        status: "disabled"
      });
      const withDirectGrant = await createPasswordUser({
        displayName: "Direct Grant Delete Block User",
        domain,
        emailLocalPart: "direct-grant-delete-block",
        status: "disabled"
      });
      const withMcpGrant = await createPasswordUser({
        displayName: "MCP Grant Delete Block User",
        domain,
        emailLocalPart: "mcp-grant-delete-block",
        status: "disabled"
      });
      const withMcpPreference = await createPasswordUser({
        displayName: "MCP Preference Delete Block User",
        domain,
        emailLocalPart: "mcp-preference-delete-block",
        status: "disabled"
      });
      const withMcpOAuth = await createPasswordUser({
        displayName: "MCP OAuth Delete Block User",
        domain,
        emailLocalPart: "mcp-oauth-delete-block",
        status: "disabled"
      });
      const mcpServer = await prisma.mcpServer.create({
        data: {
          displayName: "Delete eligibility MCP",
          namespace: `mcp-delete-${randomUUID()}`
        }
      });
      const fakeConnection = await prisma.providerConnection.findFirstOrThrow({
        select: { id: true },
        where: { enabled: true, family: "fake" }
      });

      try {
        await prisma.userSettings.create({
          data: {
            defaultControlValues: {},
            defaultProviderModelId: null,
            userId: withSettings.id
          }
        });
        await prisma.accessGrant.create({
          data: {
            enabled: true,
            providerConnectionId: fakeConnection.id,
            userId: withDirectGrant.id
          }
        });
        await prisma.mcpGrant.create({
          data: {
            canUse: true,
            serverId: mcpServer.id,
            userId: withMcpGrant.id
          }
        });
        await prisma.mcpUserServer.create({
          data: {
            serverId: mcpServer.id,
            userId: withMcpPreference.id
          }
        });
        await prisma.mcpOAuthConnection.create({
          data: {
            policyFingerprint: "delete-eligibility-test",
            purpose: "user",
            serverId: mcpServer.id,
            userId: withMcpOAuth.id
          }
        });

        for (const userId of [
          withSettings.id,
          withDirectGrant.id,
          withMcpGrant.id,
          withMcpPreference.id,
          withMcpOAuth.id
        ]) {
          await expect(
            repository.deleteStaleUser({
              actingAdminUserId: adminId,
              userId
            })
          ).resolves.toBe("user_has_owned_data");
        }
        await expect(
          prisma.user.count({
            where: {
              id: {
                in: [
                  withSettings.id,
                  withDirectGrant.id,
                  withMcpGrant.id,
                  withMcpPreference.id,
                  withMcpOAuth.id
                ]
              }
            }
          })
        ).resolves.toBe(5);
      } finally {
        await prisma.mcpServer.delete({
          where: {
            id: mcpServer.id
          }
        });
      }
    });
  });

  it("deletes only empty groups without active grants", async () => {
    await withAdminData(async ({ domain, repository }) => {
      const empty = await repository.createGroup({
        name: `admin-test-empty-delete-${domain}`
      });
      const withMember = await repository.createGroup({
        name: `admin-test-member-delete-${domain}`
      });
      const withGrant = await repository.createGroup({
        name: `admin-test-grant-delete-${domain}`
      });
      const withMcpGrant = await repository.createGroup({
        name: `mcp-delete-${domain}`
      });
      const withProviderCredential = await repository.createGroup({
        name: `pc-${domain}`
      });
      const user = await createPasswordUser({
        displayName: "Group Delete Member",
        domain,
        emailLocalPart: "group-delete-member",
        status: "active"
      });
      const fakeConnection = await prisma.providerConnection.findFirstOrThrow({
        select: { id: true },
        where: { enabled: true, family: "fake" }
      });

      await repository.setUserGroups({
        groupIds: [withMember!.id],
        userId: user.id
      });
      await repository.setGroupGrant({
        enabled: true,
        groupId: withGrant!.id,
        provider: fakeConnection.id
      });
      const mcpServer = await prisma.mcpServer.create({
        data: {
          displayName: "Group delete eligibility MCP",
          namespace: `mcp-group-delete-${randomUUID()}`
        }
      });
      const providerConnection = await prisma.providerConnection.findFirstOrThrow({
        select: { id: true },
        where: { family: "openai" }
      });
      const providerCredential = await prisma.providerCredential.create({
        data: {
          connectionId: providerConnection.id,
          label: `Group delete ${domain}`
        }
      });

      try {
        await prisma.mcpGrant.create({
          data: {
            canUse: true,
            groupId: withMcpGrant!.id,
            serverId: mcpServer.id
          }
        });
        await prisma.providerGroupCredentialAssignment.create({
          data: {
            connectionId: providerConnection.id,
            credentialId: providerCredential.id,
            groupId: withProviderCredential!.id
          }
        });

        await expect(repository.deleteEmptyGroup(empty!.id)).resolves.toBe("deleted");
        await expect(repository.deleteEmptyGroup(withMember!.id)).resolves.toBe("group_has_members");
        await expect(repository.deleteEmptyGroup(withGrant!.id)).resolves.toBe("group_has_grants");
        await expect(repository.deleteEmptyGroup(withMcpGrant!.id)).resolves.toBe("group_has_grants");
        await expect(repository.deleteEmptyGroup(withProviderCredential!.id)).resolves.toBe("group_has_grants");
        await expect(
          prisma.group.findUnique({
            where: {
              id: empty!.id
            }
          })
        ).resolves.toBeNull();
      } finally {
        await prisma.providerGroupCredentialAssignment.deleteMany({
          where: { credentialId: providerCredential.id }
        });
        await prisma.providerCredential.delete({
          where: { id: providerCredential.id }
        });
        await prisma.mcpServer.delete({
          where: {
            id: mcpServer.id
          }
        });
      }
    });
  });

  it("deletes stale invites while preserving open and accepted invites", async () => {
    await withAdminData(async ({ domain, repository }) => {
      const now = new Date("2026-06-14T00:00:00.000Z");
      const expired = await prisma.authInvite.create({
        data: {
          email: `expired@${domain}`,
          expiresAt: new Date("2026-06-13T00:00:00.000Z"),
          normalizedEmail: `expired@${domain}`
        }
      });
      const revoked = await prisma.authInvite.create({
        data: {
          email: `revoked@${domain}`,
          expiresAt: new Date("2026-06-21T00:00:00.000Z"),
          normalizedEmail: `revoked@${domain}`,
          revokedAt: now
        }
      });
      const open = await prisma.authInvite.create({
        data: {
          email: `open@${domain}`,
          expiresAt: new Date("2026-06-21T00:00:00.000Z"),
          normalizedEmail: `open@${domain}`
        }
      });
      const accepted = await prisma.authInvite.create({
        data: {
          acceptedAt: now,
          email: `accepted@${domain}`,
          expiresAt: new Date("2026-06-21T00:00:00.000Z"),
          normalizedEmail: `accepted@${domain}`
        }
      });

      await expect(
        repository.deleteStaleInvite({
          inviteId: expired.id,
          now
        })
      ).resolves.toBe("deleted");
      await expect(
        repository.deleteStaleInvite({
          inviteId: revoked.id,
          now
        })
      ).resolves.toBe("deleted");
      await expect(
        repository.deleteStaleInvite({
          inviteId: open.id,
          now
        })
      ).resolves.toBe("invite_open");
      await expect(
        repository.deleteStaleInvite({
          inviteId: accepted.id,
          now
        })
      ).resolves.toBe("invite_accepted");
      await expect(
        prisma.authInvite.count({
          where: {
            id: {
              in: [expired.id, revoked.id]
            }
          }
        })
      ).resolves.toBe(0);
    });
  });

  it("revokes exactly the scoped sessions and keeps the global revocation query explicit", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const scopedUser = await createPasswordUser({
        displayName: "Scoped Session User",
        domain,
        emailLocalPart: "scoped-session",
        status: "active"
      });
      const otherUser = await createPasswordUser({
        displayName: "Global Session User",
        domain,
        emailLocalPart: "global-session",
        status: "active"
      });
      const scopedHashes = [
        hashToken(`scoped-session-a-${domain}`),
        hashToken(`scoped-session-b-${domain}`)
      ];
      const otherHash = hashToken(`global-session-${domain}`);
      const previouslyRevokedHash = hashToken(`previously-revoked-${domain}`);
      const previouslyRevokedAt = new Date("2026-07-01T00:00:00.000Z");

      await prisma.authSession.createMany({
        data: [
          ...scopedHashes.map((tokenHash) => ({
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            tokenHash,
            userId: scopedUser.id
          })),
          {
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            tokenHash: otherHash,
            userId: otherUser.id
          },
          {
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            revokedAt: previouslyRevokedAt,
            revokedReason: "fixture_prior_revoke",
            tokenHash: previouslyRevokedHash,
            userId: scopedUser.id
          }
        ]
      });

      await expect(
        repository.revokeUserSessions({
          revokedByUserId: adminId,
          userId: scopedUser.id
        })
      ).resolves.toBe(2);

      const afterScoped = await prisma.authSession.findMany({
        where: {
          tokenHash: {
            in: [...scopedHashes, otherHash, previouslyRevokedHash]
          }
        }
      });
      const scopedByHash = new Map(afterScoped.map((session) => [session.tokenHash, session]));

      for (const tokenHash of scopedHashes) {
        expect(scopedByHash.get(tokenHash)).toMatchObject({
          revokedAt: expect.any(Date),
          revokedByUserId: adminId,
          revokedReason: "admin_revoke_user"
        });
      }
      expect(scopedByHash.get(otherHash)).toMatchObject({
        revokedAt: null,
        revokedByUserId: null,
        revokedReason: null
      });
      expect(scopedByHash.get(previouslyRevokedHash)).toMatchObject({
        revokedAt: previouslyRevokedAt,
        revokedByUserId: null,
        revokedReason: "fixture_prior_revoke"
      });

      const updateMany = vi.spyOn(prisma.authSession, "updateMany").mockResolvedValueOnce({ count: 7 });

      try {
        await expect(
          repository.revokeAllSessions({
            revokedByUserId: adminId
          })
        ).resolves.toBe(7);
        expect(updateMany).toHaveBeenCalledOnce();
        expect(updateMany).toHaveBeenCalledWith({
          data: {
            revokedAt: expect.any(Date),
            revokedByUserId: adminId,
            revokedReason: "admin_revoke_all"
          },
          where: {
            revokedAt: null
          }
        });
      } finally {
        updateMany.mockRestore();
      }
    });
  });

  it("enforces a reason and admin actor for revocation while preserving actor history", async () => {
    await withAdminData(async ({ adminId, domain, repository }) => {
      const target = await createPasswordUser({
        displayName: "Attributed Session User",
        domain,
        emailLocalPart: "attributed-session",
        status: "active"
      });
      const missingReasonHash = hashToken(`missing-reason-${domain}`);
      const missingActorHash = hashToken(`missing-actor-${domain}`);
      const systemHash = hashToken(`system-revocation-${domain}`);
      const adminHash = hashToken(`admin-revocation-${domain}`);
      const revokedAt = new Date("2026-07-27T14:24:57.972Z");

      await prisma.authSession.createMany({
        data: [missingReasonHash, missingActorHash, systemHash, adminHash].map((tokenHash) => ({
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          tokenHash,
          userId: target.id
        }))
      });

      await expect(
        prisma.authSession.update({
          data: { revokedAt },
          where: { tokenHash: missingReasonHash }
        })
      ).rejects.toThrow();
      await expect(
        prisma.authSession.update({
          data: {
            revokedAt,
            revokedReason: "admin_revoke_user"
          },
          where: { tokenHash: missingActorHash }
        })
      ).rejects.toThrow();
      await expect(
        prisma.authSession.update({
          data: {
            revokedAt,
            revokedReason: "password_reset"
          },
          where: { tokenHash: systemHash }
        })
      ).resolves.toMatchObject({
        revokedAt,
        revokedByUserId: null,
        revokedReason: "password_reset"
      });
      await expect(
        repository.revokeUserSessions({
          revokedByUserId: adminId,
          userId: target.id
        })
      ).resolves.toBe(3);

      await expect(
        prisma.authSession.findUniqueOrThrow({ where: { tokenHash: adminHash } })
      ).resolves.toMatchObject({
        revokedAt: expect.any(Date),
        revokedByUserId: adminId,
        revokedReason: "admin_revoke_user"
      });
      await expect(prisma.user.delete({ where: { id: adminId } })).rejects.toThrow();

      await prisma.user.delete({ where: { id: target.id } });
    });
  });
});
