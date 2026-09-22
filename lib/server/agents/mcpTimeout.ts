import type { NormalizedRunRequest } from "../providers/types";
import { searchExecutionConfiguration } from "../search/toolExecutor";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";

/** Codex has one envelope timeout. Actual discovery, Search and server calls
 * retain their own deadlines; this outer allowance must accommodate each. */
export function agentMcpEnvelopeTimeoutSeconds(request: NormalizedRunRequest): number {
  const servers = request.mcpDiscovery?.catalog.servers ?? request.mcp?.servers ?? [];
  // Old snapshots admitted server timeouts up to ten minutes without copying
  // them into the plan. Retain enough envelope room for those exact runtimes.
  const startupMs = servers.reduce((total, server) => total + (server.runtimeTimeouts?.startupTimeoutMs ?? 600_000), 0);
  const callMs = Math.max(0, ...servers.map(server => server.runtimeTimeouts?.callTimeoutMs ?? 600_000));
  const discoveryMs = (request.toolBudgets?.mcpAutoDiscoveryTimeoutSeconds ?? 90) * 1000;
  const searchMs = Math.max(0, ...request.searchPlan.options.map(option => searchExecutionConfiguration(option).timeoutMs));
  const image = request.imagePlan?.snapshot;
  const imageMs = image && image.model.adapterKind !== "fake" ? effectiveProviderResponseTimeoutMs(image.connection, image.model) + 60_000 : 0;
  // Transport settlement follows the bounded operation, not a second tool call.
  return Math.ceil((Math.max(discoveryMs + startupMs, callMs + startupMs, searchMs, imageMs) + 30_000) / 1000);
}
