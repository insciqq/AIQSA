import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import {
  knowledgeAnswerTargetedSupplementPromptV1,
  knowledgeGroundedDeltaSelectorPromptV1
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
  it("makes exact D targets explicit without treating them as evidence", () => {
    const { draft, manifest, request, selector } = fixture();
    const prompt = knowledgeAnswerTargetedSupplementPromptV1({
      auditDimensions: [selector.coverage[1]!],
      evidenceManifest: manifest.message,
      primaryDraft: draft,
      request,
      routeInstruction: "Answer from supplied Knowledge evidence only."
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(payload).toMatchObject({
      targetingMode: "exact_missing_dimension"
    });
    expect(prompt.systemPrompt).toContain("targetDimensionId");
    expect(prompt.systemPrompt).toContain("never evidence");
    expect(prompt.systemPrompt).toContain("advisory routing metadata, not proof");
    expect(prompt.systemPrompt).toContain("final delta Selector independently chooses");
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
