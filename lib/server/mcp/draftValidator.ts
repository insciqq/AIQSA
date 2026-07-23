import type {
  McpDraftConfiguration,
  McpJsonObject,
  McpSlotValue,
  McpToolInventoryEntry,
  McpValidationIssue
} from "@/lib/contracts/mcp";

export type McpDraftValidationInput = Readonly<{
  draft: McpDraftConfiguration;
  serverId?: string;
  validationUserId?: string;
  values: Readonly<Record<string, McpSlotValue>>;
}>;

export type McpDraftValidationOutcome =
  | Readonly<{
      evidence: McpJsonObject;
      kind: "ok";
      resolvedArtifact: McpJsonObject | null;
      toolInventory: readonly McpToolInventoryEntry[];
    }>
  | Readonly<{
      issues: readonly McpValidationIssue[];
      kind: "invalid";
    }>;

export interface McpDraftValidator {
  validate(input: McpDraftValidationInput): Promise<McpDraftValidationOutcome>;
}

export class McpDraftValidationUnavailableError extends Error {
  constructor() {
    super("mcp_draft_validation_unavailable");
    this.name = "McpDraftValidationUnavailableError";
  }
}

export const unavailableMcpDraftValidator: McpDraftValidator = {
  async validate() {
    throw new McpDraftValidationUnavailableError();
  }
};
