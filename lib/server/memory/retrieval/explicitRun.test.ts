import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryPreparingSettingsSnapshot } from "../../runs/preparingRun";
import {
  ExplicitRunMemoryManagementError,
  retrieveExplicitRunMemory
} from "./explicitRun";

const settings: MemoryPreparingSettingsSnapshot = {
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  learnAutomatically: false,
  memoryConsentRevision: 0,
  referenceChatHistory: false,
  schemaVersion: 1,
  settingsRevision: 0,
  useMemoryFacts: true
};

describe("legacy explicit run-memory decoder", () => {
  it("fails a persisted list plan closed for a non-owned Assistant", async () => {
    const findFirst = vi.fn(async () => null);
    const client = {
      assistantDefinition: { findFirst }
    } as unknown as PrismaClient;

    await expect(retrieveExplicitRunMemory(client, {
      actionPlan: { kind: "LIST", query: null, version: "memory-action-plan-v1" },
      assistantId: "published-assistant",
      settings,
      userId: "user-1"
    })).rejects.toEqual(new ExplicitRunMemoryManagementError("memory_action_failed"));
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("keeps recognizable-format DLP on a persisted list query", async () => {
    await expect(retrieveExplicitRunMemory({} as PrismaClient, {
      actionPlan: {
        kind: "LIST",
        query: "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
        version: "memory-action-plan-v1"
      },
      settings,
      userId: "user-1"
    })).rejects.toEqual(new ExplicitRunMemoryManagementError("memory_action_failed"));
  });

  it("returns the legacy authoritative empty result without semantic scoring", async () => {
    const $queryRaw = vi.fn(async () => []);
    const result = await retrieveExplicitRunMemory({ $queryRaw } as unknown as PrismaClient, {
      actionPlan: { kind: "LIST", query: null, version: "memory-action-plan-v1" },
      settings,
      userId: "user-1"
    });

    expect(result).toMatchObject({
      budgetSnapshot: {
        itemCount: 0,
        managementResult: "AUTHORITATIVE_EMPTY_LIST",
        reason: "authoritative_list_empty"
      },
      items: [],
      outcome: "EMPTY",
      preparedContext: {
        text: expect.stringContaining("No active explicit memories are saved.")
      }
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});
