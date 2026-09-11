import type { MemorySettingsResponse } from "../../../contracts/memory";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryHealthService,
  type UserMemoryHealthSnapshot
} from "./service";

function settings(
  overrides: Partial<MemorySettingsResponse["settings"]> = {},
  input: Readonly<{
    automaticLearning?: boolean;
    historyState?: "DISABLED" | "INDEXING" | "READY";
  }> = {}
): MemorySettingsResponse {
  const referenceChatHistory = input.historyState !== undefined &&
    input.historyState !== "DISABLED";
  return {
  capabilities: {
    administratorSetupRequired: false,
      automaticLearning: input.automaticLearning ?? true,
      automaticLearningAvailable: input.automaticLearning ?? true,
      decayAvailable: true,
      explicitMemory: true,
      historyRecall: true,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      permanentChatDeletion: true,
      retrievalAvailable: true,
      synthesisAvailable: true,
      temporaryChats: true
    },
    historyIndexing: {
      completedChats: input.historyState === "INDEXING" ? 3 : 5,
      state: input.historyState ?? "READY",
      totalChats: input.historyState === "INDEXING" ? 5 : 5
    },
    settings: {
      decayEnabled: false,
      embeddingDeployment: {
        connectionDisplayName: "Embedding",
        id: "embedding-1",
        modelDisplayName: "Model"
      },
      learnAutomatically: true,
      memoryGeneration: 1,
      memoryRevision: 1,
      referenceChatHistory,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      settingsRevision: 1,
      synthesisEnabled: false,
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
  waitingForConfigurationCount: 0
};

function service(input: Readonly<{
  settings?: MemorySettingsResponse;
  user?: Partial<UserMemoryHealthSnapshot>;
}> = {}) {
  return createMemoryHealthService({
    now: () => new Date("2026-08-12T10:00:00.000Z"),
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

  it("distinguishes capability and configuration delays", async () => {
    await expect(service({
      settings: settings({}, { automaticLearning: false })
    }).user("owner-1")).resolves.toMatchObject({
      learning: { reason: "CAPABILITY_UNAVAILABLE", state: "DELAYED" }
    });
    await expect(service({
      user: { waitingForConfigurationCount: 1 }
    }).user("owner-1")).resolves.toMatchObject({
      learning: { reason: "CONFIGURATION_UNAVAILABLE", state: "DELAYED" }
    });
  });

  it("keeps an explicit user pause out of failure states", async () => {
    const health = await service({ settings: settings({ useMemoryFacts: false }),
      user: { waitingForConfigurationCount: 1 } }).user("owner-1");
    expect(health.learning).toEqual({ reason: "USER_DISABLED", state: "DISABLED" });
    expect(health).not.toHaveProperty("egressReview");
    expect(health.action).toBe("NONE");
  });
});
