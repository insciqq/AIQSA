import type { MemorySettingsResponse } from "../../../contracts/memory";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryHealthService,
  type AdminMemoryHealthSnapshot,
  type UserMemoryHealthSnapshot
} from "./service";

function settings(
  overrides: Partial<MemorySettingsResponse["settings"]> = {},
  input: Readonly<{
    automaticLearning?: boolean;
    historyState?: "DISABLED" | "INDEXING" | "READY";
    reviewRequired?: boolean;
  }> = {}
): MemorySettingsResponse {
  const referenceChatHistory = input.historyState !== undefined &&
    input.historyState !== "DISABLED";
  return {
    capabilities: {
      automaticLearning: input.automaticLearning ?? true,
      explicitMemory: true,
      historyRecall: true,
      permanentChatDeletion: true,
      temporaryChats: true
    },
    egress: {
      acceptedAt: input.reviewRequired ? null : "2026-08-12T08:00:00.000Z",
      acceptedUtilityEgressFingerprint: input.reviewRequired ? null : "a".repeat(64),
      acceptedUtilityPolicyVersion: input.reviewRequired ? null : "policy-v1",
      consentMode: "ADMIN",
      currentUtilityEgressFingerprint: "a".repeat(64),
      currentUtilityPolicyVersion: "policy-v1",
      embeddingDestination: "Embedding / Model",
      remoteRerankerDestination: null,
      reviewRequired: input.reviewRequired ?? false,
      systemModelDestination: "System / Model"
    },
    historyIndexing: {
      completedChats: input.historyState === "INDEXING" ? 3 : 5,
      state: input.historyState ?? "READY",
      totalChats: input.historyState === "INDEXING" ? 5 : 5
    },
    settings: {
      embeddingDeployment: {
        connectionDisplayName: "Embedding",
        id: "embedding-1",
        modelDisplayName: "Model"
      },
      learnAutomatically: true,
      memoryConsentRevision: 1,
      memoryGeneration: 1,
      memoryRevision: 1,
      referenceChatHistory,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      settingsRevision: 1,
      updatedAt: "2026-08-12T08:00:00.000Z",
      useMemoryFacts: true,
      ...overrides
    }
  };
}

const userSnapshot: UserMemoryHealthSnapshot = {
  activeDeletionCount: 0,
  activeIndexMode: "HYBRID",
  blockedDeletionCount: 0,
  latestRebuildState: null,
  overdueTemporaryCount: 0,
  waitingForEgressCount: 0
};

const adminSnapshot: AdminMemoryHealthSnapshot = {
  activeDeletionCount: 0,
  activeJobCount: 0,
  blockedDeletionCount: 0,
  failedExecutionCount: 0,
  incompleteUsageCount: 0,
  oldestActiveJobAt: null,
  outcomeUnknownCount: 0,
  overdueTemporaryCount: 0,
  recentExecutionCount: 0,
  recentTerminalJobCount: 0,
  retryingJobCount: 0,
  waitingForEgressCount: 0
};

function service(input: Readonly<{
  admin?: Partial<AdminMemoryHealthSnapshot>;
  settings?: MemorySettingsResponse;
  user?: Partial<UserMemoryHealthSnapshot>;
}> = {}) {
  return createMemoryHealthService({
    now: () => new Date("2026-08-12T10:00:00.000Z"),
    readAdmin: vi.fn().mockResolvedValue({ ...adminSnapshot, ...input.admin }),
    readSettings: vi.fn().mockResolvedValue(input.settings ?? settings()),
    readUser: vi.fn().mockResolvedValue({ ...userSnapshot, ...input.user })
  });
}

describe("Memory health projections", () => {
  it("keeps blocked deletion and overdue Temporary prominent without private identifiers", async () => {
    const health = await service({
      user: {
        activeDeletionCount: 2,
        blockedDeletionCount: 1,
        overdueTemporaryCount: 1
      }
    }).user("owner-1");

    expect(health).toMatchObject({
      action: "OPEN_MEMORY_OPERATIONS",
      deletion: {
        activeCount: 2,
        retrievalFenced: true,
        state: "BLOCKED_REQUIRES_ADMIN"
      },
      state: "BLOCKED_REQUIRES_ADMIN",
      temporary: { overdueCount: 1, state: "OVERDUE" }
    });
    expect(JSON.stringify(health)).not.toMatch(
      /owner-1|sourceChatId|sourceMessageId|private memory text/iu
    );
  });

  it.each([
    [{ latestRebuildState: "TERMINAL_FAILED" as const }, {}, "REBUILD_FAILED"],
    [{ latestRebuildState: "CLAIMED" as const }, {}, "INDEXING"],
    [{ activeIndexMode: "LEXICAL_ONLY" as const }, { historyState: "READY" as const }, "FTS_ONLY"],
    [{}, { historyState: "INDEXING" as const }, "INDEXING"]
  ])("projects rebuild/index degradation %#", async (snapshot, settingOptions, expected) => {
    const health = await service({
      settings: settings({}, settingOptions),
      user: snapshot
    }).user("owner-1");
    expect(health.state).toBe(expected);
  });

  it("distinguishes capability and admin-review delays", async () => {
    await expect(service({
      settings: settings({}, { automaticLearning: false })
    }).user("owner-1")).resolves.toMatchObject({
      learning: { reason: "CAPABILITY_UNAVAILABLE", state: "DELAYED" }
    });
    await expect(service({
      settings: settings({}, { reviewRequired: true }),
      user: { waitingForEgressCount: 1 }
    }).user("owner-1")).resolves.toMatchObject({
      egressReview: "ADMIN_REQUIRED",
      learning: { reason: "EGRESS_REVIEW", state: "DELAYED" }
    });
  });

  it("uses aggregate bands and lag buckets without owner drilldown", async () => {
    const health = await service({
      admin: {
        activeDeletionCount: 2,
        activeJobCount: 30,
        blockedDeletionCount: 1,
        failedExecutionCount: 2,
        oldestActiveJobAt: new Date("2026-08-12T08:00:00.000Z"),
        recentExecutionCount: 4,
        waitingForEgressCount: 3
      }
    }).admin("admin-1", { egressReviewRequired: true });

    expect(health).toMatchObject({
      deletion: { active: "SOME", blocked: "SOME", state: "ATTENTION_REQUIRED" },
      overall: "ACTION_REQUIRED",
      provider: { failedRecent: "SOME", state: "DEGRADED" },
      queue: {
        active: "MANY",
        oldestLag: "UNDER_24_HOURS",
        state: "DELAYED",
        waitingForReview: "SOME"
      }
    });
    expect(JSON.stringify(health)).not.toMatch(/admin-1|userId|owner|query|source/iu);
  });
});
