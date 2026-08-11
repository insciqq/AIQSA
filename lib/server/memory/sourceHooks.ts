import {
  NOOP_MEMORY_SOURCE_MUTATION_HOOKS,
  type MemorySourceMutationHooks
} from "./sourceState";
import {
  applyMemoryAssistantAvailabilityChange,
  applyMemoryScopeTargetDeletion
} from "./scopeLifecycle";
import { applyTemporaryRunFinalized } from "./temporaryRetention";
import { applyMemoryHistorySourceMutation } from "./history/sourceLifecycle";
import { applyMemoryLearningSourceMutation } from "./learning/sourceLifecycle";

/**
 * Feature-local Memory leaves compose here. Shared chat/message/run repositories
 * depend only on the narrow hook contract and never import lifecycle owners.
 */
export const defaultMemorySourceMutationHooks: MemorySourceMutationHooks =
  Object.freeze({
    ...NOOP_MEMORY_SOURCE_MUTATION_HOOKS,
    async onRetainedSourceMutated(tx, event) {
      await applyMemoryHistorySourceMutation(tx, event);
      await applyMemoryLearningSourceMutation(tx, event);
    },
    onTemporaryRunFinalized: applyTemporaryRunFinalized,
    async onScopedTargetOwnerLifecycle(tx, event) {
      if (event.kind === "ASSISTANT_ACCESS_CHANGE") {
        await applyMemoryAssistantAvailabilityChange(tx, {
          assistantId: event.targetId,
          userId: event.userId
        });
        return;
      }
      await applyMemoryScopeTargetDeletion(tx, {
        scopeType: event.kind === "FOLDER_DELETE" ? "FOLDER" : "CHAT",
        targetId: event.targetId,
        userId: event.userId
      });
    }
  });
