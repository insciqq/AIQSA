import { shellFetch } from "./shellApi";
import {
  isMcpToolName,
  MCP_SERVER_TOOL_LIMIT,
  mcpHeaderValue,
  mcpRuntimeErrorCode,
  type McpReadiness,
  type McpRuntimeErrorCode,
  type UserMcpServer
} from "@/lib/contracts/mcp";

export type PersonalMcpAuthMode = "none" | "oauth" | "static";

/**
 * Runtime codes of the contract registry that the local-network and
 * toggle-run-continuity tasks add to `McpRuntimeErrorCode`. The decoder
 * accepts them before and after those server halves land.
 */
export const PERSONAL_MCP_REGISTRY_RUNTIME_ERROR_CODES = [
  "mcp_internal_address_forbidden",
  "mcp_local_network_disabled",
  "mcp_tool_definition_changed",
  "mcp_tool_disabled"
] as const;

export type PersonalMcpRuntimeErrorCode =
  | McpRuntimeErrorCode
  | (typeof PERSONAL_MCP_REGISTRY_RUNTIME_ERROR_CODES)[number];

export type PersonalMcpTool = { description: string | null; name: string };

/** The browser-safe personal projection Settings and the composer read. */
export type PersonalMcpConnection = {
  accountLabel: string | null;
  /** Header the stored secret is sent in; null unless `authMode` is static. */
  authHeaderName: string | null;
  authMode: PersonalMcpAuthMode;
  /** Every upstream tool, including the ones the owner switched off. */
  availableTools: PersonalMcpTool[];
  description: string;
  enabled: boolean;
  endpoint?: string;
  fields: UserMcpServer["fields"];
  id: string;
  knownToolCount: number;
  name: string;
  oauthAvailable: boolean;
  oauthState: UserMcpServer["oauthState"];
  readiness: McpReadiness;
  runtimeErrorCode: PersonalMcpRuntimeErrorCode | null;
  sourceType: "personal";
  tools: PersonalMcpTool[];
  /** Tools the owner switched off; every other upstream tool is on. */
  userDisabledToolNames: string[];
};

export type PersonalMcpCreateInput = {
  auth: { headerName?: string; mode: PersonalMcpAuthMode };
  /** Cross-site OAuth authorization origins the user confirmed. */
  authorizationOriginsAcknowledged?: string[];
  description?: string;
  insecureHttpAcknowledged?: boolean;
  name: string;
  url: string;
  values?: { authorization: string };
};

/**
 * Credential replacement for a static connection (`PATCH`, exclusive with
 * `enabled` and `tool`). A header-name change always carries a new secret.
 */
export type PersonalMcpCredentialsInput = {
  credentials: { authorization: string; headerName?: string };
};

export type PersonalMcpIssue = { code: string; path: string };

export class PersonalMcpApiError extends Error {
  /** Cross-site origins the server asks the user to confirm. */
  readonly authorizationOrigins: readonly string[];
  readonly code: string;
  /** Field-associated codes only; upstream status, operation and endpoint never reach the UI. */
  readonly issues: readonly PersonalMcpIssue[];
  readonly retryAfterSeconds: number | null;
  readonly status: number;

  constructor(code: string, status: number, details: Readonly<{
    authorizationOrigins?: readonly string[];
    issues?: readonly PersonalMcpIssue[];
    retryAfterSeconds?: number | null;
  }> = {}) {
    super(code);
    this.name = "PersonalMcpApiError";
    this.authorizationOrigins = details.authorizationOrigins ?? [];
    this.code = code;
    this.issues = details.issues ?? [];
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.status = status;
  }
}

const readinessValues = new Set<McpReadiness>([
  "authorizing", "disabled", "idle", "needs_authorization", "needs_setup", "queued", "ready",
  "reauthorization_required", "restarting", "starting", "unavailable"
]);

/**
 * The value sent for a personal static credential: the shared header rule,
 * so a bare `Authorization` token becomes a Bearer token.
 */
export function personalMcpAuthorizationValue(headerName: string, value: string): string {
  return mcpHeaderValue(headerName, value);
}

export function personalMcpOAuthConnectAction(connectionId: string): string {
  return `/api/me/mcp-connections/${encodeURIComponent(connectionId)}/oauth/connect`;
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPersonalMcpRuntimeErrorCode(value: unknown): value is PersonalMcpRuntimeErrorCode {
  return typeof value === "string" && (mcpRuntimeErrorCode(value) === value ||
    (PERSONAL_MCP_REGISTRY_RUNTIME_ERROR_CODES as readonly string[]).includes(value));
}

function toolList(value: unknown): PersonalMcpTool[] | null {
  if (!Array.isArray(value) || value.length > MCP_SERVER_TOOL_LIMIT) return null;
  const tools = value.flatMap((tool) => record(tool) && isMcpToolName(tool.name) &&
    (tool.description === null || typeof tool.description === "string")
    ? [{ description: tool.description as string | null, name: tool.name }]
    : []);
  return tools.length === value.length ? tools : null;
}

function connection(value: unknown): PersonalMcpConnection | null {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" ||
    typeof value.description !== "string" || typeof value.enabled !== "boolean" ||
    value.sourceType !== "personal" || !Array.isArray(value.fields) ||
    typeof value.oauthAvailable !== "boolean" || !readinessValues.has(value.readiness as McpReadiness) ||
    !(value.accountLabel === null || typeof value.accountLabel === "string") ||
    typeof value.knownToolCount !== "number" || !Number.isInteger(value.knownToolCount) ||
    value.knownToolCount < 0 || value.knownToolCount > MCP_SERVER_TOOL_LIMIT ||
    (value.endpoint !== undefined && typeof value.endpoint !== "string") ||
    !(value.oauthState === null ||
      ["disconnected", "disconnecting", "ready", "reauthorization_required"].includes(String(value.oauthState))) ||
    (value.authMode !== undefined && value.authMode !== "none" && value.authMode !== "oauth" && value.authMode !== "static") ||
    !(value.authHeaderName === undefined || value.authHeaderName === null ||
      (typeof value.authHeaderName === "string" && value.authHeaderName.length > 0 && value.authHeaderName.length <= 128)) ||
    !(value.runtimeErrorCode === null || isPersonalMcpRuntimeErrorCode(value.runtimeErrorCode))) {
    return null;
  }
  const fields = value.fields.flatMap((field) => record(field) && typeof field.slotKey === "string" &&
    typeof field.label === "string" && typeof field.configured === "boolean" &&
    typeof field.sensitive === "boolean" && typeof field.valueType === "string" &&
    ["missing", "personal", "shared"].includes(String(field.source))
    ? [field as UserMcpServer["fields"][number]]
    : []);
  if (fields.length !== value.fields.length) return null;
  const tools = toolList(value.tools);
  const availableTools = toolList(value.availableTools);
  if (!tools || !availableTools) return null;
  const disabled = value.userDisabledToolNames;
  if (!Array.isArray(disabled) || disabled.length > MCP_SERVER_TOOL_LIMIT || !disabled.every(isMcpToolName)) return null;
  // The projection names the mode; a row without it derives the same fact
  // from its own projected secret slot and OAuth availability.
  const authMode: PersonalMcpAuthMode = value.authMode === "none" || value.authMode === "oauth" || value.authMode === "static"
    ? value.authMode
    : value.oauthAvailable ? "oauth" : fields.some((field) => field.slotKey === "authorization" && field.sensitive) ? "static" : "none";
  return {
    accountLabel: value.accountLabel,
    authHeaderName: typeof value.authHeaderName === "string" ? value.authHeaderName : null,
    authMode,
    availableTools,
    description: value.description,
    enabled: value.enabled,
    ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}),
    fields,
    id: value.id,
    knownToolCount: value.knownToolCount,
    name: value.name,
    oauthAvailable: value.oauthAvailable,
    oauthState: value.oauthState as PersonalMcpConnection["oauthState"],
    readiness: value.readiness as McpReadiness,
    runtimeErrorCode: value.runtimeErrorCode as PersonalMcpRuntimeErrorCode | null,
    sourceType: "personal",
    tools,
    userDisabledToolNames: [...new Set(disabled)]
  };
}

function issues(value: unknown): PersonalMcpIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((issue) => record(issue) && typeof issue.code === "string" &&
    /^[a-z0-9_.-]{1,128}$/u.test(issue.code) && typeof issue.path === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/u.test(issue.path)
    ? [{ code: issue.code, path: issue.path }]
    : []);
}

function origins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 2_048) return null;
    try {
      if (new URL(item).origin !== item) return null;
    } catch {
      return null;
    }
    output.push(item);
  }
  return [...new Set(output)];
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^\d{1,6}$/u.test(raw)) return null;
  const seconds = Number(raw);
  return seconds > 0 ? seconds : null;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await shellFetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) }
  });
  const body = await json(response);
  if (!response.ok) {
    const code = record(body) && typeof body.error === "string" && /^[a-z0-9_.-]{1,128}$/u.test(body.error)
      ? body.error
      : "mcp_request_failed";
    if (code === "oauth_authorization_origin_confirmation_required") {
      const confirmed = record(body) ? origins(body.authorizationOrigins) : null;
      if (!confirmed) throw new PersonalMcpApiError("mcp_response_invalid", 502);
      throw new PersonalMcpApiError(code, response.status, { authorizationOrigins: confirmed, issues: issues(record(body) ? body.issues : null) });
    }
    throw new PersonalMcpApiError(code, response.status, {
      issues: issues(record(body) ? body.issues : null),
      retryAfterSeconds: response.status === 429 ? retryAfter(response) : null
    });
  }
  return body;
}

function serverOf(body: unknown): PersonalMcpConnection {
  const server = record(body) ? connection(body.server) : null;
  if (!server) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  return server;
}

const jsonHeaders = { "content-type": "application/json" };

export async function loadPersonalMcpConnections(signal?: AbortSignal): Promise<PersonalMcpConnection[]> {
  const body = await request("/api/me/mcp-connections", { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!record(body) || !Array.isArray(body.servers)) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  const servers = body.servers.map(connection);
  if (servers.some((server) => server === null)) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  return servers as PersonalMcpConnection[];
}

export async function createPersonalMcp(input: PersonalMcpCreateInput): Promise<PersonalMcpConnection> {
  return serverOf(await request("/api/me/mcp-connections", { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" }));
}

export async function updatePersonalMcp(
  id: string,
  body: { enabled: boolean } | { tool: { enabled: boolean; name: string } }
): Promise<PersonalMcpConnection> {
  return serverOf(await request(`/api/me/mcp-connections/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body), headers: jsonHeaders, method: "PATCH"
  }));
}

/** Replaces the write-only secret (and optionally its header) in place; the row keeps its id and switch-offs. */
export async function replacePersonalMcpCredentials(id: string, body: PersonalMcpCredentialsInput): Promise<PersonalMcpConnection> {
  return serverOf(await request(`/api/me/mcp-connections/${encodeURIComponent(id)}`, {
    body: JSON.stringify(body), headers: jsonHeaders, method: "PATCH"
  }));
}

export async function deletePersonalMcp(id: string): Promise<void> {
  await request(`/api/me/mcp-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}
