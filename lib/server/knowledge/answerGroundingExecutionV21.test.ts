import { describe, expect, it, vi } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import type {
  KnowledgeProviderDispatchLifecycle,
  PreparedKnowledgeProviderDispatch
} from "./providerDispatchLifecycle";
import {
  KnowledgeAnswerOperationDeferredError
} from "./answerGroundingExecutionV5";
import {
  knowledgeAnswerHash,
  knowledgeSelectorEvidenceFromManifest
} from "./answerGroundingV5";
import {
  executeKnowledgeAnswerGroundingV21AuditV2 as executeKnowledgeAnswerGroundingV21,
  type KnowledgeAnswerOperationExecutionV21
} from "./answerGroundingExecutionV21";
import {
  executeKnowledgeAnswerGroundingV21 as executeKnowledgeAnswerGroundingV21ScopeV4
} from "./answerGroundingExecutionV21ScopeV4";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
  decodeKnowledgeAnswerOperationRequestSnapshotV21
} from "./answerGroundingV21";
import {
  KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
  decodeKnowledgeCoverageAuditPromptV2
} from "./coverageAuditV2";
import {
  KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION,
  decodeKnowledgeCoverageScopePromptV4,
  knowledgeCoverageEvidenceFromManifestV4
} from "./coverageScopeV4";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V19,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
} from "./answerGroundingSelectorV19";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from
  "./groundingExecutionPolicy";

const request = "Explain alpha and beta.";
const usage = Object.freeze({
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 0,
  totalTokens: 15
});
const rolePolicy = Object.freeze({
  auditorReasoningEffort: "high",
  draftReasoningEffort: "low",
  egressDestination: "answer_provider",
  overriddenRoles: Object.freeze(["selector", "auditor", "supplement"]),
  providerBindingKey: "answer",
  selectorReasoningEffort: "medium",
  supplementReasoningEffort: "medium",
  version: 1
} as const satisfies KnowledgeGroundingEffectiveExecutionPolicyV1);

function manifest() {
  return packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "knowledge-call-1:result:1",
      exactExcerpt: "Alpha preserves order.",
      fileName: "mechanisms.txt",
      handle: "K1",
      locator: "page=1; heading=Alpha",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Mechanisms",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }, {
      ambiguity: "none",
      evidenceId: "knowledge-call-1:result:2",
      exactExcerpt: "Beta removes duplicates.",
      fileName: "mechanisms.txt",
      handle: "K2",
      locator: "page=1; heading=Beta",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S1",
      sourceLabel: "Mechanisms",
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

function draftOutput(text = "Alpha preserves order.", handle = "K1") {
  return { claims: [{ citationHints: [handle], text }], version: 1 };
}

function initialSelectorOutput() {
  return {
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  };
}

function partialAuditOutput() {
  return {
    coverage: [{
      id: "D1",
      status: "covered",
      supportIds: ["C1"]
    }, {
      id: "D2",
      status: "missing",
      supportIds: []
    }],
    scope: [{
      description: "Explain alpha.",
      evidenceHandles: ["K1"],
      id: "D1",
      requestAnchor: "alpha"
    }, {
      description: "Explain beta.",
      evidenceHandles: ["K2"],
      id: "D2",
      requestAnchor: "beta"
    }],
    version: 2
  };
}

function completeAuditOutput() {
  return {
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
    scope: [{
      description: "Explain alpha.",
      evidenceHandles: ["K1"],
      id: "D1",
      requestAnchor: "alpha"
    }],
    version: 2
  };
}

function missingAuditOutput() {
  return {
    coverage: [{ id: "D1", status: "missing", supportIds: [] }, {
      id: "D2",
      status: "missing",
      supportIds: []
    }],
    scope: [{
      description: "Explain alpha.",
      evidenceHandles: ["K1"],
      id: "D1",
      requestAnchor: "alpha"
    }, {
      description: "Explain beta.",
      evidenceHandles: ["K2"],
      id: "D2",
      requestAnchor: "beta"
    }],
    version: 2
  };
}

function finalSelectorOutput() {
  return {
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
      id: "C2",
      supportHandles: ["K2"],
      verdict: "supported"
    }],
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
      id: "D2",
      status: "covered",
      supportIds: ["C2"]
    }],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  };
}

function outputForOperation(name: string, complete = false) {
  if (name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21) return draftOutput();
  if (name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17) {
    return initialSelectorOutput();
  }
  if (name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION) {
    return complete ? completeAuditOutput() : partialAuditOutput();
  }
  if (name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21) {
    return draftOutput("Beta removes duplicates.", "K2");
  }
  if (name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17) {
    return finalSelectorOutput();
  }
  throw new Error("unexpected_operation");
}

function lifecycleRecorder() {
  type Entry = {
    acceptedRequest: Readonly<Record<string, unknown>>;
    acceptedResult: Readonly<Record<string, unknown>> | null;
    draft: ReturnType<typeof manifest>;
    prepared: PreparedKnowledgeProviderDispatch;
    providerResponseId: string | null;
    state: "dispatched" | "reserved" | "settled";
  };
  const entries = new Map<number, Entry>();
  const prepare = vi.fn<KnowledgeProviderDispatchLifecycle["prepare"]>(async (input) => {
    const prepared = Object.freeze({ ordinal: input.ordinal }) as unknown as
      PreparedKnowledgeProviderDispatch;
    entries.set(input.ordinal, {
      acceptedRequest: input.acceptedRequest!,
      acceptedResult: null,
      draft: input.draft,
      prepared,
      providerResponseId: null,
      state: "reserved"
    });
    return prepared;
  });
  const inspect: KnowledgeProviderDispatchLifecycle["inspect"] = async (input) => {
    void input.modelRunId;
    const entry = entries.get(input.ordinal);
    if (!entry) return null;
    const snapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      entry.acceptedRequest
    )!;
    return {
      attempt: {
        acceptedRequest: entry.acceptedRequest,
        acceptedResult: entry.acceptedResult,
        actualUsage: entry.state === "settled" ? usage : null,
        contractVersion: snapshot.contractVersion,
        evidenceReceiptHash: entry.draft.manifestHash,
        providerResponseId: entry.providerResponseId,
        purpose: snapshot.operation,
        state: entry.state
      },
      draft: entry.draft
    } as Awaited<ReturnType<KnowledgeProviderDispatchLifecycle["inspect"]>>;
  };
  const lifecycle = {
    dispatch: vi.fn<KnowledgeProviderDispatchLifecycle["dispatch"]>(async (prepared) => {
      entries.get((prepared as unknown as { ordinal: number }).ordinal)!.state = "dispatched";
    }),
    inspect,
    markAmbiguous: vi.fn<KnowledgeProviderDispatchLifecycle["markAmbiguous"]>(
      async () => undefined
    ),
    prepare,
    recover: vi.fn<KnowledgeProviderDispatchLifecycle["recover"]>(async (input) => {
      const entry = entries.get(input.ordinal)!;
      if (entry.state === "settled") {
        return {
          dispatch: await inspect({
            modelRunId: input.modelRunId,
            ordinal: input.ordinal
          }) as NonNullable<Awaited<ReturnType<typeof inspect>>>,
          kind: "settled" as const,
          providerResponseId: entry.providerResponseId
        };
      }
      entry.providerResponseId = input.providerResponseId ?? null;
      return {
        kind: "resume" as const,
        prepared: entry.prepared,
        providerResponseId: entry.providerResponseId
      };
    }),
    release: vi.fn<KnowledgeProviderDispatchLifecycle["release"]>(async () => undefined),
    settle: vi.fn<KnowledgeProviderDispatchLifecycle["settle"]>(async (prepared, input) => {
      const entry = entries.get((prepared as unknown as { ordinal: number }).ordinal)!;
      entry.acceptedResult = input.acceptedResult ?? null;
      entry.providerResponseId = input.providerResponseId ?? null;
      entry.state = "settled";
    })
  } satisfies KnowledgeProviderDispatchLifecycle;
  return { entries, lifecycle, prepare };
}

function pipelineInput(
  lifecycle: KnowledgeProviderDispatchLifecycle,
  execute: Parameters<typeof executeKnowledgeAnswerGroundingV21>[0]["execute"]
) {
  return {
    authorize: async () => undefined,
    draft: manifest(),
    execute,
    lifecycle,
    modelRunId: "run-v21-1",
    reasoningEffort: "low",
    request,
    routeInstruction: "Answer only from the supplied Knowledge evidence.",
    shouldAbort: () => false,
    transport: "native_strict" as const
  };
}

function execution(complete = false) {
  return vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
    output: outputForOperation(operation.name, complete),
    providerResponseId: `response-${operation.name}`,
    usage
  }));
}

describe("V21 audited Knowledge answer execution", () => {
  it("runs the normal Draft, Selector, Auditor order with one receipt", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execution(true))
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
    ]);
    expect(result.contracts).toEqual({
      coverageAuditorContractVersion: 2,
      draftContractVersion: 21,
      selectorContractVersion: 17,
      settlementVersion: 6
    });
    expect(result.settlement).toMatchObject({
      outcome: "answered",
      requestCoverage: "complete"
    });
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(new Set(snapshots.map(({ evidenceReceiptHash }) => evidenceReceiptHash)).size)
      .toBe(1);
    expect(snapshots.every((snapshot) => "auditPayloadHash" in snapshot &&
      snapshot.auditPayloadHash === null)).toBe(true);
  });

  it("freezes and applies one role policy across every corrected-path operation", async () => {
    const recorder = lifecycleRecorder();
    const execute = execution();
    await executeKnowledgeAnswerGroundingV21({
      ...pipelineInput(recorder.lifecycle, execute),
      executionPolicy: rolePolicy,
      reasoningEffort: undefined
    });
    expect(execute.mock.calls.map(([operation]) => operation.reasoningEffort)).toEqual([
      "low",
      "medium",
      "high",
      "medium",
      "medium"
    ]);
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(snapshots.every((snapshot) => snapshot.version === 2)).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.version === 2 &&
      JSON.stringify(snapshot.executionPolicy) === JSON.stringify(rolePolicy))).toBe(true);
    expect(decodeKnowledgeAnswerOperationRequestSnapshotV21({
      ...snapshots[1],
      reasoningEffort: "low"
    })).toBeNull();
  });

  it("rejects a malformed or conflicting policy before dispatch preparation", async () => {
    const recorder = lifecycleRecorder();
    const execute = execution(true);
    await expect(executeKnowledgeAnswerGroundingV21({
      ...pipelineInput(recorder.lifecycle, execute),
      executionPolicy: rolePolicy
    })).rejects.toThrow("knowledge_grounding_execution_policy_invalid");
    expect(recorder.prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("marks an in-flight operation ambiguous and stops immediately on abort", async () => {
    const recorder = lifecycleRecorder();
    const abortError = new Error("operation cancelled");
    const execute = vi.fn(async (): Promise<KnowledgeAnswerOperationExecutionV21> => {
      throw abortError;
    });

    await expect(executeKnowledgeAnswerGroundingV21({
      ...pipelineInput(recorder.lifecycle, execute),
      shouldAbort: (error) => error === abortError
    })).rejects.toBe(abortError);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(recorder.lifecycle.markAmbiguous).toHaveBeenCalledTimes(1);
    expect(recorder.lifecycle.markAmbiguous).toHaveBeenCalledWith(
      expect.anything(),
      { reason: "provider_dispatch_cancelled" }
    );
    expect(recorder.lifecycle.settle).not.toHaveBeenCalled();
    expect([...recorder.entries.values()].map(({ state }) => state)).toEqual([
      "dispatched"
    ]);
  });

  it("runs one bounded correction and pins one immutable Audit hash", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execution())
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17
    ]);
    const supplementSnapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(4)!.acceptedRequest
    );
    const auditHash = supplementSnapshot && "auditPayloadHash" in supplementSnapshot
      ? supplementSnapshot.auditPayloadHash
      : null;
    expect(auditHash).toMatch(/^[0-9a-f]{64}$/u);
    const finalSnapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(5)!.acceptedRequest
    );
    expect(finalSnapshot && "auditPayloadHash" in finalSnapshot
      ? finalSnapshot.auditPayloadHash
      : null).toBe(auditHash);
  });

  it("rejects recovery when a persisted Supplement is pinned to another Audit", async () => {
    const recorder = lifecycleRecorder();
    let operationOrdinal = 0;
    const first = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      operationOrdinal += 1;
      if (operationOrdinal === 5) throw new KnowledgeAnswerOperationDeferredError();
      return {
        output: outputForOperation(operation.name),
        providerResponseId: `first-response-${operationOrdinal}`,
        usage
      };
    });
    await expect(executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, first)
    )).rejects.toBeInstanceOf(KnowledgeAnswerOperationDeferredError);

    const supplement = recorder.entries.get(4)!;
    supplement.acceptedRequest = Object.freeze({
      ...supplement.acceptedRequest,
      auditPayloadHash: "f".repeat(64)
    });

    await expect(executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execution())
    )).rejects.toThrow("knowledge_answer_operation_snapshot_conflict");
  });

  it("uses at most one structural Selector repair and stays under six calls", async () => {
    const recorder = lifecycleRecorder();
    let selectorCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      const output = operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17 &&
        selectorCalls++ === 0
        ? {}
        : outputForOperation(operation.name, true);
      return { output, providerResponseId: `response-${selectorCalls}`, usage };
    });
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
    ]);
    expect(result.operations).toHaveLength(4);
  });

  it("uses the full six-call bound for one repair followed by one correction", async () => {
    const recorder = lifecycleRecorder();
    let selectorCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      const output = operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17 &&
        selectorCalls++ === 0
        ? {}
        : outputForOperation(operation.name);
      return { output, providerResponseId: `response-${selectorCalls}`, usage };
    });
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17
    ]);
    expect(result.operations).toHaveLength(6);
  });

  it("resumes the Final Selector at ordinal six after repair and correction", async () => {
    const recorder = lifecycleRecorder();
    let operationOrdinal = 0;
    let selectorCalls = 0;
    const first = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      operationOrdinal += 1;
      if (operationOrdinal === 6) throw new KnowledgeAnswerOperationDeferredError();
      const output = operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17 &&
        selectorCalls++ === 0
        ? {}
        : outputForOperation(operation.name);
      return {
        output,
        providerResponseId: `first-response-${operationOrdinal}`,
        usage
      };
    });

    await expect(executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, first)
    )).rejects.toBeInstanceOf(KnowledgeAnswerOperationDeferredError);
    expect([...recorder.entries.values()].filter(({ state }) => state === "settled"))
      .toHaveLength(5);

    const resumed = vi.fn(async (operation, options):
      Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: outputForOperation(operation.name),
      providerResponseId: options.providerResponseId,
      usage
    }));
    const result = await executeKnowledgeAnswerGroundingV21({
      ...pipelineInput(recorder.lifecycle, resumed),
      recoveryProviderResponseIds: { 6: "recovered-response-6" }
    });

    expect(result.operations).toHaveLength(6);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(resumed.mock.calls[0]?.[1]).toEqual({
      providerResponseId: "recovered-response-6"
    });
  });

  it("keeps Draft text invisible after initial Selector provider failure and corrects once", async () => {
    const recorder = lifecycleRecorder();
    const providerFailure = new TypeError("selector transport failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let selectorFailed = false;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      if (operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21) {
        return {
          output: draftOutput("Alpha maintains ordering."),
          providerResponseId: "response-draft",
          usage
        };
      }
      if (operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17 && !selectorFailed) {
        selectorFailed = true;
        throw providerFailure;
      }
      return {
        output: operation.name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
          ? missingAuditOutput()
          : outputForOperation(operation.name),
        providerResponseId: `response-${operation.name}`,
        usage
      };
    });
    try {
      const result = await executeKnowledgeAnswerGroundingV21(
        pipelineInput(recorder.lifecycle, execute)
      );
      expect(result.operations.map(({ operation }) => operation)).toEqual([
        KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
        KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
        KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
        KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
        KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17
      ]);
      const auditRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
        recorder.entries.get(3)!.acceptedRequest
      );
      expect(auditRequest?.userPrompt).not.toContain("Alpha maintains ordering.");
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
        '"operation":"knowledge_grounded_selector_v17"'
      ));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses one bounded Auditor validation repair over the same authority inputs", async () => {
    const recorder = lifecycleRecorder();
    let auditCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      const output = operation.name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
        ? auditCalls++ === 0 ? {} : completeAuditOutput()
        : outputForOperation(operation.name, true);
      return { output, providerResponseId: `response-${operation.name}`, usage };
    });
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
    ]);
    const packed = manifest();
    const repairRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(4)!.acceptedRequest
    )!;
    expect(decodeKnowledgeCoverageAuditPromptV2({
      evidence: knowledgeSelectorEvidenceFromManifest(packed),
      evidenceManifest: packed.message,
      request,
      systemPrompt: repairRequest.systemPrompt,
      userPrompt: repairRequest.userPrompt
    })).toMatchObject({
      auditPass: "repair",
      repairReason: "coverage_audit_shape_invalid"
    });
  });

  it("records both malformed Audit passes and fails closed without correction", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
        ? {}
        : outputForOperation(operation.name, true),
      providerResponseId: `response-${operation.name}`,
      usage
    }));
    await expect(executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execute)
    )).rejects.toThrow("knowledge_coverage_audit_unaccepted");
    expect([...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!.operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
    ]);
  });

  it("does not retry an Auditor provider failure", async () => {
    const recorder = lifecycleRecorder();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      if (operation.name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION) {
        throw new TypeError("auditor transport failed");
      }
      return {
        output: outputForOperation(operation.name, true),
        providerResponseId: `response-${operation.name}`,
        usage
      };
    });
    try {
      await expect(executeKnowledgeAnswerGroundingV21(
        pipelineInput(recorder.lifecycle, execute)
      )).rejects.toThrow("knowledge_coverage_audit_unaccepted");
      expect(execute).toHaveBeenCalledTimes(3);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses all six calls for Auditor repair followed by one correction", async () => {
    const recorder = lifecycleRecorder();
    let auditCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      const output = operation.name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
        ? auditCalls++ === 0 ? {} : partialAuditOutput()
        : outputForOperation(operation.name);
      return { output, providerResponseId: `response-${operation.name}`, usage };
    });
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17
    ]);
  });

  it("does not start correction after both Selector and Auditor repairs consume the cap", async () => {
    const recorder = lifecycleRecorder();
    let selectorCalls = 0;
    let auditCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      let output: Readonly<Record<string, unknown>> = outputForOperation(operation.name);
      if (operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17 &&
        selectorCalls++ === 0) output = {};
      if (operation.name === KNOWLEDGE_COVERAGE_AUDITOR_OPERATION) {
        output = auditCalls++ === 0 ? {} : partialAuditOutput();
      }
      return { output, providerResponseId: `response-${operation.name}`, usage };
    });
    const result = await executeKnowledgeAnswerGroundingV21(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
      KNOWLEDGE_COVERAGE_AUDITOR_OPERATION
    ]);
    expect(result.settlement.requestCoverage).toBe("partial");
  });

  for (const interruptedOrdinal of [1, 2, 3, 4, 5] as const) {
    it(`resumes only the next missing operation after ordinal ${interruptedOrdinal}`, async () => {
      const recorder = lifecycleRecorder();
      let ordinal = 0;
      const first = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
        ordinal += 1;
        if (ordinal === interruptedOrdinal) throw new KnowledgeAnswerOperationDeferredError();
        return {
          output: outputForOperation(operation.name),
          providerResponseId: `first-response-${ordinal}`,
          usage
        };
      });
      await expect(executeKnowledgeAnswerGroundingV21(
        pipelineInput(recorder.lifecycle, first)
      )).rejects.toBeInstanceOf(KnowledgeAnswerOperationDeferredError);
      const settledPrefix = [...recorder.entries.values()].filter(
        ({ state }) => state === "settled"
      ).length;
      expect(settledPrefix).toBe(interruptedOrdinal - 1);
      const resumed = vi.fn(async (operation, options):
        Promise<KnowledgeAnswerOperationExecutionV21> => ({
          output: outputForOperation(operation.name),
          providerResponseId: options.providerResponseId ?? `new-${operation.name}`,
          usage
        }));
      const result = await executeKnowledgeAnswerGroundingV21({
        ...pipelineInput(recorder.lifecycle, resumed),
        recoveryProviderResponseIds: {
          [interruptedOrdinal]: `recovered-response-${interruptedOrdinal}`
        }
      });
      expect(result.operations).toHaveLength(5);
      expect(resumed).toHaveBeenCalledTimes(6 - interruptedOrdinal);
      expect(resumed.mock.calls[0]?.[1]).toEqual({
        providerResponseId: `recovered-response-${interruptedOrdinal}`
      });
    });
  }
});

function scopeOutput(complete: boolean) {
  return {
    evidenceReview: [{
      answerAtomIds: ["A1"],
      handle: "K1",
      otherAtomIds: []
    }, {
      answerAtomIds: complete ? [] : ["A2"],
      handle: "K2",
      otherAtomIds: complete ? ["A2"] : []
    }],
    scope: [{
      description: "Explain alpha.",
      evidenceAtomIds: ["A1"],
      id: "D1",
      requestAnchor: "alpha"
    }, ...(complete ? [] : [{
      description: "Explain beta.",
      evidenceAtomIds: ["A2"],
      id: "D2",
      requestAnchor: "beta"
    }])],
    version: 4
  };
}

function selectorV19Output(complete: boolean) {
  return {
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] },
      ...(complete ? [] : [{ id: "D2", status: "missing", supportIds: [] }])],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  };
}

function currentExecution(complete: boolean) {
  return vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
    output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
      ? draftOutput()
      : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION
        ? scopeOutput(complete)
        : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
          ? selectorV19Output(complete)
          : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
            ? draftOutput("Beta removes duplicates.", "K2")
            : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V19
              ? finalSelectorOutput()
              : (() => { throw new Error("unexpected_current_operation"); })(),
    providerResponseId: `response-${operation.name}`,
    usage
  }));
}

describe("V21 exhaustive atom-review Coverage Scope execution", () => {
  it("runs Draft, atom-reviewed Scope, then Selector and pins the Scope hash", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21ScopeV4(
      pipelineInput(recorder.lifecycle, currentExecution(true))
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
    ]);
    expect(result.settlement).toMatchObject({
      outcome: "answered",
      requestCoverage: "complete"
    });
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(snapshots.every(({ version }) => version === 4)).toBe(true);
    const acceptedScopeHash = knowledgeAnswerHash(scopeOutput(true));
    expect(snapshots.map((snapshot) => snapshot.version === 4
      ? snapshot.coverageScopePayloadHash
      : null)).toEqual([null, null, acceptedScopeHash]);
    const scopePayload = JSON.parse(snapshots[1]!.userPrompt) as Record<string, unknown>;
    expect(scopePayload).not.toHaveProperty("draft");
    expect(scopePayload).not.toHaveProperty("supportedView");
    expect(scopePayload).not.toHaveProperty("selectorState");
  });

  it("uses the same immutable Scope for correction and final selection", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21ScopeV4(
      pipelineInput(recorder.lifecycle, currentExecution(false))
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V19
    ]);
    expect(result.settlement).toMatchObject({
      outcome: "answered",
      requestCoverage: "complete",
      supportedClaimCount: 2
    });
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    const acceptedScopeHash = knowledgeAnswerHash(scopeOutput(false));
    expect(snapshots.slice(2).every((snapshot) => snapshot.version === 4 &&
      snapshot.coverageScopePayloadHash === acceptedScopeHash)).toBe(true);
  });

  it("repairs Scope and Selector structurally without starting an over-cap correction", async () => {
    const recorder = lifecycleRecorder();
    let scopeCalls = 0;
    let selectorCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? draftOutput()
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION
          ? scopeCalls++ === 0 ? {} : scopeOutput(false)
          : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
            ? selectorCalls++ === 0 ? {} : selectorV19Output(false)
            : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));
    const result = await executeKnowledgeAnswerGroundingV21ScopeV4(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_V4_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V19
    ]);
    expect(result.settlement.requestCoverage).toBe("partial");
    const packed = manifest();
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(decodeKnowledgeCoverageScopePromptV4({
      evidence: knowledgeCoverageEvidenceFromManifestV4(packed),
      evidenceManifest: packed.message,
      request,
      systemPrompt: snapshots[2]!.systemPrompt,
      userPrompt: snapshots[2]!.userPrompt
    })).toEqual({
      repairReason: "coverage_scope_shape_invalid",
      scopePass: "repair"
    });
    expect(JSON.parse(snapshots[4]!.userPrompt)).toMatchObject({
      repairReason: "selector_malformed",
      selectorPass: "repair"
    });
    const acceptedScopeHash = knowledgeAnswerHash(scopeOutput(false));
    expect(snapshots.slice(3).every((snapshot) => snapshot.version === 4 &&
      snapshot.coverageScopePayloadHash === acceptedScopeHash)).toBe(true);
  });
});
