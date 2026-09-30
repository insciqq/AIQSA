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
      confidence: 1,
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
      sensitivityClass: "NORMAL" as const,
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
  it("admits bounded lower-certainty sources but retains the generalization confidence fence", () => {
    expect(memorySynthesisSourceAuthorityPredicate("user-1").sql)
      .toContain('"confidence" > 0.0');
    expect(memorySynthesisPatternAuthorityPredicate("user-1").sql)
      .toContain('source_version."confidence" = 1.0');
    expect(memorySynthesisPatternAuthorityPredicate("user-1").sql)
      .toContain('"confidence" <= source_version."confidence"');
  });

  it("keeps a stored PATTERN eligible only with three independent direct roots", () => {
    const sql = memorySynthesisPatternAuthorityPredicate("user-1").sql;
    expect(sql).toContain('WITH root_support AS');
    expect(sql).toContain('second."factId" <> first."factId"');
    expect(sql).toContain('third."messageId" <> second."messageId"');
    expect(sql).not.toContain("'explicit:'");
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

  it("combines two independent duplicates without granting them recurrence authority", () => {
    const input = plan();
    const refs = input.sources.slice(0, 2).map(({ ref }) => ref);
    const pattern = {
      claims: [], confidence_band: "HIGH", entity_refs: [],
      reason_code: "combined_overlapping_facts", source_refs: refs,
      statement: "The user uses a repeatable workflow."
    };
    expect(decodeMemorySynthesisOutput({ patterns: [pattern] }, input).patterns)
      .toHaveLength(1);
    expect(() => decodeMemorySynthesisOutput({ patterns: [{
      ...pattern, reason_code: "repeated_workflow_pattern"
    }] }, input)).toThrow(MemorySynthesisContractError);
  });

  it("requires independent high-confidence sources for a recurring generalization", () => {
    const input = plan();
    const weakened = { ...input, sources: input.sources.map((source) => ({ ...source, confidence: 0.6 })) };
    const refs = input.sources.slice(0, 3).map(({ ref }) => ref);
    expect(() => decodeMemorySynthesisOutput({ patterns: [{
      confidence_band: "HIGH", entity_refs: [], reason_code: "repeated_workflow_pattern",
      source_refs: refs, statement: "The user tends to use this workflow."
    }] }, weakened)).toThrow(MemorySynthesisContractError);
  });

  it("allows dated episode details from one message with exact per-claim support", () => {
    const input = plan();
    const episode = buildMemorySynthesisPlan({
      boundary: new Date("2026-08-01T00:00:00.000Z"),
      generation: 2,
      sources: input.sources.slice(0, 2).map((source, index) => ({
        ...source,
        confidence: 0.6,
        displayText: index === 0
          ? "On August 1 the user started a trip."
          : "The user returned on August 3.",
        modality: "EVENT",
        sourceChatIds: ["episode-chat"],
        sourceMessageIds: ["episode-message"]
      }))
    })!;
    const request = buildMemorySynthesisRequest(episode);
    const supplied = JSON.parse(request.userPrompt).clusters[0].sources;
    expect(supplied).toHaveLength(2);
    for (const source of supplied) {
      expect(source).toMatchObject({
        confidence: 0.6,
        modality: "EVENT",
        source_chat_refs: ["T1"],
        source_message_refs: ["M1"]
      });
    }
    expect(request.systemPrompt).toContain("Source confidence below 1 does not forbid a combination");
    const refs = episode.sources.slice(0, 2).map(({ ref }) => ref);
    const claims = [
      { source_refs: [refs[0]], statement: "On August 1 the user started a trip." },
      { source_refs: [refs[1]], statement: "The user returned on August 3." }
    ];
    const pattern = {
      claims, confidence_band: "HIGH", entity_refs: [], reason_code: "combined_episode_facts",
      source_refs: refs, statement: claims.map(({ statement }) => statement).join(" ")
    };
    expect(decodeMemorySynthesisOutput({ patterns: [pattern] }, episode).patterns[0]?.claims)
      .toHaveLength(2);
    for (const changed of [
      { ...pattern, claims: undefined },
      { ...pattern, statement: `${pattern.statement} This is a recurring habit.` },
      { ...pattern, claims: claims.slice(0, 1), statement: claims[0]!.statement },
      { ...pattern, claims: [{ ...claims[0], source_refs: ["S99"] }, claims[1]] },
      { ...pattern, reason_code: "combined_refined_facts" }
    ]) {
      expect(() => decodeMemorySynthesisOutput({ patterns: [changed] }, episode))
        .toThrow(MemorySynthesisContractError);
    }
    const unrelatedChats = {
      ...episode,
      sources: episode.sources.map((source, index) => ({ ...source, sourceChatIds: [`chat-${index}`] }))
    };
    expect(() => decodeMemorySynthesisOutput({ patterns: [pattern] }, unrelatedChats))
      .toThrow(MemorySynthesisContractError);
  });

  it("accepts compatible pairwise refinements only with complete clause support", () => {
    const input = plan();
    const refs = input.sources.slice(0, 2).map(({ ref }) => ref);
    const claims = [
      { source_refs: [refs[0]], statement: "The user owns a notebook." },
      { source_refs: [refs[1]], statement: "The notebook has a blue cover." }
    ];
    expect(decodeMemorySynthesisOutput({ patterns: [{
      claims, confidence_band: "HIGH", entity_refs: [], reason_code: "combined_refined_facts",
      source_refs: refs, statement: claims.map(({ statement }) => statement).join(" ")
    }] }, input).patterns).toHaveLength(1);
  });

  it("keeps disjoint proposals and deterministically drops overlapping proposals", () => {
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
        },
        {
          confidence_band: "HIGH",
          entity_refs: [entityRef],
          reason_code: "repeated_workflow_pattern",
          source_refs: refs.slice(1, 4),
          statement: "The user tends to prefer an overlapping workflow pattern."
        }
      ]
    }, input);

    expect(decoded.patterns).toHaveLength(2);
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
    expect(request.name).toBe("submit_memory_synthesis_patterns_v4");
    expect(request.systemPrompt).toContain("untrusted");
    expect(request.systemPrompt).toContain("combined_overlapping_facts");
    expect(request.systemPrompt).toContain("same narrow recurring preference");
    expect(request.systemPrompt).toContain("Every selected source must directly support the entire statement");
    expect(request.systemPrompt).toContain("combined_episode_facts");
    expect(request.systemPrompt).toContain("Do not summarize clutter");
    expect(request.systemPrompt).toContain("Do not join unrelated facts");
    expect(request.systemPrompt).toContain("A recurring generalization must not assert a hard current state");
    expect(request.systemPrompt).toContain("A combination may faithfully retain directly reported states and outcomes within their original scope and dates");
    expect(request.userPrompt.length).toBeLessThanOrEqual(64_000);
    expect(request.userPrompt).toContain("instruction_boundary");
    expect(request.userPrompt).toContain('"entity_refs":["E1"]');
    expect(request.userPrompt).not.toContain("entity-workflow");
  });
});
