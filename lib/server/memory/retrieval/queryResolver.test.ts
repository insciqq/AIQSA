import { describe, expect, it, vi } from "vitest";
import { MEMORY_QUERY_RESOLUTION_NAME } from "../../../contracts/memoryQueryResolution";
import type { MemoryLearningProviderResult } from "../learning/providerRuntime";
import {
  createMemoryQueryResolverService,
  MEMORY_QUERY_RESOLVER_MAX_SOURCES,
  MEMORY_QUERY_RESOLVER_MAX_TOTAL_CHARACTERS,
  MEMORY_QUERY_RESOLVER_PIPELINE_VERSION,
  MEMORY_QUERY_RESOLVER_VERSIONS,
  validateMemoryQueryResolution,
  type MemoryQueryResolverSource
} from "./queryResolver";

const query = "Can you suggest activities for my commute?";
const testimony =
  "I've listened to true crime and self-improvement during my commute, but I want to branch out into other genres.";
const sources: readonly MemoryQueryResolverSource[] = Object.freeze([{
  handle: "R1",
  itemKey: null,
  sourceType: "CURRENT_QUERY",
  userTexts: Object.freeze([query])
}, {
  handle: "R2",
  itemKey: "RECALL_ROUND:round-1",
  sourceType: "MEMORY_EVIDENCE",
  userTexts: Object.freeze([testimony])
}]);

const resolved = Object.freeze({
  constraints: [{
    basisOccurrenceIndex: 0,
    basisQuote: testimony,
    kind: "AVOID" as const,
    sourceHandle: "R2",
    sourceTextIndex: 0,
    targetOccurrenceIndex: 0,
    targetQuote: "true crime"
  }, {
    basisOccurrenceIndex: 0,
    basisQuote: testimony,
    kind: "PREFER" as const,
    sourceHandle: "R2",
    sourceTextIndex: 0,
    targetOccurrenceIndex: 0,
    targetQuote: "branch out into other genres"
  }],
  status: "RESOLVED" as const
});

function providerResult(
  argumentsValue: Record<string, unknown>
): MemoryLearningProviderResult {
  return {
    providerResponseId: "resolver-response-1",
    toolCalls: [{
      arguments: argumentsValue,
      id: "resolver-call-1",
      name: MEMORY_QUERY_RESOLUTION_NAME
    }],
    usage: {
      cachedInputTokens: 0,
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 0,
      totalTokens: 130
    }
  };
}

describe("query-scoped Memory resolver", () => {
  it("accepts only exact nested direct-user evidence", () => {
    expect(validateMemoryQueryResolution(resolved, sources)).toEqual([{
      itemKey: "RECALL_ROUND:round-1",
      kind: "AVOID",
      sourceType: "MEMORY_EVIDENCE",
      targetQuote: "true crime"
    }, {
      itemKey: "RECALL_ROUND:round-1",
      kind: "PREFER",
      sourceType: "MEMORY_EVIDENCE",
      targetQuote: "branch out into other genres"
    }]);
    expect(validateMemoryQueryResolution({
      ...resolved,
      constraints: [{
        ...resolved.constraints[0]!,
        basisQuote: "self-improvement during my commute"
      }]
    }, sources)).toBeNull();
  });

  it("rejects contradictory kinds for the same exact target", () => {
    expect(validateMemoryQueryResolution({
      constraints: [
        resolved.constraints[0]!,
        { ...resolved.constraints[0]!, kind: "PREFER" }
      ],
      status: "RESOLVED"
    }, sources)).toBeNull();
  });

  it("uses the governed strict role and commits only the validated result", async () => {
    const bind = vi.fn(async () => ({ id: "resolver-binding" }));
    const settle = vi.fn(async () => undefined);
    const withAuthorizedResultCommit = vi.fn(async (
      _userId: string,
      _input: unknown,
      apply: () => Promise<unknown>
    ) => apply());
    let serializedRequest = "";
    const run = vi.fn(async (_evidence, request) => {
      serializedRequest = JSON.stringify(request);
      return providerResult(resolved);
    });
    const service = createMemoryQueryResolverService({
      execution: {
        admission: {
          bind,
          start: vi.fn(async () => ({
            bindingId: "resolver-binding",
            snapshot: {
              logicalRole: "MEMORY_QUERY_RESOLVE",
              providerExecutionSnapshot: {
                connectionId: "connection-1",
                credentialId: "credential-1",
                credentialVersionId: "credential-version-1",
                providerModelId: "model-1"
              },
              requiresStrictStructuredOutput: true
            }
          }))
        },
        lifecycle: { settle, withAuthorizedResultCommit }
      } as never,
      provider: { run }
    });

    await expect(service.resolve({
      attemptId: "attempt-1",
      query,
      signal: new AbortController().signal,
      sources,
      userId: "user-1"
    })).resolves.toMatchObject({
      bindingId: "resolver-binding",
      constraints: [
        { kind: "AVOID", targetQuote: "true crime" },
        { kind: "PREFER", targetQuote: "branch out into other genres" }
      ],
      status: "READY"
    });

    expect(MEMORY_QUERY_RESOLVER_PIPELINE_VERSION).toBe("memory-query-resolver-v3");
    expect(MEMORY_QUERY_RESOLVER_MAX_SOURCES).toBe(12);
    expect(MEMORY_QUERY_RESOLVER_MAX_TOTAL_CHARACTERS).toBe(16_000);
    expect(MEMORY_QUERY_RESOLVER_VERSIONS).toMatchObject({
      policyVersion: "memory-query-resolver-policy-v3",
      promptVersion: "memory-query-resolver-prompt-v2",
      schemaVersion: "memory-query-resolution-v1"
    });
    expect(bind).toHaveBeenCalledWith("user-1", expect.objectContaining({
      ordinal: 0,
      role: "MEMORY_QUERY_RESOLVE"
    }));
    expect(serializedRequest).toContain(testimony);
    expect(serializedRequest).toContain("one AVOID constraint for each separable");
    expect(serializedRequest).not.toContain("Assistant:");
    expect(settle).toHaveBeenCalledWith("user-1", "resolver-binding",
      expect.objectContaining({ state: "SUCCEEDED" }));
    expect(withAuthorizedResultCommit).toHaveBeenCalledOnce();
  });

  it("fails open to the ordinary reader path on invalid provider output", async () => {
    const settle = vi.fn(async () => undefined);
    const service = createMemoryQueryResolverService({
      execution: {
        admission: {
          bind: vi.fn(async () => ({ id: "resolver-binding" })),
          start: vi.fn(async () => ({
            bindingId: "resolver-binding",
            snapshot: {
              logicalRole: "MEMORY_QUERY_RESOLVE",
              providerExecutionSnapshot: {
                connectionId: "connection-1",
                credentialId: "credential-1",
                credentialVersionId: "credential-version-1",
                providerModelId: "model-1"
              },
              requiresStrictStructuredOutput: true
            }
          }))
        },
        lifecycle: {
          settle,
          withAuthorizedResultCommit: vi.fn()
        }
      } as never,
      provider: { run: vi.fn(async () => providerResult({
        constraints: [{
          ...resolved.constraints[0],
          targetQuote: "a topic the user never named"
        }],
        status: "RESOLVED"
      })) }
    });

    await expect(service.resolve({
      attemptId: "attempt-1",
      query,
      signal: new AbortController().signal,
      sources,
      userId: "user-1"
    })).resolves.toMatchObject({
      reason: "memory_query_resolution_invalid",
      status: "UNAVAILABLE"
    });
    expect(settle).toHaveBeenCalledWith("user-1", "resolver-binding",
      expect.objectContaining({ state: "FAILED" }));
  });

  it("rejects a current-query source that does not exactly match the request", async () => {
    const bind = vi.fn();
    const run = vi.fn();
    const service = createMemoryQueryResolverService({
      execution: {
        admission: { bind },
        lifecycle: {}
      } as never,
      provider: { run }
    });

    await expect(service.resolve({
      attemptId: "attempt-1",
      query: `${query} Please make it brief.`,
      signal: new AbortController().signal,
      sources,
      userId: "user-1"
    })).resolves.toEqual({
      reason: "memory_query_resolution_input_blocked",
      status: "UNAVAILABLE"
    });
    expect(bind).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("settles cancellation promptly and ignores a late provider result", async () => {
    const settle = vi.fn(async () => undefined);
    const withAuthorizedResultCommit = vi.fn();
    let releaseProvider!: (value: MemoryLearningProviderResult) => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerPending = new Promise<MemoryLearningProviderResult>((resolve) => {
      releaseProvider = resolve;
    });
    const service = createMemoryQueryResolverService({
      execution: {
        admission: {
          bind: vi.fn(async () => ({ id: "resolver-binding" })),
          start: vi.fn(async () => ({
            bindingId: "resolver-binding",
            snapshot: {
              logicalRole: "MEMORY_QUERY_RESOLVE",
              providerExecutionSnapshot: {
                connectionId: "connection-1",
                credentialId: "credential-1",
                credentialVersionId: "credential-version-1",
                providerModelId: "model-1"
              },
              requiresStrictStructuredOutput: true
            }
          }))
        },
        lifecycle: { settle, withAuthorizedResultCommit }
      } as never,
      provider: {
        run: vi.fn(() => {
          markProviderStarted();
          return providerPending;
        })
      }
    });
    const controller = new AbortController();
    const resolving = service.resolve({
      attemptId: "attempt-1",
      query,
      signal: controller.signal,
      sources,
      userId: "user-1"
    });
    await providerStarted;
    controller.abort(new DOMException("deadline", "AbortError"));

    await expect(resolving).resolves.toMatchObject({
      bindingId: "resolver-binding",
      externalCallCount: 1,
      reason: "memory_query_resolution_outcome_unknown",
      status: "UNAVAILABLE"
    });
    expect(settle).toHaveBeenCalledWith("user-1", "resolver-binding",
      expect.objectContaining({ state: "CANCELLED" }));
    expect(withAuthorizedResultCommit).not.toHaveBeenCalled();

    releaseProvider(providerResult(resolved));
    await Promise.resolve();
    expect(withAuthorizedResultCommit).not.toHaveBeenCalled();
  });
});
