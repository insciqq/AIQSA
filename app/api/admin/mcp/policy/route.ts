import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { applyPersonalMcpPolicyChange } from "@/lib/server/mcp/defaultPersonalNetwork";
import { getDefaultMcpRuntimeCoordinator } from "@/lib/server/mcp/defaultRuntime";
import { createMcpPolicyHandlers } from "@/lib/server/mcp/policyHandlers";
import { createPrismaMcpPolicyRepository } from "@/lib/server/mcp/policyRepository";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handlers = createMcpPolicyHandlers({
  onUpdated: (policy) => applyPersonalMcpPolicyChange(policy, getDefaultMcpRuntimeCoordinator()),
  repository: createPrismaMcpPolicyRepository(prisma),
  resolveAuth: resolveRequestAuth
});

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
