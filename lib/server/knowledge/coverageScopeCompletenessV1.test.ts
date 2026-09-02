import { describe, expect, it } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import {
  decodeKnowledgeCoverageScopeCompletenessPromptV1,
  knowledgeCoverageScopeCompletenessPromptV1,
  validateDecodedKnowledgeCoverageScopeCompletenessUnionV1,
  validateKnowledgeCoverageScopeCompletenessV1
} from "./coverageScopeCompletenessV1";
import {
  knowledgeCoverageEvidenceFromManifestV6,
  validateKnowledgeCoverageScopeV6,
  type KnowledgeCoverageScopeV6
} from "./coverageScopeV6";

function fixture() {
  const manifest = packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "provider-call:result:1",
      exactExcerpt: [
        "Atlas preserves input ordering.",
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
        "Boreal preserves entries across restarts.",
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
    profileId: "fixture:scope-completeness-v1",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Why can Boreal be durable while ordering differs, and who owns retention?";
  const initial = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{ findings: [], handle: "K1" }, {
      findings: [{
        description: "State Boreal's durability guarantee.",
        evidenceAtomIds: ["A3"],
        requestAnchor: "durable"
      }],
      handle: "K2"
    }],
    jointFindings: [],
    unsupportedDimensions: [{
      description: "Identify who owns retention.",
      requestAnchor: "who owns retention"
    }],
    version: 6
  }, { evidence, request });
  if (initial.kind !== "accepted") throw new Error("fixture_scope_invalid");
  return {
    acceptedScope: initial.value as KnowledgeCoverageScopeV6,
    evidence,
    manifest,
    request
  };
}

describe("Knowledge Coverage Scope Completeness V1", () => {
  it("appends a cross-unit relation without changing accepted IDs or order", () => {
    const input = fixture();
    const validation = validateKnowledgeCoverageScopeCompletenessV1({
      additions: [{
        description: "Explain the durability-versus-ordering distinction.",
        evidenceAtomIds: ["A4", "A1", "A3"],
        requestAnchor: "Why"
      }],
      version: 1
    }, input);
    expect(validation).toEqual({
      additionCount: 1,
      kind: "accepted",
      scope: {
        scope: [{
          description: "State Boreal's durability guarantee.",
          evidenceAtomIds: ["A3"],
          evidenceHandles: ["K2"],
          id: "D1",
          requestAnchor: "durable"
        }, {
          description: "Identify who owns retention.",
          evidenceAtomIds: [],
          evidenceHandles: [],
          id: "D2",
          requestAnchor: "who owns retention"
        }, {
          description: "Explain the durability-versus-ordering distinction.",
          evidenceAtomIds: ["A1", "A3", "A4"],
          evidenceHandles: ["K1", "K2"],
          id: "D3",
          requestAnchor: "Why"
        }],
        version: 6
      }
    });
    expect(validation.kind === "accepted" &&
      validateDecodedKnowledgeCoverageScopeCompletenessUnionV1(validation.scope, {
        evidence: input.evidence,
        request: input.request
      })).toBe(true);
  });

  it("accepts an empty append-only delta without changing Scope", () => {
    const input = fixture();
    expect(validateKnowledgeCoverageScopeCompletenessV1({
      additions: [],
      version: 1
    }, input)).toEqual({
      additionCount: 0,
      kind: "accepted",
      scope: input.acceptedScope
    });
  });

  it("rejects duplicate, unknown-atom, and over-capacity additions", () => {
    const input = fixture();
    expect(validateKnowledgeCoverageScopeCompletenessV1({
      additions: [{
        description: input.acceptedScope.scope[0]!.description,
        evidenceAtomIds: ["A1"],
        requestAnchor: "Why"
      }],
      version: 1
    }, input)).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_completeness_addition_invalid"
    });
    expect(validateKnowledgeCoverageScopeCompletenessV1({
      additions: [{
        description: "Add an unknown fact.",
        evidenceAtomIds: ["A999"],
        requestAnchor: "Why"
      }],
      version: 1
    }, input)).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_completeness_addition_invalid"
    });
    expect(validateKnowledgeCoverageScopeCompletenessV1({
      additions: Array.from({ length: 7 }, (_, index) => ({
        description: `Extra omitted requirement ${index + 1}.`,
        evidenceAtomIds: [],
        requestAnchor: "Why"
      })),
      version: 1
    }, input)).toMatchObject({
      kind: "rejected",
      reason: "coverage_scope_completeness_capacity_exceeded"
    });
  });

  it("builds a Draft-blind full-ledger prompt and decodes its immutable pins", () => {
    const input = fixture();
    const prompt = knowledgeCoverageScopeCompletenessPromptV1({
      acceptedScope: input.acceptedScope,
      completenessPass: "initial",
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request
    });
    const payload = JSON.parse(prompt.userPrompt) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      "acceptedScope",
      "acceptedScopePayloadHash",
      "completenessPass",
      "evidenceContext",
      "evidenceManifestHash",
      "evidenceUnitIndex",
      "remainingCapacity",
      "repairReason",
      "request",
      "taskReminder",
      "version"
    ]);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("selector");
    expect(payload).not.toHaveProperty("coverage");
    expect(prompt.userPrompt).not.toContain(input.manifest.message);
    expect(decodeKnowledgeCoverageScopeCompletenessPromptV1({
      acceptedScope: input.acceptedScope,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt
    })).toEqual({ completenessPass: "initial", repairReason: null });
  });
});
