import { memoryEvaluationSha256 } from
  "../../../lib/evaluation/memory/canonical";
import type { MemoryPhase7CaseObservation } from
  "../../../lib/evaluation/memory/phase7Ablation";
import type {
  MemoryCorpusFixture,
  MemoryCorpusLanguage
} from "../../fixtures/memory-evaluation/shared/corpusTypes";

export const MEMORY_PHASE7_HINDSIGHT_COMPARISON_VERSION =
  "memory-phase7-hindsight-comparison-v1";

const temporalCohorts = new Set([
  "expired-plan",
  "relative-date-timezone",
  "temporal-correction",
  "temporary-vs-residence"
]);

export type HindsightRecallResult = Readonly<{
  documentId: string | null;
  text: string;
}>;

export type HindsightCaseResult = Readonly<{
  fixture: MemoryCorpusFixture;
  providerCallPerformed: boolean;
  results: readonly HindsightRecallResult[];
}>;

export type MemoryPhase7HindsightMetrics = Readonly<{
  cases: number;
  factPrecision: number;
  factRecall: number;
  russianRecallAt5: number;
  temporalAccuracy: number;
}>;

export type MemoryPhase7HindsightObservation = Readonly<{
  cohort: string;
  egressDenied: boolean;
  language: MemoryCorpusLanguage;
  recallAt5: number | null;
  retrievalContaminated: boolean;
  returnedFacts: number;
  temporalCorrect: boolean | null;
}>;

function average(values: readonly number[], code: string): number {
  if (values.length === 0 || !values.every((value) =>
    Number.isFinite(value) && value >= 0 && value <= 1
  )) throw new Error(code);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizedTokens(value: string): ReadonlySet<string> {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("und")
    .replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) ?? []);
}

function expectedContrastTokens(fixture: MemoryCorpusFixture): ReadonlySet<string> {
  const query = fixture.queries[0];
  if (!query) throw new Error("memory_phase7_hindsight_fixture_shape_invalid");
  const relevant = new Set(query.relevantMessageIds);
  const expected = fixture.expectedFacts.find((fact) =>
    fact.state === "ACTIVE" && fact.sourceMessageIds.some((id) => relevant.has(id))
  );
  if (!expected) return new Set();
  const expectedTokens = normalizedTokens(expected.displayText);
  const forbiddenTokens = new Set(fixture.forbiddenFacts.flatMap((fact) =>
    [...normalizedTokens(fact.text)]
  ));
  return new Set([...expectedTokens].filter((token) =>
    token.length >= 2 && !forbiddenTokens.has(token)
  ));
}

function hasContrast(text: string, contrast: ReadonlySet<string>): boolean {
  if (contrast.size === 0) return true;
  const tokens = normalizedTokens(text);
  return [...contrast].some((token) => tokens.has(token));
}

export function selectMemoryPhase7HindsightFixtures(input: Readonly<{
  criticalCohorts: readonly string[];
  fixtures: readonly MemoryCorpusFixture[];
  randomSeed: number;
}>): readonly MemoryCorpusFixture[] {
  if (
    input.criticalCohorts.length === 0 ||
    new Set(input.criticalCohorts).size !== input.criticalCohorts.length ||
    !Number.isSafeInteger(input.randomSeed)
  ) throw new Error("memory_phase7_hindsight_selection_invalid");
  const selected: MemoryCorpusFixture[] = [];
  for (const language of ["EN", "RU"] as const) {
    for (const cohort of input.criticalCohorts) {
      const candidates = input.fixtures.filter((fixture) =>
        fixture.language === language && fixture.cohort === cohort
      ).map((fixture) => ({
        fixture,
        hash: memoryEvaluationSha256({
          cohort,
          evaluatorVersion: MEMORY_PHASE7_HINDSIGHT_COMPARISON_VERSION,
          fixtureId: fixture.id,
          language,
          randomSeed: input.randomSeed
        })
      })).sort((left, right) =>
        left.hash.localeCompare(right.hash) ||
        left.fixture.id.localeCompare(right.fixture.id)
      );
      if (candidates.length === 0) {
        throw new Error("memory_phase7_hindsight_selection_incomplete");
      }
      selected.push(candidates[0]!.fixture);
    }
  }
  return selected;
}

export function scoreMemoryPhase7HindsightCases(
  values: readonly HindsightCaseResult[]
): Readonly<{
  metrics: MemoryPhase7HindsightMetrics;
  observations: readonly MemoryPhase7HindsightObservation[];
}> {
  if (values.length === 0) {
    throw new Error("memory_phase7_hindsight_results_invalid");
  }
  const observations = values.map(({ fixture, providerCallPerformed, results }) => {
    const query = fixture.queries[0];
    if (!query || fixture.queries.length !== 1 || results.length > 5) {
      throw new Error("memory_phase7_hindsight_results_invalid");
    }
    if (!fixture.expectedEgress.remoteCallsAllowed && providerCallPerformed) {
      throw new Error("memory_phase7_hindsight_local_only_egress");
    }
    const recallExpected = query.expectedOutcome === "RECALL";
    const contrast = expectedContrastTokens(fixture);
    const temporal = temporalCohorts.has(fixture.cohort);
    const relevant = results.map((result) =>
      recallExpected && result.documentId === fixture.id &&
      (!temporal || hasContrast(result.text, contrast))
    );
    const recallAt5 = recallExpected
      ? relevant.some(Boolean) ? 1 : 0
      : null;
    return {
      cohort: fixture.cohort,
      egressDenied: !fixture.expectedEgress.remoteCallsAllowed,
      language: fixture.language,
      recallAt5,
      retrievalContaminated: relevant.some((value) => !value) ||
        (!recallExpected && results.length > 0),
      returnedFacts: results.length,
      temporalCorrect: temporal
        ? recallExpected ? relevant[0] === true : results.length === 0
        : null
    } satisfies MemoryPhase7HindsightObservation;
  });
  return { metrics: summarizeMemoryPhase7HindsightObservations(observations), observations };
}

export function summarizeMemoryPhase7HindsightObservations(
  values: readonly Pick<MemoryPhase7HindsightObservation,
    "language" | "recallAt5" | "retrievalContaminated" | "temporalCorrect">[]
): MemoryPhase7HindsightMetrics {
  if (values.length === 0) {
    throw new Error("memory_phase7_hindsight_observations_invalid");
  }
  const recall = values.filter((value) => value.recallAt5 !== null);
  const russianRecall = recall.filter((value) => value.language === "RU");
  const temporal = values.filter((value) => value.temporalCorrect !== null);
  return {
    cases: values.length,
    factPrecision: values.filter((value) => !value.retrievalContaminated).length /
      values.length,
    factRecall: average(recall.map((value) => value.recallAt5!),
      "memory_phase7_hindsight_fact_recall_missing"),
    russianRecallAt5: average(russianRecall.map((value) => value.recallAt5!),
      "memory_phase7_hindsight_russian_recall_missing"),
    temporalAccuracy: average(temporal.map((value) => value.temporalCorrect ? 1 : 0),
      "memory_phase7_hindsight_temporal_missing")
  };
}

export function scoreMemoryPhase7NativeComparison(
  values: readonly MemoryPhase7CaseObservation[]
): MemoryPhase7HindsightMetrics {
  return summarizeMemoryPhase7HindsightObservations(values);
}
