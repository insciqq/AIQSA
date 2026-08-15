import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../../coordinator/types";
import { memoryFactConsolidationInputHash, memoryFactConsolidationJobFingerprint, memoryFactRelatedSnapshotHash, memoryFactVerificationInputHash, MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION, MEMORY_FACT_VERIFICATION_JOB_PREFIX, MEMORY_FACT_VERIFICATION_PIPELINE_VERSION, type MemoryFactCandidateSnapshot, type MemoryFactConsolidationInput, type MemoryFactDecisionSnapshot, type MemoryFactVerificationInput, type MemoryRelatedFactSnapshot } from "./contract";
import {
  createMemoryFactConsolidationHandler,
  createMemoryFactVerificationHandler,
  type MemoryFactDecisionHandlerDependencies
} from "./handler";
import {
  MEMORY_FACT_CONSOLIDATION_TOOL_NAME,
  MEMORY_FACT_VERIFICATION_TOOL_NAME
} from "./prompt";

const candidateId = "a".repeat(64);
const sourceHash = "b".repeat(64);

function candidate(): MemoryFactCandidateSnapshot {
  return {
    branchGeneration: 1,
    canonicalKey: "user.preference.drink",
    category: "preference",
    chatId: "chat-1",
    confidence: 0.92,
    directness: "DIRECT",
    displayText: "I prefer tea.",
    evidence: [{
      endOffset: 13,
      messageId: "message-1",
      observedAt: "2026-08-11T09:00:00.000Z",
      quote: "I prefer tea.",
      sourceTextHash: "c".repeat(64),
      startOffset: 0
    }],
    id: candidateId,
    importance: 0.4,
    languageCode: "en",
    modality: "PREFERENCE",
    negated: false,
    proposedValue: { drink: "tea" },
    rawTemporalExpression: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    sourceHash,
    sourceProjectionVersion: "memory-fact-source-projection-v1",
    sourceRevision: 3,
    sourceTimezone: "UTC",
    temporalResolverVersion: null,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null
  };
}

function consolidationInput(): MemoryFactConsolidationInput {
  const relatedFacts: readonly MemoryRelatedFactSnapshot[] = [];
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate: candidate(),
    memoryRevision: 0,
    relatedFacts,
    relatedSnapshotHash
  };
  return { ...withoutHash, inputHash: memoryFactConsolidationInputHash(withoutHash) };
}

function verificationInput(): MemoryFactVerificationInput {
  const decision: MemoryFactDecisionSnapshot = {
    consolidationInputHash: "d".repeat(64),
    consolidationOutputHash: "e".repeat(64),
    id: "f".repeat(64),
    operation: "ADD",
    reasonCode: "new_supported_fact",
    relatedSnapshotHash: "1".repeat(64),
    requiresVerification: true,
    targetFactId: null,
    targetVersionId: null
  };
  const withoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
    candidate: candidate(),
    decision,
    target: null
  };
  return { ...withoutHash, inputHash: memoryFactVerificationInputHash(withoutHash) };
}

function claim(kind: "CONSOLIDATE_CANDIDATE" | "VERIFY_CANDIDATE"): MemoryJobClaim {
  const input = kind === "CONSOLIDATE_CANDIDATE"
    ? consolidationInput()
    : verificationInput();
  return {
    activeLeafMessageId: "assistant-1",
    attemptCount: 1,
    branchGeneration: 1,
    chatId: "chat-1",
    claimToken: randomUUID(),
    id: `job-${randomUUID()}`,
    idempotencyFingerprint: kind === "CONSOLIDATE_CANDIDATE"
      ? memoryFactConsolidationJobFingerprint({
          candidateId: input.candidate.id,
          sourceHash,
          sourceRevision: 3
        })
      : `${MEMORY_FACT_VERIFICATION_JOB_PREFIX}${
          (input as MemoryFactVerificationInput).decision.id
        }`,
    kind,
    leaseExpiresAt: new Date("2026-08-11T12:05:00.000Z"),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 1,
    pipelineVersion: kind === "CONSOLIDATE_CANDIDATE"
      ? MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION
      : MEMORY_FACT_VERIFICATION_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash,
    sourceRevision: 3,
    stage: null,
    userId: "user-1"
  };
}

function providerOutput(kind: "CONSOLIDATE" | "VERIFY") {
  return {
    providerResponseId: "response-1",
    toolCalls: kind === "CONSOLIDATE"
      ? [{
          arguments: {
            candidate_id: candidateId,
            effective_from: null,
            evidence_ids: ["message-1"],
            operation: "ADD",
            reason_code: "new_supported_fact",
            target_fact_id: null,
            target_version_id: null
          },
          id: "call-1",
          name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME
        }]
      : [{
          arguments: {
            candidate_id: candidateId,
            decision_id: "f".repeat(64),
            reason_code: "authority_conflict",
            verdict: "DEFER"
          },
          id: "call-2",
          name: MEMORY_FACT_VERIFICATION_TOOL_NAME
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

function dependencies() {
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
  const run = vi.fn(async (_evidence: unknown, request: { kind: "CONSOLIDATE" | "VERIFY" }) =>
    providerOutput(request.kind));
  const applyConsolidation = vi.fn(async () => undefined);
  const applyVerification = vi.fn(async () => undefined);
  const deferConsolidation = vi.fn(async () => undefined);
  const staleVerification = vi.fn(async () => undefined);
  const consolidation = consolidationInput();
  const verification = verificationInput();
  const base = {
    execution: {
      admission: { bind, start },
      lifecycle: { settle }
    },
    probeAuthority: vi.fn(async () => undefined),
    provider: { run },
    repository: {
      applyConsolidation,
      applyVerification,
      consolidationBindings: vi.fn(async () => []),
      deferConsolidation,
      preflightConsolidation: vi.fn(async () => ({ status: "READY" as const })),
      preflightVerification: vi.fn(async () => ({ status: "READY" as const })),
      prepareConsolidation: vi.fn(async () => ({ input: consolidation })),
      prepareVerification: vi.fn(async () => ({ input: verification })),
      staleVerification,
      verificationBindings: vi.fn(async () => [])
    }
  } as unknown as MemoryFactDecisionHandlerDependencies;
  return {
    applyConsolidation,
    applyVerification,
    base,
    consolidation,
    deferConsolidation,
    run,
    settle,
    staleVerification
  };
}

function context() {
  return {
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

describe("Memory fact decision handlers", () => {
  it("binds one strict consolidation call, accounts usage, and exposes one atomic apply", async () => {
    const fixture = dependencies();
    const job = claim("CONSOLIDATE_CANDIDATE");
    const result = await createMemoryFactConsolidationHandler(fixture.base)
      .execute(job, context());
    expect(result.stage).toBe("consolidation_applied");
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.settle).toHaveBeenCalledWith(
      job.userId,
      "consolidate-binding",
      expect.objectContaining({
        state: "SUCCEEDED",
        usage: expect.objectContaining({ completeness: "COMPLETE", totalTokens: 15 })
      })
    );
    await result.apply?.({} as never, job);
    expect(fixture.applyConsolidation).toHaveBeenCalledWith(
      expect.anything(),
      job,
      fixture.consolidation,
      expect.objectContaining({ operation: "ADD" }),
      "consolidate-binding",
      new Date("2026-08-11T12:00:00.000Z")
    );
  });

  it("never replays a recovered RUNNING provider call", async () => {
    const fixture = dependencies();
    vi.mocked(fixture.base.repository.consolidationBindings).mockResolvedValue([{
      acceptedOutputHash: null,
      id: "uncertain-binding",
      inputHash: fixture.consolidation.inputHash,
      ordinal: 0,
      state: "RUNNING" as const
    }]);
    const job = claim("CONSOLIDATE_CANDIDATE");
    const result = await createMemoryFactConsolidationHandler(fixture.base)
      .execute(job, context());
    expect(result.stage).toBe("consolidation_deferred");
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.settle).toHaveBeenCalledWith(
      job.userId,
      "uncertain-binding",
      expect.objectContaining({ state: "OUTCOME_UNKNOWN" })
    );
    await result.apply?.({} as never, job);
    expect(fixture.deferConsolidation).toHaveBeenCalledWith(
      expect.anything(),
      job,
      candidateId,
      "consolidation_outcome_unknown"
    );
  });

  it("persists verifier disagreement as a bounded verdict for server apply", async () => {
    const fixture = dependencies();
    const job = claim("VERIFY_CANDIDATE");
    const result = await createMemoryFactVerificationHandler(fixture.base)
      .execute(job, context());
    expect(result.stage).toBe("verification_applied");
    expect(fixture.run).toHaveBeenCalledTimes(1);
    await result.apply?.({} as never, job);
    expect(fixture.applyVerification).toHaveBeenCalledWith(
      expect.anything(),
      job,
      expect.objectContaining({ inputHash: expect.any(String) }),
      expect.objectContaining({ reasonCode: "authority_conflict", verdict: "DEFER" }),
      "verify-binding",
      new Date("2026-08-11T12:00:00.000Z")
    );
    expect(fixture.staleVerification).not.toHaveBeenCalled();
  });
});
