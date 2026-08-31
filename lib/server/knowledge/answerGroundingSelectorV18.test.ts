import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { knowledgeSelectorEvidenceFromManifest } from "./answerGroundingV5";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import {
  deriveKnowledgeCoverageV3,
  knowledgeGroundedSelectorPromptV18,
  validateKnowledgeGroundedSelectorV18
} from "./answerGroundingSelectorV18";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "The construction is finite. It also has an ample line bundle.",
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
    profileId: "fixture:selector-v18",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeSelectorEvidenceFromManifest(manifest);
  const request = "What properties of the construction follow from the result?";
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{
      citationHints: ["K1"],
      text: "The construction is finite."
    }],
    version: 1
  }, { availableHandles: ["K1", "K2"] })!;
  const scope = {
    scope: [{
      description: "State that the construction is finite.",
      evidenceHandles: ["K1"],
      id: "D1",
      requestAnchor: "properties"
    }, {
      description: "State that the construction has an ample line bundle.",
      evidenceHandles: ["K1"],
      id: "D2",
      requestAnchor: "properties"
    }],
    version: 3
  } as const;
  return { draft, evidence, manifest, request, scope };
}

describe("Knowledge Grounded Selector V18", () => {
  it("keeps same-evidence conclusions as separate coverage decisions", () => {
    const { draft, evidence, request, scope } = fixture();
    const validation = validateKnowledgeGroundedSelectorV18({
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
    expect(deriveKnowledgeCoverageV3(validation.value)).toEqual({
      coveredDimensionCount: 1,
      missingInformation: [
        "State that the construction has an ample line bundle."
      ],
      requestCoverage: "partial",
      supportedContentCount: 1
    });
  });

  it("rejects coverage mappings without canonical support-handle overlap", () => {
    const { draft, evidence, request, scope } = fixture();
    const disjointScope = {
      ...scope,
      scope: [scope.scope[0], {
        ...scope.scope[1],
        evidenceHandles: ["K2"]
      }]
    } as const;
    expect(validateKnowledgeGroundedSelectorV18({
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
      reason: "selector_dimension_invalid"
    });
  });

  it("pins the immutable scope into initial and final prompts", () => {
    const { draft, evidence, manifest, request, scope } = fixture();
    for (const selectorPass of ["initial", "final"] as const) {
      const prompt = knowledgeGroundedSelectorPromptV18({
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
