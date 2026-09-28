import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AdminAssistantDefinitionReview,
  AdminAssistantListingRequestDetail,
  AdminAssistantListingRequestSummary,
  AdminAssistantResourceName
} from "../../contracts/adminAssistants";
import type {
  AssistantListingRequestState,
  AssistantListingRequestSummary,
  AssistantListingStatus
} from "../../contracts/assistantListing";
import { decodeAssistantAvatarRecipe, type AssistantRows } from "../../contracts/assistants";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { skillAccessWhere } from "../skills/prismaRepository";
import type { AssistantCatalogView } from "./catalogValidation";
import { viewerRows } from "./handlers";
import {
  AssistantListingError,
  countReviewableAssistantListingRequests,
  encodeListingCursor,
  requireActiveAdmin,
  runListingTransaction
} from "./listingShared";
import { createPrismaAssistantRepository, openableKnowledgeResources, unreachedPublicationSkillNames } from "./prismaRepository";
import { assistantRowsFromStoredColumns } from "./storedContent";

type LockedDefinition = { archivedAt: Date | null; id: string; ownerUserId: string; version: number };
async function lockDefinition(tx: Prisma.TransactionClient, assistantId: string): Promise<LockedDefinition | null> {
  const [definition] = await tx.$queryRaw<LockedDefinition[]>`
    SELECT "id", "ownerUserId", "version", "archivedAt" FROM "AssistantDefinition" WHERE "id" = ${assistantId} FOR UPDATE`;
  return definition ?? null;
}

/** Every linked Skill must already reach everyone with an approved revision. */
async function requireSkillsReachEveryone(tx: Prisma.TransactionClient, definition: LockedDefinition) {
  const names = await unreachedPublicationSkillNames(tx, definition, { groupId: null, scope: "installation" });
  if (names.length > 0) throw new AssistantListingError("assistant_skill_audience_mismatch", 409, names);
}

type RequestRow = {
  id: string; state: AssistantListingRequestState; definitionVersion: number;
  createdAt: Date; reviewedAt: Date | null; reviewNote: string | null;
};
export function listingRequestSummary(row: RequestRow, currentVersion: number): AssistantListingRequestSummary {
  return { id: row.id, state: row.state, definitionVersion: row.definitionVersion,
    outdated: row.state === "pending" && row.definitionVersion !== currentVersion,
    createdAt: row.createdAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewNote: row.reviewNote };
}

/** Owner projection for Sharing; null for anyone but the owner. */
export async function loadAssistantListingStatus(db: Pick<Prisma.TransactionClient, "assistantDefinition">, input: {
  assistantId: string; userId: string; isAdmin: boolean;
}): Promise<AssistantListingStatus | null> {
  const definition = await db.assistantDefinition.findFirst({ where: { id: input.assistantId, ownerUserId: input.userId },
    select: { version: true, archivedAt: true, publications: { where: { scope: "installation" }, select: { id: true } },
      listingRequests: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
  if (!definition) return null;
  const latest = definition.listingRequests[0];
  const request = latest ? listingRequestSummary(latest, definition.version) : null;
  const listed = definition.publications.length > 0;
  const openRequest = request?.state === "pending" && !request.outdated;
  return { listed, request,
    // Administrators list their own Assistants directly through publication.
    canRequest: !input.isAdmin && !definition.archivedAt && !listed && !openRequest,
    canWithdraw: request?.state === "pending" };
}

const summaryInclude = {
  assistant: { select: { name: true, avatar: true, updatedAt: true, version: true, archivedAt: true, owner: { select: { displayName: true } } } }
} satisfies Prisma.AssistantListingRequestInclude;
type SummaryRecord = Prisma.AssistantListingRequestGetPayload<{ include: typeof summaryInclude }>;

function adminSummary(row: SummaryRecord): AdminAssistantListingRequestSummary {
  const summary = listingRequestSummary(row, row.assistant.version);
  return { ...summary, assistantId: row.assistantId, name: row.assistant.name, avatar: decodeAssistantAvatarRecipe(row.assistant.avatar),
    ownerDisplayName: row.assistant.owner.displayName, updatedAt: row.assistant.updatedAt.toISOString(),
    canReview: row.state === "pending" && !summary.outdated && !row.assistant.archivedAt };
}

const reviewSelect = {
  version: true, name: true, description: true, category: true, avatar: true, systemPrompt: true, answerRules: true,
  responseReminder: true, starterPrompts: true, modelPolicy: true, controlsPolicy: true, searchPolicy: true, toolsPolicy: true,
  knowledgePolicy: true, skillsPolicy: true, mcpMode: true, mcpServerIds: true, searchPlan: true, knowledgeSelection: true,
  skillsMode: true, providerModelId: true, runControls: true,
  skillLinks: { orderBy: { ordinal: "asc" as const }, select: { skillId: true, mode: true } }
} satisfies Prisma.AssistantDefinitionSelect;
type ReviewRecord = Prisma.AssistantDefinitionGetPayload<{ select: typeof reviewSelect }>;

/**
 * What the reviewing administrator can use themselves: the viewer side of the
 * consumer projection, plus names of the definition's resources they can open.
 */
export type ListingReviewer = {
  catalog: Pick<AssistantCatalogView, "accessibleMcpServerIds" | "entitledSearchOptionIds" | "modelById">;
  names: Readonly<Record<"knowledgeBases" | "knowledgeSources" | "mcpServers" | "searchOptions" | "skills", ReadonlyMap<string, string>>>;
  visibleKnowledge: Readonly<{ baseIds: readonly string[]; sourceIds: readonly string[] }>;
};
export type ListingReviewerLoader = (tx: Prisma.TransactionClient, userId: string, rows: AssistantRows) => Promise<ListingReviewer>;

/** The Knowledge resources of the definition's explicit selection the user may open, with names. */
async function openableKnowledge(tx: Prisma.TransactionClient, userId: string, rows: AssistantRows) {
  const value = rows.knowledge.value;
  if (value.mode !== "explicit") return { bases: new Map<string, string>(), sources: new Map<string, string>() };
  return openableKnowledgeResources(tx, userId, value);
}

/** Loads the reviewer from the administrator's own catalog, MCP grants, Knowledge and Skills. */
export function createListingReviewerLoader(db: PrismaClient): ListingReviewerLoader {
  let assistants: ReturnType<typeof createPrismaAssistantRepository> | undefined;
  return async (tx, userId, rows) => {
    const catalogData = await createPrismaCatalogDataLoader({
      loadEntitlements: (catalogUserId) => loadEntitlementsForUser(catalogUserId, tx), prisma: tx
    })(userId);
    const selection = catalogData ? resolveCurrentUserCatalogSelection(catalogData) : null;
    assistants ??= createPrismaAssistantRepository(db);
    const accessibleMcpServerIds = await assistants.loadUserAccessibleMcpServerIds(userId);
    const tools = rows.tools.value;
    const serverIds = tools.mode === "exact" ? tools.serverIds.filter((id) => accessibleMcpServerIds.has(id)) : [];
    const skillIds = rows.skills.value.links.map((link) => link.skillId);
    // One interactive transaction runs its queries one at a time.
    const knowledge = await openableKnowledge(tx, userId, rows);
    const servers = serverIds.length > 0
      ? await tx.mcpServer.findMany({ select: { id: true, displayName: true }, where: { id: { in: serverIds } } })
      : [];
    const skills = skillIds.length > 0
      ? await tx.skillDefinition.findMany({
          select: { id: true, ownerUserId: true, currentRevision: { select: { name: true } }, sharedRevision: { select: { name: true } } },
          where: { AND: [{ id: { in: skillIds }, deletedAt: null }, skillAccessWhere(userId)] }
        })
      : [];
    const strategies = selection?.entitledStrategies ?? [];
    return {
      catalog: {
        accessibleMcpServerIds,
        entitledSearchOptionIds: new Set(strategies.map((strategy) => strategy.strategyId)),
        modelById: new Map((selection?.models ?? []).map((model) => [model.modelId, model]))
      },
      names: {
        knowledgeBases: knowledge.bases,
        knowledgeSources: knowledge.sources,
        mcpServers: new Map(servers.map((server) => [server.id, server.displayName])),
        searchOptions: new Map(strategies.map((strategy) => [strategy.strategyId, strategy.displayName])),
        skills: new Map(skills.flatMap((skill) => {
          const revision = skill.ownerUserId === userId ? skill.currentRevision : skill.sharedRevision;
          return revision ? [[skill.id, revision.name] as const] : [];
        }))
      },
      visibleKnowledge: { baseIds: [...knowledge.bases.keys()], sourceIds: [...knowledge.sources.keys()] }
    };
  };
}

/**
 * Rows as the administrator may see them, through the consumer projection,
 * with names only for what that projection identifies.
 */
export function reviewRowsFor(rows: AssistantRows, reviewer: ListingReviewer): Pick<AdminAssistantDefinitionReview, "names" | "rows"> {
  const projected = viewerRows({ rows, skillSummaries: [...reviewer.names.skills].map(([id, name]) => ({ id, name })) },
    reviewer.catalog, { owned: false, visibleKnowledge: reviewer.visibleKnowledge });
  const named = (ids: readonly string[], names: (id: string) => string | undefined): AdminAssistantResourceName[] =>
    ids.flatMap((id) => { const name = names(id); return name === undefined ? [] : [{ id, name }]; });
  const knowledge = projected.knowledge.value, model = projected.model.value, search = projected.search.value;
  const skills = projected.skills.value, tools = projected.tools.value;
  return {
    rows: projected,
    names: {
      knowledgeBases: knowledge.mode === "explicit" ? named(knowledge.baseIds, (id) => reviewer.names.knowledgeBases.get(id)) : [],
      knowledgeSources: knowledge.mode === "explicit" ? named(knowledge.sourceIds, (id) => reviewer.names.knowledgeSources.get(id)) : [],
      mcpServers: tools.mode === "exact" ? named(tools.serverIds, (id) => reviewer.names.mcpServers.get(id)) : [],
      models: model.mode === "model" && model.modelId !== null
        ? named([model.modelId], (id) => reviewer.catalog.modelById.get(id)?.displayName) : [],
      searchOptions: "optionIds" in search ? named(search.optionIds, (id) => reviewer.names.searchOptions.get(id)) : [],
      skills: named(skills.links.map((link) => link.skillId), (id) => reviewer.names.skills.get(id))
    }
  };
}

function storedRows(row: ReviewRecord): AssistantRows {
  const rows = assistantRowsFromStoredColumns(row);
  if (!rows) throw new Error("assistant_definition_integrity_invalid");
  return rows;
}

function definitionReview(row: ReviewRecord, setup: Pick<AdminAssistantDefinitionReview, "names" | "rows">): AdminAssistantDefinitionReview {
  return { version: row.version, name: row.name, description: row.description, category: row.category,
    avatar: decodeAssistantAvatarRecipe(row.avatar), instructions: row.systemPrompt, answerRules: row.answerRules ?? "",
    responseReminder: row.responseReminder, starterPrompts: [...row.starterPrompts], ...setup };
}

export type ListingCursor = { id: string; createdAt: Date };

export function createAssistantListingService(db: PrismaClient, options: { loadReviewer?: ListingReviewerLoader } = {}) {
  const loadReviewer = options.loadReviewer ?? createListingReviewerLoader(db);
  return {
    status(userId: string, assistantId: string, isAdmin: boolean) {
      return loadAssistantListingStatus(db, { assistantId, userId, isAdmin });
    },
    request(userId: string, assistantId: string, expectedVersion: number) {
      return runListingTransaction(db, async (tx) => {
        const definition = await lockDefinition(tx, assistantId);
        if (!definition || definition.ownerUserId !== userId) throw new AssistantListingError("assistant_not_available", 404);
        const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
          SELECT "role" FROM "User" WHERE "id" = ${userId} AND "status" = 'active' FOR SHARE`;
        if (!actor) throw new AssistantListingError("assistant_not_available", 404);
        if (actor.role === "admin") throw new AssistantListingError("assistant_listing_request_not_needed");
        if (definition.archivedAt) throw new AssistantListingError("assistant_archived");
        if (definition.version !== expectedVersion) throw new AssistantListingError("assistant_version_conflict");
        if (await tx.assistantPublication.count({ where: { assistantId, scope: "installation" } }) > 0) {
          throw new AssistantListingError("assistant_already_listed");
        }
        const pending = await tx.assistantListingRequest.findFirst({ where: { assistantId, state: "pending" } });
        // A lost response retried at the same version keeps the open review.
        if (pending?.definitionVersion === definition.version) return;
        await requireSkillsReachEveryone(tx, definition);
        const latest = await tx.assistantListingRequest.findFirst({ where: { assistantId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        // Keep the owner's latest-request projection in serialized write order,
        // even with a backward clock jump or several requests in one millisecond.
        const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1));
        await tx.assistantListingRequest.updateMany({ where: { assistantId, state: "pending" }, data: { state: "superseded" } });
        await tx.assistantListingRequest.create({ data: { assistantId, requestedByUserId: userId, definitionVersion: definition.version, createdAt } });
      });
    },
    withdraw(userId: string, assistantId: string, requestId: string) {
      return runListingTransaction(db, async (tx) => {
        const definition = await lockDefinition(tx, assistantId);
        if (!definition || definition.ownerUserId !== userId) throw new AssistantListingError("assistant_not_available", 404);
        const result = await tx.assistantListingRequest.updateMany({ where: { id: requestId, assistantId, state: "pending" }, data: { state: "withdrawn" } });
        if (result.count !== 1) throw new AssistantListingError("assistant_listing_request_conflict");
      });
    },
    listRequests(userId: string, input: { limit: number; cursor?: ListingCursor }) {
      return runListingTransaction(db, async (tx) => {
        await requireActiveAdmin(tx, userId);
        // Only pending requests carry the owner's consent to show the Assistant.
        const rows = await tx.assistantListingRequest.findMany({ where: { state: "pending",
          ...(input.cursor ? { OR: [{ createdAt: { lt: input.cursor.createdAt } }, { createdAt: input.cursor.createdAt, id: { gt: input.cursor.id } }] } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: input.limit + 1, include: summaryInclude });
        const page = rows.slice(0, input.limit), last = page.at(-1);
        return { state: "requests" as const, requests: page.map(adminSummary), pendingCount: await countReviewableAssistantListingRequests(tx),
          nextCursor: rows.length > input.limit && last ? encodeListingCursor({ id: last.id, createdAt: last.createdAt.toISOString() }) : null };
      });
    },
    detail(userId: string, requestId: string) {
      return runListingTransaction(db, async (tx): Promise<AdminAssistantListingRequestDetail> => {
        await requireActiveAdmin(tx, userId);
        const row = await tx.assistantListingRequest.findFirst({ where: { id: requestId, state: "pending" }, include: summaryInclude });
        if (!row) throw new AssistantListingError("assistant_listing_request_not_available", 404);
        const summary = adminSummary(row);
        // The definition is readable only while it is exactly the requested version.
        const definition = summary.canReview
          ? await tx.assistantDefinition.findUnique({ where: { id: row.assistantId }, select: reviewSelect })
          : null;
        if (!definition || definition.version !== row.definitionVersion) return { ...summary, definition: null };
        const rows = storedRows(definition);
        return { ...summary, definition: definitionReview(definition, reviewRowsFor(rows, await loadReviewer(tx, userId, rows))) };
      });
    },
    decide(userId: string, requestId: string, action: "approve" | "reject", note: string | null) {
      return runListingTransaction(db, async (tx) => {
        await requireActiveAdmin(tx, userId);
        const request = await tx.assistantListingRequest.findUnique({ where: { id: requestId }, select: { assistantId: true, state: true } });
        if (!request) throw new AssistantListingError("assistant_listing_request_not_available", 404);
        const definition = await lockDefinition(tx, request.assistantId);
        if (!definition) throw new AssistantListingError("assistant_listing_request_not_available", 404);
        const pending = await tx.assistantListingRequest.findFirst({ where: { id: requestId, state: "pending" } });
        if (!pending) throw new AssistantListingError("assistant_listing_request_conflict");
        if (definition.archivedAt || definition.version !== pending.definitionVersion) {
          throw new AssistantListingError("assistant_listing_request_outdated");
        }
        if (action === "approve") {
          await requireSkillsReachEveryone(tx, definition);
          const listed = await tx.assistantPublication.findFirst({ where: { assistantId: definition.id, scope: "installation" }, select: { id: true } });
          if (!listed) {
            await tx.assistantPublication.create({ data: { assistantId: definition.id, scope: "installation", groupId: null, publishedByUserId: userId } });
          }
        }
        const result = await tx.assistantListingRequest.updateMany({ where: { id: requestId, state: "pending" }, data: {
          state: action === "approve" ? "approved" : "rejected", reviewedByUserId: userId, reviewedAt: new Date(), reviewNote: note
        } });
        if (result.count !== 1) throw new AssistantListingError("assistant_listing_request_conflict");
        return adminSummary(await tx.assistantListingRequest.findUniqueOrThrow({ where: { id: requestId }, include: summaryInclude }));
      });
    }
  };
}
export type AssistantListingService = ReturnType<typeof createAssistantListingService>;
