import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeAnswerDraftV21,
  settleKnowledgeAnswerV21FromFinalSelector
} from "./answerGroundingV21";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21,
  decodeKnowledgeGroundedSelectorSupportEdgesV1,
  deriveKnowledgeCoverageV6,
  knowledgeGroundedSelectorPromptV21,
  normalizeKnowledgeGroundedSelectorSupportEdgesV1,
  normalizeKnowledgeGroundedSelectorSupportEdgesV2,
  validateKnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import { knowledgeGroundedSelectorPromptV21TargetClosureV1 } from
  "./answerGroundingCorrectionPromptV21";
import {
  decodeKnowledgeGroundedSelectorDiagnosticFailureV1,
  diagnoseKnowledgeGroundedSelectorDimensionV1,
  knowledgeGroundedSelectorDiagnosticFailureV1,
  knowledgeGroundedSelectorPromptV21RepairDiagnosticV1
} from "./answerGroundingSelectorRepairDiagnosticV1";
import {
  knowledgeCoverageEvidenceFromManifestV6,
  validateKnowledgeCoverageScopeV6
} from "./coverageScopeV6";
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
    profileId: "fixture:selector-v21",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "What guarantees of the Atlas controller follow from the result?";
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{
      citationHints: ["K1"],
      text: "The Atlas controller enforces a bounded queue."
    }],
    version: 1
  }, { availableHandles: ["K1", "K2"] })!;
  const scopeValidation = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{
      findings: [{
        description: "State that the Atlas controller enforces a bounded queue.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "guarantees"
      }, {
        description: "State that the Atlas controller preserves input ordering.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "guarantees"
      }],
      handle: "K1"
    }, { findings: [], handle: "K2" }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  }, { evidence, request });
  if (scopeValidation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  return { draft, evidence, manifest, request, scope: scopeValidation.value };
}

describe("Knowledge Grounded Selector V21", () => {
  it("keeps the initial prompt exact and gives dimension repair a content-free path", () => {
    const { draft, evidence, manifest, request, scope } = fixture();
    const baseInput = {
      draft,
      evidence,
      evidenceManifest: manifest.message,
      request,
      scope,
      selectorPass: "initial" as const
    };
    expect(knowledgeGroundedSelectorPromptV21RepairDiagnosticV1(baseInput)).toEqual(
      knowledgeGroundedSelectorPromptV21TargetClosureV1(baseInput)
    );

    const invalid = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: [] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    const diagnostic = diagnoseKnowledgeGroundedSelectorDimensionV1(invalid, {
      draft,
      evidence,
      request,
      scope
    });
    expect(diagnostic).toMatchObject({
      code: "coverage_support_empty",
      expectedHandles: ["K1"],
      expectedId: "D1",
      path: "/coverage/0/supportIds"
    });
    const failure = knowledgeGroundedSelectorDiagnosticFailureV1(diagnostic);
    expect(decodeKnowledgeGroundedSelectorDiagnosticFailureV1(failure)).toEqual(failure);
    const repair = knowledgeGroundedSelectorPromptV21RepairDiagnosticV1({
      ...baseInput,
      repairDiagnostic: diagnostic,
      repairReason: "selector_dimension_invalid",
      selectorPass: "repair"
    });
    expect(JSON.parse(repair.userPrompt)).toMatchObject({ repairDiagnostic: diagnostic });
    expect(repair.userPrompt).not.toContain(JSON.stringify(invalid));
  });

  it("diagnoses an all-foreign covered support set without copying its IDs", () => {
    const { evidence, request, scope } = fixture();
    const draft = decodeKnowledgeAnswerDraftV21({
      claims: [{
        citationHints: ["K1"],
        text: "The Atlas controller enforces a bounded queue."
      }, {
        citationHints: ["K2"],
        text: "A separate source discusses an optional illustration."
      }],
      version: 1
    }, { availableHandles: ["K1", "K2"] })!;
    const invalid = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
        id: "C2",
        supportHandles: ["K2"],
        verdict: "supported"
      }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C2"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    const diagnostic = diagnoseKnowledgeGroundedSelectorDimensionV1(invalid, {
      draft,
      evidence,
      request,
      scope
    });
    expect(diagnostic).toMatchObject({
      code: "coverage_support_provenance",
      expectedHandles: ["K1"],
      expectedId: "D1",
      path: "/coverage/0/supportIds"
    });
    expect(JSON.stringify(diagnostic)).not.toContain("C2");
  });

  it("exposes covered, excluded, and missing as strict output branches", () => {
    expect(KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V21.properties.coverage.items.oneOf
      .map(({ properties }) => properties.status.const)).toEqual([
        "covered",
        "excluded",
        "missing"
      ]);
  });

  it("retains positive-finding atom provenance in separate coverage decisions", () => {
    const { draft, evidence, request, scope } = fixture();
    const validation = validateKnowledgeGroundedSelectorV21({
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
    expect(deriveKnowledgeCoverageV6(validation.value)).toEqual({
      coveredDimensionCount: 1,
      excludedDimensionCount: 0,
      missingInformation: ["State that the Atlas controller preserves input ordering."],
      requestCoverage: "partial",
      supportedContentCount: 1
    });
  });

  it("prunes only provenance-disjoint surplus support edges in the current protocol", () => {
    const { evidence, request, scope } = fixture();
    const draft = decodeKnowledgeAnswerDraftV21({
      claims: [{
        citationHints: ["K1"],
        text: "The Atlas controller enforces a bounded queue."
      }, {
        citationHints: ["K2"],
        text: "A separate source discusses an optional illustration."
      }],
      version: 1
    }, { availableHandles: ["K1", "K2"] })!;
    const output = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
        id: "C2",
        supportHandles: ["K2"],
        verdict: "supported"
      }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1", "C2"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };

    expect(validateKnowledgeGroundedSelectorV21(output, {
      draft,
      evidence,
      request,
      scope
    })).toEqual({ kind: "rejected", reason: "selector_dimension_invalid" });
    const normalized = normalizeKnowledgeGroundedSelectorSupportEdgesV1(output, {
      draft,
      evidence,
      request,
      scope
    });
    expect(normalized?.coverage).toEqual([
      { id: "D1", status: "covered", supportIds: ["C1"] },
      { id: "D2", status: "missing", supportIds: [] }
    ]);
    expect(decodeKnowledgeGroundedSelectorSupportEdgesV1(output, {
      draft,
      evidence,
      request,
      scope
    })?.coverage[0]?.supportIds).toEqual(["C1"]);
  });

  it("does not invent support when every edge is disjoint or unknown", () => {
    const { draft, evidence, request, scope } = fixture();
    const base = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    for (const output of [{
      ...base,
      claims: [{ id: "C1", supportHandles: ["K2"], verdict: "supported" }]
    }, {
      ...base,
      coverage: [{ id: "D1", status: "covered", supportIds: ["C999"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }]
    }]) {
      expect(normalizeKnowledgeGroundedSelectorSupportEdgesV1(output, {
        draft,
        evidence,
        request,
        scope
      })).toBeNull();
    }
  });

  it("downgrades all-invalid current support edges without promoting coverage", () => {
    const { draft, evidence, request, scope } = fixture();
    const base = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    for (const output of [{
      ...base,
      claims: [{ id: "C1", supportHandles: ["K2"], verdict: "supported" }]
    }, {
      ...base,
      coverage: [{ id: "D1", status: "covered", supportIds: ["C999"] }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }]
    }]) {
      expect(normalizeKnowledgeGroundedSelectorSupportEdgesV2(output, {
        draft,
        evidence,
        request,
        scope
      })?.coverage).toEqual([{
        id: "D1",
        status: "missing",
        supportIds: []
      }, {
        id: "D2",
        status: "missing",
        supportIds: []
      }]);
    }
  });

  it("preserves valid current edges while pruning unknown and duplicate edges", () => {
    const { draft, evidence, request, scope } = fixture();
    const output = {
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{
        id: "D1",
        status: "covered",
        supportIds: ["C1", "C999", "C1"]
      }, {
        id: "D2",
        status: "missing",
        supportIds: ["C1"]
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    };
    expect(normalizeKnowledgeGroundedSelectorSupportEdgesV2(output, {
      draft,
      evidence,
      request,
      scope
    })?.coverage).toEqual([{
      id: "D1",
      status: "covered",
      supportIds: ["C1"]
    }, {
      id: "D2",
      status: "missing",
      supportIds: []
    }]);
  });

  it("excludes only positive Scope findings that fail exact-atom eligibility", () => {
    const { draft, evidence, request, scope } = fixture();
    const validation = validateKnowledgeGroundedSelectorV21({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "excluded",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { draft, evidence, request, scope });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    expect(deriveKnowledgeCoverageV6(validation.value)).toEqual({
      coveredDimensionCount: 1,
      excludedDimensionCount: 1,
      missingInformation: [],
      requestCoverage: "complete",
      supportedContentCount: 1
    });

    const unsupportedScope = validateKnowledgeCoverageScopeV6({
      evidenceUnits: [{ findings: [], handle: "K1" }, {
        findings: [],
        handle: "K2"
      }],
      jointFindings: [],
      unsupportedDimensions: [{
        description: "State the controller's latency guarantee.",
        requestAnchor: "guarantees"
      }],
      version: 6
    }, { evidence, request });
    expect(unsupportedScope.kind).toBe("accepted");
    if (unsupportedScope.kind !== "accepted") return;
    expect(validateKnowledgeGroundedSelectorV21({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
      coverage: [{ id: "D1", status: "excluded", supportIds: [] }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { draft, evidence, request, scope: unsupportedScope.value })).toEqual({
      kind: "rejected",
      reason: "selector_dimension_invalid"
    });
  });

  it("keeps excluded supported content out of settlement", () => {
    const { evidence, request, scope } = fixture();
    const currentDraft = decodeKnowledgeAnswerDraftV21({
      claims: [{
        citationHints: ["K1"],
        text: "The Atlas controller enforces a bounded queue."
      }, {
        citationHints: ["K1"],
        text: "The Atlas controller preserves input ordering."
      }],
      version: 1
    }, { availableHandles: ["K1", "K2"] })!;
    const validation = validateKnowledgeGroundedSelectorV21({
      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
        id: "C2",
        supportHandles: ["K1"],
        verdict: "supported"
      }],
      coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
        id: "D2",
        status: "excluded",
        supportIds: []
      }],
      extractIds: [],
      insufficientReason: "not_applicable",
      version: 1
    }, { draft: currentDraft, evidence, request, scope });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    const settlement = settleKnowledgeAnswerV21FromFinalSelector({
      draft: currentDraft,
      evidence,
      selector: validation.value
    });
    expect(settlement.requestCoverage).toBe("complete");
    expect(settlement.finalText).toContain("bounded queue");
    expect(settlement.finalText).not.toContain("input ordering");
  });

  it("pins the immutable V6 scope into initial and final prompts", () => {
    const { draft, evidence, manifest, request, scope } = fixture();
    for (const selectorPass of ["initial", "final"] as const) {
      const prompt = knowledgeGroundedSelectorPromptV21({
        draft,
        evidence,
        evidenceManifest: manifest.message,
        request,
        scope,
        selectorPass
      });
      const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
      expect(payload.coverageScope).toEqual(scope);
      expect(payload.scopeEvidenceAtomIndex).toEqual({
        items: [{
          handle: "K1",
          id: "A1",
          text: "The Atlas controller enforces a bounded queue."
        }, {
          handle: "K1",
          id: "A2",
          text: "It preserves input ordering."
        }],
        version: 1
      });
      expect(payload.selectorPass).toBe(selectorPass);
    }
  });
});
