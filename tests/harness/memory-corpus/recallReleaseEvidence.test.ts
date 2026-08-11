import { describe, expect, it } from "vitest";
import {
  MEMORY_EVALUATION_SCORER_VERSION
} from "../../../lib/evaluation/memory/contracts";
import {
  MEMORY_RECALL_RELEASE_EVALUATOR_VERSION,
  MEMORY_RECALL_RELEASE_EVIDENCE_VERSION
} from "../../../lib/evaluation/memory/recallRelease";
import { memoryEvaluationSha256 } from "../../../lib/evaluation/memory/canonical";
import {
  MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
  MEMORY_RETRIEVAL_PIPELINE_VERSION
} from "../../../lib/domain/memory/retrieval";
import { MEMORY_RETRIEVAL_PLANNER_VERSION } from "../../../lib/domain/memory/retrieval/planner";
import {
  MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION
} from "../../../lib/server/memory/retrieval/localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "../../../lib/server/memory/retrieval/vector";
import {
  MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION
} from "../../fixtures/memory-evaluation/recallReleaseCases";
import { readMemoryCorpusJson } from "./testSupport";

type LanguageGate = Readonly<{
  gatePassed: boolean;
  point: number;
  total: number;
}>;

describe("Memory recall release evidence", () => {
  it("pins passing aggregate-only holdout evidence to current native versions", () => {
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
    const retrievalConfigFingerprint = memoryEvaluationSha256({
      caseBuilder: MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION,
      evaluator: MEMORY_RECALL_RELEASE_EVALUATOR_VERSION,
      localRepository: MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION,
      minimumVectorScore: MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
      pipeline: MEMORY_RETRIEVAL_PIPELINE_VERSION,
      planner: MEMORY_RETRIEVAL_PLANNER_VERSION,
      topK: 5,
      vectorConfig: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
      vectorPipeline: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    });

    expect(evidence).toMatchObject({
      corpus: {
        hash: corpus.splits.HOLDOUT.contentHash,
        split: "HOLDOUT",
        version: corpus.corpusVersion
      },
      evidenceVersion: MEMORY_RECALL_RELEASE_EVIDENCE_VERSION,
      releaseGatePassed: true,
      sanitizedAggregatesOnly: true,
      versions: {
        caseBuilder: MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION,
        evaluator: MEMORY_RECALL_RELEASE_EVALUATOR_VERSION,
        localRepository: MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION,
        pgvector: "0.8.5",
        pipeline: MEMORY_RETRIEVAL_PIPELINE_VERSION,
        planner: MEMORY_RETRIEVAL_PLANNER_VERSION,
        postgresql: "16.14",
        retrievalConfigFingerprint,
        scorer: MEMORY_EVALUATION_SCORER_VERSION,
        vectorPipeline: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
      }
    });
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
