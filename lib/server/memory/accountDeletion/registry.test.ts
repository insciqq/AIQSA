import { describe, expect, it, vi } from "vitest";
import type { MemoryDeletionClaim } from "../coordinator/types";
import {
  ACCOUNT_MEMORY_DELETION_TARGET_TYPE,
  parseAccountMemoryDeletionClaim
} from "./contract";
import { AccountMemoryDeletionRegistry } from "./registry";

function claim(overrides: Partial<MemoryDeletionClaim> = {}): MemoryDeletionClaim {
  return {
    admissionAuthorizationId: null,
    admittedActiveLeafMessageId: null,
    admittedChatSourceRevision: null,
    alsoForgetOriginMemories: null,
    attemptCount: 1,
    claimToken: "claim-1",
    id: "deletion-1",
    leaseExpiresAt: new Date("2026-08-12T12:05:00.000Z"),
    memoryGeneration: 1,
    operation: "ACCOUNT_MEMORY_DELETE",
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: "user-1",
    targetType: ACCOUNT_MEMORY_DELETION_TARGET_TYPE,
    userId: "user-1",
    ...overrides
  };
}

describe("account Memory deletion composition contract", () => {
  it("accepts only the exact owner-bound account manifest", () => {
    expect(parseAccountMemoryDeletionClaim(claim())).not.toBeNull();
    expect(parseAccountMemoryDeletionClaim(claim({ targetId: "user-2" }))).toBeNull();
    expect(parseAccountMemoryDeletionClaim(claim({ targetType: "ACCOUNT" }))).toBeNull();
    expect(parseAccountMemoryDeletionClaim(claim({ operation: "BULK_CLEAR" }))).toBeNull();
    expect(parseAccountMemoryDeletionClaim(claim({ admissionAuthorizationId: "auth" })))
      .toBeNull();
  });

  it("is empty by default, rejects duplicate owners, and unregisters by identity", () => {
    const registry = new AccountMemoryDeletionRegistry();
    const first = {
      advance: vi.fn(async () => ({ admitted: false, readyForUserDeletion: false })),
      kick: vi.fn()
    };
    const second = {
      advance: vi.fn(async () => ({ admitted: false, readyForUserDeletion: false })),
      kick: vi.fn()
    };
    expect(registry.current()).toBeNull();
    const unregister = registry.register(first);
    expect(registry.current()).toBe(first);
    expect(() => registry.register(second)).toThrow("memory_account_deletion_hook_duplicate");
    unregister();
    expect(registry.current()).toBeNull();
  });
});
