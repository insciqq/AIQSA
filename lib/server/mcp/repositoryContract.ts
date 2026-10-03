import type {
  AdminMcpServer,
  McpDraftConfiguration,
  McpSlotValue,
  McpValidationIssue,
  UserMcpServer
} from "@/lib/contracts/mcp";

export type McpRepositoryError =
  | { kind: "draft_changed" }
  | { kind: "draft_validation_failed"; issues: readonly McpValidationIssue[] }
  | { kind: "invalid_grant"; issues: readonly McpValidationIssue[] }
  | { kind: "invalid_values"; issues: readonly McpValidationIssue[] }
  | { kind: "mcp_enabled_server_limit_reached" }
  | { kind: "not_found" }
  | { kind: "personal_mcp_limit_reached" }
  | { kind: "revision_required" };

/** A user-level limit that blocks one more personal connection or enabled server. */
export type McpUserLimitKind = "mcp_enabled_server_limit_reached" | "personal_mcp_limit_reached";

export type McpRepositoryResult<T> = { kind: "ok"; value: T } | McpRepositoryError;

/** Private catalog state; the handler strips the internal admission fields. */
export type McpUserServerState = UserMcpServer & {
  /** Internal admission diagnostics; never serialized to the user catalog. */
  errorCode: string | null;
  runtimeGenerationId: string | null;
};

/**
 * Credential replacement adds two outcomes: the connection does not use a
 * static credential, or it changed after the new credential was read for
 * validation (the replacement is refused, never applied out of order).
 */
export type McpPersonalCredentialReplacementResult =
  | McpRepositoryResult<McpUserServerState>
  | { kind: "auth_mode_invalid" }
  | { kind: "credentials_changed" };

export type McpRepository = {
  activateDraft(serverId: string): Promise<McpRepositoryResult<AdminMcpServer>>;
  createServer(input: {
    activate?: boolean;
    description: string;
    draft: McpDraftConfiguration;
    name: string;
    sharedValues: Record<string, McpSlotValue | null>;
    validationUserId?: string;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  createPersonalServer?(input: {
    description: string;
    draft: McpDraftConfiguration;
    name: string;
    userId: string;
    values: Record<string, McpSlotValue>;
  }): Promise<McpRepositoryResult<McpUserServerState>>;
  deleteServer(serverId: string): Promise<McpRepositoryResult<AdminMcpServer>>;
  deletePersonalServer?(input: { serverId: string; userId: string }): Promise<McpRepositoryResult<McpUserServerState>>;
  /**
   * Advisory check before any outbound discovery or validation for a new
   * personal connection; creation repeats it under the owner's lock.
   */
  personalCreationLimit?(userId: string): Promise<McpUserLimitKind | null>;
  /**
   * Validates a static-auth personal connection's new credential against its
   * stored URL, then stores it in place; a new header name publishes a new
   * revision. Identity, switch-offs and the cap slot are kept.
   */
  replacePersonalCredentials?(input: {
    authorization: string;
    /** Absent keeps the stored header name. */
    headerName?: string;
    serverId: string;
    userId: string;
  }): Promise<McpPersonalCredentialReplacementResult>;
  listAdminServers(validationUserId?: string): Promise<AdminMcpServer[]>;
  listUserServers(userId: string): Promise<McpUserServerState[]>;
  rebuildRevision(input: {
    oneTimeValues: Record<string, McpSlotValue>;
    replaceDraft: boolean;
    revisionId: string;
    serverId: string;
    validationUserId?: string;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  requestActivation(input: {
    expectedDraftHash?: string;
    serverId: string;
    validationUserId: string;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  rollbackServer(input: {
    revisionId: string;
    serverId: string;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  setGrant(input: {
    canUse: boolean;
    groupId: string | null;
    personalSlotKeys: string[];
    serverId: string;
    userId: string | null;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  testDraft(input: {
    description?: string;
    draft?: McpDraftConfiguration;
    expectedDraftHash?: string;
    expectedUpdatedAt?: string;
    name?: string;
    oneTimeValues: Record<string, McpSlotValue>;
    publish?: boolean;
    serverId: string;
    sharedValues?: Record<string, McpSlotValue | null>;
    validationUserId?: string;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  updateServer(input: {
    toolAccess?: import("@/lib/contracts/mcp").McpToolAccessPolicy;
    tool?: { enabled: boolean; name: string };
    expectedUpdatedAt?: string;
    description?: string;
    draft?: McpDraftConfiguration;
    enabled?: boolean;
    name?: string;
    serverId: string;
    sharedValues?: Record<string, McpSlotValue | null>;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  updateUserServer(input: {
    enabled?: boolean;
    /** Require an installation server; personal rows are not found (installation route). */
    installationOnly?: boolean;
    /** Require that the target is owned by this user (personal MCP route). */
    personalOnly?: boolean;
    serverId: string;
    userId: string;
    tool?: { enabled: boolean; name: string };
    values?: Record<string, McpSlotValue | null>;
  }): Promise<McpRepositoryResult<McpUserServerState>>;
};
