import type { MemoryDeletionHandler } from "./coordinator/types";
import { MemoryCoordinatorError } from "./coordinator/errors";
import type { MemoryCoordinatorRegistry } from "./coordinator/registry";
import { defaultMemoryCoordinatorRegistry } from "./coordinator/registry";
import { createPrismaAccountMemoryDeletionHandler } from "./accountDeletion/handler";
import { memoryHistorySourceDeletionHandler } from "./history/purge";
import { memorySavedSecretScrubDeletionHandler } from "./savedSecretScrub";
import { MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE } from "./savedSecretScrubRequest";
import { PERMANENT_CHAT_DELETION_TARGET_TYPE } from "../chats/permanentDeletion/contract";
import {
  permanentChatDeletionCapability,
  type PermanentChatDeletionCapability
} from "../chats/permanentDeletion/service";
import { prisma } from "../prisma";

/**
 * Chat purge and Temporary expiry moved to the background worker (`lib/server/background/`, 2026-11-22): it
 * finds fenced and expired chats by their own rows. An outbox row still written for either (by the previous
 * release, or by the Temporary scheduling the Memory removal deletes) completes here as a no-op, so the old
 * coordinator never processes a chat the worker owns.
 */
export const legacyPermanentChatDeletionHandler: MemoryDeletionHandler = Object.freeze({
  async execute() {
    return {};
  },
  operation: "SOURCE_PURGE"
});

export const legacyTemporaryChatDeletionHandler: MemoryDeletionHandler = Object.freeze({
  async execute() {
    return {};
  },
  operation: "TEMPORARY_DELETE"
});

/** One SOURCE_PURGE owner routes exact typed obligations without fallback. */
export function createMemorySourcePurgeDeletionHandler(input: Readonly<{
  history: MemoryDeletionHandler;
  savedSecretScrub: MemoryDeletionHandler;
}>): MemoryDeletionHandler {
  if (input.history.operation !== "SOURCE_PURGE" || input.savedSecretScrub.operation !== "SOURCE_PURGE") {
    throw new Error("memory_source_purge_handler_operation_invalid");
  }
  return Object.freeze({
    async execute(claim, context) {
      if (claim.operation !== "SOURCE_PURGE") {
        throw new MemoryCoordinatorError("memory_deletion_target_invalid", false);
      }
      if (claim.targetType === PERMANENT_CHAT_DELETION_TARGET_TYPE) {
        return legacyPermanentChatDeletionHandler.execute(claim, context);
      }
      return claim.targetType === MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE
        ? input.savedSecretScrub.execute(claim, context)
        : input.history.execute(claim, context);
    },
    operation: "SOURCE_PURGE"
  });
}

export type MemoryDeletionCompositionStatus = Readonly<{
  accountHandlerReachable: boolean;
  composed: boolean;
  sourcePurgeHandlerReachable: boolean;
}>;

/**
 * Registers the Memory coordinator's SOURCE_PURGE router and its account purge, which still drain the Memory
 * obligations the previous release admitted. Account deletion itself no longer waits for them
 * (`lib/server/auth/adminUserSessionCommands.ts`).
 */
export function createMemoryDeletionComposition(input: Readonly<{
  accountDeletionHandler: MemoryDeletionHandler;
  coordinatorRegistry: MemoryCoordinatorRegistry;
  sourcePurgeHandler: MemoryDeletionHandler;
}>) {
  if (input.accountDeletionHandler.operation !== "ACCOUNT_MEMORY_DELETE") {
    throw new Error("memory_deletion_composition_account_handler_operation_invalid");
  }
  if (input.sourcePurgeHandler.operation !== "SOURCE_PURGE") {
    throw new Error("memory_deletion_composition_source_handler_operation_invalid");
  }
  const status = (): MemoryDeletionCompositionStatus => {
    const accountHandlerReachable = input.coordinatorRegistry
      .deletionHandler("ACCOUNT_MEMORY_DELETE") === input.accountDeletionHandler;
    const sourcePurgeHandlerReachable = input.coordinatorRegistry
      .deletionHandler("SOURCE_PURGE") === input.sourcePurgeHandler;
    return Object.freeze({
      accountHandlerReachable,
      composed: accountHandlerReachable && sourcePurgeHandlerReachable,
      sourcePurgeHandlerReachable
    });
  };
  const ensure = (): MemoryDeletionCompositionStatus => {
    const existingSource = input.coordinatorRegistry.deletionHandler("SOURCE_PURGE");
    const existingAccount = input.coordinatorRegistry.deletionHandler("ACCOUNT_MEMORY_DELETE");
    if (existingSource && existingSource !== input.sourcePurgeHandler) {
      throw new Error("memory_deletion_composition_source_handler_conflict");
    }
    if (existingAccount && existingAccount !== input.accountDeletionHandler) {
      throw new Error("memory_deletion_composition_account_handler_conflict");
    }
    if (!existingSource) input.coordinatorRegistry.registerDeletion(input.sourcePurgeHandler);
    if (!existingAccount) input.coordinatorRegistry.registerDeletion(input.accountDeletionHandler);
    const current = status();
    if (!current.composed) throw new Error("memory_deletion_composition_unreachable");
    return current;
  };
  return Object.freeze({ ensure, status });
}

const defaultComposition = createMemoryDeletionComposition({
  accountDeletionHandler: createPrismaAccountMemoryDeletionHandler(prisma),
  coordinatorRegistry: defaultMemoryCoordinatorRegistry,
  sourcePurgeHandler: createMemorySourcePurgeDeletionHandler({
    history: memoryHistorySourceDeletionHandler,
    savedSecretScrub: memorySavedSecretScrubDeletionHandler
  })
});

/** Permanent chat deletion is always available: it no longer depends on this composition. */
export const defaultPermanentChatDeletionCapability: PermanentChatDeletionCapability =
  permanentChatDeletionCapability;

export function ensureDefaultMemoryDeletionComposition(): MemoryDeletionCompositionStatus {
  return defaultComposition.ensure();
}
