import {
  MEMORY_HARD_INVARIANT_DEFINITIONS,
  type MemoryBinaryMetric,
  type MemoryBinaryOutcome,
  type MemoryCapabilityRole,
  type MemoryEvaluationLanguage,
  type MemoryHardInvariant,
  type MemoryHardInvariantCategory,
  type MemoryHardInvariantObservation,
  type MemoryOperationObservation,
  type MemoryRankedMetric,
  type MemoryRankedOutcome
} from "./contracts";
import {
  compareMemoryEvaluationText,
  createMemoryEvaluationPrng,
  deriveMemoryEvaluationSeed
} from "./canonical";

const WILSON_95_Z = 1.959963984540054;

export type MemoryInterval = Readonly<{
  confidence: 0.95;
  lower: number;
  method: "WILSON" | "STRATIFIED_BOOTSTRAP";
  upper: number;
}>;

export type MemoryThresholdDirection = "MINIMUM" | "MAXIMUM";

export type MemoryQualityGate = Readonly<{
  direction: MemoryThresholdDirection;
  exact: boolean;
  intervalEndpoint: "LOWER" | "UPPER" | null;
  intervalThreshold: number | null;
  pointThreshold: number;
}>;

export const MEMORY_BINARY_QUALITY_GATES: Readonly<
  Partial<Record<MemoryBinaryMetric, MemoryQualityGate>>
> = Object.freeze({
  AUTOMATIC_FACT_PRECISION: {
    direction: "MINIMUM",
    exact: false,
    intervalEndpoint: "LOWER",
    intervalThreshold: 0.92,
    pointThreshold: 0.95
  },
  CONSOLIDATION_OPERATION_ACCURACY: {
    direction: "MINIMUM",
    exact: false,
    intervalEndpoint: "LOWER",
    intervalThreshold: 0.85,
    pointThreshold: 0.9
  },
  EVIDENCE_ID_VALIDITY: {
    direction: "MINIMUM",
    exact: true,
    intervalEndpoint: null,
    intervalThreshold: null,
    pointThreshold: 1
  },
  IRRELEVANT_AUTOMATIC_INJECTION_RATE: {
    direction: "MAXIMUM",
    exact: false,
    intervalEndpoint: "UPPER",
    intervalThreshold: 0.05,
    pointThreshold: 0.03
  },
  LANGUAGE_PRESERVING_DISPLAY_TEXT: {
    direction: "MINIMUM",
    exact: false,
    intervalEndpoint: "LOWER",
    intervalThreshold: 0.95,
    pointThreshold: 0.98
  },
  TEMPORAL_CURRENT_HISTORY_ACCURACY: {
    direction: "MINIMUM",
    exact: false,
    intervalEndpoint: "LOWER",
    intervalThreshold: 0.85,
    pointThreshold: 0.9
  }
});

export const MEMORY_RANKED_QUALITY_GATES: Readonly<
  Partial<Record<MemoryRankedMetric, MemoryQualityGate>>
> = Object.freeze({
  CURATED_RECALL_AT_5: {
    direction: "MINIMUM",
    exact: false,
    intervalEndpoint: "LOWER",
    intervalThreshold: 0.8,
    pointThreshold: 0.85
  }
});

export const MEMORY_BETA_REQUIRED_BINARY_METRICS = [
  "AUTOMATIC_FACT_PRECISION",
  "CONSOLIDATION_OPERATION_ACCURACY",
  "TEMPORAL_CURRENT_HISTORY_ACCURACY",
  "IRRELEVANT_AUTOMATIC_INJECTION_RATE",
  "LANGUAGE_PRESERVING_DISPLAY_TEXT",
  "EVIDENCE_ID_VALIDITY"
] as const satisfies readonly MemoryBinaryMetric[];

export const MEMORY_BETA_REQUIRED_RANKED_METRICS = [
  "CURATED_RECALL_AT_5"
] as const satisfies readonly MemoryRankedMetric[];

export function compareMemoryMetricUnrounded(
  value: number,
  direction: MemoryThresholdDirection,
  threshold: number
): boolean {
  if (![value, threshold].every(Number.isFinite)) {
    throw new Error("memory_evaluation_non_finite_comparison");
  }
  return direction === "MINIMUM" ? value >= threshold : value <= threshold;
}

export function roundMemoryMetricForDisplay(value: number): number {
  if (!Number.isFinite(value)) throw new Error("memory_evaluation_non_finite_display_value");
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

export function wilson95(successes: number, total: number): MemoryInterval {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || total < 1 ||
      successes < 0 || successes > total) {
    throw new Error("memory_evaluation_invalid_wilson_counts");
  }
  const proportion = successes / total;
  const zSquared = WILSON_95_Z ** 2;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const radius = WILSON_95_Z * Math.sqrt(
    proportion * (1 - proportion) / total + zSquared / (4 * total ** 2)
  ) / denominator;
  return {
    confidence: 0.95,
    lower: Math.max(0, center - radius),
    method: "WILSON",
    upper: Math.min(1, center + radius)
  };
}

function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0 || probability < 0 || probability > 1) {
    throw new Error("memory_evaluation_invalid_quantile");
  }
  if (sortedValues.length === 1) return sortedValues[0]!;
  const index = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sortedValues[lowerIndex]!;
  const upper = sortedValues[upperIndex]!;
  return lower + (upper - lower) * (index - lowerIndex);
}

export type StratifiedScore = Readonly<{ score: number; stratum: string }>;

export function stratifiedBootstrap95(
  observations: readonly StratifiedScore[],
  input: { samples: number; seed: number }
): MemoryInterval {
  if (observations.length === 0 || !Number.isSafeInteger(input.samples) ||
      input.samples < 100 || input.samples > 100_000) {
    throw new Error("memory_evaluation_invalid_bootstrap_input");
  }
  const strata = new Map<string, number[]>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.score) || observation.score < 0 || observation.score > 1 ||
        observation.stratum.length === 0) {
      throw new Error("memory_evaluation_invalid_ranked_observation");
    }
    const values = strata.get(observation.stratum) ?? [];
    values.push(observation.score);
    strata.set(observation.stratum, values);
  }

  for (const values of strata.values()) values.sort((left, right) => left - right);

  const random = createMemoryEvaluationPrng(input.seed);
  const sampleMeans: number[] = [];
  const orderedStrata = [...strata.entries()].sort(([left], [right]) =>
    compareMemoryEvaluationText(left, right)
  );
  for (let sampleIndex = 0; sampleIndex < input.samples; sampleIndex += 1) {
    let sum = 0;
    let count = 0;
    for (const [, values] of orderedStrata) {
      for (let index = 0; index < values.length; index += 1) {
        sum += values[Math.floor(random() * values.length)]!;
        count += 1;
      }
    }
    sampleMeans.push(sum / count);
  }
  sampleMeans.sort((left, right) => left - right);
  return {
    confidence: 0.95,
    lower: quantile(sampleMeans, 0.025),
    method: "STRATIFIED_BOOTSTRAP",
    upper: quantile(sampleMeans, 0.975)
  };
}

function gatePasses(point: number, interval: MemoryInterval, gate: MemoryQualityGate): boolean {
  if (gate.exact) return point === gate.pointThreshold;
  if (!compareMemoryMetricUnrounded(point, gate.direction, gate.pointThreshold)) return false;
  if (gate.intervalEndpoint === null || gate.intervalThreshold === null) return true;
  const endpoint = gate.intervalEndpoint === "LOWER" ? interval.lower : interval.upper;
  return compareMemoryMetricUnrounded(endpoint, gate.direction, gate.intervalThreshold);
}

type LanguageOutcome<T> = Readonly<{
  language: MemoryEvaluationLanguage;
  outcome: T;
}>;

export type MemoryBinaryScore = Readonly<{
  cohort: string;
  display: Readonly<{ lower: number; point: number; upper: number }>;
  gate: MemoryQualityGate | null;
  gatePassed: boolean | null;
  interval: MemoryInterval;
  language: MemoryEvaluationLanguage;
  metric: MemoryBinaryMetric;
  negativeCount: number;
  point: number;
  positiveCount: number;
  total: number;
}>;

export function scoreMemoryBinaryOutcomes(
  outcomes: readonly LanguageOutcome<MemoryBinaryOutcome>[]
): MemoryBinaryScore[] {
  const groups = new Map<string, LanguageOutcome<MemoryBinaryOutcome>[]>();
  for (const item of outcomes) {
    const key = `${item.language}\u0000${item.outcome.cohort}\u0000${item.outcome.metric}`;
    const values = groups.get(key) ?? [];
    values.push(item);
    groups.set(key, values);
  }
  return [...groups.values()].map((values) => {
    const first = values[0]!;
    const positiveCount = values.filter(({ outcome }) => outcome.positive).length;
    const total = values.length;
    const point = positiveCount / total;
    const interval = wilson95(positiveCount, total);
    const gate = MEMORY_BINARY_QUALITY_GATES[first.outcome.metric] ?? null;
    return {
      cohort: first.outcome.cohort,
      display: {
        lower: roundMemoryMetricForDisplay(interval.lower),
        point: roundMemoryMetricForDisplay(point),
        upper: roundMemoryMetricForDisplay(interval.upper)
      },
      gate,
      gatePassed: gate ? gatePasses(point, interval, gate) : null,
      interval,
      language: first.language,
      metric: first.outcome.metric,
      negativeCount: total - positiveCount,
      point,
      positiveCount,
      total
    };
  }).sort((left, right) =>
    compareMemoryEvaluationText(
      `${left.language}:${left.cohort}:${left.metric}`,
      `${right.language}:${right.cohort}:${right.metric}`
    )
  );
}

export type MemoryRankedScore = Readonly<{
  cohort: string;
  display: Readonly<{ lower: number; point: number; upper: number }>;
  gate: MemoryQualityGate | null;
  gatePassed: boolean | null;
  interval: MemoryInterval;
  language: MemoryEvaluationLanguage;
  metric: MemoryRankedMetric;
  point: number;
  strata: number;
  total: number;
}>;

export function scoreMemoryRankedOutcomes(
  outcomes: readonly LanguageOutcome<MemoryRankedOutcome>[],
  input: { samples: number; seed: number }
): MemoryRankedScore[] {
  const groups = new Map<string, LanguageOutcome<MemoryRankedOutcome>[]>();
  for (const item of outcomes) {
    const key = `${item.language}\u0000${item.outcome.cohort}\u0000${item.outcome.metric}`;
    const values = groups.get(key) ?? [];
    values.push(item);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, values]) => {
    const first = values[0]!;
    const point = values.reduce((sum, { outcome }) => sum + outcome.score, 0) / values.length;
    const interval = stratifiedBootstrap95(
      values.map(({ outcome }) => ({ score: outcome.score, stratum: outcome.stratum })),
      { samples: input.samples, seed: deriveMemoryEvaluationSeed(input.seed, key) }
    );
    const gate = MEMORY_RANKED_QUALITY_GATES[first.outcome.metric] ?? null;
    return {
      cohort: first.outcome.cohort,
      display: {
        lower: roundMemoryMetricForDisplay(interval.lower),
        point: roundMemoryMetricForDisplay(point),
        upper: roundMemoryMetricForDisplay(interval.upper)
      },
      gate,
      gatePassed: gate ? gatePasses(point, interval, gate) : null,
      interval,
      language: first.language,
      metric: first.outcome.metric,
      point,
      strata: new Set(values.map(({ outcome }) => outcome.stratum)).size,
      total: values.length
    };
  }).sort((left, right) =>
    compareMemoryEvaluationText(
      `${left.language}:${left.cohort}:${left.metric}`,
      `${right.language}:${right.cohort}:${right.metric}`
    )
  );
}

export type MemoryHardInvariantScore = Readonly<{
  category: MemoryHardInvariantCategory;
  checks: number;
  complete: boolean;
  failures: number;
  invariant: MemoryHardInvariant;
  passed: boolean;
}>;

export type MemoryHardInvariantSuiteScore = Readonly<{
  byCategory: Readonly<Record<MemoryHardInvariantCategory, boolean>>;
  complete: boolean;
  passed: boolean;
  results: readonly MemoryHardInvariantScore[];
}>;

export function scoreMemoryHardInvariants(
  observations: readonly MemoryHardInvariantObservation[]
): MemoryHardInvariantSuiteScore {
  const aggregate = new Map<MemoryHardInvariant, { checks: number; failures: number }>();
  for (const observation of observations) {
    const current = aggregate.get(observation.invariant) ?? { checks: 0, failures: 0 };
    current.checks += observation.checks;
    current.failures += observation.failures;
    aggregate.set(observation.invariant, current);
  }
  const results = MEMORY_HARD_INVARIANT_DEFINITIONS.map(({ category, code }) => {
    const score = aggregate.get(code);
    const complete = score !== undefined && score.checks > 0;
    return {
      category,
      checks: score?.checks ?? 0,
      complete,
      failures: score?.failures ?? 0,
      invariant: code,
      passed: complete && score?.failures === 0
    };
  });
  const categories = ["PRIVACY", "SAFETY", "LIFECYCLE", "RUN"] as const;
  const byCategory = Object.fromEntries(categories.map((category) => [
    category,
    results.filter((result) => result.category === category).every((result) => result.passed)
  ])) as Record<MemoryHardInvariantCategory, boolean>;
  return {
    byCategory,
    complete: results.every((result) => result.complete),
    passed: results.every((result) => result.passed),
    results
  };
}

export type MemoryOperationScore = Readonly<{
  costComplete: boolean;
  inputTokens: number | null;
  latencyMs: Readonly<{ max: number; p50: number; p95: number }>;
  operationCount: number;
  outputTokens: number | null;
  retries: number;
  role: MemoryCapabilityRole;
  totalEstimatedCostUsd: number | null;
  usageComplete: boolean;
}>;

export function scoreMemoryOperations(
  observations: readonly MemoryOperationObservation[]
): MemoryOperationScore[] {
  const groups = new Map<MemoryCapabilityRole, MemoryOperationObservation[]>();
  for (const observation of observations) {
    const values = groups.get(observation.role) ?? [];
    values.push(observation);
    groups.set(observation.role, values);
  }
  return [...groups.entries()].map(([role, values]) => {
    const latencies = values.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
    const usageComplete = values.every(({ inputTokens, outputTokens }) =>
      inputTokens !== null && outputTokens !== null
    );
    const costComplete = values.every(({ estimatedCostUsd }) => estimatedCostUsd !== null);
    return {
      costComplete,
      inputTokens: usageComplete
        ? values.reduce((sum, value) => sum + value.inputTokens!, 0)
        : null,
      latencyMs: {
        max: latencies[latencies.length - 1]!,
        p50: quantile(latencies, 0.5),
        p95: quantile(latencies, 0.95)
      },
      operationCount: values.length,
      outputTokens: usageComplete
        ? values.reduce((sum, value) => sum + value.outputTokens!, 0)
        : null,
      retries: values.reduce((sum, value) => sum + value.retries, 0),
      role,
      totalEstimatedCostUsd: costComplete
        ? values.reduce((sum, value) => sum + value.estimatedCostUsd!, 0)
        : null,
      usageComplete
    };
  }).sort((left, right) => compareMemoryEvaluationText(left.role, right.role));
}
