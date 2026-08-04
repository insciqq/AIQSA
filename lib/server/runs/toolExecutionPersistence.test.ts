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
  searchExecutionsFromToolResult,
  searchToolResultContent,
  type SearchExecutionEvidence
} from "../search/toolResult";
import { mcpToolExecutionResult } from "../mcp/toolExecutor";

const call = { id: "call-1", name: "search_via_perplexity" };

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
      durationMs: 25,
      findings,
      invocationId: "call-1:source-1",
      modelId: "search-model",
      optionId: "source-1",
      provider: "openai",
      providerOperationsTruncated: false,
      providerUsage: { webSearchRequests: 2 },
      query: "current facts",
      requestPreview: { queryCharacters: 13 },
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
        finalProviderResponsePreview: { searchExecutions: [execution] },
        requestPreview: {},
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
        finalProviderResponsePreview: {
          searchExecutions: [{
            ...execution,
            usage: { ...execution.usage, inputTokens: "not-a-number" }
          }]
        },
        requestPreview: {},
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: execution.usage
    }, toolLoopPersistenceLimits.resultBytes);
    if (!malformedUsage) throw new Error("expected malformed usage fixture snapshot");
    expect(parsePersistedToolExecutionResult(call, malformedUsage)).toBeNull();
    const malformedProviderUsage = snapshotToolLoopJson({
      callId: call.id,
      content: [{
        type: "json",
        value: { aiqsaType: "search_result", version: SEARCH_TOOL_RESULT_VERSION }
      }],
      name: call.name,
      rawPreview: {
        finalProviderResponsePreview: {
          searchExecutions: [{
            ...execution,
            providerUsage: { webSearchRequests: 101 }
          }]
        },
        requestPreview: {},
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: execution.usage
    }, toolLoopPersistenceLimits.resultBytes);
    if (!malformedProviderUsage) {
      throw new Error("expected malformed provider usage fixture snapshot");
    }
    expect(parsePersistedToolExecutionResult(call, malformedProviderUsage)).toBeNull();
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
        finalProviderResponsePreview: { searchExecutions: [] },
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete"
    }, 32_000)).toBeNull();
    expect(parsePersistedToolExecutionResult(call, {
      callId: call.id,
      content: [{ type: "json", value: { aiqsaType: "search_result", version: 1 } }],
      name: call.name,
      rawPreview: {
        finalProviderResponsePreview: { searchExecutions: [] },
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete"
    })).toBeNull();
  });

  it("keeps an unversioned pre-canonical Search execution within the old result bound readable", () => {
    const findings = "l".repeat(60 * 1_024);
    const execution: SearchExecutionEvidence = {
      displayName: "Legacy Search",
      durationMs: 10,
      findings,
      invocationId: "legacy-call:source-1",
      modelId: "legacy-search-model",
      optionId: "legacy-source",
      provider: "openrouter",
      providerOperationsTruncated: false,
      query: "legacy query",
      requestPreview: {},
      revisionId: "legacy-revision",
      sources: [],
      status: "complete",
      usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5 }
    };
    const snapshot = snapshotToolLoopJson({
      callId: call.id,
      content: [{ text: findings, type: "text" }],
      name: call.name,
      rawPreview: { finalProviderResponsePreview: { searchExecutions: [execution] } },
      status: "complete",
      usage: execution.usage
    }, toolLoopPersistenceLimits.resultBytes);
    if (!snapshot) throw new Error("expected legacy Search snapshot");

    const parsed = parsePersistedToolExecutionResult(call, snapshot);
    if (!parsed) throw new Error("expected readable legacy Search result");
    expect(searchExecutionsFromToolResult(parsed)).toEqual([execution]);
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
