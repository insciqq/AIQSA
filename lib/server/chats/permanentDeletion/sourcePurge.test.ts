import { describe, expect, it, vi } from "vitest";
import type { MemoryDeletionClaim } from "../../memory/coordinator/types";
import { PERMANENT_CHAT_DELETION_TARGET_TYPE } from "./contract";
import { createSourcePurgeDeletionHandler } from "./sourcePurge";

const claim = (targetType: string): MemoryDeletionClaim => ({
  admissionAuthorizationId: targetType === PERMANENT_CHAT_DELETION_TARGET_TYPE
    ? "authorization-1"
    : null,
  admittedActiveLeafMessageId: null,
  admittedChatSourceRevision: targetType === PERMANENT_CHAT_DELETION_TARGET_TYPE ? 0 : null,
  alsoForgetOriginMemories: targetType === PERMANENT_CHAT_DELETION_TARGET_TYPE ? false : null,
  attemptCount: 1,
  claimToken: "claim-1",
  id: "deletion-1",
  leaseExpiresAt: new Date("2026-08-12T12:05:00.000Z"),
  memoryGeneration: 1,
  operation: "SOURCE_PURGE",
  recoveredLease: false,
  resumedFromBlocked: false,
  targetId: "chat-1",
  targetType,
  userId: "user-1"
});

describe("SOURCE_PURGE composition", () => {
  it("routes only the exact permanent-chat target and retains history ownership", async () => {
    const historyExecute = vi.fn(async () => ({}));
    const permanentExecute = vi.fn(async () => ({}));
    const handler = createSourcePurgeDeletionHandler({
      history: { execute: historyExecute, operation: "SOURCE_PURGE" },
      permanentChat: { execute: permanentExecute, operation: "SOURCE_PURGE" }
    });
    const context = {
      now: () => new Date(),
      signal: new AbortController().signal
    };
    await handler.execute(claim(PERMANENT_CHAT_DELETION_TARGET_TYPE), context);
    await handler.execute(claim("HISTORY_SOURCE@memory-history-source-v1"), context);
    expect(permanentExecute).toHaveBeenCalledOnce();
    expect(historyExecute).toHaveBeenCalledOnce();
  });
});
