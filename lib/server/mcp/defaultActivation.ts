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
  const server = (await mcpRepository.listUserServers(input.userId)).find((item) => item.id === input.serverId);
  if (server?.sourceType !== "personal") return settled;
  try {
    // Personal OAuth begins with no upstream inventory. Discover it after
    // consent so MCP Auto can use the connection on the user's next message.
    await getDefaultMcpRuntimeCoordinator().ensureUserServersReady(
      input.userId,
      [input.serverId],
      AbortSignal.timeout(30_000)
    );
    const ready = (await mcpRepository.listUserServers(input.userId)).find((item) => item.id === input.serverId);
    return ready?.readiness === "ready" ? { kind: "ok" } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
};
