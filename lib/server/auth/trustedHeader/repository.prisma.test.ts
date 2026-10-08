// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { trustedHeaderSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { prisma } from "../../prisma";
import { hashToken } from "../token";
import { TRUSTED_HEADER_SOURCE } from "./method";
import { createPrismaTrustedHeaderSignInRepository } from "./repository";

const now = new Date("2026-10-08T12:00:00.000Z");
const repository = createPrismaTrustedHeaderSignInRepository(prisma);

type Fixture = {
  email(localPart: string): string;
  group(label: string, values?: string[]): Promise<string>;
  session(userId: string, token: string): Promise<void>;
  sessionInput(token: string): { createdByUserAgent: string; expiresAt: Date; lastSeenAt: Date; tokenHash: string };
  value(name: string): string;
};

async function withTrustedHeaderData<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `trusted-header-${id}.example.com`;
  const groupIds: string[] = [];

  try {
    return await run({
      email: (localPart) => `${localPart}@${domain}`,
      async group(label, values = []) {
        const group = await prisma.group.create({
          data: {
            externalNames: { create: values.map((value) => ({ source: "trusted_header" as const, value })) },
            name: `${label}-${id}`
          }
        });
        groupIds.push(group.id);
        return group.id;
      },
      async session(userId, token) {
        await prisma.authSession.create({
          data: { expiresAt: new Date("2026-10-15T12:00:00.000Z"), signInMethod: "password", tokenHash: hashToken(`${token}-${id}`), userId }
        });
      },
      sessionInput: (token) => ({
        createdByUserAgent: "Trusted Header Test",
        expiresAt: new Date("2026-10-15T12:00:00.000Z"),
        lastSeenAt: now,
        tokenHash: hashToken(`${token}-${id}`)
      }),
      value: (name) => `${name}-${id}`
    });
  } finally {
    await prisma.user.deleteMany({
      where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } }
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }
}

function config(input: Record<string, unknown> = {}) {
  return trustedHeaderSignInConfigSchema.parse({ emailHeader: "X-Auth-Request-Email", ...input });
}

describe("trusted-header sign-in settlement", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates the account, binds the identity to the trusted-header source and issues the session", async () => {
    await withTrustedHeaderData(async (fixture) => {
      const email = fixture.email("new-member");

      const result = await repository.signIn({
        config: config(),
        identity: { displayName: "Synthetic Member", email, groups: null },
        now,
        session: fixture.sessionInput("new-member")
      });

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(result).toEqual({ sessionId: expect.any(String), status: "active", userId: user.id });
      expect(user).toMatchObject({ displayName: "Synthetic Member", role: "user", status: "active" });
      await expect(prisma.authIdentity.findFirstOrThrow({
        select: { emailVerifiedAt: true, provider: true, providerAccountId: true, source: true },
        where: { userId: user.id }
      })).resolves.toEqual({ emailVerifiedAt: now, provider: "trusted_header", providerAccountId: email, source: TRUSTED_HEADER_SOURCE });
      await expect(prisma.authSession.findMany({ select: { signInMethod: true }, where: { userId: user.id } }))
        .resolves.toEqual([{ signInMethod: "trusted_header" }]);
      await expect(repository.findLinkedUserId(email)).resolves.toBe(user.id);
    });
  });

  it("links an existing account by the proxy's email, and a changed email is a new identity", async () => {
    await withTrustedHeaderData(async (fixture) => {
      const email = fixture.email("existing");
      const existing = await prisma.user.create({ data: { displayName: "Existing", email, role: "user", status: "active" } });

      await expect(repository.signIn({
        config: config(),
        identity: { displayName: "", email, groups: null },
        now,
        session: fixture.sessionInput("existing")
      })).resolves.toMatchObject({ status: "active", userId: existing.id });

      const renamed = fixture.email("renamed");
      const second = await repository.signIn({
        config: config(),
        identity: { displayName: "", email: renamed, groups: null },
        now,
        session: fixture.sessionInput("renamed")
      });
      expect(second).toMatchObject({ status: "active" });
      expect(second.status === "active" && second.userId).not.toBe(existing.id);
      await expect(prisma.authIdentity.count({ where: { provider: "trusted_header", userId: existing.id } })).resolves.toBe(1);
    });
  });

  it("admits by allowed groups, syncs mapped groups and grants the admin role from the header", async () => {
    await withTrustedHeaderData(async (fixture) => {
      const staff = fixture.value("staff");
      const admins = fixture.value("admins");
      const staffGroup = await fixture.group("staff", [staff]);
      const otherGroup = await fixture.group("other", [fixture.value("other")]);
      const policy = config({ adminGroups: [admins], allowedGroups: [staff], syncGroups: true });
      const email = fixture.email("grouped");

      await expect(repository.signIn({
        config: policy,
        identity: { displayName: "", email, groups: null },
        now,
        session: fixture.sessionInput("refused")
      })).resolves.toEqual({ status: "not_allowed" });
      await expect(prisma.user.count({ where: { email } })).resolves.toBe(0);

      const result = await repository.signIn({
        config: policy,
        identity: { displayName: "", email, groups: [staff, admins] },
        now,
        session: fixture.sessionInput("grouped")
      });
      expect(result).toMatchObject({ status: "active" });
      const user = await prisma.user.findUniqueOrThrow({ select: { id: true, role: true, roleManagedBy: true }, where: { email } });
      expect(user).toMatchObject({ role: "admin", roleManagedBy: `trusted_header:${TRUSTED_HEADER_SOURCE}` });
      const memberships = await prisma.userGroup.findMany({ select: { groupId: true }, where: { userId: user.id } });
      expect(memberships.map((membership) => membership.groupId)).toContain(staffGroup);
      expect(memberships.map((membership) => membership.groupId)).not.toContain(otherGroup);
    });
  });

  it("revokes only a live session it replaces", async () => {
    await withTrustedHeaderData(async (fixture) => {
      const user = await prisma.user.create({
        data: { displayName: "Previous", email: fixture.email("previous"), role: "user", status: "active" }
      });
      await fixture.session(user.id, "previous");
      const { tokenHash } = fixture.sessionInput("previous");

      await expect(repository.revokeReplacedSession({ now, tokenHash })).resolves.toBe(true);
      await expect(prisma.authSession.findUniqueOrThrow({ select: { revokedAt: true, revokedReason: true }, where: { tokenHash } }))
        .resolves.toEqual({ revokedAt: now, revokedReason: "trusted_header_replaced" });
      await expect(repository.revokeReplacedSession({ now, tokenHash })).resolves.toBe(false);
    });
  });
});
