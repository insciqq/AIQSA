import { describe, expect, it } from "vitest";
import {
  buildMemorySynthesisRequest,
  decodeMemorySynthesisOutput,
  MemorySynthesisContractError
} from "./contract";
import {
  buildMemorySynthesisPlan,
  memorySynthesisSourceEligibilityHash,
  type MemorySynthesisPlan,
  type MemorySynthesisSource
} from "./policy";
import {
  memorySynthesisPatternAuthorityPredicate,
  memorySynthesisSourceAuthorityPredicate
} from "./eligibility";

function plan(): MemorySynthesisPlan {
  const boundary = new Date("2026-08-01T00:00:00.000Z");
  const sources = Array.from({ length: 20 }, (_, index) => {
    const base = {
      canonicalKey: `workflow:${index}`,
      category: "workflow",
      directness: "DIRECT" as const,
      displayText: `I repeat workflow step ${index}.`,
      entityIds: ["entity-workflow"],
      factId: `fact-${index}`,
      ingestionFingerprint: index.toString(16).padStart(64, "0"),
      memoryGeneration: 2,
      modality: "WORKFLOW" as const,
      observedAt: new Date(boundary.getTime() + index * 60_000),
      pipelineVersion: "memory-fact-extraction-vnext-v2",
      predicateKey: "workflow",
      sourceChatIds: [`chat-${index % 3}`],
      sourceMessageIds: [`message-${index}`],
      sourceMode: "AUTOMATIC" as const,
      structuredValue: { index },
      subjectKey: "user",
      versionId: `version-${index}`
    };
    return {
      ...base,
      eligibilityHash: memorySynthesisSourceEligibilityHash(base)
    } satisfies MemorySynthesisSource;
  });
  return buildMemorySynthesisPlan({ boundary, generation: 2, sources })!;
}

describe("Dream synthesis strict contract", () => {
  it("excludes lower-authority supporting observations from synthesis sources", () => {
    expect(memorySynthesisSourceAuthorityPredicate("user-1").sql)
      .toContain('"confidence" = 1.0');
  });

  it("keeps a stored PATTERN eligible only with three independent direct roots", () => {
    const sql = memorySynthesisPatternAuthorityPredicate("user-1").sql;
    expect(sql).toContain('COUNT(DISTINCT source_root."rootKey")');
    expect(sql).toContain("'explicit:' || root_source_version.\"id\"");
    expect(sql).toContain("'message:' || support.\"messageId\"");
    expect(sql).toContain('support."sourceRole" = \'user\'');
  });

  it("accepts only one-cluster, three-distinct-source depth-one proposals", () => {
    const input = plan();
    const refs = input.clusters[0]!.sources.slice(0, 3).map(({ ref }) => ref);
    const entityRef = input.clusters[0]!.entityRefs[0]!;
    expect(decodeMemorySynthesisOutput({
      patterns: [{
        confidence_band: "HIGH",
        entity_refs: [entityRef],
        reason_code: "repeated_workflow_pattern",
        source_refs: refs,
        statement: "I tend to use a repeatable workflow for this kind of work."
      }]
    }, input)).toMatchObject({
      patterns: [{
        confidenceBand: "HIGH",
        reasonCode: "repeated_workflow_pattern",
        sourceRefs: refs
      }]
    });
  });

  it("rejects three source refs that collapse to one direct evidence root", () => {
    const input = plan();
    const clustered = input.clusters[0]!.sources.slice(0, 3);
    const collapsedSources = input.sources.map((source) =>
      clustered.some(({ ref }) => ref === source.ref)
        ? { ...source, sourceMessageIds: ["one-message-root"] }
        : source);
    const collapsedPlan = { ...input, sources: collapsedSources };

    expect(() => decodeMemorySynthesisOutput({
      patterns: [{
        confidence_band: "HIGH",
        entity_refs: [],
        reason_code: "repeated_workflow_pattern",
        source_refs: clustered.map(({ ref }) => ref),
        statement: "The user tends to follow this workflow."
      }]
    }, collapsedPlan)).toThrow(MemorySynthesisContractError);
  });

  it("collapses redundant valid proposals for one durable cluster and reason identity", () => {
    const input = plan();
    const refs = input.clusters[0]!.sources.slice(0, 6).map(({ ref }) => ref);
    const entityRef = input.clusters[0]!.entityRefs[0]!;
    const decoded = decodeMemorySynthesisOutput({
      patterns: [
        {
          confidence_band: "HIGH",
          entity_refs: [entityRef],
          reason_code: "repeated_workflow_pattern",
          source_refs: refs.slice(0, 3),
          statement: "The user tends to prefer one recurring workflow pattern."
        },
        {
          confidence_band: "HIGH",
          entity_refs: [entityRef],
          reason_code: "repeated_workflow_pattern",
          source_refs: refs.slice(3, 6),
          statement: "The user tends to prefer another wording of that workflow pattern."
        }
      ]
    }, input);

    expect(decoded.patterns).toHaveLength(1);
    expect(decoded.patterns[0]?.statement)
      .toBe("The user tends to prefer one recurring workflow pattern.");
  });

  it.each([
    [{ patterns: [{ confidence_band: "HIGH", entity_refs: [], reason_code: "repeated_workflow_pattern", source_refs: ["S1", "S2"], statement: "Too little support" }] }],
    [{ patterns: [{ confidence_band: "HIGH", entity_refs: [], reason_code: "repeated_workflow_pattern", source_refs: ["S1", "S2", "S3"], statement: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456" }] }],
    [{ patterns: [{ confidence_band: "LOW", entity_refs: [], reason_code: "repeated_workflow_pattern", source_refs: ["S1", "S2", "S3"], statement: "Weak claim" }] }],
    [{ patterns: [{ confidence_band: "HIGH", entity_refs: [], extra: true, reason_code: "repeated_workflow_pattern", source_refs: ["S1", "S2", "S3"], statement: "Extra key" }] }]
  ])("rejects malformed, weak, secret, or expanded output %#", (value) => {
    expect(() => decodeMemorySynthesisOutput(value, plan()))
      .toThrow(MemorySynthesisContractError);
  });

  it("[E06] builds a bounded ref-only prompt with untrusted source labels", () => {
    const request = buildMemorySynthesisRequest(plan());
    expect(request.name).toBe("submit_memory_synthesis_patterns_v2");
    expect(request.systemPrompt).toContain("untrusted");
    expect(request.systemPrompt).toContain("cluster_ref and reason_code pair");
    expect(request.systemPrompt).toContain("same narrow recurring predicate");
    expect(request.systemPrompt).toContain("future-useful predictive value");
    expect(request.systemPrompt).toContain("otherwise unrelated facts");
    expect(request.userPrompt.length).toBeLessThanOrEqual(64_000);
    expect(request.userPrompt).toContain("instruction_boundary");
    expect(request.userPrompt).toContain('"entity_refs":["E1"]');
    expect(request.userPrompt).not.toContain("entity-workflow");
  });
});
