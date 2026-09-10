const MCP_RUNTIME_ERROR_MESSAGES = {
  mcp_accepted_generation_changed: "The MCP configuration or tool changed. Start a new request to use the current configuration.",
  mcp_authorization_required: "MCP authorization is no longer valid. Reconnect in MCP settings.",
  mcp_connect_failed: "The MCP connection failed. Check the server and try again.",
  mcp_health_check_failed: "The MCP health check failed. Check the server and try again.",
  mcp_inventory_invalid: "The MCP server returned an invalid tool inventory. Ask an administrator to check the server.",
  mcp_inventory_changed: "The MCP tool inventory changed. Refresh the connection before trying again.",
  mcp_response_too_large: "The MCP server response exceeded its size limit. Ask an administrator to check the server.",
  mcp_runtime_unavailable: "The MCP runtime is unavailable. Check MCP settings and try again.",
  mcp_session_closed: "The MCP session closed. Try again to reconnect the runtime.",
  mcp_timeout: "The MCP server timed out. Check the server and try again."
} as const;

export type McpRuntimeErrorCode = keyof typeof MCP_RUNTIME_ERROR_MESSAGES;

/** Only bounded diagnostic categories cross the catalog and tool-result boundary. */
export function mcpRuntimeErrorCode(value: unknown): McpRuntimeErrorCode {
  if (typeof value === "string" && Object.hasOwn(MCP_RUNTIME_ERROR_MESSAGES, value)) {
    return value as McpRuntimeErrorCode;
  }
  if (value === "mcp_request_timeout") return "mcp_timeout";
  if (value === "mcp_network_failed" || value === "mcp_tls_failed" || value === "mcp_connection_forbidden") return "mcp_connect_failed";
  if (value === "mcp_ping_failed" || value === "mcp_ping_unsupported") return "mcp_health_check_failed";
  if (value === "mcp_oauth_reauthorization_required" || value === "oauth_reauthorization_required") return "mcp_authorization_required";
  if (typeof value === "string" && /^mcp_(?:initialize|inventory|call_result)_response_too_large$/.test(value)) return "mcp_response_too_large";
  if (value === "mcp_call_result_too_large" || value === "mcp_initialize_response_too_large") return "mcp_response_too_large";
  if (typeof value === "string" && value.startsWith("mcp_inventory_")) return "mcp_inventory_invalid";
  return "mcp_runtime_unavailable";
}

export function mcpRuntimeErrorMessage(code: unknown): string {
  return MCP_RUNTIME_ERROR_MESSAGES[mcpRuntimeErrorCode(code)];
}

export type McpSource =
  | {
      allowPrivateNetwork?: boolean;
      kind: "remote";
      url: string;
    }
  | {
      args: string[];
      kind: "npm";
      packageName: string;
      versionSelector?: string;
    }
  | {
      args: string[];
      kind: "pypi";
      packageName: string;
      versionSelector?: string;
    }
  | {
      args: string[];
      command?: string[];
      image: string;
      kind: "oci";
    };

export type McpSlotTarget =
  | { kind: "environment"; name: string }
  | { kind: "header"; name: string };

export type McpSlotValue = boolean | number | string;

export type McpSlotPolicy =
  | { kind: "literal"; value: McpSlotValue }
  | { allowPersonalOverride: boolean; kind: "shared" }
  | { kind: "personal"; required: true };

export type McpConfigurationSlot = {
  description?: string;
  enumValues?: string[];
  label: string;
  maxLength?: number;
  minLength?: number;
  sensitive: boolean;
  slotKey: string;
  target: McpSlotTarget;
  valueType: "boolean" | "enum" | "number" | "secret" | "string";
  policy: McpSlotPolicy;
};

export type McpAuthPolicy =
  | { mode: "none" }
  | { mode: "static" }
  | {
      allowedAuthorizationServerOrigins: string[];
      clientIdMetadataDocumentUrl?: string;
      mode: "oauth";
      protectedResource?: string;
      scopes: string[];
    };

export type McpDraftConfiguration = {
  auth: McpAuthPolicy;
  disabledToolNames?: string[];
  runtime: {
    callTimeoutMs: number;
    startupTimeoutMs: number;
  };
  slots: McpConfigurationSlot[];
  source: McpSource;
  transport: "stdio" | "streamable_http";
};

export type McpValidationIssue = {
  code: string;
  path: string;
  httpStatus?: number;
  operation?: "initialize" | "list_tools";
  endpoint?: string;
};

/** Administrator diagnostics only; credentials and query/fragment values never cross this projection. */
export function safeMcpEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function mcpValidationIssue(value: unknown, fallbackCode = "mcp_remote_validation_failed"): McpValidationIssue {
  const issue = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const endpoint = safeMcpEndpoint(issue.endpoint);
  return {
    code: typeof issue.code === "string" && /^[a-z0-9_.-]{1,128}$/u.test(issue.code) ? issue.code : fallbackCode,
    path: typeof issue.path === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(issue.path) ? issue.path : "validator",
    ...(typeof issue.httpStatus === "number" && Number.isInteger(issue.httpStatus) && issue.httpStatus >= 400 && issue.httpStatus <= 599 ? { httpStatus: issue.httpStatus } : {}),
    ...(issue.operation === "initialize" || issue.operation === "list_tools" ? { operation: issue.operation } : {}),
    ...(endpoint ? { endpoint } : {})
  };
}

export type McpJsonValue =
  | boolean
  | number
  | string
  | null
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export type McpJsonObject = { [key: string]: McpJsonValue };

export type McpToolInventoryEntry = {
  arguments?: McpToolArgumentInventoryEntry[];
  description: string | null;
  name: string;
  title?: string;
};

export type McpToolArgumentInventoryEntry = {
  description: string | null;
  name: string;
  types: string[];
};

export type McpValidationEvidence = {
  evidence: McpJsonObject;
  testedAt: string;
  toolInventory: McpToolInventoryEntry[];
};

export type McpDraftTestSummary = McpValidationEvidence & {
  draftHash: string;
  identityHash: string;
  resolvedArtifact: McpJsonObject | null;
};

export type McpActivationStage =
  | "queued"
  | "resolving"
  | "preparing_runtime"
  | "connecting"
  | "discovering_tools"
  | "publishing"
  | "ready"
  | "failed";

export type AdminMcpActivationSummary = {
  completedAt: string | null;
  errorCode: string | null;
  id: string;
  issues: readonly McpValidationIssue[];
  requestedAt: string;
  stage: McpActivationStage;
  startedAt: string | null;
  updatedAt: string;
};

export type McpRevisionSummary = {
  artifactStatus: "available" | "missing" | "not_applicable" | "unknown";
  createdAt: string;
  disabledToolNames?: string[];
  draftHash: string;
  id: string;
  identityHash: string;
  resolvedArtifact: McpJsonObject | null;
  revisionNumber: number;
  validationEvidence: McpValidationEvidence;
};

export type AdminMcpGrant = {
  canUse: boolean;
  groupId: string | null;
  groupName: string | null;
  id: string;
  personalSlotKeys: string[];
  userId: string | null;
  userName: string | null;
};

export type AdminMcpPersonalSlotSummary = {
  label: string;
  slotKey: string;
};

export type AdminMcpServer = {
  runtimeErrorCode?: McpRuntimeErrorCode | null;
  runtimeProblem?: "reauthorization_required" | "unavailable" | null;
  activation: AdminMcpActivationSummary | null;
  activePersonalSlots: AdminMcpPersonalSlotSummary[];
  activeRevision: McpRevisionSummary | null;
  archivedAt: string | null;
  description: string;
  draft: McpDraftConfiguration;
  draftTest: McpDraftTestSummary | null;
  draftTested: boolean;
  enabled: boolean;
  grants: AdminMcpGrant[];
  id: string;
  namespace: string;
  name: string;
  revisions: McpRevisionSummary[];
  sharedValues: Record<string, { configured: boolean; updatedAt: string | null }>;
  updatedAt: string;
  validationOAuth: {
    accountLabel: string | null;
    connectedAt: string;
    state: "disconnected" | "disconnecting" | "ready" | "reauthorization_required";
  } | null;
};

export type AdminMcpCatalogResponse = {
  servers: AdminMcpServer[];
};

export type McpReadiness =
  | "authorizing"
  | "disabled"
  | "idle"
  | "needs_authorization"
  | "needs_setup"
  | "queued"
  | "ready"
  | "reauthorization_required"
  | "restarting"
  | "starting"
  | "unavailable";

const MCP_STARTABLE_READINESS = new Set<McpReadiness>([
  "idle",
  "queued",
  "ready",
  "restarting",
  "starting"
]);

/** States for which exact admission can start or reconcile an enabled server on demand. */
export function isMcpReadinessStartable(readiness: McpReadiness): boolean {
  return MCP_STARTABLE_READINESS.has(readiness);
}

export type McpCredentialSource = "oauth" | "personal" | "shared";

export type UserMcpConfigurationField = {
  configured: boolean;
  description?: string;
  enumValues?: string[];
  label: string;
  maxLength?: number;
  minLength?: number;
  sensitive: boolean;
  slotKey: string;
  source: "missing" | "personal" | "shared";
  value?: McpSlotValue;
  valueType: McpConfigurationSlot["valueType"];
};

export type McpOperationalStatus = "active" | "checking" | "inactive";

export type UserMcpServer = {
  runtimeErrorCode?: McpRuntimeErrorCode | null;
  accountLabel: string | null;
  description: string;
  enabled: boolean;
  fields: UserMcpConfigurationField[];
  id: string;
  knownToolCount: number;
  name: string;
  oauthAvailable: boolean;
  oauthState: "disconnected" | "disconnecting" | "ready" | "reauthorization_required" | null;
  operationalStatus: McpOperationalStatus;
  readiness: McpReadiness;
  tools: { description: string | null; name: string }[];
};

export type UserMcpCatalogResponse = {
  servers: UserMcpServer[];
};

export type McpRunSelection =
  | { mode: "auto" }
  | { mode: "load_all" }
  | { mode: "off" };

export function decodeMcpRunSelection(value: unknown): McpRunSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.mode === "auto" || record.mode === "load_all" || record.mode === "off") {
    return Object.keys(record).length === 1 ? { mode: record.mode } : null;
  }
  return null;
}

export type McpErrorCode =
  | "mcp_artifact_missing"
  | "mcp_draft_changed"
  | "mcp_draft_test_failed"
  | "forbidden"
  | "invalid_draft"
  | "invalid_grant"
  | "invalid_mcp_values"
  | "json_required"
  | "mcp_encryption_unavailable"
  | "mcp_not_found"
  | "mcp_revision_required"
  | "mcp_storage_unavailable"
  | "mcp_validation_unavailable"
  | "unauthorized";

export type McpErrorResponse = {
  error: McpErrorCode;
  issues?: readonly McpValidationIssue[];
};

export type AdminMcpCreateRequest = {
  activate?: boolean;
  description?: string;
  draft: McpDraftConfiguration;
  name: string;
  sharedValues?: Record<string, McpSlotValue | null>;
};

export type AdminMcpUpdateRequest = {
  tool?: { enabled: boolean; name: string };
  expectedUpdatedAt?: string;
  description?: string;
  draft?: McpDraftConfiguration;
  enabled?: boolean;
  name?: string;
  sharedValues?: Record<string, McpSlotValue | null>;
};

export type AdminMcpGrantRequest = {
  canUse: boolean;
  groupId?: string;
  personalSlotKeys?: string[];
  userId?: string;
};

export type AdminMcpDraftTestRequest = {
  description?: string;
  draft?: McpDraftConfiguration;
  expectedUpdatedAt?: string;
  name?: string;
  oneTimeValues?: Record<string, McpSlotValue>;
  publish?: boolean;
  sharedValues?: Record<string, McpSlotValue | null>;
};

export type AdminMcpRollbackRequest = {
  revisionId: string;
};

export type UserMcpUpdateRequest = {
  enabled?: boolean;
  values?: Record<string, McpSlotValue | null>;
};
export const MCP_RUN_PLAN_LIMITS = Object.freeze({
  maxEnabledServers: 16,
  maxToolSchemaBytes: 512 * 1_024,
  maxTools: 128
});

/** Provider completion allowance includes reasoning and the strict JSON selection. */
export const MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS = Object.freeze({
  defaultTokens: 8_192,
  maxTokens: 65_536,
  minTokens: 1_024
});

export function isMcpAutoDiscoveryOutputTokens(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS.minTokens &&
    Number(value) <= MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS.maxTokens;
}

export const MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS = Object.freeze({
  defaultSeconds: 60,
  maxSeconds: 120,
  minSeconds: 1
});

export type AdminMcpAttention = {
  action: string;
  href: string | null;
  label: string;
  task: "runtime" | "validation";
};

/**
 * What an administrator must still do for a server before it works for
 * everyone: connect or reconnect validation OAuth, review a failed check, or
 * repair a missing runtime artifact. `null` means nothing is owed.
 */
export function adminMcpAttention(server: AdminMcpServer): AdminMcpAttention | null {
  if (server.archivedAt) return null;
  if (server.draft.auth.mode === "oauth" && server.validationOAuth?.state === "disconnecting") {
    return { action: "View connection", href: null, label: "Disconnecting authorization", task: "validation" };
  }
  if (server.draft.auth.mode === "oauth" && server.validationOAuth?.state !== "ready") {
    const reconnect = server.validationOAuth?.state === "reauthorization_required";
    return {
      action: reconnect ? "Reconnect" : "Connect",
      href: `/api/admin/mcp/${encodeURIComponent(server.id)}/oauth/validation/${reconnect ? "reconnect" : "connect"}`,
      label: reconnect ? "Reconnect to check changes" : "Authorization required to check changes",
      task: "validation"
    };
  }
  if (server.activation?.stage === "failed") {
    return { action: "Review and retry", href: null, label: "Settings check failed", task: "validation" };
  }
  if (server.activeRevision?.artifactStatus === "missing" || server.runtimeProblem) {
    return {
      action: "Review connection", href: null,
      label: server.runtimeProblem === "reauthorization_required"
        ? "A user connection needs reconnecting" : mcpRuntimeErrorMessage(server.runtimeErrorCode),
      task: "runtime"
    };
  }
  return null;
}
