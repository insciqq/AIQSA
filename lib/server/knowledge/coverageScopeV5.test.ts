import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import {
  decodeKnowledgeCoverageScopePromptV5,
  knowledgeCoverageEvidenceFromManifestV5,
  knowledgeCoverageEvidenceUnitIndexV1,
  knowledgeCoverageScopePromptV5,
  validateDecodedKnowledgeCoverageScopeV5,
  validateKnowledgeCoverageScopeV5
} from "./coverageScopeV5";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: [
        "The Atlas controller enforces a bounded queue.",
        "It also preserves input ordering.",
        "A neighboring theorem treats descent."
      ].join(" "),
      expandedContext: "Parent context records a proof convention.",
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
      exactExcerpt: "Background material only.",
      fileName: "background.md",
      handle: "K2",
      locator: "section=Background",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S2",
      sourceLabel: "Background",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:scope-v5",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV5(manifest);
  const request = "What guarantees of the Atlas controller follow from the result?";
  const output = {
    evidenceMap: [{
      answerAtomIds: [],
      handle: "K2"
    }, {
      answerAtomIds: ["A2", "A1"],
      handle: "K1"
    }],
    scope: [{
      description: "State that the Atlas controller enforces a bounded queue.",
      evidenceAtomIds: ["A1"],
      id: "D1",
      requestAnchor: "guarantees"
    }, {
      description: "State that the Atlas controller preserves input ordering.",
      evidenceAtomIds: ["A2"],
      id: "D2",
      requestAnchor: "guarantees"
    }],
    version: 5
  } as const;
  return { evidence, manifest, output, request };
}

describe("Knowledge Coverage Scope V5", () => {
  it("groups the exact atom ledger into bounded evidence units", () => {
    const { evidence } = fixture();
    expect(knowledgeCoverageEvidenceUnitIndexV1(evidence)).toEqual({
      units: [{
        atoms: [{
          id: "A1",
          text: "The Atlas controller enforces a bounded queue."
        }, {
          id: "A2",
          text: "It also preserves input ordering."
        }, {
          id: "A3",
          text: "A neighboring theorem treats descent."
        }, {
          id: "A4",
          text: "Parent context records a proof convention."
        }],
        handle: "K1"
      }, {
        atoms: [{ id: "A5", text: "Background material only." }],
        handle: "K2"
      }],
      version: 1
    });
  });

  it("accepts sparse positive maps and canonicalizes model ordering", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV5(output, { evidence, request });
    expect(validation).toEqual({
      kind: "accepted",
      value: {
        scope: [{
          ...output.scope[0],
          evidenceHandles: ["K1"]
        }, {
          ...output.scope[1],
          evidenceHandles: ["K1"]
        }],
        version: 5
      }
    });
    expect(validation.kind === "accepted" && validateDecodedKnowledgeCoverageScopeV5(
      validation.value,
      { evidence, request }
    )).toBe(true);
  });

  it("requires the exact unit key set and atom provenance", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV5({
      ...output,
      evidenceMap: [output.evidenceMap[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_map_invalid"
    });
    expect(validateKnowledgeCoverageScopeV5({
      ...output,
      evidenceMap: [{ answerAtomIds: [], handle: "K2" }, {
        answerAtomIds: ["A5"],
        handle: "K1"
      }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_map_invalid"
    });
    expect(validateKnowledgeCoverageScopeV5({
      ...output,
      evidenceMap: [{ answerAtomIds: [], handle: "K2" }, {
        answerAtomIds: ["A1", "A2", "A3"],
        handle: "K1"
      }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_mapping_invalid"
    });
  });

  it("rejects scope atoms not selected by the sparse map", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV5({
      ...output,
      scope: [{
        ...output.scope[0],
        evidenceAtomIds: ["A3"]
      }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_evidence_invalid"
    });
  });

  it("builds a blind grouped-unit prompt without the manifest or answer state", () => {
    const { evidence, manifest, request } = fixture();
    const prompt = knowledgeCoverageScopePromptV5({
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
    expect(payload.evidenceUnitIndex).toEqual(
      knowledgeCoverageEvidenceUnitIndexV1(evidence)
    );
    expect(payload).not.toHaveProperty("evidenceManifest");
    expect(prompt.userPrompt).not.toContain(manifest.message);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("selectorState");
    expect(payload).not.toHaveProperty("supportedView");
    expect(payload).not.toHaveProperty("coverage");
    expect(decodeKnowledgeCoverageScopePromptV5({
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({ repairReason: null, scopePass: "initial" });
  });
});
