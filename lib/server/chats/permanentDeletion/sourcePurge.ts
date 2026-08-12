import { MemoryCoordinatorError } from "../../memory/coordinator/errors";
import type { MemoryDeletionHandler } from "../../memory/coordinator/types";
import { PERMANENT_CHAT_DELETION_TARGET_TYPE } from "./contract";

/** One SOURCE_PURGE owner routes exact typed obligations without fallback. */
export function createSourcePurgeDeletionHandler(input: Readonly<{
  history: MemoryDeletionHandler;
  permanentChat: MemoryDeletionHandler;
}>): MemoryDeletionHandler {
  if (
    input.history.operation !== "SOURCE_PURGE" ||
    input.permanentChat.operation !== "SOURCE_PURGE"
  ) {
    throw new Error("memory_source_purge_handler_operation_invalid");
  }
  return Object.freeze({
    async execute(claim, context) {
      if (claim.operation !== "SOURCE_PURGE") {
        throw new MemoryCoordinatorError("memory_deletion_target_invalid", false);
      }
      return claim.targetType === PERMANENT_CHAT_DELETION_TARGET_TYPE
        ? input.permanentChat.execute(claim, context)
        : input.history.execute(claim, context);
    },
    operation: "SOURCE_PURGE"
  });
}
