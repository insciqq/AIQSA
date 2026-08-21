import { memorySummaryFixture } from "@/tests/support/memoryFixtures";
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_TARGET_SELECTION_NAME,
  createMemoryTargetSelector,
  decodeMemoryTargetSelection,
  memoryTargetCandidateMapHash,
  memoryTargetSelectionAcceptedOutputHash
} from "./targetSelector";

function target(id: string, versionId: string) {
  const summary = memorySummaryFixture({ currentVersionId: versionId, id });
  return {
    factId: id,
    statement: summary.displayText!,
    summary,
    versionId
  };
}

function dependencies(argumentsValue: unknown) {
  const settle = vi.fn(async () => ({}));
  const assertLinkedResultAuthorized = vi.fn(async () => undefined);
  const assertResultAuthorized = vi.fn(async () => undefined);
  const execution = {
    admission: {
      bind: vi.fn(async () => ({ id: "binding-selector" })),
      start: vi.fn(async () => ({
        bindingId: "binding-selector",
        snapshot: {
          logicalRole: "MEMORY_CONTROL",
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
      assertLinkedResultAuthorized,
      assertResultAuthorized,
      settle
    }
  };
  const provider = {
    run: vi.fn(async () => ({
      providerResponseId: "response-1",
      toolCalls: [{
        arguments: argumentsValue,
        id: "call-1",
        name: MEMORY_TARGET_SELECTION_NAME
      }],
      usage: {
        cachedInputTokens: 0,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15
      }
    }))
  };
  return {
    assertLinkedResultAuthorized,
    assertResultAuthorized,
    execution,
    provider,
    settle
  };
}

const request = {
  attemptId: "attempt-1",
  candidates: [
    { handle: "c0", target: target("fact-1", "version-1") },
    { handle: "c1", target: target("fact-2", "version-2") }
  ],
  controlBindingId: "binding-control",
  currentUserText: "Forget the second preference.",
  signal: new AbortController().signal,
  targetQuery: "the second preference",
  userId: "user-1"
};

describe("Memory target selector", () => {
  it("accepts only a HIGH-confidence handle from the supplied candidate set", () => {
    const handles = new Set(["c0", "c1"]);
    expect(decodeMemoryTargetSelection({
      confidenceBand: "HIGH",
      reasonCode: "SELECTED",
      selectedHandle: "c1"
    }, handles)).toMatchObject({ selectedHandle: "c1" });
    expect(decodeMemoryTargetSelection({
      confidenceBand: "MEDIUM",
      reasonCode: "SELECTED",
      selectedHandle: "c1"
    }, handles)).toBeNull();
    expect(decodeMemoryTargetSelection({
      confidenceBand: "HIGH",
      reasonCode: "SELECTED",
      selectedHandle: "c4"
    }, handles)).toBeNull();
    expect(decodeMemoryTargetSelection({
      confidenceBand: "HIGH",
      reasonCode: "SELECTED",
      selectedHandle: "c00"
    }, handles)).toBeNull();
  });

  it("binds a selected handle to the exact fact and version candidate map", () => {
    const originalMap = memoryTargetCandidateMapHash(request.candidates);
    const swappedMap = memoryTargetCandidateMapHash([
      request.candidates[1]!,
      request.candidates[0]!
    ]);
    expect(swappedMap).not.toBe(originalMap);

    const evidence = {
      candidateMapHash: originalMap,
      inputHash: "a".repeat(64),
      selectedFactId: "fact-2",
      selectedHandle: "c1",
      selectedVersionId: "version-2"
    };
    const accepted = memoryTargetSelectionAcceptedOutputHash(evidence);
    expect(memoryTargetSelectionAcceptedOutputHash({
      ...evidence,
      selectedFactId: "fact-1",
      selectedVersionId: "version-1"
    })).not.toBe(accepted);
    expect(memoryTargetSelectionAcceptedOutputHash({
      ...evidence,
      selectedHandle: "c0"
    })).not.toBe(accepted);
  });

  it("performs one strict bound call and returns its selected opaque handle", async () => {
    const deps = dependencies({
      confidenceBand: "HIGH",
      reasonCode: "SELECTED",
      selectedHandle: "c1"
    });
    await expect(createMemoryTargetSelector(deps as never).select(request))
      .resolves.toEqual({
        acceptedOutputHash: expect.any(String),
        bindingId: "binding-selector",
        candidateMapHash: expect.any(String),
        selectedHandle: "c1",
        status: "READY"
      });
    expect(deps.execution.admission.bind).toHaveBeenCalledWith("user-1", expect.objectContaining({
      ordinal: 1,
      role: "MEMORY_CONTROL"
    }));
    expect(deps.execution.admission.start).toHaveBeenCalledWith(
      "user-1",
      "binding-selector",
      { sourceBindingId: "binding-control" }
    );
    expect(deps.provider.run).toHaveBeenCalledOnce();
    expect(deps.settle).toHaveBeenCalledWith("user-1", "binding-selector",
      expect.objectContaining({ state: "SUCCEEDED" }));
    expect(deps.assertLinkedResultAuthorized).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        bindingId: "binding-selector",
        sourceBindingId: "binding-control"
      })
    );
  });

  it("fails closed on original control target drift before selector provider I/O", async () => {
    const deps = dependencies({
      confidenceBand: "HIGH",
      reasonCode: "SELECTED",
      selectedHandle: "c1"
    });
    deps.execution.admission.start.mockRejectedValueOnce(new Error("policy drift"));

    await expect(createMemoryTargetSelector(deps as never).select(request))
      .resolves.toMatchObject({ status: "UNAVAILABLE" });

    expect(deps.execution.admission.start).toHaveBeenCalledWith(
      "user-1",
      "binding-selector",
      { sourceBindingId: "binding-control" }
    );
    expect(deps.provider.run).not.toHaveBeenCalled();
    expect(deps.settle).toHaveBeenCalledWith("user-1", "binding-selector",
      expect.objectContaining({ state: "FAILED" }));
  });

  it("reauthorizes the linked selector result for the destructive apply boundary", async () => {
    const deps = dependencies(null);
    await createMemoryTargetSelector(deps as never).assertAuthorized({
      acceptedOutputHash: "a".repeat(64),
      bindingId: "binding-selector",
      controlBindingId: "binding-control",
      userId: "user-1"
    });
    expect(deps.assertLinkedResultAuthorized).toHaveBeenCalledWith("user-1", {
      acceptedOutputHash: "a".repeat(64),
      bindingId: "binding-selector",
      sourceBindingId: "binding-control"
    });
  });

  it("reauthorizes direct control evidence for a mutation without selection", async () => {
    const deps = dependencies(null);
    await createMemoryTargetSelector(deps as never).assertControlAuthorized({
      bindingId: "binding-control",
      userId: "user-1"
    });
    expect(deps.assertResultAuthorized).toHaveBeenCalledWith("user-1", {
      bindingId: "binding-control"
    });
  });

  it("fails closed on unavailable or invalid selector output without a second call", async () => {
    const deps = dependencies({
      confidenceBand: "HIGH",
      reasonCode: "SELECTED",
      selectedHandle: "c4"
    });
    await expect(createMemoryTargetSelector(deps as never).select(request))
      .resolves.toMatchObject({ status: "UNAVAILABLE" });
    expect(deps.provider.run).toHaveBeenCalledOnce();
    expect(deps.settle).toHaveBeenCalledWith("user-1", "binding-selector",
      expect.objectContaining({ state: "FAILED" }));
  });
});
