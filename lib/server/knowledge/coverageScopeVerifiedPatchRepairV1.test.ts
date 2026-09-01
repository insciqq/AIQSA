import { describe, expect, it } from "vitest";
import {
  knowledgeAnswerHash
} from "./answerGroundingV5";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { knowledgeCoverageEvidenceFromManifestV6 } from "./coverageScopeV6";
import {
  decodeKnowledgeCoverageScopePromptV6VerifiedPatchV1,
  decodeKnowledgeCoverageScopeVerifiedPatchFailureV1,
  knowledgeCoverageScopePromptV6VerifiedPatchV1,
  knowledgeCoverageScopeRepairBaseHashV1,
  knowledgeCoverageScopeVerifiedPatchFailureV1,
  mergeKnowledgeCoverageScopeVerifiedPatchesV1,
  rejectKnowledgeCoverageScopeForeignLocalFindingsV1,
  rejectKnowledgeCoverageScopeInvalidProvenanceFindingsV2,
  validateKnowledgeCoverageScopeV6VerifiedPatchV1
} from "./coverageScopeVerifiedPatchRepairV1";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "Atlas preserves input ordering. Atlas expires work after one hour.",
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
      exactExcerpt: "Boreal survives restarts. Boreal does not preserve ordering.",
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
    profileId: "fixture:scope-verified-patch-v1",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Compare ordering and durability.";
  const base = {
    evidenceUnits: [{
      findings: [{
        description: "State Atlas ordering.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "ordering"
      }, {
        description: "State Atlas retention.",
        evidenceAtomIds: ["A2", "A3"],
        requestAnchor: "ordering and durability"
      }],
      handle: "K1"
    }, {
      findings: [{
        description: "State Boreal durability.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "durability"
      }],
      handle: "K2"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  } as const;
  const repair = {
    evidenceUnits: [{
      findings: [{
        description: "Rewritten Atlas ordering.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "Atlas preserves input ordering"
      }, {
        description: "Rewritten Atlas retention.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "Atlas expires work"
      }],
      handle: "K1"
    }, {
      findings: [{
        description: "Rewritten Boreal durability.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "Boreal survives restarts"
      }],
      handle: "K2"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  } as const;
  return { base, evidence, manifest, repair, request };
}

describe("Knowledge Coverage Scope verified patch repair V1", () => {
  it("drops a foreign-provenance local finding without guessing another atom", () => {
    const { base, evidence, request } = fixture();
    const rejection = rejectKnowledgeCoverageScopeForeignLocalFindingsV1(base, {
      evidence,
      request
    });
    expect(rejection.droppedFindingPaths).toEqual([
      "/evidenceUnits/0/findings/1"
    ]);
    expect(rejection.validation.kind).toBe("accepted");
    if (rejection.validation.kind !== "accepted") return;
    expect(rejection.validation.output.evidenceUnits[0]!.findings).toEqual([
      base.evidenceUnits[0]!.findings[0]
    ]);
    expect(rejection.validation.output.evidenceUnits[1]).toEqual(
      base.evidenceUnits[1]
    );
    expect(JSON.stringify(rejection.validation.output)).not.toContain(
      "State Atlas retention"
    );
  });

  it("keeps non-provenance validation failures on the verified repair path", () => {
    const { base, evidence, request } = fixture();
    const invalidAnchor = {
      ...base,
      evidenceUnits: [{
        ...base.evidenceUnits[0],
        findings: [{
          ...base.evidenceUnits[0]!.findings[0],
          requestAnchor: "not present in request"
        }]
      }, base.evidenceUnits[1]]
    };
    const rejection = rejectKnowledgeCoverageScopeForeignLocalFindingsV1(
      invalidAnchor,
      { evidence, request }
    );
    expect(rejection.droppedFindingPaths).toEqual([]);
    expect(rejection.validation).toMatchObject({
      diagnostic: { code: "anchor_invalid" },
      kind: "rejected"
    });
  });

  it("drops a single-handle joint finding while preserving valid siblings", () => {
    const { base, evidence, request } = fixture();
    const validEvidenceUnits = [{
      ...base.evidenceUnits[0],
      findings: [base.evidenceUnits[0]!.findings[0]]
    }, base.evidenceUnits[1]];
    const invalidJoint = {
      ...base,
      evidenceUnits: validEvidenceUnits,
      jointFindings: [{
        description: "Do not treat one source as a joint comparison.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "ordering"
      }]
    };

    const rejection = rejectKnowledgeCoverageScopeInvalidProvenanceFindingsV2(
      invalidJoint,
      { evidence, request }
    );

    expect(rejection.droppedFindingPaths).toEqual(["/jointFindings/0"]);
    expect(rejection.validation.kind).toBe("accepted");
    if (rejection.validation.kind !== "accepted") return;
    expect(rejection.validation.output.evidenceUnits).toEqual(validEvidenceUnits);
    expect(rejection.validation.output.jointFindings).toEqual([]);
    expect(JSON.stringify(rejection.validation.output)).not.toContain(
      "one source as a joint comparison"
    );
  });

  it("drops a latent invalid joint item during verified repair without patching it", () => {
    const { base, evidence, request } = fixture();
    const invalidJoint = {
      ...base,
      evidenceUnits: [{
        ...base.evidenceUnits[0],
        findings: [base.evidenceUnits[0]!.findings[0]]
      }, base.evidenceUnits[1]],
      jointFindings: [{
        description: "Do not retain malformed joint provenance.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "ordering"
      }]
    };
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(
      invalidJoint,
      { evidence, request }
    );
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected" || !validation.repairBase) return;
    expect(validation.diagnostic).toMatchObject({
      code: "joint_handle_count",
      path: "/jointFindings/0/evidenceAtomIds"
    });

    const merged = mergeKnowledgeCoverageScopeVerifiedPatchesV1({
      base: validation.repairBase,
      diagnostic: validation.diagnostic,
      evidence,
      rejectInvalidProvenanceFindings: true,
      repair: invalidJoint,
      request
    });

    expect(merged.kind).toBe("accepted");
    if (merged.kind !== "accepted") return;
    expect(merged.patchedPaths).toEqual([]);
    expect(merged.output.jointFindings).toEqual([]);
    expect(JSON.stringify(merged.output)).not.toContain(
      "malformed joint provenance"
    );
  });

  it("patches only verifier-rejected paths and preserves valid anchors and descriptions", () => {
    const { base, evidence, repair, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(base, {
      evidence,
      request
    });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected") return;
    expect(validation.diagnostic).toMatchObject({
      code: "finding_atom_provenance",
      path: "/evidenceUnits/0/findings/1/evidenceAtomIds"
    });
    const merged = mergeKnowledgeCoverageScopeVerifiedPatchesV1({
      base: validation.repairBase!,
      diagnostic: validation.diagnostic,
      evidence,
      repair,
      request
    });
    expect(merged.kind).toBe("accepted");
    if (merged.kind !== "accepted") return;
    expect(merged.patchedPaths).toEqual([
      "/evidenceUnits/0/findings/1/evidenceAtomIds"
    ]);
    expect(merged.output.evidenceUnits[0]!.findings).toEqual([base.evidenceUnits[0]!.findings[0], {
      ...base.evidenceUnits[0]!.findings[1],
      evidenceAtomIds: ["A2"]
    }]);
    expect(merged.output.evidenceUnits[1]).toEqual(base.evidenceUnits[1]);
    expect(JSON.stringify(merged.output)).not.toContain("Atlas expires work");
    expect(JSON.stringify(merged.output)).not.toContain("Rewritten");
  });

  it("drops latent foreign provenance after repairing an earlier invalid field", () => {
    const { base, evidence, repair, request } = fixture();
    const invalid = {
      ...base,
      evidenceUnits: [{
        ...base.evidenceUnits[0],
        findings: [{
          ...base.evidenceUnits[0]!.findings[0],
          requestAnchor: "not present in request"
        }, base.evidenceUnits[0]!.findings[1]]
      }, base.evidenceUnits[1]]
    };
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(invalid, {
      evidence,
      request
    });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected" || !validation.repairBase) return;
    expect(validation.diagnostic).toMatchObject({
      code: "anchor_invalid",
      path: "/evidenceUnits/0/findings/0/requestAnchor"
    });
    const repairWithValidAnchor = {
      ...repair,
      evidenceUnits: [{
        ...repair.evidenceUnits[0],
        findings: [{
          ...repair.evidenceUnits[0]!.findings[0],
          requestAnchor: "ordering"
        }, repair.evidenceUnits[0]!.findings[1]]
      }, repair.evidenceUnits[1]]
    };

    const merged = mergeKnowledgeCoverageScopeVerifiedPatchesV1({
      base: validation.repairBase,
      diagnostic: validation.diagnostic,
      evidence,
      rejectForeignLocalFindings: true,
      repair: repairWithValidAnchor,
      request
    });
    expect(merged.kind).toBe("accepted");
    if (merged.kind !== "accepted") return;
    expect(merged.patchedPaths).toEqual([
      "/evidenceUnits/0/findings/0/requestAnchor"
    ]);
    expect(merged.output.evidenceUnits[0]!.findings).toEqual([{
      ...base.evidenceUnits[0]!.findings[0],
      requestAnchor: "ordering"
    }]);
    expect(JSON.stringify(merged.output)).not.toContain("State Atlas retention");
  });

  it("iterates over independently diagnosed paths without accepting repair drift", () => {
    const { base, evidence, repair, request } = fixture();
    const duplicated = {
      ...base,
      evidenceUnits: [base.evidenceUnits[0], {
        ...base.evidenceUnits[1],
        findings: [{
          ...base.evidenceUnits[1]!.findings[0],
          description: "State Atlas ordering."
        }]
      }]
    };
    const fixed = {
      ...repair,
      evidenceUnits: [repair.evidenceUnits[0], {
        ...repair.evidenceUnits[1],
        findings: [{
          ...repair.evidenceUnits[1]!.findings[0],
          description: "State Boreal durability."
        }]
      }]
    };
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(duplicated, {
      evidence,
      request
    });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected" || !validation.repairBase) return;
    const merged = mergeKnowledgeCoverageScopeVerifiedPatchesV1({
      base: validation.repairBase,
      diagnostic: validation.diagnostic,
      evidence,
      repair: fixed,
      request
    });
    expect(merged.kind).toBe("accepted");
    if (merged.kind !== "accepted") return;
    expect(merged.patchedPaths).toEqual([
      "/evidenceUnits/0/findings/1/evidenceAtomIds",
      "/evidenceUnits/1/findings/0/description"
    ]);
    expect(merged.output.evidenceUnits[1]!.findings[0]!.requestAnchor).toBe("durability");
  });

  it("persists only a repair-base hash and pins it in a content-free prompt", () => {
    const { base, evidence, manifest, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(base, {
      evidence,
      request
    });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected") return;
    const repairBaseHash = knowledgeCoverageScopeRepairBaseHashV1(
      validation.repairBase
    );
    expect(repairBaseHash).toBe(knowledgeAnswerHash(base));
    const failure = knowledgeCoverageScopeVerifiedPatchFailureV1(
      validation.reason,
      validation.diagnostic,
      repairBaseHash
    );
    expect(decodeKnowledgeCoverageScopeVerifiedPatchFailureV1(failure)).toEqual(failure);
    expect(JSON.stringify(failure)).not.toContain("State Atlas retention");
    expect(decodeKnowledgeCoverageScopeVerifiedPatchFailureV1({
      ...failure,
      reason: "open_rag_case_failed"
    })).toBeNull();
    const prompt = knowledgeCoverageScopePromptV6VerifiedPatchV1({
      evidence,
      evidenceManifest: manifest.message,
      repairBaseHash,
      repairDiagnostic: validation.diagnostic,
      repairReason: validation.reason,
      request,
      scopePass: "repair"
    });
    expect(prompt.userPrompt).toContain(repairBaseHash!);
    expect(prompt.userPrompt).not.toContain("State Atlas retention");
    expect(decodeKnowledgeCoverageScopePromptV6VerifiedPatchV1({
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({
      repairBaseHash,
      repairDiagnostic: validation.diagnostic,
      repairReason: validation.reason,
      scopePass: "repair"
    });
  });
});
