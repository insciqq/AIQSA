import { describe, expect, it } from "vitest";
import { MEMORY_RETRIEVAL_PIPELINE_VERSION } from
  "../../../lib/domain/memory/retrieval";
import { readMemoryCorpusJson } from "./testSupport";

type LanguageGate = Readonly<{
  gatePassed: boolean;
  point: number;
  total: number;
}>;

describe("Memory recall release evidence", () => {
  it("retains sanitized historical holdout evidence without granting runtime authority", () => {
    const evidence = readMemoryCorpusJson<{
      adapter: { fingerprints: Record<string, string> };
      corpus: { hash: string; split: string; version: string };
      evidenceVersion: string;
      priorAblations: readonly Readonly<{ acceptedForRelease: boolean }>[];
      quality: {
        criticalRecall: Record<"EN" | "RU", { groups: number; passed: number }>;
        irrelevantAutomaticInjection: Record<"EN" | "RU", LanguageGate>;
        recallAt5: Record<"EN" | "RU", LanguageGate & {
          bootstrap95: { lower: number; upper: number };
        }>;
      };
      releaseGatePassed: boolean;
      sanitizedAggregatesOnly: boolean;
      versions: Record<string, string | number>;
    }>("manifests/recall-release-holdout-v1.json");
    const corpus = readMemoryCorpusJson<{
      corpusVersion: string;
      splits: { HOLDOUT: { contentHash: string } };
    }>("manifests/corpus-v2.json");
    expect(evidence).toMatchObject({
      corpus: {
        hash: corpus.splits.HOLDOUT.contentHash,
        split: "HOLDOUT",
        version: corpus.corpusVersion
      },
      releaseGatePassed: true,
      sanitizedAggregatesOnly: true
    });
    expect(evidence.versions.pipeline).not.toBe(MEMORY_RETRIEVAL_PIPELINE_VERSION);
    expect(Object.values(evidence.versions).every((value) =>
      typeof value === "number" || (typeof value === "string" && value.length > 0)
    )).toBe(true);
    for (const language of ["RU", "EN"] as const) {
      expect(evidence.quality.recallAt5[language]).toMatchObject({
        bootstrap95: { lower: 1, upper: 1 },
        gatePassed: true,
        point: 1,
        total: 246
      });
      expect(evidence.quality.irrelevantAutomaticInjection[language]).toMatchObject({
        gatePassed: true,
        point: 0,
        total: 412
      });
      expect(evidence.quality.criticalRecall[language].passed)
        .toBe(evidence.quality.criticalRecall[language].groups);
    }
    expect(evidence.priorAblations).toMatchObject([{ acceptedForRelease: false }]);
    expect(Object.values(evidence.adapter.fingerprints).every((value) =>
      /^[a-f0-9]{64}$/u.test(value)
    )).toBe(true);

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "fixture-",
      "message-",
      "synthetic case",
      "синтетический пример",
      "SYNTHETIC_SECRET",
      "text-embedding-3-small",
      "sk-"
    ]) expect(serialized).not.toContain(forbidden);
  });
});
