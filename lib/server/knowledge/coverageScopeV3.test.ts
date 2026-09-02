import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { knowledgeSelectorEvidenceFromManifest } from "./answerGroundingV5";
import {
  decodeKnowledgeCoverageScopePromptV3,
  knowledgeCoverageScopePromptV3,
  validateKnowledgeCoverageScopeV3
} from "./coverageScopeV3";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: "The Atlas pipeline enforces a bounded queue. It preserves input ordering.",
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
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:scope-v3",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const request = "What guarantees of the Atlas pipeline follow from the result?";
  return {
    evidence: knowledgeSelectorEvidenceFromManifest(manifest),
    manifest,
    request,
    scope: {
      scope: [{
        description: "State that the Atlas pipeline enforces a bounded queue.",
        evidenceHandles: ["K1"],
        id: "D1",
        requestAnchor: "guarantees"
      }, {
        description: "State that the Atlas pipeline preserves input ordering.",
        evidenceHandles: ["K1"],
        id: "D2",
        requestAnchor: "guarantees"
      }],
      version: 3
    } as const
  };
}

describe("Knowledge Coverage Scope V3", () => {
  it("preserves co-equal conclusions from one evidence handle", () => {
    const { evidence, request, scope } = fixture();
    expect(validateKnowledgeCoverageScopeV3(scope, { evidence, request })).toEqual({
      kind: "accepted",
      value: scope
    });
  });

  it("builds a blind request/evidence-only prompt", () => {
    const { evidence, manifest, request } = fixture();
    const prompt = knowledgeCoverageScopePromptV3({
      evidence,
      evidenceManifest: manifest.message,
      request,
      scopePass: "initial"
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      "evidenceManifest",
      "repairReason",
      "request",
      "scopePass",
      "taskReminder",
      "version"
    ]);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("selectorState");
    expect(payload).not.toHaveProperty("supportedView");
    expect(payload).not.toHaveProperty("coverage");
    expect(decodeKnowledgeCoverageScopePromptV3({
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({ repairReason: null, scopePass: "initial" });
  });

  it("rejects non-request anchors, unknown handles, and reordered IDs", () => {
    const { evidence, request, scope } = fixture();
    expect(validateKnowledgeCoverageScopeV3({
      ...scope,
      scope: [{ ...scope.scope[0], requestAnchor: "not in the request" }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_anchor_invalid"
    });
    expect(validateKnowledgeCoverageScopeV3({
      ...scope,
      scope: [{ ...scope.scope[0], evidenceHandles: ["K2"] }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_evidence_invalid"
    });
    expect(validateKnowledgeCoverageScopeV3({
      ...scope,
      scope: [{ ...scope.scope[0], id: "D2" }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_order_invalid"
    });
  });
});
