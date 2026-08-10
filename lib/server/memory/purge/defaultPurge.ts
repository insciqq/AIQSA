import { defaultMemoryCoordinatorRegistry } from "../coordinator/registry";
import {
  MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS
} from "./contract";
import { registerPhase2MemoryDeletionContributors } from "./leaves";
import { reconcileCompletedMemoryDeletionAudits } from "./reconciliation";
import { MemoryDeletionContributorRegistry } from "./registry";

export const defaultMemoryDeletionContributorRegistry =
  new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS
  });

registerPhase2MemoryDeletionContributors(defaultMemoryDeletionContributorRegistry);

const defaultForgetPurgeHandler = defaultMemoryDeletionContributorRegistry.handler();

export function ensureDefaultMemoryPurgeHandlerRegistered(): void {
  const existing = defaultMemoryCoordinatorRegistry.deletionHandler("FORGET_PURGE");
  if (existing === defaultForgetPurgeHandler) return;
  if (existing) throw new Error("memory_default_purge_handler_conflict");
  defaultMemoryCoordinatorRegistry.registerDeletion(defaultForgetPurgeHandler);
}

export async function reconcileDefaultCompletedMemoryDeletionAudits(): Promise<void> {
  const now = new Date();
  const limit = 100;
  while (true) {
    const result = await reconcileCompletedMemoryDeletionAudits({
      limit,
      now,
      registry: defaultMemoryDeletionContributorRegistry
    });
    if (result.checked < limit) return;
  }
}
