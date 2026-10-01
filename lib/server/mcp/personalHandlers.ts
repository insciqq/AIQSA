import type { McpDraftConfiguration, McpOperationalStatus, McpSlotValue } from "@/lib/contracts/mcp";
import { isMcpToolName, MCP_SERVER_TOOL_LIMIT, mcpValidationIssue, type McpValidationIssue } from "@/lib/contracts/mcp";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "@/lib/server/http/requestBody";
import type { McpRepository, McpUserServerState } from "./repositoryContract";
import { validateMcpDraft } from "./definitions";
import { userServerProjection } from "./handlers";
import { McpEncryptionError } from "./encryption";
import { McpDraftValidationUnavailableError } from "./draftValidator";

type PersonalDeps = {
  onConnectionChanged?(userId: string, serverId: string): Promise<void>;
  onRuntimeChanged?(userId?: string): void;
  prepareOAuthDraft?(draft: McpDraftConfiguration): Promise<McpDraftConfiguration>;
  runtimeOperationalStatus?(generationId: string): McpOperationalStatus;
  repository: McpRepository;
  resolveAuth: RequestAuthResolver;
};

type RouteContext = { params: Promise<{ connectionId?: string; serverId?: string }> | { connectionId?: string; serverId?: string } };

function errorJson(error: string, status: number, issues?: readonly McpValidationIssue[]): Response {
  return Response.json({ error, ...(issues?.length ? { issues: issues.slice(0, 20).map((issue) => mcpValidationIssue(issue)) } : {}) }, { status });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function values(value: unknown): Record<string, McpSlotValue> | null {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > 32) return null;
  const output: Record<string, McpSlotValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(key) ||
      (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") ||
      (typeof candidate === "string" && (candidate.length > 16_384 || /[\r\n]/u.test(candidate))) ||
      (typeof candidate === "number" && !Number.isFinite(candidate))) return null;
    output[key] = candidate;
  }
  return output;
}

function selectedTools(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MCP_SERVER_TOOL_LIMIT || value.some((item) => !isMcpToolName(item)) ||
    new Set(value).size !== value.length) return null;
  return [...new Set(value)].sort();
}

function remoteDraft(input: Record<string, unknown>): { draft: McpDraftConfiguration; values: Record<string, McpSlotValue> } | { error: string; path: string } {
  const url = text(input.url, 2_048);
  if (!url) return { error: "url_required", path: "url" };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { error: "url_invalid", path: "url" }; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: "url_invalid", path: "url" };
  }
  if (parsed.protocol === "http:" && input.insecureHttpAcknowledged !== true) {
    return { error: "insecure_http_acknowledgement_required", path: "insecureHttpAcknowledged" };
  }
  if (input.auth !== undefined && !record(input.auth)) return { error: "auth_mode_invalid", path: "auth.mode" };
  const auth = record(input.auth) ? input.auth : { mode: "none" };
  const mode = auth.mode;
  if (mode !== "none" && mode !== "static" && mode !== "oauth") return { error: "auth_mode_invalid", path: "auth.mode" };
  const parsedValues = values(input.values);
  if (!parsedValues || Object.keys(parsedValues).some((key) => mode !== "static" || key !== "authorization")) {
    return { error: "invalid_mcp_values", path: "values" };
  }
  const headerName = auth.headerName === undefined ? "Authorization" : text(auth.headerName, 128);
  if (mode === "static" && (!headerName || ["host", "cookie", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization"].includes(headerName.toLowerCase()))) {
    return { error: "header_name_invalid", path: "auth.headerName" };
  }
  const slot = mode === "static" ? {
    label: "Authorization header",
    policy: { kind: "personal" as const, required: true as const },
    sensitive: true,
    slotKey: "authorization",
    target: { kind: "header" as const, name: headerName! },
    valueType: "secret" as const
  } : null;
  if (slot && (typeof parsedValues.authorization !== "string" || !parsedValues.authorization.trim())) {
    return { error: "authorization_required", path: "values.authorization" };
  }
  const checked = validateMcpDraft({
      auth: mode === "oauth"
        ? { allowedAuthorizationServerOrigins: [parsed.origin], mode: "oauth" as const, scopes: [] }
        : { mode },
      runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
      slots: slot ? [slot] : [],
      source: { kind: "remote", url: parsed.toString() },
      transport: "streamable_http"
  });
  if (!checked.ok) return { error: "invalid_draft", path: checked.issues[0]?.path ?? "draft" };
  return { draft: checked.value, values: parsedValues };
}

async function safely<T>(operation: () => Promise<T>): Promise<T | Response> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof McpEncryptionError) return errorJson("mcp_encryption_unavailable", 503);
    if (error instanceof McpDraftValidationUnavailableError) return errorJson("mcp_validation_unavailable", 503);
    throw error;
  }
}

async function settleConnection(deps: PersonalDeps, userId: string, server: McpUserServerState): Promise<McpUserServerState> {
  if (!deps.onConnectionChanged || !server.enabled || (server.oauthAvailable && server.oauthState !== "ready")) return server;
  try { await deps.onConnectionChanged(userId, server.id); }
  catch { /* Runtime failure is persisted and shown in the refreshed connection. */ }
  return (await deps.repository.listUserServers(userId)).find((item) => item.id === server.id && item.sourceType === "personal") ?? server;
}

export function createPersonalMcpListHandler(deps: PersonalDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    if (session.user.status !== "active") return errorJson("forbidden", 403);
    const servers = await safely(() => deps.repository.listUserServers(session.userId));
    if (servers instanceof Response) return servers;
    return Response.json({ servers: servers.filter((server) => server.sourceType === "personal").map((server) => userServerProjection(server, deps)) }, {
      headers: { "Cache-Control": "no-store" }
    });
  };
}

export function createPersonalMcpCreateHandler(deps: PersonalDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    if (session.user.status !== "active") return errorJson("forbidden", 403);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return errorJson("json_required", 415);
    const body = await readJsonBodyOrNull(request, "json");
    if (!record(body)) return requestBodyErrorResponse(body) ?? errorJson("invalid_mcp_values", 400);
    const name = text(body.name, 120);
    const description = body.description === undefined ? "" : typeof body.description === "string" && body.description.length <= 4_000 ? body.description.trim() : null;
    const draft = remoteDraft(body);
    const selected = selectedTools(body.selectedToolNames);
    if (!name || description === null || selected === null) return errorJson("invalid_mcp_values", 400);
    if ("error" in draft) return errorJson(draft.error, 422, [{ code: draft.error, path: draft.path }]);
    const createPersonalServer = deps.repository.createPersonalServer;
    if (!createPersonalServer) return errorJson("mcp_unavailable", 503);
    let prepared = draft.draft;
    if (prepared.auth.mode === "oauth" && deps.prepareOAuthDraft) {
      try { prepared = await deps.prepareOAuthDraft(prepared); }
      catch { return errorJson("mcp_oauth_discovery_failed", 422); }
    }
    const result = await safely(() => createPersonalServer({
      description,
      draft: prepared,
      name,
      ...(selected !== undefined ? { selectedToolNames: selected } : {}),
      userId: session.userId,
      values: draft.values
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") {
      if (result.kind === "draft_validation_failed") return errorJson("mcp_draft_test_failed", 422, result.issues);
      if (result.kind === "invalid_values") return errorJson("invalid_mcp_values", 400, result.issues);
      return errorJson("mcp_not_found", 404);
    }
    try { deps.onRuntimeChanged?.(session.userId); } catch { /* persistence is authoritative */ }
    const settled = await safely(() => settleConnection(deps, session.userId, result.value));
    if (settled instanceof Response) return settled;
    return Response.json({ server: userServerProjection(settled, deps) }, { headers: { "Cache-Control": "no-store" }, status: 201 });
  };
}

export function createPersonalMcpUpdateHandler(deps: PersonalDeps) {
  return async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    if (session.user.status !== "active") return errorJson("forbidden", 403);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return errorJson("json_required", 415);
    const body = await readJsonBodyOrNull(request, "json");
    if (!record(body)) return requestBodyErrorResponse(body) ?? errorJson("invalid_mcp_values", 400);
    const tool = record(body.tool) && isMcpToolName(body.tool.name) && typeof body.tool.enabled === "boolean"
      ? { enabled: body.tool.enabled, name: body.tool.name }
      : undefined;
    if ((body.tool !== undefined && !tool) || (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
      (body.enabled === undefined && !tool)) return errorJson("invalid_mcp_values", 400);
    const params = await context.params;
    const connectionId = params.connectionId ?? params.serverId;
    if (!connectionId) return errorJson("mcp_not_found", 404);
    const result = await safely(() => deps.repository.updateUserServer({
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      personalOnly: true,
      ...(tool ? { tool } : {}),
      serverId: connectionId,
      userId: session.userId
    }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return errorJson(result.kind === "invalid_values" ? "invalid_mcp_values" : "mcp_not_found", result.kind === "invalid_values" ? 400 : 404, result.kind === "invalid_values" ? result.issues : undefined);
    try { deps.onRuntimeChanged?.(session.userId); } catch { /* persistence is authoritative */ }
    const settled = await safely(() => settleConnection(deps, session.userId, result.value));
    if (settled instanceof Response) return settled;
    return Response.json({ server: userServerProjection(settled, deps) }, { headers: { "Cache-Control": "no-store" } });
  };
}

export function createPersonalMcpDeleteHandler(deps: PersonalDeps) {
  return async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    if (session.user.status !== "active") return errorJson("forbidden", 403);
    const deletePersonalServer = deps.repository.deletePersonalServer;
    if (!deletePersonalServer) return errorJson("mcp_unavailable", 503);
    const params = await context.params;
    const connectionId = params.connectionId ?? params.serverId;
    if (!connectionId) return errorJson("mcp_not_found", 404);
    const result = await safely(() => deletePersonalServer({ serverId: connectionId, userId: session.userId }));
    if (result instanceof Response) return result;
    if (result.kind !== "ok") return errorJson("mcp_not_found", 404);
    try { deps.onRuntimeChanged?.(session.userId); } catch { /* persistence is authoritative */ }
    return Response.json({ server: userServerProjection(result.value, deps) }, { headers: { "Cache-Control": "no-store" } });
  };
}
