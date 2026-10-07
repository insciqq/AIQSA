import { prisma } from "../../prisma";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { createAdminHealthRunLookup } from "./runLookup";
import { createPrismaAdminHealthRunRepository } from "./runLookupRepository";

export const adminHealthRunLookup = createAdminHealthRunLookup({
  runs: createPrismaAdminHealthRunRepository(prisma),
  incidents: createPrismaTelemetryStore(prisma)
});
