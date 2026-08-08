import { describe, expect, it } from "vitest";

import {
  decodeCancelModelRunResponse,
  decodeGetModelRunResponse,
  type ModelRunResponseProjection
} from "./runs";

function requiredRunFields(): Record<string, unknown> {
  return {
    events: [],
    id: "run-1",
    inputTokens: 12,
    modelId: "gpt-5",
    provider: "openai",
    status: "complete",
    toolCalls: []
  };
}

const toolActivity = {
  argumentsPreview: { query: "memory" },
  callId: "call-1",
  capability: "mcp",
  credentialSources: ["personal"],
  durationMs: 42,
  errorMessage: null,
  externalAccountLabel: "Personal memory",
  ordinal: 0,
  resultPreview: { content: [{ text: "found", type: "text" }] },
  round: 1,
  serverName: "Mem0",
  status: "complete",
  toolName: "search"
};

describe("decodeCancelModelRunResponse", () => {
  it("distinguishes a cancellation winner from the current non-cancelable state", () => {
    expect(
      decodeCancelModelRunResponse({
        run: {
          id: "run-1",
          providerCancelPreview: { status: "cancelled" },
          providerResponseId: "response-1",
          status: "cancelled"
        }
      })
    ).toEqual({
      kind: "cancelled",
      run: {
        id: "run-1",
        status: "cancelled"
      }
    });
    expect(
      decodeCancelModelRunResponse({
        error: "model_run_not_cancelable",
        requestId: "request-1",
        run: {
          id: "run-1",
          status: "complete"
        }
      })
    ).toEqual({
      kind: "not_cancelled",
      run: {
        id: "run-1",
        status: "complete"
      }
    });
    expect(
      decodeCancelModelRunResponse({
        error: "model_run_not_cancelable",
        run: {
          id: "run-1",
          status: "cancelled"
        }
      })
    ).toEqual({
      kind: "not_cancelled",
      run: {
        id: "run-1",
        status: "cancelled"
      }
    });
  });

  it.each([
    null,
    {},
    { run: null },
    { run: { id: "", status: "cancelled" } },
    { run: { id: "run-1", status: "complete" } },
    { run: { id: "run-1", status: "completed" } },
    {
      error: "model_run_not_found",
      run: { id: "run-1", status: "complete" }
    },
    {
      error: "model_run_not_cancelable",
      run: { id: "run-1", status: "completed" }
    }
  ])("rejects malformed or ambiguous cancellation response %#", (value) => {
    expect(decodeCancelModelRunResponse(value)).toBeNull();
  });
});

describe("decodeGetModelRunResponse", () => {
  it("decodes a complete model-run response", () => {
    const payload = { delta: "answer" };
    const errorPayload = { code: "provider_warning", nested: { retryable: false } };
    const searchRun = { artifacts: [{ url: "https://example.test" }], strategyId: "native" };

    expect(
      decodeGetModelRunResponse({
        run: {
          assistant: { assistantId: "assistant-1", name: "Docs helper", revisionNumber: 2 },
          cachedInputTokens: 3,
          cacheWriteInputTokens: 4,
          errorPayload,
          estimatedCostMicros: 125,
          events: [{ eventType: "token", payload, sequence: 7 }],
          id: "run-1",
          inputTokens: 12,
          modelId: "gpt-5",
          outputTokens: 8,
          provider: "openai",
          reasoningTokens: 2,
          searchRuns: [searchRun],
          status: "complete",
          toolCalls: [],
          totalTokens: 20
        }
      })
    ).toEqual({
      assistant: { assistantId: "assistant-1", name: "Docs helper", revisionNumber: 2 },
      cachedInputTokens: 3,
      cacheWriteInputTokens: 4,
      errorPayload,
      estimatedCostMicros: 125,
      events: [{ eventType: "token", payload, sequence: 7 }],
      id: "run-1",
      inputTokens: 12,
      knowledgeBindings: [],
      knowledgePlan: { baseIds: [] },
      knowledgeRuns: [],
      modelId: "gpt-5",
      outputTokens: 8,
      provider: "openai",
      reasoningTokens: 2,
      searchRuns: [searchRun],
      status: "complete",
      toolCalls: [],
      totalTokens: 20
    });
  });

  it("decodes exact ordered Knowledge evidence and rejects plan/binding drift", () => {
    const binding = {
      baseContentRevision: 7,
      embeddingConnectionId: "embedding-connection-1",
      embeddingCredentialSource: "group",
      embeddingProviderModelId: "embedding-model-1",
      indexedContentRevision: 6,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      targetDimension: 1_536,
      vectorSpaceFingerprint: "a".repeat(64)
    };
    const run = {
      ...requiredRunFields(),
      knowledgeBindings: [binding],
      knowledgePlan: { baseIds: ["base-1"] }
    };

    expect(decodeGetModelRunResponse({ run })).toMatchObject({
      knowledgeBindings: [binding],
      knowledgePlan: { baseIds: ["base-1"] }
    });
    for (const malformed of [
      { ...run, knowledgeBindings: [] },
      { ...run, knowledgeBindings: [{ ...binding, knowledgeBaseId: "base-2" }] },
      { ...run, knowledgeBindings: [{ ...binding, ordinal: 1 }] },
      { ...run, knowledgeBindings: [{ ...binding, targetDimension: 768 }] },
      { ...run, knowledgeBindings: [{ ...binding, vectorSpaceFingerprint: "not-a-pin" }] },
      { ...run, knowledgePlan: { baseIds: ["base-2"] } }
    ]) {
      expect(decodeGetModelRunResponse({ run: malformed })).toBeNull();
    }
  });

  it("decodes bounded ordered Knowledge retrieval receipts", () => {
    const receipt = {
      baseEvidence: [{
        baseContentRevision: 2,
        baseName: "Policies",
        candidateCount: 0,
        indexedContentRevision: 2,
        knowledgeBaseId: "base-1",
        ordinal: 0,
        state: "empty"
      }],
      candidateCount: 0,
      candidateLimit: 40,
      createdAt: "2026-08-08T12:00:00.000Z",
      durationMs: 9,
      embeddingUsage: [{ inputTokens: 2, totalTokens: 2 }],
      failureCode: null,
      fusion: "rrf_k60",
      id: "knowledge-run-1",
      invocationOrdinal: 1,
      modelRunToolCallId: "tool-call-row-1",
      outcome: "base_empty",
      postRerankOrder: null,
      preRerankOrder: null,
      providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
      query: "retained contract",
      rerankerBinding: null,
      resultLimit: 8,
      results: [],
      threshold: 0.01
    };
    const run = { ...requiredRunFields(), knowledgeRuns: [receipt] };

    expect(decodeGetModelRunResponse({ run })?.knowledgeRuns).toEqual([receipt]);
    for (const malformedReceipt of [
      { ...receipt, invocationOrdinal: 0 },
      { ...receipt, candidateCount: 1 },
      { ...receipt, candidateLimit: 7 },
      { ...receipt, embeddingUsage: [] },
      { ...receipt, outcome: "zero_above_threshold" },
      { ...receipt, preRerankOrder: ["K1.1"] },
      {
        ...receipt,
        baseEvidence: [{ ...receipt.baseEvidence[0], state: "ready" }]
      }
    ]) {
      expect(decodeGetModelRunResponse({
        run: { ...run, knowledgeRuns: [malformedReceipt] }
      })).toBeNull();
    }
    expect(decodeGetModelRunResponse({
      run: {
        ...run,
        knowledgeRuns: [receipt, { ...receipt, id: "knowledge-run-2" }]
      }
    })).toBeNull();
    expect(decodeGetModelRunResponse({
      run: {
        ...run,
        knowledgeRuns: [{ ...receipt, invocationOrdinal: 2 }]
      }
    })).toBeNull();
    expect(decodeGetModelRunResponse({
      run: { ...run, knowledgeRuns: Array.from({ length: 4 }, () => receipt) }
    })).toBeNull();
  });

  it("rejects a malformed assistant provenance", () => {
    for (const assistant of [
      { assistantId: "", name: "Docs helper", revisionNumber: 2 },
      { assistantId: "assistant-1", name: "Docs helper", revisionNumber: 0 },
      { assistantId: "assistant-1", revisionNumber: 2 },
      "assistant-1"
    ]) {
      expect(
        decodeGetModelRunResponse({ run: { ...requiredRunFields(), assistant } })
      ).toBeNull();
    }
  });

  it("applies usage, cost, and search defaults", () => {
    expect(
      decodeGetModelRunResponse({
        run: {
          ...requiredRunFields(),
          cachedInputTokens: Number.NaN,
          cacheWriteInputTokens: "4",
          estimatedCostMicros: 0,
          outputTokens: Number.POSITIVE_INFINITY,
          reasoningTokens: null,
          searchRuns: null,
          totalTokens: undefined
        }
      })
    ).toEqual({
      assistant: null,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      errorPayload: undefined,
      estimatedCostMicros: null,
      events: [],
      id: "run-1",
      inputTokens: 12,
      knowledgeBindings: [],
      knowledgePlan: { baseIds: [] },
      knowledgeRuns: [],
      modelId: "gpt-5",
      outputTokens: 0,
      provider: "openai",
      reasoningTokens: 0,
      searchRuns: [],
      status: "complete",
      toolCalls: [],
      totalTokens: 12
    });
  });

  it("decodes bounded tool activity and rejects malformed entries", () => {
    expect(
      decodeGetModelRunResponse({
        run: { ...requiredRunFields(), toolCalls: [toolActivity] }
      })?.toolCalls
    ).toEqual([toolActivity]);

    expect(
      decodeGetModelRunResponse({
        run: {
          ...requiredRunFields(),
          toolCalls: [{ ...toolActivity, serverName: null }]
        }
      })
    ).toBeNull();
    expect(
      decodeGetModelRunResponse({
        run: {
          ...requiredRunFields(),
          toolCalls: [{ ...toolActivity, resultPreview: "x".repeat(9_000) }]
        }
      })
    ).toBeNull();
  });

  it("decodes nested Search execution evidence and rejects malformed or oversized traces", () => {
    const searchExecution = {
      displayName: "Web Search · Sol",
      durationMs: 145_800,
      modelId: "gpt-5.6-sol",
      optionId: "web-search-sol",
      provider: "openai-compatible",
      providerOperations: [{
        id: "ws-1",
        kind: "search",
        ordinal: 0,
        pattern: null,
        queries: ["Moscow latest news"],
        status: "complete",
        url: null
      }],
      providerOperationsTruncated: false,
      query: "latest news in Moscow",
      sourceCount: 4,
      status: "complete",
      warning: null
    };
    const searchToolActivity = {
      ...toolActivity,
      capability: "web_search",
      searchExecutions: [searchExecution],
      serverName: null,
      toolName: "search_selected_engines"
    };

    expect(
      decodeGetModelRunResponse({
        run: { ...requiredRunFields(), toolCalls: [searchToolActivity] }
      })?.toolCalls
    ).toEqual([searchToolActivity]);

    expect(
      decodeGetModelRunResponse({
        run: {
          ...requiredRunFields(),
          toolCalls: [{
            ...searchToolActivity,
            searchExecutions: [{
              ...searchExecution,
              providerOperations: Array.from({ length: 33 }, (_, ordinal) => ({
                ...searchExecution.providerOperations[0],
                id: `ws-${ordinal}`,
                ordinal
              }))
            }]
          }]
        }
      })
    ).toBeNull();
    expect(
      decodeGetModelRunResponse({
        run: {
          ...requiredRunFields(),
          toolCalls: [{
            ...searchToolActivity,
            searchExecutions: [{
              ...searchExecution,
              providerOperations: [{
                ...searchExecution.providerOperations[0],
                queries: ["x".repeat(2_001)]
              }]
            }]
          }]
        }
      })
    ).toBeNull();
  });

  it("ignores additive envelope and run fields while preserving opaque entries", () => {
    const opaquePayload = Symbol("payload");
    const opaqueError = new Date("2026-07-13T00:00:00.000Z");
    const opaqueSearchEntry = new Map([["query", "contract"]]);
    const response = {
      envelopeVersion: 2,
      run: {
        ...requiredRunFields(),
        assistantMessageId: "message-1",
        errorPayload: opaqueError,
        events: [
          {
            createdAt: "2026-07-13T00:00:00.000Z",
            eventType: "artifact",
            payload: opaquePayload,
            sequence: 1
          }
        ],
        finalProviderResponsePreview: { finishReason: "stop" },
        searchRuns: [opaqueSearchEntry]
      }
    };

    const decoded = decodeGetModelRunResponse(response);

    expect(decoded?.errorPayload).toBe(opaqueError);
    expect(decoded?.events[0]?.payload).toBe(opaquePayload);
    expect(decoded?.searchRuns[0]).toBe(opaqueSearchEntry);
    expect(decoded).not.toHaveProperty("assistantMessageId");
    expect(decoded?.events[0]).not.toHaveProperty("createdAt");

    const runWithInspectionFields = {
      ...decoded!,
      assistantMessageId: "message-1",
      normalizedRequest: { stream: true }
    };
    const projection: ModelRunResponseProjection = runWithInspectionFields;
    expect(projection.id).toBe("run-1");
  });

  it.each([
    null,
    {},
    { run: null },
    { run: { ...requiredRunFields(), events: null } },
    { run: { ...requiredRunFields(), id: "" } },
    { run: { ...requiredRunFields(), modelId: "" } },
    { run: { ...requiredRunFields(), provider: "" } },
    { run: { ...requiredRunFields(), status: "" } },
    { run: { ...requiredRunFields(), status: "completed" } },
    { run: { ...requiredRunFields(), inputTokens: Number.NaN } },
    { run: { ...requiredRunFields(), toolCalls: null } },
    { run: { ...requiredRunFields(), events: [null] } },
    { run: { ...requiredRunFields(), events: [{ eventType: "", sequence: 1 }] } },
    { run: { ...requiredRunFields(), events: [{ eventType: "token", sequence: "1" }] } },
    {
      run: {
        ...requiredRunFields(),
        events: [
          { eventType: "token", payload: "ok", sequence: 1 },
          { eventType: "done", sequence: Number.POSITIVE_INFINITY }
        ]
      }
    }
  ])("rejects malformed model-run response %#", (value) => {
    expect(decodeGetModelRunResponse(value)).toBeNull();
  });
});
