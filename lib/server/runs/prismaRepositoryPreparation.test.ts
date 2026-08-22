import { describe, expect, it, vi } from "vitest";
import {
  finalizeUnavailablePreparingRunAdmission,
  finalizeTemporaryPreparingRunAdmission,
  sameMemoryReadOnlyControlRetryScope,
  validMemoryRerankRetrySettlement,
  validMemoryRetrievalExecutionSequence
} from "./prismaRepositoryPreparation";
import { createMemoryPreparingBaseSnapshot } from "./preparingRun";

const settingsSnapshot = Object.freeze({
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  learnAutomatically: false,
  memoryConsentRevision: 0,
  referenceChatHistory: false,
  schemaVersion: 1 as const,
  settingsRevision: 0,
  useMemoryFacts: false
});

function input(chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY") {
  return {
    assistantMessageId: "assistant-message-1",
    chatMemoryMode,
    folderId: null,
    memoryGeneration: 0,
    memoryRevision: 0,
    normalizedRequest: { privateMarker: "temporary-user-content" } as never,
    runId: "run-1",
    settingsSnapshot,
    userMessageId: "user-message-1"
  };
}

describe("Temporary run Memory preparation boundary", () => {
  it("moves Temporary admission directly to streaming without a Memory attempt", async () => {
    const update = vi.fn(async () => ({}));

    await expect(finalizeTemporaryPreparingRunAdmission({
      modelRun: { update }
    } as never, input("TEMPORARY"))).resolves.toEqual({
      assistantMessageId: "assistant-message-1",
      attemptId: "",
      chatMemoryMode: "TEMPORARY",
      folderId: null,
      memoryGeneration: 0,
      memoryRevision: 0,
      runId: "run-1",
      settingsSnapshot,
      userMessageId: "user-message-1"
    });
    expect(update).toHaveBeenCalledWith({
      data: {
        normalizedRequest: { privateMarker: "temporary-user-content" },
        status: "streaming"
      },
      where: { id: "run-1" }
    });
  });

  it.each(["NORMAL", "EXCLUDED"] as const)(
    "leaves %s admission on the ordinary Memory preparation path",
    async (chatMemoryMode) => {
      const update = vi.fn();
      await expect(finalizeTemporaryPreparingRunAdmission({
        modelRun: { update }
      } as never, input(chatMemoryMode))).resolves.toBeNull();
      expect(update).not.toHaveBeenCalled();
    }
  );
});

describe("initial Memory admission deadline fallback", () => {
  it("makes the ordinary run dispatchable with a durable zero-item unavailable receipt", async () => {
    const attemptCreate = vi.fn(async () => ({}));
    const attemptUpdate = vi.fn(async () => ({}));
    const bindingCreate = vi.fn(async () => ({}));
    const runUpdate = vi.fn(async () => ({}));
    const normalizedRequest = {
      prompt: {
        memoryActionAnswerResult: {
          operation: "NONE",
          status: "UNAVAILABLE",
          version: 1
        }
      }
    } as never;
    const baseSnapshot = createMemoryPreparingBaseSnapshot({
      normalizedRequest,
      providerRequestPreview: { request: "base" }
    });

    const result = await finalizeUnavailablePreparingRunAdmission({
      memoryRetrievalAttempt: {
        create: attemptCreate,
        update: attemptUpdate
      },
      modelRun: { update: runUpdate },
      modelRunMemoryBinding: { create: bindingCreate }
    } as never, {
      admissionKind: "NORMAL_SEND",
      assistantIdSnapshot: null,
      assistantMessageId: "assistant-message-1",
      baseSnapshot,
      chatId: "chat-1",
      chatMemoryMode: "NORMAL",
      folderId: null,
      lifecycleSnapshot: {
        activeLeafMessageId: "assistant-message-1",
        memoryBranchGeneration: 3,
        memorySourceRevision: 5
      },
      normalizedRequest,
      now: new Date("2026-08-21T10:00:00.000Z"),
      preSendActiveLeafMessageId: null,
      runId: "run-1",
      userId: "user-1",
      userMessageId: "user-message-1"
    });

    expect(result).toMatchObject({
      attemptId: expect.any(String),
      chatMemoryMode: "NORMAL",
      memoryGeneration: 0,
      memoryRevision: 0,
      runId: "run-1"
    });
    expect(attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        chatMemoryModeSnapshot: "NORMAL",
        externalRolesUsed: [],
        state: "PENDING",
        utilityEgressMode: "LOCAL_ONLY"
      })
    }));
    expect(attemptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        degradationCode: "memory_admission_deadline_exceeded",
        outcome: "FAILED_SAFE",
        state: "CONSUMED"
      })
    }));
    expect(bindingCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        degradationCode: "memory_admission_deadline_exceeded",
        outcome: "FAILED_SAFE"
      })
    }));
    expect(runUpdate).toHaveBeenCalledWith({
      data: { normalizedRequest, status: "streaming" },
      where: { id: "run-1" }
    });
  });
});

describe("Memory retrieval execution sequence", () => {
  it("allows exactly one bounded reranker retry after the primary attempt", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
  });

  it("allows the embedding-free reranker sequence only for a broad profile inventory", () => {
    const profileSequence = [
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 }
    ];
    expect(validMemoryRetrievalExecutionSequence(profileSequence, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence(profileSequence)).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 }
    ], true)).toBe(false);
  });

  it("allows only the six exact control, target, retrieval, and retry bindings", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 3 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
  });

  it.each([
    [[{ logicalRole: "MEMORY_RERANK", ordinal: 3 }]],
    [[{ logicalRole: "MEMORY_RERANK", ordinal: 2 }]],
    [[{ logicalRole: "MEMORY_CONTROL", ordinal: 1 }]],
    [[{ logicalRole: "MEMORY_QUERY_EMBED", ordinal: 3 }]],
    [[
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 },
      { logicalRole: "MEMORY_RERANK", ordinal: 4 }
    ]],
    [[
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 }
    ]]
  ])("rejects an invalid or unbounded retry sequence (%#)", (bindings) => {
    expect(validMemoryRetrievalExecutionSequence(bindings)).toBe(false);
  });

  it("requires a durably invalid primary result before accepting a reranker retry", () => {
    const retry = {
      errorCode: null,
      logicalRole: "MEMORY_RERANK",
      ordinal: 3,
      state: "SUCCEEDED"
    };
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_output_invalid",
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "FAILED"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: null,
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "SUCCEEDED"
    }, retry])).toBe(false);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_provider_failed",
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "FAILED"
    }, retry])).toBe(false);
  });
});

describe("read-only control retry scope", () => {
  const source = Object.freeze({
    admissionKind: "NORMAL_SEND" as const,
    admittedAssistantLeafMessageId: "assistant-message-1",
    admittedUserMessageId: "user-message-1",
    assistantIdSnapshot: null,
    attemptOrdinal: 0,
    baseRequestHash: "a".repeat(64),
    budgetSnapshot: {
      memoryActionLifecycleSnapshot: {
        activeLeafMessageId: "assistant-message-1",
        branchGeneration: 2,
        sourceRevision: 3,
        version: 1
      }
    },
    chatId: "chat-1",
    chatMemoryModeSnapshot: "NORMAL" as const,
    folderIdSnapshot: null,
    id: "attempt-1",
    indexGenerationIdSnapshot: "generation-1",
    memoryGenerationSnapshot: 4,
    modelRunId: "run-1",
    preSendActiveLeafMessageId: null,
    settingsSnapshot: {
      ...settingsSnapshot,
      acceptedUtilityEgressFingerprint: "b".repeat(64),
      acceptedUtilityPolicyVersion: "memory-policy-v1",
      activeIndexGenerationId: "generation-1",
      learnAutomatically: true,
      memoryConsentRevision: 2,
      referenceChatHistory: true,
      settingsRevision: 5,
      useMemoryFacts: true
    },
    userId: "user-1"
  });
  const current = Object.freeze({ ...source, attemptOrdinal: 1, id: "attempt-2" });

  it("accepts only the exact retry scope copied from attempt zero", () => {
    expect(sameMemoryReadOnlyControlRetryScope(source, current)).toBe(true);
  });

  it.each([
    ["run", { modelRunId: "run-2" }],
    ["base request", { baseRequestHash: "c".repeat(64) }],
    ["assistant leaf", { admittedAssistantLeafMessageId: "assistant-message-2" }],
    ["index generation", { indexGenerationIdSnapshot: "generation-2" }],
    ["Memory generation", { memoryGenerationSnapshot: 5 }],
    ["lifecycle", {
      budgetSnapshot: {
        memoryActionLifecycleSnapshot: {
          activeLeafMessageId: "assistant-message-1",
          branchGeneration: 2,
          sourceRevision: 4,
          version: 1
        }
      }
    }],
    ["settings", {
      settingsSnapshot: { ...source.settingsSnapshot, settingsRevision: 6 }
    }]
  ])("rejects tampered %s lineage", (_label, change) => {
    expect(sameMemoryReadOnlyControlRetryScope(source, { ...current, ...change }))
      .toBe(false);
  });
});
