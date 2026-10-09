import { prisma } from "../../prisma";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { readFailedRunLoad } from "../health/failedRuns";
import { readMemoryRebuildLoad } from "../health/memoryRebuilds";
import {
  failedRunFindings,
  HEALTH_ATTENTION_THRESHOLDS,
  memoryRebuildFindings,
  readHealthFindings,
  type HealthFinding
} from "./healthRules";

const telemetry = createPrismaTelemetryStore(prisma);
/** Failure codes read for the failed-runs item: well above the codes it names, so its counts stay exact. */
const FAILED_RUN_CODE_LIMIT = 50;

/** A database read of one rule; a failure is logged and only drops that rule. */
async function readOptionalFindings(read: () => Promise<HealthFinding[]>): Promise<HealthFinding[]> {
  try {
    return await read();
  } catch (error) {
    logEvent("service_operation", { error, subsystem: "admin", stage: "read", outcome: "failed",
      code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
    return [];
  }
}

/**
 * The health rules over this installation's failed runs, telemetry counters
 * and Memory rebuilds, read now. Failed runs come first: each is an answer a
 * user did not get.
 */
export async function readDefaultHealthFindings(): Promise<HealthFinding[]> {
  const now = new Date();
  const thresholds = HEALTH_ATTENTION_THRESHOLDS;
  const [runFindings, telemetryFindings, rebuildFindings] = await Promise.all([
    readOptionalFindings(async () => failedRunFindings(await readFailedRunLoad(prisma, {
      from: new Date(now.getTime() - thresholds.runsFailedWindowMs),
      to: new Date(now.getTime() + 1),
      perCode: thresholds.runsFailedReferencesPerCode,
      groupLimit: FAILED_RUN_CODE_LIMIT
    }))),
    readHealthFindings(telemetry, now),
    readOptionalFindings(async () => memoryRebuildFindings(await readMemoryRebuildLoad(prisma, {
      now,
      threshold: thresholds.memoryRebuildsPerOwnerMin,
      windowMs: thresholds.memoryRebuildWindowMs
    })))
  ]);
  return [...runFindings, ...telemetryFindings, ...rebuildFindings];
}
