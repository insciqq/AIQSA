import { mcpValidationIssue } from "@/lib/contracts/mcp";
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
  if (!isRecord(value)) return false;
  const safe = mcpValidationIssue(value);
  return safe.code === value.code && safe.path === value.path &&
    ["httpStatus", "operation", "endpoint"].every((key) => value[key] === undefined || value[key] === safe[key as keyof McpValidationIssue]);
}

function hasIdentityHash(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.identityHash === "string" && value.identityHash.length > 0 &&
    hasValidDisabledToolNames(value);
}

function hasValidDisabledToolNames(value: Record<string, unknown>): boolean {
  if (!("disabledToolNames" in value)) return true;
  return Array.isArray(value.disabledToolNames) && value.disabledToolNames.length <= 512 &&
    value.disabledToolNames.every((name) =>
      typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(name));
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
    (value.runtimeProblem === undefined || value.runtimeProblem === null ||
      value.runtimeProblem === "reauthorization_required" || value.runtimeProblem === "unavailable") &&
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
    isRecord(value.draft) && hasValidDisabledToolNames(value.draft) &&
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
    invalid_draft: "Review the MCP configuration fields and try again.",
    invalid_grant: "This MCP grant is no longer valid. Refresh and try again.",
    invalid_mcp_values: "One or more MCP values are missing or invalid.",
    json_required: "The MCP request format was not accepted. Refresh and try again.",
    mcp_admin_action_failed: "The MCP action could not be completed.",
    mcp_admin_response_invalid: "The MCP API returned an unexpected response. Refresh and try again.",
    mcp_artifact_missing: "The saved build of this configuration is no longer cached. Rebuild and apply it instead.",
    mcp_draft_changed: "These settings changed during editing or checking. Reopen the server, review the latest settings, and use Test & Save again.",
    mcp_draft_test_failed: "The MCP check failed. Your changes were not applied; the current configuration keeps running.",
    mcp_encryption_unavailable: "Secret storage is unavailable. Check AIQSA_ENCRYPTION_KEY.",
    mcp_not_found: "This MCP server no longer exists. Refresh the catalog.",
    mcp_revision_required: "Choose a checked configuration before continuing.",
    mcp_storage_unavailable: "MCP storage is temporarily unavailable.",
    mcp_validation_unavailable: "The MCP validation runtime is unavailable. Check the runtime and try again.",
    network_error: "Could not reach the MCP administration API.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  const summary = messages[error.code] ?? "The MCP action could not be completed. Refresh and try again.";
  if (!error.issues.length) return summary;
  const detail = error.issues.slice(0, 4).map((rawIssue) => {
    const issue = mcpValidationIssue(rawIssue);
    const stage = issue.operation === "initialize" ? "MCP initialization" : issue.operation === "list_tools" ? "tools/list" : "MCP connection";
    const location = issue.endpoint ? ` at ${issue.endpoint}` : "";
    if (issue.code === "mcp_gitlab_reauthorization_required") return "GitLab advertised its /api/v4/mcp endpoint, but the current OAuth grant does not authorize that resource. Set the advertised MCP URL and reconnect before Test & Save.";
    if (issue.code === "mcp_gitlab_endpoint_failed") return "GitLab advertised its /api/v4/mcp endpoint, but that endpoint did not pass MCP validation. Review its availability and permissions; the saved URL was not changed.";
    if (issue.code === "mcp_draft_changed") return "The configuration or OAuth connection changed during validation. Use Test & Save again.";
    if (issue.httpStatus) {
      const next = issue.httpStatus === 401 || issue.httpStatus === 403
        ? "Check the account authorization and required permissions; reconnect if needed."
        : issue.httpStatus === 404 && issue.operation !== "list_tools"
          ? "Confirm the server's MCP endpoint. A website URL may not be an MCP endpoint."
          : issue.operation === "list_tools" ? "The server connected, but its tool list could not be read. Check permissions and server availability."
            : "Check the server's availability and try again.";
      return `HTTP ${issue.httpStatus} during ${stage}${location}. ${next}`;
    }
    if (issue.code === "mcp_tls_failed") return `TLS verification failed during ${stage}${location}. Check the server certificate and HTTPS configuration.`;
    if (issue.code === "mcp_network_failed") return `Network connection failed during ${stage}${location}. Check DNS and server availability.`;
    if (issue.code === "mcp_connection_forbidden") return `The network policy blocked ${stage}${location}. Review this server's URL and network settings.`;
    if (issue.code === "mcp_authorization_required") return `Authorization is required for ${stage}${location}. Reconnect the account and check its permissions.`;
    if (issue.code === "mcp_oauth_validation_deferred") {
      return "Connect your administrator account under Authorization on the server page, then use Test & Save. That account is used only to check settings.";
    }
    if (issue.code === "mcp_oauth_reauthorization_required") {
      return "The authorization has expired or was revoked. Reconnect under Authorization on the server page, then use Test & Save.";
    }
    if (issue.code === "mcp_request_timeout") {
      return `The server did not respond in time during ${stage}${location}. Check its availability and try again.`;
    }
    if (issue.code === "mcp_remote_validation_failed" || issue.code === "mcp_initialize_failed") {
      return "Could not connect to this MCP server. Check its URL, credentials and network access.";
    }
    if (issue.code === "mcp_list_tools_failed") {
      return "Connected, but could not read the tool list. Check the account's permissions and try again.";
    }
    if (issue.code === "mcp_effective_value_required") {
      return "A required configuration value is missing. Fill in the server's configuration fields and try again.";
    }
    if (issue.code === "validation_identity_invalid") {
      return "Your administrator access changed during the check. Sign in again before applying settings.";
    }
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
