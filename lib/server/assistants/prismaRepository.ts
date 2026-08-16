import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeAssistantAvatarRecipe,
  decodeAssistantRunControls,
  type AssistantDraft
} from "../../contracts/assistants";
import { decodeSearchPlan } from "../../contracts/search";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { isMcpRunPlanRecordRunnable } from "../mcp/runPlan";
import { loadMcpRunPlanRecords } from "../mcp/runPlanRepository";
import { lockMemorySettings } from "../memory/persistence/transaction";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  applyMemoryScopedTargetOwnerLifecycle,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { prisma } from "../prisma";
import {
  validateAssistantConfigurationAgainstCatalog,
  type AssistantCatalogView
} from "./catalogValidation";
import type {
  AssistantRunMaterialization,
  AssistantRunResolution,
  AssistantRunResolver
} from "./runMaterialization";

export type AssistantRevisionRow = {
  authorDisplayName: string | null;
  avatar: unknown;
  category: string | null;
  createdAt: Date;
  description: string;
  developerPrompt: string | null;
  id: string;
  knowledgeBaseIds: string[];
  mcpServerIds: string[];
  name: string;
  providerModelId: string;
  revisionNumber: number;
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
  revisionNumber: number;
  scope: "group" | "installation";
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
  /** The revision this runner would execute right now. */
  revision: AssistantRevisionRow;
  updatedAt: Date;
  version: number;
};

export type AssistantDetailData = AssistantAccessEntry & {
  publications: AssistantPublicationRow[] | null;
  revisionCount: number | null;
};

export type AssistantWriteResult =
  | { assistantId: string; kind: "ok" }
  | { kind: "archived" }
  | { kind: "not_found" }
  | { kind: "skills_not_available" }
  | { kind: "version_conflict" };

export type AssistantCreateResult =
  | { assistantId: string; kind: "ok" }
  | { kind: "skills_not_available" };

export type AssistantPublishInput = {
  actorIsAdmin: boolean;
  assistantId: string;
  groupId: string | null;
  revisionNumber: number | null;
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

const revisionSelect = {
  author: { select: { displayName: true } },
  avatar: true,
  category: true,
  createdAt: true,
  description: true,
  developerPrompt: true,
  id: true,
  knowledgeBaseIds: true,
  mcpServerIds: true,
  name: true,
  providerModelId: true,
  revisionNumber: true,
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
} satisfies Prisma.AssistantRevisionSelect;

type RevisionRecord = Prisma.AssistantRevisionGetPayload<{ select: typeof revisionSelect }>;

function revisionRow(record: RevisionRecord): AssistantRevisionRow {
  return {
    authorDisplayName: record.author?.displayName ?? null,
    avatar: record.avatar,
    category: record.category,
    createdAt: record.createdAt,
    description: record.description,
    developerPrompt: record.developerPrompt,
    id: record.id,
    knowledgeBaseIds: [...record.knowledgeBaseIds],
    mcpServerIds: [...record.mcpServerIds],
    name: record.name,
    providerModelId: record.providerModelId,
    revisionNumber: record.revisionNumber,
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
  revision: { revisionNumber: number };
  scope: "group" | "installation";
  updatedAt: Date;
}): AssistantPublicationRow {
  return {
    groupId: record.groupId,
    groupName: record.group?.name ?? null,
    id: record.id,
    revisionNumber: record.revision.revisionNumber,
    scope: record.scope,
    updatedAt: record.updatedAt
  };
}

function revisionDraftData(draft: AssistantDraft): Omit<
  Prisma.AssistantRevisionUncheckedCreateInput,
  "assistantId" | "authorUserId" | "revisionNumber"
> {
  return {
    avatar: draft.avatar as unknown as Prisma.InputJsonValue,
    category: draft.category,
    description: draft.description,
    developerPrompt: draft.developerPrompt,
    knowledgeBaseIds: [...draft.knowledgeBaseIds],
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

async function createAssistantRevisionSkillLinks(
  tx: Prisma.TransactionClient,
  assistantRevisionId: string,
  skillIds: readonly string[]
): Promise<void> {
  if (skillIds.length === 0) return;
  await tx.assistantRevisionSkill.createMany({
    data: skillIds.map((skillId, ordinal) => ({
      assistantRevisionId,
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
        error.meta.code === "40001"));
}

export type PrismaAssistantRepositoryOptions = {
  isMcpGenerationLive?(generationId: string): boolean;
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
  knowledgeBaseIds: readonly string[]
): Promise<boolean> {
  if (knowledgeBaseIds.length === 0) return true;

  const groupIds = await activeMemberGroupIds(tx, userId);
  const accessible = await tx.knowledgeBase.findMany({
    select: { id: true },
    where: {
      archivedAt: null,
      id: { in: [...knowledgeBaseIds] },
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
  return accessible.length === knowledgeBaseIds.length;
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
  async function loadAccessEntryWith(
    readClient: AssistantReadClient,
    userId: string,
    assistantId: string
  ): Promise<AssistantAccessEntry | null> {
    const [definition, memberGroupIds, pin] = await Promise.all([
      readClient.assistantDefinition.findUnique({
        include: {
          currentRevision: { select: revisionSelect },
          owner: { select: { displayName: true } },
          publications: {
            include: {
              group: { select: { archivedAt: true, name: true } },
              revision: { select: revisionSelect }
            }
          }
        },
        where: { id: assistantId }
      }),
      activeMemberGroupIds(readClient, userId),
      readClient.assistantPin.findUnique({
        select: { userId: true },
        where: { userId_assistantId: { assistantId, userId } }
      })
    ]);
    if (!definition) return null;

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

    const selectedPublication = owned
      ? null
      : [...accessiblePublications].sort(
          (left, right) => right.revision.revisionNumber - left.revision.revisionNumber
        )[0] ?? null;
    const accessibleRevision = owned
      ? definition.currentRevision
      : selectedPublication?.revision ?? null;
    if (!accessibleRevision) return null;
    const selectedPublications = owned
      ? definition.publications
      : accessiblePublications.filter(
          (publication) => publication.revision.id === accessibleRevision.id
        );

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
      pinned: Boolean(pin),
      published: definition.publications.length > 0,
      revision: revisionRow(accessibleRevision),
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
          data: { ownerUserId: userId }
        });
        const revision = await tx.assistantRevision.create({
          data: {
            ...revisionDraftData(draft),
            assistantId: definition.id,
            authorUserId: userId,
            revisionNumber: 1
          }
        });
        await createAssistantRevisionSkillLinks(tx, revision.id, draft.skillIds);
        await tx.assistantDefinition.update({
          data: { currentRevisionId: revision.id },
          where: { id: definition.id }
        });
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
            const knowledgeBaseIds = distinctKnowledgeBaseIds(
              provisionalSource.revision.knowledgeBaseIds
            );
            const skillIds = distinctSortedSkillIds(provisionalSource.revision.skillIds);
            if (!await lockKnowledgeBaseRowsForDuplicate(tx, knowledgeBaseIds)) {
              return { kind: "knowledge_not_available" as const };
            }
            if (!await lockSkillDefinitionRows(tx, skillIds)) {
              return { kind: "skills_not_available" as const };
            }
            await lockActiveMemberGroupRows(tx, userId);
            await lockKnowledgePublicationRowsForDuplicate(tx, knowledgeBaseIds);
            const source = await loadAccessEntryWith(tx, userId, assistantId);
            if (!source || source.revision.id !== provisionalSource.revision.id) {
              return { kind: "not_found" as const };
            }
            if (!catalogView) return { kind: "model_not_available" as const };
            const runControls = decodeAssistantRunControls(source.revision.runControls ?? {});
            const searchPlan = decodeSearchPlan(source.revision.searchPlan);
            if (!runControls || !searchPlan.ok) {
              throw new Error("assistant_revision_integrity_invalid");
            }
            if (!await allKnowledgeDependenciesAvailable(
              tx,
              userId,
              knowledgeBaseIds
            )) {
              return { kind: "knowledge_not_available" as const };
            }
            if (!await skillDependenciesAvailable(tx, userId, skillIds)) {
              return { kind: "skills_not_available" as const };
            }
            const invalid = validateAssistantConfigurationAgainstCatalog(
              {
                mcpServerIds: source.revision.mcpServerIds,
                providerModelId: source.revision.providerModelId,
                runControls,
                searchPlan: searchPlan.plan
              },
              catalogView,
              { requireRunnableMcp: false }
            );
            if (invalid === "model") return { kind: "model_not_available" as const };
            if (invalid === "run_controls") {
              return { kind: "run_controls_invalid" as const };
            }
            if (invalid === "search") return { kind: "search_not_available" as const };
            if (invalid === "tools") return { kind: "tools_not_available" as const };

            const copyName = `Copy of ${source.revision.name}`.slice(0, 80);
            const definition = await tx.assistantDefinition.create({
              data: { ownerUserId: userId }
            });
            const revision = await tx.assistantRevision.create({
              data: {
                assistantId: definition.id,
                authorUserId: userId,
                avatar: source.revision.avatar as Prisma.InputJsonValue,
                category: source.revision.category,
                description: source.revision.description,
                developerPrompt: source.revision.developerPrompt,
                knowledgeBaseIds: [...source.revision.knowledgeBaseIds],
                mcpServerIds: [...source.revision.mcpServerIds],
                name: copyName,
                providerModelId: source.revision.providerModelId,
                revisionNumber: 1,
                runControls: source.revision.runControls as Prisma.InputJsonValue,
                searchPlan: source.revision.searchPlan as Prisma.InputJsonValue,
                starterPrompts: [...source.revision.starterPrompts],
                systemPrompt: source.revision.systemPrompt
              }
            });
            await createAssistantRevisionSkillLinks(tx, revision.id, source.revision.skillIds);
            await tx.assistantDefinition.update({
              data: { currentRevisionId: revision.id },
              where: { id: definition.id }
            });
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
        return { ...entry, publications: null, revisionCount: null };
      }
      const [publications, revisionCount] = await Promise.all([
        client.assistantPublication.findMany({
          include: {
            group: { select: { name: true } },
            revision: { select: { revisionNumber: true } }
          },
          orderBy: { createdAt: "asc" },
          where: { assistantId }
        }),
        client.assistantRevision.count({ where: { assistantId } })
      ]);
      return {
        ...entry,
        publications: publications.map(publicationRow),
        revisionCount
      };
    },

    async listForUser(userId: string): Promise<AssistantAccessEntry[]> {
      const memberGroupIds = await activeMemberGroupIds(client, userId);
      const [owned, sharedPublications, pins] = await Promise.all([
        client.assistantDefinition.findMany({
          include: {
            currentRevision: { select: revisionSelect },
            owner: { select: { displayName: true } },
            publications: { select: { groupId: true, id: true, scope: true } }
          },
          where: { ownerUserId: userId }
        }),
        client.assistantPublication.findMany({
          include: {
            assistant: {
              include: {
                owner: { select: { displayName: true } },
                publications: { select: { id: true, scope: true } }
              }
            },
            group: { select: { archivedAt: true, name: true } },
            revision: { select: revisionSelect }
          },
          where: {
            assistant: { archivedAt: null, ownerUserId: { not: userId } },
            OR: [
              { scope: "installation" },
              ...(memberGroupIds.length > 0
                ? [{ groupId: { in: memberGroupIds } }]
                : [])
            ]
          }
        }),
        client.assistantPin.findMany({
          select: { assistantId: true },
          where: { userId }
        })
      ]);
      const pinned = new Set(pins.map((pin) => pin.assistantId));

      const entries: AssistantAccessEntry[] = owned.flatMap((definition) =>
        definition.currentRevision
          ? [
              {
                archived: definition.archivedAt !== null,
                id: definition.id,
                installationScope: definition.publications.some(
                  (publication) => publication.scope === "installation"
                ),
                memberGroupNames: [],
                owned: true,
                ownerDisplayName: definition.owner.displayName,
                pinned: pinned.has(definition.id),
                published: definition.publications.length > 0,
                revision: revisionRow(definition.currentRevision),
                updatedAt: definition.updatedAt,
                version: definition.version
              }
            ]
          : []
      );

      const sharedByAssistant = new Map<string, typeof sharedPublications>();
      for (const publication of sharedPublications) {
        if (
          publication.scope === "group" &&
          (publication.groupId === null || publication.group?.archivedAt !== null)
        ) {
          continue;
        }
        const current = sharedByAssistant.get(publication.assistantId) ?? [];
        current.push(publication);
        sharedByAssistant.set(publication.assistantId, current);
      }
      for (const [assistantId, publications] of sharedByAssistant) {
        const best = [...publications].sort(
          (left, right) => right.revision.revisionNumber - left.revision.revisionNumber
        )[0]!;
        const selectedPublications = publications.filter(
          (publication) => publication.revision.id === best.revision.id
        );
        entries.push({
          archived: false,
          id: assistantId,
          installationScope: selectedPublications.some(
            (publication) => publication.scope === "installation"
          ),
          memberGroupNames: selectedPublications
            .filter((publication) => publication.scope === "group")
            .map((publication) => publication.group?.name ?? "")
            .filter((name) => name.length > 0)
            .sort((left, right) => left.localeCompare(right)),
          owned: false,
          ownerDisplayName: best.assistant.owner.displayName,
          pinned: pinned.has(assistantId),
          published: true,
          revision: revisionRow(best.revision),
          updatedAt: best.updatedAt,
          version: best.assistant.version
        });
      }

      return entries.sort((left, right) =>
        left.revision.name.localeCompare(right.revision.name) || left.id.localeCompare(right.id)
      );
    },

    async listRevisions(userId: string, assistantId: string): Promise<AssistantRevisionRow[] | null> {
      const definition = await client.assistantDefinition.findFirst({
        select: { id: true },
        where: { id: assistantId, ownerUserId: userId }
      });
      if (!definition) return null;
      const revisions = await client.assistantRevision.findMany({
        orderBy: { revisionNumber: "desc" },
        select: revisionSelect,
        where: { assistantId }
      });
      return revisions.map(revisionRow);
    },

    async getRevision(
      userId: string,
      assistantId: string,
      revisionNumber: number
    ): Promise<AssistantRevisionRow | null> {
      const revision = await client.assistantRevision.findFirst({
        select: revisionSelect,
        where: {
          assistant: { ownerUserId: userId },
          assistantId,
          revisionNumber
        }
      });
      return revision ? revisionRow(revision) : null;
    },

    async revise(
      userId: string,
      assistantId: string,
      expectedVersion: number,
      draft: AssistantDraft
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
        if (definition.archivedAt) return { kind: "archived" as const };
        if (!await lockAndCheckSkillDependencies(tx, userId, draft.skillIds)) {
          return { kind: "skills_not_available" as const };
        }

        const latest = await tx.assistantRevision.aggregate({
          _max: { revisionNumber: true },
          where: { assistantId }
        });
        const revision = await tx.assistantRevision.create({
          data: {
            ...revisionDraftData(draft),
            assistantId,
            authorUserId: userId,
            revisionNumber: (latest._max.revisionNumber ?? 0) + 1
          }
        });
        await createAssistantRevisionSkillLinks(tx, revision.id, draft.skillIds);
        await tx.assistantDefinition.update({
          data: {
            currentRevisionId: revision.id,
            version: { increment: 1 }
          },
          where: { id: assistantId }
        });
        return { assistantId, kind: "ok" as const };
      });
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

        const revision = input.revisionNumber === null
          ? await tx.assistantDefinition
              .findUnique({
                select: {
                  currentRevision: {
                    select: {
                      id: true,
                      revisionNumber: true,
                      skillLinks: {
                        orderBy: { ordinal: "asc" },
                        select: { skillId: true }
                      }
                    }
                  }
                },
                where: { id: input.assistantId }
              })
              .then((row) => row?.currentRevision ?? null)
          : await tx.assistantRevision.findFirst({
              select: {
                id: true,
                revisionNumber: true,
                skillLinks: {
                  orderBy: { ordinal: "asc" },
                  select: { skillId: true }
                }
              },
              where: {
                assistantId: input.assistantId,
                revisionNumber: input.revisionNumber
              }
            });
        if (!revision) return { kind: "invalid" as const };
        if (!await skillsReachPublicationAudience(
          tx,
          revision.skillLinks.map((link) => link.skillId),
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
                publishedByUserId: input.userId,
                revisionId: revision.id
              },
              include: {
                group: { select: { name: true } },
                revision: { select: { revisionNumber: true } }
              },
              where: { id: existing.id }
            })
          : await tx.assistantPublication.create({
              data: {
                assistantId: input.assistantId,
                groupId: input.scope === "group" ? input.groupId : null,
                publishedByUserId: input.userId,
                revisionId: revision.id,
                scope: input.scope
              },
              include: {
                group: { select: { name: true } },
                revision: { select: { revisionNumber: true } }
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
      const records = await loadMcpRunPlanRecords(userId, client);
      return {
        isGenerationLive,
        now,
        recordsByServerId: new Map(
          records.map((record) => [record.serverId, record])
        )
      };
    }
  };

  const runResolver: AssistantRunResolver = {
    async resolveForRun(userId, assistantId): Promise<AssistantRunResolution> {
      const entry = await loadAccessEntry(userId, assistantId);
      if (!entry || entry.archived) {
        return { code: "assistant_not_available", ok: false, status: 404 };
      }
      const runControls = decodeAssistantRunControls(entry.revision.runControls ?? {});
      const searchPlan = decodeSearchPlan(entry.revision.searchPlan);
      const avatar = decodeAssistantAvatarRecipe(entry.revision.avatar);
      if (!runControls || !searchPlan.ok || !avatar) {
        throw new Error("assistant_revision_integrity_invalid");
      }
      const model = await client.providerModel.findUnique({
        select: { connectionId: true, id: true, modelClass: true },
        where: { id: entry.revision.providerModelId }
      });
      if (!model || model.modelClass !== "answer") {
        return { code: "assistant_not_available", ok: false, status: 404 };
      }
      const assistant: AssistantRunMaterialization = {
        assistantId: entry.id,
        developerPrompt: entry.revision.developerPrompt,
        knowledgeBaseIds: [...entry.revision.knowledgeBaseIds],
        mcpServerIds: [...entry.revision.mcpServerIds],
        name: entry.revision.name,
        provider: model.connectionId,
        providerModelId: model.id,
        revisionId: entry.revision.id,
        revisionNumber: entry.revision.revisionNumber,
        runControls,
        searchPlan: searchPlan.plan,
        skillIds: [...entry.revision.skillIds],
        systemPrompt: entry.revision.systemPrompt
      };
      return { assistant, ok: true };
    }
  };

  return { ...repository, ...runResolver };
}

export type PrismaAssistantRepository = ReturnType<typeof createPrismaAssistantRepository>;
