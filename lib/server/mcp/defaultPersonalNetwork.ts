import type { McpPolicyWire } from "@/lib/contracts/mcpPolicy";
import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  buildPersonalMcpNetworkEnvironment,
  createPersonalMcpAddressPolicy,
  defaultPersonalMcpNetworkHost,
  type PersonalMcpAddressPolicyState
} from "./personalNetworkPolicy";
import { createPrismaMcpPolicyRepository } from "./policyRepository";
import type { McpRuntimeCoordinator } from "./runtimeCoordinator";
import type { McpAddressPolicy } from "./safeFetch";

type PersonalNetworkGlobal = typeof globalThis & {
  __aiqsaPersonalMcpAddressPolicy?: PersonalMcpAddressPolicyState;
};

const SETTING_SCOPE_ID = "personal_mcp_network_policy";
const ENVIRONMENT_SCOPE_ID = "personal_mcp_network_environment";

// One process-wide cache: route bundles and the runtime coordinator may load
// separate module instances, and an admin change must reach all of them.
function state(): PersonalMcpAddressPolicyState {
  const scope = globalThis as PersonalNetworkGlobal;
  scope.__aiqsaPersonalMcpAddressPolicy ??= createPersonalMcpAddressPolicy({
    environment: () => buildPersonalMcpNetworkEnvironment(defaultPersonalMcpNetworkHost()),
    onEnvironment(environment) {
      if (!environment.degraded) {
        reportSubsystemHealthy("mcp", "preflight", ENVIRONMENT_SCOPE_ID);
        return;
      }
      // Content-free: which fact was missing stays out of the record.
      reportSubsystemFailure({
        action: "degrade",
        code: "mcp_policy_unavailable",
        scope_id: ENVIRONMENT_SCOPE_ID,
        stage: "preflight",
        subsystem: "mcp"
      });
    },
    onReadFailure(error) {
      reportSubsystemFailure({
        action: "degrade",
        code: "mcp_policy_unavailable",
        prisma_code: databaseFailureCode(error),
        scope_id: SETTING_SCOPE_ID,
        stage: "read",
        subsystem: "mcp"
      });
    },
    async readLocalNetworkEnabled() {
      const { prisma } = await import("../prisma");
      const policy = await createPrismaMcpPolicyRepository(prisma).read();
      reportSubsystemHealthy("mcp", "read", SETTING_SCOPE_ID);
      return policy.personalLocalNetworkEnabled;
    }
  });
  return scope.__aiqsaPersonalMcpAddressPolicy;
}

/** The installation's personal MCP address policy; every personal transport consults it per connection. */
export const personalMcpAddressPolicy: McpAddressPolicy = (address, url) => state().decide(address, url);

/** An administrator changed the policy: the next personal connection reads it again. */
export function invalidatePersonalMcpNetworkPolicy(): void {
  state().invalidate();
}

/**
 * Applies a committed administrator change to running personal connections.
 * Switching local network access off is an owned lifecycle transition: live
 * personal sessions close at once, and the resync restarts each one the
 * policy still allows (a public endpoint) while the rest fail with
 * `mcp_local_network_disabled`. Switching on resyncs runtimes refused before.
 */
export function applyPersonalMcpPolicyChange(
  policy: McpPolicyWire,
  runtime: Pick<McpRuntimeCoordinator, "closePersonalRuntimes" | "kick">
): void {
  invalidatePersonalMcpNetworkPolicy();
  if (!policy.personalLocalNetworkEnabled) void runtime.closePersonalRuntimes().catch(() => undefined);
  runtime.kick();
}
