import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunRequest } from "../../providers/types";
import type { MemoryPreparingSettingsSnapshot } from "../../runs/preparingRun";
import { memorySha256 } from "../persistence/lexical";
import {
  ExplicitRunMemoryManagementError,
  normalizedExplicitRunQuery,
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

function request(overrides: Partial<NormalizedRunRequest> = {}): NormalizedRunRequest {
  return {
    attachmentIds: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "What is my preferred editor?", type: "text" }] },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: false,
      vision: false
    },
    modelId: "model-1",
    params: {},
    prompt: { developer: null, system: null },
    provider: "openai",
    searchStrategy: "search-disabled",
    ...overrides
  };
}

describe("explicit run-memory eligibility", () => {
  it("injects nothing for a non-owned Assistant and fails management intent closed", async () => {
    const findFirst = vi.fn(async () => null);
    const client = {
      assistantDefinition: { findFirst }
    } as unknown as PrismaClient;

    await expect(retrieveExplicitRunMemory(client, {
      assistantId: "published-assistant",
      normalizedRequest: request(),
      settings,
      userId: "user-1"
    })).resolves.toMatchObject({
      budgetSnapshot: { reason: "assistant_memory_grant_missing" },
      items: [],
      outcome: "DISABLED",
      preparedContext: null
    });
    await expect(retrieveExplicitRunMemory(client, {
      actionPlan: { kind: "LIST", query: null, version: "memory-action-plan-v1" },
      assistantId: "published-assistant",
      normalizedRequest: request(),
      settings,
      userId: "user-1"
    })).rejects.toEqual(new ExplicitRunMemoryManagementError("memory_tool_egress_forbidden"));
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("injects nothing when the same provider request exposes an external capability", async () => {
    const client = {} as PrismaClient;
    await expect(retrieveExplicitRunMemory(client, {
      normalizedRequest: request({
        searchStrategy: "openai-native-web-search"
      }),
      settings,
      userId: "user-1"
    })).resolves.toMatchObject({
      budgetSnapshot: { reason: "external_tool_egress_guard" },
      items: [],
      outcome: "DISABLED",
      preparedContext: null
    });
  });

  it("withholds a secret-tainted query snapshot while retaining only its hash", async () => {
    const query = "My API key is sk-abcdefghijklmnop";
    await expect(retrieveExplicitRunMemory({} as PrismaClient, {
      normalizedRequest: request({
        content: { blocks: [{ text: query, type: "text" }] }
      }),
      settings,
      userId: "user-1"
    })).resolves.toMatchObject({
      budgetSnapshot: { reason: "query_secret_blocked" },
      outcome: "FAILED_SAFE",
      preparedContext: null,
      queryHash: memorySha256(normalizedExplicitRunQuery(query)),
      querySnapshot: null
    });
  });

  it("injects an authoritative empty result for a non-tool Memory list", async () => {
    const $queryRaw = vi.fn(async () => []);
    const result = await retrieveExplicitRunMemory({ $queryRaw } as unknown as PrismaClient, {
      actionPlan: { kind: "LIST", query: null, version: "memory-action-plan-v1" },
      normalizedRequest: request(),
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
      },
      querySnapshot: null
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});
