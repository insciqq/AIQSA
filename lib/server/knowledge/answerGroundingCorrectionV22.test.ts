import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import { knowledgeCoverageEvidenceAtomIndexV2 } from "./coverageScopeV4";
import { knowledgeSelectorLiteralExtractIndexV2 } from "./answerGroundingV5";
import { validateKnowledgeCoverageScopeV6 } from "./coverageScopeV6";
import {
  settleKnowledgeAnswerV22,
  validateKnowledgeGroundedSelectorV22,
  type KnowledgePublicationInputV1
} from "./answerGroundingSelectorV22";
import {
  EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3,
  admitKnowledgeCorrectionV2,
  knowledgeCorrectionDeltaPromptV2,
  knowledgeCorrectionDeltaSchemaV2,
  knowledgeCorrectionOperationPlanV2,
  mergeKnowledgeCorrectionDeltaV2,
  mergeKnowledgeCorrectionDraftV3,
  validateKnowledgeCorrectionDeltaV2,
  validateKnowledgeCorrectionSupplementV3
} from "./answerGroundingCorrectionV22";

function fixture(claimCount = 2, evidence = [
  { exactExcerpt: "The Atlas controller keeps input order.", handle: "K1" },
  { exactExcerpt: "The Boreal controller preserves saved entries.", handle: "K2" }
]): KnowledgePublicationInputV1 {
  const request = "Describe Atlas and Boreal.";
  const atoms = knowledgeCoverageEvidenceAtomIndexV2(evidence);
  const scope = validateKnowledgeCoverageScopeV6({
    evidenceUnits: evidence.map(({ handle }, index) => ({
      findings: [{ description: `Describe ${index ? "Boreal" : "Atlas"}.`,
        evidenceAtomIds: atoms.items.filter((atom) => atom.handle === handle).map(({ id }) => id),
        requestAnchor: index ? "Boreal" : "Atlas" }], handle
    })), jointFindings: [], unsupportedDimensions: [], version: 6
  }, { atomIndexVersion: 2, evidence, request });
  if (scope.kind !== "accepted") throw new Error("fixture_scope_invalid");
  const draft = decodeKnowledgeAnswerDraftV21({ claims: Array.from({ length: claimCount }, (_, index) => ({
    citationHints: [index === 1 ? "K2" : "K1"],
    text: index === 0 ? "The Atlas controller keeps input order." : `Candidate property ${index + 1}.`
  })), version: 1 }, { availableHandles: ["K1", "K2"] })!;
  const input = { atomIndexVersion: 2 as const, draft, evidence, request, scope: scope.value };
  const selector = validateKnowledgeGroundedSelectorV22({
    claims: Array.from({ length: claimCount }, (_, index) => ({
      id: `C${index + 1}`, supportHandles: index < 2 ? [index ? "K2" : "K1"] : [],
      verdict: index < 2 ? "supported" : "unsupported"
    })),
    coverage: scope.value.scope.map(({ id }) => ({ contributionIds: [], id, status: "missing" })),
    insufficientReason: "not_found", version: 2
  }, input);
  if (selector.kind !== "accepted") throw new Error("fixture_selector_invalid");
  return { ...input, selector: selector.value };
}

function delta(additions = ["C1"]) {
  return { claims: [], targets: {
    D1: { addContributionIds: additions, status: "missing" },
    D2: { addContributionIds: [], status: "missing" }
  }, version: 2 };
}

describe("additive target-local correction", () => {
  it("admits mapping at a full 24-claim Draft and preserves accepted partial contributions on replay", () => {
    const input = { ...fixture(24), supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 };
    const before = JSON.stringify(input.selector);
    const admission = admitKnowledgeCorrectionV2(input)!;
    expect(admission).not.toBeNull();
    expect(admission.targets.every(({ maxSupplementClaims }) => maxSupplementClaims === 0)).toBe(true);
    expect(knowledgeCorrectionOperationPlanV2({ admission, operationCount: 5 })).toBe("mapping_only");
    const validation = validateKnowledgeCorrectionDeltaV2(delta(), input);
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") throw new Error(validation.reason);
    const selector = mergeKnowledgeCorrectionDeltaV2({ ...input, delta: validation.value });
    expect(settleKnowledgeAnswerV22({ ...input, selector })).toMatchObject({
      outcome: "answered", requestCoverage: "partial", supportedClaimCount: 1
    });
    expect(selector.claims).toEqual(input.selector.claims);
    expect(JSON.stringify(input.selector)).toBe(before);
    expect(mergeKnowledgeCorrectionDeltaV2({ ...input, delta: JSON.parse(JSON.stringify(validation.value)) }))
      .toEqual(selector);
    const schema = knowledgeCorrectionDeltaSchemaV2(input) as { properties: { claims: { maxItems: number } } };
    expect(schema.properties.claims.maxItems).toBe(0);
    expect(JSON.parse(knowledgeCorrectionDeltaPromptV2(input).userPrompt).targets[0].primaryPoints)
      .toEqual([expect.objectContaining({ id: "C1" })]);
  });

  it.each([
    { texts: [] },
    { texts: ["The Atlas controller keeps input order."] },
    { texts: ["The Atlas controller keeps input order.", "The Atlas controller keeps input order."] }
  ])("accepts empty and duplicate-only supplements before mapping: $texts", ({ texts }) => {
    const input = fixture();
    const supplement = validateKnowledgeCorrectionSupplementV3({ targets: { D1: texts, D2: [] }, version: 3 }, input);
    expect(supplement).toEqual({ kind: "accepted", value: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 });
    expect(validateKnowledgeCorrectionDeltaV2(delta(), { ...input, supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 }).kind)
      .toBe("accepted");
  });

  it("keeps a same-text supplement with independent target provenance", () => {
    const input = fixture();
    const supplement = validateKnowledgeCorrectionSupplementV3({ targets: {
      D1: [], D2: ["The Atlas controller keeps input order."]
    }, version: 3 }, input);
    expect(supplement.kind).toBe("accepted");
    if (supplement.kind !== "accepted") throw new Error(supplement.reason);
    expect(supplement.value.claims).toEqual([{ citationHints: ["K2"], id: "C3", text: "The Atlas controller keeps input order." }]);
    const validation = validateKnowledgeCorrectionDeltaV2({ ...delta(), claims: [
      { id: "C3", verdict: "supported", supportHandles: ["K2"] }
    ], targets: { D1: { addContributionIds: ["C1"], status: "covered" }, D2: { addContributionIds: ["C3"], status: "covered" } } }, {
      ...input, supplement: supplement.value
    });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") throw new Error(validation.reason);
    const draft = mergeKnowledgeCorrectionDraftV3({ ...input, supplement: supplement.value });
    const settled = settleKnowledgeAnswerV22({ ...input, draft, selector: validation.selector });
    expect(settled).toMatchObject({ requestCoverage: "complete", supportedClaimCount: 2 });
    expect(settled.finalText).toContain("[K1]");
    expect(settled.finalText).toContain("[K2]");
  });

  it("keeps zero mapping insufficient after an empty accepted delta", () => {
    const input = { ...fixture(), supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 };
    const validation = validateKnowledgeCorrectionDeltaV2(delta([]), input);
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") throw new Error(validation.reason);
    expect(settleKnowledgeAnswerV22({ ...input, selector: validation.selector })).toMatchObject({
      finalizationMode: "insufficient", supportedClaimCount: 0
    });
  });

  it("binds an accepted delta to the exact request and evidence, not only its IDs", () => {
    const input = { ...fixture(), supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 };
    const validation = validateKnowledgeCorrectionDeltaV2(delta(), input);
    if (validation.kind !== "accepted") throw new Error(validation.reason);
    expect(() => mergeKnowledgeCorrectionDeltaV2({ ...input, delta: validation.value,
      request: "Compare Atlas and Boreal."
    })).toThrow("knowledge_correction_delta_invalid");
    expect(() => mergeKnowledgeCorrectionDeltaV2({ ...input, delta: validation.value,
      evidence: input.evidence.map((item) => ({ ...item, exactExcerpt: item.exactExcerpt.replace("keeps", "preserves") }))
    })).toThrow("knowledge_correction_delta_invalid");
  });

  it.each([["C99"], ["C2"], ["C3"], ["L9999"]].map((additions) => ({ additions })))("rejects unknown, foreign or rejected additions: $additions", ({ additions }) => {
    const input = { ...fixture(3), supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 };
    expect(validateKnowledgeCorrectionDeltaV2(delta(additions), input).kind).toBe("rejected");
  });

  it("rejects attempts to resubmit primary truth, mutate non-targets or hide a missing requirement", () => {
    const input = { ...fixture(), supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 };
    expect(validateKnowledgeCorrectionDeltaV2({ ...delta(), claims: input.selector.claims }, input).kind).toBe("rejected");
    expect(validateKnowledgeCorrectionDeltaV2({ ...delta(), targets: { ...delta().targets, D3: delta().targets.D1 } }, input).kind).toBe("rejected");
    expect(validateKnowledgeCorrectionDeltaV2({ ...delta(), targets: {
      ...delta().targets, D1: { addContributionIds: [], status: "excluded" }
    } }, input).kind).toBe("rejected");
    expect(validateKnowledgeCorrectionDeltaV2({ ...delta(), targets: {
      ...delta().targets, D1: { addContributionIds: [], status: "covered" }
    } }, input).kind).toBe("rejected");
  });

  it("preserves overlap for initial contribution admission and containment for correction", () => {
    const input = fixture();
    const selector = { ...input.selector, claims: input.selector.claims.map((claim, index) => index === 0
      ? { ...claim, supportHandles: ["K1", "K2"] } : claim), coverage: input.selector.coverage.map((dimension, index) => index === 0
      ? { ...dimension, contributionIds: ["C1"] } : dimension), insufficientReason: "not_applicable" as const };
    expect(settleKnowledgeAnswerV22({ ...input, selector }).requestCoverage).toBe("partial");
    const admission = admitKnowledgeCorrectionV2({ ...input, selector })!;
    expect(admission.targets[0]!.primaryClaimIds).not.toContain("C1");
    const validation = validateKnowledgeCorrectionDeltaV2(delta([]), {
      ...input, selector, supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3
    });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") throw new Error(validation.reason);
    expect(validation.selector.coverage[0]!.contributionIds).toEqual(["C1"]);
  });

  it("checks the combined literal budget without deleting the accepted base", () => {
    const evidence = [
      { exactExcerpt: Array.from({ length: 16 }, (_, index) => `Recorded property ${index + 1} is available.`).join("\n"), handle: "K1" },
      { exactExcerpt: "Another recorded property is available.", handle: "K2" }
    ];
    const input = fixture(2, evidence);
    const literals = knowledgeSelectorLiteralExtractIndexV2(evidence).items;
    const baseIds = literals.filter(({ handle }) => handle === "K1").map(({ id }) => id);
    expect(baseIds).toHaveLength(16);
    const selector = { ...input.selector, coverage: input.selector.coverage.map((dimension, index) => index === 0
      ? { ...dimension, contributionIds: baseIds } : dimension), insufficientReason: "not_applicable" as const };
    expect(settleKnowledgeAnswerV22({ ...input, selector }).finalizationMode).toBe("evidence_only");
    const admitted = admitKnowledgeCorrectionV2({ ...input, selector })!;
    const literalId = admitted.targets[1]!.literals[0]!.id;
    const before = JSON.stringify(selector);
    const validation = validateKnowledgeCorrectionDeltaV2({ ...delta([]), targets: {
      D1: { addContributionIds: [], status: "missing" }, D2: { addContributionIds: [literalId], status: "covered" }
    } }, { ...input, selector, supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 });
    expect(validation).toMatchObject({ kind: "rejected", reason: "selector_literal_count_exceeded" });
    expect(JSON.stringify(selector)).toBe(before);
  });

  it("does not accept malformed supplement text or spend a ninth operation", () => {
    const input = fixture();
    expect(validateKnowledgeCorrectionSupplementV3({ targets: { D1: [null], D2: [] }, version: 3 }, input).kind)
      .toBe("rejected");
    const admission = admitKnowledgeCorrectionV2(input)!;
    expect(knowledgeCorrectionOperationPlanV2({ admission, operationCount: 6 })).toBe("supplement_and_mapping");
    expect(knowledgeCorrectionOperationPlanV2({ admission, operationCount: 7 })).toBe("mapping_only");
    expect(knowledgeCorrectionOperationPlanV2({ admission, operationCount: 8 })).toBeNull();
  });

  it("checks total code points across base and delta even when their separate budgets fit", () => {
    const evidence = [
      { exactExcerpt: Array.from({ length: 8 }, (_, index) => `Record ${index + 1} ` + String.fromCharCode(97 + index).repeat(1890)).join("\n"), handle: "K1" },
      { exactExcerpt: "Record nine " + "z".repeat(1890), handle: "K2" }
    ];
    const input = fixture(2, evidence);
    const literals = knowledgeSelectorLiteralExtractIndexV2(evidence).items;
    expect(literals).toHaveLength(9);
    const baseIds = literals.filter(({ handle }) => handle === "K1").map(({ id }) => id);
    const selector = { ...input.selector, coverage: input.selector.coverage.map((dimension, index) => index === 0
      ? { ...dimension, contributionIds: baseIds } : dimension), insufficientReason: "not_applicable" as const };
    expect(settleKnowledgeAnswerV22({ ...input, selector }).requestCoverage).toBe("partial");
    const admission = admitKnowledgeCorrectionV2({ ...input, selector })!;
    expect(admission.targets[1]!.literals).toHaveLength(1);
    expect(validateKnowledgeCorrectionDeltaV2({ ...delta([]), targets: {
      D1: { addContributionIds: [], status: "missing" },
      D2: { addContributionIds: [admission.targets[1]!.literals[0]!.id], status: "covered" }
    } }, { ...input, selector, supplement: EMPTY_KNOWLEDGE_CORRECTION_SUPPLEMENT_V3 })).toMatchObject({
      kind: "rejected", reason: "selector_literal_budget_invalid"
    });
  });
});
