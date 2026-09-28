import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { prisma } from "../prisma";
import { accessibleKnowledgeResources, loadUserAccessibleMcpServerIdsWith, usableSkillIds } from "./prismaRepository";
import { loadPersonalAssistantRowInputs, personalAssistantRowDefaults } from "./rowContext";

type Selection = Readonly<{ baseIds: readonly string[]; sourceIds: readonly string[] }>;

/**
 * The Knowledge access read as it was before it was narrowed to the selected
 * ids: every base the user can access first, then the selected Sources that
 * belong to one of them.
 */
async function unfilteredKnowledgeAccess(userId: string, selection: Selection) {
  if (selection.baseIds.length + selection.sourceIds.length === 0) return { baseIds: [], sourceIds: [] };
  const groupIds = (await prisma.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId }
  })).map((membership) => membership.groupId);
  const accessible = await prisma.knowledgeBase.findMany({
    select: { id: true },
    where: {
      archivedAt: null,
      deletionRequestedAt: null,
      trashedAt: null,
      OR: [
        { ownerUserId: userId },
        {
          publications: {
            some: {
              OR: [
                { scope: "installation" },
                ...(groupIds.length > 0
                  ? [{ group: { archivedAt: null }, groupId: { in: groupIds }, scope: "group" as const }]
                  : [])
              ]
            }
          }
        }
      ]
    }
  });
  const accessibleIds = new Set(accessible.map(({ id }) => id));
  const baseIds = selection.baseIds.filter((id) => accessibleIds.has(id));
  if (selection.sourceIds.length === 0) return { baseIds, sourceIds: [] };
  const sources = await prisma.knowledgeSource.findMany({
    select: { id: true },
    where: {
      deletionRequestedAt: null,
      id: { in: [...selection.sourceIds] },
      OR: [
        { ownerUserId: userId },
        { baseMemberships: { some: { knowledgeBaseId: { in: [...accessibleIds] }, removedAt: null } } }
      ],
      trashedAt: null
    }
  });
  const sourceIds = new Set(sources.map(({ id }) => id));
  return { baseIds, sourceIds: selection.sourceIds.filter((id) => sourceIds.has(id)) };
}

type AccessFixture = Readonly<{
  bases: Readonly<Record<
    "archived" | "deleting" | "everyone" | "foreign" | "own" | "private" | "retired" | "team" | "trashed",
    string
  >>;
  mcpServers: Readonly<Record<"retired" | "team" | "user", string>>;
  searchStrategies: Readonly<{ retired: string; team: string }>;
  sources: Readonly<Record<
    "deleting" | "everyone" | "inTrashedBase" | "own" | "private" | "removed" | "retired" | "team" | "trashed",
    string
  >>;
  viewerId: string;
}>;

async function withAccessFixture<T>(run: (fixture: AccessFixture) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const viewerId = `row-context-viewer-${suffix}`;
  const authorId = `row-context-author-${suffix}`;
  const groupIds: string[] = [];
  const baseIds: string[] = [];
  const sourceIds: string[] = [];
  const mcpServerIds: string[] = [];
  await prisma.user.create({
    data: {
      displayName: "Row context viewer",
      id: viewerId,
      settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel } },
      status: "active"
    }
  });
  await prisma.user.create({ data: { displayName: "Row context author", id: authorId, status: "active" } });
  try {
    const group = async (name: string, archived: boolean, member: boolean) => {
      const created = await prisma.group.create({
        data: { archivedAt: archived ? new Date() : null, name: `Row context ${name} ${suffix}` }
      });
      groupIds.push(created.id);
      if (member) await prisma.userGroup.create({ data: { groupId: created.id, userId: viewerId } });
      return created.id;
    };
    // Memberships of the archived group are created before it is archived in real use; the row is the same.
    const team = await group("team", false, true);
    const retired = await group("retired", true, true);
    const foreign = await group("foreign", false, false);
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

    const base = async (
      name: string,
      extra: Readonly<{
        archivedAt?: Date;
        deletionRequestedAt?: Date;
        ownerUserId?: string;
        publication?: "installation" | { groupId: string };
        trashedAt?: Date;
      }> = {}
    ) => {
      const ownerUserId = extra.ownerUserId ?? authorId;
      const created = await prisma.knowledgeBase.create({
        data: {
          archivedAt: extra.archivedAt ?? null,
          deletionRequestedAt: extra.deletionRequestedAt ?? null,
          name: `Row context ${name}`,
          ownerUserId,
          trashedAt: extra.trashedAt ?? null
        }
      });
      baseIds.push(created.id);
      if (extra.publication) {
        await prisma.knowledgeBasePublication.create({
          data: extra.publication === "installation"
            ? { knowledgeBaseId: created.id, publishedByUserId: ownerUserId, scope: "installation" }
            : { groupId: extra.publication.groupId, knowledgeBaseId: created.id, publishedByUserId: ownerUserId, scope: "group" }
        });
      }
      return created.id;
    };
    const bases = {
      archived: await base("archived", { archivedAt: new Date(), publication: "installation" }),
      // Deletion is requested only for trashed Knowledge (KnowledgeBase_deletion_lifecycle_check).
      deleting: await base("deleting", { deletionRequestedAt: new Date(), publication: "installation", trashedAt: new Date() }),
      everyone: await base("everyone", { publication: "installation" }),
      foreign: await base("foreign", { publication: { groupId: foreign } }),
      own: await base("own", { ownerUserId: viewerId }),
      private: await base("private"),
      retired: await base("retired", { publication: { groupId: retired } }),
      team: await base("team", { publication: { groupId: team } }),
      trashed: await base("trashed", { publication: "installation", trashedAt: new Date() })
    };

    const source = async (
      name: string,
      extra: Readonly<{
        bases?: readonly string[];
        deletionRequestedAt?: Date;
        ownerUserId?: string;
        removed?: boolean;
        trashedAt?: Date;
      }> = {}
    ) => {
      const ownerUserId = extra.ownerUserId ?? authorId;
      const created = await prisma.knowledgeSource.create({
        data: {
          deletionRequestedAt: extra.deletionRequestedAt ?? null,
          name: `Row context ${name}`,
          ownerUserId,
          trashedAt: extra.trashedAt ?? null
        }
      });
      sourceIds.push(created.id);
      for (const knowledgeBaseId of extra.bases ?? []) {
        await prisma.knowledgeBaseSource.create({
          data: { knowledgeBaseId, ownerUserId, removedAt: extra.removed ? new Date() : null, sourceId: created.id }
        });
      }
      return created.id;
    };
    const sources = {
      deleting: await source("deleting", { bases: [bases.everyone], deletionRequestedAt: new Date(), trashedAt: new Date() }),
      everyone: await source("everyone", { bases: [bases.everyone, bases.private] }),
      inTrashedBase: await source("in trashed base", { bases: [bases.trashed] }),
      own: await source("own", { ownerUserId: viewerId }),
      private: await source("private", { bases: [bases.private] }),
      removed: await source("removed", { bases: [bases.everyone], removed: true }),
      retired: await source("retired", { bases: [bases.retired] }),
      team: await source("team", { bases: [bases.team] }),
      trashed: await source("trashed", { bases: [bases.everyone], trashedAt: new Date() })
    };
    return await run({ bases, mcpServers, searchStrategies, sources, viewerId });
  } finally {
    await prisma.mcpRevision.deleteMany({ where: { serverId: { in: mcpServerIds } } });
    await prisma.mcpServer.deleteMany({ where: { id: { in: mcpServerIds } } });
    // Base memberships are history; only the purge setting lets them be deleted.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
      await tx.knowledgeBaseSource.deleteMany({ where: { sourceId: { in: sourceIds } } });
      await tx.knowledgeSource.deleteMany({ where: { id: { in: sourceIds } } });
      await tx.knowledgeBasePublication.deleteMany({ where: { knowledgeBaseId: { in: baseIds } } });
      await tx.knowledgeBase.deleteMany({ where: { id: { in: baseIds } } });
    });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [viewerId, authorId] } } });
  }
}

describe("Assistant row context reads", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads only the selected Knowledge and answers what the unfiltered read answered", async () => {
    await withAccessFixture(async ({ bases, sources, viewerId }) => {
      const allBases = Object.values(bases);
      const allSources = Object.values(sources);
      const selections: Selection[] = [
        { baseIds: allBases, sourceIds: allSources },
        { baseIds: allBases, sourceIds: [] },
        { baseIds: [], sourceIds: allSources },
        { baseIds: [bases.team, bases.retired, randomUUID()], sourceIds: [sources.team, sources.retired, randomUUID()] },
        // A Source counts through any accessible base, whichever bases the selection names.
        { baseIds: [bases.private], sourceIds: [sources.everyone, sources.private] },
        { baseIds: [bases.own, bases.own], sourceIds: [sources.own] },
        { baseIds: [], sourceIds: [] }
      ];
      const activeGroupIds = (await prisma.userGroup.findMany({
        select: { groupId: true },
        where: { group: { archivedAt: null }, userId: viewerId }
      })).map((membership) => membership.groupId);
      for (const selection of selections) {
        const expected = await unfilteredKnowledgeAccess(viewerId, selection);
        await expect(accessibleKnowledgeResources(prisma, viewerId, selection)).resolves.toEqual(expected);
        await expect(accessibleKnowledgeResources(prisma, viewerId, selection, { activeGroupIds })).resolves.toEqual(expected);
      }
      await expect(accessibleKnowledgeResources(prisma, viewerId, { baseIds: allBases, sourceIds: allSources })).resolves.toEqual({
        baseIds: [bases.everyone, bases.own, bases.team],
        sourceIds: [sources.everyone, sources.own, sources.team]
      });
    });
  });

  it("reads the groups once and loads what the separate readers load", async () => {
    await withAccessFixture(async ({ bases, mcpServers, searchStrategies, sources, viewerId }) => {
      const ids = {
        knowledgeBaseIds: [bases.team, bases.retired, bases.own, bases.team],
        knowledgeSourceIds: [sources.team, sources.retired, sources.deleting],
        skillIds: [randomUUID()]
      };
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

      const knowledge = await unfilteredKnowledgeAccess(viewerId, {
        baseIds: [...new Set(ids.knowledgeBaseIds)],
        sourceIds: ids.knowledgeSourceIds
      });
      expect(inputs.context.available).toEqual({
        allMyKnowledge: true,
        knowledgeBaseIds: new Set(knowledge.baseIds),
        knowledgeSourceIds: new Set(knowledge.sourceIds),
        mcpServerIds: await loadUserAccessibleMcpServerIdsWith(prisma, viewerId),
        modelIds: personalAssistantRowDefaults(separate).modelIds,
        searchOptionIds: personalAssistantRowDefaults(separate).searchOptionIds,
        skillIds: await usableSkillIds(prisma, viewerId, ids.skillIds)
      });
      expect([...inputs.context.available.mcpServerIds].filter((id) => Object.values(mcpServers).includes(id)).sort())
        .toEqual([mcpServers.team, mcpServers.user].sort());
      expect(inputs.context.available.knowledgeBaseIds).toEqual(new Set([bases.team, bases.own]));
      expect(inputs.context.available.knowledgeSourceIds).toEqual(new Set([sources.team]));
      const { controlsForModel: _controls, ...defaults } = inputs.context.defaults;
      const { controlsForModel: _separateControls, ...separateDefaults } = personalAssistantRowDefaults(separate).defaults;
      expect(defaults).toEqual(separateDefaults);
    });
  });
});
