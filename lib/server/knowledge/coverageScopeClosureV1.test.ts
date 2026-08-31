import { describe, expect, it } from "vitest";
import {
  buildKnowledgeSupportedAnswerViewV1,
  decodeKnowledgeAnswerDraftV21
} from "./answerGroundingV21";
import {
  validateKnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import {
  applyKnowledgeCoverageScopeClosureV1,
  decodeKnowledgeCoverageScopeClosureFailureV1,
  decodeKnowledgeCoverageScopeClosurePromptV1,
  knowledgeCoverageScopeClosureAuthorityV1,
  knowledgeCoverageScopeClosureFailureV1,
  knowledgeCoverageScopeClosurePromptV1,
  validateKnowledgeCoverageScopeClosureV1
} from "./coverageScopeClosureV1";
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
      exactExcerpt: "The Atlas controller enforces a bounded queue. It preserves input ordering statically.",
      fileName: "atlas.md",
      handle: "K1",
      locator: "section=Atlas",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Atlas",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }, {
      ambiguity: "none",
      evidenceId: "provider-call:result:2",
      exactExcerpt: "The Boreal controller survives restarts.",
      fileName: "boreal.md",
      handle: "K2",
      locator: "section=Boreal",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S2",
      sourceLabel: "Boreal",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:scope-closure-v1",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Compare the Atlas ordering guarantees and Boreal durability.";
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{
      citationHints: ["K1"],
      text: "The Atlas controller enforces a bounded queue."
    }, {
      citationHints: ["K2"],
      text: "The Boreal controller survives restarts."
    }, {
      citationHints: ["K1"],
      text: "This supported text is not mapped to a covered dimension."
    }],
    version: 1
  }, { availableHandles: ["K1", "K2"] })!;
  const scopeValidation = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{
      findings: [{
        description: "Explain that Atlas both enforces a bounded queue and preserves input ordering statically.",
        evidenceAtomIds: ["A1", "A2"],
        requestAnchor: "Atlas ordering guarantees"
      }],
      handle: "K1"
    }, {
      findings: [{
        description: "State Boreal durability across restarts.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "Boreal durability"
      }],
      handle: "K2"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  }, { evidence, request });
  if (scopeValidation.kind !== "accepted") throw new Error("fixture_scope_invalid");
  const selectorValidation = validateKnowledgeGroundedSelectorV21({
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }, {
      id: "C2",
      supportHandles: ["K2"],
      verdict: "supported"
    }, {
      id: "C3",
      supportHandles: ["K1"],
      verdict: "supported"
    }],
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
      id: "D2",
      status: "covered",
      supportIds: ["C2"]
    }],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  }, {
    draft,
    evidence,
    request,
    scope: scopeValidation.value
  });
  if (selectorValidation.kind !== "accepted") {
    throw new Error("fixture_selector_invalid");
  }
  const supportedView = buildKnowledgeSupportedAnswerViewV1({
    draft,
    evidence,
    selector: Object.freeze({
      claims: selectorValidation.value.claims,
      extractIds: selectorValidation.value.extractIds,
      insufficientReason: selectorValidation.value.insufficientReason,
      version: selectorValidation.value.version
    })
  });
  return {
    draft,
    evidence,
    manifest,
    request,
    scope: scopeValidation.value,
    selector: selectorValidation.value,
    supportedView
  };
}

describe("Knowledge Coverage Scope closure V1", () => {
  it("exposes only content mapped to claimed-covered immutable dimensions", () => {
    const input = fixture();
    expect(knowledgeCoverageScopeClosureAuthorityV1(input)).toEqual({
      coveredDimensions: [{
        description: "Explain that Atlas both enforces a bounded queue and preserves input ordering statically.",
        id: "D1",
        requestAnchor: "Atlas ordering guarantees",
        supportIds: ["C1"]
      }, {
        description: "State Boreal durability across restarts.",
        id: "D2",
        requestAnchor: "Boreal durability",
        supportIds: ["C2"]
      }],
      supportedView: {
        claims: [input.supportedView.claims[0], input.supportedView.claims[1]],
        literals: []
      }
    });
  });

  it("accepts an exact ordered veto list and can only reopen coverage", () => {
    const input = fixture();
    const output = {
      decisions: [{ id: "D1", status: "missing" }, {
        id: "D2",
        status: "closed"
      }],
      version: 1
    } as const;
    const validation = validateKnowledgeCoverageScopeClosureV1(output, input);
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    const selector = applyKnowledgeCoverageScopeClosureV1({
      closure: validation.value,
      selector: input.selector
    });
    expect(selector.coverage.map(({ id, status, supportIds }) => ({
      id,
      status,
      supportIds
    }))).toEqual([{ id: "D1", status: "missing", supportIds: [] }, {
      id: "D2",
      status: "covered",
      supportIds: ["C2"]
    }]);
    expect(selector.claims).toEqual(input.selector.claims);
  });

  it("rejects omissions, reordered IDs, and decisions for non-covered dimensions", () => {
    const input = fixture();
    for (const output of [{ decisions: [{ id: "D1", status: "closed" }], version: 1 }, {
      decisions: [{ id: "D2", status: "closed" }, {
        id: "D1",
        status: "missing"
      }],
      version: 1
    }]) {
      expect(validateKnowledgeCoverageScopeClosureV1(output, input)).toEqual({
        kind: "rejected",
        reason: "coverage_scope_closure_decision_invalid"
      });
    }
    const reopened = applyKnowledgeCoverageScopeClosureV1({
      closure: { decisions: [{ id: "D1", status: "missing" }, {
        id: "D2",
        status: "closed"
      }], version: 1 },
      selector: input.selector
    });
    expect(knowledgeCoverageScopeClosureAuthorityV1({
      ...input,
      selector: reopened
    })?.coveredDimensions.map(({ id }) => id)).toEqual(["D2"]);
    expect(validateKnowledgeCoverageScopeClosureV1({
      decisions: [{ id: "D1", status: "closed" }, {
        id: "D2",
        status: "closed"
      }],
      version: 1
    }, { ...input, selector: reopened })).toEqual({
      kind: "rejected",
      reason: "coverage_scope_closure_decision_invalid"
    });
  });

  it("round-trips initial and structural-repair prompts over identical authority", () => {
    const input = fixture();
    const authorityInput = {
      evidence: input.evidence,
      request: input.request,
      scope: input.scope,
      selector: input.selector,
      supportedView: input.supportedView
    };
    for (const pass of [{ closurePass: "initial" as const }, {
      closurePass: "repair" as const,
      repairReason: "coverage_scope_closure_decision_invalid" as const
    }]) {
      const prompt = knowledgeCoverageScopeClosurePromptV1({
        ...authorityInput,
        ...pass
      });
      const decoded = decodeKnowledgeCoverageScopeClosurePromptV1({
        ...authorityInput,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt
      });
      expect(decoded).toEqual({
        closurePass: pass.closurePass,
        repairReason: "repairReason" in pass ? pass.repairReason : null
      });
      expect(prompt.userPrompt).not.toContain(input.manifest.message);
      expect(prompt.userPrompt).not.toContain("C3");
    }
  });

  it("keeps benchmark taxonomy outside the product failure decoder", () => {
    const failure = knowledgeCoverageScopeClosureFailureV1(
      "coverage_scope_closure_decision_invalid"
    );
    expect(decodeKnowledgeCoverageScopeClosureFailureV1(failure)).toEqual(failure);
    expect(decodeKnowledgeCoverageScopeClosureFailureV1({
      ...failure,
      reason: "open_rag_replay_false_complete"
    })).toBeNull();
  });
});
