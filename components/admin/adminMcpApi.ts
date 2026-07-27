import type {
  AdminMcpCatalogResponse,
  AdminMcpCreateRequest,
  AdminMcpDraftTestRequest,
  AdminMcpGrantRequest,
  AdminMcpRollbackRequest,
  AdminMcpServer,
  AdminMcpUpdateRequest,
  McpErrorResponse,
  McpSlotValue,
  McpValidationIssue
} from "@/lib/contracts/mcp";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminMcpClientError = Readonly<{
  code: string;
  issues: readonly McpValidationIssue[];
}>;

export type AdminMcpClientResult<T> =
  | { data: T; ok: true }
  | { error: AdminMcpClientError; ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssue(value: unknown): value is McpValidationIssue {
  return isRecord(value) && typeof value.code === "string" && typeof value.path === "string";
}

function hasIdentityHash(value: unknown): boolean {
  return isRecord(value) && typeof value.identityHash === "string" && value.identityHash.length > 0;
}

function isActivation(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    [
      "queued",
      "resolving",
      "preparing_runtime",
      "connecting",
      "discovering_tools",
      "publishing",
      "ready",
      "failed"
    ].includes(String(value.stage)) &&
    typeof value.requestedAt === "string" &&
    (value.startedAt === null || typeof value.startedAt === "string") &&
    (value.completedAt === null || typeof value.completedAt === "string") &&
    typeof value.updatedAt === "string" &&
    (value.errorCode === null || typeof value.errorCode === "string") &&
    Array.isArray(value.issues) &&
    value.issues.every(isIssue)
  );
}

function isServer(value: unknown): value is AdminMcpServer {
  if (!isRecord(value)) return false;
  const validActivePersonalSlots = Array.isArray(value.activePersonalSlots) &&
    value.activePersonalSlots.every((slot) => isRecord(slot) &&
      typeof slot.label === "string" && typeof slot.slotKey === "string");
  const validationOAuth = value.validationOAuth;
  const validValidationOAuth = validationOAuth === null || (
    isRecord(validationOAuth) &&
    (validationOAuth.accountLabel === null || typeof validationOAuth.accountLabel === "string") &&
    typeof validationOAuth.connectedAt === "string" &&
    ["disconnected", "disconnecting", "ready", "reauthorization_required"].includes(String(validationOAuth.state))
  );
  const validDraftTest = value.draftTest === null || hasIdentityHash(value.draftTest);
  const validActiveRevision = value.activeRevision === null || hasIdentityHash(value.activeRevision);
  const validRevisions = Array.isArray(value.revisions) && value.revisions.every(hasIdentityHash);
  return (
    validActivePersonalSlots &&
    validActiveRevision &&
    validDraftTest &&
    validRevisions &&
    isActivation(value.activation) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.namespace === "string" &&
    typeof value.description === "string" &&
    typeof value.enabled === "boolean" &&
    (value.archivedAt === null || typeof value.archivedAt === "string") &&
    typeof value.draftTested === "boolean" &&
    isRecord(value.draft) &&
    Array.isArray(value.grants) &&
    isRecord(value.sharedValues) &&
    typeof value.updatedAt === "string" &&
    validValidationOAuth
  );
}

function errorFrom(value: unknown, fallback: string): AdminMcpClientError {
  const response = isRecord(value) ? value as Partial<McpErrorResponse> : null;
  return {
    code: typeof response?.error === "string" ? response.error : fallback,
    issues: Array.isArray(response?.issues) ? response.issues.filter(isIssue) : []
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function request<T>(
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminMcpClientResult<T>> {
  try {
    const response = await fetcher(url, init);
    const value = await readJson(response);
    if (!response.ok) return { error: errorFrom(value, "mcp_admin_action_failed"), ok: false };
    const decoded = decode(value);
    return decoded === null
      ? { error: { code: "mcp_admin_response_invalid", issues: [] }, ok: false }
      : { data: decoded, ok: true };
  } catch {
    return { error: { code: "network_error", issues: [] }, ok: false };
  }
}

function jsonInit(method: "PATCH" | "POST" | "PUT", body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  };
}

function decodeCatalog(value: unknown): AdminMcpCatalogResponse | null {
  if (!isRecord(value) || !Array.isArray(value.servers) || !value.servers.every(isServer)) return null;
  return { servers: value.servers };
}

function decodeServer(value: unknown): AdminMcpServer | null {
  return isRecord(value) && isServer(value.server) ? value.server : null;
}

export function requestAdminMcpCatalog(fetcher: Fetcher = fetch) {
  return request("/api/admin/mcp", { method: "GET" }, decodeCatalog, fetcher);
}

export function createAdminMcpServer(body: AdminMcpCreateRequest, fetcher: Fetcher = fetch) {
  return request("/api/admin/mcp", jsonInit("POST", body), decodeServer, fetcher);
}

export function updateAdminMcpServer(
  serverId: string,
  body: AdminMcpUpdateRequest,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/mcp/${encodeURIComponent(serverId)}`,
    jsonInit("PATCH", body),
    decodeServer,
    fetcher
  );
}

export function deleteAdminMcpServer(serverId: string, fetcher: Fetcher = fetch) {
  return request(
    `/api/admin/mcp/${encodeURIComponent(serverId)}`,
    { method: "DELETE" },
    decodeServer,
    fetcher
  );
}

function postServerAction(
  serverId: string,
  action: string,
  body: unknown,
  fetcher: Fetcher
) {
  return request(
    `/api/admin/mcp/${encodeURIComponent(serverId)}/${action}`,
    jsonInit("POST", body),
    decodeServer,
    fetcher
  );
}

export function testAdminMcpDraft(
  serverId: string,
  body: AdminMcpDraftTestRequest,
  fetcher: Fetcher = fetch
) {
  return postServerAction(serverId, "test", body, fetcher);
}

export function checkAdminMcpUpdate(
  serverId: string,
  body: AdminMcpDraftTestRequest,
  fetcher: Fetcher = fetch
) {
  return postServerAction(serverId, "check-update", body, fetcher);
}

export function activateAdminMcpDraft(serverId: string, fetcher: Fetcher = fetch) {
  return postServerAction(serverId, "activate", {}, fetcher);
}

export function rollbackAdminMcpServer(
  serverId: string,
  body: AdminMcpRollbackRequest,
  fetcher: Fetcher = fetch
) {
  return postServerAction(serverId, "rollback", body, fetcher);
}

export function rebuildAdminMcpRevision(
  serverId: string,
  body: Readonly<{
    oneTimeValues?: Record<string, McpSlotValue>;
    replaceDraft?: boolean;
    revisionId: string;
  }>,
  fetcher: Fetcher = fetch
) {
  return postServerAction(serverId, "rebuild", body, fetcher);
}

export function setAdminMcpGrant(
  serverId: string,
  body: AdminMcpGrantRequest,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/mcp/${encodeURIComponent(serverId)}/grants`,
    jsonInit("PUT", body),
    decodeServer,
    fetcher
  );
}

export function disconnectAdminMcpValidationOAuth(serverId: string, fetcher: Fetcher = fetch) {
  return request(
    `/api/admin/mcp/${encodeURIComponent(serverId)}/oauth/validation/disconnect`,
    jsonInit("POST", {}),
    (value) => isRecord(value) ? value : null,
    fetcher
  );
}

export function adminMcpErrorMessage(error: AdminMcpClientError): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage MCP servers.",
    invalid_draft: "Review the highlighted MCP draft fields and try again.",
    invalid_grant: "This MCP grant is no longer valid. Refresh and try again.",
    invalid_mcp_values: "One or more MCP values are missing or invalid.",
    json_required: "The MCP request format was not accepted. Refresh and try again.",
    mcp_admin_action_failed: "The MCP action could not be completed.",
    mcp_admin_response_invalid: "The MCP API returned an unexpected response. Refresh and try again.",
    mcp_artifact_missing: "The exact local artifact is no longer cached. Rebuild and activate this revision instead.",
    mcp_draft_changed: "The draft changed after testing. Test the current draft again before activation.",
    mcp_draft_test_failed: "The MCP draft could not be validated. Review the reported fields and server response.",
    mcp_encryption_unavailable: "Secret storage is unavailable. Check AIQSA_ENCRYPTION_KEY.",
    mcp_not_found: "This MCP server no longer exists. Refresh the catalog.",
    mcp_revision_required: "Choose a tested revision before continuing.",
    mcp_storage_unavailable: "MCP storage is temporarily unavailable.",
    mcp_validation_unavailable: "The MCP validation runtime is unavailable. Check the runtime and try again.",
    network_error: "Could not reach the MCP administration API.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  const summary = messages[error.code] ?? "The MCP action could not be completed. Refresh and try again.";
  if (!error.issues.length) return summary;
  const detail = error.issues.slice(0, 4).map((issue) => {
    if (issue.code === "mcp_local_environment_missing") {
      const environmentName = /^slots\.([A-Z][A-Z0-9_]{1,127})$/u.exec(issue.path)?.[1];
      return environmentName
        ? `The MCP process requires ${environmentName}. Add it under Configuration fields and provide the value needed for testing.`
        : "The MCP process is missing a required environment variable. Review its setup instructions and Configuration fields.";
    }
    if (issue.code === "mcp_local_process_failed") {
      return "The MCP process exited during startup. Check its documented environment variables and launch arguments.";
    }
    return `${issue.path}: ${issue.code}`;
  }).join("; ");
  return `${summary} ${detail}`;
}
