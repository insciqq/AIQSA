import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import {
  memoryFactConsolidationInputHash,
  memoryFactRelatedSnapshotHash,
  memoryFactVerificationInputHash,
  type MemoryFactCandidateSnapshot,
  type MemoryFactConsolidationInput,
  type MemoryFactDecisionSnapshot,
  type MemoryFactVerificationInput,
  type MemoryRelatedFactSnapshot
} from "./contract";
import {
  decodeMemoryFactConsolidation,
  decodeMemoryFactVerification,
  inspectMemoryFactVerificationOutput,
  MemoryFactConsolidationDecodeError
} from "./decoder";
import {
  MEMORY_FACT_CONSOLIDATION_TOOL_NAME,
  MEMORY_FACT_VERIFICATION_TOOL_NAME
} from "./prompt";

const candidateId = "a".repeat(64);
const sourceHash = "b".repeat(64);

function candidate(
  overrides: Partial<MemoryFactCandidateSnapshot> = {}
): MemoryFactCandidateSnapshot {
  return {
    branchGeneration: 2,
    canonicalKey: "user.preference.drink",
    category: "preference",
    chatId: "chat-1",
    confidence: 0.91,
    directness: "DIRECT",
    displayText: "Я предпочитаю зелёный чай.",
    evidence: [{
      endOffset: 29,
      messageId: "message-1",
      observedAt: "2026-08-11T09:00:00.000Z",
      quote: "Я предпочитаю зелёный чай.",
      sourceTextHash: "c".repeat(64),
      startOffset: 0
    }],
    id: candidateId,
    importance: 0.55,
    languageCode: "ru",
    modality: "PREFERENCE",
    negated: false,
    proposedValue: { drink: "зелёный чай" },
    rawTemporalExpression: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    sourceHash,
    sourceProjectionVersion: "memory-fact-source-projection-v1",
    sourceRevision: 7,
    sourceTimezone: "Europe/Moscow",
    temporalResolverVersion: null,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function relatedFact(
  overrides: Partial<MemoryRelatedFactSnapshot> = {}
): MemoryRelatedFactSnapshot {
  return {
    canonicalKey: "user.preference.drink",
    category: "preference",
    currentVersionId: "version-1",
    id: "fact-1",
    scope: { targetId: null, type: "GLOBAL_USER" },
    state: "ACTIVE",
    versions: [{
      category: "preference",
      confidence: 0.9,
      directness: "DIRECT",
      displayText: "Я предпочитаю чёрный чай.",
      id: "version-1",
      importance: 0.5,
      languageCode: "ru",
      latestEvidenceAt: "2026-08-10T09:00:00.000Z",
      modality: "PREFERENCE",
      sourceMode: "AUTOMATIC",
      state: "ACTIVE",
      structuredValue: { drink: "чёрный чай" },
      supportCount: 1,
      systemFrom: "2026-08-10T09:00:00.000Z",
      systemTo: null,
      validFrom: null,
      validTo: null
    }],
    ...overrides
  };
}

function consolidationInput(
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

function consolidationCall(
  operation: string,
  overrides: Record<string, unknown> = {}
): ModelToolCall[] {
  const target = ["REINFORCE", "SUPERSEDE", "CONFLICT", "EXPIRE"]
    .includes(operation);
  const reasons: Record<string, string> = {
    ADD: "new_supported_fact",
    CONFLICT: "simultaneous_contradiction",
    DEFER: "insufficient_support",
    EXPIRE: "direct_end_evidence",
    NOOP: "duplicate_or_explicit",
    REINFORCE: "same_current_value",
    SUPERSEDE: "direct_newer_evidence"
  };
  return [{
    arguments: {
      candidate_id: candidateId,
      effective_from: null,
      evidence_ids: ["message-1"],
      operation,
      reason_code: reasons[operation],
      target_fact_id: target ? "fact-1" : null,
      target_version_id: target ? "version-1" : null,
      ...overrides
    },
    id: "call-1",
    name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME
  }];
}

describe("Memory fact consolidation decoder", () => {
  it("accepts one exact grounded ADD and binds its output hash to the input", () => {
    const input = consolidationInput();
    const plan = decodeMemoryFactConsolidation(consolidationCall("ADD"), input);
    expect(plan).toMatchObject({
      candidateId,
      evidenceIds: ["message-1"],
      operation: "ADD",
      reasonCode: "new_supported_fact",
      targetFactId: null,
      targetVersionId: null
    });
    expect(plan.outputHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires the exact active same-scope target and ordered evidence set", () => {
    const input = consolidationInput(candidate(), [relatedFact()]);
    expect(() => decodeMemoryFactConsolidation(
      consolidationCall("REINFORCE", { evidence_ids: ["other-message"] }),
      input
    )).toThrowError(expect.objectContaining<Partial<MemoryFactConsolidationDecodeError>>({
      code: "memory_fact_consolidation_evidence_invalid"
    }));
    expect(() => decodeMemoryFactConsolidation(
      consolidationCall("REINFORCE", { target_version_id: "historical-version" }),
      input
    )).toThrowError(expect.objectContaining<Partial<MemoryFactConsolidationDecodeError>>({
      code: "memory_fact_consolidation_target_invalid"
    }));
  });

  it("accepts SUPERSEDE only with the candidate's canonical effective time", () => {
    const validFrom = "2026-08-11T06:00:00.000Z";
    const input = consolidationInput(candidate({ validFrom }), [relatedFact()]);
    expect(decodeMemoryFactConsolidation(consolidationCall("SUPERSEDE", {
      effective_from: "2026-08-11T06:00:00.000Z"
    }), input).effectiveFrom).toBe(validFrom);
    expect(() => decodeMemoryFactConsolidation(consolidationCall("SUPERSEDE", {
      effective_from: "2026-08-12T06:00:00.000Z"
    }), input)).toThrowError(expect.objectContaining<Partial<MemoryFactConsolidationDecodeError>>({
      code: "memory_fact_consolidation_temporal_invalid"
    }));
  });

  it("rejects extra fields and model-selected reason semantics", () => {
    const input = consolidationInput();
    expect(() => decodeMemoryFactConsolidation(consolidationCall("ADD", {
      explanation: "hidden reasoning"
    }), input)).toThrowError("memory_fact_consolidation_output_invalid");
    expect(() => decodeMemoryFactConsolidation(consolidationCall("ADD", {
      reason_code: "direct_newer_evidence"
    }), input)).toThrowError("memory_fact_consolidation_output_invalid");
  });
});

describe("Memory fact selective-verifier decoder", () => {
  function verificationInput(): MemoryFactVerificationInput {
    const candidateSnapshot = candidate();
    const decision: MemoryFactDecisionSnapshot = {
      consolidationInputHash: "d".repeat(64),
      consolidationOutputHash: "e".repeat(64),
      id: "f".repeat(64),
      operation: "CONFLICT",
      reasonCode: "simultaneous_contradiction",
      relatedSnapshotHash: "1".repeat(64),
      requiresVerification: true,
      targetFactId: "fact-1",
      targetVersionId: "version-1"
    };
    const target = relatedFact();
    const withoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
      candidate: candidateSnapshot,
      decision,
      target
    };
    return { ...withoutHash, inputHash: memoryFactVerificationInputHash(withoutHash) };
  }

  it("accepts only a verdict for the exact candidate and immutable decision", () => {
    const input = verificationInput();
    const plan = decodeMemoryFactVerification([{
      arguments: {
        candidate_id: input.candidate.id,
        decision_id: input.decision.id,
        reason_code: "supported_transition",
        verdict: "APPROVE"
      },
      id: "verify-call",
      name: MEMORY_FACT_VERIFICATION_TOOL_NAME
    }], input);
    expect(plan).toMatchObject({
      candidateId: input.candidate.id,
      decisionId: input.decision.id,
      reasonCode: "supported_transition",
      verdict: "APPROVE"
    });
  });

  it("does not let the verifier approve while reporting disagreement", () => {
    const input = verificationInput();
    expect(() => decodeMemoryFactVerification([{
      arguments: {
        candidate_id: input.candidate.id,
        decision_id: input.decision.id,
        reason_code: "authority_conflict",
        verdict: "APPROVE"
      },
      id: "verify-call",
      name: MEMORY_FACT_VERIFICATION_TOOL_NAME
    }], input)).toThrowError("memory_fact_verification_output_invalid");
  });

  it("classifies verifier contract failures without retaining model content", () => {
    const input = verificationInput();
    const call = (overrides: Partial<ModelToolCall> = {}): ModelToolCall => ({
      arguments: {
        candidate_id: input.candidate.id,
        decision_id: input.decision.id,
        reason_code: "supported_transition",
        verdict: "APPROVE"
      },
      id: "verify-call",
      name: MEMORY_FACT_VERIFICATION_TOOL_NAME,
      ...overrides
    });
    const issue = (calls: readonly ModelToolCall[] | undefined) =>
      inspectMemoryFactVerificationOutput(calls, input).issue;

    expect(issue(undefined)).toBe("tool_call_missing");
    expect(issue([call(), call({ id: "verify-call-2" })])).toBe(
      "tool_call_count_invalid"
    );
    expect(issue([call({ name: "wrong_tool" })])).toBe("tool_name_invalid");
    expect(issue([call({ arguments: null as never })])).toBe("arguments_invalid");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      reason_code: "supported_transition",
      verdict: "APPROVE",
      explanation: "must not be retained"
    } })])).toBe("arguments_unexpected_keys");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      verdict: "APPROVE"
    } })])).toBe("reason_code_missing");
    expect(issue([call({ arguments: {
      decision_id: input.decision.id,
      reason_code: "supported_transition",
      verdict: "APPROVE"
    } })])).toBe("candidate_id_missing");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      reason_code: "supported_transition",
      verdict: "APPROVE"
    } })])).toBe("decision_id_missing");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      reason_code: "supported_transition"
    } })])).toBe("verdict_missing");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      verdict: "APPROVE"
    } })])).toBe("multiple_required_keys_missing");
    expect(inspectMemoryFactVerificationOutput([call({ arguments: {
      candidate_id: input.candidate.id,
      verdict: "APPROVE"
    } })], input)).toMatchObject({
      missingRequiredKeys: ["decision_id", "reason_code"],
      unexpectedKeyCount: 0
    });
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      explanation: "must not be retained",
      verdict: "APPROVE"
    } })])).toBe("arguments_required_keys_missing_and_unexpected");
    expect(inspectMemoryFactVerificationOutput([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      explanation: "must not be retained",
      verdict: "APPROVE"
    } })], input)).toMatchObject({
      missingRequiredKeys: ["reason_code"],
      unexpectedKeyCount: 1
    });
    expect(issue([call({ arguments: {
      candidate_id: "wrong",
      decision_id: input.decision.id,
      reason_code: "supported_transition",
      verdict: "APPROVE"
    } })])).toBe("candidate_id_mismatch");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: "wrong",
      reason_code: "supported_transition",
      verdict: "APPROVE"
    } })])).toBe("decision_id_mismatch");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      reason_code: "supported_transition",
      verdict: "MAYBE"
    } })])).toBe("verdict_invalid");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      reason_code: "unknown",
      verdict: "REJECT"
    } })])).toBe("reason_code_invalid");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      reason_code: "source_mismatch",
      verdict: "APPROVE"
    } })])).toBe("approve_reason_mismatch");
    expect(issue([call({ arguments: {
      candidate_id: input.candidate.id,
      decision_id: input.decision.id,
      reason_code: "supported_transition",
      verdict: "REJECT"
    } })])).toBe("non_approve_reason_mismatch");
  });
});
