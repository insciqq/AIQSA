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
  type AssistantContent,
  type AssistantRunControlField,
  type AssistantSummary
} from "../../contracts/assistants";
import { decodeKnowledgePlan, inheritedKnowledgeSelection } from "../../contracts/knowledge";
import { decodeSearchPlan } from "../../contracts/search";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  resolveCurrentUserCatalogSelection,
  type CatalogData
} from "../catalog/currentUserCatalog";
import {
  validateAssistantConfigurationAgainstCatalog,
  type AssistantCatalogValidationFailure,
  type AssistantCatalogView
} from "./catalogValidation";
import { isMcpRunPlanRecordStartable } from "../mcp/runPlan";
import type {
  AssistantAccessEntry,
  AssistantContentRow,
  PrismaAssistantRepository
} from "./prismaRepository";

export type AssistantHandlerDeps = {
  loadCatalogData(userId: string): Promise<CatalogData | null>;
  repository: Pick<
    PrismaAssistantRepository,
    | "create"
    | "duplicate"
    | "getDetail"
    | "listForUser"
    | "listPublishableGroups"
    | "loadUserAccessibleMcpServerIds"
    | "loadUserMcpRunPlanView"
    | "loadUserRunnableMcpServerIds"
    | "publish"
    | "update"
    | "revokePublication"
    | "setArchived"
    | "setPinned"
  >;
  resolveAuth: RequestAuthResolver;
};

type RunnerCatalogView = AssistantCatalogView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function errorJson(
  code: string,
  status: number,
  message?: string,
  metadata: { field?: AssistantRunControlField; limit?: number } = {}
): Response {
  return Response.json(
    { error: code, ...(message ? { message } : {}), ...metadata },
    { status }
  );
}

export function buildAssistantRunnerCatalogView(input: Readonly<{
  accessibleMcpServerIds: ReadonlySet<string>;
  catalogData: CatalogData;
  mcpRunPlan: AssistantCatalogView["mcpRunPlan"];
}>): RunnerCatalogView {
  const selection = resolveCurrentUserCatalogSelection(input.catalogData);
  return {
    accessibleMcpServerIds: input.accessibleMcpServerIds,
    entitledSearchOptionIds: new Set(
      selection.entitledStrategies.map((strategy) => strategy.strategyId)
    ),
    mcpRunPlan: input.mcpRunPlan,
    modelById: new Map(selection.models.map((model) => [model.modelId, model]))
  };
}

async function runnerCatalogView(
  deps: AssistantHandlerDeps,
  userId: string
): Promise<RunnerCatalogView | null> {
  const [catalogData, accessibleMcpServerIds, mcpRunPlan] = await Promise.all([
    deps.loadCatalogData(userId),
    deps.repository.loadUserAccessibleMcpServerIds(userId),
    deps.repository.loadUserMcpRunPlanView(userId)
  ]);
  if (!catalogData) return null;
  return buildAssistantRunnerCatalogView({
    accessibleMcpServerIds,
    catalogData,
    mcpRunPlan,
  });
}

function decodeStoredContent(content: AssistantContentRow): {
  avatar: NonNullable<ReturnType<typeof decodeAssistantAvatarRecipe>>;
  runControls: NonNullable<ReturnType<typeof decodeAssistantRunControls>>;
  searchPlan: { mode: "all_selected" | "model_choice"; optionIds: string[] };
} {
  const avatar = decodeAssistantAvatarRecipe(content.avatar);
  const runControls = decodeAssistantRunControls(content.runControls ?? {});
  const searchPlan = decodeSearchPlan(content.searchPlan);
  if (!avatar || !runControls || !searchPlan.ok) {
    throw new Error("assistant_definition_integrity_invalid");
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

function knowledgeFingerprintLabel(value: unknown): string | null {
  const decoded = decodeKnowledgePlan(value);
  if (!decoded.ok || decoded.plan.mode === "none") return null;
  if (decoded.plan.mode === "all_my_knowledge") return "All Knowledge";
  if (decoded.plan.mode === "inherited") return "Knowledge";
  const count = decoded.plan.baseIds.length + decoded.plan.sourceIds.length;
  return count > 0 ? `Knowledge · ${count}` : null;
}

function knowledgeFingerprintCount(value: unknown): number {
  const decoded = decodeKnowledgePlan(value);
  return decoded.ok && decoded.plan.mode === "explicit"
    ? decoded.plan.baseIds.length + decoded.plan.sourceIds.length
    : 0;
}

function availabilityFor(
  content: AssistantContentRow,
  searchPlanOptionIds: readonly string[],
  view: RunnerCatalogView,
  options: { owned: boolean }
): AssistantAvailability {
  const runControls = decodeAssistantRunControls(content.runControls ?? {});
  const searchPlan = decodeSearchPlan(content.searchPlan);
  if (!runControls || !searchPlan.ok) {
    throw new Error("assistant_definition_integrity_invalid");
  }
  const failure = validateAssistantConfigurationAgainstCatalog(
    {
      mcpServerIds: content.mcpServerIds,
      providerModelId: content.providerModelId,
      runControls,
      searchPlan: {
        mode: searchPlan.plan.mode,
        optionIds: [...searchPlanOptionIds]
      }
    },
    view,
    { mcpRunnability: "startable" }
  );
  if (!failure) return { ok: true };

  const dependencies = options.owned
    ? ownerAvailabilityDependencies(content, failure, view)
    : [];
  if (failure === "search") {
    return {
      ...(dependencies.length > 0 ? { dependencies } : {}),
      ok: false,
      reason: "search_access"
    };
  }
  if (failure === "tools") {
    return {
      ...(dependencies.length > 0 ? { dependencies } : {}),
      ok: false,
      reason: "tools_access"
    };
  }
  return {
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ok: false,
    reason: "model_access"
  };
}

function ownerAvailabilityDependencies(
  content: AssistantContentRow,
  failure: AssistantCatalogValidationFailure,
  view: RunnerCatalogView
): NonNullable<Extract<AssistantAvailability, { ok: false }>["dependencies"]> {
  const model = view.modelById.get(content.providerModelId);
  if (failure === "model" || typeof failure === "object") {
    return [{ kind: "model", name: model?.displayName ?? "Saved model" }];
  }
  if (failure === "search") {
    return [{ kind: "search", name: "Web search" }];
  }
  if (model && content.mcpServerIds.length > 0 && !model.capabilities.toolCalling) {
    return [{ kind: "model", name: model.displayName }];
  }

  const names = new Set<string>();
  for (const serverId of content.mcpServerIds) {
    const record = view.mcpRunPlan.recordsByServerId.get(serverId);
    const accessible = view.accessibleMcpServerIds.has(serverId);
    if (
      !accessible ||
      !record ||
      !isMcpRunPlanRecordStartable(record)
    ) {
      names.add(
        !accessible || !record || record.errorCode === "mcp_startability_unknown"
          ? "Required MCP tools"
          : record.serverName
      );
    }
  }
  return [...names].map((name) => ({ kind: "mcp", name }));
}

export function buildAssistantSummary(
  entry: AssistantAccessEntry,
  view: RunnerCatalogView
): AssistantSummary {
  const decoded = decodeStoredContent(entry.content);
  const availability = availabilityFor(
    entry.content,
    decoded.searchPlan.optionIds,
    view,
    { owned: entry.owned }
  );
  return {
    archived: entry.archived,
    availability,
    avatar: decoded.avatar,
    category: assistantCategory(entry.content.category),
    description: entry.content.description,
    fingerprint: {
      knowledgeLabel: knowledgeFingerprintLabel(entry.content.knowledgeSelection),
      knowledgeResourceCount: knowledgeFingerprintCount(entry.content.knowledgeSelection),
      mcpServerCount: entry.content.mcpServerIds.length,
      modelLabel: view.modelById.get(entry.content.providerModelId)?.displayName ?? null,
      reasoningEffort: decoded.runControls.reasoningEffort ?? null,
      searchOptionCount: decoded.searchPlan.optionIds.length
    },
    id: entry.id,
    name: entry.content.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    pinned: entry.pinned,
    published: entry.published,
    scope: entry.owned
      ? { kind: "owner" }
      : entry.memberGroupNames.length > 0
        ? { groupNames: entry.memberGroupNames, kind: "group" }
        : { kind: "installation" },
    starterPrompts: [...entry.content.starterPrompts],
    updatedAt: entry.updatedAt.toISOString()
  };
}

function definitionContent(
  content: AssistantContentRow,
  view: RunnerCatalogView,
  options: { owned: boolean }
): AssistantContent {
  const decoded = decodeStoredContent(content);
  const modelVisible = view.modelById.has(content.providerModelId);
  return {
    avatar: decoded.avatar,
    category: assistantCategory(content.category),
    description: content.description,
    developerPrompt: content.developerPrompt,
    // Knowledge ids are governed dependencies too. Published consumers do
    // not receive opaque ids here; run admission resolves the exact content
    // server-side and returns one privacy-neutral availability failure.
    knowledgeSelection: options.owned
      ? content.knowledgeSelection
      : inheritedKnowledgeSelection("assistant"),
    // Consumers never learn hidden dependency ids: unresolvable model ids
    // project as null and MCP ids narrow to the runner's accessible servers.
    mcpServerIds: options.owned
      ? [...content.mcpServerIds]
      : content.mcpServerIds.filter((serverId) =>
          view.accessibleMcpServerIds.has(serverId)
        ),
    name: content.name,
    providerModelId: options.owned || modelVisible ? content.providerModelId : null,
    runControls: decoded.runControls,
    searchPlan: options.owned
      ? decoded.searchPlan
      : {
          mode: decoded.searchPlan.mode,
          optionIds: decoded.searchPlan.optionIds.filter((optionId) =>
            view.entitledSearchOptionIds.has(optionId)
          )
        },
    skillIds: [...content.skillIds],
    starterPrompts: [...content.starterPrompts],
    systemPrompt: content.systemPrompt
  };
}

function detailFromEntry(
  entry: AssistantAccessEntry & {
    publications: import("./prismaRepository").AssistantPublicationRow[] | null;
  },
  view: RunnerCatalogView
): AssistantDetail {
  const decoded = decodeStoredContent(entry.content);
  const skillSummaries = entry.content.skillSummaries ?? [];
  return {
    archived: entry.archived,
    availability: availabilityFor(
      entry.content,
      decoded.searchPlan.optionIds,
      view,
      { owned: entry.owned }
    ),
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
            scope: publication.scope,
            updatedAt: publication.updatedAt.toISOString()
          }))
        }
      : {}),
    content: definitionContent(entry.content, view, { owned: entry.owned }),
    ...(skillSummaries.length === entry.content.skillIds.length
      ? { skills: skillSummaries.map((skill) => ({ ...skill })) }
      : {}),
    ...(entry.owned ? { version: entry.version } : {})
  };
}

function validateDraftAgainstCatalog(
  draft: AssistantDraft,
  view: RunnerCatalogView
): Response | null {
  const failure = validateAssistantConfigurationAgainstCatalog(draft, view, {
    mcpRunnability: "accessible"
  });
  if (failure === "model") return errorJson("assistant_model_not_available", 400);
  if (failure !== null && typeof failure === "object") {
    return errorJson("assistant_run_controls_invalid", 400, undefined, {
      field: failure.control,
      ...(failure.limit !== undefined ? { limit: failure.limit } : {})
    });
  }
  if (failure === "search") {
    return errorJson("assistant_search_option_not_available", 400);
  }
  if (failure === "tools") return errorJson("assistant_tools_not_available", 400);
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
    const assistants = entries.map((entry) => buildAssistantSummary(entry, resolved.view));
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
    if (!decoded.ok) {
      return errorJson(decoded.code, 400, undefined, {
        ...(decoded.field ? { field: decoded.field } : {})
      });
    }
    const invalid = validateDraftAgainstCatalog(decoded.draft, resolved.view);
    if (invalid) return invalid;

    const created = await deps.repository.create(resolved.auth.userId, decoded.draft);
    if (created.kind === "skills_not_available") {
      return errorJson("assistant_skills_not_available", 400);
    }
    const detail = await deps.repository.getDetail(resolved.auth.userId, created.assistantId);
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
    if (!body || typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion < 1 || Object.keys(body).some((key) => !["expectedVersion", "content", "archived"].includes(key))) {
      return errorJson("assistant_draft_invalid", 400);
    }
    const hasContent = "content" in body && body.content !== undefined;
    const hasArchived = "archived" in body && body.archived !== undefined;
    if (hasContent === hasArchived) {
      return errorJson("assistant_draft_invalid", 400);
    }

    let result;
    if (hasContent) {
      const decoded = decodeAssistantDraft(body.content);
      if (!decoded.ok) {
        return errorJson(decoded.code, 400, undefined, {
          ...(decoded.field ? { field: decoded.field } : {})
        });
      }
      const invalid = validateDraftAgainstCatalog(decoded.draft, resolved.view);
      if (invalid) return invalid;
      result = await deps.repository.update(
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
    if (result.kind === "skill_audience_mismatch") return errorJson("assistant_skill_audience_mismatch", 409);
    if (result.kind === "archived") return errorJson("assistant_archived", 409);
    if (result.kind === "skills_not_available") {
      return errorJson("assistant_skills_not_available", 400);
    }

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
    const result = await deps.repository.duplicate(
      resolved.auth.userId,
      assistantId
    );
    if (result.kind === "not_found") return errorJson("assistant_not_available", 404);
    if (result.kind === "knowledge_not_available") {
      return errorJson("assistant_not_available", 404);
    }
    if (result.kind === "model_not_available") {
      return errorJson("assistant_model_not_available", 400);
    }
    if (result.kind === "run_controls_invalid") {
      return errorJson("assistant_run_controls_invalid", 400);
    }
    if (result.kind === "search_not_available") {
      return errorJson("assistant_search_option_not_available", 400);
    }
    if (result.kind === "skills_not_available") {
      return errorJson("assistant_not_available", 404);
    }
    if (result.kind === "tools_not_available") {
      return errorJson("assistant_tools_not_available", 400);
    }
    const detail = await deps.repository.getDetail(
      resolved.auth.userId,
      result.assistantId
    );
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      { assistant: detailFromEntry(detail, resolved.view) } satisfies AssistantDetailResponse,
      { status: 201 }
    );
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
    if (Object.keys(body ?? {}).some((key) => key !== "scope" && key !== "groupId")) {
      return errorJson("assistant_publication_invalid", 400);
    }

    const result = await deps.repository.publish({
      actorIsAdmin: resolved.auth.isAdmin,
      assistantId,
      groupId: scope === "group" ? (groupId as string).trim() : null,
      scope,
      userId: resolved.auth.userId
    });
    if (result.kind === "not_found") return errorJson("assistant_not_available", 404);
    if (result.kind === "forbidden") return errorJson("forbidden", 403);
    if (result.kind === "invalid") return errorJson("assistant_publication_invalid", 400);
    if (result.kind === "skill_audience_mismatch") {
      return errorJson(
        "assistant_skill_audience_mismatch",
        409,
        "Share every included Skill with this audience before publishing the Assistant."
      );
    }
    return Response.json({
      publication: {
        groupId: result.publication.groupId,
        groupName: result.publication.groupName,
        id: result.publication.id,
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
      assistantId: params.assistantId,
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
