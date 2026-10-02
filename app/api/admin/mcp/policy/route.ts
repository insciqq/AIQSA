import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { invalidatePersonalMcpNetworkPolicy } from "@/lib/server/mcp/defaultPersonalNetwork";
import { kickDefaultMcpRuntime } from "@/lib/server/mcp/defaultRuntime";
import { createMcpPolicyHandlers } from "@/lib/server/mcp/policyHandlers";
import { createPrismaMcpPolicyRepository } from "@/lib/server/mcp/policyRepository";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handlers = createMcpPolicyHandlers({
  // Personal transports re-check the policy on their next request, so a
  // runtime the change refuses fails its next call, refresh or health check;
  // the resync reconnects the ones it allows again.
  onUpdated() {
    invalidatePersonalMcpNetworkPolicy();
    kickDefaultMcpRuntime();
  },
  repository: createPrismaMcpPolicyRepository(prisma),
  resolveAuth: resolveRequestAuth
});

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
