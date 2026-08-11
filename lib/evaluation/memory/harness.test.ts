import { describe, expect, it } from "vitest";
import {
  MEMORY_EVALUATION_SCORER_VERSION,
  createAiqsaNativeEvaluationAdapter,
  createNoMemoryBaselineAdapter,
  zeroMemoryHardInvariantObservations,
  type MemoryEvaluationConfig,
  type MemoryEvaluationFixture,
  type MemoryEvaluationObservation
} from "./contracts";
import { hashMemoryEvaluationCorpus, runMemoryEvaluation } from "./harness";

function fixture(
  id: string,
  language: "RU" | "EN" = "RU"
): MemoryEvaluationFixture<{ prompt: string }> {
  return {
    corpusVersion: "memory-corpus-v1",
    dataClass: "SYNTHETIC",
    groupId: `group-${id}`,
    id,
    input: { prompt: `synthetic-${id}` },
    language,
    noMemoryBaseline: {
      binaryOutcomes: [{ cohort: "overall", metric: "SOURCE_COVERAGE", positive: false }],
      hardInvariants: zeroMemoryHardInvariantObservations(),
      operations: [],
      rankedOutcomes: [{ cohort: "overall", metric: "MRR", score: 0, stratum: "base" }]
    },
    split: "HOLDOUT",
    tags: ["synthetic", language.toLowerCase()]
  };
}

function config(
  fixtures: readonly MemoryEvaluationFixture<unknown>[],
  gateProfile: MemoryEvaluationConfig["gateProfile"] = "AUTOMATIC_LEARNING_BETA"
): MemoryEvaluationConfig {
  return {
    bootstrapSamples: 500,
    corpusHash: hashMemoryEvaluationCorpus(fixtures),
    corpusVersion: "memory-corpus-v1",
    gateProfile,
    pgvectorVersion: "0.8.5",
    pipelineVersion: "memory-pipeline-v1",
    policyVersion: "memory-policy-v1",
    postgresqlVersion: "16.14",
    promptVersion: "memory-prompts-v1",
    randomSeed: 4_242,
    retrievalConfigFingerprint: "retrieval-config-v1",
    schemaVersion: "memory-schema-v1",
    scorerVersion: MEMORY_EVALUATION_SCORER_VERSION,
    suiteVersion: "memory-suite-v1"
  };
}

function safeObservation(
  current: MemoryEvaluationFixture<unknown>
): MemoryEvaluationObservation {
  return {
    binaryOutcomes: [
      { cohort: "overall", metric: "SOURCE_COVERAGE", positive: true },
      { cohort: "overall", metric: "BOUNDARY_CORRECTNESS", positive: true }
    ],
    fixtureId: current.id,
    hardInvariants: zeroMemoryHardInvariantObservations(3),
    language: current.language,
    operations: [{
      estimatedCostUsd: 0.002,
      inputTokens: 120,
      latencyMs: 18,
      outputTokens: 24,
      retries: 0,
      role: "MEMORY_FACT_EXTRACT"
    }],
    rankedOutcomes: [
      { cohort: "overall", metric: "MRR", score: 0.75, stratum: "temporal" },
      { cohort: "overall", metric: "NDCG", score: 0.8, stratum: "temporal" }
    ]
  };
}

function betaObservation(
  current: MemoryEvaluationFixture<unknown>
): MemoryEvaluationObservation {
  const metrics = [
    "AUTOMATIC_FACT_PRECISION",
    "CONSOLIDATION_OPERATION_ACCURACY",
    "TEMPORAL_CURRENT_HISTORY_ACCURACY",
    "IRRELEVANT_AUTOMATIC_INJECTION_RATE",
    "LANGUAGE_PRESERVING_DISPLAY_TEXT",
    "EVIDENCE_ID_VALIDITY"
  ] as const;
  return {
    binaryOutcomes: metrics.flatMap((metric) =>
      Array.from({ length: 100 }, () => ({
        cohort: "overall",
        metric,
        positive: metric !== "IRRELEVANT_AUTOMATIC_INJECTION_RATE"
      }))
    ),
    fixtureId: current.id,
    hardInvariants: zeroMemoryHardInvariantObservations(),
    language: current.language,
    operations: [],
    rankedOutcomes: Array.from({ length: 100 }, (_, index) => ({
      cohort: "overall",
      metric: "CURATED_RECALL_AT_5" as const,
      score: 1,
      stratum: index % 2 === 0 ? "temporal" : "updates"
    }))
  };
}

function recallReleaseObservation(
  current: MemoryEvaluationFixture<unknown>,
  recallScore = 1
): MemoryEvaluationObservation {
  return {
    binaryOutcomes: Array.from({ length: 100 }, () => ({
      cohort: "overall",
      metric: "IRRELEVANT_AUTOMATIC_INJECTION_RATE" as const,
      positive: false
    })),
    fixtureId: current.id,
    hardInvariants: zeroMemoryHardInvariantObservations(),
    language: current.language,
    operations: [],
    rankedOutcomes: Array.from({ length: 100 }, (_, index) => ({
      cohort: "overall",
      metric: "CURATED_RECALL_AT_5" as const,
      score: recallScore,
      stratum: index % 2 === 0 ? "temporal" : "updates"
    }))
  };
}

describe("provider-neutral Memory evaluation harness", () => {
  it("reproduces the same sanitized evidence for fixed corpus, versions, and seed", async () => {
    const fixtures = [fixture("ru-one", "RU"), fixture("en-one", "EN")];
    const adapter = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "native-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => safeObservation(current)
    });

    const first = await runMemoryEvaluation({ adapter, config: config(fixtures), fixtures });
    const reversed = [...fixtures].reverse();
    const second = await runMemoryEvaluation({
      adapter,
      config: config(reversed),
      fixtures: reversed
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      adapter: { kind: "AIQSA_NATIVE", version: "native-fake-v1" },
      corpus: { languages: ["EN", "RU"], splits: ["HOLDOUT"] },
      hardInvariants: { complete: true, passed: true },
      passed: false,
      quality: {
        automaticLearningBetaCoverageComplete: false,
        automaticLearningBetaGatePassed: false,
        observedGatesPassed: true,
        recallReleaseCoverageComplete: false,
        recallReleaseGatePassed: false,
        selectedGateProfile: "AUTOMATIC_LEARNING_BETA",
        selectedProfileGatePassed: false
      },
      sanitizedAggregatesOnly: true,
      versions: { randomSeed: 4_242, scorer: MEMORY_EVALUATION_SCORER_VERSION }
    });
    expect(JSON.stringify(first)).not.toContain("synthetic-ru-one");
    expect(JSON.stringify(first)).not.toContain("ru-one");
  });

  it("releases recall independently from the automatic-learning beta profile", async () => {
    const fixtures = [fixture("ru-recall", "RU"), fixture("en-recall", "EN")];
    const adapter = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "native-recall-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => recallReleaseObservation(current)
    });
    const evidence = await runMemoryEvaluation({
      adapter,
      config: config(fixtures, "RECALL_RELEASE"),
      fixtures
    });
    expect(evidence).toMatchObject({
      passed: true,
      quality: {
        automaticLearningBetaCoverageComplete: false,
        automaticLearningBetaGatePassed: false,
        recallReleaseCoverageComplete: true,
        recallReleaseGatePassed: true,
        selectedGateProfile: "RECALL_RELEASE",
        selectedProfileCoverageComplete: true,
        selectedProfileGatePassed: true
      }
    });
  });

  it("does not average a failing recall language into a passing release", async () => {
    const fixtures = [fixture("ru-recall", "RU"), fixture("en-recall", "EN")];
    const adapter = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "native-recall-language-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => recallReleaseObservation(current, current.language === "RU" ? 1 : 0)
    });
    const evidence = await runMemoryEvaluation({
      adapter,
      config: config(fixtures, "RECALL_RELEASE"),
      fixtures
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.quality.recallReleaseGatePassed).toBe(false);
    expect(evidence.quality.ranked.find(({ language }) => language === "EN"))
      .toMatchObject({ gatePassed: false, point: 0 });
  });

  it("requires complete independently passing RU and EN beta evidence", async () => {
    const fixtures = [fixture("ru-beta", "RU"), fixture("en-beta", "EN")];
    const adapter = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "native-beta-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => betaObservation(current)
    });
    const evidence = await runMemoryEvaluation({ adapter, config: config(fixtures), fixtures });
    expect(evidence).toMatchObject({
      hardInvariants: { passed: true },
      passed: true,
      quality: {
        automaticLearningBetaCoverageComplete: true,
        automaticLearningBetaGatePassed: true,
        gatedMetricCount: 14,
        observedGatesPassed: true
      }
    });
  });

  it("provides a deterministic no-memory baseline adapter", async () => {
    const fixtures = [fixture("baseline-one")];
    const evidence = await runMemoryEvaluation({
      adapter: createNoMemoryBaselineAdapter(),
      config: config(fixtures),
      fixtures
    });
    expect(evidence.adapter).toMatchObject({
      fingerprints: [],
      kind: "NO_MEMORY_BASELINE",
      version: "no-memory-baseline-v1"
    });
    expect(evidence.quality.binary).toMatchObject([{
      metric: "SOURCE_COVERAGE",
      negativeCount: 1,
      point: 0
    }]);
    expect(evidence.hardInvariants.passed).toBe(true);
  });

  it("fails a suite when an intentionally unsafe adapter violates one hard invariant", async () => {
    const fixtures = [fixture("unsafe-one")];
    const adapter = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "unsafe-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => {
        const observation = safeObservation(current);
        return {
          ...observation,
          hardInvariants: observation.hardInvariants.map((item) =>
            item.invariant === "CROSS_USER_LEAKAGE"
              ? { ...item, failures: 1 }
              : item
          )
        };
      }
    });
    const evidence = await runMemoryEvaluation({ adapter, config: config(fixtures), fixtures });
    expect(evidence.passed).toBe(false);
    expect(evidence.hardInvariants.results.find(
      ({ invariant }) => invariant === "CROSS_USER_LEAKAGE"
    )).toMatchObject({ failures: 1, passed: false });
    expect(evidence.hardInvariants.byCategory.PRIVACY).toBe(false);
  });

  it("rejects expanded adapter output, mismatched fixtures, and corpus drift", async () => {
    const fixtures = [fixture("strict-one")];
    const expanded = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "expanded-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => ({
        ...safeObservation(current),
        providerBody: "must-not-enter-evidence"
      })
    });
    await expect(runMemoryEvaluation({
      adapter: expanded,
      config: config(fixtures),
      fixtures
    })).rejects.toMatchObject({
      code: "memory_evaluation_observation_invalid"
    });

    const mismatched = createAiqsaNativeEvaluationAdapter({
      adapterVersion: "mismatch-fake-v1",
      fingerprints: [],
      liveProvider: false,
      run: async (current) => ({ ...safeObservation(current), fixtureId: "another-fixture" })
    });
    await expect(runMemoryEvaluation({
      adapter: mismatched,
      config: config(fixtures),
      fixtures
    })).rejects.toMatchObject({ code: "memory_evaluation_observation_mismatch" });

    await expect(runMemoryEvaluation({
      adapter: createNoMemoryBaselineAdapter(),
      config: { ...config(fixtures), corpusHash: "0".repeat(64) },
      fixtures
    })).rejects.toMatchObject({ code: "memory_evaluation_corpus_hash_mismatch" });
  });

  it("keeps synthetic template groups on one corpus split", async () => {
    const tuning = { ...fixture("tuning"), groupId: "shared", split: "TUNING" as const };
    const holdout = { ...fixture("holdout"), groupId: "shared", split: "HOLDOUT" as const };
    const fixtures = [tuning, holdout];
    await expect(runMemoryEvaluation({
      adapter: createNoMemoryBaselineAdapter(),
      config: config(fixtures),
      fixtures
    })).rejects.toMatchObject({ code: "memory_evaluation_corpus_invalid" });
  });
});
