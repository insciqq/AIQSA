import { McpActivationCoordinator } from "./activationCoordinator";
import { defaultMcpDraftValidator, mcpRepository } from "./defaultMcp";
import { kickDefaultMcpRuntime } from "./defaultRuntime";
import { createMcpOAuthSettler } from "./oauthSettlement";

type McpActivationGlobal = typeof globalThis & {
  __aiqsaMcpActivationCoordinator?: McpActivationCoordinator;
};

function createDefaultMcpActivationCoordinator(): McpActivationCoordinator {
  return new McpActivationCoordinator({
    draftValidator: defaultMcpDraftValidator,
    onPublished: kickDefaultMcpRuntime,
    repository: mcpRepository
  });
}

export function getDefaultMcpActivationCoordinator(): McpActivationCoordinator {
  const scope = globalThis as McpActivationGlobal;
  const coordinator = scope.__aiqsaMcpActivationCoordinator ??
    createDefaultMcpActivationCoordinator();
  scope.__aiqsaMcpActivationCoordinator = coordinator;
  coordinator.start();
  return coordinator;
}

export function kickDefaultMcpActivation(): void {
  getDefaultMcpActivationCoordinator().kick();
}

export const settleDefaultMcpOAuth = createMcpOAuthSettler(
  mcpRepository,
  kickDefaultMcpActivation
);
