import type { MemoryDeletionHandler } from "./coordinator/types";
import type { MemoryCoordinatorRegistry } from "./coordinator/registry";
import { defaultMemoryCoordinatorRegistry } from "./coordinator/registry";
import {
  createAccountMemoryDeletionHook
} from "./accountDeletion/integration";
import {
  createPrismaAccountMemoryDeletionHandler
} from "./accountDeletion/handler";
import type {
  AccountMemoryDeletionHook,
  AccountMemoryDeletionRegistry
} from "./accountDeletion/registry";
import {
  defaultAccountMemoryDeletionRegistry
} from "./accountDeletion/registry";
import { MEMORY_DELETION_ADMISSION_POLICY } from "./capabilityPolicy";
import { memoryHistorySourceDeletionHandler } from "./history/purge";
import {
  createPrismaPermanentChatDeletionHandler
} from "../chats/permanentDeletion/cleanup";
import {
  createSourcePurgeDeletionHandler
} from "../chats/permanentDeletion/sourcePurge";
import type {
  PermanentChatDeletionCapability
} from "../chats/permanentDeletion/service";
import { prisma } from "../prisma";
import { createS3StorageAdapter } from "../uploads/storage";

export type MemoryDeletionAdmissionPolicy = Readonly<{
  accountMemoryDeletion: Readonly<{ enabled: boolean }>;
  permanentChatDeletion: Readonly<{ enabled: boolean }>;
}>;

export type MemoryDeletionCompositionStatus = Readonly<{
  accountAdmissionEnabled: boolean;
  accountHandlerReachable: boolean;
  accountHookReachable: boolean;
  composed: boolean;
  permanentChatAdmissionEnabled: boolean;
  sourcePurgeHandlerReachable: boolean;
}>;

type AccountHookFactory = (input: Readonly<{
  admissionEnabled: () => boolean;
  kick: () => void;
}>) => AccountMemoryDeletionHook;

export function createMemoryDeletionComposition(input: Readonly<{
  accountDeletionHandler: MemoryDeletionHandler;
  accountRegistry: AccountMemoryDeletionRegistry;
  coordinatorRegistry: MemoryCoordinatorRegistry;
  createAccountHook?: AccountHookFactory;
  kick: () => void;
  policy: MemoryDeletionAdmissionPolicy;
  sourcePurgeHandler: MemoryDeletionHandler;
}>) {
  if (input.accountDeletionHandler.operation !== "ACCOUNT_MEMORY_DELETE") {
    throw new Error("memory_deletion_composition_account_handler_operation_invalid");
  }
  if (input.sourcePurgeHandler.operation !== "SOURCE_PURGE") {
    throw new Error("memory_deletion_composition_source_handler_operation_invalid");
  }

  let accountHook!: AccountMemoryDeletionHook;
  const status = (): MemoryDeletionCompositionStatus => {
    const accountHandlerReachable = input.coordinatorRegistry
      .deletionHandler("ACCOUNT_MEMORY_DELETE") === input.accountDeletionHandler;
    const sourcePurgeHandlerReachable = input.coordinatorRegistry
      .deletionHandler("SOURCE_PURGE") === input.sourcePurgeHandler;
    const accountHookReachable = input.accountRegistry.current() === accountHook;
    const composed = accountHandlerReachable && sourcePurgeHandlerReachable &&
      accountHookReachable;
    return Object.freeze({
      accountAdmissionEnabled: composed && input.policy.accountMemoryDeletion.enabled,
      accountHandlerReachable,
      accountHookReachable,
      composed,
      permanentChatAdmissionEnabled: composed &&
        input.policy.permanentChatDeletion.enabled,
      sourcePurgeHandlerReachable
    });
  };
  const createAccountHook = input.createAccountHook ?? createAccountMemoryDeletionHook;
  accountHook = createAccountHook({
    admissionEnabled: () => status().accountAdmissionEnabled,
    kick: input.kick
  });
  const permanentChatDeletionCapability: PermanentChatDeletionCapability =
    Object.freeze({
      get enabled() {
        return status().permanentChatAdmissionEnabled;
      }
    });

  const ensure = (): MemoryDeletionCompositionStatus => {
    const existingSource = input.coordinatorRegistry.deletionHandler("SOURCE_PURGE");
    const existingAccount = input.coordinatorRegistry
      .deletionHandler("ACCOUNT_MEMORY_DELETE");
    const existingHook = input.accountRegistry.current();
    if (existingSource && existingSource !== input.sourcePurgeHandler) {
      throw new Error("memory_deletion_composition_source_handler_conflict");
    }
    if (existingAccount && existingAccount !== input.accountDeletionHandler) {
      throw new Error("memory_deletion_composition_account_handler_conflict");
    }
    if (existingHook && existingHook !== accountHook) {
      throw new Error("memory_deletion_composition_account_hook_conflict");
    }

    const rollback: Array<() => void> = [];
    try {
      if (!existingSource) {
        rollback.push(input.coordinatorRegistry.registerDeletion(
          input.sourcePurgeHandler
        ));
      }
      if (!existingAccount) {
        rollback.push(input.coordinatorRegistry.registerDeletion(
          input.accountDeletionHandler
        ));
      }
      if (!existingHook) rollback.push(input.accountRegistry.register(accountHook));
      const current = status();
      if (!current.composed) {
        throw new Error("memory_deletion_composition_unreachable");
      }
      return current;
    } catch (error) {
      for (const unregister of rollback.reverse()) unregister();
      throw error;
    }
  };

  return Object.freeze({
    ensure,
    permanentChatDeletionCapability,
    status
  });
}

const defaultPermanentChatDeletionHandler =
  createPrismaPermanentChatDeletionHandler(createS3StorageAdapter(), prisma);
const defaultSourcePurgeHandler = createSourcePurgeDeletionHandler({
  history: memoryHistorySourceDeletionHandler,
  permanentChat: defaultPermanentChatDeletionHandler
});
const defaultAccountDeletionHandler = createPrismaAccountMemoryDeletionHandler(prisma);
let defaultKick: (() => void) | null = null;
let defaultCompositionFailureLogged = false;

const defaultComposition = createMemoryDeletionComposition({
  accountDeletionHandler: defaultAccountDeletionHandler,
  accountRegistry: defaultAccountMemoryDeletionRegistry,
  coordinatorRegistry: defaultMemoryCoordinatorRegistry,
  kick: () => {
    if (!defaultKick) {
      throw new Error("memory_deletion_composition_coordinator_kick_unavailable");
    }
    defaultKick();
  },
  policy: MEMORY_DELETION_ADMISSION_POLICY,
  sourcePurgeHandler: defaultSourcePurgeHandler
});

export const defaultPermanentChatDeletionCapability =
  defaultComposition.permanentChatDeletionCapability;

export function readDefaultMemoryDeletionCompositionStatus():
MemoryDeletionCompositionStatus {
  return defaultComposition.status();
}

export function ensureDefaultMemoryDeletionComposition(
  kick: () => void
): MemoryDeletionCompositionStatus {
  defaultKick ??= kick;
  return defaultComposition.ensure();
}

export function tryEnsureDefaultMemoryDeletionComposition(
  kick: () => void
): boolean {
  try {
    ensureDefaultMemoryDeletionComposition(kick);
    return true;
  } catch {
    if (!defaultCompositionFailureLogged) {
      defaultCompositionFailureLogged = true;
      console.error("memory_deletion_composition_failed");
    }
    return false;
  }
}
