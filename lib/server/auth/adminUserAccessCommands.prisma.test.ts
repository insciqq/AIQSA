import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { listAdminDashboard } from "./adminDashboardQueries";
import { createAdminGroupGrantCommands } from "./adminGroupGrantCommands";
import { createAdminUserAccessCommands } from "./adminUserAccessCommands";

async function withAccessData(run: (data: {
  connectionId: string; credentialId: string; groupId: string; modelId: string; searchId: string; userId: string;
}) => Promise<void>) {
  const marker = randomUUID();
  const userId = `access-user-${marker}`;
  const groupId = `access-group-${marker}`;
  const connectionId = `access-provider-${marker}`;
  const credentialId = `access-key-${marker}`;
  const modelId = `access-model-${marker}`;
  const searchId = `access-search-${marker}`;
  const now = new Date();
  try {
    await prisma.user.create({ data: { displayName: "Access test user", email: `${marker}@access.example.test`, id: userId, status: "active" } });
    await prisma.group.create({ data: { id: groupId, name: `Access test ${marker}` } });
    await prisma.userGroup.create({ data: { groupId, role: "member", userId } });
    await prisma.providerConnection.create({ data: { activatedAt: now, activeConfig: {}, activeVersion: 1, displayName: "Access provider", enabled: true, family: "fake", id: connectionId } });
    await prisma.providerModel.create({ data: { activatedAt: now, activeConfig: { answerSelectable: true }, activeVersion: 1, capabilities: {}, connectionId, defaultParams: {}, displayName: "Access model", id: modelId, modelId: "upstream", provider: "fake" } });
    await prisma.searchOption.create({ data: { description: "Access fixture", displayName: "Access Search", kind: "web_search", optionId: searchId, sourceConnectionId: connectionId } });
    await prisma.providerCredential.create({ data: { connectionId, enabled: true, id: credentialId, label: "Access key" } });
    const version = await prisma.providerCredentialVersion.create({ data: { activatedAt: now, credentialId, secretEnvelope: "synthetic-not-dispatched", testEvidence: {}, testedAt: now, version: 1 } });
    await prisma.providerCredential.update({ data: { activatedAt: now, activeVersionId: version.id }, where: { id: credentialId } });
    await run({ connectionId, credentialId, groupId, modelId, searchId, userId });
  } finally {
    await prisma.providerUserCredentialAssignment.deleteMany({ where: { userId } });
    await prisma.providerGroupCredentialAssignment.deleteMany({ where: { groupId } });
    await prisma.accessGrant.deleteMany({ where: { OR: [{ userId }, { groupId }] } });
    await prisma.providerCredential.updateMany({ data: { activeVersionId: null }, where: { id: credentialId } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
    await prisma.providerModel.deleteMany({ where: { id: modelId } });
    await prisma.searchOption.deleteMany({ where: { optionId: searchId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.group.deleteMany({ where: { id: groupId } });
  }
}

describe("Prisma direct user access", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("projects exact direct grants and lets both principals remove disabled models and archived Search sources independently", async () => {
    await withAccessData(async ({ connectionId, groupId, modelId, searchId, userId }) => {
      await prisma.accessGrant.createMany({ data: [
        { groupId, providerModelId: modelId }, { groupId, searchStrategy: searchId },
        { enabled: false, providerModelId: modelId, userId }, { searchStrategy: searchId, userId }
      ] });
      await prisma.providerConnection.update({ data: { enabled: false }, where: { id: connectionId } });
      await prisma.providerModel.update({ data: { enabled: false }, where: { id: modelId } });
      await prisma.searchOption.update({ data: { archivedAt: new Date(), enabled: false }, where: { optionId: searchId } });
      const dashboard = await listAdminDashboard(prisma, { actingAdminUserId: userId });
      const direct = dashboard.users.find((user) => user.id === userId)!.directGrants;
      expect(direct).toHaveLength(2);
      expect(direct).toEqual(expect.arrayContaining([
        expect.objectContaining({ enabled: false, groupId: null, modelId, resourceDisplayName: "Access provider / Access model", userId }),
        expect.objectContaining({ groupId: null, resourceDisplayName: "Access Search", searchStrategy: searchId, userId })
      ]));
      expect(dashboard.catalog.models.some((model) => model.modelId === modelId)).toBe(false);
      expect(dashboard.catalog.searchStrategies.some((source) => source.strategyId === searchId)).toBe(false);
      const changes = [{ enabled: false, modelId, provider: connectionId }, { enabled: false, searchStrategy: searchId }];
      await expect(createAdminUserAccessCommands(prisma).setUserGrants({ changes, expectedGrantIds: direct.map(({ id }) => id), userId })).resolves.toBe("applied");
      expect(await prisma.accessGrant.count({ where: { userId } })).toBe(0);
      expect(await prisma.accessGrant.count({ where: { groupId } })).toBe(2);
      await expect(createAdminGroupGrantCommands(prisma).setGroupGrants({ changes, groupId })).resolves.toEqual({ kind: "applied" });
      expect(await prisma.accessGrant.count({ where: { groupId } })).toBe(0);
    });
  });

  it("rolls back invalid grant batches and permits only one save from the same direct-grant snapshot", async () => {
    await withAccessData(async ({ connectionId, groupId, modelId, searchId, userId }) => {
      const direct = await prisma.accessGrant.create({ data: { providerModelId: modelId, userId } });
      const inherited = await prisma.accessGrant.create({ data: { groupId, providerModelId: modelId } });
      const commands = createAdminUserAccessCommands(prisma);
      await expect(commands.setUserGrants({
        changes: [{ enabled: false, modelId, provider: connectionId }, { enabled: true, provider: "missing-provider" }],
        expectedGrantIds: [direct.id], userId
      })).resolves.toBe("user_grant_invalid");
      expect(await prisma.accessGrant.findUnique({ where: { id: direct.id } })).not.toBeNull();
      const results = await Promise.all([
        commands.setUserGrants({ changes: [{ enabled: true, provider: connectionId }], expectedGrantIds: [direct.id], userId }),
        commands.setUserGrants({ changes: [{ enabled: true, searchStrategy: searchId }], expectedGrantIds: [direct.id], userId })
      ]);
      expect(results.sort()).toEqual(["applied", "user_access_stale"]);
      expect(await prisma.accessGrant.count({ where: { userId } })).toBe(2);
      expect(await prisma.accessGrant.findUnique({ where: { id: inherited.id } })).toMatchObject({ enabled: true, groupId });
    });
  });

  it("assigns usable keys, rejects stale or disabled replacement and removes only the direct override", async () => {
    await withAccessData(async ({ connectionId, credentialId, groupId, userId }) => {
      await prisma.providerGroupCredentialAssignment.create({ data: { connectionId, credentialId, groupId } });
      const commands = createAdminUserAccessCommands(prisma);
      const initial = { connectionId, credentialId, expectedCredentialId: null, expectedUpdatedAt: null, userId };
      await expect(commands.setUserCredential(initial)).resolves.toBe("applied");
      const assignment = await prisma.providerUserCredentialAssignment.findUniqueOrThrow({ where: { connectionId_userId: { connectionId, userId } } });
      await expect(commands.setUserCredential({ ...initial, credentialId: null })).resolves.toBe("user_access_stale");
      const baseline = { expectedCredentialId: credentialId, expectedUpdatedAt: assignment.updatedAt.toISOString() };
      await prisma.providerCredential.update({ data: { enabled: false }, where: { id: credentialId } });
      await expect(commands.setUserCredential({ ...initial, ...baseline })).resolves.toBe("user_credential_invalid");
      await prisma.user.update({ data: { status: "disabled" }, where: { id: userId } });
      await expect(commands.setUserCredential({ ...initial, ...baseline, credentialId: null })).resolves.toBe("applied");
      expect(await prisma.providerUserCredentialAssignment.count({ where: { userId } })).toBe(0);
      expect(await prisma.providerGroupCredentialAssignment.count({ where: { groupId } })).toBe(1);
    });
  });

  it("allows only one membership replacement from the same snapshot and preserves the unchanged owner row", async () => {
    await withAccessData(async ({ groupId, userId }) => {
      const extraIds = [randomUUID(), randomUUID()];
      try {
        await prisma.group.createMany({ data: extraIds.map((id) => ({ id, name: `Membership test ${id}` })) });
        await prisma.userGroup.update({ data: { role: "owner" }, where: { userId_groupId: { groupId, userId } } });
        const commands = createAdminGroupGrantCommands(prisma);
        const results = await Promise.all(extraIds.map((id) => commands.setUserGroups({
          expectedGroupIds: [groupId], groupIds: [groupId, id], userId
        })));
        expect(results.sort()).toEqual(["applied", "user_access_stale"]);
        const memberships = await prisma.userGroup.findMany({ orderBy: { groupId: "asc" }, select: { groupId: true, role: true }, where: { userId } });
        expect(memberships).toHaveLength(2);
        expect(memberships).toContainEqual({ groupId, role: "owner" });
        await expect(commands.setUserGroups({ expectedGroupIds: [groupId], groupIds: [], userId })).resolves.toBe("user_access_stale");
        expect(await prisma.userGroup.findMany({ orderBy: { groupId: "asc" }, select: { groupId: true, role: true }, where: { userId } })).toEqual(memberships);
      } finally {
        await prisma.group.deleteMany({ where: { id: { in: extraIds } } });
      }
    });
  });
});
