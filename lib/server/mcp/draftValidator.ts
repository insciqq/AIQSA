import type {
  McpDraftConfiguration,
  McpJsonObject,
  McpSlotValue,
  McpToolInventoryEntry,
  McpValidationIssue
} from "@/lib/contracts/mcp";

export type McpDraftValidationInput = Readonly<{
  draft: McpDraftConfiguration;
  onProgress?(stage: McpDraftValidationStage): Promise<void>;
  /** A personal (user-owned) connection: its transport follows the personal network policy. */
  personal?: true;
  serverId?: string;
  validationUserId?: string;
  values: Readonly<Record<string, McpSlotValue>>;
}>;

export type McpDraftValidationStage =
  | "connecting"
  | "discovering_tools";

// Server-owned validation evidence, never accepted from an administration request.
export type McpEndpointCorrection = Readonly<{
  kind: "gitlab";
  fromUrl: string;
  toUrl: string;
  oauthBinding?: Readonly<{ connectionId: string; policyFingerprint: string; tokenVersion: string }>;
}>;

export type McpDraftValidationOutcome =
  | Readonly<{
      evidence: McpJsonObject;
      endpointCorrection?: McpEndpointCorrection;
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

export class McpDraftValidationAbortedError extends Error {
  constructor() {
    super("mcp_draft_validation_aborted");
    this.name = "McpDraftValidationAbortedError";
  }
}

export const unavailableMcpDraftValidator: McpDraftValidator = {
  async validate() {
    throw new McpDraftValidationUnavailableError();
  }
};
