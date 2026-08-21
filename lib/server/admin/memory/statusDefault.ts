import { prisma } from "../../prisma";
import { defaultMemoryRebuildService } from "../../memory/rebuild/defaultRebuild";
import { kickDefaultMemoryCoordinator } from "../../memory/coordinator/defaultCoordinator";
import { seedMemoryHistoryBackfill } from "../../memory/history/backfill";
import { withLockedMemoryTransaction } from "../../memory/persistence/transaction";
import { createPrismaAdminMemoryStatusRepository } from "./statusRepository";
import { createAdminMemoryStatusService } from "./statusService";

const repository = createPrismaAdminMemoryStatusRepository(
  prisma,
  async (candidate) => {
    if (candidate.operation === "REINDEX_HISTORY") {
      const seeded = await withLockedMemoryTransaction(
        prisma,
        candidate.userId,
        async (tx, settings) => {
          if (settings.memoryRevision !== candidate.expectedMemoryRevision ||
            settings.settingsRevision !== candidate.expectedSettingsRevision) {
            throw new Error("memory_admin_history_reindex_revision_conflict");
          }
          return seedMemoryHistoryBackfill(tx, settings);
        }
      );
      if (seeded.enqueuedJobs === 0 && seeded.activeJobs === 0) {
        throw new Error("memory_admin_history_reindex_unavailable");
      }
      kickDefaultMemoryCoordinator();
      return;
    }
    await defaultMemoryRebuildService.start(candidate.userId, {
      ...(candidate.embeddingDeploymentId
        ? { embeddingDeploymentId: candidate.embeddingDeploymentId }
        : {}),
      expectedMemoryRevision: candidate.expectedMemoryRevision,
      expectedSettingsRevision: candidate.expectedSettingsRevision,
      operation: candidate.operation
    });
  }
);

export const defaultAdminMemoryStatusService = createAdminMemoryStatusService({
  repository
});
