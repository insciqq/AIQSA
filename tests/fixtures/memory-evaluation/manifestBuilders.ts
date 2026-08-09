import {
  memoryEvaluationSha256
} from "../../../lib/evaluation/memory/canonical";
import { MEMORY_EVALUATION_SCORER_VERSION } from "../../../lib/evaluation/memory/contracts";
import {
  MEMORY_ADVERSARIAL_COHORTS,
  MEMORY_CORPUS_GENERATOR_VERSION,
  MEMORY_CORPUS_SCHEMA_VERSION,
  MEMORY_CORPUS_VERSION,
  MEMORY_CRITICAL_COHORTS,
  type MemoryCorpusFixture,
  type MemoryCorpusLanguage,
  type MemoryCorpusSplit
} from "./shared/corpusTypes";

export const MEMORY_CORPUS_MANIFEST_VERSION = "memory-corpus-manifest-v1";
export const MEMORY_NO_MEMORY_BASELINE_VERSION = "memory-no-memory-baseline-v1";

type LanguageStatistics = Readonly<{
  adversarialCases: number;
  factScenarios: number;
  fixtures: number;
  judgedRetrievalQueries: number;
}>;

export type MemoryCorpusSplitManifest = Readonly<{
  contentHash: string;
  criticalCohorts: Readonly<Record<MemoryCorpusLanguage, Readonly<Record<string, number>>>>;
  languages: Readonly<Record<MemoryCorpusLanguage, LanguageStatistics>>;
  split: MemoryCorpusSplit;
}>;

export type MemoryCorpusManifest = Readonly<{
  combinedContentHash: string;
  corpusVersion: typeof MEMORY_CORPUS_VERSION;
  frozenAt: "2026-08-09T00:00:00.000Z";
  generatorVersion: typeof MEMORY_CORPUS_GENERATOR_VERSION;
  manifestVersion: typeof MEMORY_CORPUS_MANIFEST_VERSION;
  schemaVersion: typeof MEMORY_CORPUS_SCHEMA_VERSION;
  splits: Readonly<Record<MemoryCorpusSplit, MemoryCorpusSplitManifest>>;
}>;

function sortedFixtures(fixtures: readonly MemoryCorpusFixture[]): MemoryCorpusFixture[] {
  return [...fixtures].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function languageStatistics(
  fixtures: readonly MemoryCorpusFixture[],
  language: MemoryCorpusLanguage
): LanguageStatistics {
  const selected = fixtures.filter((fixture) => fixture.language === language);
  return {
    adversarialCases: selected.filter(({ tags }) => tags.includes("adversarial")).length,
    factScenarios: selected.filter(({ expectedFacts, forbiddenFacts }) =>
      expectedFacts.length > 0 || forbiddenFacts.length > 0
    ).length,
    fixtures: selected.length,
    judgedRetrievalQueries: selected.reduce((sum, { queries }) => sum + queries.length, 0)
  };
}

function splitManifest(
  fixtures: readonly MemoryCorpusFixture[],
  split: MemoryCorpusSplit
): MemoryCorpusSplitManifest {
  const selected = sortedFixtures(fixtures.filter((fixture) => fixture.split === split));
  const criticalCohorts = Object.fromEntries(
    (["RU", "EN"] as const).map((language) => [
      language,
      Object.fromEntries(MEMORY_CRITICAL_COHORTS.map((cohort) => [
        cohort,
        selected.filter((fixture) =>
          fixture.language === language && fixture.cohort === cohort
        ).length
      ]))
    ])
  ) as Record<MemoryCorpusLanguage, Record<string, number>>;
  return {
    contentHash: memoryEvaluationSha256(selected),
    criticalCohorts,
    languages: {
      EN: languageStatistics(selected, "EN"),
      RU: languageStatistics(selected, "RU")
    },
    split
  };
}

export function buildMemoryCorpusManifest(
  fixtures: readonly MemoryCorpusFixture[]
): MemoryCorpusManifest {
  const tuning = splitManifest(fixtures, "TUNING");
  const holdout = splitManifest(fixtures, "HOLDOUT");
  return {
    combinedContentHash: memoryEvaluationSha256({
      corpusVersion: MEMORY_CORPUS_VERSION,
      holdout: holdout.contentHash,
      tuning: tuning.contentHash
    }),
    corpusVersion: MEMORY_CORPUS_VERSION,
    frozenAt: "2026-08-09T00:00:00.000Z",
    generatorVersion: MEMORY_CORPUS_GENERATOR_VERSION,
    manifestVersion: MEMORY_CORPUS_MANIFEST_VERSION,
    schemaVersion: MEMORY_CORPUS_SCHEMA_VERSION,
    splits: {
      HOLDOUT: holdout,
      TUNING: tuning
    }
  };
}

export type MemoryNoMemoryBaselineManifest = Readonly<{
  adapter: "NO_MEMORY_BASELINE";
  adapterVersion: "no-memory-baseline-v1";
  adjudicationManifestHash: string;
  baselineVersion: typeof MEMORY_NO_MEMORY_BASELINE_VERSION;
  corpusHashes: Readonly<Record<MemoryCorpusSplit, string>>;
  randomSeed: 4242;
  sanitizedAggregatesOnly: true;
  scorerVersion: typeof MEMORY_EVALUATION_SCORER_VERSION;
  splits: Readonly<Record<MemoryCorpusSplit, Readonly<{
    byLanguage: Readonly<Record<MemoryCorpusLanguage, Readonly<{
      factWrites: 0;
      memoryItemsRetrieved: 0;
      queries: number;
      recallAt5: 0;
    }>>>;
    hardInvariantFailures: 0;
    irrelevantAutomaticInjections: 0;
  }>>>;
}>;

export function buildNoMemoryBaselineManifest(input: {
  adjudicationManifestHash: string;
  corpusManifest: MemoryCorpusManifest;
  fixtures: readonly MemoryCorpusFixture[];
}): MemoryNoMemoryBaselineManifest {
  const split = (
    name: MemoryCorpusSplit
  ): MemoryNoMemoryBaselineManifest["splits"][MemoryCorpusSplit] => ({
    byLanguage: Object.fromEntries((["RU", "EN"] as const).map((language) => [
      language,
      {
        factWrites: 0,
        memoryItemsRetrieved: 0,
        queries: input.fixtures
          .filter((fixture) => fixture.split === name && fixture.language === language)
          .reduce((sum, fixture) => sum + fixture.queries.length, 0),
        recallAt5: 0
      }
    ])) as MemoryNoMemoryBaselineManifest["splits"][MemoryCorpusSplit]["byLanguage"],
    hardInvariantFailures: 0,
    irrelevantAutomaticInjections: 0
  });
  return {
    adapter: "NO_MEMORY_BASELINE",
    adapterVersion: "no-memory-baseline-v1",
    adjudicationManifestHash: input.adjudicationManifestHash,
    baselineVersion: MEMORY_NO_MEMORY_BASELINE_VERSION,
    corpusHashes: {
      HOLDOUT: input.corpusManifest.splits.HOLDOUT.contentHash,
      TUNING: input.corpusManifest.splits.TUNING.contentHash
    },
    randomSeed: 4242,
    sanitizedAggregatesOnly: true,
    scorerVersion: MEMORY_EVALUATION_SCORER_VERSION,
    splits: {
      HOLDOUT: split("HOLDOUT"),
      TUNING: split("TUNING")
    }
  };
}

export const MEMORY_CORPUS_MINIMUMS = Object.freeze({
  adversarial: { EN: 100, RU: 100 },
  criticalCohortPerLanguage: 20,
  factScenarios: { EN: 100, RU: 200 },
  retrievalQueries: { EN: 150, RU: 300 },
  requiredAdversarialCohorts: [...MEMORY_ADVERSARIAL_COHORTS]
});
