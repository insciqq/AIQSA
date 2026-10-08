import { prisma } from "../../prisma";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { readMemoryRebuildLoad } from "../health/memoryRebuilds";
import {
  HEALTH_ATTENTION_THRESHOLDS,
  memoryRebuildFindings,
  readHealthFindings,
  type HealthFinding
} from "./healthRules";

const telemetry = createPrismaTelemetryStore(prisma);

/** Rebuilds per owner; an unreadable count is logged and only drops its own rule. */
async function readDefaultMemoryRebuildFindings(now: Date): Promise<HealthFinding[]> {
  try {
    return memoryRebuildFindings(await readMemoryRebuildLoad(prisma, {
      now,
      threshold: HEALTH_ATTENTION_THRESHOLDS.memoryRebuildsPerOwnerMin,
      windowMs: HEALTH_ATTENTION_THRESHOLDS.memoryRebuildWindowMs
    }));
  } catch (error) {
    logEvent("service_operation", { error, subsystem: "admin", stage: "read", outcome: "failed",
      code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
    return [];
  }
}

/** The health rules over this installation's telemetry counters and Memory rebuilds, read now. */
export async function readDefaultHealthFindings(): Promise<HealthFinding[]> {
  const now = new Date();
  const [telemetryFindings, rebuildFindings] = await Promise.all([
    readHealthFindings(telemetry, now),
    readDefaultMemoryRebuildFindings(now)
  ]);
  return [...telemetryFindings, ...rebuildFindings];
}
