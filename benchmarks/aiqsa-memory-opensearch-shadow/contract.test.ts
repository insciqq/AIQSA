import { describe, expect, it } from "vitest";
import {
  MEMORY_OPENSEARCH_SHADOW_CORPUS,
  MEMORY_OPENSEARCH_SHADOW_CORPUS_FINGERPRINT,
  MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS,
  qualificationAdditiveOverlapReview,
  qualificationJaccard,
  qualificationPercentile,
  qualificationSignedPercentile
} from "./contract";

describe("Memory OpenSearch shadow qualification contract", () => {
  it("freezes every required language/script cohort without duplicate case keys", () => {
    expect(new Set(MEMORY_OPENSEARCH_SHADOW_CORPUS.map(({ key }) => key)).size)
      .toBe(MEMORY_OPENSEARCH_SHADOW_CORPUS.length);
    expect(new Set(MEMORY_OPENSEARCH_SHADOW_CORPUS.map(({ cohort }) => cohort)))
      .toEqual(new Set(MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS));
    expect(MEMORY_OPENSEARCH_SHADOW_CORPUS_FINGERPRINT)
      .toMatch(/^[a-f0-9]{64}$/u);
  });

  it("computes deterministic nearest-rank percentiles and set Jaccard", () => {
    expect(qualificationPercentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(qualificationPercentile([4, 1, 3, 2], 0.95)).toBe(4);
    expect(qualificationSignedPercentile([-0.5, 0.25, 0], 0.5)).toBe(0);
    expect(qualificationJaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(qualificationJaccard([], [])).toBe(1);
  });

  it("reviews only additive low-overlap expansions with no relevant-rank loss", () => {
    expect(qualificationAdditiveOverlapReview({
      firstRelevantReciprocalRankDeltas: [0, 0.5],
      top10BaselineContained: [true, true]
    })).toBe(true);
    expect(qualificationAdditiveOverlapReview({
      firstRelevantReciprocalRankDeltas: [-0.01],
      top10BaselineContained: [true]
    })).toBe(false);
    expect(qualificationAdditiveOverlapReview({
      firstRelevantReciprocalRankDeltas: [0.5],
      top10BaselineContained: [false]
    })).toBe(false);
  });
});
