import type {
  AdminMcpServer,
  McpDraftConfiguration,
  McpSlotValue,
  McpValidationIssue,
  UserMcpServer
} from "@/lib/contracts/mcp";

export type McpRepositoryError =
  | { kind: "artifact_missing" }
  | { kind: "draft_changed" }
  | { kind: "draft_validation_failed"; issues: readonly McpValidationIssue[] }
  | { kind: "invalid_grant"; issues: readonly McpValidationIssue[] }
  | { kind: "invalid_values"; issues: readonly McpValidationIssue[] }
  | { kind: "not_found" }
  | { kind: "revision_required" };

export type McpRepositoryResult<T> = { kind: "ok"; value: T } | McpRepositoryError;

/** Private catalog state; the handler strips the internal admission fields. */
export type McpUserServerState = UserMcpServer & {
  /** Internal admission diagnostics; never serialized to the user catalog. */
  errorCode: string | null;
  runtimeGenerationId: string | null;
};

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
    connectorKey?: string;
    selectedToolNames?: readonly string[];
    userId: string;
    values: Record<string, McpSlotValue>;
  }): Promise<McpRepositoryResult<McpUserServerState>>;
  deleteServer(serverId: string): Promise<McpRepositoryResult<AdminMcpServer>>;
  deletePersonalServer?(input: { serverId: string; userId: string }): Promise<McpRepositoryResult<McpUserServerState>>;
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
    /** Require that the target is owned by this user (personal MCP route). */
    personalOnly?: boolean;
    serverId: string;
    userId: string;
    tool?: { enabled: boolean; name: string };
    values?: Record<string, McpSlotValue | null>;
  }): Promise<McpRepositoryResult<McpUserServerState>>;
};
