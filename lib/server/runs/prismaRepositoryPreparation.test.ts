import { describe, expect, it, vi } from "vitest";
import {
  finalizeUnavailablePreparingRunAdmission,
  finalizeTemporaryPreparingRunAdmission,
  sameMemoryReadOnlyControlRetryScope,
  validMemoryRerankRetrySettlement,
  validMemoryRetrievalExecutionSequence
} from "./prismaRepositoryPreparation";
import {
  createMemoryPreparingBaseSnapshot,
  decodeMemoryPreparingSettingsSnapshot
} from "./preparingRun";
import {
  MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
  MEMORY_RERANK_MAX_ATTEMPTS
} from "../memory/retrieval/runUtilities";

const settingsSnapshot = Object.freeze({
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  decayEnabled: false,
  decayPolicyVersion: null,
  learnAutomatically: false,
  memoryConsentRevision: 0,
  referenceChatHistory: false,
  schemaVersion: 2 as const,
  settingsRevision: 0,
  useMemoryFacts: false
});

describe("Memory preparing settings compatibility", () => {
  it("normalizes an accepted v1 snapshot to decay-disabled v2", () => {
    const { decayEnabled: _enabled, decayPolicyVersion: _policy, ...legacy } =
      settingsSnapshot;
    expect(decodeMemoryPreparingSettingsSnapshot({
      ...legacy,
      schemaVersion: 1
    })).toEqual(settingsSnapshot);
  });
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
  it("allows only one fresh reranker retry after the primary attempt", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 },
      { logicalRole: "MEMORY_RERANK", ordinal: 4 }
    ])).toBe(false);
  });

  it("allows nine bounded reranker batches plus one global aggregation and retries", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 3 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 1 },
      ...Array.from(
        {
          length: MEMORY_RERANK_AGGREGATION_MAX_BATCHES *
            MEMORY_RERANK_MAX_ATTEMPTS
        },
        (_, index) => ({ logicalRole: "MEMORY_RERANK", ordinal: index + 2 })
      )
    ], false, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      ...Array.from(
        { length: 6 },
        (_, index) => ({
          logicalRole: "MEMORY_RERANK",
          ordinal: 2 + index * MEMORY_RERANK_MAX_ATTEMPTS
        })
      )
    ], false, true)).toBe(true);
  });

  it("allows earlier-utility degradation while constraining a broad profile inventory", () => {
    const profileSequence = [
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 }
    ];
    expect(validMemoryRetrievalExecutionSequence(profileSequence, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence(profileSequence)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      ...profileSequence,
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ], true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 }
    ], true)).toBe(false);
  });

  it("allows bounded control, target, retrieval, and read-only retry bindings", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 2 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 3 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 4 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 2 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 4 }
    ])).toBe(false);
  });

  it.each([
    [[{
      logicalRole: "MEMORY_RERANK",
      ordinal: 2 + MEMORY_RERANK_AGGREGATION_MAX_BATCHES *
        MEMORY_RERANK_MAX_ATTEMPTS
    }]],
    [[{ logicalRole: "MEMORY_UNKNOWN", ordinal: 0 }]],
    [[{ logicalRole: "MEMORY_AGGREGATE", ordinal: 0 }]],
    [[
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 }
    ]]
  ])("rejects an invalid or unbounded retry sequence (%#)", (bindings) => {
    expect(validMemoryRetrievalExecutionSequence(bindings)).toBe(false);
  });

  it("keeps aggregation bindings separate from bounded targeted reranker ordinals", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_RERANK", ordinal: 4 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 0 }
    ], false, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 2 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 4 }
    ], false, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 4 }
    ], false, true)).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 0 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 2 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 4 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 6 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 8 },
      { logicalRole: "MEMORY_AGGREGATE", ordinal: 10 }
    ], false, true)).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      {
        logicalRole: "MEMORY_RERANK",
        ordinal: 1 + MEMORY_RERANK_AGGREGATION_MAX_BATCHES *
          MEMORY_RERANK_MAX_ATTEMPTS
      }
    ], false, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 5 }
    ])).toBe(false);
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
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "rerank_provider_request_failed",
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "OUTCOME_UNKNOWN"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "rerank_provider_http_error",
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "FAILED"
    }, retry])).toBe(false);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_reranker_transient_http_failure",
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "FAILED"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "rerank_response_invalid",
      logicalRole: "MEMORY_RERANK",
      ordinal: 2,
      state: "FAILED"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_output_invalid",
      logicalRole: "MEMORY_RERANK",
      ordinal: 4,
      state: "FAILED"
    }, {
      ...retry,
      ordinal: 5
    }])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_output_invalid",
      logicalRole: "MEMORY_RERANK",
      ordinal: 6,
      state: "FAILED"
    }, {
      ...retry,
      ordinal: 7
    }])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_output_invalid",
      logicalRole: "MEMORY_RERANK",
      ordinal: 8,
      state: "FAILED"
    }, {
      ...retry,
      ordinal: 9
    }])).toBe(true);
  });

  it("requires each aggregation map or reduce retry to follow its own invalid output", () => {
    const retry = {
      errorCode: null,
      logicalRole: "MEMORY_AGGREGATE",
      ordinal: 5,
      state: "SUCCEEDED"
    };
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_output_invalid",
      logicalRole: "MEMORY_AGGREGATE",
      ordinal: 4,
      state: "FAILED"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: null,
      logicalRole: "MEMORY_AGGREGATE",
      ordinal: 4,
      state: "SUCCEEDED"
    }, retry])).toBe(false);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_provider_failed",
      logicalRole: "MEMORY_AGGREGATE",
      ordinal: 8,
      state: "FAILED"
    }, {
      ...retry,
      ordinal: 9
    }])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_run_utility_outcome_unknown",
      logicalRole: "MEMORY_AGGREGATE",
      ordinal: 8,
      state: "OUTCOME_UNKNOWN"
    }, {
      ...retry,
      ordinal: 9
    }])).toBe(true);
  });

  it("requires a transport-uncertain query embedding before its bounded retry", () => {
    const retry = {
      errorCode: null,
      logicalRole: "MEMORY_QUERY_EMBED",
      ordinal: 2,
      state: "SUCCEEDED"
    };
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "embedding_provider_request_failed",
      logicalRole: "MEMORY_QUERY_EMBED",
      ordinal: 1,
      state: "OUTCOME_UNKNOWN"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_query_embedding_attempt_timed_out",
      logicalRole: "MEMORY_QUERY_EMBED",
      ordinal: 1,
      state: "OUTCOME_UNKNOWN"
    }, retry])).toBe(true);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "embedding_provider_request_failed",
      logicalRole: "MEMORY_QUERY_EMBED",
      ordinal: 1,
      state: "FAILED"
    }, retry])).toBe(false);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_query_embedding_output_invalid",
      logicalRole: "MEMORY_QUERY_EMBED",
      ordinal: 1,
      state: "FAILED"
    }, retry])).toBe(false);
    expect(validMemoryRerankRetrySettlement([{
      errorCode: "memory_query_embedding_transient_http_failure",
      logicalRole: "MEMORY_QUERY_EMBED",
      ordinal: 1,
      state: "FAILED"
    }, retry])).toBe(true);
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

  it("accepts the exact retry scope across the bounded retry chain", () => {
    expect(sameMemoryReadOnlyControlRetryScope(source, current)).toBe(true);
    expect(sameMemoryReadOnlyControlRetryScope(source, {
      ...current,
      attemptOrdinal: 2,
      id: "attempt-3"
    })).toBe(true);
    expect(sameMemoryReadOnlyControlRetryScope(current, {
      ...current,
      attemptOrdinal: 2,
      id: "attempt-3"
    })).toBe(true);
    expect(sameMemoryReadOnlyControlRetryScope(source, {
      ...current,
      attemptOrdinal: 3,
      id: "attempt-4"
    })).toBe(false);
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
