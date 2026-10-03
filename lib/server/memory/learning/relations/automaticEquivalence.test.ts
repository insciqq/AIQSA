import { describe, expect, it } from "vitest";
import {
  memoryExplicitRelationCandidateModes,
  selectMemoryExplicitRelationCandidateIds
} from "./explicitCandidates";
import {
  assertMemoryExplicitRelationSnapshot,
  MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION,
  memoryEquivalenceTextKey,
  selectMemoryExplicitRelationMerge,
  type MemoryExplicitRelationDecision,
  type MemoryExplicitRelationFact,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";
import {
  buildMemoryExplicitRelationRequest,
  decodeMemoryExplicitRelationDecisions,
  memoryExplicitRelationInputHash
} from "./explicitResolver";
import { selectMemoryExplicitEquivalenceSweepTargets } from "./explicitSweep";

function fact(
  id: string,
  sourceMode: MemoryExplicitRelationFact["sourceMode"],
  minute: number,
  extra: Partial<MemoryExplicitRelationFact> = {}
): MemoryExplicitRelationFact {
  const at = new Date(Date.UTC(2026, 8, 15, 7, minute)).toISOString();
  return {
    createdAt: at, evidenceHash: "a".repeat(64), expectedAt: null, expiresAt: null,
    factId: `private-fact-${id}`, modality: "STATE", observedAt: at, occurredAt: null,
    pinned: false, scopeId: "private-scope", sourceMode, statement: "My name is Ada.",
    systemFrom: at, validFrom: null, validTo: null, versionId: `private-version-${id}`, ...extra
  };
}

function snapshot(
  source: MemoryExplicitRelationFact,
  candidates: readonly MemoryExplicitRelationFact[]
): MemoryExplicitRelationSnapshot {
  return {
    candidates, memoryGeneration: 2, pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
    source, userId: "private-owner"
  };
}

function decisions(
  input: MemoryExplicitRelationSnapshot,
  relation: MemoryExplicitRelationDecision["relation"] = "EQUIVALENT",
  confidenceBand: MemoryExplicitRelationDecision["confidenceBand"] = "HIGH"
): readonly MemoryExplicitRelationDecision[] {
  return decodeMemoryExplicitRelationDecisions({
    decisions: input.candidates.map((_, index) => ({
      confidence_band: confidenceBand, relation, target_ref: `R${index + 1}`
    }))
  }, input);
}

describe("automatic and explicit equivalence policy", () => {
  it("keeps the explicit save as the survivor whatever the age of the automatic fact", () => {
    const learned = fact("learned", "AUTOMATIC", 0, { statement: "My name is ada." });
    const saved = fact("saved", "EXPLICIT", 30);
    const input = snapshot(saved, [learned]);
    expect(selectMemoryExplicitRelationMerge(input, decisions(input))).toEqual({
      canonical: saved, redundant: [learned]
    });
    const reversed = snapshot(learned, [saved]);
    expect(selectMemoryExplicitRelationMerge(reversed, decisions(reversed))).toEqual({
      canonical: saved, redundant: [learned]
    });
  });

  it("merges an automatic fact into the oldest equivalent save without merging explicit saves", () => {
    const learned = fact("learned", "AUTOMATIC", 40);
    const older = fact("older", "EXPLICIT", 10);
    const newer = fact("newer", "EXPLICIT", 20);
    const input = snapshot(learned, [newer, older]);
    expect(selectMemoryExplicitRelationMerge(input, decisions(input))).toEqual({
      canonical: older, redundant: [learned]
    });
  });

  it("keeps the homogeneous explicit rule beside an equivalent automatic fact", () => {
    const saved = fact("saved", "EXPLICIT", 30);
    const older = fact("older", "EXPLICIT", 10);
    const learned = fact("learned", "AUTOMATIC", 0);
    const input = snapshot(saved, [learned, older]);
    expect(selectMemoryExplicitRelationMerge(input, decisions(input))).toEqual({
      canonical: older, redundant: [learned, saved]
    });
  });

  it.each([
    ["distinct", "DISTINCT", "HIGH"], ["uncertain", "UNCERTAIN", "LOW"], ["a medium verdict", "EQUIVALENT", "MEDIUM"]
  ] as const)("keeps both facts on %s", (_name, relation, confidence) => {
    const input = snapshot(fact("saved", "EXPLICIT", 30), [fact("learned", "AUTOMATIC", 0)]);
    expect(selectMemoryExplicitRelationMerge(input, decisions(input, relation, confidence))).toBeNull();
  });

  it.each([
    ["another time", { occurredAt: "2026-09-01T00:00:00.000Z" }],
    ["another interval", { validFrom: "2026-01-01T00:00:00.000Z" }],
    ["another expiry", { expiresAt: "2027-01-01T00:00:00.000Z" }],
    ["another modality", { modality: "PREFERENCE" }]
  ] as const)("keeps both facts on %s even with an equivalent verdict", (_name, change) => {
    const input = snapshot(fact("saved", "EXPLICIT", 30), [fact("learned", "AUTOMATIC", 0, change)]);
    expect(selectMemoryExplicitRelationMerge(input, decisions(input))).toBeNull();
  });

  it("never compares two automatic facts, a pinned automatic fact, or automatic facts under v1", () => {
    const learned = fact("learned", "AUTOMATIC", 0);
    const saved = fact("saved", "EXPLICIT", 30);
    for (const invalid of [
      snapshot(learned, [fact("other", "AUTOMATIC", 5)]),
      snapshot(saved, [{ ...learned, pinned: true }]),
      { ...snapshot(saved, [learned]), pipelineVersion: MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION }
    ]) {
      expect(() => assertMemoryExplicitRelationSnapshot(invalid))
        .toThrow("memory_explicit_relation_snapshot_invalid");
    }
  });

  it("binds the comparison to each participant's exact source and origin", () => {
    const input = snapshot(fact("saved", "EXPLICIT", 30), [fact("learned", "AUTOMATIC", 0)]);
    const hash = memoryExplicitRelationInputHash(input);
    for (const changed of [
      snapshot(input.source, [{ ...input.candidates[0]!, evidenceHash: "b".repeat(64) }]),
      snapshot(input.source, [{ ...input.candidates[0]!, sourceMode: "EXPLICIT" }]),
      snapshot(input.source, [{ ...input.candidates[0]!, statement: "My name is Eva." }])
    ]) expect(memoryExplicitRelationInputHash(changed)).not.toBe(hash);
  });

  it("asks a neutral question and keeps origin, pins and identities out of the provider input", () => {
    const input = snapshot(fact("saved", "EXPLICIT", 30, { pinned: true }), [fact("learned", "AUTOMATIC", 0)]);
    const request = buildMemoryExplicitRelationRequest(input);
    expect(request.name).toBe("memory_fact_equivalence_v2");
    expect(request.systemPrompt).toContain("that origin never changes its meaning");
    expect(request.systemPrompt).toContain("letter case, punctuation or spacing do not change meaning");
    for (const hidden of ["private-", "AUTOMATIC", "EXPLICIT", "pinned", "a".repeat(64)]) {
      expect(request.userPrompt).not.toContain(hidden);
    }
    expect(JSON.parse(request.userPrompt)).toMatchObject({
      candidates: [{ ref: "R1", statement: "My name is Ada." }],
      source: { ref: "P0", statement: "My name is Ada." }
    });
  });
});

describe("equivalence candidate selection", () => {
  it("matches normalized text regardless of case, punctuation and spacing in any script", () => {
    expect(memoryEquivalenceTextKey("My name is Ada.")).toBe(memoryEquivalenceTextKey("  my NAME is ada "));
    expect(memoryEquivalenceTextKey("Меня зовут Ада!")).toBe(memoryEquivalenceTextKey("меня зовут ада"));
    expect(memoryEquivalenceTextKey("私はエイダです。")).toBe(memoryEquivalenceTextKey("私はエイダです"));
    expect(memoryEquivalenceTextKey("My name is Ada.")).not.toBe(memoryEquivalenceTextKey("My name is Eva."));
    expect(memoryEquivalenceTextKey("My name is not Ada.")).not.toBe(memoryEquivalenceTextKey("My name is Ada."));
    expect(memoryEquivalenceTextKey("?!…")).toBe("");
  });

  it("admits automatic candidates only for an explicit source of the current protocol", () => {
    expect([...memoryExplicitRelationCandidateModes(MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, "EXPLICIT")].sort())
      .toEqual(["AUTOMATIC", "EXPLICIT"]);
    expect([...memoryExplicitRelationCandidateModes(MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, "AUTOMATIC")])
      .toEqual(["EXPLICIT"]);
    expect([...memoryExplicitRelationCandidateModes(MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION, "EXPLICIT")])
      .toEqual(["EXPLICIT"]);
    expect(memoryExplicitRelationCandidateModes("memory-fact-relation-v2", "EXPLICIT").size).toBe(0);
  });

  it("puts bounded equal-text twins first and keeps the v1 lane order otherwise", () => {
    const ranked = Array.from({ length: 10 }, (_, index) => `ranked-${index}`);
    const recent = ["recent-0", "ranked-9", "recent-1"];
    const v1 = selectMemoryExplicitRelationCandidateIds({ equal: [], ranked, recent });
    expect(v1).toEqual([...ranked.slice(0, 8), "recent-0", "ranked-9", "recent-1", "ranked-8"]);
    const equal = ["twin-0", "ranked-3", "twin-1", "twin-2", "twin-3"];
    const v2 = selectMemoryExplicitRelationCandidateIds({ equal, ranked, recent });
    expect(v2.slice(0, 4)).toEqual(["twin-0", "ranked-3", "twin-1", "twin-2"]);
    expect(v2).not.toContain("twin-3");
    expect(new Set(v2).size).toBe(v2.length);
    expect(v2).toHaveLength(MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES);
  });

  it("sweeps only unchecked unprotected automatic facts with an equal explicit save in their scope", () => {
    const row = (versionId: string, sourceMode: "AUTOMATIC" | "EXPLICIT", text: string,
      extra: Partial<{ checked: boolean; eligible: boolean; scopeId: string }> = {}) => ({
      checked: false, eligible: true, normalizedSearchText: text, scopeId: "scope", sourceMode, versionId, ...extra
    });
    expect(selectMemoryExplicitEquivalenceSweepTargets([
      row("saved", "EXPLICIT", "my name is ada."),
      row("twin", "AUTOMATIC", "my name is ada"),
      row("paraphrase", "AUTOMATIC", "the user is called ada."),
      row("pinned", "AUTOMATIC", "my name is ada.", { eligible: false }),
      row("checked", "AUTOMATIC", "my name is ada.", { checked: true }),
      row("other-scope", "AUTOMATIC", "my name is ada.", { scopeId: "folder" }),
      row("empty", "AUTOMATIC", "…"),
      row("saved-twin", "EXPLICIT", "my name is ada")
    ])).toEqual(["twin"]);
  });
});
