import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { knowledgeCoverageEvidenceFromManifestV6 } from "./coverageScopeV6";
import {
  collectKnowledgeCoverageScopeRepairDiagnosticsV1,
  decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1,
  knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1
} from "./coverageScopeMultiDiagnosticRepairV1";
import {
  knowledgeCoverageScopeRepairBaseHashV1,
  knowledgeCoverageScopePromptV6VerifiedPatchV1,
  mergeKnowledgeCoverageScopeVerifiedPatchesV1,
  validateKnowledgeCoverageScopeV6VerifiedPatchV1
} from "./coverageScopeVerifiedPatchRepairV1";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "Atlas preserves input ordering.",
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
      exactExcerpt: "Boreal survives restarts.",
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
    profileId: "fixture:scope-multi-diagnostic-v1",
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
        requestAnchor: "anchor outside request one"
      }],
      handle: "K1"
    }, {
      findings: [{
        description: "State Boreal durability.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "anchor outside request two"
      }],
      handle: "K2"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  } as const;
  const repair = {
    ...base,
    evidenceUnits: [{
      ...base.evidenceUnits[0],
      findings: [{
        ...base.evidenceUnits[0]!.findings[0],
        requestAnchor: "ordering"
      }]
    }, {
      ...base.evidenceUnits[1],
      findings: [{
        ...base.evidenceUnits[1]!.findings[0],
        requestAnchor: "durability"
      }]
    }]
  } as const;
  return { base, evidence, manifest, repair, request };
}

describe("Knowledge Coverage Scope multi-diagnostic repair V1", () => {
  it("keeps the initial provider prompt byte-identical to verified patch V1", () => {
    const { evidence, manifest, request } = fixture();
    const input = {
      atomIndexVersion: 2 as const,
      evidence,
      evidenceManifest: manifest.message,
      repairBaseHash: null,
      request,
      scopePass: "initial" as const
    };
    const prompt = knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1(input);
    expect(prompt).toEqual(knowledgeCoverageScopePromptV6VerifiedPatchV1(input));
    expect(decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1({
      atomIndexVersion: 2,
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({
      repairBaseHash: null,
      repairDiagnostics: [],
      repairReason: null,
      scopePass: "initial"
    });
  });

  it("reports every stable invalid anchor and repairs both in one verified merge", () => {
    const { base, evidence, repair, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(base, {
      atomIndexVersion: 2,
      evidence,
      request
    });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected") return;
    const diagnostics = collectKnowledgeCoverageScopeRepairDiagnosticsV1({
      atomIndexVersion: 2,
      base: validation.repairBase,
      evidence,
      initialDiagnostic: validation.diagnostic,
      request
    });
    expect(diagnostics).toMatchObject([{ path:
      "/evidenceUnits/0/findings/0/requestAnchor" }, { path:
      "/evidenceUnits/1/findings/0/requestAnchor" }]);

    const merged = mergeKnowledgeCoverageScopeVerifiedPatchesV1({
      atomIndexVersion: 2,
      base: validation.repairBase!,
      diagnostic: validation.diagnostic,
      evidence,
      repair,
      request
    });
    expect(merged.kind).toBe("accepted");
    if (merged.kind !== "accepted") return;
    expect(merged.patchedPaths).toEqual(diagnostics.map(({ path }) => path));
    expect(merged.output.evidenceUnits.map(({ findings }) =>
      findings[0]!.description)).toEqual([
      "State Atlas ordering.",
      "State Boreal durability."
    ]);
  });

  it("round-trips content-free diagnostics without disclosing the rejected candidate", () => {
    const { base, evidence, manifest, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(base, {
      atomIndexVersion: 2,
      evidence,
      request
    });
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected") return;
    const diagnostics = collectKnowledgeCoverageScopeRepairDiagnosticsV1({
      atomIndexVersion: 2,
      base: validation.repairBase,
      evidence,
      initialDiagnostic: validation.diagnostic,
      request
    });
    const repairBaseHash = knowledgeCoverageScopeRepairBaseHashV1(
      validation.repairBase
    );
    const prompt = knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1({
      atomIndexVersion: 2,
      evidence,
      evidenceManifest: manifest.message,
      repairBaseHash,
      repairDiagnostics: diagnostics,
      repairReason: validation.reason,
      request,
      scopePass: "repair"
    });
    expect(prompt.userPrompt).not.toContain("anchor outside request one");
    expect(prompt.userPrompt).not.toContain("anchor outside request two");
    expect(decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1({
      atomIndexVersion: 2,
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({
      repairBaseHash,
      repairDiagnostics: diagnostics,
      repairReason: validation.reason,
      scopePass: "repair"
    });
  });

  it("falls back to the first diagnostic when container paths are unstable", () => {
    const { base, evidence, request } = fixture();
    const invalidUnitMap = {
      ...base,
      evidenceUnits: [{
        ...base.evidenceUnits[0]
      }, {
        ...base.evidenceUnits[1],
        handle: "K1"
      }]
    } as const;
    const validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(
      invalidUnitMap,
      { atomIndexVersion: 2, evidence, request }
    );
    expect(validation.kind).toBe("rejected");
    if (validation.kind !== "rejected") return;
    expect(collectKnowledgeCoverageScopeRepairDiagnosticsV1({
      atomIndexVersion: 2,
      base: validation.repairBase,
      evidence,
      initialDiagnostic: validation.diagnostic,
      request
    })).toEqual([validation.diagnostic]);
  });
});
