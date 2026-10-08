// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaAdminRepository } from "./adminRepository";
import { createPrismaSignInManagementRepository } from "./signInManagement";

const now = new Date("2026-10-08T12:00:00.000Z");
const management = createPrismaSignInManagementRepository(prisma);

type Fixture = {
  group(label: string, input?: { archived?: boolean; scim?: boolean }): Promise<string>;
  identity(userId: string, input: { provider: "google" | "oidc" | "password"; source?: string; warning?: string }): Promise<string>;
  run: string;
  user(label: string, groupIds?: string[]): Promise<string>;
};

async function withManagementData<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `sign-in-management-${id}.example.com`;
  const groupIds: string[] = [];
  // SCIM manages the groups it pushed only while it is enabled, so the fixture enables it.
  const scimSnapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "scim" } });
  await prisma.authSignInMethodSetting.upsert({
    create: { activatedAt: now, activeConfig: { linkMethod: "none" }, activeVersion: 1, enabled: true, method: "scim" },
    update: { enabled: true },
    where: { method: "scim" }
  });
  try {
    return await run({
      async group(label, input = {}) {
        const group = await prisma.group.create({
          data: {
            archivedAt: input.archived ? now : null,
            name: `${label}-${id}`,
            scimExternalId: input.scim ? `scim-${id}-${label}` : null
          }
        });
        groupIds.push(group.id);
        return group.id;
      },
      async identity(userId, input) {
        const user = await prisma.user.findUniqueOrThrow({ select: { email: true }, where: { id: userId } });
        const identity = await prisma.authIdentity.create({
          data: {
            emailVerifiedAt: now,
            lastSyncWarning: input.warning ?? null,
            lastSyncedAt: input.warning ? now : null,
            normalizedEmail: user.email!,
            passwordHash: input.provider === "password" ? "aiqsa-scrypt-v1$synthetic" : null,
            provider: input.provider,
            providerAccountId: `${input.provider}-${randomUUID()}`,
            source: input.provider === "oidc" ? input.source ?? `https://idp-${id}.example.test` : null,
            userId
          }
        });
        return identity.id;
      },
      run: id,
      async user(label, memberships = []) {
        const user = await prisma.user.create({
          data: {
            displayName: `Management ${label}`,
            email: `${label}@${domain}`,
            groups: { create: memberships.map((groupId) => ({ groupId })) },
            status: "active"
          }
        });
        return user.id;
      }
    });
  } finally {
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.authSignInMethodSetting.deleteMany({ where: { method: "scim" } });
    if (scimSnapshot) {
      await prisma.authSignInMethodSetting.create({
        data: { ...scimSnapshot, activeConfig: scimSnapshot.activeConfig ?? undefined, draftConfig: scimSnapshot.draftConfig ?? undefined }
      });
    }
  }
}

describe("sign-in management", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("adds exact external names per source and refuses duplicates and archived groups", async () => {
    await withManagementData(async ({ group }) => {
      const groupId = await group("team");
      const archivedId = await group("old", { archived: true });

      const added = await management.addExternalName({ groupId, source: "oidc", value: " /team " });
      expect(added.ok && added.value.externalNames).toEqual([expect.objectContaining({ source: "oidc", value: " /team " })]);
      await expect(management.addExternalName({ groupId, source: "oidc", value: " /team " }))
        .resolves.toEqual({ code: "external_name_duplicate", ok: false });
      // The same value for another source is another name.
      await expect(management.addExternalName({ groupId, source: "ldap", value: " /team " })).resolves.toMatchObject({ ok: true });
      await expect(management.addExternalName({ groupId, source: "github", value: "x" }))
        .resolves.toEqual({ code: "external_name_invalid", ok: false });
      await expect(management.addExternalName({ groupId, source: "oidc", value: "x".repeat(513) }))
        .resolves.toEqual({ code: "external_name_invalid", ok: false });
      await expect(management.addExternalName({ groupId: archivedId, source: "oidc", value: "/old" }))
        .resolves.toEqual({ code: "group_archived", ok: false });
      await expect(management.addExternalName({ groupId: randomUUID(), source: "oidc", value: "/none" }))
        .resolves.toEqual({ code: "group_not_found", ok: false });

      const nameId = added.ok ? added.value.externalNames[0]!.id : "";
      const removed = await management.removeExternalName({ externalNameId: nameId, groupId });
      expect(removed.ok && removed.value.externalNames.map((name) => name.source)).toEqual(["ldap"]);
      await expect(management.removeExternalName({ externalNameId: nameId, groupId }))
        .resolves.toEqual({ code: "external_name_not_found", ok: false });
    });
  });

  it("refuses manual changes of memberships a source or SCIM manages, and allows the others", async () => {
    await withManagementData(async ({ group, identity, user }) => {
      const managedId = await group("idp-team");
      const scimId = await group("pushed", { scim: true });
      const plainId = await group("plain");
      await management.addExternalName({ groupId: managedId, source: "oidc", value: "/idp-team" });
      const directoryUser = await user("directory");
      await identity(directoryUser, { provider: "oidc" });
      const googleUser = await user("google");
      await identity(googleUser, { provider: "google" });
      const admin = createPrismaAdminRepository(prisma);

      await expect(admin.setUserGroups({ expectedGroupIds: [], groupIds: [managedId], userId: directoryUser }))
        .resolves.toBe("group_membership_managed");
      await expect(admin.setUserGroups({ expectedGroupIds: [], groupIds: [scimId], userId: googleUser }))
        .resolves.toBe("group_membership_managed");
      await expect(prisma.userGroup.count({ where: { userId: { in: [directoryUser, googleUser] } } })).resolves.toBe(0);

      // Without an OIDC identity the external name manages nothing for this user.
      await expect(admin.setUserGroups({ expectedGroupIds: [], groupIds: [managedId, plainId], userId: googleUser }))
        .resolves.toBe("applied");
      await expect(admin.setUserGroups({ expectedGroupIds: [], groupIds: [plainId], userId: directoryUser }))
        .resolves.toBe("applied");

      const projection = await management.readGroup(managedId);
      expect(projection?.managedMembers).toEqual([]);
      await prisma.userGroup.create({ data: { groupId: managedId, userId: directoryUser } });
      await expect(management.readGroup(managedId)).resolves.toMatchObject({
        managedMembers: [{ managedBy: "oidc", userId: directoryUser }],
        scimManaged: false
      });
      // Removing the managed membership is refused just like adding it.
      await expect(admin.setUserGroups({ expectedGroupIds: [managedId, plainId], groupIds: [plainId], userId: directoryUser }))
        .resolves.toBe("group_membership_managed");
    });
  });

  it("projects identities with their sync status and source, and unlinks with a last-method guard", async () => {
    await withManagementData(async ({ group, identity, run, user }) => {
      const scimId = await group("pushed", { scim: true });
      const person = await user("person", [scimId]);
      const currentSource = `https://idp-${run}.example.test/realms/current`;
      const oidcIdentity = await identity(person, { provider: "oidc", source: `https://idp-${run}.example.test/realms/old`, warning: "groups_claim_missing" });

      const projection = await management.readUser(person, { oidc: currentSource });
      expect(projection).toEqual({
        hasPassword: false,
        identities: [expect.objectContaining({
          id: oidcIdentity,
          lastSyncWarning: "groups_claim_missing",
          provider: "oidc",
          sourceCurrent: false
        })],
        managedGroups: [{ groupId: scimId, managedBy: "scim" }]
      });

      await expect(management.unlinkIdentity({
        confirmLastSignInMethod: false,
        currentSources: {},
        identityId: oidcIdentity,
        userId: person
      })).resolves.toEqual({ code: "identity_last_sign_in_method", ok: false });

      const passwordIdentity = await identity(person, { provider: "password" });
      await expect(management.unlinkIdentity({
        confirmLastSignInMethod: true,
        currentSources: {},
        identityId: passwordIdentity,
        userId: person
      })).resolves.toEqual({ code: "identity_unlink_forbidden", ok: false });

      const unlinked = await management.unlinkIdentity({
        confirmLastSignInMethod: false,
        currentSources: {},
        identityId: oidcIdentity,
        userId: person
      });
      expect(unlinked.ok && unlinked.value).toMatchObject({ hasPassword: true, identities: [] });
      await expect(prisma.authIdentity.count({ where: { id: oidcIdentity } })).resolves.toBe(0);
      await expect(management.unlinkIdentity({
        confirmLastSignInMethod: true,
        currentSources: {},
        identityId: oidcIdentity,
        userId: person
      })).resolves.toEqual({ code: "identity_not_found", ok: false });
    });
  });
});
