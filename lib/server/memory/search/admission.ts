import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_SEARCH_VERSION, type MemorySearchSnapshot, type MemorySearchDestination } from "./contract";

/** Local configuration admission only: no provider/index calls and no content reads. */
export async function admitMemorySearch(input: Readonly<{
  userId: string; timeoutSeconds: number; assistantId?: string | null;
}>, client: PrismaClient = prisma): Promise<MemorySearchSnapshot | null> {
  if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 120) {
    throw new Error("memory_search_timeout_invalid");
  }
  return withLockedMemoryTransaction(client, input.userId, async (tx, settings) => {
    if (!settings.useMemoryFacts) return null;
    if (input.assistantId && !(await tx.assistantDefinition.findFirst({ where: {
      id: input.assistantId, ownerUserId: input.userId, archivedAt: null
    }, select: { id: true } }))) return null;
    const policy = await resolveCurrentMemoryUtilityPolicy(tx, input.userId, settings);
    const embedding = policy.targets.get("MEMORY_QUERY_EMBED");
    const destinations: MemorySearchDestination[] = [
      ...(embedding ? [{ role: "MEMORY_QUERY_EMBED" as const, target: embedding }] : []),
      ...(policy.rerankerTargets ?? []).slice(0, 3).map(target => ({ role: "MEMORY_RERANK" as const, target }))
    ].map(({ role, target }) => ({ role, providerModelId: target.authority.providerModelId,
      destinationFingerprint: target.destinationFingerprint, executionTargetFingerprint: target.executionTargetFingerprint }));
    return { version: MEMORY_SEARCH_VERSION, maxCalls: 3, resultTokens: 6000, comparisonResultTokens: 12000,
      timeoutSeconds: input.timeoutSeconds, memoryGeneration: settings.memoryGeneration,
      referenceChatHistory: settings.referenceChatHistory, destinations };
  }, { deadlineAtMs: Date.now() + 5000 });
}
