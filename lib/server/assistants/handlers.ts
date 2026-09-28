import {
  decodeAssistantAvatarRecipe,
  decodeAssistantDraft,
  decodeAssistantRunControls,
  type AssistantAccessScope,
  type AssistantAvailability,
  type AssistantDetail,
  type AssistantDetailResponse,
  type AssistantDraft,
  type AssistantDuplicateResponse,
  type AssistantListResponse,
  type AssistantOwnerAudience,
  type AssistantPublicationResponse,
  type AssistantContent,
  type AssistantRowAvailability,
  type AssistantRowDeviation,
  type AssistantRowDeviationKey,
  type AssistantRowKey,
  type AssistantRowPolicy,
  type AssistantRows,
  type AssistantRunControlField,
  type AssistantSummary
} from "../../contracts/assistants";
import { inheritedKnowledgeSelection } from "../../contracts/knowledge";
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
  assistantRowCatalogFailures,
  firstAssistantCatalogFailure,
  type AssistantCatalogRowValues,
  type AssistantCatalogView
} from "./catalogValidation";
import { isMcpRunPlanRecordStartable } from "../mcp/runPlan";
import type { AdoptChatSetup } from "./adoptChatSetup";
import { assistantKnowledgeFingerprint } from "./fingerprint";
import type {
  AssistantAccessEntry,
  AssistantContentRow,
  AssistantDetailData,
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
    | "loadDefaultAssistantId"
    | "loadRecentAssistantIds"
    | "loadUserAccessibleMcpServerIds"
    | "loadUserMcpRunPlanView"
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
  metadata: {
    field?: AssistantRunControlField | "pinned" | "available";
    actual?: number;
    limit?: number;
    row?: AssistantRowKey;
    skills?: string[];
  } = {}
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

function catalogModel(view: Pick<RunnerCatalogView, "modelById">, providerModelId: string | null) {
  return providerModelId === null ? undefined : view.modelById.get(providerModelId);
}

function assistantCategory(value: string | null): AssistantSummary["category"] {
  return value === null ? null : (value as AssistantSummary["category"]);
}

type AvailabilityDependency = NonNullable<AssistantRowDeviation["dependencies"]>[number];

function catalogRowValues(rows: AssistantRows): AssistantCatalogRowValues {
  return {
    controls: rows.controls.value,
    model: rows.model.value,
    search: rows.search.value,
    tools: rows.tools.value
  };
}

function knowledgeReason(
  knowledge: NonNullable<AssistantAccessEntry["dependencyAvailability"]>["knowledge"] | undefined
): AssistantRowDeviation["reason"] {
  return knowledge === "not_ready" ? "knowledge_not_ready"
    : knowledge === "unavailable" ? "knowledge_unavailable" : "knowledge_access";
}

/**
 * Availability "for you": resources of fixed rows and every Skill link are
 * dependencies, so their loss makes the Assistant unavailable; an unusable
 * adjustable value is only a row deviation, because the viewer's own default
 * replaces it. A row with several resources is unusable when any one is.
 * Owners receive the names of what is missing; other viewers a neutral reason.
 */
function availabilityFor(
  entry: AssistantAccessEntry,
  view: RunnerCatalogView
): { availability: AssistantAvailability; rowAvailability: AssistantRowAvailability } {
  const content = entry.content;
  const rows = content.rows;
  const failures = assistantRowCatalogFailures(catalogRowValues(rows), view, { mcpRunnability: "startable" });
  const modelName = (): AvailabilityDependency[] => [{
    kind: "model",
    name: catalogModel(view, content.providerModelId)?.displayName ?? content.modelDisplayName ?? "Saved model"
  }];
  const failed: Array<{
    dependencies: () => AvailabilityDependency[];
    key: AssistantRowDeviationKey;
    policy: AssistantRowPolicy;
    reason: AssistantRowDeviation["reason"];
  }> = [];
  if (failures.model) {
    failed.push({ dependencies: modelName, key: "model", policy: rows.model.policy, reason: "model_access" });
  }
  // Controls belong to the model; only a fixed set can make the Assistant
  // unusable, because an adjustable one gives way to the viewer's own values.
  if (failures.controls && rows.controls.policy === "fixed") {
    failed.push({ dependencies: modelName, key: "model", policy: "fixed", reason: "model_access" });
  }
  if (failures.search) {
    failed.push({
      dependencies: () => [{ kind: "search", name: "Web search" }],
      key: "search",
      policy: rows.search.policy,
      reason: "search_access"
    });
  }
  if (failures.tools) {
    failed.push({
      dependencies: () => toolsDependencies(content, view),
      key: "tools",
      policy: rows.tools.policy,
      reason: "tools_access"
    });
  }
  const knowledge = entry.dependencyAvailability?.knowledge;
  if (rows.knowledge.value.mode === "explicit" && knowledge !== "ready") {
    failed.push({ dependencies: () => [], key: "knowledge", policy: rows.knowledge.policy, reason: knowledgeReason(knowledge) });
  }

  const deviation = (row: (typeof failed)[number]): AssistantRowDeviation => {
    const dependencies = entry.owned ? row.dependencies() : [];
    return { ...(dependencies.length > 0 ? { dependencies } : {}), reason: row.reason };
  };
  const rowAvailability: AssistantRowAvailability = {};
  for (const row of failed) {
    if (row.policy === "adjustable" && !rowAvailability[row.key]) rowAvailability[row.key] = deviation(row);
  }
  const fixed = failed.filter((row) => row.policy === "fixed");
  const skillsMissing = rows.skills.value.links.length > 0 && entry.dependencyAvailability?.skills !== true;
  // Knowledge follows Skills, as it always has; catalog rows come first.
  const blocking = fixed.find((row) => row.key !== "knowledge");
  const unavailable: AssistantAvailability = entry.archived
    ? { ok: false, reason: "archived" }
    : blocking
      ? { ok: false, ...deviation(blocking) }
      : skillsMissing
        ? { ok: false, reason: "skills_access" }
        : fixed[0]
          ? { ok: false, ...deviation(fixed[0]) }
          : { ok: true };
  return { availability: unavailable, rowAvailability };
}

function toolsDependencies(
  content: AssistantContentRow,
  view: RunnerCatalogView
): AvailabilityDependency[] {
  const model = catalogModel(view, content.providerModelId);
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

/** How the Assistant reaches this viewer; group names are only the viewer's own groups. */
function accessScope(entry: AssistantAccessEntry): AssistantAccessScope {
  if (entry.owned) return { kind: "owner" };
  if (entry.projectName !== undefined) return { kind: "project", projectName: entry.projectName };
  return entry.memberGroupNames.length > 0
    ? { groupNames: entry.memberGroupNames, kind: "group" }
    : { kind: "installation" };
}

/** Only the owner learns the whole audience. */
function ownerAudience(entry: AssistantAccessEntry): AssistantOwnerAudience | null {
  if (!entry.owned) return null;
  return { everyone: entry.audience?.everyone ?? false, groupNames: [...entry.audience?.groupNames ?? []] };
}

export function buildAssistantSummary(
  entry: AssistantAccessEntry,
  view: RunnerCatalogView
): AssistantSummary {
  const decoded = decodeStoredContent(entry.content);
  const { availability, rowAvailability } = availabilityFor(entry, view);
  return {
    archived: entry.archived,
    audience: ownerAudience(entry),
    availability,
    avatar: decoded.avatar,
    category: assistantCategory(entry.content.category),
    description: entry.content.description,
    featured: entry.featured,
    featuredOrder: entry.featuredOrder,
    fingerprint: {
      ...assistantKnowledgeFingerprint(entry.content.knowledgeSelection),
      mcpServerCount: entry.content.mcpServerIds.length,
      modelLabel: catalogModel(view, entry.content.providerModelId)?.displayName ?? null,
      reasoningEffort: decoded.runControls.reasoningEffort ?? null,
      searchOptionCount: decoded.searchPlan.optionIds.length
    },
    id: entry.id,
    name: entry.content.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    pinned: entry.pinned,
    published: entry.published,
    rowAvailability,
    scope: accessScope(entry),
    // Every stored link, including Skills this viewer cannot open; only the count leaves.
    skillLinkCount: entry.content.skillIds.length,
    starterPrompts: [...entry.content.starterPrompts],
    updatedAt: entry.updatedAt.toISOString()
  };
}

function withHiddenCount<T extends object>(value: T, visible: number, total: number): T & { hiddenCount?: number } {
  return total > visible ? { ...value, hiddenCount: total - visible } : value;
}

/**
 * Rows as a viewer who does not own the Assistant may see them: resources
 * the viewer can use are identified, the rest are counted (D-10). Without a
 * resolved Knowledge subset every Knowledge resource is counted. The listing
 * review projects rows for the reviewing administrator with it too.
 */
export function viewerRows(
  content: Pick<AssistantContentRow, "rows" | "skillSummaries">,
  view: Pick<RunnerCatalogView, "accessibleMcpServerIds" | "entitledSearchOptionIds" | "modelById">,
  options: { owned: boolean; visibleKnowledge?: AssistantDetailData["visibleKnowledge"] }
): AssistantRows {
  const rows = content.rows;
  if (options.owned) return rows;
  const model = rows.model.value;
  const search = rows.search.value;
  const tools = rows.tools.value;
  const knowledge = rows.knowledge.value;
  const skills = rows.skills.value;
  const visibleSkillIds = new Set((content.skillSummaries ?? []).map(({ id }) => id));
  const links = skills.links.filter((link) => visibleSkillIds.has(link.skillId));
  const optionIds = search.mode === "inherit" || search.mode === "off"
    ? []
    : search.optionIds.filter((optionId) => view.entitledSearchOptionIds.has(optionId));
  const serverIds = tools.mode === "exact"
    ? tools.serverIds.filter((serverId) => view.accessibleMcpServerIds.has(serverId))
    : [];
  const visibleBaseIds = new Set(options.visibleKnowledge?.baseIds ?? []);
  const visibleSourceIds = new Set(options.visibleKnowledge?.sourceIds ?? []);
  const baseIds = knowledge.mode === "explicit" ? knowledge.baseIds.filter((id) => visibleBaseIds.has(id)) : [];
  const sourceIds = knowledge.mode === "explicit" ? knowledge.sourceIds.filter((id) => visibleSourceIds.has(id)) : [];
  return {
    controls: rows.controls,
    knowledge: {
      policy: rows.knowledge.policy,
      value: knowledge.mode === "explicit"
        ? withHiddenCount({ baseIds, mode: "explicit" as const, sourceIds }, baseIds.length + sourceIds.length,
          knowledge.baseIds.length + knowledge.sourceIds.length)
        : knowledge
    },
    model: {
      policy: rows.model.policy,
      value: model.mode === "model" && catalogModel(view, model.modelId) === undefined
        ? { mode: "model", modelId: null }
        : model
    },
    search: {
      policy: rows.search.policy,
      value: search.mode === "inherit" || search.mode === "off"
        ? search
        : withHiddenCount({ mode: search.mode, optionIds }, optionIds.length, search.optionIds.length)
    },
    skills: {
      policy: rows.skills.policy,
      value: withHiddenCount({ links, mode: skills.mode }, links.length, skills.links.length)
    },
    tools: {
      policy: rows.tools.policy,
      value: tools.mode === "exact"
        ? withHiddenCount({ mode: "exact" as const, serverIds }, serverIds.length, tools.serverIds.length)
        : tools
    }
  };
}

/**
 * Instructions, answer rules and the reminder are readable by every viewer
 * the Assistant is available to; only the owner can edit them.
 */
function definitionContent(
  content: AssistantContentRow,
  view: RunnerCatalogView,
  options: { owned: boolean; visibleKnowledge?: AssistantDetailData["visibleKnowledge"] }
): AssistantContent {
  const decoded = decodeStoredContent(content);
  const modelVisible = catalogModel(view, content.providerModelId) !== undefined;
  return {
    answerRules: content.answerRules,
    avatar: decoded.avatar,
    category: assistantCategory(content.category),
    description: content.description,
    responseReminder: content.responseReminder ?? "",
    // The flat Knowledge field serves the current editor only; consumers
    // read their visible subset from `rows`.
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
    rows: viewerRows(content, view, options),
    runControls: decoded.runControls,
    searchPlan: options.owned
      ? decoded.searchPlan
      : {
          mode: decoded.searchPlan.mode,
          optionIds: decoded.searchPlan.optionIds.filter((optionId) =>
            view.entitledSearchOptionIds.has(optionId)
          )
        },
    skillIds: options.owned ? [...content.skillIds] : (content.skillSummaries ?? []).map(({ id }) => id),
    skillModes: Object.fromEntries((options.owned ? content.skillIds : (content.skillSummaries ?? []).map(({ id }) => id))
      .map((id) => [id, content.skillModes?.[id] ?? "pinned"])),
    skills: content.skills ?? { mode: "auto" },
    starterPrompts: [...content.starterPrompts],
    systemPrompt: content.systemPrompt
  };
}

function detailFromEntry(
  entry: AssistantDetailData,
  view: RunnerCatalogView
): AssistantDetail {
  const skillSummaries = entry.content.skillSummaries ?? [];
  const { availability, rowAvailability } = availabilityFor(entry, view);
  return {
    archived: entry.archived,
    audience: ownerAudience(entry),
    availability,
    featured: entry.featured,
    ...(entry.owned
      ? {
          featuredOrder: entry.featuredOrder,
          ...(entry.listingRequest !== undefined ? { listingRequest: entry.listingRequest } : {}),
          ...(entry.projects ? { projects: entry.projects } : {}),
          ...(entry.recentChatCount !== undefined ? { recentChatCount: entry.recentChatCount } : {})
        }
      : {}),
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
    rowAvailability,
    scope: accessScope(entry),
    content: definitionContent(entry.content, view, {
      owned: entry.owned,
      ...(entry.visibleKnowledge ? { visibleKnowledge: entry.visibleKnowledge } : {})
    }),
    ...(!entry.owned || skillSummaries.length === entry.content.skillIds.length
      ? { skills: skillSummaries.map((skill) => ({ ...skill })) }
      : {}),
    updatedAt: entry.updatedAt.toISOString(),
    ...(entry.owned ? { version: entry.version } : {})
  };
}

/**
 * Every concrete row value must be usable by the owner, whatever its policy;
 * inherit values need no catalog entry. A granted, enabled MCP server that is
 * not running yet is accepted (D-11).
 */
function validateDraftAgainstCatalog(
  draft: Pick<AssistantDraft, "rows">,
  view: RunnerCatalogView
): Response | null {
  const failure = firstAssistantCatalogFailure(
    assistantRowCatalogFailures(catalogRowValues(draft.rows), view, { mcpRunnability: "accessible" })
  );
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
    const [entries, publishableGroups, storedDefaultAssistantId] = await Promise.all([
      deps.repository.listForUser(resolved.auth.userId),
      deps.repository.listPublishableGroups(resolved.auth.userId),
      deps.repository.loadDefaultAssistantId(resolved.auth.userId)
    ]);
    const assistants = entries.map((entry) => buildAssistantSummary(entry, resolved.view));
    const listedIds = assistants.flatMap((assistant) => assistant.archived ? [] : [assistant.id]);
    // A saved default that is no longer usable is never named here.
    const defaultAssistantId = storedDefaultAssistantId !== null && listedIds.includes(storedDefaultAssistantId)
      ? storedDefaultAssistantId
      : null;
    const recentAssistantIds = await deps.repository.loadRecentAssistantIds(resolved.auth.userId, listedIds);
    return Response.json({
      assistants,
      publishableGroups,
      recentAssistantIds,
      viewer: { canPublishInstallation: resolved.auth.isAdmin, defaultAssistantId }
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
        ...(decoded.field ? { field: decoded.field } : {}),
        ...(decoded.actual === undefined ? {} : { actual: decoded.actual }),
        ...(decoded.limit === undefined ? {} : { limit: decoded.limit }),
        ...(decoded.row ? { row: decoded.row } : {})
      });
    }
    const invalid = validateDraftAgainstCatalog(decoded.draft, resolved.view);
    if (invalid) return invalid;

    const created = await deps.repository.create(resolved.auth.userId, decoded.draft);
    if (created.kind === "skills_not_available") {
      return errorJson("assistant_skills_not_available", 400);
    }
    const detail = await deps.repository.getDetail(resolved.auth.userId, created.assistantId, { isAdmin: resolved.auth.isAdmin });
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
    const detail = await deps.repository.getDetail(resolved.auth.userId, assistantId, { isAdmin: resolved.auth.isAdmin });
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
          ...(decoded.field ? { field: decoded.field } : {}),
          ...(decoded.actual === undefined ? {} : { actual: decoded.actual }),
          ...(decoded.limit === undefined ? {} : { limit: decoded.limit }),
          ...(decoded.row ? { row: decoded.row } : {})
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

    const detail = await deps.repository.getDetail(resolved.auth.userId, assistantId, { isAdmin: resolved.auth.isAdmin });
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
    const detail = await deps.repository.getDetail(
      resolved.auth.userId,
      result.assistantId,
      { isAdmin: resolved.auth.isAdmin }
    );
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      {
        assistant: detailFromEntry(detail, resolved.view),
        report: result.report
      } satisfies AssistantDuplicateResponse,
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
        "Share every included Skill with this audience before publishing the Assistant.",
        result.skillNames?.length ? { skills: result.skillNames } : {}
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

export type AdoptChatSetupHandlerDeps = AssistantHandlerDeps & { adoptChatSetup: AdoptChatSetup };

/**
 * "Save chat setup to Assistant" (owner only, PRD 8.5): the rows changed in
 * one of the owner's personal chats bound to this Assistant become its
 * values; policies stay. The rows are validated like an ordinary save. An
 * Assistant the caller does not own, another user's chat, a Project chat and
 * a chat bound elsewhere all answer the same neutral 404. Nothing changed for
 * the chat is an ordinary success that writes nothing.
 */
export function createAdoptChatSetupHandler(deps: AdoptChatSetupHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ assistantId: string }> | { assistantId: string } }
  ): Promise<Response> {
    const resolved = await authAndView(deps, request);
    if ("response" in resolved) return resolved.response;
    const assistantId = await routeParam(context, "assistantId");
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    if (!body || typeof body.chatId !== "string" || typeof body.expectedVersion !== "number" ||
      !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
      Object.keys(body).some((key) => key !== "chatId" && key !== "expectedVersion")) {
      return errorJson("assistant_draft_invalid", 400);
    }
    const chatId = body.chatId.trim();
    if (!chatId || chatId.length > 64) return errorJson("assistant_not_available", 404);

    const result = await deps.adoptChatSetup({
      assistantId,
      chatId,
      expectedVersion: body.expectedVersion,
      userId: resolved.auth.userId,
      validate: (rows) => validateDraftAgainstCatalog({ rows }, resolved.view)
    });
    if (result.kind === "not_found") return errorJson("assistant_not_available", 404);
    if (result.kind === "version_conflict") return errorJson("assistant_version_conflict", 409);
    if (result.kind === "archived") return errorJson("assistant_archived", 409);
    if (result.kind === "active_run") return errorJson("active_run_in_progress", 409);
    if (result.kind === "invalid") return result.invalid;
    if (result.kind === "rows_invalid") {
      return errorJson(result.error.code, 400, undefined, {
        ...(result.error.field ? { field: result.error.field } : {}),
        ...(result.error.actual === undefined ? {} : { actual: result.error.actual }),
        ...(result.error.limit === undefined ? {} : { limit: result.error.limit }),
        ...(result.error.row ? { row: result.error.row } : {})
      });
    }

    const detail = await deps.repository.getDetail(resolved.auth.userId, assistantId, { isAdmin: resolved.auth.isAdmin });
    if (!detail) return errorJson("assistant_not_available", 404);
    return Response.json(
      { assistant: detailFromEntry(detail, resolved.view) } satisfies AssistantDetailResponse
    );
  };
}
