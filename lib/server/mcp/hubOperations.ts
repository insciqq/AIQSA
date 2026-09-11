import { storedTokenUsage } from "../usage";
import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "@/lib/domain/modelRunEvents";
import type { McpHubServiceDependencies } from "./hubService";

type Database = Pick<PrismaClient, "$transaction" | "mcpHubDispatch" | "mcpHubDiscoveryAttempt">;

function reportedUsage(usage: ModelRunUsage | null) {
  return storedTokenUsage(usage ?? {});
}

export type McpHubMaintenanceResult = Readonly<{
  dispatches: { expired: number; removed: number };
  discoveryAttempts: { expired: number; removed: number };
}>;

/** Content-free receipts outlive revocation; user deletion cascades them.
 * Maintenance expires ambiguous work without replay and retires old receipts,
 * retaining their existing UsageEvent under the ordinary accounting lifecycle. */
export function createMcpHubOperationStore(database: Database) {
  const maintain = async (input: Readonly<{
    cutoff?: Date;
    dryRun?: boolean;
    limit?: number;
    now?: Date;
  }> = {}): Promise<McpHubMaintenanceResult> => {
    const now = input.now ?? new Date();
    const limit = Math.min(1_000, Math.max(1, input.limit ?? 100));
    const expireWhere = { state: "DISPATCHED" as const, expiresAt: { lte: now } };
    const removeWhere = { state: { not: "DISPATCHED" as const }, createdAt: { lt: input.cutoff ?? new Date(0) } };
    const [dispatches, discovery, oldDispatches, oldDiscovery] = await Promise.all([
      database.mcpHubDispatch.findMany({ where: expireWhere, select: { id: true }, orderBy: { expiresAt: "asc" }, take: limit }),
      database.mcpHubDiscoveryAttempt.findMany({ where: expireWhere, select: { id: true }, orderBy: { expiresAt: "asc" }, take: limit }),
      input.cutoff ? database.mcpHubDispatch.findMany({ where: removeWhere, select: { id: true }, orderBy: { createdAt: "asc" }, take: limit }) : [],
      input.cutoff ? database.mcpHubDiscoveryAttempt.findMany({ where: removeWhere, select: { id: true }, orderBy: { createdAt: "asc" }, take: limit }) : []
    ]);
    if (input.dryRun) return {
      dispatches: { expired: dispatches.length, removed: oldDispatches.length },
      discoveryAttempts: { expired: discovery.length, removed: oldDiscovery.length }
    };
    const data = { state: "UNKNOWN" as const, completedAt: now, revision: { increment: 1 } };
    const [expiredDispatches, expiredDiscovery, removedDispatches, removedDiscovery] = await Promise.all([
      dispatches.length ? database.mcpHubDispatch.updateMany({ where: { ...expireWhere, id: { in: dispatches.map(({ id }) => id) } }, data: { ...data, resultCode: "execution_outcome_unknown" } }) : { count: 0 },
      discovery.length ? database.mcpHubDiscoveryAttempt.updateMany({ where: { ...expireWhere, id: { in: discovery.map(({ id }) => id) } }, data }) : { count: 0 },
      oldDispatches.length ? database.mcpHubDispatch.deleteMany({
        where: { ...removeWhere, id: { in: oldDispatches.map(({ id }) => id) } }
      }) : { count: 0 },
      oldDiscovery.length ? database.mcpHubDiscoveryAttempt.deleteMany({
        where: { ...removeWhere, id: { in: oldDiscovery.map(({ id }) => id) } }
      }) : { count: 0 }
    ]);
    return {
      dispatches: { expired: expiredDispatches.count, removed: removedDispatches.count },
      discoveryAttempts: { expired: expiredDiscovery.count, removed: removedDiscovery.count }
    };
  };

  const recordDispatch: McpHubServiceDependencies["recordDispatch"] = async (input) => {
    await maintain();
    const operation = await database.mcpHubDispatch.create({
      data: { userId: input.userId, clientId: input.clientId, grantId: input.grantId,
        resourcePath: input.resourcePath, toolId: input.toolId, toolVersion: input.toolVersion },
      select: { id: true, revision: true }
    });
    return {
      async settle(state, resultCode) {
        const result = await database.mcpHubDispatch.updateMany({
          data: { completedAt: new Date(), resultCode: resultCode ?? null, revision: { increment: 1 }, state },
          where: { id: operation.id, revision: operation.revision, state: "DISPATCHED" }
        });
        if (result.count !== 1) throw new Error("mcp_hub_settlement_lost");
      }
    };
  };

  const recordDiscoveryAttempt: McpHubServiceDependencies["recordDiscoveryAttempt"] = async (authority, role) => {
    const snapshot = role.snapshot;
    if (!snapshot.connectionId || !snapshot.providerModelId || !snapshot.credentialVersionId) {
      throw new Error("mcp_hub_discovery_binding_missing");
    }
    await maintain();
    const operation = await database.mcpHubDiscoveryAttempt.create({
      data: {
        clientId: authority.clientId, grantId: authority.grantId, userId: authority.userId,
        connectionId: snapshot.connectionId, providerModelId: snapshot.providerModelId,
        credentialVersionId: snapshot.credentialVersionId,
        usageEvent: { create: {
          mcpHubDiscovery: true, userId: authority.userId,
          modelId: snapshot.model.upstreamModelId, provider: snapshot.providerFamily,
          providerModelId: snapshot.providerModelId
        } }
      },
      select: { id: true, revision: true }
    });
    return {
      async settle({ state, usage }) {
        await database.$transaction(async (tx) => {
          await tx.mcpHubDiscoveryAttempt.updateMany({
            where: { id: operation.id, revision: operation.revision, state: "DISPATCHED" },
            data: { state, completedAt: new Date(), revision: { increment: 1 } }
          });
          // Late usage may enrich an expired UNKNOWN receipt, but never creates
          // a second event or changes an already settled accounting outcome.
          if (usage) await tx.usageEvent.updateMany({
            where: { mcpHubDiscoveryAttemptId: operation.id, usageCompleteness: "UNAVAILABLE" },
            data: reportedUsage(usage)
          });
        });
      }
    };
  };
  return { maintain, recordDispatch, recordDiscoveryAttempt };
}
