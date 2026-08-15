import { describe, expect, it } from "vitest";
import {
  adminMemoryHealthSchema,
  decodeMemoryHealthResponse
} from "./memoryHealth";

function userHealth() {
  return {
    action: "NONE",
    deletion: {
      activeCount: 0,
      countTruncated: false,
      retrievalFenced: false,
      state: "CLEAR"
    },
    egressReview: "NONE",
    indexing: {
      completedChats: 0,
      countTruncated: false,
      state: "DISABLED",
      totalChats: 0
    },
    learning: { reason: "USER_DISABLED", state: "DISABLED" },
    observedAt: "2026-08-12T10:00:00.000Z",
    rebuild: { state: "IDLE" },
    state: "UP_TO_DATE",
    temporary: { countTruncated: false, overdueCount: 0, state: "CLEAR" }
  };
}

describe("Memory health wire contracts", () => {
  it("accepts a bounded owner projection and rejects extra or inconsistent evidence", () => {
    expect(decodeMemoryHealthResponse({ health: userHealth() })).not.toBeNull();
    expect(decodeMemoryHealthResponse({
      health: { ...userHealth(), sourceChatId: "private-chat" }
    })).toBeNull();
    expect(decodeMemoryHealthResponse({
      health: {
        ...userHealth(),
        deletion: {
          activeCount: 1,
          countTruncated: false,
          retrievalFenced: false,
          state: "IN_PROGRESS"
        }
      }
    })).toBeNull();
    expect(decodeMemoryHealthResponse({
      health: {
        ...userHealth(),
        deletion: {
          activeCount: 1,
          countTruncated: false,
          retrievalFenced: true,
          state: "BLOCKED_REQUIRES_ADMIN"
        }
      }
    })).toBeNull();
    expect(decodeMemoryHealthResponse({
      health: { ...userHealth(), action: "OPEN_MEMORY_OPERATIONS" }
    })).toBeNull();
  });

  it("accepts only bounded aggregate admin labels", () => {
    const value = {
      deletion: { active: "SOME", blocked: "NONE", state: "WORKING" },
      observedAt: "2026-08-12T10:00:00.000Z",
      overall: "DEGRADED",
      provider: {
        failedRecent: "NONE",
        outcomeUnknown: "NONE",
        state: "READY",
        usageIncomplete: "NONE"
      },
      queue: {
        active: "SOME",
        failed: "NONE",
        oldestLag: "UNDER_15_MINUTES",
        state: "WORKING",
        waitingForReview: "NONE"
      },
      temporary: { overdue: "NONE", state: "CLEAR" }
    };
    expect(adminMemoryHealthSchema.safeParse(value).success).toBe(true);
    expect(adminMemoryHealthSchema.safeParse({ ...value, ownerId: "user-1" }).success)
      .toBe(false);
    expect(adminMemoryHealthSchema.safeParse({
      ...value,
      queue: { ...value.queue, active: 12 }
    }).success).toBe(false);
  });
});
