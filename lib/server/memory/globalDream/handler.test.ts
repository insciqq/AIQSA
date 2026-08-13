import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import { MemoryExecutionError } from "../execution";
import {
  memoryFactConsolidationInputHash,
  memoryFactConsolidationOutputHash,
  memoryFactRelatedSnapshotHash,
  type MemoryFactConsolidationInput,
  type MemoryFactDecisionSnapshot,
  type MemoryRelatedFactSnapshot
} from "../learning/consolidation/contract";
import {
  MEMORY_FACT_CONSOLIDATION_TOOL_NAME,
  MEMORY_FACT_VERIFICATION_TOOL_NAME
} from "../learning/consolidation/prompt";
import {
  MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
  memoryGlobalDreamJobFingerprint,
  memoryGlobalDreamPlanStage,
  memoryGlobalDreamResultHash,
  type MemoryGlobalDreamSelection
} from "./contract";
import {
  createMemoryGlobalDreamHandler,
  type MemoryGlobalDreamHandlerDependencies
} from "./handler";
import type { MemoryGlobalDreamExecutionBinding } from "./repository";

const now = new Date("2026-08-11T12:00:00.000Z");

function semanticSelection(
  operation: "CONFLICT" | "REINFORCE"
): Extract<MemoryGlobalDreamSelection, { kind: "RECONCILE_PAIR" }> {
  const targetFactId = randomUUID();
  const targetVersionId = randomUUID();
  const same = operation === "REINFORCE";
  const relatedFacts: readonly MemoryRelatedFactSnapshot[] = [{
    canonicalKey: "user.preference.drink",
    category: "preference",
    currentVersionId: targetVersionId,
    id: targetFactId,
    scope: { targetId: null, type: "GLOBAL_USER" },
    state: "ACTIVE",
    versions: [{
      category: "preference",
      confidence: 0.95,
      directness: "DIRECT",
      displayText: "I prefer tea.",
      id: targetVersionId,
      importance: 0.4,
      languageCode: "en",
      latestEvidenceAt: "2026-08-10T10:00:00.000Z",
      modality: "PREFERENCE",
      sourceMode: "AUTOMATIC",
      state: "ACTIVE",
      structuredValue: { drink: "tea" },
      supportCount: 1,
      systemFrom: "2026-08-10T10:00:00.000Z",
      systemTo: null,
      validFrom: null,
      validTo: null
    }]
  }];
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate: {
      branchGeneration: 1,
      canonicalKey: "user.preference.drink",
      category: "preference",
      chatId: randomUUID(),
      confidence: 0.95,
      directness: "DIRECT",
      displayText: same ? "I prefer tea." : "I prefer coffee.",
      evidence: [{
        endOffset: same ? 13 : 16,
        messageId: randomUUID(),
        observedAt: "2026-08-11T10:00:00.000Z",
        quote: same ? "I prefer tea." : "I prefer coffee.",
        sourceTextHash: "a".repeat(64),
        startOffset: 0
      }],
      id: "b".repeat(64),
      importance: 0.4,
      languageCode: "en",
      modality: "PREFERENCE",
      negated: false,
      proposedValue: { drink: same ? "tea" : "coffee" },
      rawTemporalExpression: null,
      scope: { targetId: null, type: "GLOBAL_USER" },
      sensitivity: "NORMAL",
      sourceHash: "c".repeat(64),
      sourceProjectionVersion: "memory-fact-source-projection-v1",
      sourceRevision: 2,
      sourceTimezone: "UTC",
      temporalResolverVersion: null,
      temporalResolutionEvidence: null,
      validFrom: null,
      validTo: null
    },
    memoryRevision: 0,
    relatedFacts,
    relatedSnapshotHash
  };
  const input = {
    ...withoutHash,
    inputHash: memoryFactConsolidationInputHash(withoutHash)
  };
  const snapshotHash = "d".repeat(64);
  return {
    input,
    kind: "RECONCILE_PAIR",
    resultHash: memoryGlobalDreamResultHash({ kind: "RECONCILE_PAIR", snapshotHash }),
    scopeChanged: false,
    snapshotHash,
    sourceEvidenceIds: [randomUUID()],
    sourceFactId: randomUUID(),
    sourceVersionId: randomUUID(),
    targetEvidenceIds: [randomUUID()],
    targetFactId,
    targetVersionId
  };
}

function claim(selection: MemoryGlobalDreamSelection): MemoryJobClaim {
  const idempotencyFingerprint = selection.kind === "RECONCILE_PAIR"
    ? memoryGlobalDreamJobFingerprint({
        kind: selection.kind,
        snapshotHash: selection.snapshotHash,
        sourceFactId: selection.sourceFactId,
        targetFactId: selection.targetFactId
      })
    : selection.kind === "REVISIT_DEFERRED"
      ? memoryGlobalDreamJobFingerprint({
          candidateId: selection.input.candidate.id,
          kind: selection.kind,
          snapshotHash: selection.snapshotHash
        })
      : memoryGlobalDreamJobFingerprint({
        factId: selection.factId,
        kind: selection.kind,
        snapshotHash: selection.snapshotHash
      });
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: randomUUID(),
    id: randomUUID(),
    idempotencyFingerprint,
    kind: "GLOBAL_DREAM",
    leaseExpiresAt: new Date("2026-08-11T12:05:00.000Z"),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 8,
    pipelineVersion: MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId: randomUUID()
  };
}

function fixture(selection: MemoryGlobalDreamSelection) {
  const bind = vi.fn(async (_userId: string, request: { role: string }) => ({
    id: request.role === "MEMORY_VERIFY" ? "verify-binding" : "consolidate-binding"
  }));
  const start = vi.fn(async (_userId: string, bindingId: string) => ({
    bindingId,
    snapshot: {
      logicalRole: bindingId === "verify-binding" ? "MEMORY_VERIFY" : "MEMORY_CONSOLIDATE",
      providerExecutionSnapshot: {
        connectionId: "connection-1",
        credentialId: "credential-1",
        credentialVersionId: "credential-version-1",
        providerModelId: "model-1"
      },
      requiresStrictStructuredOutput: true
    }
  }));
  const settle = vi.fn(async () => ({ state: "SUCCEEDED" }));
  const run = vi.fn(async (_evidence: unknown, request: {
    input: MemoryFactConsolidationInput | { decision: MemoryFactDecisionSnapshot };
    kind: "CONSOLIDATE" | "VERIFY";
  }) => {
    const semantic = selection as Extract<
      MemoryGlobalDreamSelection,
      { kind: "RECONCILE_PAIR" }
    >;
    if (request.kind === "CONSOLIDATE") {
      const operation = semantic.input.candidate.displayText.includes("coffee")
        ? "CONFLICT"
        : "REINFORCE";
      return {
        providerResponseId: "response-consolidate",
        toolCalls: [{
          arguments: {
            candidate_id: semantic.input.candidate.id,
            effective_from: null,
            evidence_ids: semantic.input.candidate.evidence.map(({ messageId }) => messageId),
            operation,
            reason_code: operation === "CONFLICT"
              ? "simultaneous_contradiction"
              : "same_current_value",
            target_fact_id: semantic.targetFactId,
            target_version_id: semantic.targetVersionId
          },
          id: "call-consolidate",
          name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME
        }],
        usage: {
          cachedInputTokens: 2,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 1,
          totalTokens: 15
        }
      };
    }
    const verificationInput = request.input as { decision: MemoryFactDecisionSnapshot };
    return {
      providerResponseId: "response-verify",
      toolCalls: [{
        arguments: {
          candidate_id: semantic.input.candidate.id,
          decision_id: verificationInput.decision.id,
          reason_code: "supported_transition",
          verdict: "APPROVE"
        },
        id: "call-verify",
        name: MEMORY_FACT_VERIFICATION_TOOL_NAME
      }],
      usage: {
        cachedInputTokens: 1,
        inputTokens: 8,
        outputTokens: 3,
        reasoningTokens: 0,
        totalTokens: 11
      }
    };
  });
  const apply = vi.fn(async () => undefined);
  const repository = {
    apply,
    consolidationBindings: vi.fn(async (): Promise<MemoryGlobalDreamExecutionBinding[]> => []),
    preflight: vi.fn(async () => ({ status: "READY" as const })),
    prepare: vi.fn(async () => ({ selection })),
    verificationBindings: vi.fn(async (): Promise<MemoryGlobalDreamExecutionBinding[]> => [])
  };
  const probeAuthority = vi.fn(async () => undefined);
  const deps = {
    execution: {
      admission: { bind, start },
      lifecycle: { settle }
    },
    probeAuthority,
    provider: { run },
    repository
  } as unknown as MemoryGlobalDreamHandlerDependencies;
  return { apply, deps, probeAuthority, repository, run, settle };
}

function context() {
  return {
    now: () => new Date(now),
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

describe("Global Dream handler", () => {
  it("applies a local invalid-evidence action with zero provider calls", async () => {
    const snapshotHash = "e".repeat(64);
    const selection: MemoryGlobalDreamSelection = {
      factId: randomUUID(),
      kind: "RETRACT_INVALID",
      resultHash: memoryGlobalDreamResultHash({ kind: "RETRACT_INVALID", snapshotHash }),
      snapshotHash,
      versionId: randomUUID()
    };
    const test = fixture(selection);
    const job = claim(selection);
    const result = await createMemoryGlobalDreamHandler(test.deps)
      .execute(job, context());
    expect(test.run).not.toHaveBeenCalled();
    expect(test.settle).not.toHaveBeenCalled();
    await result.apply?.({} as never, job);
    expect(test.apply).toHaveBeenCalledWith(
      expect.anything(),
      job,
      selection,
      null,
      null,
      now
    );
  });

  it("reconciles an equivalent pair with one qualified consolidation call", async () => {
    const selection = semanticSelection("REINFORCE");
    const test = fixture(selection);
    const job = claim(selection);
    const result = await createMemoryGlobalDreamHandler(test.deps)
      .execute(job, context());
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.run.mock.calls[0]?.[1]).toMatchObject({ kind: "CONSOLIDATE" });
    expect(test.settle).toHaveBeenCalledWith(
      job.userId,
      "consolidate-binding",
      expect.objectContaining({
        state: "SUCCEEDED",
        usage: expect.objectContaining({ completeness: "COMPLETE", totalTokens: 15 })
      })
    );
    await result.apply?.({} as never, job);
    expect(test.apply).toHaveBeenCalledWith(
      expect.anything(),
      job,
      selection,
      expect.objectContaining({ bindingId: "consolidate-binding" }),
      null,
      now
    );
  });

  it("applies a legacy conflict with one consolidation call and no verifier", async () => {
    const selection = semanticSelection("CONFLICT");
    const test = fixture(selection);
    const job = claim(selection);
    const result = await createMemoryGlobalDreamHandler(test.deps)
      .execute(job, context());
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.run.mock.calls.map((call) => call[1].kind)).toEqual(["CONSOLIDATE"]);
    await result.apply?.({} as never, job);
    expect(test.apply).toHaveBeenCalledWith(
      expect.anything(),
      job,
      selection,
      expect.objectContaining({ bindingId: "consolidate-binding" }),
      null,
      now
    );
  });

  it("recovers a succeeded consolidation from its bounded stage without another call", async () => {
    const selection = semanticSelection("REINFORCE");
    const test = fixture(selection);
    const target = selection.input.relatedFacts[0]!;
    const withoutHash = {
      candidateId: selection.input.candidate.id,
      effectiveFrom: null,
      evidenceIds: selection.input.candidate.evidence.map(({ messageId }) => messageId),
      operation: "REINFORCE" as const,
      reasonCode: "same_current_value" as const,
      targetFactId: target.id,
      targetVersionId: target.currentVersionId
    };
    const plan = {
      ...withoutHash,
      outputHash: memoryFactConsolidationOutputHash(selection.input, withoutHash)
    };
    const job = {
      ...claim(selection),
      recoveredLease: true,
      stage: memoryGlobalDreamPlanStage(selection.input, plan)
    };
    test.repository.consolidationBindings.mockResolvedValueOnce([{
      acceptedOutputHash: plan.outputHash,
      id: "recovered-binding",
      inputHash: selection.input.inputHash,
      ordinal: 0,
      state: "SUCCEEDED"
    }]);
    const result = await createMemoryGlobalDreamHandler(test.deps)
      .execute(job, context());
    expect(test.run).not.toHaveBeenCalled();
    await result.apply?.({} as never, job);
    expect(test.apply).toHaveBeenCalledWith(
      expect.anything(),
      job,
      selection,
      expect.objectContaining({ bindingId: "recovered-binding", plan }),
      null,
      now
    );
  });

  it("maps changed egress consent to a durable waiting gate before calls", async () => {
    const selection = semanticSelection("REINFORCE");
    const test = fixture(selection);
    const job = claim(selection);
    test.probeAuthority.mockRejectedValueOnce(
      new MemoryExecutionError("memory_execution_egress_consent_required")
    );
    await expect(createMemoryGlobalDreamHandler(test.deps).preflight(job))
      .resolves.toEqual({
        errorCode: "memory_execution_egress_consent_required",
        status: "WAITING_FOR_EGRESS_CONSENT"
      });
    expect(test.run).not.toHaveBeenCalled();
  });
});
