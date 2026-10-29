import { mcpGuardAsk, type McpGuardCheck } from "./guard";
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
import { consumeMcpApproval, consumeNamedMcpApproval, requestMcpApproval, type McpApprovalScope } from "./writeApprovalRepository";

/** Approval state the guest-code gateway consults; injectable for tests. */
export type McpGatewayApprovalStore = Readonly<{
  consume(scope: McpApprovalScope, key: McpApprovalCallKey, approvedBy?: string): Promise<boolean>;
  request(scope: McpApprovalScope, request: McpApprovalRequest & Readonly<{
    source: "code";
    toolCallId: string | null;
  }>): Promise<string>;
}>;

export function createPrismaMcpGatewayApprovalStore(prisma: PrismaClient): McpGatewayApprovalStore {
  return {
    consume: (scope, key, approvedBy) => approvedBy
      ? consumeNamedMcpApproval(prisma, scope, approvedBy, key, new Date()) : consumeMcpApproval(prisma, scope, key),
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
 * The approval gate of a guest-code call, after the shared pipeline
 * prepared its exact current definition and before anything is dispatched.
 * The admitted guard checks writes, including standing consent. Without it,
 * the previous consent policy applies. A matching explicit human approval
 * still authorizes the exact call; otherwise an ask is refused after
 * the run's pending request (its card) is recorded. Without a store the gate
 * fails closed.
 */
export async function gateMcpGatewayCall(input: Readonly<{
  admission: McpApprovalAdmission | undefined;
  guard?: McpGuardCheck;
  signal?: AbortSignal;
  prepared: McpHubPreparedToolCall;
  scope: McpApprovalScope;
  source: "code";
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
  let request = mcpApprovalRequest({ arguments: input.prepared.arguments, definitionHash: input.prepared.definitionHash,
    originalName: descriptor.name, serverId: input.prepared.serverId, serverName: descriptor.server_name,
    title: descriptor.title ?? descriptor.annotations?.title, toolName: input.toolName });
  if (input.admission.guard) {
    const guard = input.guard ? await input.guard({ admission: input.admission.guard, tool: {
      serverName: descriptor.server_name, toolName: descriptor.name, description: descriptor.description,
      annotations: descriptor.annotations, arguments: input.prepared.arguments
    }, runId: input.scope.runId, userId: input.scope.userId, signal: input.signal }).catch(mcpGuardAsk) : mcpGuardAsk();
    request = { ...request, guard };
    input.signal?.throwIfAborted();
  }
  if (await input.store.consume(input.scope, request, input.admission.guard?.approvedBy)) return "allowed";
  if (request.guard?.decision === "allow") {
    await input.store.request(input.scope, { ...request, source: input.source, toolCallId: input.toolCallId });
    return "allowed";
  }
  await input.store.request(input.scope, { ...request, source: input.source, toolCallId: input.toolCallId });
  return "refused";
}
