import { describe, expect, it } from "vitest";
import {
  buildKnowledgeSupportedAnswerViewV1,
  decodeKnowledgeAnswerDraftV21
} from "./answerGroundingV21";
import { validateKnowledgeGroundedSelectorV21 } from "./answerGroundingSelectorV21";
import {
  applyKnowledgeCoverageScopeClosureV2,
  decodeKnowledgeCoverageScopeClosureFailureV2,
  decodeKnowledgeCoverageScopeClosurePromptV2,
  knowledgeCoverageScopeClosureAuditRequiredV2,
  knowledgeCoverageScopeClosureAuthorityV2,
  knowledgeCoverageScopeClosureFailureV2,
  knowledgeCoverageScopeClosurePromptV2,
  validateKnowledgeCoverageScopeClosureV2
} from "./coverageScopeClosureV2";
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
      exactExcerpt: "Atlas and Boreal both degrade at 1B operations. Atlas degrades at 1B operations.",
      fileName: "scaling.md",
      handle: "K1",
      locator: "section=Scaling",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Scaling",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }, {
      ambiguity: "none",
      evidenceId: "provider-call:result:2",
      exactExcerpt: "Boreal degrades at 1B operations.",
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
    profileId: "fixture:scope-closure-v2",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "At what size do both Atlas and Boreal degrade?";
  const draft = decodeKnowledgeAnswerDraftV21({
    claims: [{
      citationHints: ["K1"],
      text: "Atlas degrades at 1B operations."
    }, {
      citationHints: ["K2"],
      text: "This supported Boreal point remains deliberately unmapped."
    }],
    version: 1
  }, { availableHandles: ["K1", "K2"] })!;
  const scopeValidation = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{
      findings: [{
        description: "State the size at which both Atlas and Boreal degrade.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "At"
      }, {
        description: "State the size at which Atlas degrades.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "At"
      }],
      handle: "K1"
    }, {
      findings: [{
        description: "State the size at which Boreal degrades.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "At"
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
    }],
    coverage: [{ id: "D1", status: "excluded", supportIds: [] }, {
      id: "D2",
      status: "covered",
      supportIds: ["C1"]
    }, {
      id: "D3",
      status: "missing",
      supportIds: []
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

describe("Knowledge Coverage Scope closure V2", () => {
  it("audits covered or excluded reductions but skips an all-missing handoff", () => {
    const input = fixture();
    expect(knowledgeCoverageScopeClosureAuditRequiredV2(input.selector)).toBe(true);
    expect(knowledgeCoverageScopeClosureAuditRequiredV2({
      ...input.selector,
      coverage: input.selector.coverage.map((dimension) => ({
        ...dimension,
        status: "missing" as const,
        supportIds: []
      }))
    })).toBe(false);
    expect(knowledgeCoverageScopeClosureAuditRequiredV2({
      ...input.selector,
      coverage: input.selector.coverage.map((dimension) => ({
        ...dimension,
        status: "excluded" as const,
        supportIds: []
      }))
    })).toBe(true);
  });

  it("audits the complete ordered Scope but projects only mapped supported text", () => {
    const input = fixture();
    const authority = knowledgeCoverageScopeClosureAuthorityV2(input);
    expect(authority?.dimensions.map(({ id, selectorStatus, supportIds }) => ({
      id,
      selectorStatus,
      supportIds
    }))).toEqual([{ id: "D1", selectorStatus: "excluded", supportIds: [] }, {
      id: "D2",
      selectorStatus: "covered",
      supportIds: ["C1"]
    }, {
      id: "D3",
      selectorStatus: "missing",
      supportIds: []
    }]);
    expect(authority?.scopeEvidenceAtomIndex.items.map(({ id }) => id)).toEqual([
      "A1", "A2", "A3"
    ]);
    expect(authority?.supportedView.claims.map(({ id }) => id)).toEqual(["C1"]);
    expect(authority?.supportedView.claims.map(({ id }) => id)).not.toContain("C2");
  });

  it("can only reopen covered or excluded dimensions to missing", () => {
    const input = fixture();
    const output = {
      decisions: [{ id: "D1", status: "missing" }, {
        id: "D2",
        status: "closed"
      }, {
        id: "D3",
        status: "missing"
      }],
      version: 2
    } as const;
    const validation = validateKnowledgeCoverageScopeClosureV2(output, input);
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    const selector = applyKnowledgeCoverageScopeClosureV2({
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
      supportIds: ["C1"]
    }, {
      id: "D3",
      status: "missing",
      supportIds: []
    }]);
  });

  it("rejects promotion, new exclusion, omissions, and reordered IDs", () => {
    const input = fixture();
    for (const output of [{
      decisions: [{ id: "D1", status: "closed" }, {
        id: "D2", status: "closed"
      }, { id: "D3", status: "missing" }],
      version: 2
    }, {
      decisions: [{ id: "D1", status: "excluded" }, {
        id: "D2", status: "excluded"
      }, { id: "D3", status: "missing" }],
      version: 2
    }, {
      decisions: [{ id: "D1", status: "excluded" }, {
        id: "D2", status: "closed"
      }, { id: "D3", status: "excluded" }],
      version: 2
    }, {
      decisions: [{ id: "D2", status: "closed" }, {
        id: "D1", status: "excluded"
      }],
      version: 2
    }]) {
      expect(validateKnowledgeCoverageScopeClosureV2(output, input)).toEqual({
        kind: "rejected",
        reason: "coverage_scope_closure_decision_invalid"
      });
    }
  });

  it("round-trips the holistic initial and structural-repair prompts", () => {
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
      const prompt = knowledgeCoverageScopeClosurePromptV2({
        ...authorityInput,
        ...pass
      });
      expect(decodeKnowledgeCoverageScopeClosurePromptV2({
        ...authorityInput,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt
      })).toEqual({
        closurePass: pass.closurePass,
        repairReason: "repairReason" in pass ? pass.repairReason : null
      });
      expect(prompt.userPrompt).toContain('"selectorStatus":"excluded"');
      expect(prompt.userPrompt).toContain('"scopeEvidenceAtomIndex"');
      expect(prompt.userPrompt).not.toContain(input.manifest.message);
      expect(prompt.userPrompt).not.toContain('"id":"C2"');
    }
  });

  it("keeps benchmark taxonomy outside the product failure decoder", () => {
    const failure = knowledgeCoverageScopeClosureFailureV2(
      "coverage_scope_closure_decision_invalid"
    );
    expect(decodeKnowledgeCoverageScopeClosureFailureV2(failure)).toEqual(failure);
    expect(decodeKnowledgeCoverageScopeClosureFailureV2({
      ...failure,
      reason: "open_rag_false_complete"
    })).toBeNull();
  });
});
