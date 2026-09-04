import type {
  AdminMcpCatalogResponse,
  McpDraftConfiguration,
  McpErrorCode,
  McpErrorResponse,
  McpSlotValue,
  McpValidationIssue,
  McpOperationalStatus,
  UserMcpServer,
  UserMcpCatalogResponse
} from "@/lib/contracts/mcp";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "@/lib/server/http/requestBody";
import { validateMcpDraft } from "./definitions";
import { McpDraftValidationUnavailableError } from "./draftValidator";
import { McpEncryptionError } from "./encryption";
import type { McpRepository, McpRepositoryResult, McpUserServerState } from "./repositoryContract";

export type McpHandlerDeps = {
  onActivationRequested?(): void;
  onRuntimeChanged?(userId?: string): void;
  runtimeOperationalStatus?(generationId: string): McpOperationalStatus;
  repository: McpRepository;
  resolveAuth: RequestAuthResolver;
};

function notifyActivationRequested(deps: McpHandlerDeps): void {
  try {
    deps.onActivationRequested?.();
  } catch {
    // Persistence is authoritative; the activation scheduler also sweeps periodically.
  }
}

function notifyRuntimeChanged(deps: McpHandlerDeps, userId?: string): void {
  try {
    deps.onRuntimeChanged?.(userId);
  } catch {
    // Persistence is authoritative; periodic reconciliation retries a failed kick.
  }
}

type RouteContext = {
  params: Promise<{ serverId: string }> | { serverId: string };
};

function errorJson(error: McpErrorCode, status: number, issues?: readonly McpValidationIssue[]): Response {
  return Response.json(
    { error, ...(issues?.length ? { issues } : {}) } satisfies McpErrorResponse,
    { status }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function readJsonRecord(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  if (!hasJsonContentType(request)) return [null, null];
  const body = await readJsonBodyOrNull(request, "json");
  return [isRecord(body) ? body : null, requestBodyErrorResponse(body)];
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function optionalText(value: unknown, maxLength: number): string | undefined | null {
  if (typeof value === "undefined") return undefined;
  return text(value, maxLength);
}

function descriptionText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : null;
}

function optionalDescriptionText(value: unknown, maxLength: number): string | undefined | null {
  if (typeof value === "undefined") return undefined;
  return descriptionText(value, maxLength);
}

function slotValues(value: unknown): Record<string, McpSlotValue | null> | null {
  if (typeof value === "undefined") return {};
  if (!isRecord(value) || Object.keys(value).length > 64) return null;
  const output: Record<string, McpSlotValue | null> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(key) ||
      (candidate !== null && typeof candidate !== "string" && typeof candidate !== "number" &&
        typeof candidate !== "boolean")) {
      return null;
    }
    output[key] = candidate;
  }
  return output;
}

async function requireUser(request: Request, deps: McpHandlerDeps) {
  const session = await deps.resolveAuth(request);
  return session ?? null;
}

async function requireAdmin(request: Request, deps: McpHandlerDeps) {
  const session = await requireUser(request, deps);
  if (!session) return { response: errorJson("unauthorized", 401), session: null };
  if (session.user.role !== "admin" || session.user.status !== "active") {
    return { response: errorJson("forbidden", 403), session: null };
  }
  return { response: null, session };
}

function repositoryError<T>(result: Exclude<McpRepositoryResult<T>, { kind: "ok" }>): Response {
  if (result.kind === "not_found") return errorJson("mcp_not_found", 404);
  if (result.kind === "artifact_missing") return errorJson("mcp_artifact_missing", 409);
  if (result.kind === "draft_changed") return errorJson("mcp_draft_changed", 409);
  if (result.kind === "revision_required") return errorJson("mcp_revision_required", 409);
  if (result.kind === "draft_validation_failed") {
    return errorJson("mcp_draft_test_failed", 422, result.issues);
  }
  if (result.kind === "invalid_grant") return errorJson("invalid_grant", 400, result.issues);
  return errorJson("invalid_mcp_values", 400, result.issues);
}

async function safely<T>(operation: () => Promise<T>): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpEncryptionError) {
      return errorJson("mcp_encryption_unavailable", 503);
    }
    if (error instanceof McpDraftValidationUnavailableError) {
      return errorJson("mcp_validation_unavailable", 503);
    }
    throw error;
  }
}

export function createAdminMcpCatalogHandler(deps: McpHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const servers = await safely(() => deps.repository.listAdminServers());
    if (servers instanceof Response) return servers;
    return Response.json({ servers } satisfies AdminMcpCatalogResponse);
  };
}

export function createAdminMcpCreateHandler(deps: McpHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const name = text(body?.name, 120);
    const description = typeof body?.description === "undefined" ? "" : descriptionText(body.description, 4_000);
    const draft = validateMcpDraft(body?.draft);
    const sharedValues = slotValues(body?.sharedValues);
    if (!name || description === null || !draft.ok ||
      (typeof body?.activate !== "undefined" && typeof body.activate !== "boolean")) {
      return errorJson("invalid_draft", 400, draft.ok ? undefined : draft.issues);
    }
    if (!sharedValues) return errorJson("invalid_mcp_values", 400);
    const result = await safely(() => deps.repository.createServer({
      activate: body?.activate === true,
      description,
      draft: draft.value,
      name,
      sharedValues,
      validationUserId: auth.session.userId
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    if (body?.activate === true) notifyActivationRequested(deps);
    return Response.json(
      { server: result.value },
      { status: body?.activate === true ? 202 : 201 }
    );
  };
}

export function createAdminMcpUpdateHandler(deps: McpHandlerDeps) {
  return async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    if (!body) return errorJson("invalid_draft", 400);
    const name = optionalText(body.name, 120);
    const description = optionalDescriptionText(body.description, 4_000);
    if (name === null || description === null ||
      (typeof body.enabled !== "undefined" && typeof body.enabled !== "boolean")) {
      return errorJson("invalid_draft", 400);
    }
    let draft: McpDraftConfiguration | undefined;
    if (typeof body.draft !== "undefined") {
      const validated = validateMcpDraft(body.draft);
      if (!validated.ok) return errorJson("invalid_draft", 400, validated.issues);
      draft = validated.value;
    }
    const sharedValues = typeof body.sharedValues === "undefined" ? undefined : slotValues(body.sharedValues);
    if (sharedValues === null) return errorJson("invalid_mcp_values", 400);
    if (typeof name === "undefined" && typeof description === "undefined" &&
      typeof body.enabled === "undefined" && !draft && typeof sharedValues === "undefined") {
      return errorJson("invalid_draft", 400);
    }
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.updateServer({
      ...(description !== undefined ? { description } : {}),
      ...(draft ? { draft } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(sharedValues !== undefined ? { sharedValues } : {}),
      serverId
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps);
    return Response.json({ server: result.value });
  };
}

export function createAdminMcpDeleteHandler(deps: McpHandlerDeps) {
  return async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.deleteServer(serverId));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps);
    return Response.json({ server: result.value });
  };
}

export function createAdminMcpDraftTestHandler(deps: McpHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    if (!body) return errorJson("invalid_mcp_values", 400);
    const parsedValues = slotValues(body.oneTimeValues);
    if (!parsedValues || Object.values(parsedValues).some((value) => value === null)) {
      return errorJson("invalid_mcp_values", 400);
    }
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.testDraft({
      oneTimeValues: parsedValues as Record<string, McpSlotValue>,
      serverId,
      validationUserId: auth.session.userId
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    return Response.json({ server: result.value });
  };
}

export function createAdminMcpCheckUpdateHandler(deps: McpHandlerDeps) {
  return createAdminMcpDraftTestHandler(deps);
}

export function createAdminMcpRebuildHandler(deps: McpHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const revisionId = text(body?.revisionId, 128);
    const parsedValues = slotValues(body?.oneTimeValues);
    if (!revisionId || !parsedValues || Object.values(parsedValues).some((value) => value === null) ||
      (typeof body?.replaceDraft !== "undefined" && typeof body.replaceDraft !== "boolean")) {
      return errorJson("invalid_mcp_values", 400);
    }
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.rebuildRevision({
      oneTimeValues: parsedValues as Record<string, McpSlotValue>,
      replaceDraft: body?.replaceDraft === true,
      revisionId,
      serverId,
      validationUserId: auth.session.userId
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps);
    return Response.json({ server: result.value });
  };
}

export function createAdminMcpActivateHandler(deps: McpHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.activateDraft(serverId));
    if (result instanceof Response) return result;
    if (result.kind === "revision_required") {
      const queued = await safely(() => deps.repository.requestActivation({
        serverId,
        validationUserId: auth.session.userId
      }));
      if (queued instanceof Response) return queued;
      if (queued.kind !== "ok") return repositoryError(queued);
      notifyActivationRequested(deps);
      return Response.json({ server: queued.value }, { status: 202 });
    }
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps);
    return Response.json({ server: result.value });
  };
}

export function createAdminMcpRollbackHandler(deps: McpHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const revisionId = text(body?.revisionId, 128);
    if (!revisionId) return errorJson("mcp_revision_required", 400);
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.rollbackServer({ revisionId, serverId }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps);
    return Response.json({ server: result.value });
  };
}

export function createAdminMcpGrantHandler(deps: McpHandlerDeps) {
  return async function PUT(request: Request, context: RouteContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const hasUserId = Boolean(body && Object.hasOwn(body, "userId"));
    const hasGroupId = Boolean(body && Object.hasOwn(body, "groupId"));
    const userId = typeof body?.userId === "undefined" ? null : text(body.userId, 128);
    const groupId = typeof body?.groupId === "undefined" ? null : text(body.groupId, 128);
    const rawPersonalSlotKeys = body?.personalSlotKeys;
    const personalSlotKeys = typeof rawPersonalSlotKeys === "undefined"
      ? []
      : Array.isArray(rawPersonalSlotKeys) && rawPersonalSlotKeys.every(
        (entry): entry is string => typeof entry === "string"
      )
        ? rawPersonalSlotKeys
        : null;
    const canUse = body?.canUse;
    if (typeof canUse !== "boolean" || hasUserId === hasGroupId ||
      (hasUserId && !userId) || (hasGroupId && !groupId) || !personalSlotKeys ||
      personalSlotKeys.length > 64 || new Set(personalSlotKeys).size !== personalSlotKeys.length ||
      personalSlotKeys.some((key) => !/^[a-z][a-z0-9_.-]{0,127}$/u.test(key)) ||
      (groupId && personalSlotKeys.length > 0)) {
      return errorJson("invalid_grant", 400);
    }
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.setGrant({
      canUse,
      groupId,
      personalSlotKeys,
      serverId,
      userId
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps);
    return Response.json({ server: result.value });
  };
}

function userServerProjection(server: McpUserServerState, deps: McpHandlerDeps): UserMcpServer {
  let operationalStatus: McpOperationalStatus = "inactive";
  if (server.enabled && server.runtimeGenerationId &&
    ["ready", "starting", "queued", "restarting"].includes(server.readiness)) {
    try {
      operationalStatus = deps.runtimeOperationalStatus?.(server.runtimeGenerationId) ?? "inactive";
      if (operationalStatus === "active" && server.readiness !== "ready") operationalStatus = "checking";
    } catch {
      // A health lookup failure cannot manufacture positive runtime evidence.
    }
  }
  return {
    accountLabel: server.accountLabel,
    description: server.description,
    enabled: server.enabled,
    fields: server.fields,
    id: server.id,
    knownToolCount: server.knownToolCount,
    name: server.name,
    oauthAvailable: server.oauthAvailable,
    oauthState: server.oauthState,
    operationalStatus,
    readiness: server.readiness,
    tools: server.tools
  };
}

export function createUserMcpCatalogHandler(deps: McpHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await requireUser(request, deps);
    if (!session) return errorJson("unauthorized", 401);
    const servers = await safely(() => deps.repository.listUserServers(session.userId));
    if (servers instanceof Response) return servers;
    return Response.json({
      servers: servers.map((server) => userServerProjection(server, deps))
    } satisfies UserMcpCatalogResponse, { headers: { "Cache-Control": "no-store" } });
  };
}

export function createUserMcpUpdateHandler(deps: McpHandlerDeps) {
  return async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const session = await requireUser(request, deps);
    if (!session) return errorJson("unauthorized", 401);
    const [body, bodyError] = await readJsonRecord(request);
    if (bodyError) return bodyError;
    const values = typeof body?.values === "undefined" ? undefined : slotValues(body.values);
    if (!body || (typeof body.enabled !== "undefined" && typeof body.enabled !== "boolean") || values === null ||
      (typeof body.enabled === "undefined" && typeof values === "undefined")) {
      return errorJson("invalid_mcp_values", 400);
    }
    const { serverId } = await context.params;
    const result = await safely(() => deps.repository.updateUserServer({
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      serverId,
      userId: session.userId,
      ...(values !== undefined ? { values } : {})
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return repositoryError(result);
    notifyRuntimeChanged(deps, session.userId);
    return Response.json({ server: userServerProjection(result.value, deps) },
      { headers: { "Cache-Control": "no-store" } });
  };
}
