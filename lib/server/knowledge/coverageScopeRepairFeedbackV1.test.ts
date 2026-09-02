import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { knowledgeCoverageEvidenceFromManifestV6 } from "./coverageScopeV6";
import {
  decodeKnowledgeCoverageScopePromptV6RepairFeedbackV1,
  decodeKnowledgeCoverageScopeRepairDiagnosticV1,
  decodeKnowledgeCoverageScopeRepairFeedbackFailureV1,
  knowledgeCoverageScopePromptV6RepairFeedbackV1,
  knowledgeCoverageScopeRepairFeedbackFailureV1,
  validateKnowledgeCoverageScopeV6RepairFeedbackV1
} from "./coverageScopeRepairFeedbackV1";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "The Atlas controller preserves input ordering. Its queue expires after one hour.",
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
      exactExcerpt: "The Boreal controller survives restarts. Boreal does not preserve ordering.",
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
    profileId: "fixture:scope-repair-feedback-v1",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Compare ordering and durability, and state the retention owner.";
  const output = {
    evidenceUnits: [{
      findings: [{
        description: "State Boreal durability.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "durability"
      }],
      handle: "K2"
    }, {
      findings: [{
        description: "State Atlas ordering.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "ordering"
      }],
      handle: "K1"
    }],
    jointFindings: [{
      description: "Compare ordering behavior.",
      evidenceAtomIds: ["A1", "A4"],
      requestAnchor: "Compare"
    }],
    unsupportedDimensions: [{
      description: "Identify the retention owner.",
      requestAnchor: "retention owner"
    }],
    version: 6
  } as const;
  return { evidence, manifest, output, request };
}

describe("Knowledge Coverage Scope repair feedback V1", () => {
  it("reports the exact local-provenance boundary without provider content", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1({
      ...output,
      evidenceUnits: [output.evidenceUnits[0], {
        ...output.evidenceUnits[1],
        findings: [{
          ...output.evidenceUnits[1].findings[0],
          evidenceAtomIds: ["A1", "A3"]
        }]
      }]
    }, { evidence, request });
    expect(validation).toEqual({
      diagnostic: {
        actualCount: 2,
        code: "finding_atom_provenance",
        expectedHandle: "K1",
        maximumCount: 1,
        path: "/evidenceUnits/1/findings/0/evidenceAtomIds",
        version: 1
      },
      kind: "rejected",
      reason: "coverage_scope_finding_invalid"
    });
    expect(JSON.stringify(validation)).not.toContain("State Atlas ordering");
  });

  it("reports a cross-array total of nine against the global limit of eight", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1({
      ...output,
      unsupportedDimensions: Array.from({ length: 6 }, (_, index) => ({
        description: `Retention requirement ${index + 1}.`,
        requestAnchor: "retention"
      }))
    }, { evidence, request });
    expect(validation).toEqual({
      diagnostic: {
        actualCount: 9,
        code: "dimension_count",
        expectedHandle: null,
        maximumCount: 8,
        path: "/",
        version: 1
      },
      kind: "rejected",
      reason: "coverage_scope_shape_invalid"
    });
  });

  it("puts bounded limits and exact diagnostics in a fresh blind repair prompt", () => {
    const { evidence, manifest, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1({
      ...output,
      unsupportedDimensions: Array.from({ length: 6 }, (_, index) => ({
        description: `Retention requirement ${index + 1}.`,
        requestAnchor: "retention"
      }))
    }, { evidence, request });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected") return;
    const initial = knowledgeCoverageScopePromptV6RepairFeedbackV1({
      evidence,
      evidenceManifest: manifest.message,
      request,
      scopePass: "initial"
    });
    const repair = knowledgeCoverageScopePromptV6RepairFeedbackV1({
      evidence,
      evidenceManifest: manifest.message,
      repairDiagnostic: validation.diagnostic,
      repairReason: validation.reason,
      request,
      scopePass: "repair"
    });
    const initialPayload = JSON.parse(initial.userPrompt) as Record<string, unknown>;
    const repairPayload = JSON.parse(repair.userPrompt) as Record<string, unknown>;
    expect(initialPayload.repairDiagnostic).toBeNull();
    expect(initialPayload.repairReason).toBeNull();
    expect(repairPayload.repairDiagnostic).toEqual(validation.diagnostic);
    expect(repairPayload.validationLimits).toMatchObject({ maxTotalDimensions: 8 });
    expect(repairPayload).not.toHaveProperty("priorOutput");
    expect(repair.userPrompt).not.toContain(manifest.message);
    expect(repair.userPrompt).not.toContain("Retention requirement");
    expect(decodeKnowledgeCoverageScopePromptV6RepairFeedbackV1({
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: repair.systemPrompt,
      userPrompt: repair.userPrompt
    })).toEqual({
      repairDiagnostic: validation.diagnostic,
      repairReason: validation.reason,
      scopePass: "repair"
    });
  });

  it("persists validation diagnostics but rejects malformed feedback", () => {
    const diagnostic = {
      actualCount: 9,
      code: "dimension_count",
      expectedHandle: null,
      maximumCount: 8,
      path: "/",
      version: 1
    } as const;
    const failure = knowledgeCoverageScopeRepairFeedbackFailureV1(
      "coverage_scope_shape_invalid",
      diagnostic
    );
    expect(decodeKnowledgeCoverageScopeRepairFeedbackFailureV1(failure)).toEqual(failure);
    expect(decodeKnowledgeCoverageScopeRepairDiagnosticV1({
      ...diagnostic,
      path: "/evidenceUnits/0/findings/0/description/private-content"
    })).toBeNull();
    expect(decodeKnowledgeCoverageScopeRepairFeedbackFailureV1({
      ...failure,
      diagnostic: null
    })).toBeNull();
  });
});
