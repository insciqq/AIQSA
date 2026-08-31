import { describe, expect, it } from "vitest";
import type { KnowledgeSelectorEvidenceV1 } from "./answerGroundingV5";
import type { KnowledgeSupportedAnswerViewV1 } from "./coverageAuditV1";
import {
  KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V2,
  KNOWLEDGE_COVERAGE_AUDITOR_OPERATION,
  KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V2,
  decodeKnowledgeCoverageAuditPromptV2,
  decodeKnowledgeCoverageAuditV2,
  deriveKnowledgeCoverageV2,
  knowledgeCoverageAuditDimensionsV2,
  knowledgeCoverageAuditMissingDimensionsV2,
  knowledgeCoverageAuditPromptV2,
  validateKnowledgeCoverageAuditV2
} from "./coverageAuditV2";

const evidence: readonly KnowledgeSelectorEvidenceV1[] = Object.freeze([
  Object.freeze({
    exactExcerpt: "Mechanism A preserves the original order.",
    handle: "K1"
  }),
  Object.freeze({
    exactExcerpt: "The controller bounds queue depth and preserves arrival order.",
    handle: "K2"
  }),
  Object.freeze({
    exactExcerpt: "A neighboring application concerns storage layout.",
    handle: "K3"
  })
]);

const request = "How does the controller enforce its guarantees and preserve arrival order?";

const supportedView: KnowledgeSupportedAnswerViewV1 = Object.freeze({
  claims: Object.freeze([
    Object.freeze({
      id: "C1",
      supportHandles: Object.freeze(["K2"]),
      text: "The controller bounds queue depth."
    }),
    Object.freeze({
      id: "C2",
      supportHandles: Object.freeze(["K3"]),
      text: "A neighboring application concerns storage layout."
    })
  ]),
  literals: Object.freeze([])
});

function coequalAudit(): unknown {
  return {
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
      id: "D2",
      status: "missing",
      supportIds: []
    }],
    scope: [{
      description: "State how the controller bounds queue depth.",
      evidenceHandles: ["K2"],
      id: "D1",
      requestAnchor: "enforce its guarantees"
    }, {
      description: "State how the controller preserves arrival order.",
      evidenceHandles: ["K2"],
      id: "D2",
      requestAnchor: "preserve arrival order"
    }],
    version: 2
  };
}

describe("Coverage Auditor V2 contracts", () => {
  it("separates query-to-evidence scope from answer coverage in one operation", () => {
    expect(KNOWLEDGE_COVERAGE_AUDITOR_OPERATION).toBe(
      "knowledge_coverage_auditor_v2"
    );
    expect(KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V2).toMatchObject({
      additionalProperties: false,
      required: ["version", "scope", "coverage"]
    });
    expect(Object.keys(KNOWLEDGE_COVERAGE_AUDIT_SCHEMA_V2.properties)).toEqual([
      "version",
      "scope",
      "coverage"
    ]);
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V2).toContain(
      "Complete the entire scope phase from the request and evidence as if SupportedAnswerViewV1 were absent"
    );
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V2).toContain(
      "One evidence item may contain multiple co-equal direct conclusions"
    );
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V2).toContain(
      "canonical support handles overlap"
    );
    expect(KNOWLEDGE_COVERAGE_AUDITOR_CONTRACT_V2).not.toContain(
      "referenceAnswer"
    );
  });

  it("keeps a co-equal omitted axis missing even when both axes share one handle", () => {
    const audit = decodeKnowledgeCoverageAuditV2(coequalAudit(), {
      evidence,
      request,
      supportedView
    });
    expect(audit).not.toBeNull();
    expect(audit?.scope.map(({ evidenceHandles }) => evidenceHandles)).toEqual([
      ["K2"],
      ["K2"]
    ]);
    expect(deriveKnowledgeCoverageV2(audit!)).toEqual({
      coveredDimensionCount: 1,
      missingInformation: ["State how the controller preserves arrival order."],
      requestCoverage: "partial",
      supportedContentCount: 1
    });
    expect(knowledgeCoverageAuditMissingDimensionsV2(audit!)).toEqual([
      expect.objectContaining({
        evidenceHandles: ["K2"],
        id: "D2",
        status: "missing"
      })
    ]);
  });

  it("rejects a related supported claim whose evidence is outside the frozen scope", () => {
    const value = coequalAudit() as {
      coverage: Array<Record<string, unknown>>;
    };
    value.coverage[1] = {
      id: "D2",
      status: "covered",
      supportIds: ["C2"]
    };
    expect(validateKnowledgeCoverageAuditV2(value, {
      evidence,
      request,
      supportedView
    })).toEqual({ kind: "rejected", reason: "coverage_audit_support_invalid" });
  });

  it("rejects evidence-only coverage and unknown evidence scope", () => {
    const noSupport = coequalAudit() as {
      coverage: Array<Record<string, unknown>>;
    };
    noSupport.coverage[0] = { id: "D1", status: "covered", supportIds: [] };
    expect(decodeKnowledgeCoverageAuditV2(noSupport, {
      evidence,
      request,
      supportedView
    })).toBeNull();

    const unknownEvidence = coequalAudit() as {
      scope: Array<Record<string, unknown>>;
    };
    unknownEvidence.scope[0] = {
      ...unknownEvidence.scope[0],
      evidenceHandles: ["K9"]
    };
    expect(validateKnowledgeCoverageAuditV2(unknownEvidence, {
      evidence,
      request,
      supportedView
    })).toEqual({
      kind: "rejected",
      reason: "coverage_audit_scope_evidence_invalid"
    });
  });

  it("keeps a requested facet with no evidence as an explicit missing scope item", () => {
    const value = coequalAudit() as {
      coverage: Array<Record<string, unknown>>;
      scope: Array<Record<string, unknown>>;
    };
    value.scope[1] = { ...value.scope[1], evidenceHandles: [] };
    const audit = decodeKnowledgeCoverageAuditV2(value, {
      evidence,
      request,
      supportedView
    });
    expect(knowledgeCoverageAuditDimensionsV2(audit!)[1]).toMatchObject({
      evidenceHandles: [],
      status: "missing",
      supportIds: []
    });
  });

  it("rejects reordered coverage, duplicate descriptions, and inexact anchors", () => {
    const reordered = coequalAudit() as {
      coverage: Array<Record<string, unknown>>;
    };
    reordered.coverage.reverse();
    expect(validateKnowledgeCoverageAuditV2(reordered, {
      evidence,
      request,
      supportedView
    })).toEqual({ kind: "rejected", reason: "coverage_audit_scope_invalid" });

    const duplicate = coequalAudit() as { scope: Array<Record<string, unknown>> };
    duplicate.scope[1] = {
      ...duplicate.scope[1],
      description: duplicate.scope[0]?.description
    };
    expect(validateKnowledgeCoverageAuditV2(duplicate, {
      evidence,
      request,
      supportedView
    })).toEqual({
      kind: "rejected",
      reason: "coverage_audit_description_invalid"
    });

    const wrongAnchor = coequalAudit() as { scope: Array<Record<string, unknown>> };
    wrongAnchor.scope[0] = { ...wrongAnchor.scope[0], requestAnchor: "storage layout" };
    expect(validateKnowledgeCoverageAuditV2(wrongAnchor, {
      evidence,
      request,
      supportedView
    })).toEqual({ kind: "rejected", reason: "coverage_audit_anchor_invalid" });
  });

  it("round-trips initial and structural-repair prompts over identical authority", () => {
    const manifest = "<private_knowledge_evidence>bounded</private_knowledge_evidence>";
    const selectorState = {
      contradictedClaimCount: 0,
      selectedLiteralCount: 0,
      supportedClaimCount: 2,
      unsupportedClaimCount: 0
    };
    const initial = knowledgeCoverageAuditPromptV2({
      auditPass: "initial",
      evidence,
      evidenceManifest: manifest,
      request,
      selectorState,
      supportedView
    });
    expect(decodeKnowledgeCoverageAuditPromptV2({
      evidence,
      evidenceManifest: manifest,
      request,
      ...initial
    })).toEqual({
      auditPass: "initial",
      repairReason: null,
      selectorState,
      supportedView
    });
    const repair = knowledgeCoverageAuditPromptV2({
      auditPass: "repair",
      evidence,
      evidenceManifest: manifest,
      repairReason: "coverage_audit_scope_invalid",
      request,
      selectorState,
      supportedView
    });
    expect(decodeKnowledgeCoverageAuditPromptV2({
      evidence,
      evidenceManifest: manifest,
      request,
      ...repair
    })).toMatchObject({
      auditPass: "repair",
      repairReason: "coverage_audit_scope_invalid",
      selectorState,
      supportedView
    });
    expect(() => knowledgeCoverageAuditPromptV2({
      auditPass: "initial",
      evidence,
      evidenceManifest: manifest,
      referenceAnswer: "forbidden evaluator authority",
      request,
      supportedView
    } as never)).toThrow("knowledge_coverage_audit_prompt_invalid");
  });
});
