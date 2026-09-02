import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import {
  deriveKnowledgeCoverageV4,
  knowledgeGroundedSelectorPromptV19,
  validateKnowledgeGroundedSelectorV19
} from "./answerGroundingSelectorV19";
import {
  knowledgeCoverageEvidenceFromManifestV4,
  validateKnowledgeCoverageScopeV4
} from "./coverageScopeV4";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "The Atlas pipeline enforces a bounded queue. It preserves input ordering.",
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
      exactExcerpt: "A separate source discusses an optional example.",
      fileName: "example.md",
      handle: "K2",
      locator: "section=Example",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S2",
      sourceLabel: "Example",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:selector-v19",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV4(manifest);
  const request = "What guarantees of the Atlas pipeline follow from the result?";
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{
      citationHints: ["K1"],
      text: "The Atlas pipeline enforces a bounded queue."
    }],
    version: 1
  }, { availableHandles: ["K1", "K2"] })!;
  const scopeValidation = validateKnowledgeCoverageScopeV4({
    evidenceReview: [{
      answerAtomIds: ["A1", "A2"],
      handle: "K1",
      otherAtomIds: []
    }, {
      answerAtomIds: [],
      handle: "K2",
      otherAtomIds: ["A3"]
    }],
    scope: [{
      description: "State that the Atlas pipeline enforces a bounded queue.",
      evidenceAtomIds: ["A1"],
      id: "D1",
      requestAnchor: "guarantees"
    }, {
      description: "State that the Atlas pipeline preserves input ordering.",
      evidenceAtomIds: ["A2"],
      id: "D2",
      requestAnchor: "guarantees"
    }],
    version: 4
  }, { evidence, request });
  if (scopeValidation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  return { draft, evidence, manifest, request, scope: scopeValidation.value };
}

describe("Knowledge Grounded Selector V19", () => {
  it("retains immutable atom provenance in separate coverage decisions", () => {
    const { draft, evidence, request, scope } = fixture();
    const validation = validateKnowledgeGroundedSelectorV19({
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
    expect(deriveKnowledgeCoverageV4(validation.value)).toEqual({
      coveredDimensionCount: 1,
      missingInformation: ["State that the Atlas pipeline preserves input ordering."],
      requestCoverage: "partial",
      supportedContentCount: 1
    });
  });

  it("rejects a coverage mapping without canonical handle overlap", () => {
    const { draft, evidence, request, scope } = fixture();
    const disjointScope = {
      ...scope,
      scope: [scope.scope[0], {
        ...scope.scope[1],
        evidenceHandles: ["K2"]
      }]
    } as const;
    expect(validateKnowledgeGroundedSelectorV19({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "covered",
        supportIds: ["C1"]
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { draft, evidence, request, scope: disjointScope })).toMatchObject({
      kind: "rejected",
      reason: "selector_malformed"
    });
  });

  it("pins the immutable atom-derived scope into initial and final prompts", () => {
    const { draft, evidence, manifest, request, scope } = fixture();
    for (const selectorPass of ["initial", "final"] as const) {
      const prompt = knowledgeGroundedSelectorPromptV19({
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
