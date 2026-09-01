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
  decodeKnowledgeTargetedSupplementV2,
  decodeKnowledgeTargetedSupplementV3,
  decodeKnowledgeTargetedSupplementV4,
  decodeKnowledgeTargetedSupplementV1,
  decodeKnowledgeTargetedSupplementFailureV1,
  isKnowledgeAnswerTargetedSupplementSchemaV2,
  isKnowledgeAnswerTargetedSupplementSchemaV3,
  knowledgeAnswerTargetedSupplementSchemaV2,
  knowledgeAnswerTargetedSupplementSchemaV3,
  knowledgeTargetableMissingDimensionsV1,
  knowledgeTargetedEvidenceAtomIndexV1,
  knowledgeTargetedSupplementClaimLimitsV2,
  knowledgeTargetedSupplementClaimLimitsV3,
  knowledgeTargetedSupplementFitsV1,
  knowledgeGroundedDeltaCoverageReviewRequiredV1,
  mergeKnowledgeGroundedCorrectionV1,
  mergeKnowledgeGroundedCorrectionV2,
  mergeKnowledgeTargetedSupplementV2,
  mergeKnowledgeTargetedSupplementV1,
  knowledgeTargetedSupplementFailureV1,
  validateKnowledgeTargetedSupplementV1,
  validateKnowledgeTargetedSupplementV2,
  validateKnowledgeTargetedSupplementV3,
  validateKnowledgeTargetedSupplementV4
} from "./answerGroundingCorrectionV21";

const primary = decodeKnowledgeAnswerDraftV21({
  claims: [{ citationHints: ["K1"], text: "Alpha is bounded." }],
  version: 1
}, { availableHandles: ["K1", "K2", "K3"] })!;

const primaryFour = decodeKnowledgeAnswerDraftV21({
  claims: Array.from({ length: 4 }, (_, index) => ({
    citationHints: ["K1"],
    text: `Primary fact ${index + 1}.`
  })),
  version: 1
}, { availableHandles: ["K1"] })!;

function dimension(
  id: string,
  handle: string | null,
  status: "covered" | "excluded" | "missing",
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
    // Preserve exact recovery of a settled pre-refinement V7 diagnostic. The
    // current validator no longer emits this reason because target provenance
    // is server-derived rather than model-authored.
    const failure = knowledgeTargetedSupplementFailureV1(
      "draft_target_evidence_invalid"
    );
    expect(decodeKnowledgeTargetedSupplementFailureV1(failure)).toEqual(failure);
    expect(decodeKnowledgeAnswerDraftMalformed(failure)).toBeNull();
  });

  it("requires one task-addressed candidate for every positive missing dimension", () => {
    const accepted = validateKnowledgeTargetedSupplementV1({
      claims: [{
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
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
    expect(accepted.value.draft.claims.map(({ citationHints }) => citationHints))
      .toEqual([["K2"], ["K3"]]);
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

  it("versions literal mathematical underscores independently from the V2 wire shape", () => {
    const output = {
      targets: {
        D2: ["The maps X̃×_X Y and X̃×_X Z preserve the square."],
        D3: ["Gamma removes duplicates."]
      },
      version: 2
    } as const;
    const input = {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    } as const;
    expect(validateKnowledgeTargetedSupplementV2(output, input)).toEqual({
      kind: "rejected",
      reason: "draft_claim_text_invalid"
    });
    expect(validateKnowledgeTargetedSupplementV3(output, input)).toMatchObject({
      kind: "accepted",
      value: { version: 2 }
    });
    expect(decodeKnowledgeTargetedSupplementV2(output, input)).toBeNull();
    expect(decodeKnowledgeTargetedSupplementV3(output, input)).not.toBeNull();
  });

  it("reserves a bounded claim group for every missing target", () => {
    const targets = [
      dimension("D2", "K2", "missing"),
      dimension("D3", "K3", "missing"),
      dimension("D4", "K4", "missing"),
      dimension("D5", "K5", "missing")
    ];
    const limits = knowledgeTargetedSupplementClaimLimitsV2({
      primaryClaimCount: 1,
      targetDimensions: targets
    });
    expect(limits).toEqual([
      { maxClaims: 3, targetDimensionId: "D2" },
      { maxClaims: 3, targetDimensionId: "D3" },
      { maxClaims: 3, targetDimensionId: "D4" },
      { maxClaims: 3, targetDimensionId: "D5" }
    ]);
    const schema = knowledgeAnswerTargetedSupplementSchemaV2({
      primaryClaimCount: 1,
      targetDimensions: targets
    });
    expect(isKnowledgeAnswerTargetedSupplementSchemaV2(schema)).toBe(true);
    expect(schema).toMatchObject({
      properties: {
        targets: {
          required: ["D2", "D3", "D4", "D5"]
        }
      }
    });
    const input = {
      availableHandles: ["K1", "K2", "K3", "K4", "K5"],
      missingDimensions: targets,
      primaryDraft: primary
    } as const;
    expect(validateKnowledgeTargetedSupplementV2({
      targets: {
        D2: ["D2 fact one.", "D2 fact two.", "D2 fact three."],
        D3: ["D3 fact one.", "D3 fact two.", "D3 fact three."],
        D4: ["D4 fact one.", "D4 fact two.", "D4 fact three."]
      },
      version: 2
    }, input)).toEqual({ kind: "rejected", reason: "draft_target_set_invalid" });
    const accepted = decodeKnowledgeTargetedSupplementV2({
      targets: {
        D2: ["D2 fact one.", "D2 fact two."],
        D3: ["D3 fact one."],
        D4: ["D4 fact one.", "D4 fact two.", "D4 fact three."],
        D5: ["D5 fact one."]
      },
      version: 2
    }, input);
    expect(accepted?.bindings.map(({ targetDimensionId }) => targetDimensionId))
      .toEqual(["D2", "D2", "D3", "D4", "D4", "D4", "D5"]);
    expect(mergeKnowledgeTargetedSupplementV2({
      primaryDraft: primary,
      supplement: accepted!
    }).bindings.at(-1)).toEqual({ claimId: "C8", targetDimensionId: "D5" });
  });

  it("scales atomic capacity with target count inside the complete-Draft bound", () => {
    const targets = Array.from({ length: 8 }, (_, index) =>
      dimension(`D${index + 1}`, "K1", "missing"));
    expect(knowledgeTargetedSupplementClaimLimitsV2({
      primaryClaimCount: 4,
      targetDimensions: targets
    })?.map(({ maxClaims }) => maxClaims)).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
    expect(knowledgeTargetedSupplementClaimLimitsV3({
      primaryClaimCount: 4,
      targetDimensions: targets
    })?.map(({ maxClaims }) => maxClaims)).toEqual([3, 3, 3, 3, 2, 2, 2, 2]);
    expect(knowledgeTargetedSupplementClaimLimitsV3({
      primaryClaimCount: 1,
      targetDimensions: [targets[0]!]
    })).toEqual([{ maxClaims: 3, targetDimensionId: "D1" }]);
    const schema = knowledgeAnswerTargetedSupplementSchemaV3({
      primaryClaimCount: 4,
      targetDimensions: targets
    });
    expect(isKnowledgeAnswerTargetedSupplementSchemaV3(schema)).toBe(true);
    expect(isKnowledgeAnswerTargetedSupplementSchemaV2(schema)).toBe(false);

    const output = {
      targets: Object.fromEntries(targets.map(({ id }, index) => [
        id,
        Array.from({ length: index < 4 ? 3 : 2 }, (_, claimIndex) =>
          `${id} atomic fact ${claimIndex + 1}.`)
      ])),
      version: 2
    };
    const input = {
      availableHandles: ["K1"],
      missingDimensions: targets,
      primaryDraft: primaryFour
    } as const;
    expect(validateKnowledgeTargetedSupplementV3(output, input)).toEqual({
      kind: "rejected",
      reason: "draft_target_shape_invalid"
    });
    expect(validateKnowledgeTargetedSupplementV4(output, input)).toMatchObject({
      kind: "accepted",
      value: { version: 2 }
    });
    expect(decodeKnowledgeTargetedSupplementV4(output, input)?.draft.claims)
      .toHaveLength(20);
  });

  it("projects only exact immutable atoms assigned to correction targets", () => {
    const target = dimension("D2", "K2", "missing");
    expect(knowledgeTargetedEvidenceAtomIndexV1({
      evidence: [{
        exactExcerpt: "Alpha is bounded. Beta preserves order.",
        handle: "K2"
      }],
      targetDimensions: [target]
    })).toEqual({
      atoms: [{
        handle: "K2",
        id: "A2",
        text: "Beta preserves order."
      }],
      targets: [{
        evidenceAtomIds: ["A2"],
        targetDimensionId: "D2"
      }],
      version: 1
    });
    expect(knowledgeTargetedEvidenceAtomIndexV1({
      evidence: [{ exactExcerpt: "Alpha is bounded.", handle: "K2" }],
      targetDimensions: [target]
    })).toBeNull();
  });

  it("disables correction instead of truncating an oversized atom projection", () => {
    const atomIds = (start: number, count: number) => Object.freeze(
      Array.from({ length: count }, (_, index) => `A${start + index}`)
    );
    const target = (
      id: string,
      evidenceAtomIds: readonly string[]
    ): KnowledgeCoverageDimensionV6 => Object.freeze({
      description: `Explain ${id}.`,
      evidenceAtomIds,
      evidenceHandles: Object.freeze(["K1"]),
      id,
      requestAnchor: "Explain",
      status: "missing",
      supportIds: Object.freeze([])
    });
    expect(knowledgeTargetedEvidenceAtomIndexV1({
      evidence: [{
        exactExcerpt: Array.from(
          { length: 129 },
          (_, index) => `Fact ${index + 1}.`
        ).join(" "),
        handle: "K1"
      }],
      targetDimensions: [
        target("D1", atomIds(1, 43)),
        target("D2", atomIds(44, 43)),
        target("D3", atomIds(87, 43))
      ]
    })).toBeNull();
  });

  it("derives target hints while rejecting missing targets and primary duplicates", () => {
    const base = {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    } as const;
    expect(validateKnowledgeTargetedSupplementV1({
      claims: [{
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }],
      version: 1
    }, base)).toEqual({ kind: "rejected", reason: "draft_target_set_invalid" });
    const derivedHints = validateKnowledgeTargetedSupplementV1({
      claims: [{
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, base);
    expect(derivedHints.kind).toBe("accepted");
    if (derivedHints.kind === "accepted") {
      expect(derivedHints.value.bindings).toEqual([{
        claimId: "C1",
        targetDimensionId: "D2"
      }, {
        claimId: "C2",
        targetDimensionId: "D3"
      }]);
      expect(derivedHints.value.draft.claims.map(({ citationHints }) => citationHints))
        .toEqual([["K2"], ["K3"]]);
    }
    expect(validateKnowledgeTargetedSupplementV1({
      claims: [{
        citationHints: ["K9"],
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, base)).toEqual({ kind: "rejected", reason: "draft_target_shape_invalid" });
    expect(validateKnowledgeTargetedSupplementV1({
      claims: [{
        targetDimensionId: "D2",
        text: "Alpha is bounded."
      }, {
        targetDimensionId: "D3",
        text: "Gamma removes duplicates."
      }],
      version: 1
    }, base)).toEqual({ kind: "rejected", reason: "draft_duplicate_primary_claim" });
  });

  it("keeps accepted base state immutable and admits only target-matched deltas", () => {
    const supplement = decodeKnowledgeTargetedSupplementV1({
      claims: [{
        targetDimensionId: "D2",
        text: "Beta preserves order."
      }, {
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
        ...missing,
        dimension("D5", "K3", "excluded")
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
        dimension("D4", null, "missing"),
        dimension("D5", "K3", "covered", ["C3"])
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
    }, {
      id: "D5",
      status: "excluded",
      supportIds: []
    }]);
  });

  it("lets the target-only verifier veto a false positive and discards foreign support", () => {
    const supplement = decodeKnowledgeTargetedSupplementV1({
      claims: [{
        targetDimensionId: "D2",
        text: "Beta reverses the beneficiary."
      }, {
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
        supportHandles: Object.freeze(["K2"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([
        dimension("D1", "K1", "missing"),
        dimension("D2", "K2", "excluded"),
        dimension("D3", "K3", "covered", ["C3"]),
        dimension("D4", null, "missing")
      ])
    });
    const corrected = mergeKnowledgeGroundedCorrectionV2({
      bindings: merged.bindings,
      finalSelector: final,
      initialSelector: initial,
      primaryClaimCount: primary.claims.length
    });
    expect(corrected.coverage.map(({ id, status, supportIds }) => ({
      id,
      status,
      supportIds
    }))).toEqual([{
      id: "D1", status: "covered", supportIds: ["C1"]
    }, {
      id: "D2", status: "excluded", supportIds: []
    }, {
      id: "D3", status: "missing", supportIds: []
    }, {
      id: "D4", status: "missing", supportIds: []
    }]);
    expect(corrected.claims).toEqual([{
      id: "C1", supportHandles: ["K1"], verdict: "supported"
    }, {
      id: "C2", supportHandles: [], verdict: "unsupported"
    }, {
      id: "C3", supportHandles: [], verdict: "unsupported"
    }]);
  });

  it("reviews only an all-supported target group left missing by the final verifier", () => {
    const initial = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze(["K1"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([
        dimension("D1", "K1", "covered", ["C1"]),
        dimension("D2", "K2", "missing")
      ])
    });
    const final = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze(["K1"]),
        verdict: "supported" as const
      }), Object.freeze({
        id: "C2",
        supportHandles: Object.freeze(["K2"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([
        dimension("D1", "K1", "covered", ["C1"]),
        dimension("D2", "K2", "missing")
      ])
    });
    const input = {
      bindings: [{ claimId: "C2", targetDimensionId: "D2" }],
      finalSelector: final,
      initialSelector: initial,
      primaryClaimCount: 1
    } as const;
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV1(input)).toBe(true);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV1({
      ...input,
      finalSelector: selector({
        claims: final.claims,
        coverage: Object.freeze([
          dimension("D1", "K1", "covered", ["C1"]),
          dimension("D2", "K2", "covered", ["C2"])
        ])
      })
    })).toBe(false);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV1({
      ...input,
      finalSelector: selector({
        claims: Object.freeze([final.claims[0]!, Object.freeze({
          ...final.claims[1]!,
          supportHandles: Object.freeze([]),
          verdict: "unsupported" as const
        })]),
        coverage: final.coverage
      })
    })).toBe(false);
  });
});
