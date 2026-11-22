import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinatorRegistry } from "./coordinator/registry";
import type { MemoryDeletionClaim, MemoryDeletionHandler } from "./coordinator/types";
import {
  createMemoryDeletionComposition,
  createMemorySourcePurgeDeletionHandler,
  legacyTemporaryChatDeletionHandler
} from "./deletionComposition";
import { PERMANENT_CHAT_DELETION_TARGET_TYPE } from "../chats/permanentDeletion/contract";
import { MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE } from "./savedSecretScrubRequest";

function handler(operation: "ACCOUNT_MEMORY_DELETE" | "SOURCE_PURGE"): MemoryDeletionHandler {
  return Object.freeze({ execute: vi.fn(async () => ({})), operation });
}

function claim(targetType: string): MemoryDeletionClaim {
  return {
    admissionAuthorizationId: null, admittedActiveLeafMessageId: null, admittedChatSourceRevision: null,
    alsoForgetOriginMemories: null, attemptCount: 1, claimToken: "token", id: "deletion-1",
    leaseExpiresAt: new Date("2026-11-22T12:00:30.000Z"), memoryGeneration: 0, operation: "SOURCE_PURGE",
    recoveredLease: false, resumedFromBlocked: false, targetId: "chat-1", targetType, userId: "user-1"
  };
}

const context = { now: () => new Date("2026-11-22T12:00:00.000Z"), signal: new AbortController().signal };

describe("Memory deletion composition", () => {
  it("registers the source purge router and the account purge once, and refuses a conflicting owner", () => {
    const coordinatorRegistry = new MemoryCoordinatorRegistry();
    const accountDeletionHandler = handler("ACCOUNT_MEMORY_DELETE");
    const sourcePurgeHandler = handler("SOURCE_PURGE");
    const created = createMemoryDeletionComposition({ accountDeletionHandler, coordinatorRegistry, sourcePurgeHandler });
    expect(created.status().composed).toBe(false);
    expect(created.ensure()).toEqual({ accountHandlerReachable: true, composed: true, sourcePurgeHandlerReachable: true });
    expect(created.ensure().composed).toBe(true);

    const other = createMemoryDeletionComposition({
      accountDeletionHandler: handler("ACCOUNT_MEMORY_DELETE"), coordinatorRegistry, sourcePurgeHandler
    });
    expect(() => other.ensure()).toThrow("memory_deletion_composition_account_handler_conflict");
  });

  it("completes a pre-upgrade chat purge as a no-op and routes the Memory obligations", async () => {
    const history = handler("SOURCE_PURGE");
    const savedSecretScrub = handler("SOURCE_PURGE");
    const router = createMemorySourcePurgeDeletionHandler({ history, savedSecretScrub });
    await expect(router.execute(claim(PERMANENT_CHAT_DELETION_TARGET_TYPE), context)).resolves.toEqual({});
    expect(history.execute).not.toHaveBeenCalled();
    expect(savedSecretScrub.execute).not.toHaveBeenCalled();
    await router.execute(claim(MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE), context);
    expect(savedSecretScrub.execute).toHaveBeenCalledOnce();
    await router.execute(claim("HISTORY@other"), context);
    expect(history.execute).toHaveBeenCalledOnce();
  });

  it("leaves Temporary chats to the background worker", async () => {
    await expect(legacyTemporaryChatDeletionHandler.execute(
      { ...claim("TEMPORARY_CHAT@temporary-24h-v1"), operation: "TEMPORARY_DELETE" }, context
    )).resolves.toEqual({});
  });
});
