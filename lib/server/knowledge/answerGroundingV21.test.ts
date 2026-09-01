import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_DRAFT_MALFORMED,
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_PARTIAL_COVERAGE_NOTE,
  settleKnowledgeAnswerV5,
  type KnowledgeAnswerDraftV5,
  type KnowledgeGroundedSelectorV3,
  type KnowledgeSelectorEvidenceV1
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V21,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V2,
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_SCHEMA_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V17,
  buildKnowledgeSupportedAnswerViewV1,
  decodeKnowledgeAnswerDraftSupplementV21,
  decodeKnowledgeAnswerDraftV21,
  decodeKnowledgeGroundedSelectorFailureV17,
  decodeKnowledgeGroundedSelectorFinalV17,
  decodeKnowledgeGroundedSelectorV17,
  knowledgeAnswerDraftPromptV21,
  knowledgeAnswerV21FailureCode,
  knowledgeGroundedSelectorPromptV17,
  knowledgeGroundedSelectorV17Fallback,
  mergeKnowledgeAnswerDraftsV21,
  settleKnowledgeAnswerV21FromAudit,
  settleKnowledgeAnswerV21FromFinalSelector,
  validateKnowledgeGroundedSelectorFinalV17,
  validateKnowledgeGroundedSelectorV17,
  type KnowledgeGroundedSelectorV17
} from "./answerGroundingV21";
import {
  KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1,
  knowledgeAnswerDraftPromptV21GlobalReducerV1
} from "./answerGroundingGlobalReducerV1";
import {
  decodeKnowledgeCoverageAuditV2,
  knowledgeCoverageAuditDimensionsV2,
  type KnowledgeCoverageAuditV2
} from "./coverageAuditV2";
import type { KnowledgeSupportedAnswerViewV1 } from "./coverageAuditV1";

const request = "How does the process preserve order, remove duplicates, and bound memory?";
const evidenceManifest =
  "<private_knowledge_evidence>bounded immutable evidence</private_knowledge_evidence>";
const evidence: readonly KnowledgeSelectorEvidenceV1[] = Object.freeze([
  Object.freeze({
    exactExcerpt: "Mechanism A preserves the original order.",
    handle: "K1"
  }),
  Object.freeze({
    exactExcerpt: "Mechanism B removes duplicate records.",
    handle: "K2"
  }),
  Object.freeze({
    exactExcerpt: "Mechanism C bounds memory use.",
    handle: "K3"
  }),
  Object.freeze({
    exactExcerpt: "A neighboring theorem concerns storage layout.",
    handle: "K4"
  }),
  Object.freeze({
    exactExcerpt: "Mode A retains 10 records.",
    handle: "K5"
  }),
  Object.freeze({
    exactExcerpt: "Mode B retains 5 records.",
    handle: "K6"
  })
]);

function rawDraft(
  claims: readonly Readonly<{ hints: readonly string[]; text: string }>[]
): unknown {
  return {
    claims: claims.map(({ hints, text }) => ({ citationHints: hints, text })),
    version: 1
  };
}

function draft(
  claims: readonly Readonly<{ hints: readonly string[]; text: string }>[]
): KnowledgeAnswerDraftV5 {
  const value = decodeKnowledgeAnswerDraftV21(rawDraft(claims), {
    availableHandles: evidence.map(({ handle }) => handle)
  });
  if (!value) throw new Error("fixture_draft_invalid");
  return value;
}

function rawSelector(
  currentDraft: KnowledgeAnswerDraftV5,
  verdicts: readonly ("contradicted" | "supported" | "unsupported")[]
): unknown {
  return {
    claims: currentDraft.claims.map((claim, index) => ({
      id: claim.id,
      supportHandles: verdicts[index] === "supported" ? claim.citationHints : [],
      verdict: verdicts[index]
    })),
    extractIds: [],
    insufficientReason: verdicts.includes("supported") ? "not_applicable" : "not_found",
    version: 1
  };
}

function selector(
  currentDraft: KnowledgeAnswerDraftV5,
  verdicts: readonly ("contradicted" | "supported" | "unsupported")[]
): KnowledgeGroundedSelectorV17 {
  const value = decodeKnowledgeGroundedSelectorV17(
    rawSelector(currentDraft, verdicts),
    { draft: currentDraft, evidence }
  );
  if (!value) throw new Error("fixture_selector_invalid");
  return value;
}

function auditFor(
  view: KnowledgeSupportedAnswerViewV1,
  dimensions: readonly Readonly<{
    description: string;
    hints?: readonly string[];
    id: string;
    requestAnchor: string;
    status: "covered" | "missing";
    supportIds?: readonly string[];
  }>[]
): KnowledgeCoverageAuditV2 {
  const supportHandlesById = new Map([
    ...view.claims.map(({ id, supportHandles }) => [id, supportHandles] as const),
    ...view.literals.map(({ handle, id }) => [id, [handle]] as const)
  ]);
  const value = decodeKnowledgeCoverageAuditV2({
    coverage: dimensions.map((dimension) => ({
      id: dimension.id,
      status: dimension.status,
      supportIds: dimension.supportIds ?? []
    })),
    scope: dimensions.map((dimension) => ({
      description: dimension.description,
      evidenceHandles: dimension.hints ?? [...new Set(
        (dimension.supportIds ?? []).flatMap((id) => supportHandlesById.get(id) ?? [])
      )],
      id: dimension.id,
      requestAnchor: dimension.requestAnchor
    })),
    version: 2
  }, { evidence, request, supportedView: view });
  if (!value) throw new Error("fixture_audit_invalid");
  return value;
}

const threeDimensions = Object.freeze([
  Object.freeze({
    description: "Explain how the process preserves order.",
    id: "D1",
    requestAnchor: "preserve order"
  }),
  Object.freeze({
    description: "Explain how the process removes duplicates.",
    id: "D2",
    requestAnchor: "remove duplicates"
  }),
  Object.freeze({
    description: "Explain how the process bounds memory.",
    id: "D3",
    requestAnchor: "bound memory"
  })
]);

describe("Knowledge grounding V21 contracts", () => {
  it("declares side-by-side operation and strict schema identities", () => {
    expect([
      KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V17,
      KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
      KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V17
    ]).toEqual([
      "knowledge_answer_draft_v21",
      "knowledge_grounded_selector_v17",
      "knowledge_answer_draft_supplement_v21",
      "knowledge_grounded_selector_final_v17"
    ]);
    expect(KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V2).toMatchObject({
      coverageAuditorContractVersion: 2,
      coverageAuditorOperation: "knowledge_coverage_auditor_v2",
      draftContractVersion: 21,
      selectorContractVersion: 17,
      settlementVersion: 6
    });
    expect(KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21).toMatchObject({
      additionalProperties: false,
      required: ["version", "claims"]
    });
    expect(KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V17).toMatchObject({
      additionalProperties: false,
      required: ["version", "claims", "extractIds", "insufficientReason"]
    });
    expect(KNOWLEDGE_GROUNDED_SELECTOR_FINAL_SCHEMA_V17).toMatchObject({
      additionalProperties: false,
      required: ["version", "claims", "extractIds", "coverage", "insufficientReason"]
    });
  });

  it("keeps primary Draft independent from coverage and sufficiency", () => {
    const prompt = knowledgeAnswerDraftPromptV21({
      draftPass: "primary",
      evidenceManifest,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    });
    expect(KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V21).toContain(
      "exact user request as the primary scope authority"
    );
    expect(KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V21).toContain("adjacent topics");
    expect(KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V21).not.toContain("coveragePlan");
    expect(prompt.userPrompt).not.toContain("coveragePlan");
    expect(prompt.userPrompt).not.toContain("dimensions");
    expect(() => knowledgeAnswerDraftPromptV21({
      coveragePlan: { dimensions: [] },
      draftPass: "primary",
      evidenceManifest,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    } as never)).toThrow("knowledge_answer_draft_v21_prompt_invalid");
  });

  it("atomizes co-equal current Draft facets without changing historical bytes", () => {
    const input = {
      draftPass: "primary" as const,
      evidenceManifest,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    };
    const historical = knowledgeAnswerDraftPromptV21(input);
    const current = knowledgeAnswerDraftPromptV21GlobalReducerV1(input);
    expect(current.userPrompt).toBe(historical.userPrompt);
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n` +
      KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1
    );
    expect(current.systemPrompt).toContain("one claim per facet");
    expect(current.systemPrompt).toContain("independent-verdict test");
    expect(current.systemPrompt).toContain("later Selector may combine multiple");
  });

  it("assigns Draft IDs/layout server-side and rejects malformed candidates", () => {
    const value = draft([
      { hints: ["K1"], text: "The process preserves the original order." },
      { hints: ["K2"], text: "The process removes duplicate records." }
    ]);
    expect(value.claims.map(({ id }) => id)).toEqual(["C1", "C2"]);
    expect(value.blocks).toEqual([{ claimIds: ["C1", "C2"], type: "bullets" }]);
    expect(decodeKnowledgeAnswerDraftV21({
      ...rawDraft([{ hints: ["K1"], text: "Valid." }]) as object,
      extra: true
    }, { availableHandles: ["K1"] })).toBeNull();
    expect(decodeKnowledgeAnswerDraftV21(rawDraft([
      { hints: ["K9"], text: "Unknown evidence." }
    ]), { availableHandles: ["K1"] })).toBeNull();
    expect(decodeKnowledgeAnswerDraftV21(rawDraft([
      { hints: ["K1"], text: "Unsafe\nclaim." }
    ]), { availableHandles: ["K1"] })).toBeNull();
  });

  it("accepts only Selector-owned classified failures", () => {
    expect(decodeKnowledgeGroundedSelectorFailureV17(
      knowledgeGroundedSelectorV17Fallback("selector_timeout")
    )).toEqual({ kind: "selector_failed", reason: "selector_timeout" });
    expect(decodeKnowledgeGroundedSelectorFailureV17({
      kind: "selector_failed",
      reason: "draft_malformed"
    })).toBeNull();
  });

  it("makes initial Selector factual-support-only with exact claim identity", () => {
    const currentDraft = draft([
      {
        hints: ["K5", "K6"],
        text: "Mode A retains 5 more records than Mode B (10 versus 5)."
      }
    ]);
    const accepted = decodeKnowledgeGroundedSelectorV17({
      claims: [{
        id: "C1",
        supportHandles: ["K5", "K6"],
        verdict: "supported"
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { draft: currentDraft, evidence });
    expect(accepted?.claims[0]).toEqual({
      id: "C1",
      supportHandles: ["K5", "K6"],
      verdict: "supported"
    });
    expect(KNOWLEDGE_GROUNDED_SELECTOR_CONTRACT_V17).toContain(
      "Initial and repair passes decide factual support only"
    );
    expect(KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V17).not.toHaveProperty(
      "properties.coverage"
    );

    expect(validateKnowledgeGroundedSelectorV17({
      claims: [],
      extractIds: [],
      insufficientReason: "not_found",
      version: 1
    }, { draft: currentDraft, evidence })).toEqual({
      kind: "rejected",
      reason: "selector_claim_set_invalid"
    });
  });

  it("physically excludes unsupported Draft text from SupportedAnswerViewV1", () => {
    const currentDraft = draft([
      { hints: ["K1"], text: "The process preserves the original order." },
      { hints: ["K4"], text: "The neighboring theorem is the requested mechanism." }
    ]);
    const currentSelector = selector(currentDraft, ["supported", "unsupported"]);
    const view = buildKnowledgeSupportedAnswerViewV1({
      draft: currentDraft,
      evidence,
      selector: currentSelector
    });
    expect(view.claims).toEqual([{
      id: "C1",
      supportHandles: ["K1"],
      text: "The process preserves the original order."
    }]);
    expect(JSON.stringify(view)).not.toContain("neighboring theorem");
  });

  it("does not publish supported adjacent content outside audited request scope", () => {
    const scopedRequest = "How does the process preserve order?";
    const currentDraft = draft([
      { hints: ["K1"], text: "The process preserves the original order." },
      { hints: ["K4"], text: "The neighboring theorem concerns storage layout." }
    ]);
    const currentSelector = selector(currentDraft, ["supported", "supported"]);
    const view = buildKnowledgeSupportedAnswerViewV1({
      draft: currentDraft,
      evidence,
      selector: currentSelector
    });
    const audit = decodeKnowledgeCoverageAuditV2({
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
      scope: [{
        description: "Explain how the process preserves order.",
        evidenceHandles: ["K1"],
        id: "D1",
        requestAnchor: "preserve order"
      }],
      version: 2
    }, { evidence, request: scopedRequest, supportedView: view });
    const settlement = settleKnowledgeAnswerV21FromAudit({
      audit,
      draft: currentDraft,
      evidence,
      request: scopedRequest,
      selector: currentSelector
    });
    expect(settlement.finalText).toContain("preserves the original order");
    expect(settlement.finalText).not.toContain("storage layout");
  });

  it("recovers a generically omitted co-equal axis in one bounded correction", () => {
    const primary = draft([
      { hints: ["K1"], text: "The process preserves the original order." },
      { hints: ["K2"], text: "The process removes duplicate records." }
    ]);
    const initial = selector(primary, ["supported", "supported"]);
    const initialView = buildKnowledgeSupportedAnswerViewV1({
      draft: primary,
      evidence,
      selector: initial
    });
    const audit = auditFor(initialView, [
      { ...threeDimensions[0]!, status: "covered", supportIds: ["C1"] },
      { ...threeDimensions[1]!, status: "covered", supportIds: ["C2"] },
      { ...threeDimensions[2]!, hints: ["K3"], status: "missing" }
    ]);
    const partial = settleKnowledgeAnswerV21FromAudit({
      audit,
      draft: primary,
      evidence,
      request,
      selector: initial
    });
    expect(partial.requestCoverage).toBe("partial");
    expect(partial.finalText).toContain(KNOWLEDGE_PARTIAL_COVERAGE_NOTE);

    const supplementPrompt = knowledgeAnswerDraftPromptV21({
      auditDimensions: knowledgeCoverageAuditDimensionsV2(audit)
        .filter(({ status }) => status === "missing"),
      draftPass: "supplement",
      evidenceManifest,
      primaryDraft: primary,
      request,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    });
    expect(supplementPrompt.userPrompt).toContain("D3");
    expect(supplementPrompt.userPrompt).toContain("primaryDraft");
    const supplement = decodeKnowledgeAnswerDraftSupplementV21(rawDraft([
      { hints: ["K3"], text: "The process bounds memory use." }
    ]), { availableHandles: evidence.map(({ handle }) => handle) });
    const merged = mergeKnowledgeAnswerDraftsV21({
      primary,
      supplement: supplement!
    });
    expect("claims" in merged && merged.claims.map(({ id }) => id)).toEqual([
      "C1",
      "C2",
      "C3"
    ]);
    const final = decodeKnowledgeGroundedSelectorFinalV17({
      claims: [
        { id: "C1", supportHandles: ["K1"], verdict: "supported" },
        { id: "C2", supportHandles: ["K2"], verdict: "supported" },
        { id: "C3", supportHandles: ["K3"], verdict: "supported" }
      ],
      coverage: [
        { id: "D1", status: "covered", supportIds: ["C1"] },
        { id: "D2", status: "covered", supportIds: ["C2"] },
        { id: "D3", status: "covered", supportIds: ["C3"] }
      ],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { audit, draft: merged, evidence });
    expect(final?.coverage.map(({ description }) => description)).toEqual(
      threeDimensions.map(({ description }) => description)
    );
    const complete = settleKnowledgeAnswerV21FromFinalSelector({
      draft: merged,
      evidence,
      selector: final!
    });
    expect(complete.requestCoverage).toBe("complete");
    expect(complete.finalText).toContain("bounds memory use");
    expect(complete.finalText).not.toContain(KNOWLEDGE_PARTIAL_COVERAGE_NOTE);
  });

  it("recovers from a malformed primary Draft without inheriting malformed state", () => {
    const emptySelector = decodeKnowledgeGroundedSelectorV17({
      claims: [],
      extractIds: [],
      insufficientReason: "not_found",
      version: 1
    }, { draft: KNOWLEDGE_DRAFT_MALFORMED, evidence });
    const emptyView = buildKnowledgeSupportedAnswerViewV1({
      draft: KNOWLEDGE_DRAFT_MALFORMED,
      evidence,
      selector: emptySelector!
    });
    const audit = auditFor(emptyView, [{
      ...threeDimensions[2]!,
      hints: ["K3"],
      id: "D1",
      status: "missing"
    }]);
    const supplement = decodeKnowledgeAnswerDraftSupplementV21(rawDraft([
      { hints: ["K3"], text: "The process bounds memory use." }
    ]), { availableHandles: evidence.map(({ handle }) => handle) });
    const merged = mergeKnowledgeAnswerDraftsV21({
      primary: KNOWLEDGE_DRAFT_MALFORMED,
      supplement: supplement!
    });
    expect("claims" in merged && merged.claims[0]?.id).toBe("C1");
    const final = decodeKnowledgeGroundedSelectorFinalV17({
      claims: [{ id: "C1", supportHandles: ["K3"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { audit, draft: merged, evidence });
    expect(settleKnowledgeAnswerV21FromFinalSelector({
      draft: merged,
      evidence,
      selector: final!
    })).toMatchObject({ outcome: "answered", requestCoverage: "complete" });
  });

  it("fails to insufficient evidence when no supported content exists", () => {
    const noEvidence: readonly KnowledgeSelectorEvidenceV1[] = [];
    const emptySelector = decodeKnowledgeGroundedSelectorV17({
      claims: [],
      extractIds: [],
      insufficientReason: "not_found",
      version: 1
    }, { draft: KNOWLEDGE_DRAFT_MALFORMED, evidence: noEvidence });
    const emptyView = buildKnowledgeSupportedAnswerViewV1({
      draft: KNOWLEDGE_DRAFT_MALFORMED,
      evidence: noEvidence,
      selector: emptySelector!
    });
    const audit = decodeKnowledgeCoverageAuditV2({
      coverage: [{
        id: "D1",
        status: "missing",
        supportIds: []
      }],
      scope: [{
        description: "Explain how the process preserves order.",
        evidenceHandles: [],
        id: "D1",
        requestAnchor: "preserve order"
      }],
      version: 2
    }, { evidence: noEvidence, request, supportedView: emptyView });
    expect(settleKnowledgeAnswerV21FromAudit({
      audit,
      draft: KNOWLEDGE_DRAFT_MALFORMED,
      evidence: noEvidence,
      request,
      selector: emptySelector!
    })).toMatchObject({
      outcome: "insufficient_evidence",
      requestCoverage: "none",
      supportedClaimCount: 0
    });
  });

  it("preserves immutable audit IDs, order, and descriptions on final", () => {
    const primary = draft([
      { hints: ["K1"], text: "The process preserves the original order." },
      { hints: ["K2"], text: "The process removes duplicate records." }
    ]);
    const initial = selector(primary, ["supported", "supported"]);
    const view = buildKnowledgeSupportedAnswerViewV1({
      draft: primary,
      evidence,
      selector: initial
    });
    const audit = auditFor(view, [
      { ...threeDimensions[0]!, status: "covered", supportIds: ["C1"] },
      { ...threeDimensions[1]!, status: "covered", supportIds: ["C2"] }
    ]);
    const swapped = validateKnowledgeGroundedSelectorFinalV17({
      ...rawSelector(primary, ["supported", "supported"]) as object,
      coverage: [
        { id: "D2", status: "covered", supportIds: ["C2"] },
        { id: "D1", status: "covered", supportIds: ["C1"] }
      ]
    }, { audit, draft: primary, evidence });
    expect(swapped).toEqual({ kind: "rejected", reason: "selector_dimension_invalid" });

    const crossScoped = validateKnowledgeGroundedSelectorFinalV17({
      ...rawSelector(primary, ["supported", "supported"]) as object,
      coverage: [
        { id: "D1", status: "covered", supportIds: ["C2"] },
        { id: "D2", status: "covered", supportIds: ["C1"] }
      ]
    }, { audit, draft: primary, evidence });
    expect(crossScoped).toEqual({
      kind: "rejected",
      reason: "selector_dimension_invalid"
    });

    const rewritten = validateKnowledgeGroundedSelectorFinalV17({
      ...rawSelector(primary, ["supported", "supported"]) as object,
      coverage: [
        {
          description: "Rewritten dimension",
          id: "D1",
          status: "covered",
          supportIds: ["C1"]
        },
        { id: "D2", status: "covered", supportIds: ["C2"] }
      ]
    }, { audit, draft: primary, evidence });
    expect(rewritten).toEqual({ kind: "rejected", reason: "selector_dimension_invalid" });
  });

  it("fails closed on malformed audit before settlement", () => {
    const primary = draft([
      { hints: ["K1"], text: "The process preserves the original order." }
    ]);
    const initial = selector(primary, ["supported"]);
    expect(() => settleKnowledgeAnswerV21FromAudit({
      audit: {
        coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
        scope: [{
          description: "Explain order.",
          evidenceHandles: ["K1"],
          id: "D1",
          requestAnchor: "not in request"
        }],
        version: 2
      },
      draft: primary,
      evidence,
      request,
      selector: initial
    })).toThrow("knowledge_coverage_audit_unaccepted");
    expect(knowledgeAnswerV21FailureCode(
      new Error("knowledge_coverage_audit_unaccepted")
    )).toBe("coverage_audit_malformed");
  });

  it("preserves historical renderer output for equivalent supported claims", () => {
    const primary = draft([
      { hints: ["K1"], text: "The process preserves the original order." },
      { hints: ["K2"], text: "The process removes duplicate records." }
    ]);
    const initial = selector(primary, ["supported", "supported"]);
    const view = buildKnowledgeSupportedAnswerViewV1({
      draft: primary,
      evidence,
      selector: initial
    });
    const audit = auditFor(view, [
      { ...threeDimensions[0]!, status: "covered", supportIds: ["C1"] },
      { ...threeDimensions[1]!, status: "covered", supportIds: ["C2"] }
    ]);
    const current = settleKnowledgeAnswerV21FromAudit({
      audit,
      draft: primary,
      evidence,
      request,
      selector: initial
    });
    const historicalSelector: KnowledgeGroundedSelectorV3 = Object.freeze({
      claims: initial.claims,
      decision: "select_claims",
      requestCoverage: "complete",
      version: 1
    });
    const historical = settleKnowledgeAnswerV5({
      draft: primary,
      evidence,
      selector: { kind: "accepted", value: historicalSelector }
    });
    expect(current).toEqual(historical);
  });

  it("builds phase-specific Selector prompts without completeness leakage", () => {
    const primary = draft([
      { hints: ["K1"], text: "The process preserves the original order." }
    ]);
    const initialPrompt = knowledgeGroundedSelectorPromptV17({
      draft: primary,
      evidence,
      evidenceManifest,
      request,
      selectorPass: "initial"
    });
    expect(initialPrompt.userPrompt).not.toContain("coverageAudit");
    expect(initialPrompt.userPrompt).not.toContain("dimensions");
    expect(initialPrompt.systemPrompt).toContain("support only");

    const initial = selector(primary, ["supported"]);
    const view = buildKnowledgeSupportedAnswerViewV1({
      draft: primary,
      evidence,
      selector: initial
    });
    const audit = auditFor(view, [{
      ...threeDimensions[0]!,
      status: "covered",
      supportIds: ["C1"]
    }]);
    const finalPrompt = knowledgeGroundedSelectorPromptV17({
      audit,
      draft: primary,
      evidence,
      evidenceManifest,
      request,
      selectorPass: "final"
    });
    expect(finalPrompt.userPrompt).toContain("coverageAudit");
    expect(finalPrompt.userPrompt).toContain(
      "Explain how the process preserves order."
    );
    expect(finalPrompt.userPrompt).not.toContain("referenceAnswer");
  });
});
