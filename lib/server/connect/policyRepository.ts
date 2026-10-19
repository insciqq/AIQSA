import type { PrismaClient } from "@prisma/client";
import type { ConnectAdminPolicy } from "@/lib/contracts/connect";

export const CONNECT_POLICY_ID = "installation";

export type ConnectPolicyUpdateResult =
  | Readonly<{ kind: "ok"; policy: ConnectAdminPolicy }>
  | Readonly<{ kind: "stale" }>;

export type ConnectPolicyRepository = Readonly<{
  read(): Promise<ConnectAdminPolicy>;
  /** Replaces the switch at the version the administrator read; a concurrent change is stale, never merged. */
  update(input: Readonly<{ enabled: boolean; expectedVersion: number; userId: string }>): Promise<ConnectPolicyUpdateResult>;
}>;

const policySelect = { enabled: true, version: true } as const;

export function createPrismaConnectPolicyRepository(
  prisma: Pick<PrismaClient, "$transaction" | "connectPolicy">
): ConnectPolicyRepository {
  return {
    async read() {
      const policy = await prisma.connectPolicy.findUnique({ select: policySelect, where: { id: CONNECT_POLICY_ID } });
      // The migration seeds the singleton and bootstrap repairs it.
      if (!policy) throw new Error("connect_policy_integrity_invalid");
      return policy;
    },
    async update(input) {
      return prisma.$transaction(async (tx) => {
        const updated = await tx.connectPolicy.updateMany({
          data: { enabled: input.enabled, updatedByUserId: input.userId, version: { increment: 1 } },
          where: { id: CONNECT_POLICY_ID, version: input.expectedVersion }
        });
        if (updated.count !== 1) return { kind: "stale" as const };
        const policy = await tx.connectPolicy.findUniqueOrThrow({ select: policySelect, where: { id: CONNECT_POLICY_ID } });
        return { kind: "ok" as const, policy };
      });
    }
  };
}
