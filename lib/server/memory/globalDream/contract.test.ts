import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MemoryJobDescriptor } from "../coordinator/types";
import {
  memoryFactConsolidationInputHash,
  memoryFactConsolidationOutputHash,
  memoryFactRelatedSnapshotHash,
  memoryFactVerificationInputHash,
  memoryFactVerificationOutputHash,
  type MemoryFactConsolidationInput,
  type MemoryFactDecisionSnapshot,
  type MemoryFactVerificationInput
} from "../learning/consolidation/contract";
import {
  MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
  memoryGlobalDreamJobFingerprint,
  memoryGlobalDreamJobIsValid,
  memoryGlobalDreamPlanStage,
  memoryGlobalDreamVerificationStage,
  parseMemoryGlobalDreamJobFingerprint,
  parseMemoryGlobalDreamPlanStage,
  parseMemoryGlobalDreamVerificationStage
} from "./contract";

function input(): MemoryFactConsolidationInput {
  const relatedFacts = [{
    canonicalKey: "user.preference.drink",
    category: "preference",
    currentVersionId: "version-1",
    id: randomUUID(),
    scope: { targetId: null, type: "GLOBAL_USER" as const },
    state: "ACTIVE" as const,
    versions: [{
      category: "preference",
      confidence: 0.95,
      directness: "DIRECT" as const,
      displayText: "I prefer tea.",
      id: "version-1",
      importance: 0.4,
      languageCode: "en",
      latestEvidenceAt: "2026-08-10T10:00:00.000Z",
      modality: "PREFERENCE" as const,
      sourceMode: "AUTOMATIC" as const,
      state: "ACTIVE" as const,
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
      displayText: "I prefer coffee.",
      evidence: [{
        endOffset: 16,
        messageId: randomUUID(),
        observedAt: "2026-08-11T10:00:00.000Z",
        quote: "I prefer coffee.",
        sourceTextHash: "a".repeat(64),
        startOffset: 0
      }],
      id: "b".repeat(64),
      importance: 0.4,
      languageCode: "en",
      modality: "PREFERENCE",
      negated: false,
      proposedValue: { drink: "coffee" },
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
  return { ...withoutHash, inputHash: memoryFactConsolidationInputHash(withoutHash) };
}

describe("Global Dream contract", () => {
  it("round-trips bounded local, pair, and deferred job identities", () => {
    const factId = randomUUID();
    const sourceFactId = randomUUID();
    const snapshotHash = "d".repeat(64);
    const values = [
      memoryGlobalDreamJobFingerprint({
        factId,
        kind: "RETRACT_INVALID",
        snapshotHash
      }),
      memoryGlobalDreamJobFingerprint({
        factId,
        kind: "EXPIRE_TEMPORAL",
        snapshotHash
      }),
      memoryGlobalDreamJobFingerprint({
        kind: "RECONCILE_PAIR",
        snapshotHash,
        sourceFactId,
        targetFactId: factId
      }),
      memoryGlobalDreamJobFingerprint({
        candidateId: "e".repeat(64),
        kind: "REVISIT_DEFERRED",
        snapshotHash
      })
    ];
    expect(values.map(parseMemoryGlobalDreamJobFingerprint)).toEqual([
      expect.objectContaining({ factId, kind: "RETRACT_INVALID" }),
      expect.objectContaining({ factId, kind: "EXPIRE_TEMPORAL" }),
      expect.objectContaining({ kind: "RECONCILE_PAIR", sourceFactId }),
      expect.objectContaining({ candidateId: "e".repeat(64), kind: "REVISIT_DEFERRED" })
    ]);
    expect(values.every((value) => value.length <= 128)).toBe(true);
    expect(parseMemoryGlobalDreamJobFingerprint("gd1:p:bad")).toBeNull();
  });

  it("accepts a source-free job without coupling validity to additive revision", () => {
    const idempotencyFingerprint = memoryGlobalDreamJobFingerprint({
      factId: randomUUID(),
      kind: "RETRACT_INVALID",
      snapshotHash: "f".repeat(64)
    });
    const job: MemoryJobDescriptor = {
      activeLeafMessageId: null,
      attemptCount: 0,
      branchGeneration: null,
      chatId: null,
      id: randomUUID(),
      idempotencyFingerprint,
      kind: "GLOBAL_DREAM",
      memoryGenerationSnapshot: 3,
      memoryRevisionSnapshot: 9_999,
      pipelineVersion: MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
      sourceHash: null,
      sourceRevision: null,
      stage: null,
      userId: randomUUID()
    };
    expect(memoryGlobalDreamJobIsValid(job)).toBe(true);
    expect(memoryGlobalDreamJobIsValid({ ...job, sourceRevision: 1 })).toBe(false);
  });

  it("persists enough bounded stage data to reconstruct both decisions", () => {
    const consolidationInput = input();
    const target = consolidationInput.relatedFacts[0]!;
    const consolidationWithoutHash = {
      candidateId: consolidationInput.candidate.id,
      effectiveFrom: null,
      evidenceIds: consolidationInput.candidate.evidence.map(({ messageId }) => messageId),
      operation: "CONFLICT" as const,
      reasonCode: "simultaneous_contradiction" as const,
      targetFactId: target.id,
      targetVersionId: target.currentVersionId
    };
    const consolidation = {
      ...consolidationWithoutHash,
      outputHash: memoryFactConsolidationOutputHash(
        consolidationInput,
        consolidationWithoutHash
      )
    };
    const decision: MemoryFactDecisionSnapshot = {
      consolidationInputHash: consolidationInput.inputHash,
      consolidationOutputHash: consolidation.outputHash,
      id: "9".repeat(64),
      operation: consolidation.operation,
      reasonCode: consolidation.reasonCode,
      relatedSnapshotHash: consolidationInput.relatedSnapshotHash,
      requiresVerification: true,
      targetFactId: target.id,
      targetVersionId: target.currentVersionId
    };
    const verificationWithoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
      candidate: consolidationInput.candidate,
      decision,
      target
    };
    const verificationInput = {
      ...verificationWithoutHash,
      inputHash: memoryFactVerificationInputHash(verificationWithoutHash)
    };
    const verificationWithoutOutput = {
      candidateId: consolidationInput.candidate.id,
      decisionId: decision.id,
      reasonCode: "supported_transition" as const,
      verdict: "APPROVE" as const
    };
    const verification = {
      ...verificationWithoutOutput,
      outputHash: memoryFactVerificationOutputHash(
        verificationInput,
        verificationWithoutOutput
      )
    };
    const planStage = memoryGlobalDreamPlanStage(consolidationInput, consolidation);
    const finalStage = memoryGlobalDreamVerificationStage(
      consolidationInput,
      consolidation,
      verification
    );
    expect(parseMemoryGlobalDreamPlanStage(planStage)).toEqual({
      operation: "CONFLICT",
      targetIndex: 0
    });
    expect(parseMemoryGlobalDreamVerificationStage(finalStage)).toEqual({
      operation: "CONFLICT",
      reasonCode: "supported_transition",
      targetIndex: 0,
      verdict: "APPROVE"
    });
    expect(finalStage.length).toBeLessThanOrEqual(64);
  });
});
