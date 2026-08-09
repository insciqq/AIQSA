import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMORY_BENCHMARK_SOURCES,
  buildMemoryBenchmarkEvidenceManifest,
  buildMemoryBenchmarkProvenanceManifest,
  loadOfflineMemoryBenchmarkProbes
} from "../../fixtures/memory-evaluation/benchmarks/adapters";
import {
  MEMORY_BENCHMARK_IDS,
  MEMORY_BENCHMARK_PROBES
} from "../../fixtures/memory-evaluation/benchmarks/probes";
import { memoryCorpusRoot, readMemoryCorpusJson } from "./testSupport";

describe("native Memory offline benchmark adapters", () => {
  it("matches pinned, license-reviewed provenance without upstream content", () => {
    const provenance = buildMemoryBenchmarkProvenanceManifest();
    expect(provenance).toEqual(
      readMemoryCorpusJson("manifests/benchmark-provenance-v1.json")
    );
    expect(provenance).toMatchObject({
      officialLeaderboardComparable: false,
      separation: {
        aiqsaHoldoutImported: false,
        tuningImported: false,
        upstreamTextIncluded: false
      }
    });
    expect(MEMORY_BENCHMARK_SOURCES.map(({ benchmark, license }) => [benchmark, license]))
      .toEqual([
        ["LONGMEMEVAL", "MIT"],
        ["LOCOMO", "CC-BY-NC-4.0"],
        ["MINJA_LIKE", "NOASSERTION"]
      ]);
    for (const source of MEMORY_BENCHMARK_SOURCES) {
      expect(source.repositoryRevision).toMatch(/^[0-9a-f]{40}$/u);
      if (source.datasetRevision !== null) {
        expect(source.datasetRevision).toMatch(/^[0-9a-f]{40}$/u);
      }
      expect(source.contentMode).toBe("SYNTHETIC_BEHAVIOR_ONLY");
      expect(source.licenseReview).toMatchObject({
        copiedUpstreamContent: false,
        decision: "METADATA_AND_BEHAVIOR_ONLY"
      });
    }
  });

  it("freezes five hermetic synthetic probes per benchmark with exact source IDs", () => {
    const probeIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const benchmark of MEMORY_BENCHMARK_IDS) {
      expect(loadOfflineMemoryBenchmarkProbes({ benchmark, purpose: "BENCHMARK_ONLY" }))
        .toHaveLength(5);
    }
    expect(MEMORY_BENCHMARK_PROBES
      .filter(({ benchmark }) => benchmark === "LONGMEMEVAL")
      .map(({ provenanceCategory }) => provenanceCategory)).toEqual([
      "single-session-user",
      "multi-session",
      "knowledge-update",
      "temporal-reasoning",
      "abstention"
    ]);
    expect(MEMORY_BENCHMARK_PROBES
      .filter(({ benchmark }) => benchmark === "LOCOMO")
      .map(({ provenanceCategory }) => provenanceCategory)).toEqual([
      "single-hop",
      "multi-hop",
      "temporal",
      "long-conversation",
      "adversarial"
    ]);
    for (const probe of MEMORY_BENCHMARK_PROBES) {
      expect(probe.syntheticBehaviorOnly).toBe(true);
      expect(probeIds.has(probe.id)).toBe(false);
      probeIds.add(probe.id);
      const localMessageIds = new Set(probe.messages.map(({ id }) => id));
      expect(probe.messages.map(({ text }) => text).join(" ").toLocaleLowerCase())
        .toMatch(/synthetic|синтет/u);
      for (const message of probe.messages) {
        expect(messageIds.has(message.id)).toBe(false);
        messageIds.add(message.id);
      }
      for (const relevantMessageId of probe.relevantMessageIds) {
        expect(localMessageIds.has(relevantMessageId)).toBe(true);
      }
    }
    expect(probeIds.size).toBe(15);
  });

  it("reproduces separate sanitized benchmark evidence", () => {
    const provenance = buildMemoryBenchmarkProvenanceManifest();
    const evidence = buildMemoryBenchmarkEvidenceManifest(provenance);
    expect(evidence).toEqual(
      readMemoryCorpusJson("manifests/benchmark-evidence-v1.json")
    );
    expect(evidence).toMatchObject({
      officialLeaderboardComparable: false,
      sanitizedAggregatesOnly: true
    });

    const serialized = JSON.stringify(evidence);
    for (const probe of MEMORY_BENCHMARK_PROBES) {
      expect(serialized).not.toContain(probe.id);
      for (const message of probe.messages) expect(serialized).not.toContain(message.text);
    }
  });

  it("introduces no benchmark runtime package dependency", () => {
    const packageManifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
    ) as Record<string, unknown>;
    const packageText = JSON.stringify({
      dependencies: packageManifest.dependencies,
      devDependencies: packageManifest.devDependencies,
      optionalDependencies: packageManifest.optionalDependencies
    }).toLocaleLowerCase();
    expect(packageText).not.toMatch(/longmemeval|locomo|minja/u);

    const attribution = readFileSync(
      path.join(memoryCorpusRoot, "benchmarks/ATTRIBUTION.md"),
      "utf8"
    );
    expect(attribution).toMatch(
      /not\s+be presented as a LongMemEval, LoCoMo, or MINJA leaderboard score/u
    );
  });
});
