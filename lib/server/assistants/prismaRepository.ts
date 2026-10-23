import { Prisma, type PrismaClient } from "@prisma/client";
import type { AssistantListingStatus } from "../../contracts/assistantListing";
import {
  ASSISTANT_MAX_RECENT,
  assistantSkillModeForDelivery,
  decodeAssistantAvatarRecipe,
  decodeAssistantRunControls,
  type AssistantDraft,
  type AssistantDuplicateReport,
  type AssistantOwnerAudience,
  type AssistantPublishableGroup,
  type AssistantRows
} from "../../contracts/assistants";
import { decodeSearchPlan } from "../../contracts/search";
import type { AssistantSkillMode, SkillsSelection } from "../../contracts/skills";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { projectMcpRunPlanStartability } from "../mcp/runPlan";
import { loadMcpRunPlanRecordsForServers } from "../mcp/runPlanRepository";
import { lockMemorySettings } from "../memory/persistence/transaction";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  applyMemoryScopedTargetOwnerLifecycle,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { prisma } from "../prisma";
import {
  assistantRowsForCopier,
  emptyAssistantCatalogView,
  type AssistantCatalogView
} from "./catalogValidation";
import type {
  AssistantRunMaterialization,
  AssistantRunResolution,
  AssistantRunResolver
} from "./runMaterialization";
import { withAssistantDependencyAvailability } from "./dependencyAvailability";
import { loadAssistantRecentChatCounts, loadFeaturedAssistantOrders } from "./listedAssistants";
import { loadAssistantListingStatus } from "./listingRequests";
import {
  assistantRowsFromStoredColumns,
  legacyValuesFromAssistantRows,
  storedColumnsFromAssistantRows
} from "./storedContent";

export type AssistantContentRow = {
  answerRules: string | null;
  avatar: unknown;
  category: string | null;
  description: string;
  responseReminder?: string;
  id: string;
  mcpServerIds: string[];
  /** The stored model's name, for the owner's missing-dependency copy only. */
  modelDisplayName?: string | null;
  name: string;
  /** Null is an inherited model, which no current path can run. */
  providerModelId: string | null;
  /** Authoritative row values and policies; the flat fields above read them as today. */
  rows: AssistantRows;
  runControls: unknown;
  searchPlan: unknown;
  skillSummaries?: { id: string; name: string; available?: boolean; mode?: AssistantSkillMode; instructionApproxTokens?: number }[];
  skillIds: string[];
  skillModes?: Record<string, AssistantSkillMode>;
  skills?: SkillsSelection;
  starterPrompts: string[];
  systemPrompt: string;
};

export type AssistantPublicationRow = {
  groupId: string | null;
  groupName: string | null;
  id: string;
  scope: "group" | "installation";
  updatedAt: Date;
};

export type AssistantAccessEntry = {
  archived: boolean;
  /** Owner only: whom the owner shared it with; null for every other viewer. */
  audience: AssistantOwnerAudience | null;
  featured: boolean;
  /** Position of the installation publication among Featured Assistants. */
  featuredOrder: number | null;
  id: string;
  installationScope: boolean;
  memberGroupNames: string[];
  owned: boolean;
  ownerDisplayName: string;
  pinned: boolean;
  published: boolean;
  /** One complete live definition for future admission. */
  content: AssistantContentRow;
  dependencyAvailability?: Readonly<{
    skills: boolean;
  }>;
  updatedAt: Date;
  version: number;
};

export type AssistantDetailData = AssistantAccessEntry & {
  /** Owner only: the latest listing request and whether one can be made. */
  listingRequest?: AssistantListingStatus | null;
  publications: AssistantPublicationRow[] | null;
  /** Owner only. */
  recentChatCount?: number;
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
  /** When given (a publication the user confirmed in an answer's card), the definition version it was proposed for. */
  expectedVersion?: number;
  groupId: string | null;
  scope: "group" | "installation";
  userId: string;
};

export type AssistantPublishResult =
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "version_conflict" }
  | { kind: "skill_audience_mismatch"; skillNames?: string[] }
  | { kind: "ok"; publication: AssistantPublicationRow };

export type AssistantDuplicateResult =
  | { assistantId: string; kind: "ok"; report: AssistantDuplicateReport }
  | { kind: "not_found" };

const contentSelect = {
  answerRules: true,
  avatar: true,
  category: true,
  controlsPolicy: true,
  description: true,
  responseReminder: true,
  skillsMode: true,
  skillsPolicy: true,
  id: true,
  mcpMode: true,
  mcpServerIds: true,
  modelPolicy: true,
  name: true,
  providerModel: { select: { displayName: true } },
  providerModelId: true,
  runControls: true,
  searchPlan: true,
  searchPolicy: true,
  toolsPolicy: true,
  skillLinks: {
    orderBy: { ordinal: "asc" },
    select: {
      skill: { select: { ownerUserId: true, currentRevision: { select: { name: true } }, sharedRevision: { select: { name: true } } } },
      skillId: true,
      mode: true
    }
  },
  starterPrompts: true,
  systemPrompt: true
} satisfies Prisma.AssistantDefinitionSelect;

type ContentRecord = Prisma.AssistantDefinitionGetPayload<{ select: typeof contentSelect }>;

/** Run resolution selects the model's connection instead and passes no name. */
type ContentRecordInput = Omit<ContentRecord, "providerModel"> & {
  providerModel: { displayName: string } | null;
};

function contentRow(record: ContentRecordInput, userId?: string): AssistantContentRow {
  const rows = assistantRowsFromStoredColumns(record);
  if (!rows) throw new Error("assistant_definition_integrity_invalid");
  return {
    answerRules: record.answerRules,
    avatar: record.avatar,
    category: record.category,
    description: record.description,
    responseReminder: record.responseReminder ?? "",
    skills: { mode: record.skillsMode },
    skillModes: Object.fromEntries(record.skillLinks.map((link) => [link.skillId, link.mode])),
    id: record.id,
    ...legacyValuesFromAssistantRows(rows),
    modelDisplayName: record.providerModel?.displayName ?? null,
    name: record.name,
    rows,
    skillSummaries: record.skillLinks.flatMap((link) => {
      const revision = link.skill.ownerUserId === userId ? link.skill.currentRevision : link.skill.sharedRevision;
      return revision ? [{ id: link.skillId, name: revision.name, mode: link.mode }] : [];
    }),
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

function rowColumnsData(rows: AssistantRows) {
  const { skillLinks: _skillLinks, ...columns } = storedColumnsFromAssistantRows(rows);
  return {
    ...columns,
    runControls: columns.runControls as Prisma.InputJsonValue,
    searchPlan: columns.searchPlan as Prisma.InputJsonValue
  };
}

function rowSkillLinks(rows: AssistantRows): {
  skillIds: string[];
  skillModes: Record<string, AssistantSkillMode>;
} {
  const links = rows.skills.value.links;
  return {
    skillIds: links.map((link) => link.skillId),
    skillModes: Object.fromEntries(links.map((link) =>
      [link.skillId, assistantSkillModeForDelivery(link.delivery)]))
  };
}

function contentDraftData(draft: AssistantDraft): Omit<
  Prisma.AssistantDefinitionUncheckedCreateInput, "ownerUserId"
> {
  // The retired developer prompt is neither stored nor cleared: the migration
  // merged it into the system prompt and current readers ignore the column.
  return {
    ...rowColumnsData(draft.rows),
    answerRules: draft.answerRules,
    avatar: draft.avatar as unknown as Prisma.InputJsonValue,
    category: draft.category,
    description: draft.description,
    responseReminder: draft.responseReminder,
    name: draft.name,
    starterPrompts: [...draft.starterPrompts],
    systemPrompt: draft.systemPrompt
  };
}

async function createAssistantSkillLinks(
  tx: Prisma.TransactionClient,
  assistantId: string,
  skillIds: readonly string[],
  skillModes: Readonly<Record<string, AssistantSkillMode>> = {}
): Promise<void> {
  if (skillIds.length === 0) return;
  await tx.assistantSkill.createMany({
    data: skillIds.map((skillId, ordinal) => ({
      assistantId,
      ordinal,
      skillId,
      mode: skillModes[skillId] ?? "pinned"
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

/** `activeGroupIds`: the user's memberships of groups that are not archived, when already read. */
export async function loadUserAccessibleMcpServerIdsWith(
  readClient: AssistantMcpAccessClient,
  userId: string,
  options: Readonly<{ activeGroupIds?: readonly string[] }> = {}
): Promise<Set<string>> {
  const memberGroupIds = options.activeGroupIds ?? await activeMemberGroupIds(readClient, userId);
  const grants = await readClient.mcpGrant.findMany({
    select: { serverId: true },
    where: {
      canUse: true,
      server: { archivedAt: null, enabled: true, activeRevisionId: { not: null }, ownerUserId: null },
      OR: [
        { userId },
        ...(memberGroupIds.length > 0 ? [{ groupId: { in: [...memberGroupIds] } }] : [])
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

/**
 * The owner's new Assistant inside the caller's transaction: every linked
 * Skill must be usable by the owner. Version 1.
 */
export async function createAssistantInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  draft: AssistantDraft
): Promise<AssistantCreateResult> {
  const links = rowSkillLinks(draft.rows);
  if (!await lockAndCheckSkillDependencies(tx, userId, links.skillIds)) {
    return { kind: "skills_not_available" as const };
  }
  const definition = await tx.assistantDefinition.create({
    data: { ...contentDraftData(draft), ownerUserId: userId }
  });
  await createAssistantSkillLinks(tx, definition.id, links.skillIds, links.skillModes);
  return { assistantId: definition.id, kind: "ok" as const };
}

/**
 * A revision of the owner's Assistant inside the caller's transaction,
 * guarded by its version: usable Skills that reach every audience it is
 * published to, then the content and links replace the old ones and the
 * version increments. A serialization failure propagates to the caller.
 */
export async function updateAssistantInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  assistantId: string,
  expectedVersion: number,
  draft: AssistantDraft
): Promise<AssistantWriteResult> {
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
  const links = rowSkillLinks(draft.rows);
  if (!await lockAndCheckSkillDependencies(tx, userId, links.skillIds)) {
    return { kind: "skills_not_available" as const };
  }

  const publications = await tx.assistantPublication.findMany({
    select: { groupId: true, scope: true }, where: { assistantId }
  });
  for (const audience of publications) {
    if (!await skillsReachPublicationAudience(tx, links.skillIds, audience)) {
      return { kind: "skill_audience_mismatch" as const };
    }
  }
  await tx.assistantDefinition.update({
    data: { ...contentDraftData(draft), version: { increment: 1 } },
    where: { id: assistantId }
  });
  await tx.assistantSkill.deleteMany({ where: { assistantId } });
  await createAssistantSkillLinks(tx, assistantId, links.skillIds, links.skillModes);
  return { assistantId, kind: "ok" as const };
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
  // Shared locks: writers serialize, while independent readers and run
  // admission remain compatible.
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

function usableSkillWhere(userId: string): Prisma.SkillDefinitionWhereInput {
  return {
    archivedAt: null,
    currentRevisionId: { not: null },
    deletedAt: null,
    OR: [
      { ownerUserId: userId },
      {
        sharedRevisionId: { not: null },
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
  };
}

async function skillDependenciesAvailable(
  tx: Prisma.TransactionClient,
  userId: string,
  skillIds: readonly string[]
): Promise<boolean> {
  const ids = distinctSortedSkillIds(skillIds);
  if (ids.length === 0) return true;
  const available = await tx.skillDefinition.count({
    where: { ...usableSkillWhere(userId), id: { in: ids } }
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
      sharedRevisionId: { not: null },
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

/** Names of linked Skills that keep the audience from being reached; empty when all reach it. */
export async function unreachedPublicationSkillNames(
  tx: Prisma.TransactionClient,
  definition: Readonly<{ id: string; ownerUserId: string }>,
  audience: Readonly<{ groupId: string | null; scope: "group" | "installation" }>
): Promise<string[]> {
  const links = await tx.assistantSkill.findMany({
    orderBy: { ordinal: "asc" },
    select: { skillId: true, skill: { select: { ownerUserId: true, currentRevision: { select: { name: true } }, sharedRevision: { select: { name: true } } } } },
    where: { assistantId: definition.id }
  });
  if (await skillsReachPublicationAudience(tx, links.map((link) => link.skillId), audience)) return [];
  const names: string[] = [];
  for (const link of links) {
    if (await skillsReachPublicationAudience(tx, [link.skillId], audience)) continue;
    // Only the owner's own unapproved Skill names are shown; others stay neutral.
    names.push(link.skill.sharedRevision?.name ??
      (link.skill.ownerUserId === definition.ownerUserId ? link.skill.currentRevision?.name : undefined) ?? "Unavailable Skill");
  }
  return names.length > 0 ? names : ["Unavailable Skill"];
}

/** Skills among `skillIds` the user can link: their own, or shared with them. */
export async function usableSkillIds(
  tx: Pick<Prisma.TransactionClient, "skillDefinition">,
  userId: string,
  skillIds: readonly string[]
): Promise<Set<string>> {
  if (skillIds.length === 0) return new Set();
  const usable = await tx.skillDefinition.findMany({
    select: { id: true },
    where: { ...usableSkillWhere(userId), id: { in: [...skillIds] } }
  });
  return new Set(usable.map(({ id }) => id));
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
    providerModel: contentSelect.providerModel,
    publications: { include: { group: { select: { archivedAt: true, name: true } } } }
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
    // Archived Assistants keep a stored position but are never Featured.
    const featuredOrder = definition.archivedAt ? null : definition.publications.find((publication) =>
      publication.scope === "installation")?.featuredOrder ?? null;

    return {
      archived: definition.archivedAt !== null,
      // From the stored publications, which archiving the Assistant keeps; a
      // publication to an archived group reaches no one and is left out.
      audience: owned
        ? {
            everyone: definition.publications.some((publication) => publication.scope === "installation"),
            groupNames: definition.publications
              .flatMap((publication) =>
                publication.scope === "group" && publication.group && publication.group.archivedAt === null
                  ? [publication.group.name]
                  : [])
              .sort((left, right) => left.localeCompare(right))
          }
        : null,
      featured: featuredOrder !== null,
      featuredOrder,
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
      published: definition.publications.length > 0,
      content: contentRow(definition, userId),
      updatedAt: definition.updatedAt,
      version: definition.version
    };
  }

  /** Dense Featured positions replace stored ones, which may have gaps after an unlist. */
  function withFeaturedOrder<T extends AssistantAccessEntry>(entry: T, orders: ReadonlyMap<string, number>): T {
    const featuredOrder = orders.get(entry.id) ?? null;
    return { ...entry, featured: featuredOrder !== null, featuredOrder };
  }

  const loadAccessEntry = (userId: string, assistantId: string) =>
    loadAccessEntryWith(client, userId, assistantId);

  const repository = {
    async create(userId: string, draft: AssistantDraft): Promise<AssistantCreateResult> {
      return client.$transaction((tx) => createAssistantInTransaction(tx, userId, draft));
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
            // The provisional source read discovers the exact dependency ids;
            // the locked re-read below is authority.
            await lockAssistantPublicationRowsForDuplicate(tx, assistantId);
            const provisionalSource = await loadAccessEntryWith(tx, userId, assistantId);
            if (!provisionalSource) return { kind: "not_found" as const };
            const skillIds = distinctSortedSkillIds(provisionalSource.content.skillIds);
            // A missing Skill is one the copier cannot use: its link is
            // dropped below instead of failing the copy.
            await lockSkillDefinitionRows(tx, skillIds);
            await lockActiveMemberGroupRows(tx, userId);
            const source = await loadAccessEntryWith(tx, userId, assistantId);
            if (!source || source.version !== provisionalSource.version) {
              return { kind: "not_found" as const };
            }
            // Without a catalog the copier can use no catalog resource: the
            // copy keeps inherit values and downgrades every concrete one.
            const copied = assistantRowsForCopier(source.content.rows,
              catalogView ?? emptyAssistantCatalogView(options.now?.() ?? new Date()), {
              skillIds: await usableSkillIds(tx, userId, skillIds)
            });

            const copyName = `Copy of ${source.content.name}`.slice(0, 80);
            const definition = await tx.assistantDefinition.create({
              data: {
                ownerUserId: userId,
                // Rows the copier can use keep their value and policy.
                ...rowColumnsData(copied.rows),
                answerRules: source.content.answerRules,
                avatar: source.content.avatar as Prisma.InputJsonValue,
                category: source.content.category,
                description: source.content.description,
                responseReminder: source.content.responseReminder ?? "",
                name: copyName,
                starterPrompts: [...source.content.starterPrompts],
                systemPrompt: source.content.systemPrompt
              }
            });
            const links = rowSkillLinks(copied.rows);
            await createAssistantSkillLinks(tx, definition.id, links.skillIds, links.skillModes);
            return { assistantId: definition.id, kind: "ok" as const, report: copied.report };
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

    async getDetail(
      userId: string,
      assistantId: string,
      options: { isAdmin?: boolean } = {}
    ): Promise<AssistantDetailData | null> {
      const loaded = await loadAccessEntry(userId, assistantId);
      if (!loaded) return null;
      const [[available], featuredOrders] = await Promise.all([
        withAssistantDependencyAvailability(client, userId, [loaded]),
        loadFeaturedAssistantOrders(client)
      ]);
      if (!available) return null;
      const entry = withFeaturedOrder(available, featuredOrders);
      if (!entry.owned) return { ...entry, publications: null };
      const [publications, listingRequest, chatCounts] = await Promise.all([
        client.assistantPublication.findMany({
          include: {
            group: { select: { name: true } }
          },
          orderBy: { createdAt: "asc" },
          where: { assistantId }
        }),
        loadAssistantListingStatus(client, { assistantId, isAdmin: options.isAdmin === true, userId }),
        loadAssistantRecentChatCounts(client, [assistantId])
      ]);
      return {
        ...entry,
        listingRequest,
        publications: publications.map(publicationRow),
        recentChatCount: chatCounts.get(assistantId) ?? 0
      };
    },

    async listForUser(userId: string): Promise<AssistantAccessEntry[]> {
      const memberGroupIds = await activeMemberGroupIds(client, userId);
      const [definitions, featuredOrders] = await Promise.all([
        client.assistantDefinition.findMany({
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
        }),
        loadFeaturedAssistantOrders(client)
      ]);
      const entries = definitions.map((definition) =>
        projectAccessEntry(definition, userId, memberGroupIds, definition.pins.length > 0)
      ).filter((entry): entry is AssistantAccessEntry => entry !== null)
        .map((entry) => withFeaturedOrder(entry, featuredOrders));
      const available = await withAssistantDependencyAvailability(client, userId, entries);
      return available.sort((left, right) =>
        left.content.name.localeCompare(right.content.name) || left.id.localeCompare(right.id));
    },

    /**
     * Assistants of the user's latest personal chats, newest first, limited
     * to `candidateIds` (the Assistants the list returns).
     */
    async loadRecentAssistantIds(userId: string, candidateIds: readonly string[]): Promise<string[]> {
      const ids = [...new Set(candidateIds)];
      if (ids.length === 0) return [];
      const rows = await client.$queryRaw<Array<{ assistantId: string }>>(Prisma.sql`
        SELECT chat."assistantId"
        FROM "Chat" AS chat
        WHERE chat."userId" = ${userId}
          AND chat."assistantId" IN (${Prisma.join(ids)})
          AND chat."archived" = false
          AND chat."permanentDeletionAt" IS NULL
          AND chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
        GROUP BY chat."assistantId"
        ORDER BY MAX(chat."updatedAt") DESC, chat."assistantId"
        LIMIT ${ASSISTANT_MAX_RECENT}
      `);
      return rows.map((row) => row.assistantId);
    },

    async update(
      userId: string,
      assistantId: string,
      expectedVersion: number,
      draft: AssistantDraft
    ): Promise<AssistantWriteResult> {
      try {
        return await client.$transaction((tx) => updateAssistantInTransaction(tx, userId, assistantId, expectedVersion, draft));
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
        // Memory admission holds the owner before the definition. Keep the
        // same order before the availability hook acquires Memory settings.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
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
        if (archived) {
          // Archiving withdraws the owner's pending listing request. The
          // definition row lock above is the one the listing service takes, so
          // a concurrent decision either sees the withdrawal or wins first.
          await tx.assistantListingRequest.updateMany({
            data: { state: "withdrawn" },
            where: { assistantId, state: "pending" }
          });
        }
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
          Array<{ archivedAt: Date | null; id: string; version: number }>
        >`
          SELECT "id", "archivedAt", "version"
          FROM "AssistantDefinition"
          WHERE "id" = ${input.assistantId} AND "ownerUserId" = ${input.userId}
          FOR UPDATE
        `;
        const definition = locked[0];
        if (!definition) return { kind: "not_found" as const };
        // Checked under the row lock: a definition saved since the proposal is not published.
        if (input.expectedVersion !== undefined && definition.version !== input.expectedVersion) {
          return { kind: "version_conflict" as const };
        }
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
          return {
            kind: "skill_audience_mismatch" as const,
            skillNames: await unreachedPublicationSkillNames(
              tx,
              { id: input.assistantId, ownerUserId: input.userId },
              { groupId: input.groupId, scope: input.scope }
            )
          };
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
    }, transaction?: Prisma.TransactionClient): Promise<"not_found" | "revoked"> {
      // A caller's transaction (administrator unlist) keeps its own recheck.
      const revoke = async (tx: Prisma.TransactionClient) => {
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
      };
      return transaction ? revoke(transaction) : client.$transaction(revoke);
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

    async listPublishableGroups(userId: string): Promise<AssistantPublishableGroup[]> {
      // One statement for any number of groups; members count while their account is active.
      const memberships = await client.userGroup.findMany({
        select: { group: { select: {
          _count: { select: { users: { where: { user: { status: "active" } } } } }, id: true, name: true
        } } },
        where: { group: { archivedAt: null }, userId }
      });
      return memberships
        .map(({ group }) => ({ id: group.id, memberCount: group._count.users, name: group.name }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    /** The stored personal default, before any visibility check. */
    async loadDefaultAssistantId(userId: string): Promise<string | null> {
      const settings = await client.userSettings.findUnique({
        select: { defaultAssistantId: true },
        where: { userId }
      });
      return settings?.defaultAssistantId ?? null;
    },

    async loadUserAccessibleMcpServerIds(userId: string): Promise<Set<string>> {
      return loadUserAccessibleMcpServerIdsWith(client, userId);
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
    async resolveForRun(userId, assistantId): Promise<AssistantRunResolution> {
      return resolveConsistentDefinition(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AssistantDefinition"
          WHERE "id" = ${assistantId} FOR SHARE`;
        const entry = await loadAccessEntryWith(tx, userId, assistantId);
        if (!entry || entry.archived) {
          return { code: "assistant_not_available", ok: false, status: 404 };
        }
        // Admission resolves every row through the chain against the
        // runner's catalog: inherit, an unusable model, Search or Tools value
        // and each Skill link are decided there, so a dependency failure is
        // the neutral conflict, not "not found".
        const model = entry.content.providerModelId === null
          ? null
          : await tx.providerModel.findUnique({
              select: { connectionId: true, modelClass: true },
              where: { id: entry.content.providerModelId }
            });
        return materialize(entry.content, entry.version,
          model?.modelClass === "answer" ? model.connectionId : null);
      });
    }
  };

  function materialize(content: AssistantContentRow, version: number, provider: string | null): AssistantRunResolution {
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
      responseReminder: content.responseReminder ?? "",
      answerRules: content.answerRules ?? null,
      mcpServerIds: [...content.mcpServerIds],
      name: content.name,
      provider,
      providerModelId: content.providerModelId,
      rows: content.rows,
      runControls,
      searchPlan: searchPlan.plan,
      skillIds: [...content.skillIds],
      skillModes: content.skillModes ?? Object.fromEntries(content.skillIds.map((id) => [id, "pinned" as const])),
      skills: content.skills ?? { mode: "auto" },
      systemPrompt: content.systemPrompt
    };
    return { assistant, ok: true };
  }

  return { ...repository, ...runResolver };
}

export type PrismaAssistantRepository = ReturnType<typeof createPrismaAssistantRepository>;
