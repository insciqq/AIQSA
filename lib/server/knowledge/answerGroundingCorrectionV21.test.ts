import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeAnswerDraftMalformed
} from "./answerGroundingV5";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import type {
  KnowledgeCoverageDimensionV6,
  KnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import {
  decodeKnowledgeTargetedSupplementV1,
  decodeKnowledgeTargetedSupplementFailureV1,
  knowledgeTargetableMissingDimensionsV1,
  knowledgeTargetedSupplementFitsV1,
  mergeKnowledgeGroundedCorrectionV1,
  mergeKnowledgeTargetedSupplementV1,
  knowledgeTargetedSupplementFailureV1,
  validateKnowledgeTargetedSupplementV1
} from "./answerGroundingCorrectionV21";

const primary = decodeKnowledgeAnswerDraftV21({
  claims: [{ citationHints: ["K1"], text: "Alpha is bounded." }],
  version: 1
}, { availableHandles: ["K1", "K2", "K3"] })!;

function dimension(
  id: string,
  handle: string | null,
  status: "covered" | "missing",
  supportIds: readonly string[] = []
): KnowledgeCoverageDimensionV6 {
  return Object.freeze({
    description: `Explain ${id}.`,
    evidenceAtomIds: Object.freeze(handle ? [`A${id.slice(1)}`] : []),
    evidenceHandles: Object.freeze(handle ? [handle] : []),
    id,
    requestAnchor: "Explain",
    status,
    supportIds: Object.freeze([...supportIds])
  });
}

const missing = Object.freeze([
  dimension("D2", "K2", "missing"),
  dimension("D3", "K3", "missing"),
  dimension("D4", null, "missing")
]);

function selector(input: Readonly<{
  claims: KnowledgeGroundedSelectorV21["claims"];
  coverage: KnowledgeGroundedSelectorV21["coverage"];
}>): KnowledgeGroundedSelectorV21 {
  return Object.freeze({
    claims: input.claims,
    coverage: input.coverage,
    extractIds: Object.freeze([]),
    insufficientReason: "not_applicable",
    version: 1
  });
}

describe("target-addressed Knowledge correction", () => {
  it("keeps targeted diagnostics outside the historical Draft failure decoder", () => {
    const failure = knowledgeTargetedSupplementFailureV1(
      "draft_target_evidence_invalid"
    );
    expect(decodeKnowledgeTargetedSupplementFailureV1(failure)).toEqual(failure);
    expect(decodeKnowledgeAnswerDraftMalformed(failure)).toBeNull();
  });

  it("requires one provenance-linked candidate for every positive missing dimension", () => {
    const accepted = validateKnowledgeTargetedSupplementV1({
      claims: [{
        citationHints: ["K2"],
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
        citationHints: ["K3"],
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    });
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") return;
    expect(accepted.value.bindings).toEqual([{
      claimId: "C1",
      targetDimensionId: "D2"
    }, {
      claimId: "C2",
      targetDimensionId: "D3"
    }]);
    expect(knowledgeTargetableMissingDimensionsV1(missing).map(({ id }) => id))
      .toEqual(["D2", "D3"]);
    expect(knowledgeTargetedSupplementFitsV1({
      primaryClaimCount: 22,
      targetableDimensionCount: 2
    })).toBe(true);
    expect(knowledgeTargetedSupplementFitsV1({
      primaryClaimCount: 23,
      targetableDimensionCount: 2
    })).toBe(false);
    expect(knowledgeTargetedSupplementFitsV1({
      primaryClaimCount: 0,
      targetableDimensionCount: 2
    })).toBe(false);
  });

  it("rejects missing targets, wrong provenance, and primary duplicates", () => {
    const base = {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    } as const;
    expect(validateKnowledgeTargetedSupplementV1({
      claims: [{
        citationHints: ["K2"],
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }],
      version: 1
    }, base)).toEqual({ kind: "rejected", reason: "draft_target_set_invalid" });
    expect(validateKnowledgeTargetedSupplementV1({
      claims: [{
        citationHints: ["K3"],
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
        citationHints: ["K3"],
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, base)).toEqual({ kind: "rejected", reason: "draft_target_evidence_invalid" });
    expect(validateKnowledgeTargetedSupplementV1({
      claims: [{
        citationHints: ["K2"],
        targetDimensionId: "D2",
        text: "Alpha is bounded."
      }, {
        citationHints: ["K3"],
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, base)).toEqual({ kind: "rejected", reason: "draft_duplicate_primary_claim" });
  });

  it("keeps accepted base state immutable and admits only target-matched deltas", () => {
    const supplement = decodeKnowledgeTargetedSupplementV1({
      claims: [{
        citationHints: ["K2"],
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
        citationHints: ["K3"],
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    })!;
    const merged = mergeKnowledgeTargetedSupplementV1({
      primaryDraft: primary,
      supplement
    });
    expect(merged.bindings).toEqual([{
      claimId: "C2",
      targetDimensionId: "D2"
    }, {
      claimId: "C3",
      targetDimensionId: "D3"
    }]);
    const initial = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze(["K1"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([
        dimension("D1", "K1", "covered", ["C1"]),
        ...missing
      ])
    });
    const final = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze([]),
        verdict: "unsupported" as const
      }), Object.freeze({
        id: "C2",
        supportHandles: Object.freeze(["K2"]),
        verdict: "supported" as const
      }), Object.freeze({
        id: "C3",
        supportHandles: Object.freeze(["K3"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([
        dimension("D1", "K1", "missing"),
        dimension("D2", "K2", "covered", ["C2"]),
        dimension("D3", "K3", "covered", ["C2"]),
        dimension("D4", null, "missing")
      ])
    });
    const corrected = mergeKnowledgeGroundedCorrectionV1({
      bindings: merged.bindings,
      finalSelector: final,
      initialSelector: initial,
      primaryClaimCount: primary.claims.length
    });
    expect(corrected.claims).toEqual([{
      id: "C1",
      supportHandles: ["K1"],
      verdict: "supported"
    }, {
      id: "C2",
      supportHandles: ["K2"],
      verdict: "supported"
    }, {
      id: "C3",
      supportHandles: ["K3"],
      verdict: "supported"
    }]);
    expect(corrected.coverage.map(({ id, status, supportIds }) => ({
      id,
      status,
      supportIds
    }))).toEqual([{
      id: "D1",
      status: "covered",
      supportIds: ["C1"]
    }, {
      id: "D2",
      status: "covered",
      supportIds: ["C2"]
    }, {
      id: "D3",
      status: "missing",
      supportIds: []
    }, {
      id: "D4",
      status: "missing",
      supportIds: []
    }]);
  });
});
