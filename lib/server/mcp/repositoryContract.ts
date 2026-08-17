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
  deleteServer(serverId: string): Promise<McpRepositoryResult<AdminMcpServer>>;
  listAdminServers(): Promise<AdminMcpServer[]>;
  listUserServers(userId: string): Promise<UserMcpServer[]>;
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
    expectedDraftHash?: string;
    oneTimeValues: Record<string, McpSlotValue>;
    serverId: string;
    validationUserId?: string;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  updateServer(input: {
    description?: string;
    draft?: McpDraftConfiguration;
    enabled?: boolean;
    name?: string;
    serverId: string;
    sharedValues?: Record<string, McpSlotValue | null>;
  }): Promise<McpRepositoryResult<AdminMcpServer>>;
  updateUserServer(input: {
    enabled?: boolean;
    serverId: string;
    userId: string;
    values?: Record<string, McpSlotValue | null>;
  }): Promise<McpRepositoryResult<UserMcpServer>>;
};
