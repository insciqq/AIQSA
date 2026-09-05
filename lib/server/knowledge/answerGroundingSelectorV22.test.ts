import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import { knowledgeSelectorLiteralExtractIndexV2 } from "./answerGroundingV5";
import { validateKnowledgeCoverageScopeV6 } from "./coverageScopeV6";
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
    { contributionIds: [], id: "D1", status: "covered" },
    { contributionIds: ["C1"], id: "D1", status: "excluded" },
    { contributionIds: ["C99"], id: "D1", status: "missing" },
    { contributionIds: ["L9999"], id: "D1", status: "missing" },
    { contributionIds: ["C1"], id: "D9", status: "covered" }
  ])("rejects invalid publication edges: %j", (dimension) => {
    const input = fixture();
    expect(validateKnowledgeGroundedSelectorV22({ ...payload(input), coverage: [dimension] }, input).kind)
      .toBe("rejected");
  });

  it.each(["unsupported", "contradicted"])("rejects an edge to a %s claim", (verdict) => {
    const input = fixture();
    const raw = payload(input);
    raw.claims[0] = { ...raw.claims[0]!, supportHandles: [], verdict };
    expect(validateKnowledgeGroundedSelectorV22(raw, input).kind).toBe("rejected");
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
    const selector = accept({
      claims: evidence.map(({ handle }, index) => ({ id: `C${index + 1}`, supportHandles: [handle], verdict: "supported" })),
      coverage: scope.value.scope.map(({ id }, index) => ({ contributionIds: [`C${index + 1}`], id, status: "covered" })),
      insufficientReason: "not_applicable", version: 2
    }, current);
    const plan = buildKnowledgePublicationPlanV1({ ...current, selector });
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
