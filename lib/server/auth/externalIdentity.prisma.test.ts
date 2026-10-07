// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaAdminRepository } from "./adminRepository";
import {
  completeExternalSignIn,
  externalIdentityPolicy,
  externalRoleManager,
  settleExternalIdentity,
  type ExternalIdentityInput,
  type ExternalIdentityPolicy
} from "./externalIdentity";
import { hashToken } from "./token";

const now = new Date("2026-10-08T12:00:00.000Z");
const ADMIN_GROUP = "aiqsa-admins";

const openPolicy = externalIdentityPolicy({
  adminGroups: [],
  allowedGroups: [],
  autoCreateUsers: true,
  syncGroups: false
});

type SettlementFixture = {
  adminId: string;
  /** A group owned by this test, optionally named for external sources. */
  group(label: string, input?: { archived?: boolean; names?: { source: "ldap" | "oidc"; value: string }[] }): Promise<string>;
  /** An external identity of the test source, linked to an existing user. */
  identity(user: { email: string; id: string }, input: { source?: string; subject: string }): Promise<void>;
  input(input: Partial<ExternalIdentityInput> & { email: string; subject: string }): ExternalIdentityInput;
  issuer: string;
  user(input: {
    localPart: string;
    role?: "admin" | "user";
    roleManagedBy?: string | null;
    status?: "active" | "disabled" | "pending";
  }): Promise<{ email: string; id: string }>;
  email(localPart: string): string;
};

class RolledBack extends Error {
  constructor(readonly value: unknown) {
    super("rolled_back");
  }
}

/** Runs in a transaction that always rolls back, so its changes to shared rows never persist. */
async function rolledBack<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => {
      throw new RolledBack(await run(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.value as T;
    }
    throw error;
  }
  throw new Error("rolled_back_transaction_committed");
}

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

function settle(input: ExternalIdentityInput) {
  return prisma.$transaction((tx) => settleExternalIdentity(tx, input));
}

async function withSettlementData<T>(run: (fixture: SettlementFixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `external-${id}.example.com`;
  const issuer = `https://idp-${id}.example.test/realms/aiqsa`;
  const groupIds: string[] = [];
  const email = (localPart: string) => `${localPart}@${domain}`;
  const admin = await prisma.user.create({
    data: { displayName: "Settlement Test Admin", email: email("operator"), role: "admin", status: "active" }
  });

  try {
    return await run({
      adminId: admin.id,
      email,
      async group(label, input = {}) {
        const group = await prisma.group.create({
          data: {
            archivedAt: input.archived ? now : null,
            externalNames: { create: input.names ?? [] },
            name: `${label}-${id}`
          }
        });
        groupIds.push(group.id);
        return group.id;
      },
      async identity(user, input) {
        await prisma.authIdentity.create({
          data: {
            emailVerifiedAt: now,
            normalizedEmail: user.email,
            provider: "oidc",
            providerAccountId: input.subject,
            source: input.source ?? issuer,
            userId: user.id
          }
        });
      },
      input(input) {
        return {
          displayName: "Synthetic Directory User",
          emailVerified: true,
          groups: [],
          now,
          policy: openPolicy,
          provider: "oidc",
          source: issuer,
          ...input
        };
      },
      issuer,
      async user(input) {
        const user = await prisma.user.create({
          data: {
            displayName: `Settlement ${input.localPart}`,
            email: email(input.localPart),
            role: input.role ?? "user",
            roleManagedBy: input.roleManagedBy ?? null,
            status: input.status ?? "active"
          }
        });
        return { email: user.email!, id: user.id };
      }
    });
  } finally {
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.authAccessRule.deleteMany({ where: { value: domain } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }
}

async function roleOf(userId: string) {
  return prisma.user.findUniqueOrThrow({ select: { role: true, roleManagedBy: true }, where: { id: userId } });
}

async function groupIdsOf(userId: string) {
  const memberships = await prisma.userGroup.findMany({ select: { groupId: true }, where: { userId } });
  return memberships.map((membership) => membership.groupId).sort();
}

describe("external identity settlement", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("finds a linked identity by its subject even after the source changes its email", async () => {
    await withSettlementData(async (fixture) => {
      const user = await fixture.user({ localPart: "linked" });
      await fixture.identity(user, { subject: "stable-subject" });

      await expect(settle(fixture.input({ email: fixture.email("renamed"), subject: "stable-subject" })))
        .resolves.toEqual({ status: "active", userId: user.id });
      await expect(prisma.user.count({ where: { email: fixture.email("renamed") } })).resolves.toBe(0);
      await expect(prisma.authIdentity.count({ where: { userId: user.id } })).resolves.toBe(1);
    });
  });

  it("refuses a known subject from another source without changing anything", async () => {
    await withSettlementData(async (fixture) => {
      const user = await fixture.user({ localPart: "moved" });
      await fixture.identity(user, { source: `${fixture.issuer}-previous`, subject: "moved-subject" });

      await expect(settle(fixture.input({ email: user.email, subject: "moved-subject" })))
        .resolves.toEqual({ status: "source_changed" });
      await expect(prisma.authIdentity.findMany({ select: { source: true }, where: { userId: user.id } }))
        .resolves.toEqual([{ source: `${fixture.issuer}-previous` }]);
    });
  });

  it("links an existing account only through a verified email or the method's explicit trust", async () => {
    await withSettlementData(async (fixture) => {
      const verifiedOwner = await fixture.user({ localPart: "verified-owner" });
      const trustedOwner = await fixture.user({ localPart: "trusted-owner" });
      const disabled = await fixture.user({ localPart: "disabled", status: "disabled" });

      await expect(settle(fixture.input({ email: verifiedOwner.email, emailVerified: false, subject: "unverified-claim" })))
        .resolves.toEqual({ status: "account_conflict" });
      // An unverified claim learns no more about a disabled account than about any other.
      await expect(settle(fixture.input({ email: disabled.email, emailVerified: false, subject: "disabled-claim" })))
        .resolves.toEqual({ status: "account_conflict" });
      await expect(prisma.authIdentity.count({ where: { provider: "oidc", userId: { in: [verifiedOwner.id, disabled.id] } } }))
        .resolves.toBe(0);

      await expect(settle(fixture.input({ email: verifiedOwner.email, subject: "verified-claim" })))
        .resolves.toEqual({ status: "active", userId: verifiedOwner.id });
      await expect(settle(fixture.input({ email: disabled.email, subject: "disabled-verified-claim" })))
        .resolves.toEqual({ status: "not_allowed" });
      await expect(settle(fixture.input({
        email: trustedOwner.email,
        emailVerified: false,
        policy: { ...openPolicy, trustUnverifiedEmail: true },
        subject: "trusted-claim"
      }))).resolves.toEqual({ status: "active", userId: trustedOwner.id });

      await expect(prisma.authIdentity.findMany({
        orderBy: { providerAccountId: "asc" },
        select: { emailVerifiedAt: true, providerAccountId: true, source: true, userId: true },
        where: { provider: "oidc", userId: { in: [verifiedOwner.id, trustedOwner.id, disabled.id] } }
      })).resolves.toEqual([
        { emailVerifiedAt: null, providerAccountId: "trusted-claim", source: fixture.issuer, userId: trustedOwner.id },
        { emailVerifiedAt: now, providerAccountId: "verified-claim", source: fixture.issuer, userId: verifiedOwner.id }
      ]);
    });
  });

  it("admits by allowed groups, failing closed when the groups claim is missing", async () => {
    await withSettlementData(async (fixture) => {
      const restricted: ExternalIdentityPolicy = {
        ...openPolicy,
        admission: { allowedGroups: ["aiqsa-users"], kind: "groups" }
      };
      const email = fixture.email("restricted");

      for (const groups of [null, [], ["other-team"]]) {
        await expect(settle(fixture.input({ email, groups, policy: restricted, subject: "restricted-subject" })))
          .resolves.toEqual({ status: "not_allowed" });
      }
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);

      const admitted = await settle(fixture.input({
        email,
        groups: ["other-team", "aiqsa-users"],
        policy: restricted,
        subject: "restricted-subject"
      }));
      expect(admitted).toMatchObject({ status: "active" });
      // A linked identity is admitted again at every sign-in.
      await expect(settle(fixture.input({ email, groups: null, policy: restricted, subject: "restricted-subject" })))
        .resolves.toEqual({ status: "not_allowed" });
      // Without allowed groups, anyone the source authenticated is admitted.
      await expect(settle(fixture.input({ email, groups: null, subject: "restricted-subject" })))
        .resolves.toEqual(admitted);
    });
  });

  it("creates an account only when the policy creates users, and activates a pending one", async () => {
    await withSettlementData(async (fixture) => {
      const email = fixture.email("new-member");
      const pending = await fixture.user({ localPart: "pending", status: "pending" });

      await expect(settle(fixture.input({
        email,
        policy: { ...openPolicy, autoCreateUsers: false },
        subject: "new-subject"
      }))).resolves.toEqual({ status: "not_allowed" });
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);
      await expect(prisma.authIdentity.count({ where: { normalizedEmail: email } })).resolves.toBe(0);

      const created = await settle(fixture.input({ displayName: " New Member ", email, subject: "new-subject" }));
      const user = await prisma.user.findUniqueOrThrow({
        include: { authIdentities: true, settings: true },
        where: { email }
      });

      expect(created).toEqual({ status: "active", userId: user.id });
      expect(user).toMatchObject({ displayName: "New Member", role: "user", roleManagedBy: null, status: "active" });
      expect(user.settings).not.toBeNull();
      expect(user.authIdentities).toEqual([expect.objectContaining({
        emailVerifiedAt: now,
        provider: "oidc",
        providerAccountId: "new-subject",
        source: fixture.issuer
      })]);

      await expect(settle(fixture.input({
        email: pending.email,
        policy: { ...openPolicy, autoCreateUsers: false },
        subject: "pending-subject"
      }))).resolves.toEqual({ status: "active", userId: pending.id });
      await expect(prisma.user.findUniqueOrThrow({ select: { status: true }, where: { id: pending.id } }))
        .resolves.toEqual({ status: "active" });
    });
  });

  it("keeps today's access-rule admission for providers that use it", async () => {
    await withSettlementData(async (fixture) => {
      const accessRules: ExternalIdentityPolicy = { ...openPolicy, admission: { kind: "access_rules" } };
      const defaultGroupId = await fixture.group("access-rule-default");
      const pending = await fixture.user({ localPart: "access-pending", status: "pending" });
      const email = fixture.email("access-new");

      await expect(settle(fixture.input({ email, policy: accessRules, subject: "access-new-subject" })))
        .resolves.toEqual({ status: "not_allowed" });
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);
      await expect(settle(fixture.input({ email: pending.email, policy: accessRules, subject: "access-pending-subject" })))
        .resolves.toEqual({ status: "pending" });
      await expect(prisma.authIdentity.count({ where: { providerAccountId: "access-pending-subject" } })).resolves.toBe(1);

      await prisma.authAccessRule.create({
        data: { defaultGroups: { create: { groupId: defaultGroupId } }, kind: "domain", value: email.split("@")[1]! }
      });
      const created = await settle(fixture.input({ email, policy: accessRules, subject: "access-new-subject" }));
      const user = await prisma.user.findUniqueOrThrow({ select: { id: true, status: true }, where: { email } });

      expect(created).toEqual({ status: "active", userId: user.id });
      expect(user.status).toBe("active");
      await expect(groupIdsOf(user.id)).resolves.toEqual([defaultGroupId]);
      await expect(settle(fixture.input({ email: pending.email, policy: accessRules, subject: "access-pending-subject" })))
        .resolves.toEqual({ status: "active", userId: pending.id });
    });
  });

  it("syncs the source's managed groups at sign-in and records the content-free outcome", async () => {
    await withSettlementData(async (fixture) => {
      const engineering = await fixture.group("engineering", { names: [{ source: "oidc", value: "/engineering" }] });
      const operations = await fixture.group("operations", { names: [{ source: "oidc", value: "/operations" }] });
      const manual = await fixture.group("manual");
      const directory = await fixture.group("directory", { names: [{ source: "ldap", value: "/operations" }] });
      const user = await fixture.user({ localPart: "synced" });
      await fixture.identity(user, { subject: "synced-subject" });
      await prisma.userGroup.createMany({
        data: [operations, manual, directory].map((groupId) => ({ groupId, userId: user.id }))
      });
      const syncing = { ...openPolicy, syncGroups: true };

      await expect(settle(fixture.input({
        email: user.email,
        groups: ["/engineering"],
        policy: syncing,
        subject: "synced-subject"
      }))).resolves.toEqual({ status: "active", userId: user.id });
      await expect(groupIdsOf(user.id)).resolves.toEqual([directory, engineering, manual].sort());

      await expect(settle(fixture.input({ email: user.email, groups: null, policy: syncing, subject: "synced-subject" })))
        .resolves.toEqual({ status: "active", userId: user.id, warning: "groups_claim_missing" });
      await expect(groupIdsOf(user.id)).resolves.toEqual([directory, engineering, manual].sort());
      await expect(prisma.authIdentity.findFirstOrThrow({
        select: { lastSyncWarning: true, lastSyncedAt: true },
        where: { providerAccountId: "synced-subject" }
      })).resolves.toEqual({ lastSyncWarning: "groups_claim_missing", lastSyncedAt: now });
    });
  });

  it("promotes admin-group members and demotes only the admins it promoted", async () => {
    await withSettlementData(async (fixture) => {
      const managing = { ...openPolicy, adminGroups: [ADMIN_GROUP] };
      const manager = externalRoleManager("oidc", fixture.issuer);
      const member = await fixture.user({ localPart: "member" });
      const promoted = await fixture.user({ localPart: "promoted", role: "admin", roleManagedBy: manager });
      const manualAdmin = await fixture.user({ localPart: "manual-admin", role: "admin" });
      const otherSourceAdmin = await fixture.user({
        localPart: "other-source-admin",
        role: "admin",
        roleManagedBy: externalRoleManager("saml", fixture.issuer)
      });
      for (const [user, subject] of [
        [member, "member-subject"],
        [promoted, "promoted-subject"],
        [manualAdmin, "manual-subject"],
        [otherSourceAdmin, "other-source-subject"]
      ] as const) {
        await fixture.identity(user, { subject });
      }

      await expect(settle(fixture.input({ email: member.email, groups: [ADMIN_GROUP], policy: managing, subject: "member-subject" })))
        .resolves.toEqual({ status: "active", userId: member.id });
      await expect(roleOf(member.id)).resolves.toEqual({ role: "admin", roleManagedBy: manager });

      for (const [user, subject] of [
        [promoted, "promoted-subject"],
        [manualAdmin, "manual-subject"],
        [otherSourceAdmin, "other-source-subject"]
      ] as const) {
        await expect(settle(fixture.input({ email: user.email, groups: ["staff"], policy: managing, subject })))
          .resolves.toEqual({ status: "active", userId: user.id });
      }
      await expect(roleOf(promoted.id)).resolves.toEqual({ role: "user", roleManagedBy: null });
      await expect(roleOf(manualAdmin.id)).resolves.toEqual({ role: "admin", roleManagedBy: null });
      await expect(roleOf(otherSourceAdmin.id)).resolves.toEqual({
        role: "admin",
        roleManagedBy: externalRoleManager("saml", fixture.issuer)
      });

      // A missing claim leaves the role as it is.
      await expect(settle(fixture.input({ email: member.email, groups: null, policy: managing, subject: "member-subject" })))
        .resolves.toEqual({ status: "active", userId: member.id, warning: "groups_claim_missing" });
      await expect(roleOf(member.id)).resolves.toEqual({ role: "admin", roleManagedBy: manager });

      // A manual role change takes the role over from the source.
      const admins = createPrismaAdminRepository(prisma);
      await expect(admins.setUserRole({ actingAdminUserId: fixture.adminId, role: "user", userId: member.id }))
        .resolves.toBe("revoked");
      await expect(admins.setUserRole({ actingAdminUserId: fixture.adminId, role: "admin", userId: member.id }))
        .resolves.toBe("granted");
      await expect(roleOf(member.id)).resolves.toEqual({ role: "admin", roleManagedBy: null });
    });
  });

  it("keeps the last active admin, with a warning, instead of demoting it", async () => {
    await withSettlementData(async (fixture) => {
      const manager = externalRoleManager("oidc", fixture.issuer);
      const lastAdmin = await fixture.user({ localPart: "last-admin", role: "admin", roleManagedBy: manager });
      await fixture.identity(lastAdmin, { subject: "last-admin-subject" });

      const observed = await rolledBack(async (tx) => {
        // Only inside this rolled-back transaction: every other active admin steps down.
        await tx.user.updateMany({
          data: { role: "user" },
          where: { id: { not: lastAdmin.id }, role: "admin", status: "active" }
        });
        const outcome = await settleExternalIdentity(tx, fixture.input({
          email: lastAdmin.email,
          groups: [],
          policy: { ...openPolicy, adminGroups: [ADMIN_GROUP] },
          subject: "last-admin-subject"
        }));
        const user = await tx.user.findUniqueOrThrow({
          select: { role: true, roleManagedBy: true },
          where: { id: lastAdmin.id }
        });
        const identity = await tx.authIdentity.findFirstOrThrow({
          select: { lastSyncWarning: true },
          where: { providerAccountId: "last-admin-subject" }
        });
        return { identity, outcome, user };
      });

      expect(observed).toEqual({
        identity: { lastSyncWarning: "last_admin_kept" },
        outcome: { status: "active", userId: lastAdmin.id, warning: "last_admin_kept" },
        user: { role: "admin", roleManagedBy: manager }
      });
    });
  });

  it("never deadlocks an admin-managing sign-in against a concurrent manual role change", async () => {
    await withSettlementData(async (fixture) => {
      const admins = createPrismaAdminRepository(prisma);
      const manager = externalRoleManager("oidc", fixture.issuer);
      const contested = await fixture.user({ localPart: "contested" });
      await fixture.identity(contested, { subject: "contested-subject" });
      const managing = { ...openPolicy, adminGroups: [ADMIN_GROUP] };

      for (let round = 0; round < 6; round += 1) {
        const promote = round % 2 === 0;
        const wait = startBarrier(2);
        const [outcome, manual] = await Promise.all([
          wait().then(() => settle(fixture.input({
            email: contested.email,
            groups: promote ? [ADMIN_GROUP] : [],
            policy: managing,
            subject: "contested-subject"
          }))),
          wait().then(() => admins.setUserRole({
            actingAdminUserId: fixture.adminId,
            role: promote ? "user" : "admin",
            userId: contested.id
          }))
        ]);

        expect(outcome).toEqual({ status: "active", userId: contested.id });
        expect(["granted", "revoked", "unchanged"]).toContain(manual);
        // Either serial order is valid; neither leaves a managing source on a non-admin.
        expect([
          { role: "admin", roleManagedBy: manager },
          { role: "admin", roleManagedBy: null },
          { role: "user", roleManagedBy: null }
        ]).toContainEqual(await roleOf(contested.id));
      }
    });
  });

  it("issues the session in the settling transaction with the method that proved the sign-in", async () => {
    await withSettlementData(async (fixture) => {
      const email = fixture.email("session-member");
      const session = (token: string) => ({
        createdByUserAgent: "External Settlement Test",
        expiresAt: new Date("2026-10-15T12:00:00.000Z"),
        lastSeenAt: now,
        tokenHash: hashToken(token)
      });

      await expect(completeExternalSignIn(prisma, {
        ...fixture.input({ email, policy: { ...openPolicy, autoCreateUsers: false }, subject: "session-subject" }),
        session: session(`refused-${email}`),
        signInMethod: "oidc"
      })).resolves.toEqual({ status: "not_allowed" });

      const signedIn = await completeExternalSignIn(prisma, {
        ...fixture.input({ email, subject: "session-subject" }),
        session: session(`issued-${email}`),
        signInMethod: "oidc"
      });
      const user = await prisma.user.findUniqueOrThrow({ select: { id: true }, where: { email } });

      expect(signedIn).toEqual({ sessionId: expect.any(String), status: "active", userId: user.id });
      await expect(prisma.authSession.findMany({
        select: { id: true, signInMethod: true },
        where: { userId: user.id }
      })).resolves.toEqual([{ id: signedIn.status === "active" ? signedIn.sessionId : "", signInMethod: "oidc" }]);
      await expect(prisma.authSession.count({ where: { tokenHash: hashToken(`refused-${email}`) } })).resolves.toBe(0);
    });
  });
});
