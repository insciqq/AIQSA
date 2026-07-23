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
};

export type McpJsonValue =
  | boolean
  | number
  | string
  | null
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export type McpJsonObject = { [key: string]: McpJsonValue };

export type McpToolInventoryEntry = {
  description: string | null;
  name: string;
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

export type McpRevisionSummary = {
  artifactStatus: "available" | "missing" | "not_applicable" | "unknown";
  createdAt: string;
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

export type UserMcpServer = {
  accountLabel: string | null;
  description: string;
  enabled: boolean;
  errorCode: string | null;
  fields: UserMcpConfigurationField[];
  id: string;
  knownToolCount: number;
  name: string;
  oauthAvailable: boolean;
  oauthState: "disconnected" | "disconnecting" | "ready" | "reauthorization_required" | null;
  readiness: McpReadiness;
  tools: { description: string | null; name: string }[];
};

export type UserMcpCatalogResponse = {
  servers: UserMcpServer[];
};

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
  description?: string;
  draft: McpDraftConfiguration;
  name: string;
  sharedValues?: Record<string, McpSlotValue | null>;
};

export type AdminMcpUpdateRequest = {
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
  oneTimeValues?: Record<string, McpSlotValue>;
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
