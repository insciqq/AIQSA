import type { PrismaClient } from "@prisma/client";
import { WORKSPACE_POLICY_ID } from "@/lib/domain/workspace";

export type WorkspacePolicyRecord = Readonly<{
  enabled: boolean;
  internetEnabled: boolean;
  version: number;
}>;

export type WorkspacePolicyRepository = Readonly<{
  read(): Promise<WorkspacePolicyRecord>;
  update(input: Readonly<{
    enabled?: boolean;
    expectedVersion: number;
    internetEnabled?: boolean;
    userId: string;
  }>): Promise<{ kind: "ok"; policy: WorkspacePolicyRecord } | { kind: "stale" }>;
}>;

export function createPrismaWorkspacePolicyRepository(
  prisma: Pick<PrismaClient, "$transaction" | "workspacePolicy">
): WorkspacePolicyRepository {
  return {
    async read() {
      const policy = await prisma.workspacePolicy.findUnique({
        select: { enabled: true, internetEnabled: true, version: true },
        where: { id: WORKSPACE_POLICY_ID }
      });
      if (!policy) throw new Error("workspace_policy_integrity_invalid");
      return policy;
    },
    async update(input) {
      return prisma.$transaction(async (tx) => {
        const result = await tx.workspacePolicy.updateMany({
          data: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.internetEnabled === undefined
              ? {}
              : { internetEnabled: input.internetEnabled }),
            updatedByUserId: input.userId,
            version: { increment: 1 }
          },
          where: { id: WORKSPACE_POLICY_ID, version: input.expectedVersion }
        });
        if (result.count !== 1) return { kind: "stale" as const };
        const policy = await tx.workspacePolicy.findUniqueOrThrow({
          select: { enabled: true, internetEnabled: true, version: true },
          where: { id: WORKSPACE_POLICY_ID }
        });
        return { kind: "ok" as const, policy };
      });
    }
  };
}
