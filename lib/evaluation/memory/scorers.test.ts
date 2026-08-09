import { describe, expect, it } from "vitest";
import { zeroMemoryHardInvariantObservations } from "./contracts";
import {
  compareMemoryMetricUnrounded,
  roundMemoryMetricForDisplay,
  scoreMemoryBinaryOutcomes,
  scoreMemoryHardInvariants,
  scoreMemoryOperations,
  scoreMemoryRankedOutcomes,
  stratifiedBootstrap95,
  wilson95
} from "./scorers";

describe("Memory evaluation scorers", () => {
  it("computes Wilson 95% intervals without continuity correction", () => {
    expect(wilson95(95, 100)).toEqual({
      confidence: 0.95,
      lower: expect.closeTo(0.888_249, 5),
      method: "WILSON",
      upper: expect.closeTo(0.978_456, 5)
    });
    expect(() => wilson95(2, 1)).toThrow("memory_evaluation_invalid_wilson_counts");
  });

  it("compares raw values before three-decimal display rounding", () => {
    expect(roundMemoryMetricForDisplay(0.9496)).toBe(0.95);
    expect(compareMemoryMetricUnrounded(0.9496, "MINIMUM", 0.95)).toBe(false);

    const outcomes = Array.from({ length: 10_000 }, (_, index) => ({
      language: "RU" as const,
      outcome: {
        cohort: "critical-russian",
        metric: "AUTOMATIC_FACT_PRECISION" as const,
        positive: index < 9_496
      }
    }));
    const [score] = scoreMemoryBinaryOutcomes(outcomes);
    expect(score).toMatchObject({
      display: { point: 0.95 },
      gatePassed: false,
      point: 0.9496
    });
  });

  it("uses deterministic stratified bootstrap intervals for ranked retrieval", () => {
    const observations = [
      { score: 1, stratum: "ru-temporal" },
      { score: 0.8, stratum: "ru-temporal" },
      { score: 0.9, stratum: "ru-update" },
      { score: 0.7, stratum: "ru-update" }
    ];
    const first = stratifiedBootstrap95(observations, { samples: 2_000, seed: 91 });
    const second = stratifiedBootstrap95(observations, { samples: 2_000, seed: 91 });
    expect(second).toEqual(first);
    expect(stratifiedBootstrap95([...observations].reverse(), {
      samples: 2_000,
      seed: 91
    })).toEqual(first);
    expect(first).toMatchObject({
      confidence: 0.95,
      lower: expect.any(Number),
      method: "STRATIFIED_BOOTSTRAP",
      upper: expect.any(Number)
    });

    const ranked = scoreMemoryRankedOutcomes(
      observations.map(({ score, stratum }) => ({
        language: "RU" as const,
        outcome: {
          cohort: "overall",
          metric: "CURATED_RECALL_AT_5" as const,
          score,
          stratum
        }
      })),
      { samples: 2_000, seed: 91 }
    );
    expect(ranked).toMatchObject([{
      gate: { intervalEndpoint: "LOWER", pointThreshold: 0.85 },
      language: "RU",
      metric: "CURATED_RECALL_AT_5",
      point: expect.closeTo(0.85, 12),
      strata: 2,
      total: 4
    }]);
  });

  it("never averages away missing or failing hard invariants", () => {
    const incomplete = scoreMemoryHardInvariants(
      zeroMemoryHardInvariantObservations().slice(1)
    );
    expect(incomplete).toMatchObject({ complete: false, passed: false });
    expect(incomplete.results[0]).toMatchObject({
      checks: 0,
      complete: false,
      invariant: "CROSS_USER_LEAKAGE",
      passed: false
    });

    const unsafe = scoreMemoryHardInvariants(
      zeroMemoryHardInvariantObservations().map((item) =>
        item.invariant === "SECRET_PROVIDER_EGRESS" ? { ...item, failures: 1 } : item
      )
    );
    expect(unsafe).toMatchObject({ complete: true, passed: false });
    expect(unsafe.byCategory.SAFETY).toBe(false);
  });

  it("reports latency, retry, token, and cost completeness without estimation", () => {
    const scores = scoreMemoryOperations([
      {
        estimatedCostUsd: 0.01,
        inputTokens: 10,
        latencyMs: 30,
        outputTokens: 5,
        retries: 1,
        role: "MEMORY_FACT_EXTRACT"
      },
      {
        estimatedCostUsd: null,
        inputTokens: null,
        latencyMs: 10,
        outputTokens: null,
        retries: 0,
        role: "MEMORY_FACT_EXTRACT"
      }
    ]);
    expect(scores).toEqual([{
      costComplete: false,
      inputTokens: null,
      latencyMs: { max: 30, p50: 20, p95: 29 },
      operationCount: 2,
      outputTokens: null,
      retries: 1,
      role: "MEMORY_FACT_EXTRACT",
      totalEstimatedCostUsd: null,
      usageComplete: false
    }]);
  });
});
