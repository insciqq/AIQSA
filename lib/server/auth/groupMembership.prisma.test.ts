// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaAdminRepository } from "./adminRepository";
import { syncExternalGroups } from "./groupMembership";

type MembershipFixture = {
  group(label: string, input?: { archived?: boolean; names?: { source: "ldap" | "oidc"; value: string }[] }): Promise<string>;
  /** An installation MCP server granted to one group, with a ready runtime revision. */
  mcpServer(label: string, grantedGroupId: string): Promise<{ revisionId: string; serverId: string }>;
  /** The user's enabled preference for a server, with a desired runtime generation. */
  mcpPreference(server: { revisionId: string; serverId: string }, userId: string): Promise<string>;
  user(localPart: string): Promise<string>;
  /** An external group value unique to this run. */
  value(name: string): string;
};

async function withMembershipData<T>(run: (fixture: MembershipFixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `membership-${id}.example.com`;
  const groupIds: string[] = [];
  const serverIds: string[] = [];

  try {
    return await run({
      async group(label, input = {}) {
        const group = await prisma.group.create({
          data: {
            archivedAt: input.archived ? new Date() : null,
            externalNames: { create: input.names ?? [] },
            name: `${label}-${id}`
          }
        });
        groupIds.push(group.id);
        return group.id;
      },
      async mcpPreference(server, userId) {
        const preference = await prisma.mcpUserServer.create({
          data: { enabled: true, serverId: server.serverId, userId }
        });
        const generation = await prisma.mcpRuntimeGeneration.create({
          data: {
            fingerprint: randomUUID(),
            revisionId: server.revisionId,
            state: "ready",
            userServerId: preference.id
          }
        });
        await prisma.mcpUserServer.update({
          data: { desiredRuntimeGenerationId: generation.id },
          where: { id: preference.id }
        });
        return preference.id;
      },
      async mcpServer(label, grantedGroupId) {
        const server = await prisma.mcpServer.create({
          data: { displayName: `Membership ${label}`, enabled: true, namespace: `membership_${label}_${id.replaceAll("-", "")}` }
        });
        serverIds.push(server.id);
        const revision = await prisma.mcpRevision.create({
          data: {
            configuration: {},
            draftHash: "a".repeat(64),
            identityHash: `membership-${label}`,
            revisionNumber: 1,
            serverId: server.id,
            validationEvidence: {}
          }
        });
        await prisma.mcpGrant.create({ data: { canUse: true, groupId: grantedGroupId, serverId: server.id } });
        return { revisionId: revision.id, serverId: server.id };
      },
      async user(localPart) {
        const user = await prisma.user.create({
          data: { displayName: `Membership ${localPart}`, email: `${localPart}@${domain}`, status: "active" }
        });
        return user.id;
      },
      value: (name) => `${name}-${id}`
    });
  } finally {
    await prisma.mcpRuntimeGeneration.deleteMany({ where: { revision: { serverId: { in: serverIds } } } });
    await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
    await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }
}

function byGroupId(left: { groupId: string }, right: { groupId: string }): number {
  return left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0;
}

async function membershipsOf(userId: string) {
  const memberships = await prisma.userGroup.findMany({ select: { groupId: true, role: true }, where: { userId } });
  return memberships.sort(byGroupId);
}

function sync(input: { source: "ldap" | "oidc"; userId: string; values: string[] | null }) {
  return prisma.$transaction((tx) => syncExternalGroups(tx, input));
}

describe("external group membership sync", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("adds and removes only the groups the source manages, and a missing claim changes nothing", async () => {
    await withMembershipData(async (fixture) => {
      const engineeringValue = fixture.value("/engineering");
      const engineering = await fixture.group("engineering", { names: [{ source: "oidc", value: engineeringValue }] });
      const stale = await fixture.group("stale", { names: [{ source: "oidc", value: fixture.value("/stale") }] });
      const manual = await fixture.group("manual");
      const directory = await fixture.group("directory", { names: [{ source: "ldap", value: engineeringValue }] });
      const archived = await fixture.group("archived", {
        archived: true,
        names: [{ source: "oidc", value: engineeringValue }]
      });
      const userId = await fixture.user("synced");
      await prisma.userGroup.createMany({
        data: [
          { groupId: stale, role: "member", userId },
          { groupId: manual, role: "owner", userId },
          { groupId: directory, role: "member", userId }
        ]
      });
      const expected = [
        { groupId: directory, role: "member" },
        { groupId: engineering, role: "member" },
        { groupId: manual, role: "owner" }
      ].sort(byGroupId);

      await expect(sync({ source: "oidc", userId, values: [engineeringValue, fixture.value("/unmapped")] }))
        .resolves.toEqual({ added: 1, removed: 1 });
      await expect(membershipsOf(userId)).resolves.toEqual(expected);
      await expect(sync({ source: "oidc", userId, values: null }))
        .resolves.toEqual({ added: 0, removed: 0, warning: "groups_claim_missing" });
      await expect(sync({ source: "oidc", userId, values: [engineeringValue] })).resolves.toEqual({ added: 0, removed: 0 });
      await expect(membershipsOf(userId)).resolves.toEqual(expected);
      await expect(prisma.group.count({ where: { id: archived, users: { some: { userId } } } })).resolves.toBe(0);
    });
  });

  it("applies exactly the administrator path's MCP side effects", async () => {
    await withMembershipData(async (fixture) => {
      const leaving = await fixture.group("leaving", { names: [{ source: "oidc", value: fixture.value("leaving") }] });
      const joining = await fixture.group("joining", { names: [{ source: "oidc", value: fixture.value("joining") }] });
      const lostServer = await fixture.mcpServer("lost", leaving);
      const gainedServer = await fixture.mcpServer("gained", joining);
      const syncedUser = await fixture.user("synced");
      const administeredUser = await fixture.user("administered");
      const preferences = async (userId: string) => {
        await prisma.userGroup.create({ data: { groupId: leaving, userId } });
        for (const server of [lostServer, gainedServer]) {
          await fixture.mcpPreference(server, userId);
        }
      };
      const runtimeState = async (userId: string) => (await prisma.mcpUserServer.findMany({
        select: { desiredRuntimeGenerationId: true, enabled: true, serverId: true },
        where: { userId }
      })).sort((left, right) => left.serverId.localeCompare(right.serverId));
      await preferences(syncedUser);
      await preferences(administeredUser);

      await expect(sync({ source: "oidc", userId: syncedUser, values: [fixture.value("joining")] }))
        .resolves.toEqual({ added: 1, removed: 1 });
      await expect(createPrismaAdminRepository(prisma).setUserGroups({
        expectedGroupIds: [leaving],
        groupIds: [joining],
        userId: administeredUser
      })).resolves.toBe("applied");

      const expected = [
        { desiredRuntimeGenerationId: null, enabled: false, serverId: lostServer.serverId },
        { desiredRuntimeGenerationId: null, enabled: true, serverId: gainedServer.serverId }
      ].sort((left, right) => left.serverId.localeCompare(right.serverId));
      await expect(runtimeState(syncedUser)).resolves.toEqual(expected);
      await expect(runtimeState(administeredUser)).resolves.toEqual(expected);
      await expect(membershipsOf(syncedUser)).resolves.toEqual([{ groupId: joining, role: "member" }]);
      await expect(membershipsOf(administeredUser)).resolves.toEqual([{ groupId: joining, role: "member" }]);
    });
  });
});
