import type { PrismaClient } from "@prisma/client";
import { MCP_POLICY_ID, type McpPolicyWire } from "@/lib/contracts/mcpPolicy";

export type McpPolicyRepository = Readonly<{
  read(): Promise<McpPolicyWire>;
  update(input: Readonly<{
    expectedVersion: number;
    personalLocalNetworkEnabled: boolean;
  }>): Promise<Readonly<{ kind: "ok"; policy: McpPolicyWire }> | Readonly<{ kind: "stale" }>>;
}>;

const policySelect = { personalLocalNetworkEnabled: true, version: true } as const;

export function createPrismaMcpPolicyRepository(
  prisma: Pick<PrismaClient, "$transaction" | "mcpPolicy">
): McpPolicyRepository {
  return {
    async read() {
      const policy = await prisma.mcpPolicy.findUnique({ select: policySelect, where: { id: MCP_POLICY_ID } });
      // The migration seeds the singleton and bootstrap repairs it.
      if (!policy) throw new Error("mcp_policy_integrity_invalid");
      return policy;
    },
    async update(input) {
      return prisma.$transaction(async (tx) => {
        const updated = await tx.mcpPolicy.updateMany({
          data: { personalLocalNetworkEnabled: input.personalLocalNetworkEnabled, version: { increment: 1 } },
          where: { id: MCP_POLICY_ID, version: input.expectedVersion }
        });
        if (updated.count !== 1) return { kind: "stale" as const };
        if (input.personalLocalNetworkEnabled) {
          // Runtimes refused while local network access was off reconnect on
          // the next reconciliation instead of waiting out their backoff.
          await tx.mcpRuntimeGeneration.updateMany({
            data: { retryAt: null },
            where: { errorCode: "mcp_local_network_disabled", state: "failed" }
          });
        }
        const policy = await tx.mcpPolicy.findUniqueOrThrow({ select: policySelect, where: { id: MCP_POLICY_ID } });
        return { kind: "ok" as const, policy };
      });
    }
  };
}
