import { McpActivationCoordinator } from "./activationCoordinator";
import { defaultMcpDraftValidator, mcpRepository } from "./defaultMcp";
import { getDefaultMcpRuntimeCoordinator, kickDefaultMcpRuntime } from "./defaultRuntime";
import { createMcpOAuthSettler, type McpOAuthSettler } from "./oauthSettlement";

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

const settleAuthorization = createMcpOAuthSettler(
  mcpRepository,
  kickDefaultMcpActivation
);

export const settleDefaultMcpOAuth: McpOAuthSettler = async (input) => {
  const settled = await settleAuthorization(input);
  if (settled.kind !== "ok" || input.purpose !== "user") return settled;
  // Authorization is stored and the server is enabled: that is the outcome.
  // Settings shows readiness; warm-up never turns consent into a failure.
  try {
    const server = (await mcpRepository.listUserServers(input.userId)).find((item) => item.id === input.serverId);
    if (server?.sourceType === "personal") {
      // Personal OAuth begins with no upstream inventory. Discover it on demand
      // in the background so MCP Auto can use the connection on the next message.
      void getDefaultMcpRuntimeCoordinator().ensureUserServersReady(
        input.userId,
        [input.serverId],
        AbortSignal.timeout(30_000)
      ).catch(() => undefined);
    }
  } catch {
    // Persistence is authoritative; reconciliation and the next run start it.
  }
  return settled;
};
