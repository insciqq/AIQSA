import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import {
  knowledgeAnswerTargetedSupplementPromptV1,
  knowledgeAnswerTargetedSupplementPromptV2,
  knowledgeAnswerTargetedSupplementPromptV3,
  knowledgeGroundedDeltaSelectorPromptV1,
  knowledgeGroundedDeltaSelectorPromptV2,
  knowledgeGroundedDeltaSelectorPromptV3,
  knowledgeGroundedDeltaSelectorPromptV4,
  knowledgeGroundedSelectorPromptV21TargetClosureV1
} from "./answerGroundingCorrectionPromptV21";
import {
  knowledgeCoverageEvidenceFromManifestV6,
  validateKnowledgeCoverageScopeV6
} from "./coverageScopeV6";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { validateKnowledgeGroundedSelectorV21 } from "./answerGroundingSelectorV21";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "Alpha is bounded. Beta preserves order.",
      fileName: "result.md",
      handle: "K1",
      locator: "section=Result",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Result",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to supplied evidence.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:targeted-correction",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Explain alpha and beta.";
  const scopeValidation = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{
      findings: [{
        description: "Explain alpha.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "alpha"
      }, {
        description: "Explain beta.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "beta"
      }],
      handle: "K1"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  }, { evidence, request });
  if (scopeValidation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{ citationHints: ["K1"], text: "Alpha is bounded." }],
    version: 1
  }, { availableHandles: ["K1"] })!;
  const correctedDraft = decodeKnowledgeAnswerDraftV21({
    claims: [{ citationHints: ["K1"], text: "Alpha is bounded." }, {
      citationHints: ["K1"],
      text: "Beta preserves order."
    }],
    version: 1
  }, { availableHandles: ["K1"] })!;
  const selectorValidation = validateKnowledgeGroundedSelectorV21({
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
      id: "D2",
      status: "missing",
      supportIds: []
    }],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  }, { draft, evidence, request, scope: scopeValidation.value });
  if (selectorValidation.kind !== "accepted") throw new Error("fixture_selector_invalid");
  return {
    correctedDraft,
    draft,
    evidence,
    manifest,
    request,
    scope: scopeValidation.value,
    selector: selectorValidation.value
  };
}

describe("targeted correction prompts", () => {
  it("makes the exact target atom slice the only factual context", () => {
    const { evidence, request, selector } = fixture();
    const prompt = knowledgeAnswerTargetedSupplementPromptV1({
      auditDimensions: [selector.coverage[1]!],
      evidence,
      request,
      routeInstruction: "Answer from supplied Knowledge evidence only."
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "draftPass",
      "request",
      "targetEvidenceAtomIndex",
      "targetTasks",
      "targetingMode",
      "taskReminder",
      "version"
    ]);
    expect(payload).toMatchObject({
      targetEvidenceAtomIndex: {
        atoms: [{
          handle: "K1",
          id: "A2",
          text: "Beta preserves order."
        }],
        targets: [{
          evidenceAtomIds: ["A2"],
          targetDimensionId: "D2"
        }],
        version: 1
      },
      targetTasks: [{
        description: "Explain beta.",
        id: "D2",
        requestAnchor: "beta"
      }],
      targetingMode: "exact_missing_dimension"
    });
    expect(payload).not.toHaveProperty("evidenceManifest");
    expect(payload).not.toHaveProperty("primaryDraft");
    expect(payload).not.toHaveProperty("primaryClaimIndex");
    expect(prompt.systemPrompt).toContain("targetDimensionId");
    expect(prompt.systemPrompt).toContain("sole factual evidence");
    expect(prompt.systemPrompt).toContain("full manifest, unrelated evidence handles");
    expect(prompt.systemPrompt).toContain("model does not choose provenance");
    expect(prompt.systemPrompt).toContain("final delta Selector independently chooses");
    expect(prompt.systemPrompt).toContain("deterministic complete projection");
  });

  it("pins every target to an explicit grouped claim capacity", () => {
    const { draft, evidence, request, selector } = fixture();
    const prompt = knowledgeAnswerTargetedSupplementPromptV2({
      auditDimensions: [selector.coverage[1]!],
      evidence,
      primaryClaimCount: draft.claims.length,
      request,
      routeInstruction: "Answer from supplied Knowledge evidence only."
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(payload).toMatchObject({
      targetClaimLimits: [{ maxClaims: 12, targetDimensionId: "D2" }],
      targetingMode: "exact_missing_dimension_groups",
      version: 2
    });
    expect(prompt.systemPrompt).toContain("required key of targets");
    expect(prompt.systemPrompt).toContain("Never spend another target's capacity");
  });

  it("closes each target over ordered evidence without promoting provisional branches", () => {
    const { draft, evidence, request, selector } = fixture();
    const historical = knowledgeAnswerTargetedSupplementPromptV2({
      auditDimensions: [selector.coverage[1]!],
      evidence,
      primaryClaimCount: draft.claims.length,
      request,
      routeInstruction: "Answer from supplied Knowledge evidence only."
    });
    const current = knowledgeAnswerTargetedSupplementPromptV3({
      auditDimensions: [selector.coverage[1]!],
      evidence,
      primaryClaimCount: draft.claims.length,
      request,
      routeInstruction: "Answer from supplied Knowledge evidence only."
    });
    expect(historical.systemPrompt).not.toContain("provisional branch");
    expect(current.systemPrompt).toContain('contract version="3"');
    expect(current.systemPrompt).toContain("ordered union of targets[D]");
    expect(current.systemPrompt).toContain("later same-unit qualifications");
    expect(current.systemPrompt).toContain("without their requested outcomes");
    expect(JSON.parse(current.userPrompt)).toMatchObject({
      targetClosureProtocol: {
        coverageRequirement: "complete_target_entailment",
        evidenceOrder: "target_evidence_atom_ids",
        sameUnitConclusionResolution: "final_qualification_or_exclusion_controls",
        version: 1
      },
      version: 3
    });
  });

  it("fails closed rather than projecting incomplete target evidence", () => {
    const { request, selector } = fixture();
    expect(() => knowledgeAnswerTargetedSupplementPromptV1({
      auditDimensions: [selector.coverage[1]!],
      evidence: [],
      request,
      routeInstruction: "Answer from supplied Knowledge evidence only."
    })).toThrow("knowledge_targeted_supplement_prompt_invalid");
  });

  it("pins immutable base state and claim-to-dimension bindings into final delta", () => {
    const { correctedDraft, evidence, manifest, request, scope, selector } = fixture();
    const prompt = knowledgeGroundedDeltaSelectorPromptV1({
      bindings: [{ claimId: "C2", targetDimensionId: "D2" }],
      draft: correctedDraft,
      evidence,
      evidenceManifest: manifest.message,
      initialSelector: selector,
      request,
      scope
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(payload).toMatchObject({
      baseSelector: selector,
      correctionTargets: [{ claimId: "C2", targetDimensionId: "D2" }],
      selectorPass: "final_delta"
    });
    expect(prompt.systemPrompt).toContain("baseSelector is immutable");
  });

  it("keeps historical single-claim delta semantics and makes support sets collective now", () => {
    const { correctedDraft, evidence, manifest, request, scope, selector } = fixture();
    const input = {
      bindings: [{ claimId: "C2", targetDimensionId: "D2" }],
      draft: correctedDraft,
      evidence,
      evidenceManifest: manifest.message,
      initialSelector: selector,
      request,
      scope
    } as const;
    const historical = knowledgeGroundedDeltaSelectorPromptV1(input);
    const current = knowledgeGroundedDeltaSelectorPromptV2(input);
    expect(historical.systemPrompt).toContain(
      "A targeted claim still needs semantic entailment and must answer the complete"
    );
    expect(historical.systemPrompt).not.toContain("collective support set");
    expect(current.systemPrompt).toContain("contract version=\"2\"");
    expect(current.systemPrompt).toContain("collective support set");
    expect(current.systemPrompt).toContain("their union must semantically answer");
    expect(current.systemPrompt).toContain("Every mapped claim must be independently entailed");
    expect(JSON.parse(current.userPrompt)).toMatchObject({
      correctionTargets: [{ claimId: "C2", targetDimensionId: "D2" }],
      selectorPass: "final_delta"
    });
  });

  it("resolves complete ordered evidence in both initial and correction verification", () => {
    const { correctedDraft, draft, evidence, manifest, request, scope, selector } = fixture();
    const initial = knowledgeGroundedSelectorPromptV21TargetClosureV1({
      draft,
      evidence,
      evidenceManifest: manifest.message,
      request,
      scope,
      selectorPass: "initial"
    });
    const final = knowledgeGroundedDeltaSelectorPromptV3({
      bindings: [{ claimId: "C2", targetDimensionId: "D2" }],
      draft: correctedDraft,
      evidence,
      evidenceManifest: manifest.message,
      initialSelector: selector,
      request,
      scope
    });
    expect(initial.systemPrompt).toContain("complete atom sequence");
    expect(initial.systemPrompt).toContain("later rules out is contradicted");
    expect(JSON.parse(initial.userPrompt)).toHaveProperty("targetClosureProtocol.version", 1);
    expect(final.systemPrompt).toContain('delta_selector_contract version="3"');
    expect(final.systemPrompt).toContain("list of candidate cases without each requested final outcome");
    expect(final.systemPrompt).toContain("complete ordered target evidence");
    expect(JSON.parse(final.userPrompt)).toMatchObject({
      correctionTargets: [{ claimId: "C2", targetDimensionId: "D2" }],
      selectorPass: "final_delta",
      targetClosureProtocol: { version: 1 }
    });
  });

  it("physically limits the current final verifier to target statements and atoms", () => {
    const { correctedDraft, evidence, request, scope, selector } = fixture();
    const final = knowledgeGroundedDeltaSelectorPromptV4({
      bindings: [{ claimId: "C2", targetDimensionId: "D2" }],
      draft: correctedDraft,
      evidence,
      initialSelector: selector,
      request,
      scope
    });
    const payload = JSON.parse(final.userPrompt) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "baseSelector",
      "correctionTargets",
      "request",
      "selectorPass",
      "supplementalClaims",
      "targetEvidenceAtomIndex",
      "targetTasks",
      "targetVerificationProtocol",
      "taskReminder",
      "version"
    ]);
    expect(payload).toMatchObject({
      correctionTargets: [{ claimId: "C2", targetDimensionId: "D2" }],
      selectorPass: "final_delta_least_authority",
      supplementalClaims: [{ id: "C2", text: "Beta preserves order." }],
      targetEvidenceAtomIndex: {
        atoms: [{ handle: "K1", id: "A2", text: "Beta preserves order." }],
        targets: [{ evidenceAtomIds: ["A2"], targetDimensionId: "D2" }],
        version: 1
      },
      targetVerificationProtocol: {
        evidenceAuthority: "target_atoms_only",
        targetAuthority: "eligible_or_veto_false_positive",
        version: 1
      },
      version: 4
    });
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("evidenceManifest");
    expect(payload).not.toHaveProperty("literalExtractIndex");
    expect(payload).not.toHaveProperty("scopeEvidenceAtomIndex");
    expect(final.userPrompt).not.toContain("Alpha is bounded.");
    expect(final.systemPrompt).toContain("sole factual evidence");
    expect(final.systemPrompt).toContain("recipient or beneficiary");
    expect(final.systemPrompt).toContain("swapped actor or recipient");
    expect(final.systemPrompt).toContain("may become excluded only");

    const repair = knowledgeGroundedDeltaSelectorPromptV4({
      bindings: [{ claimId: "C2", targetDimensionId: "D2" }],
      draft: correctedDraft,
      evidence,
      initialSelector: selector,
      repairReason: "selector_coverage_invalid",
      request,
      scope
    });
    expect(JSON.parse(repair.userPrompt)).toMatchObject({
      repairReason: "selector_coverage_invalid",
      selectorPass: "final_delta_least_authority_repair",
      version: 4
    });
    expect(repair.systemPrompt).toContain(
      'grounded_delta_selector_repair_contract version="1"'
    );
    expect(repair.systemPrompt).toContain("prior rejected payload is absent");
    expect(repair.userPrompt).not.toContain("Generated JSON");
  });

  it("rejects an incomplete or cross-target delta prompt before dispatch", () => {
    const { correctedDraft, evidence, manifest, request, scope, selector } = fixture();
    expect(() => knowledgeGroundedDeltaSelectorPromptV1({
      bindings: [{ claimId: "C2", targetDimensionId: "D1" }],
      draft: correctedDraft,
      evidence,
      evidenceManifest: manifest.message,
      initialSelector: selector,
      request,
      scope
    })).toThrow("knowledge_grounded_delta_selector_prompt_invalid");
  });
});
