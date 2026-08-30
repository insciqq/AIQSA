import { describe, expect, it, vi } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import type {
  KnowledgeProviderDispatchLifecycle,
  PreparedKnowledgeProviderDispatch
} from "./providerDispatchLifecycle";
import { executeKnowledgeAnswerGroundingV8 } from "./answerGroundingExecutionV5";
import {
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V17_V13,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V18_V14,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V19_V15,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V13_V9,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V14_V10,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V11_V7,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V10_V7,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V9_V6,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V8_V6,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V7_V5,
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
} from "./answerGroundingV5";

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

function coEqualResultManifest() {
  return packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "knowledge-call-1:result:1",
      exactExcerpt: "The commutative square factors the modification and proves it is finite.",
      fileName: "modification.txt",
      handle: "K1",
      locator: "page=1; heading=Construction",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Modification theorem",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }, {
      ambiguity: "none",
      evidenceId: "knowledge-call-1:result:2",
      exactExcerpt: "Finally, pulling back O(1) along the closed immersion preserves relative ampleness.",
      fileName: "modification.txt",
      handle: "K2",
      locator: "page=2; heading=Construction",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S1",
      sourceLabel: "Modification theorem",
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
          contractVersion: operation === "knowledge_coverage_planner_v20" ||
            operation === "knowledge_answer_draft_v20" ||
            operation === "knowledge_answer_draft_supplement_v20"
            ? 20
            : operation === "knowledge_answer_draft_v19" ||
            operation === "knowledge_answer_draft_supplement_v19"
            ? 19
            : operation === "knowledge_answer_draft_v18" ||
            operation === "knowledge_answer_draft_supplement_v18"
            ? 18
            : operation === "knowledge_answer_draft_v17" ||
            operation === "knowledge_answer_draft_supplement_v17"
            ? 17
            : operation === "knowledge_answer_draft_v16" ||
              operation === "knowledge_answer_draft_supplement_v16"
              ? 16
            : operation === "knowledge_answer_draft_v14" ||
            operation === "knowledge_answer_draft_supplement_v14"
            ? 14
            : operation === "knowledge_answer_draft_v13" ||
            operation === "knowledge_answer_draft_supplement_v13"
            ? 13
            : operation === "knowledge_answer_draft_v12" ||
                operation === "knowledge_answer_draft_supplement_v12"
              ? 12
            : operation === "knowledge_answer_draft_v11"
            ? 11
            : operation === "knowledge_answer_draft_v10"
              ? 10
            : operation === "knowledge_answer_draft_v9"
              ? 9
            : operation === "knowledge_answer_draft_v8"
              ? 8
              : operation === "knowledge_answer_draft_v7"
                ? 7
              : operation === "knowledge_grounded_selector_v16" ||
                  operation === "knowledge_grounded_selector_final_v16"
                ? 16
              : operation === "knowledge_grounded_selector_v15" ||
                    operation === "knowledge_grounded_selector_final_v15"
                  ? 15
                : operation === "knowledge_grounded_selector_v14" ||
                    operation === "knowledge_grounded_selector_final_v14"
                  ? 14
                  : operation === "knowledge_grounded_selector_v13" ||
                    operation === "knowledge_grounded_selector_final_v13"
                  ? 13
                  : operation === "knowledge_grounded_selector_v12" ||
                    operation === "knowledge_grounded_selector_final_v12"
                  ? 12
                  : operation === "knowledge_grounded_selector_v10" ||
                    operation === "knowledge_grounded_selector_final_v10"
                  ? 10
                  : operation === "knowledge_grounded_selector_v9" ||
                    operation === "knowledge_grounded_selector_final_v9"
                  ? 9
                  : operation === "knowledge_grounded_selector_v8" ||
                      operation === "knowledge_grounded_selector_final_v8"
                    ? 8
                : operation === "knowledge_grounded_selector_v7"
                  ? 7
                  : operation === "knowledge_grounded_selector_v6"
                    ? 6
                    : 5,
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
  execute: Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"],
  options: Readonly<{
    draft?: ReturnType<typeof manifest>;
    request?: string;
  }> = {}
) {
  return {
    authorize: async () => undefined,
    contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V19_V15,
    draft: options.draft ?? manifest(),
    execute,
    forbiddenIdentityFragments: ["private-run-identity"],
    lifecycle,
    modelRunId: "run-1",
    reasoningEffort: "low",
    request: options.request ?? "How long are completed exports retained?",
    routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
    shouldAbort: () => false,
    transport: "native_strict" as const
  };
}

function plannedPipelineInput(
  lifecycle: KnowledgeProviderDispatchLifecycle,
  execute: Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"],
  options: Parameters<typeof pipelineInput>[2] = {}
) {
  return {
    ...pipelineInput(lifecycle, execute, options),
    contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16
  };
}

describe("Knowledge answer grounding V5 execution", () => {
  it("persists one immutable coverage plan before Draft V20 and Selector V16", async () => {
    const recorder = lifecycleRecorder();
    const plan = {
      dimensions: [{
        description: "The requested retention period.",
        id: "D1"
      }],
      version: 1
    } as const;
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_coverage_planner_v20"
          ? plan
          : request.name === "knowledge_answer_draft_v20"
            ? {
                claims: [{
                  citationHints: ["K1"],
                  text: "Atlas retains completed exports for 30 days."
                }],
                version: 1
              }
            : {
                claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
                coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
                extractIds: [],
                insufficientReason: "not_applicable",
                version: 1
              },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const first = await executeKnowledgeAnswerGroundingV8(
      plannedPipelineInput(recorder.lifecycle, execute)
    );

    expect(first.contracts).toEqual({
      draftContractVersion: 20,
      selectorContractVersion: 16
    });
    expect(first.operations.map((operation) => operation.operation)).toEqual([
      "knowledge_coverage_planner_v20",
      "knowledge_answer_draft_v20",
      "knowledge_grounded_selector_v16"
    ]);
    const draftPayload = JSON.parse(execute.mock.calls[1]![0].userPrompt) as
      Record<string, unknown>;
    const selectorPayload = JSON.parse(execute.mock.calls[2]![0].userPrompt) as
      Record<string, unknown>;
    expect(draftPayload.coveragePlan).toEqual(plan);
    expect(selectorPayload.coveragePlan).toEqual(plan);

    execute.mockClear();
    const recovered = await executeKnowledgeAnswerGroundingV8(
      plannedPipelineInput(recorder.lifecycle, execute)
    );
    expect(execute).not.toHaveBeenCalled();
    expect(recovered.operations).toHaveLength(3);
  });

  it("settles a malformed Coverage Planner result and fails closed before Draft", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: { dimensions: [], version: 1 },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await expect(executeKnowledgeAnswerGroundingV8(
      plannedPipelineInput(recorder.lifecycle, execute)
    )).rejects.toThrow("knowledge_coverage_plan_result_invalid");
    expect(execute).toHaveBeenCalledOnce();
    expect(recorder.entries.get(1)?.acceptedResult).toEqual({
      kind: "coverage_plan_malformed"
    });
    expect(recorder.entries.has(2)).toBe(false);
  });

  it("performs exactly one draft and one selector and reuses both accepted results", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name.startsWith("knowledge_answer_draft_")
          ? request.name === "knowledge_answer_draft_v19" ||
              request.name === "knowledge_answer_draft_v18" ||
              request.name === "knowledge_answer_draft_v17" ||
              request.name === "knowledge_answer_draft_v16" ||
              request.name === "knowledge_answer_draft_v14" ||
              request.name === "knowledge_answer_draft_v13" ||
              request.name === "knowledge_answer_draft_v11"
            ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
            : {
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
              coverage: [{
                description: "The requested retention period.",
                id: "D1",
                status: "covered",
                supportIds: ["C1"]
              }],
              extractIds: [],
              insufficientReason: "not_applicable",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const first = await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(first.contracts).toEqual({
      draftContractVersion: 19,
      selectorContractVersion: 15
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v19",
      "knowledge_grounded_selector_v15"
    ]);
    expect(recorder.prepare).toHaveBeenCalledTimes(2);
    expect(recorder.dispatch).toHaveBeenCalledTimes(2);
    expect(recorder.settle).toHaveBeenCalledTimes(2);

    execute.mockClear();
    const recovered = await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(execute).not.toHaveBeenCalled();
    expect(recorder.prepare).toHaveBeenCalledTimes(2);
    expect(recorder.dispatch).toHaveBeenCalledTimes(2);
    expect(recovered.operations.map((operation) => operation.providerResponseId)).toEqual([
      "provider-knowledge_answer_draft_v19",
      "provider-knowledge_grounded_selector_v15"
    ]);
  });

  it("continues an accepted V17/V13 pair without minting V18/V14 operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v17"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              coverage: [{
                description: "The requested retention period.",
                id: "D1",
                status: "covered",
                supportIds: ["C1"]
              }],
              extractIds: [],
              insufficientReason: "not_applicable",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V17_V13
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 17,
      selectorContractVersion: 13
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v17",
      "knowledge_grounded_selector_v13"
    ]);
  });

  it("continues an accepted V18/V14 pair without minting V19/V15 operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v18"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              coverage: [{
                description: "The requested retention period.",
                id: "D1",
                status: "covered",
                supportIds: ["C1"]
              }],
              extractIds: [],
              insufficientReason: "not_applicable",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V18_V14
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 18,
      selectorContractVersion: 14
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v18",
      "knowledge_grounded_selector_v14"
    ]);
  });

  it("runs exactly one validation repair over the unchanged Draft and evidence", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v19"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : request.name === "knowledge_grounded_selector_v15"
            ? { invalid: "selector" }
            : {
                claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
                coverage: [{
                  description: "The requested retention period.",
                  id: "D1",
                  status: "covered",
                  supportIds: ["C1"]
                }],
                extractIds: [],
                insufficientReason: "not_applicable",
                version: 1
              },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const first = await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(first.operations.map((operation) => operation.operation)).toEqual([
      "knowledge_answer_draft_v19",
      "knowledge_grounded_selector_v15",
      "knowledge_grounded_selector_final_v15"
    ]);
    expect(recorder.entries.get(2)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason: "selector_malformed"
    });
    const repairPayload = JSON.parse(execute.mock.calls[2]![0].userPrompt) as
      Record<string, unknown>;
    expect(repairPayload).toMatchObject({
      phase2aDraft: {
        claims: [{
          citationHints: ["K1"],
          id: "C1",
          text: "Atlas retains completed exports for 30 days."
        }]
      },
      phase2cSelectorPass: "repair",
      phase2dRepairReason: "selector_malformed"
    });

    execute.mockClear();
    const recovered = await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(execute).not.toHaveBeenCalled();
    expect(recovered.operations).toHaveLength(3);
  });

  it("lets the one validation repair fail closed without another provider call", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v19"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : { invalid: "selector" },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await executeKnowledgeAnswerGroundingV8(pipelineInput(recorder.lifecycle, execute));

    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v19",
      "knowledge_grounded_selector_v15",
      "knowledge_grounded_selector_final_v15"
    ]);
    expect(recorder.entries.get(3)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason: "selector_malformed"
    });
  });

  it("continues an accepted V14/V10 pair without minting V15/V11 operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v14"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              coverage: [{
                description: "The requested retention period.",
                id: "D1",
                status: "covered",
                supportIds: ["C1"]
              }],
              decision: "select_claims",
              missingInformation: [],
              requestCoverage: "complete",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V14_V10
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 14,
      selectorContractVersion: 10
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v14",
      "knowledge_grounded_selector_v10"
    ]);
  });

  it("continues an accepted V13/V9 pair without minting newer operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v13"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              decision: "select_claims",
              missingInformation: [],
              requestCoverage: "complete",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V13_V9
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 13,
      selectorContractVersion: 9
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v13",
      "knowledge_grounded_selector_v9"
    ]);
  });

  it("recovers one omitted co-equal result with one bounded targeted correction", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => {
        if (request.name === "knowledge_answer_draft_v19") {
          return {
            output: {
              claims: [{
                citationHints: ["K1"],
                text: "The commutative square factors the modification and proves it is finite."
              }],
              version: 1
            },
            providerResponseId: `provider-${request.name}`,
            usage
          };
        }
        if (request.name === "knowledge_grounded_selector_v15") {
          return {
            output: {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              coverage: [
                {
                  description: "How the diagram establishes finiteness.",
                  id: "D1",
                  status: "covered",
                  supportIds: ["C1"]
                },
                {
                  description: "How the diagram preserves the modification's relative ampleness.",
                  id: "D2",
                  status: "missing",
                  supportIds: []
                }
              ],
              extractIds: [],
              insufficientReason: "not_applicable",
              version: 1
            },
            providerResponseId: `provider-${request.name}`,
            usage
          };
        }
        if (request.name === "knowledge_answer_draft_supplement_v19") {
          return {
            output: {
              claims: [{
                citationHints: ["K2"],
                text: "Pulling back O(1) along the closed immersion preserves relative ampleness."
              }],
              version: 1
            },
            providerResponseId: `provider-${request.name}`,
            usage
          };
        }
        return {
          output: {
            claims: [
              { id: "C1", supportHandles: ["K1"], verdict: "supported" },
              { id: "C2", supportHandles: ["K2"], verdict: "supported" }
            ],
            coverage: [
              {
                description: "How the diagram establishes finiteness.",
                id: "D1",
                status: "covered",
                supportIds: ["C1"]
              },
              {
                description: "How the diagram preserves the modification's relative ampleness.",
                id: "D2",
                status: "covered",
                supportIds: ["C2"]
              }
            ],
            extractIds: [],
            insufficientReason: "not_applicable",
            version: 1
          },
          providerResponseId: `provider-${request.name}`,
          usage
        };
      }
    );

    const first = await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute, {
        draft: coEqualResultManifest(),
        request: "How do commutative diagrams assist in proving properties of scheme modifications?"
      })
    );

    expect(first.operations.map((operation) => operation.operation)).toEqual([
      "knowledge_answer_draft_v19",
      "knowledge_grounded_selector_v15",
      "knowledge_answer_draft_supplement_v19",
      "knowledge_grounded_selector_final_v15"
    ]);
    const supplementPayload = JSON.parse(
      execute.mock.calls[2]![0].userPrompt
    ) as Record<string, unknown>;
    expect(supplementPayload).toMatchObject({
      draftPass: "supplement",
      missingInformation: [
        "How the diagram preserves the modification's relative ampleness."
      ]
    });
    const finalPayload = JSON.parse(
      execute.mock.calls[3]![0].userPrompt
    ) as Record<string, unknown>;
    expect(finalPayload).toMatchObject({
      phase2aDraft: {
        claims: [
          {
            id: "C1",
            text: "The commutative square factors the modification and proves it is finite."
          },
          {
            id: "C2",
            text: "Pulling back O(1) along the closed immersion preserves relative ampleness."
          }
        ]
      },
      phase2cSelectorPass: "final"
    });

    execute.mockClear();
    const recovered = await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute, {
        draft: coEqualResultManifest(),
        request: "How do commutative diagrams assist in proving properties of scheme modifications?"
      })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(recovered.operations).toHaveLength(4);
  });

  it("continues an accepted V10/V7 pair without minting V11 operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v10"
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

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V10_V7
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 10,
      selectorContractVersion: 7
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v10",
      "knowledge_grounded_selector_v7"
    ]);
  });

  it("continues an accepted V9/V6 pair without minting newer operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name.startsWith("knowledge_answer_draft_")
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

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V9_V6
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 9,
      selectorContractVersion: 6
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v9",
      "knowledge_grounded_selector_v6"
    ]);
  });

  it("persists Selector V7 literal IDs without model-authored quote text", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v11"
          ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
          : {
              claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
              decision: "select_claims_with_evidence",
              extractIds: ["L1"],
              requestCoverage: "complete",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V11_V7
    });

    expect(recorder.entries.get(2)?.acceptedResult).toEqual({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      decision: "select_claims_with_evidence",
      extractIds: ["L1"],
      requestCoverage: "complete",
      version: 1
    });
    expect(JSON.stringify(recorder.entries.get(2)?.acceptedResult)).not.toContain("quote");
  });

  it("continues an accepted V8/V6 pair without minting newer operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name.startsWith("knowledge_answer_draft_")
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

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V8_V6
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 8,
      selectorContractVersion: 6
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v8",
      "knowledge_grounded_selector_v6"
    ]);
  });

  it("continues an accepted V7/V5 pair without minting V8/V6 operations", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name === "knowledge_answer_draft_v7"
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

    const result = await executeKnowledgeAnswerGroundingV8({
      ...pipelineInput(recorder.lifecycle, execute),
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V7_V5
    });

    expect(result.contracts).toEqual({
      draftContractVersion: 7,
      selectorContractVersion: 5
    });
    expect(execute.mock.calls.map(([request]) => request.name)).toEqual([
      "knowledge_answer_draft_v7",
      "knowledge_grounded_selector_v5"
    ]);
  });

  it("settles a selector failure marker instead of retrying or publishing its payload", async () => {
    const recorder = lifecycleRecorder();
    let calls = 0;
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async () => {
        calls += 1;
        if (calls === 2) throw new TypeError("network unavailable");
        return {
          output: {
            claims: [{
              citationHints: ["K1"],
              text: "Atlas retains completed exports for 30 days."
            }],
            version: 1
          },
          providerResponseId: "provider-draft",
          usage
        };
      }
    );

    await executeKnowledgeAnswerGroundingV8(
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
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async () => {
        calls += 1;
        if (calls === 2) throw selectorError;
        return {
          output: {
            claims: [{
              citationHints: ["K1"],
              text: "Atlas retains completed exports for 30 days."
            }],
            version: 1
          },
          providerResponseId: "provider-draft",
          usage
        };
      }
    );

    await executeKnowledgeAnswerGroundingV8(
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
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name.startsWith("knowledge_answer_draft_")
          ? { invalid: "draft" }
          : { invalid: "selector" },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(recorder.entries.get(1)?.acceptedResult).toEqual({
      kind: "draft_malformed",
      reason: "draft_shape_invalid"
    });
    expect(recorder.entries.get(2)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason: "selector_malformed"
    });
  });

  it("continues from an accepted draft with only one selector call", async () => {
    const recorder = lifecycleRecorder();
    const firstExecute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: request.name.startsWith("knowledge_answer_draft_")
          ? request.name === "knowledge_answer_draft_v19" ||
              request.name === "knowledge_answer_draft_v18" ||
              request.name === "knowledge_answer_draft_v17" ||
              request.name === "knowledge_answer_draft_v16" ||
              request.name === "knowledge_answer_draft_v14" ||
              request.name === "knowledge_answer_draft_v13" ||
              request.name === "knowledge_answer_draft_v11"
            ? {
              claims: [{
                citationHints: ["K1"],
                text: "Atlas retains completed exports for 30 days."
              }],
              version: 1
            }
            : {
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
              coverage: [{
                description: "The requested retention period.",
                id: "D1",
                status: "covered",
                supportIds: ["C1"]
              }],
              extractIds: [],
              insufficientReason: "not_applicable",
              version: 1
            },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );
    await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, firstExecute)
    );
    recorder.entries.delete(2);
    const recoveryExecute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>(
      async (request) => ({
        output: {
          claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
          coverage: [{
            description: "The requested retention period.",
            id: "D1",
            status: "covered",
            supportIds: ["C1"]
          }],
          extractIds: [],
          insufficientReason: "not_applicable",
          version: 1
        },
        providerResponseId: `provider-${request.name}`,
        usage
      })
    );

    await executeKnowledgeAnswerGroundingV8(
      pipelineInput(recorder.lifecycle, recoveryExecute)
    );

    expect(recoveryExecute).toHaveBeenCalledOnce();
    expect(recoveryExecute.mock.calls[0]?.[0].name).toBe(
      "knowledge_grounded_selector_v15"
    );
  });

  it("releases a reserved operation when authorization changes before provider I/O", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn<Parameters<typeof executeKnowledgeAnswerGroundingV8>[0]["execute"]>();

    await expect(executeKnowledgeAnswerGroundingV8({
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
