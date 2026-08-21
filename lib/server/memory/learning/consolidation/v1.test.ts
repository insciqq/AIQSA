import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import { memorySha256 } from "../../persistence/lexical";
import {
  memoryFactConsolidationInputHash,
  memoryFactRelatedSnapshotHash,
  type MemoryFactCandidateSnapshot,
  type MemoryFactConsolidationInput
} from "./contract";
import { decodeMemoryFactConsolidation } from "./decoder";
import { MEMORY_FACT_CONSOLIDATION_TOOL_NAME } from "./prompt";
import { evaluateMemoryFactConsolidationPlan } from "./policy";

function candidate(): MemoryFactCandidateSnapshot {
  return {
    branchGeneration: 1,
    canonicalKey: "auto.example",
    category: "preferences",
    chatId: "chat-1",
    confidence: 1,
    confidenceBand: "HIGH",
    correction: false,
    directness: "DIRECT",
    displayText: "The user prefers concise replies.",
    evidence: [{
      endOffset: 26,
      messageId: "message-1",
      observedAt: "2026-08-21T09:00:00.000Z",
      quote: "I prefer concise replies.",
      sourceTextHash: "a".repeat(64),
      startOffset: 0
    }],
    extractionExecutionId: "extraction-binding-1",
    futureUseful: true,
    id: "b".repeat(64),
    importance: 0.5,
    languageCode: "en",
    modality: "PREFERENCE",
    negated: false,
    proposedValue: { statement: "The user prefers concise replies." },
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
  };
}

function input(): MemoryFactConsolidationInput {
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate: candidate(),
    memoryRevision: 1,
    relatedFacts: [],
    relatedSnapshotHash: memoryFactRelatedSnapshotHash([])
  };
  return { ...withoutHash, inputHash: memoryFactConsolidationInputHash(withoutHash) };
}

function call(args: Record<string, unknown>): ModelToolCall[] {
  return [{ arguments: args, id: "call-1", name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME }];
}

describe("Personal Memory v1 consolidation", () => {
  it.each([
    ["ADD", "new_fact"],
    ["NOOP", "same_current_value"],
    ["REJECT", "unsafe_or_ambiguous"]
  ] as const)("rejects direct %s operation packets", (operation, reasonCode) => {
    expect(() => decodeMemoryFactConsolidation(call({
      candidate_id: input().candidate.id,
      effective_from: null,
      evidence_ids: ["message-1"],
      operation,
      reason_code: reasonCode,
      target_fact_id: null,
      target_version_id: null
    }), input())).toThrowError("memory_fact_consolidation_output_invalid");
  });

  it("maps comparison DIFFERENT to ADD and AMBIGUOUS to REJECT", () => {
    const base = {
      candidate_id: input().candidate.id,
      evidence_ids: ["message-1"],
      target_fact_id: null,
      target_version_id: null
    };
    const add = decodeMemoryFactConsolidation(
      call({ ...base, comparison: "DIFFERENT" }),
      input()
    );
    const reject = decodeMemoryFactConsolidation(
      call({ ...base, comparison: "AMBIGUOUS" }),
      input()
    );
    expect(add.operation).toBe("ADD");
    expect(reject.operation).toBe("REJECT");
    expect(evaluateMemoryFactConsolidationPlan(input(), add)).toEqual({
      requiresVerification: false,
      status: "VALID"
    });
    expect(evaluateMemoryFactConsolidationPlan(input(), reject)).toEqual({
      requiresVerification: false,
      status: "VALID"
    });
  });
});
