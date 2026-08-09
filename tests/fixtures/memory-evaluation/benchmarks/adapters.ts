import { memoryEvaluationSha256 } from "../../../../lib/evaluation/memory/canonical";
import {
  MEMORY_BENCHMARK_IDS,
  MEMORY_BENCHMARK_PROBES,
  MEMORY_BENCHMARK_PROBE_VERSION,
  type MemoryBenchmarkId,
  type MemoryBenchmarkProbe
} from "./probes";

export const MEMORY_BENCHMARK_PROVENANCE_VERSION = "memory-benchmark-provenance-v1";
export const MEMORY_BENCHMARK_EVIDENCE_VERSION = "memory-benchmark-evidence-v1";

export type MemoryBenchmarkSource = Readonly<{
  benchmark: MemoryBenchmarkId;
  contentMode: "SYNTHETIC_BEHAVIOR_ONLY";
  license: "MIT" | "CC-BY-NC-4.0" | "NOASSERTION";
  licenseReview: Readonly<{
    copiedUpstreamContent: false;
    decision: "METADATA_AND_BEHAVIOR_ONLY";
    reviewedAt: "2026-08-09";
    reviewerId: "memory-benchmark-license-review-v1";
  }>;
  paperUrl: string;
  repositoryRevision: string;
  repositoryUrl: string;
  datasetRevision: string | null;
}>;

export type MemoryBenchmarkProvenanceManifest = Readonly<{
  manifestVersion: typeof MEMORY_BENCHMARK_PROVENANCE_VERSION;
  officialLeaderboardComparable: false;
  probeContentHash: string;
  probeVersion: typeof MEMORY_BENCHMARK_PROBE_VERSION;
  separation: Readonly<{
    aiqsaHoldoutImported: false;
    tuningImported: false;
    upstreamTextIncluded: false;
  }>;
  sources: readonly MemoryBenchmarkSource[];
}>;

export const MEMORY_BENCHMARK_SOURCES: readonly MemoryBenchmarkSource[] = [
  {
    benchmark: "LONGMEMEVAL",
    contentMode: "SYNTHETIC_BEHAVIOR_ONLY",
    datasetRevision: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
    license: "MIT",
    licenseReview: {
      copiedUpstreamContent: false,
      decision: "METADATA_AND_BEHAVIOR_ONLY",
      reviewedAt: "2026-08-09",
      reviewerId: "memory-benchmark-license-review-v1"
    },
    paperUrl: "https://openreview.net/forum?id=aly8kr7X1M",
    repositoryRevision: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
    repositoryUrl: "https://github.com/xiaowu0162/LongMemEval"
  },
  {
    benchmark: "LOCOMO",
    contentMode: "SYNTHETIC_BEHAVIOR_ONLY",
    datasetRevision: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
    license: "CC-BY-NC-4.0",
    licenseReview: {
      copiedUpstreamContent: false,
      decision: "METADATA_AND_BEHAVIOR_ONLY",
      reviewedAt: "2026-08-09",
      reviewerId: "memory-benchmark-license-review-v1"
    },
    paperUrl: "https://aclanthology.org/2024.acl-long.747/",
    repositoryRevision: "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
    repositoryUrl: "https://github.com/snap-research/locomo"
  },
  {
    benchmark: "MINJA_LIKE",
    contentMode: "SYNTHETIC_BEHAVIOR_ONLY",
    datasetRevision: null,
    license: "NOASSERTION",
    licenseReview: {
      copiedUpstreamContent: false,
      decision: "METADATA_AND_BEHAVIOR_ONLY",
      reviewedAt: "2026-08-09",
      reviewerId: "memory-benchmark-license-review-v1"
    },
    paperUrl: "https://arxiv.org/abs/2503.03704v5",
    repositoryRevision: "7c260a22c8fb2bd0c8d8bbd4cded7ddc2af9670b",
    repositoryUrl: "https://github.com/dsh3n77/MINJA"
  }
];

export function buildMemoryBenchmarkProvenanceManifest(): MemoryBenchmarkProvenanceManifest {
  return {
    manifestVersion: MEMORY_BENCHMARK_PROVENANCE_VERSION,
    officialLeaderboardComparable: false,
    probeContentHash: memoryEvaluationSha256(MEMORY_BENCHMARK_PROBES),
    probeVersion: MEMORY_BENCHMARK_PROBE_VERSION,
    separation: {
      aiqsaHoldoutImported: false,
      tuningImported: false,
      upstreamTextIncluded: false
    },
    sources: MEMORY_BENCHMARK_SOURCES
  };
}

export function loadOfflineMemoryBenchmarkProbes(input: {
  benchmark: MemoryBenchmarkId;
  purpose: "BENCHMARK_ONLY";
}): readonly MemoryBenchmarkProbe[] {
  if (input.purpose !== "BENCHMARK_ONLY" || !MEMORY_BENCHMARK_IDS.includes(input.benchmark)) {
    throw new Error("memory_benchmark_access_denied");
  }
  return MEMORY_BENCHMARK_PROBES.filter(({ benchmark }) => benchmark === input.benchmark);
}

export type MemoryBenchmarkEvidenceManifest = Readonly<{
  adapter: "NO_MEMORY_BASELINE";
  benchmarkCounts: Readonly<Record<MemoryBenchmarkId, Readonly<{
    denied: number;
    probes: number;
    recalled: 0;
  }>>>;
  evidenceVersion: typeof MEMORY_BENCHMARK_EVIDENCE_VERSION;
  officialLeaderboardComparable: false;
  provenanceManifestHash: string;
  sanitizedAggregatesOnly: true;
}>;

export function buildMemoryBenchmarkEvidenceManifest(
  provenance: MemoryBenchmarkProvenanceManifest
): MemoryBenchmarkEvidenceManifest {
  return {
    adapter: "NO_MEMORY_BASELINE",
    benchmarkCounts: Object.fromEntries(MEMORY_BENCHMARK_IDS.map((benchmark) => {
      const probes = loadOfflineMemoryBenchmarkProbes({ benchmark, purpose: "BENCHMARK_ONLY" });
      return [benchmark, {
        denied: probes.filter(({ expectedOutcome }) => expectedOutcome.startsWith("DENY_"))
          .length,
        probes: probes.length,
        recalled: 0
      }];
    })) as MemoryBenchmarkEvidenceManifest["benchmarkCounts"],
    evidenceVersion: MEMORY_BENCHMARK_EVIDENCE_VERSION,
    officialLeaderboardComparable: false,
    provenanceManifestHash: memoryEvaluationSha256(provenance),
    sanitizedAggregatesOnly: true
  };
}
