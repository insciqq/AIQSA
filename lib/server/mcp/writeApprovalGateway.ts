import type { PrismaClient } from "@prisma/client";
import type { McpHubPreparedToolCall } from "./hubService";
import {
  MCP_APPROVAL_REFUSAL,
  mcpApprovalRequest,
  mcpCallNeedsApproval,
  type McpApprovalAdmission,
  type McpApprovalCallKey,
  type McpApprovalRequest
} from "./writeApproval";
import { consumeMcpApproval, requestMcpApproval, type McpApprovalScope } from "./writeApprovalRepository";

/** Approval state the guest-code and Agent gateways consult; injectable for tests. */
export type McpGatewayApprovalStore = Readonly<{
  consume(scope: McpApprovalScope, key: McpApprovalCallKey): Promise<boolean>;
  request(scope: McpApprovalScope, request: McpApprovalRequest & Readonly<{
    source: "agent" | "code";
    toolCallId: string | null;
  }>): Promise<string>;
}>;

export function createPrismaMcpGatewayApprovalStore(prisma: PrismaClient): McpGatewayApprovalStore {
  return {
    consume: (scope, key) => consumeMcpApproval(prisma, scope, key),
    request: (scope, request) => requestMcpApproval(prisma, scope, request)
  };
}

/** A gateway call refused for the user's approval: nothing was sent. */
export class McpApprovalRequiredError extends Error {
  readonly code = MCP_APPROVAL_REFUSAL;
  constructor() {
    super(MCP_APPROVAL_REFUSAL);
    this.name = "McpApprovalRequiredError";
  }
}

/**
 * The approval gate of a guest-code or Agent call, after the shared pipeline
 * prepared its exact current definition and before anything is dispatched.
 * Allowed when the run needs no approval for it (no marker, a read-only
 * tool, an "Always allow" frozen at admission) or one matching one-shot
 * approval of a later run of the chat was consumed; refused otherwise, after
 * the run's pending request (its card) is recorded. Without a store the gate
 * fails closed.
 */
export async function gateMcpGatewayCall(input: Readonly<{
  admission: McpApprovalAdmission | undefined;
  prepared: McpHubPreparedToolCall;
  scope: McpApprovalScope;
  source: "agent" | "code";
  store: McpGatewayApprovalStore | undefined;
  toolCallId: string | null;
  toolName: string;
}>): Promise<"allowed" | "refused"> {
  // A run admitted without the marker (a scheduled task's run, an older run) never asks.
  if (!input.admission) return "allowed";
  const { descriptor } = input.prepared;
  if (!mcpCallNeedsApproval({ admission: input.admission, annotations: descriptor.annotations, serverId: input.prepared.serverId })) {
    return "allowed";
  }
  if (!input.store) return "refused";
  const request = mcpApprovalRequest({ arguments: input.prepared.arguments, definitionHash: input.prepared.definitionHash,
    originalName: descriptor.name, serverId: input.prepared.serverId, serverName: descriptor.server_name,
    title: descriptor.title ?? descriptor.annotations?.title, toolName: input.toolName });
  if (await input.store.consume(input.scope, request)) return "allowed";
  await input.store.request(input.scope, { ...request, source: input.source, toolCallId: input.toolCallId });
  return "refused";
}
