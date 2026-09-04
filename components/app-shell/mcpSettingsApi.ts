import { shellFetch } from "@/components/app-shell/shellApi";
import type {
  McpReadiness,
  McpOperationalStatus,
  McpSlotValue,
  McpValidationIssue,
  UserMcpCatalogResponse,
  UserMcpServer,
  UserMcpUpdateRequest
} from "@/lib/contracts/mcp";

const readinessValues = new Set<McpReadiness>([
  "authorizing",
  "disabled",
  "idle",
  "needs_authorization",
  "needs_setup",
  "queued",
  "ready",
  "reauthorization_required",
  "restarting",
  "starting",
  "unavailable"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSlotValue(value: unknown): value is McpSlotValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function userServer(value: unknown): UserMcpServer | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
    typeof value.description !== "string" || typeof value.enabled !== "boolean" ||
    typeof value.oauthAvailable !== "boolean" || !readinessValues.has(value.readiness as McpReadiness) ||
    typeof value.knownToolCount !== "number" || !Number.isInteger(value.knownToolCount) ||
    value.knownToolCount < 0 || value.knownToolCount > 512 ||
    !(
      value.oauthState === null ||
      ["disconnected", "disconnecting", "ready", "reauthorization_required"].includes(String(value.oauthState))
    ) ||
    !(value.accountLabel === null || typeof value.accountLabel === "string") ||
    !["active", "checking", "inactive"].includes(String(value.operationalStatus)) ||
    !Array.isArray(value.fields) || !Array.isArray(value.tools)) return null;
  if (value.operationalStatus === "active" && (!value.enabled || value.readiness !== "ready")) return null;

  const fields = value.fields.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.slotKey !== "string" ||
      typeof candidate.label !== "string" || typeof candidate.configured !== "boolean" ||
      typeof candidate.sensitive !== "boolean" ||
      !["missing", "personal", "shared"].includes(String(candidate.source)) ||
      !["boolean", "enum", "number", "secret", "string"].includes(String(candidate.valueType)) ||
      (candidate.value !== undefined && !isSlotValue(candidate.value)) ||
      (candidate.enumValues !== undefined && (!Array.isArray(candidate.enumValues) || candidate.enumValues.some((item) => typeof item !== "string"))) ||
      (candidate.maxLength !== undefined &&
        (typeof candidate.maxLength !== "number" || !Number.isInteger(candidate.maxLength) || candidate.maxLength < 1)) ||
      (candidate.minLength !== undefined &&
        (typeof candidate.minLength !== "number" || !Number.isInteger(candidate.minLength) || candidate.minLength < 0)) ||
      (candidate.description !== undefined && typeof candidate.description !== "string")) return [];
    return [{
      configured: candidate.configured,
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      ...(Array.isArray(candidate.enumValues) ? { enumValues: candidate.enumValues as string[] } : {}),
      label: candidate.label,
      ...(typeof candidate.maxLength === "number" ? { maxLength: candidate.maxLength } : {}),
      ...(typeof candidate.minLength === "number" ? { minLength: candidate.minLength } : {}),
      sensitive: candidate.sensitive,
      slotKey: candidate.slotKey,
      source: candidate.source as "missing" | "personal" | "shared",
      ...(candidate.value !== undefined ? { value: candidate.value } : {}),
      valueType: candidate.valueType as "boolean" | "enum" | "number" | "secret" | "string"
    }];
  });
  if (fields.length !== value.fields.length) return null;

  const tools = value.tools.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string" ||
      !(candidate.description === null || typeof candidate.description === "string")) return [];
    return [{ description: candidate.description as string | null, name: candidate.name }];
  });
  if (tools.length !== value.tools.length) return null;

  return {
    accountLabel: value.accountLabel,
    description: value.description,
    enabled: value.enabled,
    fields,
    id: value.id,
    knownToolCount: value.knownToolCount,
    name: value.name,
    oauthAvailable: value.oauthAvailable,
    oauthState: value.oauthState as UserMcpServer["oauthState"],
    operationalStatus: value.operationalStatus as McpOperationalStatus,
    readiness: value.readiness as McpReadiness,
    tools
  };
}

function catalogResponse(value: unknown): UserMcpCatalogResponse | null {
  if (!isRecord(value) || !Array.isArray(value.servers)) return null;
  const servers = value.servers.map(userServer);
  return servers.every((server): server is UserMcpServer => server !== null) ? { servers } : null;
}

function stableError(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" && value.error.trim()
    ? value.error.trim()
    : "mcp_request_failed";
}

function validationIssues(value: unknown): readonly McpValidationIssue[] {
  if (!isRecord(value) || !Array.isArray(value.issues)) return [];
  const issues = value.issues.slice(0, 64).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.code !== "string" ||
      typeof candidate.path !== "string" || candidate.code.length > 128 || candidate.path.length > 256) return [];
    return [{ code: candidate.code, path: candidate.path }];
  });
  return issues.length === value.issues.length ? issues : [];
}

export class McpSettingsApiError extends Error {
  readonly code: string;
  readonly issues: readonly McpValidationIssue[];
  readonly status: number;

  constructor(code: string, status: number, issues: readonly McpValidationIssue[] = []) {
    super(code);
    this.name = "McpSettingsApiError";
    this.code = code;
    this.issues = issues;
    this.status = status;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadUserMcpServers(signal?: AbortSignal): Promise<UserMcpServer[]> {
  const response = await shellFetch("/api/me/mcp", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new McpSettingsApiError(stableError(body), response.status, validationIssues(body));
  }
  const decoded = catalogResponse(body);
  if (!decoded) throw new McpSettingsApiError("mcp_response_invalid", 502);
  return decoded.servers;
}

export async function updateUserMcpServer(
  serverId: string,
  body: UserMcpUpdateRequest
): Promise<UserMcpServer> {
  const response = await shellFetch(`/api/me/mcp/${encodeURIComponent(serverId)}`, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "PATCH"
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new McpSettingsApiError(stableError(payload), response.status, validationIssues(payload));
  }
  const server = isRecord(payload) ? userServer(payload.server) : null;
  if (!server) throw new McpSettingsApiError("mcp_response_invalid", 502);
  return server;
}

export async function disconnectUserMcpServer(serverId: string): Promise<"disconnected" | "disconnecting"> {
  const response = await shellFetch(`/api/me/mcp/${encodeURIComponent(serverId)}/oauth/disconnect`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    method: "POST"
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new McpSettingsApiError(stableError(payload), response.status, validationIssues(payload));
  }
  if (!isRecord(payload) || (payload.status !== "disconnected" && payload.status !== "disconnecting")) {
    throw new McpSettingsApiError("mcp_response_invalid", 502);
  }
  return payload.status;
}

export function userMcpOAuthAction(serverId: string, reconnect: boolean): string {
  return `/api/me/mcp/${encodeURIComponent(serverId)}/oauth/${reconnect ? "reconnect" : "connect"}`;
}
