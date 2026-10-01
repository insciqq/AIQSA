import { shellFetch } from "./shellApi";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import { isMcpToolName } from "@/lib/contracts/mcp";

export type PersonalMcpCreateInput = {
  auth: { headerName?: string; mode: "none" | "oauth" | "static" };
  description?: string;
  insecureHttpAcknowledged?: boolean;
  name: string;
  selectedToolNames?: string[];
  url: string;
  values?: Record<string, string | number | boolean>;
};

export class PersonalMcpApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PersonalMcpApiError";
    this.status = status;
  }
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function userServer(value: unknown): UserMcpServer | null {
  if (!record(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
    typeof value.description !== "string" || typeof value.enabled !== "boolean" ||
    value.sourceType !== "personal" || !Array.isArray(value.fields) || !Array.isArray(value.tools) ||
    !["authorizing", "disabled", "idle", "needs_authorization", "needs_setup", "queued", "ready", "reauthorization_required", "restarting", "starting", "unavailable"].includes(String(value.readiness))) {
    return null;
  }
  if (value.knownToolCount !== undefined && (typeof value.knownToolCount !== "number" || !Number.isInteger(value.knownToolCount) || value.knownToolCount < 0 || value.knownToolCount > 1024)) return null;
  if (value.endpoint !== undefined && typeof value.endpoint !== "string") return null;
  if (value.oauthState !== null && value.oauthState !== undefined &&
    !["disconnected", "disconnecting", "ready", "reauthorization_required"].includes(String(value.oauthState))) return null;
  const fields = value.fields.flatMap((field) => record(field) && typeof field.slotKey === "string" &&
    typeof field.label === "string" && typeof field.configured === "boolean" &&
    typeof field.sensitive === "boolean" && typeof field.valueType === "string" &&
    ["missing", "personal", "shared"].includes(String(field.source))
    ? [field as UserMcpServer["fields"][number]]
    : []);
  if (fields.length !== value.fields.length) return null;
  const tools = value.tools.flatMap((tool) => record(tool) && isMcpToolName(tool.name) &&
    (tool.description === null || typeof tool.description === "string")
    ? [{ name: tool.name, description: tool.description as string | null }]
    : []);
  if (tools.length !== value.tools.length) return null;
  if (value.availableTools !== undefined && !Array.isArray(value.availableTools)) return null;
  const availableTools = value.availableTools === undefined ? undefined : value.availableTools.flatMap((tool) => record(tool) &&
    isMcpToolName(tool.name) && (tool.description === null || typeof tool.description === "string")
    ? [{ name: tool.name, description: tool.description as string | null }]
    : []);
  if (Array.isArray(value.availableTools) && availableTools?.length !== value.availableTools.length) return null;
  const selectedToolNames = value.selectedToolNames === undefined
    ? undefined
    : Array.isArray(value.selectedToolNames) && value.selectedToolNames.every(isMcpToolName)
      ? [...new Set(value.selectedToolNames)]
      : null;
  if (selectedToolNames === null) return null;
  return {
    accountLabel: value.accountLabel === null || typeof value.accountLabel === "string" ? value.accountLabel : null,
    ...(availableTools ? { availableTools } : {}),
    description: value.description,
    enabled: value.enabled,
    ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}),
    fields,
    id: value.id,
    knownToolCount: typeof value.knownToolCount === "number" && Number.isInteger(value.knownToolCount) ? value.knownToolCount : tools.length,
    name: value.name,
    oauthAvailable: typeof value.oauthAvailable === "boolean" ? value.oauthAvailable : false,
    oauthState: value.oauthState === null || typeof value.oauthState === "string" ? value.oauthState as UserMcpServer["oauthState"] : null,
    readiness: value.readiness as UserMcpServer["readiness"],
    ...(selectedToolNames ? { selectedToolNames } : {}),
    sourceType: "personal",
    tools
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await shellFetch(path, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  const body = await json(response);
  if (!response.ok) throw new PersonalMcpApiError(record(body) && typeof body.error === "string" ? body.error : "mcp_request_failed", response.status);
  return body;
}

export async function loadPersonalMcpConnections(): Promise<UserMcpServer[]> {
  const body = await request("/api/me/mcp-connections", { cache: "no-store" });
  if (!record(body) || !Array.isArray(body.servers)) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  const servers = body.servers.map(userServer);
  if (servers.some((server) => server === null)) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  return servers as UserMcpServer[];
}

export async function createPersonalMcp(input: PersonalMcpCreateInput): Promise<{ server: UserMcpServer }> {
  const body = await request("/api/me/mcp-connections", { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST" });
  const server = record(body) ? userServer(body.server) : null;
  if (!server) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  return { server };
}

export async function updatePersonalMcp(id: string, body: { enabled?: boolean; tool?: { enabled: boolean; name: string } }): Promise<UserMcpServer> {
  const payload = await request(`/api/me/mcp-connections/${encodeURIComponent(id)}`, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "PATCH" });
  const server = record(payload) ? userServer(payload.server) : null;
  if (!server) throw new PersonalMcpApiError("mcp_response_invalid", 502);
  return server;
}

export async function deletePersonalMcp(id: string): Promise<void> {
  await request(`/api/me/mcp-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}
