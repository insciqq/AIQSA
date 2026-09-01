import { describe, expect, it } from "vitest";
import {
  knowledgeCoverageScopeCompletenessPromptV1,
  validateKnowledgeCoverageScopeCompletenessV1
} from "./coverageScopeCompletenessV1";
import {
  knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1
} from "./coverageScopeMultiDiagnosticRepairV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1,
  decodeKnowledgeCoverageScopeCompletenessPromptV2,
  decodeKnowledgeCoverageScopePromptV6QueryIntentV1,
  knowledgeCoverageScopeCompletenessPromptV2,
  knowledgeCoverageScopePromptV6QueryIntentV1
} from "./coverageScopeQueryIntentV1";
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
      exactExcerpt: [
        "The smaller queue is suitable for burst traffic because it limits lock contention.",
        "This trades peak throughput for predictable latency."
      ].join(" "),
      fileName: "queue.md",
      handle: "K1",
      locator: "section=Queue",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Queue",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:scope-query-intent-v1",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "Why is the smaller queue suitable for burst traffic?";
  const scope = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{
      findings: [{
        description: "State that the smaller queue is suitable for burst traffic.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "suitable"
      }],
      handle: "K1"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  }, { evidence, request });
  if (scope.kind !== "accepted") throw new Error("scope_query_intent_fixture_invalid");
  return { evidence, manifest, request, scope: scope.value };
}

describe("Knowledge Coverage Scope query-intent prompts", () => {
  it("preserves historical Scope bytes and appends only the current semantic contract", () => {
    const input = fixture();
    const args = {
      atomIndexVersion: 2 as const,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      repairBaseHash: null,
      request: input.request,
      scopePass: "initial" as const
    };
    const historical = knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1(args);
    const current = knowledgeCoverageScopePromptV6QueryIntentV1(args);

    expect(current.userPrompt).toBe(historical.userPrompt);
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n${KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1}`
    );
    expect(current.systemPrompt).toContain(
      "restating a premise, conclusion, recommendation, suitability judgment"
    );
    expect(current.systemPrompt).toContain("question form is a completeness boundary");
    expect(decodeKnowledgeCoverageScopePromptV6QueryIntentV1({
      atomIndexVersion: 2,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      ...current
    })).toMatchObject({ scopePass: "initial" });
  });

  it("makes the existing append-only audit detect an omitted requested connector", () => {
    const input = fixture();
    const args = {
      acceptedScope: input.scope,
      atomIndexVersion: 2 as const,
      completenessPass: "initial" as const,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request
    };
    const historical = knowledgeCoverageScopeCompletenessPromptV1(args);
    const current = knowledgeCoverageScopeCompletenessPromptV2(args);

    expect(current.userPrompt).toBe(historical.userPrompt);
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n` +
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1
    );
    expect(current.systemPrompt).toContain("append a distinct answer task");
    expect(current.systemPrompt).toContain("When none do, append the explicitly requested");
    expect(decodeKnowledgeCoverageScopeCompletenessPromptV2({
      acceptedScope: input.scope,
      atomIndexVersion: 2,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      ...current
    })).toEqual({ completenessPass: "initial", repairReason: null });
  });

  it("appends the explanatory task while preserving the accepted premise item", () => {
    const input = fixture();
    const validation = validateKnowledgeCoverageScopeCompletenessV1({
      additions: [{
        description: [
          "Explain the evidence-backed reason and trade-off that make the smaller queue",
          "suitable for burst traffic."
        ].join(" "),
        evidenceAtomIds: ["A1", "A2"],
        requestAnchor: "Why"
      }],
      version: 1
    }, {
      acceptedScope: input.scope,
      evidence: input.evidence,
      request: input.request
    });

    expect(validation).toMatchObject({
      additionCount: 1,
      kind: "accepted",
      scope: {
        scope: [{
          description: input.scope.scope[0]!.description,
          id: "D1"
        }, {
          evidenceAtomIds: ["A1", "A2"],
          evidenceHandles: ["K1"],
          id: "D2",
          requestAnchor: "Why"
        }]
      }
    });
  });
});
