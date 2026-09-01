import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1,
  decodeKnowledgeCoverageScopeCompletenessPromptV3,
  decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1,
  knowledgeCoverageScopeCompletenessPromptV3,
  knowledgeCoverageScopePromptV6AnswerGranularityV1
} from "./coverageScopeAnswerGranularityV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1,
  decodeKnowledgeCoverageScopeCompletenessPromptV4,
  decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2,
  knowledgeCoverageScopeCompletenessPromptV4,
  knowledgeCoverageScopePromptV6AnswerGranularityV2
} from "./coverageScopeAnswerGranularityV2";
import {
  KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS,
  knowledgeCoverageRequestAnchorIndexV1,
  resolveKnowledgeCoverageRequestAnchorIdsV1
} from "./coverageScopeRequestAnchorIdsV1";
import {
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
        "Retry limits improve reliability by preventing an overloaded dependency from receiving unbounded work.",
        "The operators believe a lower limit may also reduce recovery time, but they have not tested that expectation."
      ].join(" "),
      fileName: "retries.md",
      handle: "K1",
      locator: "section=Retries",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Retries",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }, {
      ambiguity: "none",
      evidenceId: "provider-call:result:2",
      exactExcerpt: "A staging example used three retries for one legacy endpoint.",
      fileName: "example.md",
      handle: "K2",
      locator: "section=Example",
      operationOrdinal: 1,
      resultOrdinal: 2,
      sourceAlias: "S2",
      sourceLabel: "Example",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    profileId: "fixture:scope-answer-granularity-v1",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
  const evidence = knowledgeCoverageEvidenceFromManifestV6(manifest);
  const request = "How do retry limits influence service reliability?";
  const validation = validateKnowledgeCoverageScopeV6({
    evidenceUnits: [{
      findings: [{
        description: "Explain how retry limits prevent overload and improve reliability.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "How"
      }],
      handle: "K1"
    }, { findings: [], handle: "K2" }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  }, { evidence, request });
  if (validation.kind !== "accepted") {
    throw new Error("scope_answer_granularity_fixture_invalid");
  }
  return { evidence, manifest, request, scope: validation.value };
}

describe("Knowledge Coverage Scope answer granularity", () => {
  it("keeps V29 Scope bytes and appends only the current granularity contract", () => {
    const input = fixture();
    const args = {
      atomIndexVersion: 2 as const,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      repairBaseHash: null,
      request: input.request,
      scopePass: "initial" as const
    };
    const historical = knowledgeCoverageScopePromptV6QueryIntentV1(args);
    const current = knowledgeCoverageScopePromptV6AnswerGranularityV1(args);
    expect(current.userPrompt).toBe(historical.userPrompt);
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n` +
      KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1
    );
    expect(current.systemPrompt).toContain("smallest non-overlapping set");
    expect(current.systemPrompt).toContain("belief, expectation, conjecture");
    expect(current.systemPrompt).toContain("Do not create one dimension per relevant");
    expect(decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1({
      atomIndexVersion: 2,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      ...current
    })).toMatchObject({ scopePass: "initial" });
  });

  it("keeps V29 completeness bytes and audits only requested granularity", () => {
    const input = fixture();
    const args = {
      acceptedScope: input.scope,
      atomIndexVersion: 2 as const,
      completenessPass: "initial" as const,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request
    };
    const historical = knowledgeCoverageScopeCompletenessPromptV2(args);
    const current = knowledgeCoverageScopeCompletenessPromptV3(args);
    expect(current.userPrompt).toBe(historical.userPrompt);
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n` +
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1
    );
    expect(current.systemPrompt).toContain("not merely another relevant fact");
    expect(current.systemPrompt).toContain("does not cover the faithful requirement");
    expect(decodeKnowledgeCoverageScopeCompletenessPromptV3({
      acceptedScope: input.scope,
      atomIndexVersion: 2,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      ...current
    })).toEqual({ completenessPass: "initial", repairReason: null });
  });

  it("keeps V30 Scope bytes and prefers answer-level summaries to inventories", () => {
    const input = fixture();
    const args = {
      atomIndexVersion: 2 as const,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      repairBaseHash: null,
      request: input.request,
      scopePass: "initial" as const
    };
    const historical = knowledgeCoverageScopePromptV6AnswerGranularityV1(args);
    const current = knowledgeCoverageScopePromptV6AnswerGranularityV2(args);
    const currentPayload = JSON.parse(current.userPrompt) as Record<string, unknown>;
    const { requestAnchorIndex, ...historicalPayload } = currentPayload;
    expect(historicalPayload).toEqual(JSON.parse(historical.userPrompt));
    expect(requestAnchorIndex).toEqual(knowledgeCoverageRequestAnchorIndexV1(
      input.request
    ));
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n` +
      KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 +
      `\n\n${KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1}`
    );
    expect(current.systemPrompt).toContain("lowest answer-level abstraction");
    expect(current.systemPrompt).toContain("unrequested inventory");
    expect(current.systemPrompt).toContain("Never author a compound finding");
    expect(current.systemPrompt).toContain("put exactly one supplied Q ID");
    expect(decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2({
      atomIndexVersion: 2,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      ...current
    })).toMatchObject({ scopePass: "initial" });
  });

  it("keeps V30 completeness bytes and does not turn detail into a quota", () => {
    const input = fixture();
    const args = {
      acceptedScope: input.scope,
      atomIndexVersion: 2 as const,
      completenessPass: "initial" as const,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request
    };
    const historical = knowledgeCoverageScopeCompletenessPromptV3(args);
    const current = knowledgeCoverageScopeCompletenessPromptV4(args);
    const currentPayload = JSON.parse(current.userPrompt) as Record<string, unknown>;
    const { requestAnchorIndex, ...historicalPayload } = currentPayload;
    expect(historicalPayload).toEqual(JSON.parse(historical.userPrompt));
    expect(requestAnchorIndex).toEqual(knowledgeCoverageRequestAnchorIndexV1(
      input.request
    ));
    expect(current.systemPrompt).toBe(
      `${historical.systemPrompt}\n\n` +
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 +
      `\n\n${KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1}`
    );
    expect(current.systemPrompt).toContain("source-stated summary proposition");
    expect(current.systemPrompt).toContain("exception catalogue");
    expect(decodeKnowledgeCoverageScopeCompletenessPromptV4({
      acceptedScope: input.scope,
      atomIndexVersion: 2,
      evidence: input.evidence,
      evidenceManifest: input.manifest.message,
      request: input.request,
      ...current
    })).toEqual({ completenessPass: "initial", repairReason: null });
  });

  it("resolves server-issued query IDs before unchanged V6 validation", () => {
    const input = fixture();
    const index = knowledgeCoverageRequestAnchorIndexV1(input.request);
    const retryId = index.items.find(({ text }) => text === "retry")?.id;
    expect(retryId).toBeTruthy();
    const resolved = resolveKnowledgeCoverageRequestAnchorIdsV1({
      evidenceUnits: [{
        findings: [{
          description: "Explain how retry limits improve reliability.",
          evidenceAtomIds: ["A1"],
          requestAnchor: retryId
        }],
        handle: "K1"
      }, { findings: [], handle: "K2" }],
      jointFindings: [],
      unsupportedDimensions: [],
      version: 6
    }, input.request);
    expect(validateKnowledgeCoverageScopeV6(resolved, {
      evidence: input.evidence,
      request: input.request
    }).kind).toBe("accepted");
  });

  it("bounds the query-ID ledger and leaves unknown IDs fail-closed", () => {
    const request = Array.from({ length: 200 }, (_, index) => `facet-${index + 1}`)
      .join(" ");
    const index = knowledgeCoverageRequestAnchorIndexV1(request);
    expect(index.items.length).toBeLessThanOrEqual(
      KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_INDEX_MAX_ITEMS
    );
    expect(index.items.every(({ id, text }) => /^Q[1-9]\d*$/u.test(id) &&
      request.includes(text))).toBe(true);
    expect(resolveKnowledgeCoverageRequestAnchorIdsV1(
      { requestAnchor: "Q999" },
      request
    )).toEqual({ requestAnchor: "Q999" });
  });
});
