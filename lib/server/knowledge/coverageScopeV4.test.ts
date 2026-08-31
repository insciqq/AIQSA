import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import {
  decodeKnowledgeCoverageScopePromptV4,
  knowledgeCoverageEvidenceAtomIndexV1,
  knowledgeCoverageEvidenceAtomIndexV2,
  knowledgeCoverageEvidenceFromManifestV4,
  knowledgeCoverageScopePromptV4,
  validateDecodedKnowledgeCoverageScopeV4,
  validateKnowledgeCoverageScopeV4
} from "./coverageScopeV4";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: [
        "The Atlas pipeline enforces a bounded queue.",
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
    profileId: "fixture:scope-v4",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV4(manifest);
  const request = "What guarantees of the Atlas pipeline follow from the result?";
  const output = {
    evidenceReview: [{
      answerAtomIds: ["A1", "A2"],
      handle: "K1",
      otherAtomIds: ["A3", "A4"]
    }, {
      answerAtomIds: [],
      handle: "K2",
      otherAtomIds: ["A5"]
    }],
    scope: [{
      description: "State that the Atlas pipeline enforces a bounded queue.",
      evidenceAtomIds: ["A1"],
      id: "D1",
      requestAnchor: "guarantees"
    }, {
      description: "State that the Atlas pipeline preserves input ordering.",
      evidenceAtomIds: ["A2"],
      id: "D2",
      requestAnchor: "guarantees"
    }],
    version: 4
  } as const;
  return { evidence, manifest, output, request };
}

describe("Knowledge Coverage Scope V4", () => {
  it("builds deterministic bounded atoms with canonical provenance", () => {
    const { evidence } = fixture();
    expect(knowledgeCoverageEvidenceAtomIndexV1(evidence)).toEqual({
      items: [{
        handle: "K1",
        id: "A1",
        text: "The Atlas pipeline enforces a bounded queue."
      }, {
        handle: "K1",
        id: "A2",
        text: "It also preserves input ordering."
      }, {
        handle: "K1",
        id: "A3",
        text: "A neighboring theorem treats descent."
      }, {
        handle: "K1",
        id: "A4",
        text: "Parent context records a proof convention."
      }, {
        handle: "K2",
        id: "A5",
        text: "Background material only."
      }],
      version: 1
    });
  });

  it("restores trusted parent context around the focal excerpt in source order", () => {
    const previous = "The am-AMM is governed by an auction-managed lease.";
    const next = "The withdrawal cost accrues to the current manager.";
    const expandedContext = [
      `Previous same-Source context:\n${previous}`,
      `Next same-Source context:\n${next}`
    ].join("\n\n");
    const previousStart = expandedContext.indexOf(previous);
    const nextStart = expandedContext.indexOf(next);
    const manifest = packKnowledgeEvidenceDispatchManifest({
      candidates: [{
        ambiguity: "none",
        evidenceId: "provider-call:result:ordered",
        exactExcerpt: "Liquidity providers can enter and exit the pool freely.",
        expandedContext,
        expandedContextOrder: {
          offsetEncoding: "utf16_code_units",
          segments: [{
            end: previousStart + previous.length,
            position: "previous",
            sourceOrdinal: 10,
            start: previousStart
          }, {
            end: nextStart + next.length,
            position: "next",
            sourceOrdinal: 12,
            start: nextStart
          }],
          version: 1
        },
        fileName: "amm.md",
        handle: "K1",
        locator: "section=am-AMM",
        operationOrdinal: 1,
        resultOrdinal: 1,
        sourceAlias: "S1",
        sourceLabel: "AMM",
        sourceTruncated: false,
        sourceVersionNumber: 1,
        state: "available"
      }],
      coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
      footer: "</private_knowledge_evidence>",
      header: '<private_knowledge_evidence version="4">',
      maximumBytes: 16_384,
      maximumTokens: 4_096,
      profileId: "fixture:source-order",
      promptFragmentVersion: 1,
      runtimeVersion: 1
    });

    const atomIndex = knowledgeCoverageEvidenceAtomIndexV2(
      knowledgeCoverageEvidenceFromManifestV4(manifest)
    );

    expect(atomIndex).toEqual({
      items: [{
        contextRole: "previous_context",
        handle: "K1",
        id: "A1",
        text: previous
      }, {
        contextRole: "exact_excerpt",
        handle: "K1",
        id: "A2",
        text: "Liquidity providers can enter and exit the pool freely."
      }, {
        contextRole: "next_context",
        handle: "K1",
        id: "A3",
        text: next
      }],
      version: 2
    });
    expect(atomIndex.items.map(({ text }) => text).join(" "))
      .not.toContain("same-Source context");
  });

  it("accepts an exhaustive review and derives handles from answer atoms", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV4(output, { evidence, request });
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
        version: 4
      }
    });
    expect(validation.kind === "accepted" && validateDecodedKnowledgeCoverageScopeV4(
      validation.value,
      { evidence, request }
    )).toBe(true);
  });

  it("fails closed when a decoded scope is checked against invalid evidence", () => {
    const { evidence, output, request } = fixture();
    const validation = validateKnowledgeCoverageScopeV4(output, { evidence, request });
    if (validation.kind !== "accepted") throw new Error("fixture_scope_invalid");
    expect(validateDecodedKnowledgeCoverageScopeV4(validation.value, {
      evidence: [{ ...evidence[0]!, exactExcerpt: "" }],
      request
    })).toBe(false);
    expect(validateDecodedKnowledgeCoverageScopeV4({
      ...validation.value,
      scope: [{
        ...validation.value.scope[0],
        evidenceHandles: ["K1", "K2", "K3", "K4", "K5"]
      }]
    }, { evidence, request })).toBe(false);
  });

  it("rejects a lost atom, a false partition, and an unmapped answer atom", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      evidenceReview: [{
        ...output.evidenceReview[0],
        otherAtomIds: []
      }, output.evidenceReview[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_review_invalid"
    });
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      evidenceReview: [{
        ...output.evidenceReview[0],
        answerAtomIds: ["A1", "A2", "A3"]
      }, output.evidenceReview[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_review_invalid"
    });
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      scope: [{
        ...output.scope[0],
        evidenceAtomIds: ["A3"]
      }, output.scope[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_evidence_invalid"
    });
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      evidenceReview: [{
        ...output.evidenceReview[0],
        answerAtomIds: ["A1", "A2", "A3"],
        otherAtomIds: ["A4"]
      }, output.evidenceReview[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_review_invalid"
    });
  });

  it("rejects handle/order fabrication and non-request anchors", () => {
    const { evidence, output, request } = fixture();
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      evidenceReview: [{
        ...output.evidenceReview[0],
        handle: "K2"
      }, output.evidenceReview[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_review_invalid"
    });
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      evidenceReview: [{
        ...output.evidenceReview[0],
        answerAtomIds: ["A2", "A1"]
      }, output.evidenceReview[1]]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_atom_review_invalid"
    });
    expect(validateKnowledgeCoverageScopeV4({
      ...output,
      scope: [{
        ...output.scope[0],
        requestAnchor: "not in request"
      }]
    }, { evidence, request })).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_anchor_invalid"
    });
  });

  it("builds a blind prompt with an exact server-authored atom ledger", () => {
    const { evidence, manifest, request } = fixture();
    const prompt = knowledgeCoverageScopePromptV4({
      evidence,
      evidenceManifest: manifest.message,
      request,
      scopePass: "initial"
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      "evidenceAtomIndex",
      "evidenceContext",
      "evidenceManifestHash",
      "repairReason",
      "request",
      "scopePass",
      "taskReminder",
      "version"
    ]);
    expect(payload.evidenceAtomIndex).toEqual(knowledgeCoverageEvidenceAtomIndexV1(evidence));
    expect(payload).not.toHaveProperty("evidenceManifest");
    expect(prompt.userPrompt).not.toContain(manifest.message);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("selectorState");
    expect(payload).not.toHaveProperty("supportedView");
    expect(payload).not.toHaveProperty("coverage");
    expect(decodeKnowledgeCoverageScopePromptV4({
      evidence,
      evidenceManifest: manifest.message,
      request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({ repairReason: null, scopePass: "initial" });
  });
});
