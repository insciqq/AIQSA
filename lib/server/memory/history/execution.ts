import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { memoryHistoryOrphanedExecutionSql } from "../coordinator/recoveryPolicy";
import { MemoryExecutionError } from "../execution/errors";
import {
  createPrismaMemoryExecutionLifecycle,
  type MemoryExecutionSettlementInput
} from "../execution/lifecycle";
import { unavailableMemoryReportedUsage } from "../execution/structuredClassifier";
import { MemoryPersistenceError } from "../persistence/errors";
import { MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE } from "./contract";

/** An orphaned call's only settlement. Every recoverer writes the same one, so
 * a concurrent recoverer replays it instead of conflicting. */
const recoveredUncertainSettlement: MemoryExecutionSettlementInput = Object.freeze({
  acceptedOutputHash: null,
  errorCode: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
  providerResponseId: null,
  state: "OUTCOME_UNKNOWN",
  usage: unavailableMemoryReportedUsage
});

const abandonedSettlement: MemoryExecutionSettlementInput = Object.freeze({
  acceptedOutputHash: null,
  errorCode: "memory_history_dispatch_abandoned",
  providerResponseId: null,
  state: "CANCELLED",
  usage: unavailableMemoryReportedUsage
});

/** Bounded part of the periodic recovery pass. History indexing makes no model
 * calls, but an attempt of an earlier release may have left one unsettled
 * (memoryHistoryOrphanedExecutionSql). A started call settles as an unknown
 * outcome with unavailable usage, a never-started one as cancelled; neither is
 * dispatched again. Returns the number of new settlements. */
export async function settleObsoleteMemoryHistoryOrphans(
  client: PrismaClient,
  input: Readonly<{ limit: number; now: Date }>
): Promise<number> {
  const orphans = await client.$queryRaw<Array<{ id: string; running: boolean; userId: string }>>(Prisma.sql`
    SELECT execution.id, execution."userId", execution.state = 'RUNNING' AS running
    FROM "MemoryExecutionBinding" AS execution
    JOIN "MemoryJob" AS job ON job.id = execution."memoryJobId" AND job."userId" = execution."userId"
    JOIN "User" AS owner ON owner.id = job."userId" AND owner.status = 'active'::"UserStatus"
    WHERE ${memoryHistoryOrphanedExecutionSql(input.now)}
    ORDER BY execution."createdAt", execution.id LIMIT ${input.limit}
  `).catch(retainDatabaseFailure);
  const lifecycle = createPrismaMemoryExecutionLifecycle({ now: () => input.now }, client);
  let settled = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      const view = await lifecycle.settle(orphan.userId, orphan.id,
        orphan.running ? recoveredUncertainSettlement : abandonedSettlement);
      if (!view.replayed) settled += 1;
    } catch (error) {
      // A late settlement by the lost attempt, chat deletion or account
      // disable may win after selection. Anything else retries next pass.
      if (!(error instanceof MemoryExecutionError && (error.code === "memory_execution_state_conflict" ||
        error.code === "memory_execution_binding_not_found")) &&
        !(error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable")) failed += 1;
    }
  }
  if (settled > 0 || failed > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "recovery",
      outcome: failed > 0 ? "failed" : "degraded", action: failed > 0 ? "retry" : "degrade",
      code: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE, count: settled,
      ...(failed > 0 ? { failed_count: failed } : {}) });
  }
  return settled;
}
