import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  buildPersonalMcpNetworkEnvironment,
  createPersonalMcpAddressPolicy,
  defaultPersonalMcpNetworkHost,
  type PersonalMcpAddressPolicyState
} from "./personalNetworkPolicy";
import { createPrismaMcpPolicyRepository } from "./policyRepository";
import type { McpAddressPolicy } from "./safeFetch";

type PersonalNetworkGlobal = typeof globalThis & {
  __aiqsaPersonalMcpAddressPolicy?: PersonalMcpAddressPolicyState;
};

const SCOPE_ID = "personal_mcp_network_policy";

// One process-wide cache: route bundles and the runtime coordinator may load
// separate module instances, and an admin change must reach all of them.
function state(): PersonalMcpAddressPolicyState {
  const scope = globalThis as PersonalNetworkGlobal;
  scope.__aiqsaPersonalMcpAddressPolicy ??= createPersonalMcpAddressPolicy({
    environment: () => buildPersonalMcpNetworkEnvironment(defaultPersonalMcpNetworkHost()),
    onReadFailure(error) {
      reportSubsystemFailure({
        action: "degrade",
        code: "mcp_policy_unavailable",
        prisma_code: databaseFailureCode(error),
        scope_id: SCOPE_ID,
        stage: "read",
        subsystem: "mcp"
      });
    },
    async readLocalNetworkEnabled() {
      const { prisma } = await import("../prisma");
      const policy = await createPrismaMcpPolicyRepository(prisma).read();
      reportSubsystemHealthy("mcp", "read", SCOPE_ID);
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
