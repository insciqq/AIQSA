import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { defaultExplicitMemoryService } from "../explicit/defaultExplicit";
import { defaultMemoryLifecycleService } from "../lifecycle/defaultLifecycle";
import { defaultMemorySettingsService } from "../settings/defaultSettings";
import { resolveMemoryExplicitEquivalentTarget } from "../persistence/explicitEquivalence";
import type { MemoryConsumerHandlerDeps } from "./handlers";
import { createMemoryConsumerService } from "./service";

export function memoryResetOutboxWhere(userId: string) {
  return {
    operation: "FORGET_PURGE" as const,
    targetType: { startsWith: "ALL_REUSABLE@" },
    userId
  };
}

export const defaultMemoryConsumerService = createMemoryConsumerService({
  explicitService: defaultExplicitMemoryService,
  lifecycleService: defaultMemoryLifecycleService,
  resolveEquivalentTarget: (userId, target, now) => resolveMemoryExplicitEquivalentTarget(prisma, userId, target, now),
  readResetState: async (userId) => {
    const reset = await prisma.memoryDeletionOutbox.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { state: true },
      where: memoryResetOutboxWhere(userId)
    });
    return reset?.state ?? null;
  },
  settingsService: defaultMemorySettingsService
});

export const defaultMemoryConsumerHandlerDeps: MemoryConsumerHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryConsumerService
};
