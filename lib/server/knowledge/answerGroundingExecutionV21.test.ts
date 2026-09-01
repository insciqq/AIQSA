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
  executeKnowledgeAnswerGroundingV21 as executeKnowledgeAnswerGroundingV21ScopeV6
} from "./answerGroundingExecutionV21ScopeV6";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
  decodeKnowledgeAnswerOperationRequestSnapshotV21,
  isCurrentKnowledgeAnswerOperationSnapshotV21
} from "./answerGroundingV21";
import {
  KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
  decodeKnowledgeCoverageAuditPromptV2
} from "./coverageAuditV2";
import {
  KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
  knowledgeCoverageEvidenceFromManifestV6,
  validateKnowledgeCoverageScopeV6
} from "./coverageScopeV6";
import { KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2 } from "./coverageScopeV4";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
  validateKnowledgeCoverageScopeCompletenessV1
} from "./coverageScopeCompletenessV1";
import {
  decodeKnowledgeCoverageScopeCompletenessPromptV2,
  decodeKnowledgeCoverageScopePromptV6QueryIntentV1
} from "./coverageScopeQueryIntentV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
} from "./coverageScopeClosureV1";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
} from "./answerGroundingSelectorV21";
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
      exactExcerpt: "Beta removes duplicates. Beta preserves stability.",
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
    evidenceUnits: [{
      findings: [{
        description: "Explain alpha.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "alpha"
      }],
      handle: "K1"
    }, {
      findings: complete ? [] : [{
        description: "Explain beta.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "beta"
      }],
      handle: "K2"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  };
}

function selectorV21Output(complete: boolean) {
  return {
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] },
      ...(complete ? [] : [{ id: "D2", status: "missing", supportIds: [] }])],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  };
}

function acceptedScope(complete: boolean) {
  const packed = manifest();
  const evidence = knowledgeCoverageEvidenceFromManifestV6(packed);
  const validation = validateKnowledgeCoverageScopeV6(
    scopeOutput(complete),
    { evidence, request }
  );
  if (validation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  return validation.value;
}

function closureOutput(...dimensionIds: string[]) {
  return {
    decisions: dimensionIds.map((id) => ({ id, status: "closed" as const })),
    version: 1 as const
  };
}

function currentExecution(complete: boolean) {
  return vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
    output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
      ? draftOutput()
      : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
        ? scopeOutput(complete)
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
          ? { additions: [], version: 1 }
        : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
          ? selectorV21Output(complete)
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
            ? closureOutput("D1")
          : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
            ? {
                targets: { D2: ["Beta removes duplicates."] },
                version: 2
              }
            : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
              ? finalSelectorOutput()
              : (() => { throw new Error("unexpected_current_operation"); })(),
    providerResponseId: `response-${operation.name}`,
    usage
  }));
}

describe("V21 positive-finding Coverage Scope execution", () => {
  it("vetoes a false-positive target without publishing its contradicted supplement", async () => {
    const recorder = lifecycleRecorder();
    const falseTargetScope = {
      ...scopeOutput(false),
      evidenceUnits: [{
        ...scopeOutput(false).evidenceUnits[0]
      }, {
        ...scopeOutput(false).evidenceUnits[1],
        findings: [{
          description: "Explain variability in beta compensation.",
          evidenceAtomIds: ["A2"],
          requestAnchor: "beta"
        }]
      }]
    };
    const execute = vi.fn(async (operation):
      Promise<KnowledgeAnswerOperationExecutionV21> => ({
        output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
          ? draftOutput()
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
            ? falseTargetScope
            : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
              ? { additions: [], version: 1 }
              : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
                ? selectorV21Output(false)
                : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
                  ? closureOutput("D1")
                  : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
                    ? {
                        targets: {
                          D2: ["Beta compensation varies with stochastic fees."]
                        },
                        version: 2
                      }
                    : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
                      ? {
                          claims: [{
                            id: "C1",
                            supportHandles: ["K1"],
                            verdict: "supported"
                          }, {
                            id: "C2",
                            supportHandles: [],
                            verdict: "contradicted"
                          }],
                          coverage: [{
                            id: "D1", status: "covered", supportIds: ["C1"]
                          }, {
                            id: "D2", status: "excluded", supportIds: []
                          }],
                          extractIds: [],
                          insufficientReason: "not_applicable",
                          version: 1
                        }
                      : (() => { throw new Error("unexpected_current_operation"); })(),
        providerResponseId: `response-${operation.name}`,
        usage
      }));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.settlement).toMatchObject({
      requestCoverage: "complete",
      supportedClaimCount: 1
    });
    expect(result.settlement.finalText).toContain("Alpha preserves order.");
    expect(result.settlement.finalText).not.toContain("compensation varies");
  });

  it("runs Draft, positive-finding Scope, then Selector and pins its hash", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, currentExecution(true))
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
    ]);
    expect(result.settlement).toMatchObject({
      outcome: "answered",
      requestCoverage: "complete"
    });
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(snapshots.every(isCurrentKnowledgeAnswerOperationSnapshotV21)).toBe(true);
    const acceptedScopeHash = knowledgeAnswerHash(acceptedScope(true));
    expect(snapshots.map((snapshot) => isCurrentKnowledgeAnswerOperationSnapshotV21(snapshot)
      ? snapshot.coverageScopePayloadHash
      : null)).toEqual([null, null, acceptedScopeHash, acceptedScopeHash,
        acceptedScopeHash]);
    const scopePayload = JSON.parse(snapshots[1]!.userPrompt) as Record<string, unknown>;
    expect(scopePayload).not.toHaveProperty("draft");
    expect(scopePayload).not.toHaveProperty("supportedView");
    expect(scopePayload).not.toHaveProperty("selectorState");
  });

  it("canonicalizes a surplus disjoint Selector edge without consuming repair", async () => {
    const recorder = lifecycleRecorder();
    let selectorCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? {
            claims: [{ citationHints: ["K1"], text: "Alpha preserves order." }, {
              citationHints: ["K2"],
              text: "Beta removes duplicates."
            }],
            version: 1
          }
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? scopeOutput(true)
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? { additions: [], version: 1 }
            : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
              ? (() => {
                  selectorCalls += 1;
                  return {
                  claims: [{
                    id: "C1",
                    supportHandles: ["K1"],
                    verdict: "supported"
                  }, {
                    id: "C2",
                    supportHandles: ["K2"],
                    verdict: "supported"
                  }],
                  coverage: [{
                    id: "D1",
                    status: "covered",
                    supportIds: ["C1", "C2"]
                  }],
                  extractIds: [],
                  insufficientReason: "not_applicable",
                  version: 1
                  };
                })()
              : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
                ? closureOutput("D1")
              : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(selectorCalls).toBe(1);
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
    ]);
    expect(recorder.entries.get(4)?.acceptedResult).toMatchObject({
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }]
    });
    expect(result.settlement.finalText).toContain("Alpha preserves order.");
    expect(result.settlement.finalText).not.toContain("Beta removes duplicates.");
  });

  it("uses the same immutable Scope for correction and final selection", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, currentExecution(false))
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
    ]);
    expect(result.settlement).toMatchObject({
      outcome: "answered",
      requestCoverage: "complete",
      supportedClaimCount: 2
    });
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    const acceptedScopeHash = knowledgeAnswerHash(acceptedScope(false));
    expect(snapshots.slice(2).every((snapshot) =>
      isCurrentKnowledgeAnswerOperationSnapshotV21(snapshot) &&
      snapshot.coverageScopePayloadHash === acceptedScopeHash)).toBe(true);
    expect(JSON.parse(snapshots[5]!.userPrompt)).toMatchObject({
      targetEvidenceAtomIndex: {
        atoms: [{
          contextRole: "exact_excerpt",
          handle: "K2",
          id: "A2",
          text: "Beta removes duplicates."
        }],
        targets: [{ evidenceAtomIds: ["A2"], targetDimensionId: "D2" }],
        version: 2
      }
    });
  });

  it("settles a compound target from multiple atomic target-bound claims", async () => {
    const recorder = lifecycleRecorder();
    const compoundScope = {
      evidenceUnits: [{
        findings: [{
          description: "Explain alpha.",
          evidenceAtomIds: ["A1"],
          requestAnchor: "alpha"
        }],
        handle: "K1"
      }, {
        findings: [{
          description: "Explain how beta removes duplicates and preserves stability.",
          evidenceAtomIds: ["A2", "A3"],
          requestAnchor: "beta"
        }],
        handle: "K2"
      }],
      jointFindings: [],
      unsupportedDimensions: [],
      version: 6
    } as const;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? draftOutput()
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? compoundScope
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? { additions: [], version: 1 }
            : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
              ? selectorV21Output(false)
              : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
                ? closureOutput("D1")
              : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
                ? {
                    targets: {
                      D2: ["Beta removes duplicates.", "Beta preserves stability."]
                    },
                    version: 2
                  }
                : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
                  ? {
                      claims: [{
                        id: "C1",
                        supportHandles: ["K1"],
                        verdict: "supported"
                      }, {
                        id: "C2",
                        supportHandles: ["K2"],
                        verdict: "supported"
                      }, {
                        id: "C3",
                        supportHandles: ["K2"],
                        verdict: "supported"
                      }],
                      coverage: [{
                        id: "D1", status: "covered", supportIds: ["C1"]
                      }, {
                        id: "D2", status: "covered", supportIds: ["C2", "C3"]
                      }],
                      extractIds: [],
                      insufficientReason: "not_applicable",
                      version: 1
                    }
                  : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.settlement).toMatchObject({
      requestCoverage: "complete",
      supportedClaimCount: 3
    });
    expect(result.settlement.finalText).toContain("Beta removes duplicates.");
    expect(result.settlement.finalText).toContain("Beta preserves stability.");
    expect(recorder.entries.get(7)?.acceptedResult).toMatchObject({
      coverage: [{ id: "D1", supportIds: ["C1"] }, {
        id: "D2", status: "covered", supportIds: ["C2", "C3"]
      }]
    });
    const finalSnapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(7)?.acceptedRequest
    );
    expect(finalSnapshot?.systemPrompt).toContain("ordered union entails every material part");
    expect(finalSnapshot?.systemPrompt).toContain("one or more supported claims");
  });

  it("reopens a falsely closed compound target before targeted correction", async () => {
    const recorder = lifecycleRecorder();
    const compoundScope = {
      evidenceUnits: [{
        findings: [{
          description: "Explain alpha.",
          evidenceAtomIds: ["A1"],
          requestAnchor: "alpha"
        }],
        handle: "K1"
      }, {
        findings: [{
          description: "Explain how beta removes duplicates and preserves stability.",
          evidenceAtomIds: ["A2", "A3"],
          requestAnchor: "beta"
        }],
        handle: "K2"
      }],
      jointFindings: [],
      unsupportedDimensions: [],
      version: 6
    } as const;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? {
            claims: [{ citationHints: ["K1"], text: "Alpha preserves order." }, {
              citationHints: ["K2"],
              text: "Beta removes duplicates."
            }],
            version: 1
          }
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? compoundScope
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? { additions: [], version: 1 }
            : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
              ? {
                  claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
                    id: "C2", supportHandles: ["K2"], verdict: "supported"
                  }],
                  coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
                    id: "D2", status: "covered", supportIds: ["C2"]
                  }],
                  extractIds: [],
                  insufficientReason: "not_applicable",
                  version: 1
                }
              : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
                ? {
                    decisions: [{ id: "D1", status: "closed" }, {
                      id: "D2", status: "missing"
                    }],
                    version: 1
                  }
                : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
                  ? {
                      targets: {
                        D2: ["Beta removes duplicates and preserves stability."]
                      },
                      version: 2
                    }
                  : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
                    ? {
                        claims: [{
                          id: "C1", supportHandles: ["K1"], verdict: "supported"
                        }, {
                          id: "C2", supportHandles: ["K2"], verdict: "supported"
                        }, {
                          id: "C3", supportHandles: ["K2"], verdict: "supported"
                        }],
                        coverage: [{
                          id: "D1", status: "covered", supportIds: ["C1"]
                        }, {
                          id: "D2", status: "covered", supportIds: ["C2", "C3"]
                        }],
                        extractIds: [],
                        insufficientReason: "not_applicable",
                        version: 1
                      }
                    : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
    ]);
    expect(recorder.entries.get(5)?.acceptedResult).toEqual({
      decisions: [{ id: "D1", status: "closed" }, {
        id: "D2", status: "missing"
      }],
      version: 1
    });
    expect(recorder.entries.get(6)?.acceptedResult).toMatchObject({
      targets: { D2: ["Beta removes duplicates and preserves stability."] }
    });
    expect(result.settlement).toMatchObject({
      requestCoverage: "complete",
      supportedClaimCount: 2
    });
    expect(result.settlement.finalText).toContain(
      "Beta removes duplicates and preserves stability."
    );
  });

  it("repairs a malformed closure once and does not bypass the gate", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(true);
    let closureCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> =>
      operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION &&
        closureCalls++ === 0
        ? {
            output: {},
            providerResponseId: "response-malformed-closure",
            usage
          }
        : baseline(operation));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
    ]);
    expect(result.settlement.requestCoverage).toBe("complete");
    const repairSnapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(6)?.acceptedRequest
    );
    expect(JSON.parse(repairSnapshot!.userPrompt)).toMatchObject({
      closurePass: "repair",
      repairReason: "coverage_scope_closure_shape_invalid"
    });
  });

  it("adds an omitted cross-unit relation before targeted correction", async () => {
    const recorder = lifecycleRecorder();
    const completenessOutput = {
      additions: [{
        description: "Explain how alpha and beta work together.",
        evidenceAtomIds: ["A1", "A2"],
        requestAnchor: "alpha and beta"
      }],
      version: 1
    } as const;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? draftOutput()
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? scopeOutput(true)
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? completenessOutput
              : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
              ? {
                  claims: [{
                    id: "C1",
                    supportHandles: ["K1"],
                    verdict: "supported"
                  }],
                  coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
                    id: "D2", status: "missing", supportIds: []
                  }],
                  extractIds: [],
                  insufficientReason: "not_applicable",
                  version: 1
                }
              : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
                ? closureOutput("D1")
              : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
                ? {
                    targets: {
                      D2: ["Alpha preserves order while beta removes duplicates."]
                    },
                    version: 2
                  }
                : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
                  ? {
                      claims: [{
                        id: "C1",
                        supportHandles: ["K1"],
                        verdict: "supported"
                      }, {
                        id: "C2",
                        supportHandles: ["K1", "K2"],
                        verdict: "supported"
                      }],
                      coverage: [{
                        id: "D1", status: "covered", supportIds: ["C1"]
                      }, {
                        id: "D2", status: "covered", supportIds: ["C2"]
                      }],
                      extractIds: [],
                      insufficientReason: "not_applicable",
                      version: 1
                    }
                  : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
    ]);
    expect(result.settlement).toMatchObject({
      requestCoverage: "complete",
      supportedClaimCount: 2
    });
    const initialScope = acceptedScope(true);
    const completeness = validateKnowledgeCoverageScopeCompletenessV1(
      completenessOutput,
      {
        acceptedScope: initialScope,
        evidence: knowledgeCoverageEvidenceFromManifestV6(manifest()),
        request
      }
    );
    expect(completeness.kind).toBe("accepted");
    if (completeness.kind !== "accepted") throw new Error("fixture_completeness_invalid");
    const initialScopeHash = knowledgeAnswerHash(initialScope);
    const mergedScopeHash = knowledgeAnswerHash(completeness.scope);
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(snapshots[2]).toMatchObject({
      coverageScopePayloadHash: initialScopeHash
    });
    expect(snapshots.slice(3).every((snapshot) =>
      isCurrentKnowledgeAnswerOperationSnapshotV21(snapshot) &&
      snapshot.coverageScopePayloadHash === mergedScopeHash)).toBe(true);
    expect(JSON.parse(snapshots[3]!.userPrompt)).toMatchObject({
      coverageScope: {
        scope: [{ id: "D1" }, {
          evidenceAtomIds: ["A1", "A2"],
          evidenceHandles: ["K1", "K2"],
          id: "D2"
        }]
      },
      targetClosureProtocol: { version: 1 }
    });
    expect(snapshots[3]!.systemPrompt).toContain(
      "grounded_selector_target_closure_contract"
    );
    expect(JSON.parse(snapshots[5]!.userPrompt)).toMatchObject({
      targetClosureProtocol: { version: 1 },
      version: 5
    });
    expect(snapshots[5]!.systemPrompt).toContain(
      'knowledge_targeted_supplement_contract version="5"'
    );
    expect(snapshots[5]!.systemPrompt).toContain(
      "Omit an unsupported connector"
    );
    expect(JSON.parse(snapshots[6]!.userPrompt)).toMatchObject({
      selectorPass: "final_delta_least_authority",
      targetVerificationProtocol: {
        evidenceAuthority: "target_atoms_only",
        version: 1
      },
      version: 4
    });
    expect(snapshots[6]!.systemPrompt).toContain(
      'grounded_delta_selector_contract version="4"'
    );
    expect(JSON.parse(snapshots[6]!.userPrompt)).not.toHaveProperty("evidenceManifest");
    expect(JSON.parse(snapshots[6]!.userPrompt)).not.toHaveProperty("draft");
  });

  it("uses one bounded final-delta review when verified target claims are unmapped", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    let finalCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      if (operation.name !== KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21) {
        return baseline(operation);
      }
      finalCalls += 1;
      return {
        output: finalCalls === 1 ? {
          ...finalSelectorOutput(),
          coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
            id: "D2", status: "missing", supportIds: []
          }]
        } : finalSelectorOutput(),
        providerResponseId: `response-final-${finalCalls}`,
        usage
      };
    });

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(finalCalls).toBe(2);
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
    ]);
    expect(recorder.entries.get(7)?.acceptedResult).toEqual({
      kind: "selector_failed",
      reason: "selector_coverage_invalid"
    });
    expect(result.settlement.requestCoverage).toBe("complete");
    const repairSnapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(8)?.acceptedRequest
    )!;
    expect(JSON.parse(repairSnapshot.userPrompt)).toMatchObject({
      repairReason: "selector_coverage_invalid",
      selectorPass: "final_delta_least_authority_repair"
    });
  });

  it("drops a foreign-provenance finding without a whole-Scope retry", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    let scopeCalls = 0;
    const execute = vi.fn(async (
      operation
    ): Promise<KnowledgeAnswerOperationExecutionV21> =>
      operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION && scopeCalls++ === 0
        ? {
            output: {
              ...scopeOutput(false),
              evidenceUnits: [{
                ...scopeOutput(false).evidenceUnits[0],
                findings: [
                  ...scopeOutput(false).evidenceUnits[0]!.findings,
                  {
                    description: "Do not attribute beta evidence to alpha.",
                    evidenceAtomIds: ["A2"],
                    requestAnchor: "alpha"
                  }
                ]
              }, scopeOutput(false).evidenceUnits[1]]
            },
            providerResponseId: "response-invalid-local-provenance",
            usage
          }
        : baseline(operation));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(scopeCalls).toBe(1);
    expect(result.operations.filter(({ operation }) =>
      operation === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION)).toHaveLength(1);
    expect(recorder.entries.get(2)?.acceptedResult).toEqual(scopeOutput(false));
    expect(JSON.stringify(recorder.entries.get(2)?.acceptedResult)).not.toContain(
      "Do not attribute beta evidence"
    );
    expect(result.settlement.requestCoverage).toBe("complete");
  });

  it("reserves both correction calls after one structural repair and closure veto", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    let scopeCalls = 0;
    const execute = vi.fn(async (
      operation
    ): Promise<KnowledgeAnswerOperationExecutionV21> =>
      operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION && scopeCalls++ === 0
        ? {
            output: {
              ...scopeOutput(false),
              evidenceUnits: [{
                ...scopeOutput(false).evidenceUnits[0],
                findings: [{
                ...scopeOutput(false).evidenceUnits[0]!.findings[0]!,
                  requestAnchor: "missing request anchor"
                }]
              }, {
                ...scopeOutput(false).evidenceUnits[1],
                findings: [{
                  ...scopeOutput(false).evidenceUnits[1]!.findings[0]!,
                  requestAnchor: "second missing request anchor"
                }]
              }]
            },
            providerResponseId: "response-invalid-scope",
            usage
          }
        : baseline(operation));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
    ]);
    expect(result.settlement).toMatchObject({
      requestCoverage: "complete",
      supportedClaimCount: 2
    });
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(snapshots).toHaveLength(8);
    expect(snapshots.every(isCurrentKnowledgeAnswerOperationSnapshotV21)).toBe(true);
    const packed = manifest();
    expect(decodeKnowledgeCoverageScopePromptV6QueryIntentV1({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence: knowledgeCoverageEvidenceFromManifestV6(packed),
      evidenceManifest: packed.message,
      request,
      systemPrompt: snapshots[2]!.systemPrompt,
      userPrompt: snapshots[2]!.userPrompt
    })).toEqual({
      repairBaseHash: knowledgeAnswerHash({
        ...scopeOutput(false),
        evidenceUnits: [{
          ...scopeOutput(false).evidenceUnits[0],
          findings: [{
            ...scopeOutput(false).evidenceUnits[0]!.findings[0]!,
            requestAnchor: "missing request anchor"
          }]
        }, {
          ...scopeOutput(false).evidenceUnits[1],
          findings: [{
            ...scopeOutput(false).evidenceUnits[1]!.findings[0]!,
            requestAnchor: "second missing request anchor"
          }]
        }]
      }),
      repairDiagnostics: [{
        actualCount: null,
        code: "anchor_invalid",
        expectedHandle: null,
        maximumCount: null,
        path: "/evidenceUnits/0/findings/0/requestAnchor",
        version: 1
      }, {
        actualCount: null,
        code: "anchor_invalid",
        expectedHandle: null,
        maximumCount: null,
        path: "/evidenceUnits/1/findings/0/requestAnchor",
        version: 1
      }],
      repairReason: "coverage_scope_anchor_invalid",
      scopePass: "repair"
    });
    expect(snapshots[2]!.userPrompt).not.toContain("Explain alpha.");
    expect(snapshots[2]!.userPrompt).not.toContain("second missing request anchor");
    expect(recorder.entries.get(2)!.acceptedResult).toMatchObject({
      repairBaseHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(JSON.stringify(recorder.entries.get(2)!.acceptedResult))
      .not.toContain("Explain alpha.");
    expect(snapshots[5]).toMatchObject({
      operation: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      version: 29
    });
    expect(snapshots[6]).toMatchObject({
      operation: KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      version: 29
    });
    expect(snapshots[7]).toMatchObject({
      operation: KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21,
      version: 29
    });
  });

  it("fails closed when recovery lost a transient verified-patch base", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    const invalidScope = {
      ...scopeOutput(false),
      evidenceUnits: [{
        ...scopeOutput(false).evidenceUnits[0],
        findings: [{
          ...scopeOutput(false).evidenceUnits[0]!.findings[0]!,
          requestAnchor: "missing request anchor"
        }]
      }, scopeOutput(false).evidenceUnits[1]]
    };
    let scopeCalls = 0;
    const first = vi.fn(async (
      operation
    ): Promise<KnowledgeAnswerOperationExecutionV21> => {
      if (operation.name !== KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION) {
        return baseline(operation);
      }
      if (scopeCalls++ === 0) {
        return {
          output: invalidScope,
          providerResponseId: "response-invalid-scope",
          usage
        };
      }
      throw new KnowledgeAnswerOperationDeferredError();
    });
    await expect(executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, first)
    )).rejects.toBeInstanceOf(KnowledgeAnswerOperationDeferredError);
    expect(recorder.entries.get(2)?.state).toBe("settled");
    expect(recorder.entries.get(3)?.state).toBe("dispatched");

    const resumed = vi.fn(async (
      operation
    ): Promise<KnowledgeAnswerOperationExecutionV21> => baseline(operation));
    await expect(executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, resumed)
    )).rejects.toThrow("knowledge_coverage_scope_repair_base_unavailable");
    expect(resumed).not.toHaveBeenCalled();
  });

  it("repairs malformed completeness once over the unchanged initial Scope", async () => {
    const recorder = lifecycleRecorder();
    let completenessCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? draftOutput()
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? scopeOutput(true)
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? completenessCalls++ === 0 ? {} : { additions: [], version: 1 }
            : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
              ? selectorV21Output(true)
              : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
                ? closureOutput("D1")
              : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
    ]);
    expect(result.settlement.requestCoverage).toBe("complete");
    const packed = manifest();
    const initialScope = acceptedScope(true);
    const repairRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(4)?.acceptedRequest
    );
    expect(decodeKnowledgeCoverageScopeCompletenessPromptV2({
      acceptedScope: initialScope,
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence: knowledgeCoverageEvidenceFromManifestV6(packed),
      evidenceManifest: packed.message,
      request,
      systemPrompt: repairRequest!.systemPrompt,
      userPrompt: repairRequest!.userPrompt
    })).toEqual({
      completenessPass: "repair",
      repairReason: "coverage_scope_completeness_shape_invalid"
    });
    const initialScopeHash = knowledgeAnswerHash(initialScope);
    expect([3, 4, 5, 6].every((ordinal) => {
      const snapshot = decodeKnowledgeAnswerOperationRequestSnapshotV21(
        recorder.entries.get(ordinal)?.acceptedRequest
      );
      return snapshot && isCurrentKnowledgeAnswerOperationSnapshotV21(snapshot) &&
        snapshot.coverageScopePayloadHash === initialScopeHash;
    })).toBe(true);
  });

  it("derives supplemental Draft provenance from the immutable target", async () => {
    const recorder = lifecycleRecorder();
    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, currentExecution(false))
    );
    expect(result.operations).toHaveLength(7);
    expect(result.settlement).toMatchObject({
      requestCoverage: "complete",
      supportedClaimCount: 2
    });
    expect(recorder.entries.get(6)?.acceptedResult).toMatchObject({
      targets: { D2: ["Beta removes duplicates."] },
      version: 2
    });
    const finalRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      recorder.entries.get(7)?.acceptedRequest
    );
    const finalPayload = JSON.parse(finalRequest!.userPrompt);
    expect(finalPayload).toMatchObject({
      supplementalClaims: [{ id: "C2", text: "Beta removes duplicates." }],
      targetEvidenceAtomIndex: {
        atoms: [{ handle: "K2", id: "A2" }],
        targets: [{ evidenceAtomIds: ["A2"], targetDimensionId: "D2" }]
      }
    });
    expect(finalPayload).not.toHaveProperty("draft");
    expect(finalPayload).not.toHaveProperty("evidenceManifest");
  });

  it("canonicalizes harmless Draft presentation before durable acceptance", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      if (operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21) {
        return {
          output: {
            claims: [{
              citationHints: ["K1"],
              text: "\n- **Alpha preserves order.** [K1]\n"
            }],
            version: 1
          },
          providerResponseId: "response-formatted-primary",
          usage
        };
      }
      if (operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21) {
        return {
          output: {
            targets: {
              D2: ["\n- **Beta removes duplicates.** [K2]\n"]
            },
            version: 2
          },
          providerResponseId: "response-formatted-supplement",
          usage
        };
      }
      return baseline(operation);
    });

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.settlement.requestCoverage).toBe("complete");
    expect(recorder.entries.get(1)?.acceptedResult).toMatchObject({
      claims: [{ text: "Alpha preserves order." }]
    });
    expect(recorder.entries.get(6)?.acceptedResult).toMatchObject({
      targets: { D2: ["Beta removes duplicates."] },
      version: 2
    });
  });

  it("accepts literal mathematical subscripts in primary and corrective claims", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    const primaryText =
      "The maps X̃×_X Y and X̃×_X Z form two cartesian squares.";
    const supplementText =
      "The projections Y×_X Z and Y×_X W preserve the comparison.";
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => {
      if (operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21) {
        return {
          output: {
            claims: [{ citationHints: ["K1"], text: primaryText }],
            version: 1
          },
          providerResponseId: "response-math-primary",
          usage
        };
      }
      if (operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21) {
        return {
          output: { targets: { D2: [supplementText] }, version: 2 },
          providerResponseId: "response-math-supplement",
          usage
        };
      }
      return baseline(operation);
    });

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.settlement.requestCoverage).toBe("complete");
    expect(recorder.entries.get(1)?.acceptedResult).toMatchObject({
      claims: [{ text: primaryText }]
    });
    expect(recorder.entries.get(6)?.acceptedResult).toMatchObject({
      targets: { D2: [supplementText] }
    });
  });

  it("records a targeted supplement failure and stops before final selection", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> =>
      operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
        ? {
            output: {
              targets: { D1: ["Alpha preserves order."] },
              version: 2
            },
            providerResponseId: "response-invalid-targeted-supplement",
            usage
          }
        : baseline(operation));
    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations).toHaveLength(6);
    expect(result.settlement.requestCoverage).toBe("partial");
    expect(recorder.entries.get(6)?.acceptedResult).toEqual({
      kind: "targeted_supplement_failed",
      reason: "draft_target_set_invalid"
    });
  });

  it("preserves accepted coverage and rejects a supported cross-target mapping", async () => {
    const recorder = lifecycleRecorder();
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? draftOutput()
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? {
              evidenceUnits: [{
                findings: [{
                  description: "Explain alpha.",
                  evidenceAtomIds: ["A1"],
                  requestAnchor: "alpha"
                }],
                handle: "K1"
              }, {
                findings: [{
                  description: "Explain beta duplicate removal.",
                  evidenceAtomIds: ["A2"],
                  requestAnchor: "beta"
                }, {
                  description: "Explain beta stability.",
                  evidenceAtomIds: ["A3"],
                  requestAnchor: "beta"
                }],
                handle: "K2"
              }],
              jointFindings: [],
              unsupportedDimensions: [],
              version: 6
            }
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? { additions: [], version: 1 }
          : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
            ? {
                claims: [{
                  id: "C1",
                  supportHandles: ["K1"],
                  verdict: "supported"
                }],
                coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
                  id: "D2", status: "missing", supportIds: []
                }, {
                  id: "D3", status: "missing", supportIds: []
                }],
                extractIds: [],
                insufficientReason: "not_applicable",
                version: 1
              }
            : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
              ? closureOutput("D1")
            : operation.name === KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21
              ? {
                  targets: {
                    D2: ["Beta removes duplicates."],
                    D3: ["Beta preserves stability."]
                  },
                  version: 2
                }
              : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
                ? {
                    claims: [{ id: "C1", supportHandles: [], verdict: "unsupported" }, {
                      id: "C2", supportHandles: ["K2"], verdict: "supported"
                    }, {
                      id: "C3", supportHandles: ["K2"], verdict: "supported"
                    }],
                    coverage: [{ id: "D1", status: "missing", supportIds: [] }, {
                      id: "D2", status: "covered", supportIds: ["C2"]
                    }, {
                      id: "D3", status: "covered", supportIds: ["C2"]
                    }],
                    extractIds: [],
                    insufficientReason: "not_applicable",
                    version: 1
                  }
                : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));
    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.settlement).toMatchObject({
      requestCoverage: "partial",
      supportedClaimCount: 2
    });
    expect(result.settlement.finalText).toContain("Alpha preserves order.");
    expect(result.settlement.finalText).not.toContain("stability");
  });

  it("repairs Scope and Selector structurally without starting an over-cap correction", async () => {
    const recorder = lifecycleRecorder();
    let scopeCalls = 0;
    let selectorCalls = 0;
    const execute = vi.fn(async (operation): Promise<KnowledgeAnswerOperationExecutionV21> => ({
      output: operation.name === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
        ? draftOutput()
        : operation.name === KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION
          ? scopeCalls++ === 0 ? {} : scopeOutput(false)
          : operation.name === KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION
            ? { additions: [], version: 1 }
          : operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21
            ? selectorCalls++ === 0
              ? {
                  ...selectorV21Output(false),
                  coverage: [selectorV21Output(false).coverage[0]]
                }
              : selectorV21Output(false)
            : operation.name === KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
              ? closureOutput("D1")
            : (() => { throw new Error("unexpected_current_operation"); })(),
      providerResponseId: `response-${operation.name}`,
      usage
    }));
    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION
    ]);
    expect(result.settlement.requestCoverage).toBe("partial");
    const packed = manifest();
    const snapshots = [...recorder.entries.values()].map(({ acceptedRequest }) =>
      decodeKnowledgeAnswerOperationRequestSnapshotV21(acceptedRequest)!);
    expect(decodeKnowledgeCoverageScopePromptV6QueryIntentV1({
      atomIndexVersion: KNOWLEDGE_COVERAGE_ATOM_INDEX_VERSION_V2,
      evidence: knowledgeCoverageEvidenceFromManifestV6(packed),
      evidenceManifest: packed.message,
      request,
      systemPrompt: snapshots[2]!.systemPrompt,
      userPrompt: snapshots[2]!.userPrompt
    })).toEqual({
      repairBaseHash: null,
      repairDiagnostics: [{
        actualCount: null,
        code: "payload_shape",
        expectedHandle: null,
        maximumCount: null,
        path: "/",
        version: 1
      }],
      repairReason: "coverage_scope_shape_invalid",
      scopePass: "repair"
    });
    expect(JSON.parse(snapshots[5]!.userPrompt)).toMatchObject({
      repairDiagnostic: {
        actualCount: 1,
        code: "coverage_count",
        expectedCount: 2,
        expectedHandles: [],
        expectedId: null,
        path: "/coverage",
        version: 1
      },
      repairReason: "selector_dimension_invalid",
      selectorPass: "repair"
    });
    expect(recorder.entries.get(5)!.acceptedResult).toMatchObject({
      diagnostic: { code: "coverage_count", path: "/coverage" },
      kind: "selector_failed",
      reason: "selector_dimension_invalid"
    });
    const acceptedScopeHash = knowledgeAnswerHash(acceptedScope(false));
    expect(snapshots.slice(3).every((snapshot) =>
      isCurrentKnowledgeAnswerOperationSnapshotV21(snapshot) &&
      snapshot.coverageScopePayloadHash === acceptedScopeHash)).toBe(true);
  });

  it("downgrades an unknown Selector edge and keeps the correction reserve", async () => {
    const recorder = lifecycleRecorder();
    const baseline = currentExecution(false);
    let selectorCalls = 0;
    const execute = vi.fn(async (
      operation
    ): Promise<KnowledgeAnswerOperationExecutionV21> =>
      operation.name === KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21 &&
        selectorCalls++ === 0
        ? {
            output: {
              ...selectorV21Output(false),
              coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
                id: "D2",
                status: "covered",
                supportIds: ["C999"]
              }]
            },
            providerResponseId: "response-selector-unknown-edge",
            usage
          }
        : baseline(operation));

    const result = await executeKnowledgeAnswerGroundingV21ScopeV6(
      pipelineInput(recorder.lifecycle, execute)
    );

    expect(result.operations.map(({ operation }) => operation)).toEqual([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
      KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V21
    ]);
    expect(recorder.entries.get(4)?.acceptedResult).toMatchObject({
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }]
    });
    expect(JSON.stringify(recorder.entries.get(4)?.acceptedResult))
      .not.toContain("C999");
    expect(result.settlement.requestCoverage).toBe("complete");
  });
});
