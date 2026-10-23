import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { prisma } from "../prisma";
import { loadUserAccessibleMcpServerIdsWith, usableSkillIds } from "./prismaRepository";
import { loadPersonalAssistantRowInputs, personalAssistantRowDefaults } from "./rowContext";

type AccessFixture = Readonly<{
  mcpServers: Readonly<Record<"retired" | "team" | "user", string>>;
  searchStrategies: Readonly<{ retired: string; team: string }>;
  viewerId: string;
}>;

async function withAccessFixture<T>(run: (fixture: AccessFixture) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const viewerId = `row-context-viewer-${suffix}`;
  const groupIds: string[] = [];
  const mcpServerIds: string[] = [];
  await prisma.user.create({
    data: {
      displayName: "Row context viewer",
      id: viewerId,
      settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel } },
      status: "active"
    }
  });
  try {
    const group = async (name: string, archived: boolean) => {
      const created = await prisma.group.create({
        data: { archivedAt: archived ? new Date() : null, name: `Row context ${name} ${suffix}` }
      });
      groupIds.push(created.id);
      await prisma.userGroup.create({ data: { groupId: created.id, userId: viewerId } });
      return created.id;
    };
    // Memberships of the archived group are created before it is archived in real use; the row is the same.
    const team = await group("team", false);
    const retired = await group("retired", true);
    const searchStrategies = { retired: `row-context-retired-${suffix}`, team: `row-context-team-${suffix}` };
    await prisma.accessGrant.createMany({ data: [
      { groupId: team, searchStrategy: searchStrategies.team },
      { groupId: retired, searchStrategy: searchStrategies.retired }
    ] });

    // Usable MCP servers granted to the viewer, to their group and to their archived group.
    const mcpServer = async (name: string, grant: { groupId: string } | { userId: string }) => {
      const server = await prisma.mcpServer.create({
        data: { displayName: `Row context ${name}`, enabled: true, namespace: `rowctx_${name}_${suffix.replaceAll("-", "")}` }
      });
      mcpServerIds.push(server.id);
      const revision = await prisma.mcpRevision.create({ data: {
        configuration: { disabledToolNames: [] },
        draftHash: "a".repeat(64),
        identityHash: "b".repeat(64),
        revisionNumber: 1,
        serverId: server.id,
        validationEvidence: {}
      } });
      await prisma.mcpServer.update({ data: { activeRevisionId: revision.id }, where: { id: server.id } });
      await prisma.mcpGrant.create({ data: { canUse: true, serverId: server.id, ...grant } });
      return server.id;
    };
    const mcpServers = {
      retired: await mcpServer("retired", { groupId: retired }),
      team: await mcpServer("team", { groupId: team }),
      user: await mcpServer("user", { userId: viewerId })
    };
    return await run({ mcpServers, searchStrategies, viewerId });
  } finally {
    await prisma.mcpRevision.deleteMany({ where: { serverId: { in: mcpServerIds } } });
    await prisma.mcpServer.deleteMany({ where: { id: { in: mcpServerIds } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.user.deleteMany({ where: { id: viewerId } });
  }
}

describe("Assistant row context reads", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads the groups once and loads what the separate readers load", async () => {
    await withAccessFixture(async ({ mcpServers, searchStrategies, viewerId }) => {
      const ids = { skillIds: [randomUUID()] };
      const inputs = await loadPersonalAssistantRowInputs(prisma, { ids, userId: viewerId });
      if (!inputs) throw new Error("expected row inputs");

      const separate = await createPrismaCatalogDataLoader({
        loadEntitlements: (userId) => loadEntitlementsForUser(userId, prisma),
        prisma
      })(viewerId);
      if (!separate) throw new Error("expected catalog data");
      // The chain leaves the saved default Assistant unchecked.
      const { defaultAssistantAvailable: _unchecked, ...settings } = separate.settings;
      expect(inputs.data).toEqual({ ...separate, settings });
      expect(inputs.data.entitlements.searchStrategies).toEqual(new Set([searchStrategies.team]));

      expect(inputs.context.available).toEqual({
        mcpServerIds: await loadUserAccessibleMcpServerIdsWith(prisma, viewerId),
        modelIds: personalAssistantRowDefaults(separate).modelIds,
        searchOptionIds: personalAssistantRowDefaults(separate).searchOptionIds,
        skillIds: await usableSkillIds(prisma, viewerId, ids.skillIds)
      });
      expect([...inputs.context.available.mcpServerIds].filter((id) => Object.values(mcpServers).includes(id)).sort())
        .toEqual([mcpServers.team, mcpServers.user].sort());
      const { controlsForModel: _controls, ...defaults } = inputs.context.defaults;
      const { controlsForModel: _separateControls, ...separateDefaults } = personalAssistantRowDefaults(separate).defaults;
      expect(defaults).toEqual(separateDefaults);
    });
  });
});
