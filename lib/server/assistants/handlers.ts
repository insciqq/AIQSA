import {
  decodeAssistantAvatarRecipe,
  decodeAssistantDraft,
  decodeAssistantRunControls,
  type AssistantAvailability,
  type AssistantDetail,
  type AssistantDetailResponse,
  type AssistantDraft,
  type AssistantListResponse,
  type AssistantPublicationResponse,
  type AssistantRevisionContent,
  type AssistantRevisionsResponse,
  type AssistantSummary
} from "../../contracts/assistants";
import { decodeSearchPlan } from "../../contracts/search";
import { assistantRevisionChangedSections } from "../../domain/assistants";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  resolveCurrentUserCatalogSelection,
  type CatalogData
} from "../catalog/currentUserCatalog";
import type {
  AssistantAccessEntry,
  AssistantRevisionRow,
  PrismaAssistantRepository
} from "./prismaRepository";

export type AssistantHandlerDeps = {
  loadCatalogData(userId: string): Promise<CatalogData | null>;
  repository: Pick<
    PrismaAssistantRepository,
    | "create"
    | "duplicate"
    | "getDetail"
    | "getRevision"
    | "listForUser"
    | "listPublishableGroups"
    | "listRevisions"
    | "loadUserAccessibleMcpServerIds"
    | "publish"
    | "revise"
    | "revokePublication"
    | "setArchived"
    | "setPinned"
  >;
  resolveAuth: RequestAuthResolver;
};

type RunnerCatalogView = {
  entitledSearchOptionIds: Set<string>;
  mcpServerIds: Set<string>;
  modelLabelById: Map<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function errorJson(code: string, status: number, message?: string): Response {
  return Response.json({ error: code, ...(message ? { message } : {}) }, { status });
}

async function runnerCatalogView(
  deps: AssistantHandlerDeps,
  userId: string
): Promise<RunnerCatalogView | null> {
  const [catalogData, mcpServerIds] = await Promise.all([
    deps.loadCatalogData(userId),
    deps.repository.loadUserAccessibleMcpServerIds(userId)
  ]);
  if (!catalogData) return null;
  const selection = resolveCurrentUserCatalogSelection(catalogData);
  return {
    entitledSearchOptionIds: new Set(
      selection.entitledStrategies.map((strategy) => strategy.strategyId)
    ),
    mcpServerIds,
    modelLabelById: new Map(
      selection.models.map((model) => [model.modelId, model.displayName])
    )
  };
}

function decodeStoredRevision(revision: AssistantRevisionRow): {
  avatar: NonNullable<ReturnType<typeof decodeAssistantAvatarRecipe>>;
  runControls: NonNullable<ReturnType<typeof decodeAssistantRunControls>>;
  searchPlan: { mode: "all_selected" | "model_choice"; optionIds: string[] };
} {
  const avatar = decodeAssistantAvatarRecipe(revision.avatar);
  const runControls = decodeAssistantRunControls(revision.runControls ?? {});
  const searchPlan = decodeSearchPlan(revision.searchPlan);
  if (!avatar || !runControls || !searchPlan.ok) {
    throw new Error("assistant_revision_integrity_invalid");
  }
  return {
    avatar,
    runControls,
    searchPlan: {
      mode: searchPlan.plan.mode,
      optionIds: [...searchPlan.plan.optionIds]
    }
  };
}

function assistantCategory(value: string | null): AssistantSummary["category"] {
  return value === null ? null : (value as AssistantSummary["category"]);
}

function availabilityFor(
  revision: AssistantRevisionRow,
  searchPlanOptionIds: readonly string[],
  view: RunnerCatalogView
): AssistantAvailability {
  if (!view.modelLabelById.has(revision.providerModelId)) {
    return { ok: false, reason: "model_access" };
  }
  if (searchPlanOptionIds.some((optionId) => !view.entitledSearchOptionIds.has(optionId))) {
    return { ok: false, reason: "search_access" };
  }
  if (revision.mcpServerIds.some((serverId) => !view.mcpServerIds.has(serverId))) {
    return { ok: false, reason: "tools_access" };
  }
  return { ok: true };
}

function summaryFromEntry(entry: AssistantAccessEntry, view: RunnerCatalogView): AssistantSummary {
  const decoded = decodeStoredRevision(entry.revision);
  const availability = availabilityFor(entry.revision, decoded.searchPlan.optionIds, view);
  return {
    archived: entry.archived,
    availability,
    avatar: decoded.avatar,
    category: assistantCategory(entry.revision.category),
    description: entry.revision.description,
    fingerprint: {
      mcpServerCount: entry.revision.mcpServerIds.length,
      modelLabel: view.modelLabelById.get(entry.revision.providerModelId) ?? null,
      reasoningEffort: decoded.runControls.reasoningEffort ?? null,
      searchOptionCount: decoded.searchPlan.optionIds.length
    },
    id: entry.id,
    name: entry.revision.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    pinned: entry.pinned,
    published: entry.published,
    revisionNumber: entry.revision.revisionNumber,
    scope: entry.owned
      ? { kind: "owner" }
      : entry.memberGroupNames.length > 0
        ? { groupNames: entry.memberGroupNames, kind: "group" }
        : { kind: "installation" },
    starterPrompts: [...entry.revision.starterPrompts],
    updatedAt: entry.updatedAt.toISOString()
  };
}

function revisionContent(
  revision: AssistantRevisionRow,
  view: RunnerCatalogView,
  options: { owned: boolean }
): AssistantRevisionContent {
  const decoded = decodeStoredRevision(revision);
  const modelVisible = view.modelLabelById.has(revision.providerModelId);
  return {
    authorDisplayName: revision.authorDisplayName,
    avatar: decoded.avatar,
    category: assistantCategory(revision.category),
    createdAt: revision.createdAt.toISOString(),
    description: revision.description,
    developerPrompt: revision.developerPrompt,
    // Consumers never learn hidden dependency ids: unresolvable model ids
    // project as null and MCP ids narrow to the runner's accessible servers.
    mcpServerIds: options.owned
      ? [...revision.mcpServerIds]
      : revision.mcpServerIds.filter((serverId) => view.mcpServerIds.has(serverId)),
    name: revision.name,
    providerModelId: options.owned || modelVisible ? revision.providerModelId : null,
    revisionNumber: revision.revisionNumber,
    runControls: decoded.runControls,
    searchPlan: decoded.searchPlan,
    starterPrompts: [...revision.starterPrompts],
    systemPrompt: revision.systemPrompt
  };
}

function detailFromEntry(
  entry: AssistantAccessEntry & {
    publications: import("./prismaRepository").AssistantPublicationRow[] | null;
    revisionCount: number | null;
  },
  view: RunnerCatalogView
): AssistantDetail {
  const decoded = decodeStoredRevision(entry.revision);
  return {
    archived: entry.archived,
    availability: availabilityFor(entry.revision, decoded.searchPlan.optionIds, view),
    id: entry.id,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    pinned: entry.pinned,
    ...(entry.publications
      ? {
          publications: entry.publications.map((publication) => ({
            groupId: publication.groupId,
            groupName: publication.groupName,
            id: publication.id,
            revisionNumber: publication.revisionNumber,
            scope: publication.scope,
            updatedAt: publication.updatedAt.toISOString()
          }))
        }
      : {}),
    revision: revisionContent(entry.revision, view, { owned: entry.owned }),
    ...(entry.revisionCount !== null ? { revisionCount: entry.revisionCount } : {}),
    ...(entry.owned ? { version: entry.version } : {})
  };
}

function validateDraftAgainstCatalog(
  draft: AssistantDraft,
  view: RunnerCatalogView
): Response | null {
  if (!view.modelLabelById.has(draft.providerModelId)) {
    return errorJson("assistant_model_not_available", 400);
  }
  if (
    draft.searchPlan.optionIds.some(
      (optionId) => !view.entitledSearchOptionIds.has(optionId)
    )
  ) {
    return errorJson("assistant_search_option_not_available", 400);
  }
  if (draft.mcpServerIds.some((serverId) => !view.mcpServerIds.has(serverId))) {
    return errorJson("assistant_tools_not_available", 400);
  }
  return null;
}

async function authAndView(
  deps: AssistantHandlerDeps,
  request: Request
): Promise<
  | { response: Response }
  | { auth: { isAdmin: boolean; userId: string }; view: RunnerCatalogView }
> {
  const session = await deps.resolveAuth(request);
  if (!session) {
    return { response: errorJson("unauthorized", 401) };
  }
  const view = await runnerCatalogView(deps, session.userId);
  if (!view) {
    return { response: errorJson("unauthorized", 401) };
  }
  return {
    auth: { isAdmin: session.user.role === "admin", userId: session.userId },
    view
  };
}

async function routeParam(
  context: { params: Promise<Record<string, string>> | Record<string, string> },
  key: string
): Promise<string> {
  const params = await context.params;
  return params[key] ?? "";
}

export function createListAssistantsHandler(deps: AssistantHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const [entries, publishableGroups] = await Promise.all([
      deps.repository.listForUser(resolved.auth.userId),
      deps.repository.listPublishableGroups(resolved.auth.userId)
    ]);
    const assistants = entries.map((entry) => summaryFromEntry(entry, resolved.view));
    return Response.json({
      assistants,
      publishableGroups,
      viewer: { canPublishInstallation: resolved.auth.isAdmin }
    } satisfies AssistantListResponse);
  };
}

export function createCreateAssistantHandler(deps: AssistantHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeAssistantDraft(body ?? {});
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const invalid = validateDraftAgainstCatalog(decoded.draft, resolved.view);
    if (invalid) return invalid;

    const assistantId = await deps.repository.create(resolved.auth.userId, decoded.draft);
    const detail = await deps.repository.getDetail(resolved.auth.userId, assistantId);
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      { assistant: detailFromEntry(detail, resolved.view) } satisfies AssistantDetailResponse,
      { status: 201 }
    );
  };
}

export function createGetAssistantHandler(deps: AssistantHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const assistantId = await routeParam(context, "assistantId");
    const detail = await deps.repository.getDetail(resolved.auth.userId, assistantId);
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      { assistant: detailFromEntry(detail, resolved.view) } satisfies AssistantDetailResponse
    );
  };
}

export function createUpdateAssistantHandler(deps: AssistantHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const assistantId = await routeParam(context, "assistantId");
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    if (!body || typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion)) {
      return errorJson("assistant_draft_invalid", 400);
    }
    const hasRevision = "revision" in body && body.revision !== undefined;
    const hasArchived = "archived" in body && body.archived !== undefined;
    if (hasRevision === hasArchived) {
      return errorJson("assistant_draft_invalid", 400);
    }

    let result;
    if (hasRevision) {
      const decoded = decodeAssistantDraft(body.revision);
      if (!decoded.ok) return errorJson(decoded.code, 400);
      const invalid = validateDraftAgainstCatalog(decoded.draft, resolved.view);
      if (invalid) return invalid;
      result = await deps.repository.revise(
        resolved.auth.userId,
        assistantId,
        body.expectedVersion,
        decoded.draft
      );
    } else {
      if (typeof body.archived !== "boolean") {
        return errorJson("assistant_draft_invalid", 400);
      }
      result = await deps.repository.setArchived(
        resolved.auth.userId,
        assistantId,
        body.expectedVersion,
        body.archived
      );
    }

    if (result.kind === "not_found") return errorJson("assistant_not_available", 404);
    if (result.kind === "version_conflict") return errorJson("assistant_version_conflict", 409);
    if (result.kind === "archived") return errorJson("assistant_archived", 409);

    const detail = await deps.repository.getDetail(resolved.auth.userId, assistantId);
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      { assistant: detailFromEntry(detail, resolved.view) } satisfies AssistantDetailResponse
    );
  };
}

export function createDuplicateAssistantHandler(deps: AssistantHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const assistantId = await routeParam(context, "assistantId");
    const duplicateId = await deps.repository.duplicate(resolved.auth.userId, assistantId);
    if (!duplicateId) return errorJson("assistant_not_available", 404);
    const detail = await deps.repository.getDetail(resolved.auth.userId, duplicateId);
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      { assistant: detailFromEntry(detail, resolved.view) } satisfies AssistantDetailResponse,
      { status: 201 }
    );
  };
}

export function createListAssistantRevisionsHandler(deps: AssistantHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const assistantId = await routeParam(context, "assistantId");
    const revisions = await deps.repository.listRevisions(resolved.auth.userId, assistantId);
    if (!revisions) return errorJson("assistant_not_available", 404);

    const contents = revisions.map((revision) =>
      revisionContent(revision, resolved.view, { owned: true })
    );
    const byNumber = new Map(contents.map((content) => [content.revisionNumber, content]));
    return Response.json({
      revisions: contents.map((content) => ({
        authorDisplayName: content.authorDisplayName,
        changedSections: assistantRevisionChangedSections(
          byNumber.get(content.revisionNumber - 1) ?? null,
          content
        ),
        createdAt: content.createdAt,
        revisionNumber: content.revisionNumber
      }))
    } satisfies AssistantRevisionsResponse);
  };
}

export function createGetAssistantRevisionHandler(deps: AssistantHandlerDeps) {
  return async function GET(
    request: Request,
    context: {
      params:
        | Promise<{ assistantId: string; revisionNumber: string }>
        | { assistantId: string; revisionNumber: string };
    }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const params = await context.params;
    const revisionNumber = Number.parseInt(params.revisionNumber, 10);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      return errorJson("assistant_revision_not_found", 404);
    }
    const revision = await deps.repository.getRevision(
      resolved.auth.userId,
      params.assistantId,
      revisionNumber
    );
    if (!revision) return errorJson("assistant_revision_not_found", 404);
    return Response.json({
      revision: revisionContent(revision, resolved.view, { owned: true })
    });
  };
}

export function createPublishAssistantHandler(deps: AssistantHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const assistantId = await routeParam(context, "assistantId");
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const scope = body?.scope;
    if (scope !== "group" && scope !== "installation") {
      return errorJson("assistant_publication_invalid", 400);
    }
    const groupId = body?.groupId;
    if (scope === "group" && (typeof groupId !== "string" || !groupId.trim())) {
      return errorJson("assistant_publication_invalid", 400);
    }
    const revisionNumber = body?.revisionNumber;
    if (
      revisionNumber !== undefined &&
      (typeof revisionNumber !== "number" || !Number.isInteger(revisionNumber) || revisionNumber < 1)
    ) {
      return errorJson("assistant_publication_invalid", 400);
    }

    const result = await deps.repository.publish({
      actorIsAdmin: resolved.auth.isAdmin,
      assistantId,
      groupId: scope === "group" ? (groupId as string).trim() : null,
      revisionNumber: typeof revisionNumber === "number" ? revisionNumber : null,
      scope,
      userId: resolved.auth.userId
    });
    if (result.kind === "not_found") return errorJson("assistant_not_available", 404);
    if (result.kind === "forbidden") return errorJson("forbidden", 403);
    if (result.kind === "invalid") return errorJson("assistant_publication_invalid", 400);
    return Response.json({
      publication: {
        groupId: result.publication.groupId,
        groupName: result.publication.groupName,
        id: result.publication.id,
        revisionNumber: result.publication.revisionNumber,
        scope: result.publication.scope,
        updatedAt: result.publication.updatedAt.toISOString()
      }
    } satisfies AssistantPublicationResponse);
  };
}

export function createRevokeAssistantPublicationHandler(deps: AssistantHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: {
      params:
        | Promise<{ assistantId: string; publicationId: string }>
        | { assistantId: string; publicationId: string };
    }
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const params = await context.params;
    const result = await deps.repository.revokePublication({
      actorIsAdmin: session.user.role === "admin",
      publicationId: params.publicationId,
      userId: session.userId
    });
    if (result === "not_found") return errorJson("assistant_not_available", 404);
    return new Response(null, { status: 204 });
  };
}

export function createPinAssistantHandler(deps: AssistantHandlerDeps) {
  const setPinned = (pinned: boolean) =>
    async function handle(
      request: Request,
      context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
    ): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return errorJson("unauthorized", 401);
      const assistantId = await routeParam(context, "assistantId");
      const applied = await deps.repository.setPinned(session.userId, assistantId, pinned);
      if (!applied) return errorJson("assistant_not_available", 404);
      return new Response(null, { status: 204 });
    };

  return {
    DELETE: setPinned(false),
    PUT: setPinned(true)
  };
}
