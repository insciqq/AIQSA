import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeAnswerDraftMalformed
} from "./answerGroundingV5";
import {
  decodeKnowledgeAnswerDraftV21,
  settleKnowledgeAnswerV21FromFinalSelectorV38
} from "./answerGroundingV21";
import type {
  KnowledgeCoverageDimensionV6,
  KnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import {
  decodeKnowledgeTargetedSupplementV2,
  decodeKnowledgeTargetedSupplementV3,
  decodeKnowledgeTargetedSupplementV4,
  decodeKnowledgeTargetedSupplementV5,
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
  knowledgeTargetedSupplementCrossTargetExactRepeatCountV1,
  knowledgeGroundedDeltaCoverageReviewRequiredV1,
  knowledgeGroundedDeltaCoverageReviewRequiredV2,
  knowledgeTargetPrimaryClaimsV1,
  mergeKnowledgeGroundedCorrectionV1,
  mergeKnowledgeGroundedCorrectionV2,
  mergeKnowledgeGroundedCorrectionV3,
  mergeKnowledgeTargetedSupplementV2,
  mergeKnowledgeTargetedSupplementV3,
  mergeKnowledgeTargetedSupplementV1,
  normalizeKnowledgeTargetedSupplementExactPrimaryDuplicatesV1,
  knowledgeTargetedSupplementFailureV1,
  validateKnowledgeTargetedSupplementV1,
  validateKnowledgeTargetedSupplementV2,
  validateKnowledgeTargetedSupplementV3,
  validateKnowledgeTargetedSupplementV4,
  validateKnowledgeTargetedSupplementV5
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

  it("keeps exact claim replicas target-local in deterministic order", () => {
    const input = {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    } as const;
    const output = {
      targets: {
        D3: ["A shared mechanism is enabled."],
        D2: ["A shared mechanism is enabled.", "The first path is bounded."]
      },
      version: 2
    } as const;
    expect(validateKnowledgeTargetedSupplementV4(output, input)).toEqual({
      kind: "rejected",
      reason: "draft_duplicate_claim"
    });
    const accepted = decodeKnowledgeTargetedSupplementV5(output, input);
    expect(accepted?.bindings).toEqual([
      { claimId: "C1", targetDimensionId: "D2" },
      { claimId: "C2", targetDimensionId: "D2" },
      { claimId: "C3", targetDimensionId: "D3" }
    ]);
    expect(accepted?.draft.claims.map(({ citationHints, text }) => ({
      citationHints,
      text
    }))).toEqual([{
      citationHints: ["K2"],
      text: "A shared mechanism is enabled."
    }, {
      citationHints: ["K2"],
      text: "The first path is bounded."
    }, {
      citationHints: ["K3"],
      text: "A shared mechanism is enabled."
    }]);
    expect(knowledgeTargetedSupplementCrossTargetExactRepeatCountV1(accepted!)).toBe(1);
    const merged = mergeKnowledgeTargetedSupplementV3({
      primaryDraft: primary,
      supplement: accepted!
    });
    expect(merged.draft.claims.map(({ citationHints, id, text }) => ({
      citationHints,
      id,
      text
    }))).toEqual([{
      citationHints: ["K1"], id: "C1", text: "Alpha is bounded."
    }, {
      citationHints: ["K2"], id: "C2", text: "A shared mechanism is enabled."
    }, {
      citationHints: ["K2"], id: "C3", text: "The first path is bounded."
    }, {
      citationHints: ["K3"], id: "C4", text: "A shared mechanism is enabled."
    }]);
  });

  it("keeps separate identities when cross-target replicas share one handle", () => {
    const accepted = decodeKnowledgeTargetedSupplementV5({
      targets: {
        D2: ["A shared mechanism is enabled."],
        D3: ["A shared mechanism is enabled."]
      },
      version: 2
    }, {
      availableHandles: ["K1", "K2"],
      missingDimensions: Object.freeze([
        dimension("D2", "K2", "missing"),
        dimension("D3", "K2", "missing")
      ]),
      primaryDraft: primary
    });
    expect(accepted?.bindings).toEqual([{
      claimId: "C1",
      targetDimensionId: "D2"
    }, {
      claimId: "C2",
      targetDimensionId: "D3"
    }]);
    expect(accepted?.draft.claims.map(({ citationHints, id }) => ({
      citationHints,
      id
    }))).toEqual([{
      citationHints: ["K2"],
      id: "C1"
    }, {
      citationHints: ["K2"],
      id: "C2"
    }]);
  });

  it("rejects exact repeats inside one target and against the primary Draft", () => {
    const input = {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    } as const;
    expect(validateKnowledgeTargetedSupplementV5({
      targets: {
        D2: ["Caf\u00e9 is bounded.", "Cafe\u0301 is bounded."],
        D3: ["A separate mechanism applies."]
      },
      version: 2
    }, input)).toEqual({ kind: "rejected", reason: "draft_duplicate_claim" });
    expect(validateKnowledgeTargetedSupplementV5({
      targets: {
        D2: ["Alpha is bounded."],
        D3: ["A separate mechanism applies."]
      },
      version: 2
    }, input)).toEqual({
      kind: "rejected",
      reason: "draft_duplicate_primary_claim"
    });
  });

  it("adjudicates identical target replicas independently and deduplicates only egress", () => {
    const accepted = decodeKnowledgeTargetedSupplementV5({
      targets: {
        D2: ["A shared mechanism is enabled."],
        D3: ["A shared mechanism is enabled."]
      },
      version: 2
    }, {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    })!;
    const merged = mergeKnowledgeTargetedSupplementV3({
      primaryDraft: primary,
      supplement: accepted
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
    const corrected = (
      secondVerdict: "supported" | "unsupported",
      thirdVerdict: "supported" | "unsupported"
    ) => mergeKnowledgeGroundedCorrectionV3({
      bindings: merged.bindings,
      finalSelector: selector({
        claims: Object.freeze([Object.freeze({
          id: "C1", supportHandles: Object.freeze([]), verdict: "unsupported" as const
        }), Object.freeze({
          id: "C2",
          supportHandles: Object.freeze(secondVerdict === "supported" ? ["K2"] : []),
          verdict: secondVerdict
        }), Object.freeze({
          id: "C3",
          supportHandles: Object.freeze(thirdVerdict === "supported" ? ["K3"] : []),
          verdict: thirdVerdict
        })]),
        coverage: Object.freeze([
          dimension("D1", "K1", "missing"),
          dimension(
            "D2",
            "K2",
            secondVerdict === "supported" ? "covered" : "missing",
            secondVerdict === "supported" ? ["C2"] : []
          ),
          dimension(
            "D3",
            "K3",
            thirdVerdict === "supported" ? "covered" : "missing",
            thirdVerdict === "supported" ? ["C3"] : []
          ),
          dimension("D4", null, "missing")
        ])
      }),
      initialSelector: initial,
      primaryClaimCount: 1
    });

    const firstOnly = corrected("supported", "unsupported");
    expect(firstOnly.claims.slice(1).map(({ verdict }) => verdict)).toEqual([
      "supported", "unsupported"
    ]);
    expect(firstOnly.coverage.slice(1, 3).map(({ status }) => status)).toEqual([
      "covered", "missing"
    ]);
    const secondOnly = corrected("unsupported", "supported");
    expect(secondOnly.claims.slice(1).map(({ verdict }) => verdict)).toEqual([
      "unsupported", "supported"
    ]);
    expect(secondOnly.coverage.slice(1, 3).map(({ status }) => status)).toEqual([
      "missing", "covered"
    ]);

    const evidence = [{
      exactExcerpt: "Alpha is bounded.", handle: "K1"
    }, {
      exactExcerpt: "A shared mechanism is enabled.", handle: "K2"
    }, {
      exactExcerpt: "A shared mechanism is enabled.", handle: "K3"
    }] as const;
    const bothSupported = settleKnowledgeAnswerV21FromFinalSelectorV38({
      draft: merged.draft,
      evidence,
      selector: corrected("supported", "supported"),
      scopeProtocol: "append_only_completeness_reduce_v2"
    });
    expect(bothSupported.supportedClaimCount).toBe(3);
    expect(bothSupported.finalText.match(/A shared mechanism is enabled\./gu))
      .toHaveLength(1);
    expect(bothSupported.finalText).toContain("[K2]");
    expect(bothSupported.finalText).not.toContain("[K3]");

    const neitherSupported = settleKnowledgeAnswerV21FromFinalSelectorV38({
      draft: merged.draft,
      evidence,
      selector: corrected("unsupported", "unsupported"),
      scopeProtocol: "append_only_completeness_reduce_v2"
    });
    expect(neitherSupported.supportedClaimCount).toBe(1);
    expect(neitherSupported.finalText).not.toContain("A shared mechanism is enabled.");
  });

  it("drops exact primary repeats only when every target retains a candidate", () => {
    const input = {
      availableHandles: ["K1", "K2", "K3"],
      missingDimensions: missing,
      primaryDraft: primary
    } as const;
    const mixed = {
      targets: {
        D2: ["Alpha is bounded.", "Beta preserves order."],
        D3: ["Gamma removes duplicates."]
      },
      version: 2
    };
    const normalized = normalizeKnowledgeTargetedSupplementExactPrimaryDuplicatesV1(
      mixed,
      primary
    );
    expect(normalized).toEqual({
      targets: {
        D2: ["Beta preserves order."],
        D3: ["Gamma removes duplicates."]
      },
      version: 2
    });
    expect(validateKnowledgeTargetedSupplementV4(normalized, input).kind).toBe(
      "accepted"
    );

    const wouldEmptyTarget = {
      ...mixed,
      targets: {
        ...mixed.targets,
        D2: ["Alpha is bounded."]
      }
    };
    expect(normalizeKnowledgeTargetedSupplementExactPrimaryDuplicatesV1(
      wouldEmptyTarget,
      primary
    )).toBe(wouldEmptyTarget);
    expect(validateKnowledgeTargetedSupplementV4(
      wouldEmptyTarget,
      input
    )).toEqual({ kind: "rejected", reason: "draft_duplicate_primary_claim" });
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

  it("reviews a missing dated-reading target covered by immutable primary handles", () => {
    const target = Object.freeze({
      description: "List the readings recorded on 2026-01-01, 2026-01-02, and 2026-01-03.",
      evidenceAtomIds: Object.freeze(["A1", "A2", "A3"]),
      evidenceHandles: Object.freeze(["K1", "K2", "K3"]),
      id: "D1",
      requestAnchor: "all three dated readings",
      status: "missing" as const,
      supportIds: Object.freeze([])
    });
    const primaryClaims = Object.freeze(["K1", "K2", "K3"].map((handle, index) =>
      Object.freeze({
        id: `C${index + 1}`,
        supportHandles: Object.freeze([handle]),
        verdict: "supported" as const
      })));
    const initial = selector({
      claims: primaryClaims,
      coverage: Object.freeze([target])
    });
    const optionalUnsupported = Object.freeze({
      id: "C4",
      supportHandles: Object.freeze([]),
      verdict: "unsupported" as const
    });
    const final = selector({
      claims: Object.freeze([...primaryClaims, optionalUnsupported]),
      coverage: Object.freeze([target])
    });
    const input = {
      bindings: [{ claimId: "C4", targetDimensionId: "D1" }],
      finalSelector: final,
      initialSelector: initial,
      primaryClaimCount: 3,
      reopenedTargetIds: ["D1"]
    } as const;

    expect(knowledgeGroundedDeltaCoverageReviewRequiredV1(input)).toBe(false);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV2(input)).toBe(true);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV2({
      ...input,
      finalSelector: selector({
        claims: Object.freeze([primaryClaims[0]!, Object.freeze({
          ...primaryClaims[1]!,
          supportHandles: Object.freeze([]),
          verdict: "unsupported" as const
        }), primaryClaims[2]!, optionalUnsupported]),
        coverage: final.coverage
      })
    })).toBe(false);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV2({
      ...input,
      initialSelector: selector({
        claims: primaryClaims,
        coverage: Object.freeze([Object.freeze({
          ...target,
          evidenceAtomIds: Object.freeze([...target.evidenceAtomIds, "A4"]),
          evidenceHandles: Object.freeze([...target.evidenceHandles, "K4"])
        })])
      }),
      finalSelector: selector({
        claims: final.claims,
        coverage: Object.freeze([Object.freeze({
          ...target,
          evidenceAtomIds: Object.freeze([...target.evidenceAtomIds, "A4"]),
          evidenceHandles: Object.freeze([...target.evidenceHandles, "K4"])
        })])
      })
    })).toBe(false);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV2({
      ...input,
      bindings: [{ claimId: "C4", targetDimensionId: "D2" }]
    })).toBe(false);
    expect(knowledgeGroundedDeltaCoverageReviewRequiredV2({
      ...input,
      reopenedTargetIds: []
    })).toBe(false);
  });

  it("lets the current target reduce reuse only immutable provenance-local primary points", () => {
    const initial = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze(["K1"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([dimension("D1", "K1", "missing")])
    });
    expect(knowledgeTargetPrimaryClaimsV1({
      draft: primary,
      initialSelector: initial
    })).toEqual([{
      id: "C1",
      supportHandles: ["K1"],
      targetDimensionIds: ["D1"],
      text: "Alpha is bounded."
    }]);
    const final = selector({
      claims: Object.freeze([initial.claims[0]!, Object.freeze({
        id: "C2",
        supportHandles: Object.freeze([]),
        verdict: "unsupported" as const
      })]),
      coverage: Object.freeze([dimension("D1", "K1", "covered", ["C1"])])
    });
    const input = {
      bindings: [{ claimId: "C2", targetDimensionId: "D1" }],
      finalSelector: final,
      initialSelector: initial,
      primaryClaimCount: 1
    } as const;
    expect(mergeKnowledgeGroundedCorrectionV2(input).coverage[0]).toMatchObject({
      status: "missing",
      supportIds: []
    });
    expect(mergeKnowledgeGroundedCorrectionV3(input).coverage[0]).toMatchObject({
      status: "covered",
      supportIds: ["C1"]
    });

    const foreignInitial = selector({
      claims: initial.claims,
      coverage: Object.freeze([dimension("D1", "K2", "missing")])
    });
    const foreignFinal = selector({
      claims: final.claims,
      coverage: Object.freeze([dimension("D1", "K2", "covered", ["C1"])])
    });
    expect(mergeKnowledgeGroundedCorrectionV3({
      ...input,
      finalSelector: foreignFinal,
      initialSelector: foreignInitial
    }).coverage[0]).toMatchObject({ status: "missing", supportIds: [] });
  });

  it("canonicalizes primary-state drift before accumulative target reduction", () => {
    const initial = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze(["K1"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([dimension("D1", "K1", "missing")])
    });
    const final = selector({
      claims: Object.freeze([Object.freeze({
        id: "C1",
        supportHandles: Object.freeze([]),
        verdict: "unsupported" as const
      }), Object.freeze({
        id: "C2",
        supportHandles: Object.freeze(["K1"]),
        verdict: "supported" as const
      })]),
      coverage: Object.freeze([dimension("D1", "K1", "covered", ["C2"])])
    });
    const corrected = mergeKnowledgeGroundedCorrectionV3({
      bindings: [{ claimId: "C2", targetDimensionId: "D1" }],
      finalSelector: final,
      initialSelector: initial,
      primaryClaimCount: 1
    });
    expect(corrected.claims).toEqual([{
      id: "C1",
      supportHandles: ["K1"],
      verdict: "supported"
    }, {
      id: "C2",
      supportHandles: ["K1"],
      verdict: "supported"
    }]);
    expect(corrected.coverage[0]).toMatchObject({
      status: "covered",
      supportIds: ["C2"]
    });
  });
});
