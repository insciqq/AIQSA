import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeAssistantAvatarRecipe,
  decodeAssistantRunControls,
  type AssistantDraft
} from "../../contracts/assistants";
import {
  decodeKnowledgePlan,
  type KnowledgeSelection
} from "../../contracts/knowledge";
import { decodeSearchPlan } from "../../contracts/search";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import {
  isMcpRunPlanRecordRunnable,
  projectMcpRunPlanStartability
} from "../mcp/runPlan";
import {
  loadMcpRunPlanRecords,
  loadMcpRunPlanRecordsForServers
} from "../mcp/runPlanRepository";
import { lockMemorySettings } from "../memory/persistence/transaction";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  applyMemoryScopedTargetOwnerLifecycle,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { prisma } from "../prisma";
import { revokeOwnedProjectResourcePublication } from "../projects/prismaRepository";
import {
  validateAssistantConfigurationAgainstCatalog,
  type AssistantCatalogView
} from "./catalogValidation";
import type {
  AssistantRunMaterialization,
  AssistantRunResolution,
  AssistantRunResolver
} from "./runMaterialization";

export type AssistantContentRow = {
  avatar: unknown;
  category: string | null;
  description: string;
  developerPrompt: string | null;
  id: string;
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  name: string;
  providerModelId: string;
  runControls: unknown;
  searchPlan: unknown;
  skillSummaries?: { id: string; name: string }[];
  skillIds: string[];
  starterPrompts: string[];
  systemPrompt: string;
};

export type AssistantPublicationRow = {
  groupId: string | null;
  groupName: string | null;
  id: string;
  scope: "group" | "installation" | "project";
  updatedAt: Date;
};

export type AssistantAccessEntry = {
  archived: boolean;
  id: string;
  installationScope: boolean;
  memberGroupNames: string[];
  owned: boolean;
  ownerDisplayName: string;
  pinned: boolean;
  published: boolean;
  /** One complete live definition for future admission. */
  content: AssistantContentRow;
  updatedAt: Date;
  version: number;
};

export type AssistantDetailData = AssistantAccessEntry & {
  publications: AssistantPublicationRow[] | null;
};

export type AssistantWriteResult =
  | { assistantId: string; kind: "ok" }
  | { kind: "archived" }
  | { kind: "not_found" }
  | { kind: "skills_not_available" }
  | { kind: "skill_audience_mismatch" }
  | { kind: "version_conflict" };

export type AssistantCreateResult =
  | { assistantId: string; kind: "ok" }
  | { kind: "skills_not_available" };

export type AssistantPublishInput = {
  actorIsAdmin: boolean;
  assistantId: string;
  groupId: string | null;
  scope: "group" | "installation";
  userId: string;
};

export type AssistantPublishResult =
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "skill_audience_mismatch" }
  | { kind: "ok"; publication: AssistantPublicationRow };

export type AssistantDuplicateResult =
  | { assistantId: string; kind: "ok" }
  | { kind: "knowledge_not_available" }
  | { kind: "model_not_available" }
  | { kind: "not_found" }
  | { kind: "run_controls_invalid" }
  | { kind: "search_not_available" }
  | { kind: "skills_not_available" }
  | { kind: "tools_not_available" };

const contentSelect = {
  avatar: true,
  category: true,
  description: true,
  developerPrompt: true,
  id: true,
  knowledgeSelection: true,
  mcpServerIds: true,
  name: true,
  providerModelId: true,
  runControls: true,
  searchPlan: true,
  skillLinks: {
    orderBy: { ordinal: "asc" },
    select: {
      skill: { select: { currentRevision: { select: { name: true } } } },
      skillId: true
    }
  },
  starterPrompts: true,
  systemPrompt: true
} satisfies Prisma.AssistantDefinitionSelect;

type ContentRecord = Prisma.AssistantDefinitionGetPayload<{ select: typeof contentSelect }>;

function contentRow(record: ContentRecord): AssistantContentRow {
  const knowledge = decodeKnowledgePlan(record.knowledgeSelection);
  if (!knowledge.ok || knowledge.plan.mode === "all_my_knowledge" ||
    knowledge.plan.mode === "inherited") {
    throw new Error("assistant_definition_integrity_invalid");
  }
  return {
    avatar: record.avatar,
    category: record.category,
    description: record.description,
    developerPrompt: record.developerPrompt,
    id: record.id,
    knowledgeSelection: knowledge.plan,
    mcpServerIds: [...record.mcpServerIds],
    name: record.name,
    providerModelId: record.providerModelId,
    runControls: record.runControls,
    searchPlan: record.searchPlan,
    skillSummaries: record.skillLinks.flatMap((link) =>
      link.skill.currentRevision
        ? [{ id: link.skillId, name: link.skill.currentRevision.name }]
        : []
    ),
    skillIds: record.skillLinks.map((link) => link.skillId),
    starterPrompts: [...record.starterPrompts],
    systemPrompt: record.systemPrompt
  };
}

function publicationRow(record: {
  group: { name: string } | null;
  groupId: string | null;
  id: string;
  scope: "group" | "installation";
  updatedAt: Date;
}): AssistantPublicationRow {
  return {
    groupId: record.groupId,
    groupName: record.group?.name ?? null,
    id: record.id,
    scope: record.scope,
    updatedAt: record.updatedAt
  };
}

function contentDraftData(draft: AssistantDraft): Omit<
  Prisma.AssistantDefinitionUncheckedCreateInput, "ownerUserId"
> {
  return {
    avatar: draft.avatar as unknown as Prisma.InputJsonValue,
    category: draft.category,
    description: draft.description,
    developerPrompt: draft.developerPrompt,
    knowledgeSelection: draft.knowledgeSelection as unknown as Prisma.InputJsonValue,
    mcpServerIds: [...draft.mcpServerIds],
    name: draft.name,
    providerModelId: draft.providerModelId,
    runControls: draft.runControls as Prisma.InputJsonValue,
    searchPlan: {
      mode: draft.searchPlan.mode,
      optionIds: [...draft.searchPlan.optionIds]
    } as Prisma.InputJsonValue,
    starterPrompts: [...draft.starterPrompts],
    systemPrompt: draft.systemPrompt
  };
}

async function createAssistantSkillLinks(
  tx: Prisma.TransactionClient,
  assistantId: string,
  skillIds: readonly string[]
): Promise<void> {
  if (skillIds.length === 0) return;
  await tx.assistantSkill.createMany({
    data: skillIds.map((skillId, ordinal) => ({
      assistantId,
      ordinal,
      skillId
    }))
  });
}

async function activeMemberGroupIds(
  client: Pick<PrismaClient, "userGroup">,
  userId: string
): Promise<string[]> {
  const memberships = await client.userGroup.findMany({
    select: { groupId: true },
    where: { group: { archivedAt: null }, userId }
  });
  return memberships.map((membership) => membership.groupId);
}

type AssistantReadClient = Pick<
  PrismaClient,
  "assistantDefinition" | "assistantPin" | "userGroup"
>;

type AssistantMcpAccessClient = Pick<PrismaClient, "mcpGrant" | "userGroup">;

async function loadUserAccessibleMcpServerIdsWith(
  readClient: AssistantMcpAccessClient,
  userId: string
): Promise<Set<string>> {
  const memberGroupIds = await activeMemberGroupIds(readClient, userId);
  const grants = await readClient.mcpGrant.findMany({
    select: { serverId: true },
    where: {
      canUse: true,
      server: { archivedAt: null, enabled: true, activeRevisionId: { not: null } },
      OR: [
        { userId },
        ...(memberGroupIds.length > 0 ? [{ groupId: { in: memberGroupIds } }] : [])
      ]
    }
  });
  return new Set(grants.map((grant) => grant.serverId));
}

function isPrismaSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" &&
        typeof error.meta === "object" &&
        error.meta !== null &&
        (error.meta.code === "40001" || error.meta.code === "40P01")));
}

export type PrismaAssistantRepositoryOptions = {
  isMcpGenerationLive?(generationId: string): boolean;
  loadUserMcpServers?(
    userId: string
  ): Promise<readonly Readonly<{
    enabled: boolean;
    errorCode: string | null;
    id: string;
    readiness: import("../../contracts/mcp").McpReadiness;
  }>[]>;
  loadCatalogView?(
    tx: Prisma.TransactionClient,
    userId: string
  ): Promise<AssistantCatalogView | null>;
  memorySourceHooks?: MemorySourceMutationHooks;
  now?(): Date;
};

async function lockAssistantPublicationRows(
  tx: Prisma.TransactionClient,
  assistantId: string
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT publication."id"
    FROM "AssistantPublication" AS publication
    WHERE publication."assistantId" = ${assistantId}
    ORDER BY publication."id"
    FOR UPDATE OF publication
  `;
}

async function lockAssistantPublicationRowsForDuplicate(
  tx: Prisma.TransactionClient,
  assistantId: string
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT publication."id"
    FROM "AssistantPublication" AS publication
    WHERE publication."assistantId" = ${assistantId}
    ORDER BY publication."id"
    FOR SHARE OF publication
  `;
}

async function lockActiveMemberGroupRows(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  // Knowledge publish takes its base before the authorizing group rows. Keep
  // duplication on that same order and use shared locks: writers serialize,
  // while independent readers and run admission remain compatible.
  await tx.$queryRaw<Array<{ groupId: string }>>`
    SELECT membership."groupId"
    FROM "UserGroup" AS membership
    INNER JOIN "Group" AS team ON team."id" = membership."groupId"
    WHERE membership."userId" = ${userId}
      AND team."archivedAt" IS NULL
    ORDER BY membership."groupId"
    FOR SHARE OF membership, team
  `;
}

function distinctSortedSkillIds(skillIds: readonly string[]): string[] {
  return [...new Set(skillIds)].sort((left, right) => left.localeCompare(right));
}

async function lockSkillDefinitionRows(
  tx: Prisma.TransactionClient,
  skillIds: readonly string[]
): Promise<boolean> {
  const ids = distinctSortedSkillIds(skillIds);
  if (ids.length === 0) return true;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT definition."id"
    FROM "SkillDefinition" AS definition
    WHERE definition."id" IN (${Prisma.join(ids)})
    ORDER BY definition."id"
    FOR SHARE OF definition
  `);
  return rows.length === ids.length;
}

async function skillDependenciesAvailable(
  tx: Prisma.TransactionClient,
  userId: string,
  skillIds: readonly string[]
): Promise<boolean> {
  const ids = distinctSortedSkillIds(skillIds);
  if (ids.length === 0) return true;
  const available = await tx.skillDefinition.count({
    where: {
      archivedAt: null,
      currentRevisionId: { not: null },
      deletedAt: null,
      id: { in: ids },
      OR: [
        { ownerUserId: userId },
        {
          publications: {
            some: {
              OR: [
                { scope: "installation" },
                {
                  group: {
                    archivedAt: null,
                    users: { some: { userId } }
                  },
                  scope: "group"
                }
              ]
            }
          }
        }
      ]
    }
  });
  return available === ids.length;
}

async function lockAndCheckSkillDependencies(
  tx: Prisma.TransactionClient,
  userId: string,
  skillIds: readonly string[]
): Promise<boolean> {
  if (!await lockSkillDefinitionRows(tx, skillIds)) return false;
  await lockActiveMemberGroupRows(tx, userId);
  return skillDependenciesAvailable(tx, userId, skillIds);
}

async function skillsReachPublicationAudience(
  tx: Prisma.TransactionClient,
  skillIds: readonly string[],
  audience: Readonly<{ groupId: string | null; scope: "group" | "installation" }>
): Promise<boolean> {
  const ids = distinctSortedSkillIds(skillIds);
  if (ids.length === 0) return true;
  if (!await lockSkillDefinitionRows(tx, ids)) return false;
  const available = await tx.skillDefinition.count({
    where: {
      archivedAt: null,
      currentRevisionId: { not: null },
      deletedAt: null,
      id: { in: ids },
      publications: {
        some: audience.scope === "installation"
          ? { scope: "installation" }
          : {
              OR: [
                { scope: "installation" },
                { groupId: audience.groupId, scope: "group" }
              ]
            }
      }
    }
  });
  return available === ids.length;
}

function distinctKnowledgeBaseIds(knowledgeBaseIds: readonly string[]): string[] {
  return [...new Set(knowledgeBaseIds)].sort((left, right) => left.localeCompare(right));
}

function distinctKnowledgeSourceIds(sourceIds: readonly string[]): string[] {
  return [...new Set(sourceIds)].sort((left, right) => left.localeCompare(right));
}

async function lockKnowledgeSourceRowsForDuplicate(
  tx: Prisma.TransactionClient,
  sourceIds: readonly string[]
): Promise<boolean> {
  if (sourceIds.length === 0) return true;
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT source."id"
    FROM "KnowledgeSource" AS source
    WHERE source."id" IN (${Prisma.join(sourceIds)})
    ORDER BY source."id"
    FOR SHARE OF source
  `);
  return locked.length === sourceIds.length;
}

async function lockKnowledgeBaseRowsForDuplicate(
  tx: Prisma.TransactionClient,
  knowledgeBaseIds: readonly string[]
): Promise<boolean> {
  if (knowledgeBaseIds.length === 0) return true;

  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT base."id"
    FROM "KnowledgeBase" AS base
    WHERE base."id" IN (${Prisma.join(knowledgeBaseIds)})
    ORDER BY base."id"
    FOR SHARE OF base
  `);
  return locked.length === knowledgeBaseIds.length;
}

async function lockKnowledgePublicationRowsForDuplicate(
  tx: Prisma.TransactionClient,
  knowledgeBaseIds: readonly string[]
): Promise<void> {
  if (knowledgeBaseIds.length === 0) return;

  // A revoke deletes only the child after locking its base. Locking the child
  // after bases and groups makes a revoke that won against this repeatable-read
  // snapshot surface as a serialization retry instead of stale authorization.
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT publication."id"
    FROM "KnowledgeBasePublication" AS publication
    WHERE publication."knowledgeBaseId" IN (${Prisma.join(knowledgeBaseIds)})
    ORDER BY publication."knowledgeBaseId", publication."id"
    FOR SHARE OF publication
  `);
}

async function allKnowledgeDependenciesAvailable(
  tx: Prisma.TransactionClient,
  userId: string,
  selection: KnowledgeSelection
): Promise<boolean> {
  const groupIds = await activeMemberGroupIds(tx, userId);
  const accessible = await tx.knowledgeBase.findMany({
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
                  ? [{
                      group: { archivedAt: null },
                      groupId: { in: groupIds },
                      scope: "group" as const
                    }]
                  : [])
              ]
            }
          }
        }
      ]
    }
  });
  const accessibleIds = new Set(accessible.map(({ id }) => id));
  if (selection.baseIds.some((id) => !accessibleIds.has(id))) return false;
  if (selection.sourceIds.length === 0) return true;
  const sources = await tx.knowledgeSource.findMany({
    select: { id: true },
    where: {
      deletionRequestedAt: null,
      id: { in: [...selection.sourceIds] },
      OR: [
        { ownerUserId: userId },
        {
          baseMemberships: {
            some: {
              knowledgeBaseId: { in: [...accessibleIds] },
              removedAt: null
            }
          }
        }
      ],
      trashedAt: null
    }
  });
  return sources.length === selection.sourceIds.length;
}

export function createPrismaAssistantRepository(
  client: PrismaClient = prisma,
  options: PrismaAssistantRepositoryOptions = {}
) {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;
  const loadCatalogView = options.loadCatalogView ?? (async (
    tx: Prisma.TransactionClient,
    userId: string
  ): Promise<AssistantCatalogView | null> => {
    const catalogData = await createPrismaCatalogDataLoader({
      loadEntitlements: (catalogUserId) =>
        loadEntitlementsForUser(catalogUserId, tx),
      prisma: tx
    })(userId);
    if (!catalogData) return null;
    const selection = resolveCurrentUserCatalogSelection(catalogData);
    const accessibleMcpServerIds = await loadUserAccessibleMcpServerIdsWith(
      tx,
      userId
    );
    return {
      accessibleMcpServerIds,
      entitledSearchOptionIds: new Set(
        selection.entitledStrategies.map((strategy) => strategy.strategyId)
      ),
      // Duplicate intentionally accepts accessible but currently unready MCP.
      // No runtime liveness is consulted in this transaction.
      mcpRunPlan: {
        isGenerationLive: () => false,
        now: options.now?.() ?? new Date(),
        recordsByServerId: new Map()
      },
      modelById: new Map(selection.models.map((model) => [model.modelId, model]))
    };
  });
  const accessInclude = {
    skillLinks: contentSelect.skillLinks,
    owner: { select: { displayName: true } },
    publications: { include: { group: { select: { archivedAt: true, name: true } } } },
    projectBindings: { select: { id: true } }
  } satisfies Prisma.AssistantDefinitionInclude;

  async function loadAccessEntryWith(
    readClient: AssistantReadClient,
    userId: string,
    assistantId: string
  ): Promise<AssistantAccessEntry | null> {
    const [definition, memberGroupIds, pin] = await Promise.all([
      readClient.assistantDefinition.findUnique({
        include: accessInclude,
        where: { id: assistantId }
      }),
      activeMemberGroupIds(readClient, userId),
      readClient.assistantPin.findUnique({
        select: { userId: true },
        where: { userId_assistantId: { assistantId, userId } }
      })
    ]);
    if (!definition) return null;

    return projectAccessEntry(definition, userId, memberGroupIds, Boolean(pin));
  }

  function projectAccessEntry(
    definition: Prisma.AssistantDefinitionGetPayload<{ include: typeof accessInclude }>,
    userId: string,
    memberGroupIds: readonly string[],
    pinned: boolean
  ): AssistantAccessEntry | null {
    const owned = definition.ownerUserId === userId;
    const memberGroups = new Set(memberGroupIds);
    const accessiblePublications = definition.publications.filter(
      (publication) =>
        publication.scope === "installation" ||
        (publication.groupId !== null &&
          memberGroups.has(publication.groupId) &&
          publication.group?.archivedAt === null)
    );

    if (!owned && (definition.archivedAt || accessiblePublications.length === 0)) {
      return null;
    }

    const selectedPublications = owned ? definition.publications : accessiblePublications;

    return {
      archived: definition.archivedAt !== null,
      id: definition.id,
      installationScope: selectedPublications.some(
        (publication) => publication.scope === "installation"
      ),
      memberGroupNames: selectedPublications
        .filter((publication) => publication.scope === "group")
        .map((publication) => publication.group?.name ?? "")
        .filter((name) => name.length > 0)
        .sort((left, right) => left.localeCompare(right)),
      owned,
      ownerDisplayName: definition.owner.displayName,
      pinned,
      published: definition.publications.length > 0 || (owned && definition.projectBindings.length > 0),
      content: contentRow(definition),
      updatedAt: definition.updatedAt,
      version: definition.version
    };
  }

  const loadAccessEntry = (userId: string, assistantId: string) =>
    loadAccessEntryWith(client, userId, assistantId);

  const repository = {
    async create(userId: string, draft: AssistantDraft): Promise<AssistantCreateResult> {
      return client.$transaction(async (tx) => {
        if (!await lockAndCheckSkillDependencies(tx, userId, draft.skillIds)) {
          return { kind: "skills_not_available" as const };
        }
        const definition = await tx.assistantDefinition.create({
          data: { ...contentDraftData(draft), ownerUserId: userId }
        });
        await createAssistantSkillLinks(tx, definition.id, draft.skillIds);
        return { assistantId: definition.id, kind: "ok" as const };
      });
    },

    async duplicate(
      userId: string,
      assistantId: string
    ): Promise<AssistantDuplicateResult> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await client.$transaction(async (tx) => {
            // Catalog dependencies and source access are read from one MVCC
            // snapshot. The later locks serialize source publication/access
            // mutations; repeatable-read retry handles a source row changed
            // after the snapshot was established.
            const catalogView = await loadCatalogView(tx, userId);
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "AssistantDefinition"
              WHERE "id" = ${assistantId}
              FOR UPDATE
            `;
            // Keep every shared dependency reader on the same global order as
            // Knowledge publication: source, bases, membership/groups, then
            // Knowledge publications. The provisional source read discovers
            // the exact dependency ids; the locked re-read below is authority.
            await lockAssistantPublicationRowsForDuplicate(tx, assistantId);
            const provisionalSource = await loadAccessEntryWith(tx, userId, assistantId);
            if (!provisionalSource) return { kind: "not_found" as const };
            const knowledgeSelection = provisionalSource.content.knowledgeSelection;
            const knowledgeBaseIds = distinctKnowledgeBaseIds(knowledgeSelection.baseIds);
            const knowledgeSourceIds = distinctKnowledgeSourceIds(knowledgeSelection.sourceIds);
            const skillIds = distinctSortedSkillIds(provisionalSource.content.skillIds);
            if (!await lockKnowledgeBaseRowsForDuplicate(tx, knowledgeBaseIds)) {
              return { kind: "knowledge_not_available" as const };
            }
            if (!await lockKnowledgeSourceRowsForDuplicate(tx, knowledgeSourceIds)) {
              return { kind: "knowledge_not_available" as const };
            }
            if (!await lockSkillDefinitionRows(tx, skillIds)) {
              return { kind: "skills_not_available" as const };
            }
            await lockActiveMemberGroupRows(tx, userId);
            await lockKnowledgePublicationRowsForDuplicate(tx, knowledgeBaseIds);
            const source = await loadAccessEntryWith(tx, userId, assistantId);
            if (!source || source.version !== provisionalSource.version) {
              return { kind: "not_found" as const };
            }
            if (!catalogView) return { kind: "model_not_available" as const };
            const runControls = decodeAssistantRunControls(source.content.runControls ?? {});
            const searchPlan = decodeSearchPlan(source.content.searchPlan);
            if (!runControls || !searchPlan.ok) {
              throw new Error("assistant_definition_integrity_invalid");
            }
            if (!await allKnowledgeDependenciesAvailable(
              tx,
              userId,
              knowledgeSelection
            )) {
              return { kind: "knowledge_not_available" as const };
            }
            if (!await skillDependenciesAvailable(tx, userId, skillIds)) {
              return { kind: "skills_not_available" as const };
            }
            const invalid = validateAssistantConfigurationAgainstCatalog(
              {
                mcpServerIds: source.content.mcpServerIds,
                providerModelId: source.content.providerModelId,
                runControls,
                searchPlan: searchPlan.plan
              },
              catalogView,
              { mcpRunnability: "accessible" }
            );
            if (invalid === "model") return { kind: "model_not_available" as const };
            if (invalid !== null && typeof invalid === "object") {
              return { kind: "run_controls_invalid" as const };
            }
            if (invalid === "search") return { kind: "search_not_available" as const };
            if (invalid === "tools") return { kind: "tools_not_available" as const };

            const copyName = `Copy of ${source.content.name}`.slice(0, 80);
            const definition = await tx.assistantDefinition.create({
              data: {
                ownerUserId: userId,
                avatar: source.content.avatar as Prisma.InputJsonValue,
                category: source.content.category,
                description: source.content.description,
                developerPrompt: source.content.developerPrompt,
                knowledgeSelection: source.content.knowledgeSelection as unknown as Prisma.InputJsonValue,
                mcpServerIds: [...source.content.mcpServerIds],
                name: copyName,
                providerModelId: source.content.providerModelId,
                runControls: source.content.runControls as Prisma.InputJsonValue,
                searchPlan: source.content.searchPlan as Prisma.InputJsonValue,
                starterPrompts: [...source.content.starterPrompts],
                systemPrompt: source.content.systemPrompt
              }
            });
            await createAssistantSkillLinks(tx, definition.id, source.content.skillIds);
            return { assistantId: definition.id, kind: "ok" as const };
          }, {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            maxWait: 10_000,
            timeout: 30_000
          });
        } catch (error) {
          if (isPrismaSerializationConflict(error)) {
            if (attempt < 2) continue;
            // Exhausted races reveal no dependency/source existence detail.
            return { kind: "not_found" as const };
          }
          throw error;
        }
      }
      return { kind: "not_found" as const };
    },

    async getDetail(userId: string, assistantId: string): Promise<AssistantDetailData | null> {
      const entry = await loadAccessEntry(userId, assistantId);
      if (!entry) return null;
      if (!entry.owned) {
        return { ...entry, publications: null };
      }
      const [publications, projectBindings] = await Promise.all([
        client.assistantPublication.findMany({
          include: {
            group: { select: { name: true } }
          },
          orderBy: { createdAt: "asc" },
          where: { assistantId }
        }),
        client.projectAssistantBinding.findMany({
          orderBy: { createdAt: "asc" },
          where: { assistantId }
        })
      ]);
      return {
        ...entry,
        publications: [
          ...publications.map(publicationRow),
          ...projectBindings.map((binding) => ({
            groupId: null,
            groupName: null,
            id: `project:${binding.id}`,
            scope: "project" as const,
            updatedAt: binding.createdAt
          }))
        ]
      };
    },

    async listForUser(userId: string): Promise<AssistantAccessEntry[]> {
      const memberGroupIds = await activeMemberGroupIds(client, userId);
      const definitions = await client.assistantDefinition.findMany({
        include: { ...accessInclude, pins: { select: { userId: true }, where: { userId } } },
        where: {
          OR: [
            { ownerUserId: userId },
            {
              archivedAt: null,
              publications: { some: { OR: [
                { scope: "installation" },
                { scope: "group", groupId: { in: memberGroupIds }, group: { archivedAt: null } }
              ] } }
            }
          ]
        }
      });
      const entries = definitions.map((definition) =>
        projectAccessEntry(definition, userId, memberGroupIds, definition.pins.length > 0)
      ).filter((entry): entry is AssistantAccessEntry => entry !== null);
      return entries.sort((left, right) =>
        left.content.name.localeCompare(right.content.name) || left.id.localeCompare(right.id));
    },

    async update(
      userId: string,
      assistantId: string,
      expectedVersion: number,
      draft: AssistantDraft
    ): Promise<AssistantWriteResult> {
      try {
        return await client.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<
            Array<{ archivedAt: Date | null; id: string; version: number }>
          >`
            SELECT "id", "archivedAt", "version"
            FROM "AssistantDefinition"
            WHERE "id" = ${assistantId} AND "ownerUserId" = ${userId}
            FOR UPDATE
          `;
          const definition = locked[0];
          if (!definition) return { kind: "not_found" as const };
          if (definition.version !== expectedVersion) return { kind: "version_conflict" as const };
          if (definition.archivedAt) return { kind: "archived" as const };
          if (!await lockAndCheckSkillDependencies(tx, userId, draft.skillIds)) {
            return { kind: "skills_not_available" as const };
          }

          const publications = await tx.assistantPublication.findMany({
            select: { groupId: true, scope: true }, where: { assistantId }
          });
          for (const audience of publications) {
            if (!await skillsReachPublicationAudience(tx, draft.skillIds, audience)) {
              return { kind: "skill_audience_mismatch" as const };
            }
          }
          await tx.assistantDefinition.update({
            data: { ...contentDraftData(draft), version: { increment: 1 } },
            where: { id: assistantId }
          });
          await tx.assistantSkill.deleteMany({ where: { assistantId } });
          await createAssistantSkillLinks(tx, assistantId, draft.skillIds);
          return { assistantId, kind: "ok" as const };
        });
      } catch (error) {
        if (isPrismaSerializationConflict(error)) return { kind: "version_conflict" };
        throw error;
      }
    },

    async setArchived(
      userId: string,
      assistantId: string,
      expectedVersion: number,
      archived: boolean
    ): Promise<AssistantWriteResult> {
      return client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{ archivedAt: Date | null; id: string; version: number }>
        >`
          SELECT "id", "archivedAt", "version"
          FROM "AssistantDefinition"
          WHERE "id" = ${assistantId} AND "ownerUserId" = ${userId}
          FOR UPDATE
        `;
        const definition = locked[0];
        if (!definition) return { kind: "not_found" as const };
        if (definition.version !== expectedVersion) return { kind: "version_conflict" as const };

        const availabilityChanged = (definition.archivedAt !== null) !== archived;
        if (availabilityChanged) {
          await lockMemorySettings(tx, userId, false);
        }

        await tx.assistantDefinition.update({
          data: {
            archivedAt: archived ? (options.now?.() ?? new Date()) : null,
            version: { increment: 1 }
          },
          where: { id: assistantId }
        });
        if (availabilityChanged) {
          await applyMemoryScopedTargetOwnerLifecycle(tx, memorySourceHooks, {
            kind: "ASSISTANT_ACCESS_CHANGE",
            sourceSnapshots: [],
            targetId: assistantId,
            userId
          });
        }
        return { assistantId, kind: "ok" as const };
      });
    },

    async publish(input: AssistantPublishInput): Promise<AssistantPublishResult> {
      return client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{ archivedAt: Date | null; id: string }>
        >`
          SELECT "id", "archivedAt"
          FROM "AssistantDefinition"
          WHERE "id" = ${input.assistantId} AND "ownerUserId" = ${input.userId}
          FOR UPDATE
        `;
        const definition = locked[0];
        if (!definition) return { kind: "not_found" as const };
        if (definition.archivedAt) return { kind: "invalid" as const };

        if (input.scope === "installation") {
          if (!input.actorIsAdmin) return { kind: "forbidden" as const };
        } else {
          if (!input.groupId) return { kind: "invalid" as const };
          // Match duplicate/run lock order: definition, publications, then the
          // exact membership and active group that authorize this publication.
          // The share locks make membership removal and group archival
          // serialize with the publication write rather than winning after an
          // unlocked authorization check.
          await lockAssistantPublicationRows(tx, input.assistantId);
          const memberships = await tx.$queryRaw<Array<{ groupId: string }>>`
            SELECT membership."groupId"
            FROM "UserGroup" AS membership
            INNER JOIN "Group" AS member_group
              ON member_group."id" = membership."groupId"
            WHERE membership."userId" = ${input.userId}
              AND membership."groupId" = ${input.groupId}
              AND member_group."archivedAt" IS NULL
            FOR SHARE OF membership, member_group
          `;
          if (!memberships[0]) return { kind: "forbidden" as const };
        }

        const content = await tx.assistantDefinition.findUnique({
          select: { skillLinks: { select: { skillId: true } } },
          where: { id: input.assistantId }
        });
        if (!content) return { kind: "invalid" as const };
        if (!await skillsReachPublicationAudience(
          tx,
          content.skillLinks.map((link) => link.skillId),
          { groupId: input.groupId, scope: input.scope }
        )) {
          return { kind: "skill_audience_mismatch" as const };
        }

        const existing = await tx.assistantPublication.findFirst({
          select: { id: true },
          where: {
            assistantId: input.assistantId,
            ...(input.scope === "installation"
              ? { scope: "installation" }
              : { groupId: input.groupId })
          }
        });
        const publication = existing
          ? await tx.assistantPublication.update({
              data: {
                publishedByUserId: input.userId
              },
              include: {
                group: { select: { name: true } }
              },
              where: { id: existing.id }
            })
          : await tx.assistantPublication.create({
              data: {
                assistantId: input.assistantId,
                groupId: input.scope === "group" ? input.groupId : null,
                publishedByUserId: input.userId,
                scope: input.scope
              },
              include: {
                group: { select: { name: true } }
              }
            });
        return { kind: "ok" as const, publication: publicationRow(publication) };
      });
    },

    async revokePublication(input: {
      actorIsAdmin: boolean;
      assistantId: string;
      publicationId: string;
      userId: string;
    }): Promise<"not_found" | "revoked"> {
      if (input.publicationId.startsWith("project:")) {
        const bindingId = input.publicationId.slice("project:".length);
        if (!bindingId) return "not_found";
        return await revokeOwnedProjectResourcePublication(client, {
          bindingId,
          resourceId: input.assistantId,
          type: "assistant",
          userId: input.userId
        }) ? "revoked" : "not_found";
      }
      return client.$transaction(async (tx) => {
        const publication = await tx.assistantPublication.findFirst({
          select: {
            assistant: { select: { id: true, ownerUserId: true } },
            id: true
          },
          where: {
            assistantId: input.assistantId,
            id: input.publicationId
          }
        });
        if (
          !publication ||
          (publication.assistant.ownerUserId !== input.userId && !input.actorIsAdmin)
        ) {
          return "not_found" as const;
        }
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "AssistantDefinition"
          WHERE "id" = ${publication.assistant.id}
          FOR UPDATE
        `;
        const deleted = await tx.assistantPublication.deleteMany({
          where: {
            assistantId: input.assistantId,
            id: publication.id
          }
        });
        return deleted.count === 1 ? "revoked" as const : "not_found" as const;
      });
    },

    async setPinned(userId: string, assistantId: string, pinned: boolean): Promise<boolean> {
      const entry = await loadAccessEntry(userId, assistantId);
      if (!entry) return false;
      if (pinned) {
        await client.assistantPin.upsert({
          create: { assistantId, userId },
          update: {},
          where: { userId_assistantId: { assistantId, userId } }
        });
      } else {
        await client.assistantPin.deleteMany({ where: { assistantId, userId } });
      }
      return true;
    },

    loadAccessEntry,

    async listPublishableGroups(userId: string): Promise<Array<{ id: string; name: string }>> {
      const memberships = await client.userGroup.findMany({
        select: { group: { select: { id: true, name: true } } },
        where: { group: { archivedAt: null }, userId }
      });
      return memberships
        .map((membership) => membership.group)
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async loadUserAccessibleMcpServerIds(userId: string): Promise<Set<string>> {
      return loadUserAccessibleMcpServerIdsWith(client, userId);
    },

    async loadUserRunnableMcpServerIds(userId: string): Promise<Set<string>> {
      const now = options.now?.() ?? new Date();
      const isGenerationLive = options.isMcpGenerationLive ?? (() => false);
      const records = await loadMcpRunPlanRecords(userId, client);
      return new Set(
        records
          .filter((record) =>
            isMcpRunPlanRecordRunnable({ isGenerationLive, now, record })
          )
          .map((record) => record.serverId)
      );
    },

    async loadUserMcpRunPlanView(userId: string) {
      const now = options.now?.() ?? new Date();
      const isGenerationLive = options.isMcpGenerationLive ?? (() => false);
      // Availability needs disabled and attention states too so an owner can
      // receive a truthful, named dependency. Ordinary Auto discovery keeps
      // using the enabled-only loader above.
      const accessibleServerIds = await loadUserAccessibleMcpServerIdsWith(client, userId);
      const [runPlanRecords, userServers] = await Promise.all([
        loadMcpRunPlanRecordsForServers(userId, [...accessibleServerIds], client),
        options.loadUserMcpServers?.(userId).catch(() => []) ?? Promise.resolve([])
      ]);
      const records = projectMcpRunPlanStartability(runPlanRecords, userServers);
      return {
        isGenerationLive,
        now,
        recordsByServerId: new Map(
          records.map((record) => [record.serverId, record])
        )
      };
    }
  };

  async function resolveConsistentDefinition(
    operation: (tx: Prisma.TransactionClient) => Promise<AssistantRunResolution>
  ): Promise<AssistantRunResolution> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
        });
      } catch (error) {
        if (!isPrismaSerializationConflict(error)) throw error;
      }
    }
    return { code: "assistant_not_available", ok: false, status: 404 };
  }

  const runResolver: AssistantRunResolver = {
    async resolveForProject(projectId, assistantId): Promise<AssistantRunResolution> {
      return resolveConsistentDefinition(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AssistantDefinition"
          WHERE "id" = ${assistantId} FOR SHARE`;
        const binding = await tx.projectAssistantBinding.findUnique({
          include: { assistant: { include: {
            providerModel: { select: { connectionId: true, id: true, modelClass: true } },
            skillLinks: contentSelect.skillLinks
          } } },
          where: { projectId_assistantId: { assistantId, projectId } }
        });
        if (!binding || binding.assistant.archivedAt || binding.assistant.providerModel.modelClass !== "answer") {
          return { code: "assistant_not_available", ok: false, status: 404 };
        }
        return materialize(contentRow(binding.assistant), binding.assistant.version,
          binding.assistant.providerModel.connectionId);
      });
    },
    async resolveForRun(userId, assistantId): Promise<AssistantRunResolution> {
      return resolveConsistentDefinition(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AssistantDefinition"
          WHERE "id" = ${assistantId} FOR SHARE`;
        const entry = await loadAccessEntryWith(tx, userId, assistantId);
        if (!entry || entry.archived) {
          return { code: "assistant_not_available", ok: false, status: 404 };
        }
        const model = await tx.providerModel.findUnique({
          select: { connectionId: true, modelClass: true },
          where: { id: entry.content.providerModelId }
        });
        if (!model || model.modelClass !== "answer") {
          return { code: "assistant_not_available", ok: false, status: 404 };
        }
        return materialize(entry.content, entry.version, model.connectionId);
      });
    }
  };

  function materialize(content: AssistantContentRow, version: number, provider: string): AssistantRunResolution {
    const runControls = decodeAssistantRunControls(content.runControls ?? {});
    const searchPlan = decodeSearchPlan(content.searchPlan);
    const avatar = decodeAssistantAvatarRecipe(content.avatar);
    if (!runControls || !searchPlan.ok || !avatar) {
      throw new Error("assistant_definition_integrity_invalid");
    }
    const assistant: AssistantRunMaterialization = {
      assistantId: content.id,
      definitionVersion: version,
      identity: { avatar, name: content.name },
      developerPrompt: content.developerPrompt,
      knowledgeSelection: content.knowledgeSelection,
      mcpServerIds: [...content.mcpServerIds],
      name: content.name,
      provider,
      providerModelId: content.providerModelId,
      runControls,
      searchPlan: searchPlan.plan,
      skillIds: [...content.skillIds],
      systemPrompt: content.systemPrompt
    };
    return { assistant, ok: true };
  }

  return { ...repository, ...runResolver };
}

export type PrismaAssistantRepository = ReturnType<typeof createPrismaAssistantRepository>;
