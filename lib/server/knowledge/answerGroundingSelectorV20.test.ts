import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import {
  deriveKnowledgeCoverageV5,
  knowledgeGroundedSelectorPromptV20,
  validateKnowledgeGroundedSelectorV20
} from "./answerGroundingSelectorV20";
import {
  knowledgeCoverageEvidenceFromManifestV5,
  validateKnowledgeCoverageScopeV5
} from "./coverageScopeV5";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "The Atlas controller enforces a bounded queue. It preserves input ordering.",
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
    }, {
      ambiguity: "none",
      evidenceId: "provider-call:result:2",
      exactExcerpt: "A separate source discusses an optional illustration.",
      fileName: "illustration.md",
      handle: "K2",
      locator: "section=Illustration",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S2",
      sourceLabel: "Illustration",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:selector-v20",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV5(manifest);
  const request = "What guarantees of the Atlas controller follow from the result?";
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{
      citationHints: ["K1"],
      text: "The Atlas controller enforces a bounded queue."
    }],
    version: 1
  }, { availableHandles: ["K1", "K2"] })!;
  const scopeValidation = validateKnowledgeCoverageScopeV5({
    evidenceMap: [{ answerAtomIds: ["A1", "A2"], handle: "K1" }, {
      answerAtomIds: [],
      handle: "K2"
    }],
    scope: [{
      description: "State that the Atlas controller enforces a bounded queue.",
      evidenceAtomIds: ["A1"],
      id: "D1",
      requestAnchor: "guarantees"
    }, {
      description: "State that the Atlas controller preserves input ordering.",
      evidenceAtomIds: ["A2"],
      id: "D2",
      requestAnchor: "guarantees"
    }],
    version: 5
  }, { evidence, request });
  if (scopeValidation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  return { draft, evidence, manifest, request, scope: scopeValidation.value };
}

describe("Knowledge Grounded Selector V20", () => {
  it("retains sparse-unit atom provenance in separate coverage decisions", () => {
    const { draft, evidence, request, scope } = fixture();
    const validation = validateKnowledgeGroundedSelectorV20({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { draft, evidence, request, scope });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    expect(validation.value.coverage.map(({ evidenceAtomIds }) => evidenceAtomIds))
      .toEqual([["A1"], ["A2"]]);
    expect(deriveKnowledgeCoverageV5(validation.value)).toEqual({
      coveredDimensionCount: 1,
      missingInformation: ["State that the Atlas controller preserves input ordering."],
      requestCoverage: "partial",
      supportedContentCount: 1
    });
  });

  it("pins the immutable V5 scope into initial and final prompts", () => {
    const { draft, evidence, manifest, request, scope } = fixture();
    for (const selectorPass of ["initial", "final"] as const) {
      const prompt = knowledgeGroundedSelectorPromptV20({
        draft,
        evidence,
        evidenceManifest: manifest.message,
        request,
        scope,
        selectorPass
      });
      const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
      expect(payload.coverageScope).toEqual(scope);
      expect(payload.selectorPass).toBe(selectorPass);
    }
  });
});
