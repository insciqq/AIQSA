import { prisma } from "../../prisma";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { readHealthFindings, type HealthFinding } from "./healthRules";

const telemetry = createPrismaTelemetryStore(prisma);

/** The health rules over this installation's telemetry counters, read now. */
export function readDefaultHealthFindings(): Promise<HealthFinding[]> {
  return readHealthFindings(telemetry, new Date());
}
