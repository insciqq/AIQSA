import { prisma } from "../prisma";
import { createAgentPolicyRepository } from "./policyRepository";

export const agentPolicyRepository = createAgentPolicyRepository(prisma);
