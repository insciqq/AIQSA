import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { defaultMemorySettingsService } from "../settings/defaultSettings";
import {
  createMemoryHealthService,
  type UserMemoryHealthSnapshot
} from "./service";

const ACTIVE_DELETION_STATES = [
  "PENDING",
  "RUNNING",
  "RETRY_WAIT",
  "BLOCKED_REQUIRES_ADMIN"
] as const;

async function readUserMemoryHealthSnapshot(
  client: PrismaClient,
  userId: string,
  now: Date
): Promise<UserMemoryHealthSnapshot> {
  const [
    settings,
    activeDeletionCount,
    blockedDeletionCount,
    overdueTemporaryCount,
    waitingForConfigurationCount,
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
      where: { state: { in: ["WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT"] }, userId }
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
    waitingForConfigurationCount
  });
}

export const defaultMemoryHealthService = createMemoryHealthService({
  readSettings: (userId) => defaultMemorySettingsService.get(userId),
  readUser: (userId, now) => readUserMemoryHealthSnapshot(prisma, userId, now)
});
