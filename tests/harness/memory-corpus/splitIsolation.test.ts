import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOfflineMemoryBenchmarkProbes } from "../../fixtures/memory-evaluation/benchmarks/adapters";
import { MEMORY_BENCHMARK_IDS } from "../../fixtures/memory-evaluation/benchmarks/probes";
import { MEMORY_HOLDOUT_COHORT_TEMPLATES } from "../../fixtures/memory-evaluation/holdout/cohorts";
import { loadMemoryHoldoutCorpus } from "../../fixtures/memory-evaluation/holdout/corpus";
import { MEMORY_COHORT_TEMPLATES } from "../../fixtures/memory-evaluation/shared/cohorts";
import {
  MEMORY_CORPUS_COHORTS,
  MEMORY_CORPUS_VERSION
} from "../../fixtures/memory-evaluation/shared/corpusTypes";
import { loadFrozenMemoryCorpus, memoryCorpusRoot } from "./testSupport";

const corpus = loadFrozenMemoryCorpus();

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  });
}

function fixtureContent(fixtures: typeof corpus.fixtures): Set<string> {
  return new Set(fixtures.flatMap((fixture) => [
    ...fixture.chats.flatMap((chat) => chat.messages.map(({ text }) => text)),
    ...fixture.expectedFacts.map(({ displayText }) => displayText),
    ...fixture.forbiddenFacts.map(({ text }) => text),
    ...fixture.queries.map(({ text }) => text)
  ]));
}

describe("native Memory corpus isolation", () => {
  it("keeps tuning source imports outside the holdout boundary", () => {
    const tuningSource = sourceFiles(path.join(memoryCorpusRoot, "tuning"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(tuningSource).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*holdout/iu);
    expect(tuningSource).not.toContain("blind-holdout-family");

    const adapterSource = readFileSync(
      path.join(memoryCorpusRoot, "benchmarks/adapters.ts"),
      "utf8"
    );
    expect(adapterSource).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*holdout/iu);
    expect(adapterSource).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*tuning/iu);
  });

  it("requires the exact holdout purpose and corpus version", () => {
    expect(() => loadMemoryHoldoutCorpus({
      expectedCorpusVersion: MEMORY_CORPUS_VERSION,
      purpose: "TUNING"
    } as never)).toThrow("memory_holdout_access_denied");
    expect(() => loadMemoryHoldoutCorpus({
      expectedCorpusVersion: "memory-corpus-v0",
      purpose: "SCORING_ONLY"
    })).toThrow("memory_holdout_access_denied");
  });

  it("keeps tuning and holdout IDs, groups, and synthetic content disjoint", () => {
    const tuningIds = new Set(corpus.tuning.map(({ id }) => id));
    const tuningGroups = new Set(corpus.tuning.map(({ groupId }) => groupId));
    const tuningContent = fixtureContent(corpus.tuning);

    expect(corpus.holdout.some(({ id }) => tuningIds.has(id))).toBe(false);
    expect(corpus.holdout.some(({ groupId }) => tuningGroups.has(groupId))).toBe(false);
    expect([...fixtureContent(corpus.holdout)].some((text) => tuningContent.has(text))).toBe(false);
  });

  it("uses distinct tuning and holdout scenario copy before case suffixing", () => {
    for (const cohort of MEMORY_CORPUS_COHORTS) {
      for (const language of ["RU", "EN"] as const) {
        const tuning = MEMORY_COHORT_TEMPLATES[cohort][language];
        const holdout = MEMORY_HOLDOUT_COHORT_TEMPLATES[cohort][language];
        expect(holdout.source).not.toBe(tuning.source);
        expect(holdout.query).not.toBe(tuning.query);
        expect(holdout.forbiddenFact).not.toBe(tuning.forbiddenFact);
        if (tuning.expectedFact !== null && holdout.expectedFact !== null) {
          expect(holdout.expectedFact).not.toBe(tuning.expectedFact);
        }
        if (tuning.correction !== null && holdout.correction !== null) {
          expect(holdout.correction).not.toBe(tuning.correction);
        }
      }
    }
  });

  it("keeps benchmark probes in their own fail-closed input family", () => {
    const corpusIds = new Set(corpus.fixtures.flatMap((fixture) => [
      fixture.id,
      ...fixture.chats.flatMap((chat) => chat.messages.map(({ id }) => id)),
      ...fixture.queries.map(({ id }) => id)
    ]));
    const benchmarkIds = MEMORY_BENCHMARK_IDS.flatMap((benchmark) =>
      loadOfflineMemoryBenchmarkProbes({ benchmark, purpose: "BENCHMARK_ONLY" })
        .flatMap((probe) => [probe.id, ...probe.messages.map(({ id }) => id)])
    );
    expect(benchmarkIds.some((id) => corpusIds.has(id))).toBe(false);
    expect(() => loadOfflineMemoryBenchmarkProbes({
      benchmark: "LONGMEMEVAL",
      purpose: "SCORING_ONLY"
    } as never)).toThrow("memory_benchmark_access_denied");
  });
});
