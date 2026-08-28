import { describe, expect, it, vi } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import type {
  KnowledgeProviderDispatchLifecycle,
  PreparedKnowledgeProviderDispatch
} from "./providerDispatchLifecycle";
import { executeKnowledgeAnswerGroundingV5 } from "./answerGroundingExecutionV5";
import { KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION } from "./answerGroundingV5";

const usage = Object.freeze({
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 0,
  totalTokens: 15
});

function manifest() {
  return packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "knowledge-call-1:result:1",
      exactExcerpt: "Atlas retains completed exports for 30 days.",
      fileName: "retention.txt",
      handle: "K1",
      locator: "page=1; heading=Retention",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Retention",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 32_000,
    maximumTokens: 8_000,
    profileId: "fake:answer",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
}

function lifecycleRecorder() {
  type Entry = {
    acceptedRequest: Readonly<Record<string, unknown>>;
    acceptedResult?: Readonly<Record<string, unknown>>;
    draft: ReturnType<typeof manifest>;
    prepared: PreparedKnowledgeProviderDispatch;
    providerResponseId?: string | null;
  };
  const entries = new Map<number, Entry>();
  const prepare = vi.fn<KnowledgeProviderDispatchLifecycle["prepare"]>(async (input) => {
    const prepared = Object.freeze({ ordinal: input.ordinal }) as unknown as
      PreparedKnowledgeProviderDispatch;
    entries.set(input.ordinal, {
      acceptedRequest: input.acceptedRequest!,
      draft: input.draft,
      prepared
    });
    return prepared;
  });
  const dispatch = vi.fn<KnowledgeProviderDispatchLifecycle["dispatch"]>(async () => undefined);
  const settle = vi.fn<KnowledgeProviderDispatchLifecycle["settle"]>(async (prepared, input) => {
    const ordinal = (prepared as unknown as { ordinal: number }).ordinal;
    const entry = entries.get(ordinal)!;
    entry.acceptedResult = input.acceptedResult;
    entry.providerResponseId = input.providerResponseId;
  });
  const release = vi.fn<KnowledgeProviderDispatchLifecycle["release"]>(async () => undefined);
  const lifecycle = {
    dispatch,
    async inspect(input: { modelRunId: string; ordinal: number }) {
      void input.modelRunId;
      const entry = entries.get(input.ordinal);
      if (!entry?.acceptedResult) return null;
      const operation = String(entry.acceptedRequest.operation);
      return {
        attempt: {
          acceptedRequest: entry.acceptedRequest,
          acceptedResult: entry.acceptedResult,
          actualUsage: usage,
          contractVersion: operation === "knowledge_answer_draft_v5" ? 5 : 3,
          evidenceReceiptHash: entry.draft.manifestHash,
          providerResponseId: entry.providerResponseId ?? null,
          purpose: operation,
          state: "settled"
        },
        draft: entry.draft
      } as Awaited<ReturnType<KnowledgeProviderDispatchLifecycle["inspect"]>>;
    },
    markAmbiguous: vi.fn<KnowledgeProviderDispatchLifecycle["markAmbiguous"]>(async () => undefined),
    prepare,
    recover: vi.fn<KnowledgeProviderDispatchLifecycle["recover"]>(async () => ({
      kind: "not_found"
    })),
    release,
    settle
  } satisfies KnowledgeProviderDispatchLifecycle;
  return { dispatch, entries, lifecycle, prepare, release, settle };
}

function pipelineInput(
  lifecycle: KnowledgeProviderDispatchLifecycle,
  execute: Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]
) {
  return {
    authorize: async () => undefined,
    draft: manifest(),
    execute,
    forbiddenIdentityFragments: ["private-run-identity"],
    lifecycle,
    modelRunId: "run-1",
    reasoningEffort: "low",
    request: "How long are completed exports retained?",
    routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
    shouldAbort: () => false,
    transport: "native_strict" as const
  };
}

describe("Knowledge answer grounding V5 execution", () => {
  it("performs exactly one draft and one selector and reuses both accepted results", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v5"
          ? {
              blocks: [{ claimIds: ["C1"], type: "paragraph" }],
              claims: [{
                citationHints: ["K1"],
                id: "C1",
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              decision: "select_claims",
              requestCoverage: "complete",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const first = await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(first.contracts).toEqual({
      draftContractVersion: 5,
      selectorContractVersion: 3
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v5",
      "knowledge_grounded_selector_v3"
    ]);
    expect(recorder.prepare).toHaveBeenCalledTimes(2);
    expect(recorder.dispatch).toHaveBeenCalledTimes(2);
    expect(recorder.settle).toHaveBeenCalledTimes(2);

    execute.mockClear();
    const recovered = await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(execute).not.toHaveBeenCalled();
    expect(recorder.prepare).toHaveBeenCalledTimes(2);
    expect(recorder.dispatch).toHaveBeenCalledTimes(2);
    expect(recovered.operations.map((operation) => operation.providerResponseId)).toEqual([
      "provider-knowledge_answer_draft_v5",
      "provider-knowledge_grounded_selector_v3"
    ]);
  });

  it("settles a selector failure marker instead of retrying or publishing its payload", async () => {
    const recorder = lifecycleRecorder();
    let calls = 0;
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>(
      async () => {
        calls += 1;
        if (calls === 2) throw new TypeError("network unavailable");
        return {
          output: {
            blocks: [{ claimIds: ["C1"], type: "paragraph" }],
            claims: [{
              citationHints: ["K1"],
              id: "C1",
              text: "Atlas retains completed exports for 30 days."
            }],
            version: 1
          },
          providerResponseId: "provider-draft",
          usage
        };
      }
    );

    await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(recorder.entries.get(2)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason: "selector_transport_failure"
    });
    expect(recorder.settle).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "timeout",
      Object.assign(new Error("provider deadline exceeded"), { name: "TimeoutError" }),
      "selector_timeout"
    ],
    ["refusal", new Error("provider safety refusal"), "selector_refusal"],
    ["rate limit", new Error("provider returned 429"), "selector_provider_error"],
    ["server error", new Error("provider returned 503"), "selector_provider_error"]
  ] as const)("settles %s without a retry or third provider operation", async (
    _label,
    selectorError,
    reason
  ) => {
    const recorder = lifecycleRecorder();
    let calls = 0;
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>(
      async () => {
        calls += 1;
        if (calls === 2) throw selectorError;
        return {
          output: {
            blocks: [{ claimIds: ["C1"], type: "paragraph" }],
            claims: [{
              citationHints: ["K1"],
              id: "C1",
              text: "Atlas retains completed exports for 30 days."
            }],
            version: 1
          },
          providerResponseId: "provider-draft",
          usage
        };
      }
    );

    await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(recorder.entries.get(2)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason
    });
    expect(recorder.settle).toHaveBeenCalledTimes(2);
  });

  it("settles malformed draft and selector payloads as private failure markers", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v5"
          ? { invalid: "draft" }
          : { invalid: "selector" },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(recorder.entries.get(1)?.acceptedResult).toEqual({ kind: "draft_malformed" });
    expect(recorder.entries.get(2)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason: "selector_malformed"
    });
  });

  it("continues from an accepted draft with only one selector call", async () => {
    const recorder = lifecycleRecorder();
    const firstExecute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v5"
          ? {
              blocks: [{ claimIds: ["C1"], type: "paragraph" }],
              claims: [{
                citationHints: ["K1"],
                id: "C1",
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              decision: "select_claims",
              requestCoverage: "complete",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );
    await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, firstExecute)
    );
    recorder.entries.delete(2);
    const recoveryExecute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>(
      async (request) => ({
        output: {
          claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
          decision: "select_claims",
          requestCoverage: "complete",
          version: 1
        },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await executeKnowledgeAnswerGroundingV5(
      pipelineInput(recorder.lifecycle, recoveryExecute)
    );

    expect(recoveryExecute).toHaveBeenCalledOnce();
    expect(recoveryExecute.mock.calls[0]?.[0].name).toBe(
      "knowledge_grounded_selector_v3"
    );
  });

  it("releases a reserved operation when authorization changes before provider I/O", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV5>[0]["execute"]>();

    await expect(executeKnowledgeAnswerGroundingV5({
      ...pipelineInput(recorder.lifecycle, execute),
      authorize: async () => {
        throw new Error("knowledge_access_changed");
      }
    })).rejects.toThrow("knowledge_access_changed");

    expect(execute).not.toHaveBeenCalled();
    expect(recorder.release).toHaveBeenCalledOnce();
    expect(recorder.dispatch).not.toHaveBeenCalled();
  });
});
