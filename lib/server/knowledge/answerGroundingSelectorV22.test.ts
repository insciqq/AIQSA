import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import { decodeKnowledgeAnswerDraftMalformed, knowledgeSelectorLiteralExtractIndexV2 } from "./answerGroundingV5";
import { validateKnowledgeCoverageScopeV6 } from "./coverageScopeV6";
import { decodeKnowledgeContributionOperationFailureV1, knowledgeContributionOperationFailureV1 } from "./answerGroundingOperationFailureV1";
import {
  buildKnowledgePublicationPlanV1,
  knowledgeGroundedSelectorPromptV22,
  knowledgeSelectorPayloadV22,
  renderKnowledgePublicationPlanV1,
  settleKnowledgeAnswerV22,
  validateAcceptedKnowledgeSelectorV22,
  validateKnowledgeAnswerDraftContributionsV1,
  validateKnowledgeGroundedSelectorV22,
  type KnowledgeGroundedSelectorV22,
  type KnowledgeSelectorInputV22
} from "./answerGroundingSelectorV22";
import {
  applyKnowledgeCoverageScopeClosureV3,
  knowledgeCoverageScopeClosurePromptV3,
  validateKnowledgeCoverageScopeClosureV3
} from "./coverageScopeClosureV3";

function fixture(): KnowledgeSelectorInputV22 {
  const evidence = [
    { exactExcerpt: "Reading on 2040-01-01 was 42 units. The cabinet is blue.", handle: "K1" },
    { exactExcerpt: "Reading on 2040-02-01 was 35 units.", handle: "K2" },
    { exactExcerpt: "Reading on 2040-03-01 was 38 units.", handle: "K3" }
  ];
  const request = "Report the dated readings and explain the trend.";
  const validation = validateKnowledgeCoverageScopeV6({
    evidenceUnits: evidence.map(({ handle }) => ({ findings: [], handle })),
    jointFindings: [{
      description: "Report the dated readings and explain the trend.",
      evidenceAtomIds: ["A1", "A3", "A4"],
      requestAnchor: "dated readings"
    }],
    unsupportedDimensions: [],
    version: 6
  }, { atomIndexVersion: 2, evidence, request });
  if (validation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [
      ...evidence.map(({ exactExcerpt, handle }) => ({
        citationHints: [handle], text: exactExcerpt.split(". ")[0]!
      })),
      { citationHints: ["K1"], text: "The cabinet is blue." }
    ],
    version: 1
  }, { availableHandles: evidence.map(({ handle }) => handle) })!;
  return { atomIndexVersion: 2, draft, evidence, request, scope: validation.value };
}

function payload(input: KnowledgeSelectorInputV22, status: "covered" | "missing" = "covered") {
  return {
    claims: ["K1", "K2", "K3", "K1"].map((handle, index) => ({
      id: `C${index + 1}`, supportHandles: [handle], verdict: "supported"
    })),
    coverage: input.scope.scope.map(({ id }) => ({
      contributionIds: ["C1", "C2", "C3"], id, status
    })),
    insufficientReason: "not_applicable",
    version: 2
  };
}

function accept(value: unknown, input: KnowledgeSelectorInputV22): KnowledgeGroundedSelectorV22 {
  const validation = validateKnowledgeGroundedSelectorV22(value, input);
  expect(validation.kind).toBe("accepted");
  if (validation.kind !== "accepted") throw new Error(validation.reason);
  return validation.value;
}

describe("contribution publication and Closure", () => {
  it("applies the unchanged sixteen-literal ceiling to the whole contribution union", () => {
    const evidence = [{ handle: "K1", exactExcerpt: Array.from({ length: 17 }, (_, index) => `Sample ${index + 1} was observed.`).join("\n") }];
    const request = "Report the samples.";
    const scope = validateKnowledgeCoverageScopeV6({ version: 6, jointFindings: [], unsupportedDimensions: [],
      evidenceUnits: [{ handle: "K1", findings: [{ description: "Report the samples.", requestAnchor: "samples",
        evidenceAtomIds: ["A1"] }, { description: "Report the remaining samples.", requestAnchor: "samples",
        evidenceAtomIds: ["A2"] }] }]
    }, { atomIndexVersion: 2, evidence, request });
    if (scope.kind !== "accepted") throw new Error("fixture_scope_invalid");
    const draft = decodeKnowledgeAnswerDraftV21({ version: 1,
      claims: [{ citationHints: ["K1"], text: "Sample 1 was observed." }]
    }, { availableHandles: ["K1"] })!;
    const input = { atomIndexVersion: 2 as const, draft, evidence, request, scope: scope.value };
    const literals = knowledgeSelectorLiteralExtractIndexV2(evidence).items.map(({ id }) => id);
    expect(literals).toHaveLength(17);
    const output = { version: 2, insufficientReason: "not_applicable",
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "missing", contributionIds: literals.slice(0, 9) },
        { id: "D2", status: "missing", contributionIds: literals.slice(9) }]
    };
    expect(validateKnowledgeGroundedSelectorV22(output, input)).toEqual({
      kind: "rejected", reason: "selector_literal_count_exceeded"
    });
    expect(validateKnowledgeGroundedSelectorV22({ ...output,
      coverage: [output.coverage[0]!, { ...output.coverage[1]!, contributionIds: literals.slice(9, 16) }]
    }, input).kind).toBe("accepted");
    expect(knowledgeGroundedSelectorPromptV22({ ...input, evidenceManifest: "Immutable evidence",
      selectorPass: "repair", repairReason: "selector_literal_count_exceeded", workflowVersion: 5
    }).systemPrompt).toContain("one whole-answer limit, not a per-dimension allowance");
  });

  it.each([
    ["Plain `identifier` text.", "draft_claim_backtick_invalid"],
    ["The result is _emphasized_.", "draft_claim_emphasis_invalid"],
    ["The <b>result</b> is present.", "draft_claim_html_invalid"],
    ["The [result](https://example.invalid) is present.", "draft_claim_link_invalid"],
    ["- The result is present.", "draft_claim_block_prefix_invalid"],
    ["One assertion.\nAnother assertion.", "draft_claim_control_character"],
    ["A value is supported [K1].", "draft_claim_citation_invalid"],
    ["x".repeat(1001), "draft_claim_too_long"],
    ["The private-identity-1 value is present.", "draft_claim_identity_invalid"],
    [" Trailing or leading whitespace. ", "draft_claim_text_invalid"]
  ])("classifies rejected current claim text without exporting it", (text, reason) => {
    const result = validateKnowledgeAnswerDraftContributionsV1({ claims: [{ text, citationHints: ["K1"] }], version: 1 },
      { availableHandles: ["K1"], forbiddenIdentityFragments: ["private-identity-1"] });
    expect(result).toEqual({ kind: "rejected", reason });
    expect(decodeKnowledgeAnswerDraftMalformed({ kind: "draft_malformed", reason })).toEqual({ kind: "draft_malformed", reason });
    expect(decodeKnowledgeAnswerDraftMalformed({ kind: "draft_malformed", reason: "draft_claim_text_invalid" })).not.toBeNull();
    expect(decodeKnowledgeAnswerDraftMalformed({ kind: "draft_malformed", reason: "draft_claim_markup_invalid" })).not.toBeNull();
  });

  it("publishes three dated contributions after collective Closure reopens their requirement", () => {
    const input = fixture();
    const selector = accept(payload(input), input);
    const closure = { decisions: [{ id: "D1", status: "missing" as const }], version: 3 as const };
    const before = JSON.stringify(selector);
    const reopened = applyKnowledgeCoverageScopeClosureV3({ ...input, closure, selector });
    const settled = settleKnowledgeAnswerV22({ ...input, selector: reopened });
    expect(reopened.coverage[0]?.contributionIds).toEqual(["C1", "C2", "C3"]);
    expect(settled).toMatchObject({
      finalizationMode: "selected_claims", outcome: "answered", requestCoverage: "partial",
      supportedClaimCount: 3
    });
    for (const value of ["42", "35", "38", "2040-01-01", "2040-02-01", "2040-03-01", "[K1]", "[K2]", "[K3]", "trend"]) {
      expect(settled.finalText).toContain(value);
    }
    expect(settled.finalText).not.toContain("cabinet");
    expect(JSON.stringify(selector)).toBe(before);
    expect(applyKnowledgeCoverageScopeClosureV3({ ...input, closure, selector: reopened })).toEqual(reopened);
    const recovered = JSON.parse(JSON.stringify(reopened));
    expect(settleKnowledgeAnswerV22({ ...input, selector: recovered })).toEqual(settled);
  });

  it("accepts a useful partial contribution without pretending collective completeness", () => {
    const input = fixture();
    const selector = accept({ ...payload(input, "missing"), coverage: [{
      contributionIds: ["C1"], id: "D1", status: "missing"
    }] }, input);
    expect(settleKnowledgeAnswerV22({ ...input, selector })).toMatchObject({
      outcome: "answered", requestCoverage: "partial", supportedClaimCount: 1
    });
    const closureInput = JSON.parse(knowledgeCoverageScopeClosurePromptV3({
      ...input, closurePass: "initial", selector
    }).userPrompt);
    expect(closureInput.contributions.map((entry: { id: string }) => entry.id)).toEqual(["C1"]);
    expect(validateKnowledgeCoverageScopeClosureV3({
      decisions: [{ id: "D1", status: "closed" }], version: 3
    }, { ...input, selector }).kind).toBe("rejected");
  });

  it("does not infer mapping from supported claims sharing the same source", () => {
    const input = fixture();
    const selector = accept({ ...payload(input, "missing"), coverage: [{
      contributionIds: [], id: "D1", status: "missing"
    }], insufficientReason: "not_found" }, input);
    expect(settleKnowledgeAnswerV22({ ...input, selector })).toMatchObject({
      finalizationMode: "insufficient", outcome: "insufficient_evidence",
      requestCoverage: "none", supportedClaimCount: 0
    });
  });

  it("normalizes duplicate IDs idempotently while preserving the accepted state", () => {
    const input = fixture();
    const selector = accept({ ...payload(input, "missing"), coverage: [{
      contributionIds: ["C2", "C1", "C2"], id: "D1", status: "missing"
    }] }, input);
    expect(selector.coverage[0]?.contributionIds).toEqual(["C2", "C1"]);
    expect(accept(knowledgeSelectorPayloadV22(selector), input)).toEqual(selector);
    expect(buildKnowledgePublicationPlanV1({ ...input, selector }).entries.map(({ id }) => id))
      .toEqual(["C1", "C2"]);
  });

  it.each([
    [{ contributionIds: [], id: "D1", status: "covered" }, "selector_covered_contributions_empty"],
    [{ contributionIds: ["C1"], id: "D1", status: "excluded" }, "selector_excluded_contributions_nonempty"],
    [{ contributionIds: ["C99"], id: "D1", status: "missing" }, "selector_unknown_contribution_id"],
    [{ contributionIds: ["L9999"], id: "D1", status: "missing" }, "selector_unknown_literal_id"],
    [{ contributionIds: ["L0"], id: "D1", status: "missing" }, "selector_literal_id_invalid"],
    [{ contributionIds: ["L10000"], id: "D1", status: "missing" }, "selector_literal_id_invalid"],
    [{ contributionIds: ["C1"], id: "D9", status: "covered" }, "selector_dimension_id_invalid"],
    [{ contributionIds: [42], id: "D1", status: "covered" }, "selector_contribution_shape_invalid"]
  ])("classifies invalid publication edges without retaining their payload: %j", (dimension, reason) => {
    const input = fixture();
    const validation = validateKnowledgeGroundedSelectorV22({ ...payload(input), coverage: [dimension] }, input);
    expect(validation).toEqual({ kind: "rejected", reason });
    if (validation.kind !== "rejected") throw new Error("fixture_invalid");
    const failure = knowledgeContributionOperationFailureV1("invalid_output", validation.reason);
    expect(decodeKnowledgeContributionOperationFailureV1(JSON.parse(JSON.stringify(failure)))).toEqual({
      kind: "contribution_operation_failed", reason: "invalid_output", validationReason: reason, version: 1
    });
  });

  it.each(["unsupported", "contradicted"])("rejects an edge to a %s claim", (verdict) => {
    const input = fixture();
    const raw = payload(input);
    raw.claims[0] = { ...raw.claims[0]!, supportHandles: [], verdict };
    expect(validateKnowledgeGroundedSelectorV22(raw, input)).toEqual({
      kind: "rejected", reason: "selector_contribution_not_supported"
    });
  });

  it("distinguishes exclusion of an unsupported requested facet from an invalid D ID", () => {
    const input = fixture();
    const scope = validateKnowledgeCoverageScopeV6({ version: 6,
      evidenceUnits: input.evidence.map(({ handle }) => ({ handle, findings: [] })), jointFindings: [],
      unsupportedDimensions: [{ description: "Explain the trend.", requestAnchor: "trend" }]
    }, { ...input, atomIndexVersion: 2 });
    if (scope.kind !== "accepted") throw new Error("fixture_scope_invalid");
    const current = { ...input, scope: scope.value };
    const prompt = knowledgeGroundedSelectorPromptV22({ ...current, evidenceManifest: "Immutable evidence",
      selectorPass: "initial", workflowVersion: 5 });
    expect(JSON.parse(prompt.userPrompt).contributionSourceIndex.dimensions)
      .toEqual([{ id: "D1", literalIds: [], supportHandles: [] }]);
    expect(validateKnowledgeGroundedSelectorV22({ ...payload(current), insufficientReason: "not_found",
      coverage: [{ id: "D1", status: "excluded", contributionIds: [] }]
    }, current)).toEqual({ kind: "rejected", reason: "selector_excluded_required_dimension" });
  });

  it("uses contribution edges as the only literal-selection authority", () => {
    const input = fixture();
    const literal = knowledgeSelectorLiteralExtractIndexV2(input.evidence).items[0]!;
    const raw = payload(input, "missing");
    raw.coverage[0]!.contributionIds = [literal.id];
    const selector = accept(raw, input);
    expect(settleKnowledgeAnswerV22({ ...input, selector })).toMatchObject({
      finalizationMode: "evidence_only", requestCoverage: "partial", supportedClaimCount: 0
    });
    expect(validateKnowledgeGroundedSelectorV22({ ...raw, extractIds: [literal.id] }, input).kind)
      .toBe("rejected");
    raw.coverage[0]!.contributionIds.push("C1");
    expect(settleKnowledgeAnswerV22({ ...input, selector: accept(raw, input) })).toMatchObject({
      finalizationMode: "selected_claims_with_evidence", supportedClaimCount: 1
    });
  });

  it("detects corrupted contribution provenance and decorated Scope on reconstruction", () => {
    const input = fixture();
    const selector = accept(payload(input), input);
    const corrupted = { ...selector, coverage: selector.coverage.map((dimension) => ({
      ...dimension, evidenceHandles: ["K9"]
    })) };
    expect(validateAcceptedKnowledgeSelectorV22(corrupted, input)).toBe(false);
    expect(() => settleKnowledgeAnswerV22({ ...input, selector: corrupted }))
      .toThrow("knowledge_publication_state_invalid");
  });

  it("keeps identical text separately attributed and detects renderer loss before complete", () => {
    const input = fixture();
    const first = "The same requirement applies.";
    const draft = decodeKnowledgeAnswerDraftV21({
      claims: [{ citationHints: ["K1"], text: first }, { citationHints: ["K2"], text: "Another fact." }], version: 1
    }, { availableHandles: ["K1", "K2"] })!;
    if (!("claims" in draft)) throw new Error("fixture_draft_invalid");
    const duplicateDraft = { ...draft, claims: draft.claims.map((claim) => ({ ...claim, text: first })) };
    const evidence = [{ handle: "K1", exactExcerpt: first }, { handle: "K2", exactExcerpt: first }];
    const request = "State Alpha and Beta separately.";
    const scope = validateKnowledgeCoverageScopeV6({
      evidenceUnits: evidence.map(({ handle }, index) => ({
        findings: [{ description: `State the ${index ? "Beta" : "Alpha"} requirement.`,
          evidenceAtomIds: [`A${index + 1}`], requestAnchor: index ? "Beta" : "Alpha" }], handle
      })), jointFindings: [], unsupportedDimensions: [], version: 6
    }, { atomIndexVersion: 2, evidence, request });
    if (scope.kind !== "accepted") throw new Error("fixture_scope_invalid");
    const current = { ...input, draft: duplicateDraft, evidence, request, scope: scope.value };
    const promptInput = { ...current, evidenceManifest: "Immutable evidence", selectorPass: "initial" as const };
    const sourceIndex = JSON.parse(knowledgeGroundedSelectorPromptV22({ ...promptInput, workflowVersion: 5 }).userPrompt)
      .contributionSourceIndex;
    expect(sourceIndex).toEqual({ version: 1, maximumDistinctLiterals: 16, maximumLiteralCodePoints: 2048,
      maximumTotalLiteralCodePoints: 16384, dimensions: [
        { id: "D1", literalIds: ["L1"], supportHandles: ["K1"] },
        { id: "D2", literalIds: ["L2"], supportHandles: ["K2"] }
      ] });
    for (const workflowVersion of [undefined, 2, 3, 4] as const) {
      expect(JSON.parse(knowledgeGroundedSelectorPromptV22({ ...promptInput, workflowVersion }).userPrompt))
        .not.toHaveProperty("contributionSourceIndex");
    }
    const selector = accept({
      claims: evidence.map(({ handle }, index) => ({ id: `C${index + 1}`, supportHandles: [handle], verdict: "supported" })),
      coverage: scope.value.scope.map(({ id }, index) => ({ contributionIds: [`C${index + 1}`], id, status: "covered" })),
      insufficientReason: "not_applicable", version: 2
    }, current);
    const plan = buildKnowledgePublicationPlanV1({ ...current, selector });
    const invalid = knowledgeSelectorPayloadV22(selector) as { coverage: { contributionIds: string[] }[] };
    invalid.coverage[1]!.contributionIds = ["C1"];
    expect(validateKnowledgeGroundedSelectorV22(invalid, current)).toEqual({
      kind: "rejected", reason: "selector_contribution_provenance_invalid"
    });
    const settled = settleKnowledgeAnswerV22({ ...current, selector });
    expect(settled.finalText).toContain(`Alpha: ${first} [K1]`);
    expect(settled.finalText).toContain(`Beta: ${first} [K2]`);
    expect(settled).toMatchObject({ requestCoverage: "complete", supportedClaimCount: 2 });
    expect(() => renderKnowledgePublicationPlanV1({
      ...current, selector, plan: { ...plan, entries: plan.entries.slice(0, 1) }
    })).toThrow("knowledge_publication_plan_invalid");
    expect(() => renderKnowledgePublicationPlanV1({
      ...current, selector, plan: { ...plan, entries: plan.entries.map((entry) => ({ ...entry, handles: ["K1"] })) }
    })).toThrow("knowledge_publication_plan_invalid");
  });

  it("exposes partial-contribution authority in the new prompt without a second literal selection", () => {
    const input = fixture();
    const prompt = knowledgeGroundedSelectorPromptV22({ ...input, evidenceManifest: "immutable manifest", selectorPass: "initial" });
    expect(prompt.systemPrompt).toContain("missing may retain a nonempty useful contribution set");
    expect(prompt.systemPrompt).not.toContain("missing has none");
    expect(JSON.parse(prompt.userPrompt).scopeEvidenceAtomIndex.items).toHaveLength(3);
  });

  it("publishes a shared claim once with every independently requested binding", () => {
    const evidence = [{ handle: "K1", exactExcerpt: "Both Alpha and Beta have the same value." }];
    const request = "State Alpha and Beta separately.";
    const scope = validateKnowledgeCoverageScopeV6({
      evidenceUnits: [{ handle: "K1", findings: ["Alpha", "Beta"].map((name) => ({
        description: `State ${name}'s value.`, evidenceAtomIds: ["A1"], requestAnchor: name
      })) }], jointFindings: [], unsupportedDimensions: [], version: 6
    }, { atomIndexVersion: 2, evidence, request });
    const draft = validateKnowledgeAnswerDraftContributionsV1({
      claims: [{ citationHints: ["K1"], text: evidence[0]!.exactExcerpt }], version: 1
    }, { availableHandles: ["K1"] });
    if (scope.kind !== "accepted" || draft.kind !== "accepted") throw new Error("fixture_invalid");
    const input = { atomIndexVersion: 2 as const, draft: draft.value, evidence, request, scope: scope.value };
    const selector = accept({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: scope.value.scope.map(({ id }) => ({ contributionIds: ["C1"], id, status: "covered" })),
      insufficientReason: "not_applicable", version: 2
    }, input);
    const settlement = settleKnowledgeAnswerV22({ ...input, selector });
    expect(settlement).toMatchObject({ supportedClaimCount: 1, requestCoverage: "complete" });
    expect(settlement.finalText).toBe(`- Alpha; Beta: ${evidence[0]!.exactExcerpt} [K1]`);
  });

  it("admits equal primary text only with distinct provenance while retaining claim validation", () => {
    const first = { citationHints: ["K1"], text: "The approved value is 19." };
    const input = { availableHandles: ["K1", "K2"], forbiddenIdentityFragments: ["private-identity"] };
    const validate = (claims: unknown[]) => validateKnowledgeAnswerDraftContributionsV1({ claims, version: 1 }, input);
    expect(validate([first, { ...first, citationHints: ["K2"] }]).kind).toBe("accepted");
    expect(validate([first, first])).toMatchObject({ kind: "rejected", reason: "draft_duplicate_claim" });
    expect(validate([{ ...first, citationHints: ["K9"] }]).kind).toBe("rejected");
    expect(validate([{ ...first, text: "private-identity has value 19." }]).kind).toBe("rejected");
    expect(validate(Array.from({ length: 25 }, () => first)).kind).toBe("rejected");
  });
});
