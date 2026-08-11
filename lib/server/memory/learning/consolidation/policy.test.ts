import { describe, expect, it } from "vitest";
import {
  memoryFactConsolidationInputHash,
  memoryFactConsolidationOutputHash,
  memoryFactRelatedSnapshotHash,
  type MemoryFactCandidateSnapshot,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationOperation,
  type MemoryFactConsolidationPlan,
  type MemoryRelatedFactSnapshot
} from "./contract";
import { evaluateMemoryFactConsolidationPlan } from "./policy";

function candidate(
  overrides: Partial<MemoryFactCandidateSnapshot> = {}
): MemoryFactCandidateSnapshot {
  return {
    branchGeneration: 1,
    canonicalKey: "user.preference.drink",
    category: "preference",
    chatId: "chat-1",
    confidence: 0.91,
    directness: "DIRECT",
    displayText: "I prefer green tea.",
    evidence: [{
      endOffset: 19,
      messageId: "message-new",
      observedAt: "2026-08-11T10:00:00.000Z",
      quote: "I prefer green tea.",
      sourceTextHash: "1".repeat(64),
      startOffset: 0
    }],
    id: "2".repeat(64),
    importance: 0.5,
    languageCode: "en",
    modality: "PREFERENCE",
    negated: false,
    proposedValue: { drink: "green tea" },
    rawTemporalExpression: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    sourceHash: "3".repeat(64),
    sourceProjectionVersion: "memory-fact-source-projection-v1",
    sourceRevision: 1,
    sourceTimezone: "UTC",
    temporalResolverVersion: null,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function fact(
  sourceMode: "AUTOMATIC" | "EXPLICIT" = "AUTOMATIC",
  overrides: Partial<MemoryRelatedFactSnapshot> = {}
): MemoryRelatedFactSnapshot {
  return {
    canonicalKey: "user.preference.drink",
    category: "preference",
    currentVersionId: "version-current",
    id: "fact-current",
    scope: { targetId: null, type: "GLOBAL_USER" },
    state: "ACTIVE",
    versions: [{
      category: "preference",
      confidence: 0.9,
      directness: "DIRECT",
      displayText: "I prefer black tea.",
      id: "version-current",
      importance: 0.5,
      languageCode: "en",
      latestEvidenceAt: "2026-08-10T10:00:00.000Z",
      modality: "PREFERENCE",
      sourceMode,
      state: "ACTIVE",
      structuredValue: { drink: "black tea" },
      supportCount: 1,
      systemFrom: "2026-08-10T10:00:00.000Z",
      systemTo: null,
      validFrom: null,
      validTo: null
    }],
    ...overrides
  };
}

function input(
  candidateSnapshot = candidate(),
  relatedFacts: readonly MemoryRelatedFactSnapshot[] = []
): MemoryFactConsolidationInput {
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate: candidateSnapshot,
    relatedFacts,
    relatedSnapshotHash
  };
  return { ...withoutHash, inputHash: memoryFactConsolidationInputHash(withoutHash) };
}

const reasons = {
  ADD: "new_supported_fact",
  CONFLICT: "simultaneous_contradiction",
  DEFER: "insufficient_support",
  EXPIRE: "direct_end_evidence",
  NOOP: "duplicate_or_explicit",
  REINFORCE: "same_current_value",
  SUPERSEDE: "direct_newer_evidence"
} as const;

function plan(
  consolidationInput: MemoryFactConsolidationInput,
  operation: MemoryFactConsolidationOperation,
  overrides: Partial<MemoryFactConsolidationPlan> = {}
): MemoryFactConsolidationPlan {
  const targeted = ["REINFORCE", "SUPERSEDE", "CONFLICT", "EXPIRE"]
    .includes(operation);
  const withoutHash: Omit<MemoryFactConsolidationPlan, "outputHash"> = {
    candidateId: consolidationInput.candidate.id,
    effectiveFrom: operation === "SUPERSEDE"
      ? consolidationInput.candidate.validFrom
      : null,
    evidenceIds: consolidationInput.candidate.evidence.map(({ messageId }) => messageId),
    operation,
    reasonCode: reasons[operation],
    targetFactId: targeted ? "fact-current" : null,
    targetVersionId: targeted ? "version-current" : null,
    ...overrides
  };
  return {
    ...withoutHash,
    outputHash: memoryFactConsolidationOutputHash(consolidationInput, withoutHash)
  };
}

describe("server-owned Memory fact consolidation policy", () => {
  it("admits a low-risk new fact but selects verification for material preferences", () => {
    const lowRisk = input(candidate({ importance: 0.4, modality: "HABIT" }));
    expect(evaluateMemoryFactConsolidationPlan(lowRisk, plan(lowRisk, "ADD")))
      .toEqual({ requiresVerification: false, status: "VALID" });

    const material = input(candidate({ importance: 0.7, modality: "PREFERENCE" }));
    expect(evaluateMemoryFactConsolidationPlan(material, plan(material, "ADD")))
      .toEqual({ requiresVerification: true, status: "VALID" });
  });

  it("allows reinforcement only for the exact same current value", () => {
    const same = fact("AUTOMATIC", {
      versions: [{
        ...fact().versions[0]!,
        displayText: "I prefer green tea.",
        structuredValue: { drink: "green tea" }
      }]
    });
    const sameInput = input(candidate(), [same]);
    expect(evaluateMemoryFactConsolidationPlan(
      sameInput,
      plan(sameInput, "REINFORCE")
    )).toEqual({ requiresVerification: false, status: "VALID" });

    const differentInput = input(candidate(), [fact()]);
    expect(evaluateMemoryFactConsolidationPlan(
      differentInput,
      plan(differentInput, "REINFORCE")
    )).toEqual({ reasonCode: "reinforce_precondition_invalid", status: "DEFER" });
  });

  it("requires newer direct evidence and an automatic target for SUPERSEDE", () => {
    const automatic = input(candidate(), [fact()]);
    expect(evaluateMemoryFactConsolidationPlan(
      automatic,
      plan(automatic, "SUPERSEDE")
    )).toEqual({ requiresVerification: true, status: "VALID" });

    const explicit = input(candidate(), [fact("EXPLICIT")]);
    expect(evaluateMemoryFactConsolidationPlan(
      explicit,
      plan(explicit, "SUPERSEDE")
    )).toEqual({ reasonCode: "supersede_precondition_invalid", status: "DEFER" });

    const staleCandidate = input(candidate({
      evidence: [{
        ...candidate().evidence[0]!,
        observedAt: "2026-08-09T10:00:00.000Z"
      }]
    }), [fact()]);
    expect(evaluateMemoryFactConsolidationPlan(
      staleCandidate,
      plan(staleCandidate, "SUPERSEDE")
    )).toEqual({ reasonCode: "supersede_precondition_invalid", status: "DEFER" });
  });

  it("never silently overrides explicit authority but may surface a verified conflict", () => {
    const explicit = input(candidate(), [fact("EXPLICIT")]);
    expect(evaluateMemoryFactConsolidationPlan(
      explicit,
      plan(explicit, "CONFLICT")
    )).toEqual({ requiresVerification: true, status: "VALID" });
    expect(evaluateMemoryFactConsolidationPlan(
      explicit,
      plan(explicit, "SUPERSEDE")
    )).toMatchObject({ status: "DEFER" });
  });

  it("expires only an automatic target with direct negating evidence", () => {
    const negated = input(candidate({ negated: true }), [fact()]);
    expect(evaluateMemoryFactConsolidationPlan(
      negated,
      plan(negated, "EXPIRE")
    )).toEqual({ requiresVerification: true, status: "VALID" });

    const positive = input(candidate(), [fact()]);
    expect(evaluateMemoryFactConsolidationPlan(
      positive,
      plan(positive, "EXPIRE")
    )).toEqual({ reasonCode: "expire_precondition_invalid", status: "DEFER" });

    const explicit = input(candidate({ negated: true }), [fact("EXPLICIT")]);
    expect(evaluateMemoryFactConsolidationPlan(
      explicit,
      plan(explicit, "EXPIRE")
    )).toEqual({ reasonCode: "expire_precondition_invalid", status: "DEFER" });
  });

  it("rejects stale or temporally impossible expiry evidence", () => {
    const stale = input(candidate({
      evidence: [{
        ...candidate().evidence[0]!,
        observedAt: "2026-08-09T10:00:00.000Z"
      }],
      negated: true
    }), [fact()]);
    expect(evaluateMemoryFactConsolidationPlan(stale, plan(stale, "EXPIRE")))
      .toEqual({ reasonCode: "expire_precondition_invalid", status: "DEFER" });

    const beforeInterval = input(candidate({ negated: true }), [fact("AUTOMATIC", {
      versions: [{
        ...fact().versions[0]!,
        latestEvidenceAt: "2026-08-09T10:00:00.000Z",
        validFrom: "2026-08-12T10:00:00.000Z"
      }]
    })]);
    expect(evaluateMemoryFactConsolidationPlan(
      beforeInterval,
      plan(beforeInterval, "EXPIRE")
    )).toEqual({ reasonCode: "expire_precondition_invalid", status: "DEFER" });
  });

  it("fails closed on model-swapped evidence authority", () => {
    const consolidationInput = input();
    expect(evaluateMemoryFactConsolidationPlan(
      consolidationInput,
      plan(consolidationInput, "ADD", { evidenceIds: ["message-other"] })
    )).toEqual({ reasonCode: "evidence_precondition_invalid", status: "DEFER" });
  });
});
