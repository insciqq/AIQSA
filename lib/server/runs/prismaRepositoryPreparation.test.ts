import { describe, expect, it, vi } from "vitest";
import {
  completePreparingRunAttemptWithClient,
  finalizePreparingRunWithClient,
  finalizeUnavailablePreparingRunAdmission,
  finalizeTemporaryPreparingRunAdmission,
  insertAcceptedWorkspaceRunBinding,
  memorySpeculativeQueryResolverInventoryDeclared,
  sameMemoryReadOnlyControlRetryScope,
  validMemoryRerankRetrySettlement,
  validMemoryRetrievalExecutionSequence
} from "./prismaRepositoryPreparation";
import {
  createMemoryPreparingBaseSnapshot,
  decodeMemoryPreparingSettingsSnapshot
} from "./preparingRun";
import {
  MEMORY_DEDICATED_RERANK_ROUTE_PIPELINE_VERSION,
  MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
  MEMORY_RERANK_MAX_ATTEMPTS
} from "../memory/retrieval/runUtilities";
import { MEMORY_CONTROL_SCREEN_VERSION } from "../memory/actions/controlScreenPolicy";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";

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

function ownerFirstTransactionClient() {
  const statements: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: Readonly<{ strings: readonly string[] }>) => {
      const statement = query.strings.join("");
      statements.push(statement);
      return statement.includes('FROM "User"') ? [{ id: "user-1" }] : [];
    })
  };
  const client = {
    $transaction: vi.fn(async (
      operation: (transaction: typeof tx) => Promise<unknown>
    ) => operation(tx))
  };
  return { client, statements };
}

describe("Memory preparing transaction lock order", () => {
  it("locks the owner before the run during retrieval completion", async () => {
    const { client, statements } = ownerFirstTransactionClient();

    await expect(completePreparingRunAttemptWithClient(client as never, {
      attemptId: "attempt-1",
      result: { budgetSnapshot: {}, outcome: "DISABLED" },
      runId: "run-1",
      userId: "user-1"
    })).resolves.toBe(false);

    expect(statements[0]).toContain('FROM "User"');
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[1]).toContain('FROM "ModelRun"');
  });

  it("locks the owner before the run during finalization", async () => {
    const { client, statements } = ownerFirstTransactionClient();

    await expect(finalizePreparingRunWithClient(client as never, {
      attemptId: "attempt-1",
      normalizedRequest: {} as never,
      providerRequestPreview: {},
      runId: "run-1",
      userId: "user-1"
    }, {})).resolves.toBe(false);

    expect(statements[0]).toContain('FROM "User"');
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[1]).toContain('FROM "ModelRun"');
  });
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

  it.each(["NORMAL", "EXCLUDED"] as const)(
    "moves any answer to a scheduled task's prompt in a %s chat to streaming and reports it, so no Memory attempt follows",
    async (chatMemoryMode) => {
      const update = vi.fn(async () => ({}));
      await expect(finalizeTemporaryPreparingRunAdmission({
        modelRun: { update }
      } as never, { ...input(chatMemoryMode), scheduledPrompt: true as const })).resolves.toEqual({
        assistantMessageId: "assistant-message-1",
        attemptId: "",
        chatMemoryMode,
        folderId: null,
        memoryGeneration: 0,
        memoryRevision: 0,
        runId: "run-1",
        scheduledPrompt: true,
        settingsSnapshot,
        userMessageId: "user-message-1"
      });
      expect(update).toHaveBeenCalledWith({
        data: { normalizedRequest: { privateMarker: "temporary-user-content" }, status: "streaming" },
        where: { id: "run-1" }
      });
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
  it("admits one qualified control screen before or without strict control", () => {
    const screen = { logicalRole: "MEMORY_CONTROL_SCREEN", ordinal: 0,
      pipelineVersion: MEMORY_CONTROL_SCREEN_VERSION };
    expect(validMemoryRetrievalExecutionSequence([screen])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([screen,
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 }])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([screen], true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([screen, screen])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([{ ...screen, ordinal: 1 }])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([{ ...screen,
      pipelineVersion: "unqualified" }])).toBe(false);
  });
  it("rejects bindings of the retired per-passage history relevance role", () => {
    expect(validMemoryRetrievalExecutionSequence([{ logicalRole: "MEMORY_HISTORY_RELEVANCE", ordinal: 1,
      pipelineVersion: "memory-history-relevance-v1" }])).toBe(false);
  });
  it("declares a cancelled resolver that missed the attachment boundary", () => {
    const budget = {
      queryResolverExecutionStrategy: "SPECULATIVE",
      queryResolverProviderCalls: 1,
      queryResolverState: "NOT_READY_AT_ATTACH"
    };
    const declared = memorySpeculativeQueryResolverInventoryDeclared(budget);

    expect(declared).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 }
    ], false, false, declared)).toBe(true);
    expect(memorySpeculativeQueryResolverInventoryDeclared({
      ...budget,
      queryResolverProviderCalls: 0
    })).toBe(false);
    expect(memorySpeculativeQueryResolverInventoryDeclared({
      ...budget,
      queryResolverState: "UNKNOWN_STATE"
    })).toBe(false);
  });

  it("allows only one fresh reranker retry after the primary attempt", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 },
      { logicalRole: "MEMORY_RERANK", ordinal: 4 }
    ])).toBe(false);
  });

  it("allows nine bounded reranker batches without a generative aggregation role", () => {
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 1 },
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 3 },
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

  it("accounts for one declared speculative resolver in the aggregation bound", () => {
    const maximumAggregationSequence = [
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_CONTROL", ordinal: 1 },
      ...Array.from(
        { length: 4 },
        (_, index) => ({ logicalRole: "MEMORY_QUERY_EMBED", ordinal: index + 1 })
      ),
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 },
      ...Array.from(
        {
          length: MEMORY_RERANK_AGGREGATION_MAX_BATCHES *
            MEMORY_RERANK_MAX_ATTEMPTS
        },
        (_, index) => ({ logicalRole: "MEMORY_RERANK", ordinal: index + 2 })
      )
    ];

    expect(validMemoryRetrievalExecutionSequence(
      maximumAggregationSequence,
      false,
      true,
      true
    )).toBe(true);
    expect(validMemoryRetrievalExecutionSequence(
      maximumAggregationSequence,
      false,
      true
    )).toBe(false);
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
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 },
      { logicalRole: "MEMORY_RERANK", ordinal: 2 },
      { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 2 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_QUERY_EMBED", ordinal: 4 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 1 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 }
    ], false, true)).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 }
    ], false, true, true)).toBe(true);
    expect(validMemoryRetrievalExecutionSequence([
      { logicalRole: "MEMORY_CONTROL", ordinal: 0 },
      { logicalRole: "MEMORY_QUERY_RESOLVE", ordinal: 0 }
    ], true, false, true)).toBe(true);
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

  it("rejects historical aggregation bindings from a new reader-first attempt", () => {
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
    ], false, true)).toBe(false);
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

describe("dedicated reranker preparation inventory", () => {
  function batch(route: number, index: number, state = "SUCCEEDED", errorCode: string | null = null) {
    return {
      errorCode,
      inputHash: (index + 1).toString(16).padStart(64, "0"),
      logicalRole: "MEMORY_RERANK",
      ordinal: 2 + route * MEMORY_RERANK_AGGREGATION_MAX_BATCHES + index,
      pipelineVersion: MEMORY_DEDICATED_RERANK_ROUTE_PIPELINE_VERSION,
      providerModelId: `reranker-${route}`,
      state
    };
  }

  it.each([[false, false], [false, true], [true, false]])(
    "accepts independent successful batches for profile=%s aggregation=%s",
    (profile, aggregation) => {
      const bindings = [batch(0, 0), batch(0, 1)];
      expect(validMemoryRetrievalExecutionSequence(bindings, profile, aggregation)).toBe(true);
      expect(validMemoryRerankRetrySettlement(bindings)).toBe(true);
    }
  );

  it("accepts a whole-pool fallback after one batch fails on each earlier model", () => {
    const bindings = [
      batch(0, 0), batch(0, 1, "FAILED", "memory_reranker_transient_http_failure"),
      batch(1, 0, "FAILED", "memory_reranker_model_unavailable"), batch(1, 1),
      batch(2, 0), batch(2, 1)
    ];
    expect(validMemoryRetrievalExecutionSequence(bindings)).toBe(true);
    expect(validMemoryRerankRetrySettlement(bindings)).toBe(true);
  });

  it("retains settled evidence when a later model becomes unavailable before binding every batch", () => {
    const bindings = [batch(0, 0), batch(0, 1, "OUTCOME_UNKNOWN", "rerank_request_timed_out"),
      batch(1, 1, "FAILED", "memory_reranker_runtime_unavailable")];
    expect(validMemoryRetrievalExecutionSequence(bindings)).toBe(true);
    expect(validMemoryRerankRetrySettlement(bindings)).toBe(true);
  });

  it.each([
    "success-only-fallback", "permanent-error", "cancelled-primary", "changed-batch", "same-model",
    "mixed-model", "missing-first-route", "mixed-protocol", "unidentified-input", "reused-batch-input", "skipped-route"
  ])("rejects an invalid dedicated route: %s", (variation) => {
    let bindings = [batch(0, 0), batch(0, 1, "FAILED", "memory_reranker_transient_http_failure"),
      batch(1, 0), batch(1, 1)];
    if (variation === "success-only-fallback") bindings[1] = batch(0, 1);
    if (variation === "permanent-error") bindings[1]!.errorCode = "rerank_provider_http_error";
    if (variation === "cancelled-primary") bindings[1]!.state = "CANCELLED";
    if (variation === "changed-batch") bindings[2]!.inputHash = "9".repeat(64);
    if (variation === "same-model") for (const item of bindings.slice(2)) item.providerModelId = "reranker-0";
    if (variation === "mixed-model") bindings[1]!.providerModelId = "unrelated-reranker";
    if (variation === "missing-first-route") bindings = bindings.slice(2);
    if (variation === "mixed-protocol") Object.assign(bindings[1]!, { pipelineVersion: "memory-multilingual-relevance-v31" });
    if (variation === "unidentified-input") bindings[2]!.inputHash = "";
    if (variation === "reused-batch-input") bindings[1]!.inputHash = bindings[0]!.inputHash;
    if (variation === "skipped-route") for (const item of bindings.slice(2)) item.ordinal += MEMORY_RERANK_AGGREGATION_MAX_BATCHES;
    expect(validMemoryRerankRetrySettlement(bindings)).toBe(false);
  });

  it("bounds ordinals and rejects duplicate positions or mixed protocols", () => {
    expect(validMemoryRetrievalExecutionSequence([batch(3, 0)], false, true)).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([batch(0, 0), batch(0, 0)])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      batch(0, 0), { logicalRole: "MEMORY_RERANK", ordinal: 3 }
    ])).toBe(false);
    expect(validMemoryRetrievalExecutionSequence([
      { ...batch(0, 0), logicalRole: "MEMORY_CONTROL", ordinal: 0 }
    ])).toBe(false);
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
  const switched = Object.freeze({ ...current, indexGenerationIdSnapshot: "generation-2",
    settingsSnapshot: { ...current.settingsSnapshot, activeIndexGenerationId: "generation-2" } });

  it("accepts the exact retry scope across the bounded retry chain", () => {
    expect(sameMemoryReadOnlyControlRetryScope(source, current)).toBe(true);
    expect(sameMemoryReadOnlyControlRetryScope(source, switched)).toBe(true);
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
    ["owner", { userId: "user-2" }],
    ["chat", { chatId: "chat-2" }],
    ["user message", { admittedUserMessageId: "user-message-2" }],
    ["assistant", { assistantIdSnapshot: "assistant-2" }],
    ["folder", { folderIdSnapshot: "folder-2" }],
    ["temporary chat", { chatMemoryModeSnapshot: "TEMPORARY" as const }],
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

  it.each([
    ["revision", { settingsRevision: 6 }],
    ["consent", { memoryConsentRevision: 3 }],
    ["egress", { acceptedUtilityEgressFingerprint: "c".repeat(64) }],
    ["policy", { acceptedUtilityPolicyVersion: "changed" }],
    ["pause", { useMemoryFacts: false }],
    ["history", { referenceChatHistory: false }],
    ["learning", { learnAutomatically: false }],
    ["decay", { decayEnabled: true }]
  ])("rejects %s changes even during an otherwise valid projection cutover", (_label, change) => {
    expect(sameMemoryReadOnlyControlRetryScope(source, { ...switched,
      settingsSnapshot: { ...switched.settingsSnapshot, ...change }
    })).toBe(false);
    expect(sameMemoryReadOnlyControlRetryScope({ ...source,
      settingsSnapshot: { ...source.settingsSnapshot, ...change }
    }, switched)).toBe(false);
  });
});

describe("Workspace switch write-back at admission", () => {
  const ids = { assistantMessageId: "assistant-message-1", runId: "run-1", userMessageId: "user-message-1" };
  const normalized = {
    enabled: true as const, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
    maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "fixture", messageManifestPath: "/workspace/inbox/messages/user-message-1/manifest.json",
    outputDirectory: workspaceRunOutputDirectory("run-1"), projectDirectory: "/workspace/project", runtimeVersion: "fixture",
    sessionId: "ws-1", syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300
  };
  const plan = {
    ...ids, chatId: "chat-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), normalized, policyRevision: 3,
    sandboxName: "sandbox-1", sessionId: "ws-1",
    toolDefinitions: [{ description: "Run a command", namespacedName: "workspace_exec" }] as never[]
  };
  const scheduledOccurrence = {
    occurrenceId: "occurrence-1", previousResult: null, relevantMcpServerIds: null, taskGeneration: 1, taskId: "task-1", taskRevision: 1
  };

  /** A transaction that admits the session, binding and secrets, recording chat switch writes. */
  function transaction() {
    const chatUpdates: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "user-1" }]),
      chat: {
        findUnique: vi.fn(async () => ({ projectId: null, userId: "user-1" })),
        findUniqueOrThrow: vi.fn(async () => ({ projectId: null, userId: "user-1" })),
        update: vi.fn(async (args: unknown) => { chatUpdates.push(args); return {}; })
      },
      modelRun: { count: vi.fn(async () => 0) },
      user: { update: vi.fn(async () => ({ workspaceBrowserSequence: BigInt(1) })) },
      workspacePolicy: { findUnique: vi.fn(async () => ({ enabled: true, version: 3 })) },
      workspaceRunBinding: { create: vi.fn(async () => ({})) },
      workspaceSecret: { findMany: vi.fn(async () => []) },
      workspaceSession: { create: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) }
    };
    return { chatUpdates, tx };
  }

  function admission(input: Readonly<{ scheduled: boolean; workspace: boolean }>) {
    return {
      admissionKind: "NORMAL_SEND", chatId: "chat-1", userId: "user-1", workspaceEnabled: input.workspace,
      normalizedRequest: input.workspace ? { workspace: normalized } : {},
      ...(input.workspace ? { workspaceAdmissionPlan: plan } : {}),
      ...(input.scheduled ? { scheduledOccurrence } : {})
    } as never;
  }

  it("lets an ordinary send write its Workspace choice back to the chat's switch", async () => {
    for (const workspace of [true, false]) {
      const { chatUpdates, tx } = transaction();
      await insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: false, workspace }), ids);
      expect(chatUpdates).toEqual([{ data: { workspaceEnabled: workspace }, where: { id: "chat-1" } }]);
    }
  });

  it("never lets a scheduled run change an existing chat's Workspace switch, on or off", async () => {
    for (const workspace of [true, false]) {
      const { chatUpdates, tx } = transaction();
      await insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: true, workspace }), ids);
      expect(chatUpdates).toEqual([]);
      // The run itself still gets its Workspace binding.
      expect(tx.workspaceRunBinding.create).toHaveBeenCalledTimes(workspace ? 1 : 0);
    }
  });
});
