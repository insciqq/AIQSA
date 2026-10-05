import { logEvent } from "../observability";
import { prisma } from "../prisma";
import { RunRecoveryScheduler } from "../runs/recoveryScheduler";
import { createS3StorageAdapter } from "../uploads/storage";
import { createPrismaRetentionRepository, runObjectDeletionPass } from "./prune";

const PASS_INTERVAL_MS = 60_000;

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
    globalForObjectDeletion.__aiqsaObjectDeletionWorker = new RunRecoveryScheduler({
      intervalMs: PASS_INTERVAL_MS,
      async reconcile(signal) {
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
