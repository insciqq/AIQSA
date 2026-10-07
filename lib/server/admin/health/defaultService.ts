import { prisma } from "../../prisma";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { createAdminHealthService } from "./service";

/** Health reads the telemetry tables and joins provider display names; ids it cannot find were deleted. */
export const adminHealthService = createAdminHealthService({
  store: createPrismaTelemetryStore(prisma),
  async providerNames({ connectionIds, modelIds }) {
    const [connections, models] = await Promise.all([
      connectionIds.length > 0
        ? prisma.providerConnection.findMany({ where: { id: { in: [...connectionIds] } }, select: { id: true, displayName: true } })
        : Promise.resolve([]),
      modelIds.length > 0
        ? prisma.providerModel.findMany({ where: { id: { in: [...modelIds] } }, select: { id: true, displayName: true, modelId: true } })
        : Promise.resolve([])
    ]);
    return {
      connections: new Map(connections.map((row) => [row.id, row.displayName.trim() || "Unnamed connection"])),
      models: new Map(models.map((row) => [row.id, row.displayName.trim() || row.modelId]))
    };
  }
});
