import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import {
  KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS,
  decodeKnowledgeCoverageScopePromptV6,
  knowledgeCoverageEvidenceFromManifestV6,
  knowledgeCoverageScopePromptV6,
  validateDecodedKnowledgeCoverageScopeV6,
  validateKnowledgeCoverageScopeV6
} from "./coverageScopeV6";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: [
        "The Atlas controller preserves input ordering.",
        "Its queue expires after one hour."
      ].join(" "),
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
      exactExcerpt: [
        "The Boreal controller preserves entries across restarts.",
        "Unlike Atlas, Boreal does not guarantee input ordering."
      ].join(" "),
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
    profileId: "fixture:scope-v6",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Compare ordering and durability, and state the retention owner.";
  const output = {
    evidenceUnits: [{
      findings: [{
        description: "State Boreal's durability guarantee.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "durability"
      }],
      handle: "K2"
    }, {
      findings: [{
        description: "State Atlas's ordering guarantee.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "ordering"
      }],
      handle: "K1"
    }],
    jointFindings: [{
      description: "Compare Atlas and Boreal ordering behavior.",
      evidenceAtomIds: ["A4", "A1"],
      requestAnchor: "Compare"
    }],
    unsupportedDimensions: [{
      description: "Identify who owns retention.",
      requestAnchor: "retention owner"
    }],
    version: 6
  } as const;
  return { evidence, manifest, output, request };
}

describe("Knowledge Coverage Scope V6", () => {
  it("materializes every positive finding as a final request-ordered dimension", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6(output, { evidence, request });
    expect(validation).toEqual({
      kind: "accepted",
      value: {
        scope: [{
          description: "Compare Atlas and Boreal ordering behavior.",
          evidenceAtomIds: ["A1", "A4"],
          evidenceHandles: ["K1", "K2"],
          id: "D1",
          requestAnchor: "Compare"
        }, {
          description: "State Atlas's ordering guarantee.",
          evidenceAtomIds: ["A1"],
          evidenceHandles: ["K1"],
          id: "D2",
          requestAnchor: "ordering"
        }, {
          description: "State Boreal's durability guarantee.",
          evidenceAtomIds: ["A3"],
          evidenceHandles: ["K2"],
          id: "D3",
          requestAnchor: "durability"
        }, {
          description: "Identify who owns retention.",
          evidenceAtomIds: [],
          evidenceHandles: [],
          id: "D4",
          requestAnchor: "retention owner"
        }],
        version: 6
      }
    });
    expect(validation.kind === "accepted" && validateDecodedKnowledgeCoverageScopeV6(
      validation.value,
      { evidence, request }
    )).toBe(true);
  });

  it("canonicalizes provider array order by request position and atom provenance", () => {
    const { evidence, output, request } = fixture();
    const k1 = {
      findings: [output.evidenceUnits[1]!.findings[0]!, {
        description: "State the Atlas queue-expiry qualifier.",
        evidenceAtomIds: ["A2"],
        requestAnchor: "ordering"
      }],
      handle: "K1"
    } as const;
    const left = validateKnowledgeCoverageScopeV6({
      ...output,
      evidenceUnits: [k1, output.evidenceUnits[0]],
      jointFindings: [{
        ...output.jointFindings[0],
        evidenceAtomIds: ["A1", "A4"]
      }]
    }, { evidence, request });
    const right = validateKnowledgeCoverageScopeV6({
      ...output,
      evidenceUnits: [output.evidenceUnits[0], {
        ...k1,
        findings: [...k1.findings].reverse()
      }],
      jointFindings: [{
        ...output.jointFindings[0],
        evidenceAtomIds: ["A4", "A1"]
      }]
    }, { evidence, request });
    expect(left.kind).toBe("accepted");
    expect(right).toEqual(left);
  });

  it("requires exactly one record for every evidence-unit key", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV6({
      ...output,
      evidenceUnits: [output.evidenceUnits[0]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_unit_map_invalid"
    });
    expect(validateKnowledgeCoverageScopeV6({
      ...output,
      evidenceUnits: [output.evidenceUnits[0], output.evidenceUnits[0]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_unit_map_invalid"
    });
  });

  it("keeps local findings local and joint findings cross-unit", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV6({
      ...output,
      evidenceUnits: [{
        findings: [{
          ...output.evidenceUnits[1].findings[0],
          evidenceAtomIds: ["A3"]
        }],
        handle: "K1"
      }, output.evidenceUnits[0]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_finding_invalid"
    });
    expect(validateKnowledgeCoverageScopeV6({
      ...output,
      jointFindings: [{
        ...output.jointFindings[0],
        evidenceAtomIds: ["A1", "A2"]
      }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_joint_invalid"
    });
  });

  it("rejects duplicate descriptions and more than eight total dimensions", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV6({
      ...output,
      unsupportedDimensions: [{
        description: output.evidenceUnits[0].findings[0].description,
        requestAnchor: "retention owner"
      }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_description_duplicate"
    });
    expect(validateKnowledgeCoverageScopeV6({
      ...output,
      unsupportedDimensions: Array.from({ length: 6 }, (_, index) => ({
        description: `Unsupported retention facet ${index + 1}.`,
        requestAnchor: "retention"
      }))
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_shape_invalid"
    });
  });

  it("rejects decoded scopes whose request-anchor order was changed", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6(output, { evidence, request });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    const [first, second, ...rest] = validation.value.scope;
    expect(validateDecodedKnowledgeCoverageScopeV6({
      ...validation.value,
      scope: [
        { ...second, id: "D1" },
        { ...first, id: "D2" },
        ...rest
      ]
    }, { evidence, request })).toBe(false);
  });

  it("rejects decoded scopes when the evidence-unit bound is exceeded", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV6(output, { evidence, request });
    expect(validation.kind).toBe("accepted");
    if (validation.kind !== "accepted") return;
    const overBoundEvidence = [
      ...evidence,
      ...Array.from({
        length: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceItems - evidence.length + 1
      }, (_, index) => ({
        ...evidence[0]!,
        exactExcerpt: `Extra bounded evidence unit ${index + 1}.`,
        handle: `K${evidence.length + index + 1}`
      }))
    ];
    expect(validateDecodedKnowledgeCoverageScopeV6(validation.value, {
      evidence: overBoundEvidence,
      request
    })).toBe(false);
  });

  it("builds a blind grouped-unit prompt without manifest or answer state", () => {
    const { evidence, manifest, request } = fixture();
    const prompt = knowledgeCoverageScopePromptV6({
      evidence,
      evidenceManifest: manifest.message,
      request,
      scopePass: "initial"
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      "evidenceContext",
      "evidenceManifestHash",
      "evidenceUnitIndex",
      "repairReason",
      "request",
      "scopePass",
      "taskReminder",
      "version"
    ]);
    expect(payload).not.toHaveProperty("evidenceManifest");
    expect(prompt.userPrompt).not.toContain(manifest.message);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("selectorState");
    expect(payload).not.toHaveProperty("supportedView");
    expect(payload).not.toHaveProperty("coverage");
    expect(decodeKnowledgeCoverageScopePromptV6({
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({ repairReason: null, scopePass: "initial" });
  });
});
