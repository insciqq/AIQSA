import type { PrismaClient } from "@prisma/client";
import { decodeAgentPolicy, type AgentPolicyValues, type AgentPolicyWire } from "@/lib/contracts/agentPolicy";

const select = {
  limitsEnabled: true, version: true, timeoutSeconds: true,
  maxModelCalls: true, maxToolCalls: true, tokenBudget: true, maxOutputTokens: true
} as const;

export type AgentPolicyRepository = Readonly<{
  read(): Promise<AgentPolicyWire>;
  update(input: AgentPolicyValues & Readonly<{ expectedVersion: number; userId: string }>):
    Promise<AgentPolicyWire | null>;
}>;

export function createAgentPolicyRepository(database: Pick<PrismaClient, "$transaction" | "agentPolicy">): AgentPolicyRepository {
  const checked = (value: unknown) => {
    const policy = decodeAgentPolicy(value);
    if (!policy) throw new Error("agent_policy_integrity_invalid");
    return policy;
  };
  return {
    async read() {
      return checked(await database.agentPolicy.findUnique({ where: { id: "installation" }, select }));
    },
    async update({ expectedVersion, userId, ...values }) {
      checked({ ...values, version: expectedVersion });
      return database.$transaction(async (tx) => {
        const updated = await tx.agentPolicy.updateMany({
          where: { id: "installation", version: expectedVersion },
          data: { ...values, version: { increment: 1 }, updatedByUserId: userId }
        });
        if (updated.count !== 1) return null;
        return checked(await tx.agentPolicy.findUnique({ where: { id: "installation" }, select }));
      });
    }
  };
}
