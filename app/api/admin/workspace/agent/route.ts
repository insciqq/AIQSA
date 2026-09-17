import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createAgentPolicyHandlers } from "@/lib/server/agents/policyHandlers";
import { createAgentPolicyRepository } from "@/lib/server/agents/policyRepository";

const handlers = createAgentPolicyHandlers({ resolveAuth: resolveRequestAuth, repository: createAgentPolicyRepository(prisma) });
export const runtime = "nodejs";
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
