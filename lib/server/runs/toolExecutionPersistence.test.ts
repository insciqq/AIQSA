import { describe, expect, it } from "vitest";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "./toolExecutionPersistence";
import {
  snapshotToolLoopJson,
  toolLoopPersistenceLimits
} from "./toolLoopPersistence";
import {
  SEARCH_TOOL_RESULT_VERSION,
  searchToolResultContent,
  type SearchExecutionEvidence
} from "../search/toolResult";
import { mcpToolExecutionResult } from "../mcp/toolExecutor";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence
} from "../knowledge/retrievalTypes";
import {
  knowledgeToolResultContent,
  knowledgeToolResultText
} from "../knowledge/toolResult";

const call = { id: "call-1", name: "search_engine_1" };

describe("persisted tool execution result codec", () => {
  it("round-trips bounded search evidence and usage", () => {
    const result = {
      artifacts: [{
        data: { artifactType: "search" as const, payload: { query: "current news" } },
        type: "artifact" as const
      }],
      callId: call.id,
      content: [{ text: "result", type: "text" as const }],
      name: call.name,
      rawPreview: { providerResponseId: "search-response-1", requestPreview: { query: "current news" } },
      status: "complete" as const,
      usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 0, totalTokens: 7 }
    };

    const snapshot = snapshotToolExecutionResult(result, 32_000);

    expect(snapshot).not.toBeNull();
    expect(parsePersistedToolExecutionResult(call, snapshot)).toEqual(result);
  });

  it("rejects mismatched identity, malformed evidence, and oversized results", () => {
    expect(parsePersistedToolExecutionResult(call, {
      callId: "other-call",
      content: [{ text: "result", type: "text" }],
      name: call.name,
      status: "complete"
    })).toBeNull();
    expect(parsePersistedToolExecutionResult(call, {
      artifacts: [{ data: { artifactType: "unknown", payload: {} }, type: "artifact" }],
      callId: call.id,
      content: [{ text: "result", type: "text" }],
      name: call.name,
      status: "complete"
    })).toBeNull();
    expect(snapshotToolExecutionResult({
      callId: call.id,
      content: [{ text: "x".repeat(100), type: "text" }],
      name: call.name,
      status: "complete"
    }, 32)).toBeNull();
  });

  it("persists canonical Search findings once and rehydrates provider-facing content", () => {
    const findings = "canonical grounded findings ".repeat(200).trim();
    const execution: SearchExecutionEvidence = {
      displayName: "Primary Search",
      findings,
      invocationId: "call-1:source-1",
      modelId: "search-model",
      optionId: "source-1",
      provider: "openai",
      revisionId: "revision-1",
      sources: [{ rank: 1, title: "Source", url: "https://example.com/source" }],
      status: "complete",
      usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 0, totalTokens: 7 }
    };
    const result = {
      callId: call.id,
      content: searchToolResultContent([execution]),
      name: call.name,
      rawPreview: {
        searchExecutions: [execution],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete" as const,
      usage: execution.usage
    };

    const snapshot = snapshotToolExecutionResult(
      result,
      toolLoopPersistenceLimits.resultBytes
    );
    if (!snapshot) throw new Error("expected canonical Search snapshot");
    const serialized = JSON.stringify(snapshot);

    expect(serialized.split(findings)).toHaveLength(2);
    expect(serialized).toContain('"aiqsaType":"search_result"');
    expect(serialized).not.toContain("Search source ");
    expect(parsePersistedToolExecutionResult(call, snapshot)).toEqual(result);
    const malformedUsage = snapshotToolLoopJson({
      callId: call.id,
      content: [{
        type: "json",
        value: { aiqsaType: "search_result", version: SEARCH_TOOL_RESULT_VERSION }
      }],
      name: call.name,
      rawPreview: {
        searchExecutions: [{
          ...execution,
          usage: { ...execution.usage, inputTokens: "not-a-number" }
        }],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: execution.usage
    }, toolLoopPersistenceLimits.resultBytes);
    if (!malformedUsage) throw new Error("expected malformed usage fixture snapshot");
    expect(parsePersistedToolExecutionResult(call, malformedUsage)).toBeNull();
    const presentationTrace = snapshotToolLoopJson({
      callId: call.id,
      content: [{
        type: "json",
        value: { aiqsaType: "search_result", version: SEARCH_TOOL_RESULT_VERSION }
      }],
      name: call.name,
      rawPreview: {
        searchExecutions: [{ ...execution, requestPreview: {} }],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: execution.usage
    }, toolLoopPersistenceLimits.resultBytes);
    if (!presentationTrace) {
      throw new Error("expected presentation trace fixture snapshot");
    }
    expect(parsePersistedToolExecutionResult(call, presentationTrace)).toBeNull();
  });

  it("round-trips a durable Knowledge search outage with error status", () => {
    const draft: KnowledgeRetrievalEvidence = {
      bases: [],
      candidateCount: 0,
      candidateLimit: 64,
      durationMs: 3,
      embeddingExecutions: [],
      failureCode: "knowledge_search_backend_unavailable",
      fusion: "weighted_rrf_v2",
      invocationOrdinal: 1,
      operation: "automatic_search",
      outcome: "search_unavailable",
      providerText: "pending",
      query: "knowledge_search_unavailable",
      resultLimit: 16,
      results: [],
      version: KNOWLEDGE_RESULT_VERSION
    };
    const evidence = { ...draft, providerText: knowledgeToolResultText(draft) };
    const knowledgeCall = { id: "knowledge-call-1", name: "search_knowledge" };
    const result = {
      callId: knowledgeCall.id,
      content: knowledgeToolResultContent(evidence),
      name: knowledgeCall.name,
      rawPreview: {
        knowledgeResultVersion: evidence.version,
        knowledgeRetrieval: evidence,
        providerCall: true
      },
      status: "error" as const,
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    };

    const snapshot = snapshotToolExecutionResult(
      result,
      toolLoopPersistenceLimits.resultBytes
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      content: [{
        type: "json",
        value: { aiqsaType: "knowledge_result", version: KNOWLEDGE_RESULT_VERSION }
      }],
      status: "error"
    });
    expect(parsePersistedToolExecutionResult(knowledgeCall, snapshot)).toEqual(result);
  });

  it("enforces the complete serialized result boundary one byte below, at, and above", () => {
    const resultAtBytes = (targetBytes: number) => {
      const base = {
        callId: call.id,
        content: [{ text: "", type: "text" as const }],
        name: call.name,
        status: "complete" as const
      };
      const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
      return {
        ...base,
        content: [{ text: "x".repeat(targetBytes - overhead), type: "text" as const }]
      };
    };
    const limit = toolLoopPersistenceLimits.resultBytes;
    const below = resultAtBytes(limit - 1);
    const at = resultAtBytes(limit);
    const above = resultAtBytes(limit + 1);

    expect(Buffer.byteLength(JSON.stringify(below), "utf8")).toBe(limit - 1);
    expect(Buffer.byteLength(JSON.stringify(at), "utf8")).toBe(limit);
    expect(Buffer.byteLength(JSON.stringify(above), "utf8")).toBe(limit + 1);
    expect(snapshotToolExecutionResult(below, limit)).not.toBeNull();
    expect(snapshotToolExecutionResult(at, limit)).not.toBeNull();
    expect(snapshotToolExecutionResult(above, limit)).toBeNull();
  });

  it("rejects a forged or malformed canonical Search marker", () => {
    expect(snapshotToolExecutionResult({
      callId: call.id,
      content: [{ text: "unrelated text", type: "text" }],
      name: call.name,
      rawPreview: {
        searchExecutions: [],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete"
    }, 32_000)).toBeNull();
    expect(parsePersistedToolExecutionResult(call, {
      callId: call.id,
      content: [{ type: "json", value: { aiqsaType: "search_result", version: 1 } }],
      name: call.name,
      rawPreview: {
        searchExecutions: [],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete"
    })).toBeNull();
  });

  it("does not confuse marker-shaped MCP structured output with a Search checkpoint", () => {
    const result = mcpToolExecutionResult({
      arguments: {},
      id: call.id,
      name: call.name
    }, {
      isError: false,
      structuredContent: { aiqsaType: "search_result", version: 1 },
      text: [],
      unsupportedContentTypes: []
    });

    const snapshot = snapshotToolExecutionResult(result, 32_000);
    expect(snapshot).not.toBeNull();
    expect(parsePersistedToolExecutionResult(call, snapshot)).toEqual(result);
  });
});
