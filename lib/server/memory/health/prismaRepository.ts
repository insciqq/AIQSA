import type { PrismaClient } from "@prisma/client";
import type {
  AdminMemoryHealthSnapshot,
  MemoryHealthRepository,
  UserMemoryHealthSnapshot
} from "./service";

const ACTIVE_JOB_STATES = [
  "QUEUED",
  "WAITING_FOR_EGRESS_CONSENT",
  "CLAIMED",
  "RETRYABLE_FAILED"
] as const;
const ACTIVE_DELETION_STATES = [
  "PENDING",
  "RUNNING",
  "RETRY_WAIT",
  "BLOCKED_REQUIRES_ADMIN"
] as const;

export function createPrismaMemoryHealthRepository(
  client: PrismaClient
): MemoryHealthRepository {
  return Object.freeze({
    async readAdmin(adminUserId, now): Promise<AdminMemoryHealthSnapshot> {
      const recentSince = new Date(now.getTime() - 24 * 60 * 60_000);
      const [
        activeJobCount,
        retryingJobCount,
        waitingForEgressCount,
        recentTerminalJobCount,
        oldestActiveJob,
        activeDeletionCount,
        blockedDeletionCount,
        overdueTemporaryCount,
        recentExecutionCount,
        failedExecutionCount,
        outcomeUnknownCount,
        incompleteUsageCount,
        locale
      ] = await Promise.all([
        client.memoryJob.count({ where: { state: { in: [...ACTIVE_JOB_STATES] } } }),
        client.memoryJob.count({ where: { state: "RETRYABLE_FAILED" } }),
        client.memoryJob.count({ where: { state: "WAITING_FOR_EGRESS_CONSENT" } }),
        client.memoryJob.count({
          where: { state: "TERMINAL_FAILED", updatedAt: { gte: recentSince } }
        }),
        client.memoryJob.findFirst({
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
          where: { state: { in: [...ACTIVE_JOB_STATES] } }
        }),
        client.memoryDeletionOutbox.count({
          where: { state: { in: [...ACTIVE_DELETION_STATES] } }
        }),
        client.memoryDeletionOutbox.count({
          where: { state: "BLOCKED_REQUIRES_ADMIN" }
        }),
        client.chat.count({
          where: {
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: { lt: now }
          }
        }),
        client.memoryExecutionBinding.count({
          where: { createdAt: { gte: recentSince } }
        }),
        client.memoryExecutionBinding.count({
          where: { createdAt: { gte: recentSince }, state: "FAILED" }
        }),
        client.memoryExecutionBinding.count({
          where: { createdAt: { gte: recentSince }, state: "OUTCOME_UNKNOWN" }
        }),
        client.memoryExecutionBinding.count({
          where: {
            createdAt: { gte: recentSince },
            state: { in: ["SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN"] },
            usageCompleteness: { in: ["UNAVAILABLE", "PARTIAL"] }
          }
        }),
        client.userMemorySettings.findUnique({
          select: { memoryUiLocale: true },
          where: { userId: adminUserId }
        })
      ]);
      return Object.freeze({
        activeDeletionCount,
        activeJobCount,
        blockedDeletionCount,
        failedExecutionCount,
        incompleteUsageCount,
        oldestActiveJobAt: oldestActiveJob?.createdAt ?? null,
        outcomeUnknownCount,
        overdueTemporaryCount,
        recentExecutionCount,
        recentTerminalJobCount,
        requestLocale: locale?.memoryUiLocale ?? "EN",
        retryingJobCount,
        waitingForEgressCount
      });
    },

    async readUser(userId, now): Promise<UserMemoryHealthSnapshot> {
      const [
        settings,
        activeDeletionCount,
        blockedDeletionCount,
        overdueTemporaryCount,
        waitingForEgressCount,
        latestRebuild
      ] = await Promise.all([
        client.userMemorySettings.findUnique({
          select: { activeIndexGenerationId: true },
          where: { userId }
        }),
        client.memoryDeletionOutbox.count({
          where: { state: { in: [...ACTIVE_DELETION_STATES] }, userId }
        }),
        client.memoryDeletionOutbox.count({
          where: { state: "BLOCKED_REQUIRES_ADMIN", userId }
        }),
        client.chat.count({
          where: {
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: { lt: now },
            userId
          }
        }),
        client.memoryJob.count({
          where: { state: "WAITING_FOR_EGRESS_CONSENT", userId }
        }),
        client.memoryJob.findFirst({
          orderBy: { createdAt: "desc" },
          select: { state: true },
          where: { kind: "REBUILD_INDEX", userId }
        })
      ]);
      const activeIndex = settings?.activeIndexGenerationId
        ? await client.memoryIndexGeneration.findFirst({
            select: { indexMode: true },
            where: { id: settings.activeIndexGenerationId, userId }
          })
        : null;
      return Object.freeze({
        activeDeletionCount,
        activeIndexMode: activeIndex?.indexMode ?? null,
        blockedDeletionCount,
        latestRebuildState: latestRebuild?.state ?? null,
        overdueTemporaryCount,
        waitingForEgressCount
      });
    }
  });
}
