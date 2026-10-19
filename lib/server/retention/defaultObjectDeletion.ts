import { deleteExpiredAnswerProblemReports } from "../answerProblemReports/repository";
import { deleteExpiredSignInRefusals } from "../auth/signInRefusals";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { prisma } from "../prisma";
import { RunRecoveryScheduler } from "../runs/recoveryScheduler";
import { deleteExpiredTelegramRecords } from "../telegram/store/retention";
import { createS3StorageAdapter } from "../uploads/storage";
import { createPrismaRetentionRepository, runObjectDeletionPass } from "./prune";

const PASS_INTERVAL_MS = 60_000;
const RECORD_PRUNE_INTERVAL_MS = 3_600_000;

type RecordPrune = Readonly<{ failureCode: string; prune(now: Date): Promise<number> }>;

/**
 * Small records past their retention, at most hourly and in bounded batches:
 * answer problem reports after 90 days, refused sign-ins after 30, and the
 * content-free Telegram records on their own schedules. A failure is reported
 * and retried on a later pass; it never stops the other prunes or object
 * deletion.
 */
function createRecordPrune(prunes: readonly RecordPrune[], now: () => number = Date.now): () => Promise<void> {
  let nextAt = 0;
  return async () => {
    const time = now();
    if (time < nextAt) return;
    nextAt = time + RECORD_PRUNE_INTERVAL_MS;
    for (const { failureCode, prune } of prunes) {
      try {
        const deleted = await prune(new Date(time));
        if (deleted > 0) {
          logEvent("runtime_lifecycle", { subsystem: "database", stage: "cleanup", outcome: "completed", count: deleted });
        }
      } catch (error) {
        logEvent("runtime_lifecycle", { error, subsystem: "database", stage: "cleanup", outcome: "failed", action: "retry",
          code: failureCode, prisma_code: databaseFailureCode(error) });
      }
    }
  };
}

const globalForObjectDeletion = globalThis as unknown as {
  __aiqsaObjectDeletionWorker?: RunRecoveryScheduler;
};

/**
 * One worker per application process (single replica), shared across route
 * bundles: due object-deletion jobs leave storage without an operator prune
 * timer. Retention staging stays with `npm run prune`.
 */
export function getDefaultObjectDeletionWorker(): RunRecoveryScheduler {
  if (!globalForObjectDeletion.__aiqsaObjectDeletionWorker) {
    const repository = createPrismaRetentionRepository(prisma);
    const storage = createS3StorageAdapter();
    const pruneRecords = createRecordPrune([
      { failureCode: "answer_problem_report_prune_failed", prune: (now) => deleteExpiredAnswerProblemReports(prisma, now) },
      { failureCode: "sign_in_refusal_prune_failed", prune: (now) => deleteExpiredSignInRefusals(prisma, now) },
      { failureCode: "telegram_record_prune_failed", prune: (now) => deleteExpiredTelegramRecords(prisma, now) }
    ]);
    globalForObjectDeletion.__aiqsaObjectDeletionWorker = new RunRecoveryScheduler({
      intervalMs: PASS_INTERVAL_MS,
      async reconcile(signal) {
        await pruneRecords();
        const pass = await runObjectDeletionPass({ repository, signal, storage });
        if (pass.claimed === 0) return;
        logEvent("runtime_lifecycle", {
          subsystem: "object_storage",
          stage: "cleanup",
          outcome: pass.failed > 0 ? "failed" : "completed",
          claimed_count: pass.claimed,
          completed_count: pass.completed,
          failed_count: pass.failed,
          ...(pass.failed > 0 ? { action: "retry" as const, code: "object_delete_failed" } : {})
        });
      },
      subsystem: "object_storage"
    });
  }
  return globalForObjectDeletion.__aiqsaObjectDeletionWorker;
}

export function startDefaultObjectDeletionWorker(): void {
  getDefaultObjectDeletionWorker().start();
}
