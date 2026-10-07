import { describe, expect, it } from "vitest";
import { reportedCostMicros } from "../../domain/usage";
import { reportedUsageCostUsd } from "./reportedUsageCost";

describe("OpenRouter reported spend", () => {
  it("is cost alone for an ordinary call, whose upstream cost OpenRouter already paid", () => {
    // The embedding usage block probed 2026-10-07 (qwen/qwen3-embedding-8b).
    expect(reportedUsageCostUsd({ prompt_tokens: 5, total_tokens: 5, cost: 5e-8, is_byok: false,
      cost_details: { upstream_inference_cost: 5e-8, upstream_inference_prompt_cost: 5e-8, upstream_inference_completions_cost: 0 } }))
      .toBe(5e-8);
    // The rerank usage block probed 2026-10-07 (voyageai/rerank-2.5).
    expect(reportedUsageCostUsd({ total_tokens: 2, cost: 1e-7 })).toBe(1e-7);
    expect(reportedUsageCostUsd({ cost: 0 })).toBe(0);
  });

  it("adds the upstream provider's charge to OpenRouter's fee for a BYOK call", () => {
    expect(reportedUsageCostUsd({ cost: 2.5e-9, is_byok: true,
      cost_details: { upstream_inference_cost: 5e-8, upstream_inference_prompt_cost: 5e-8 } })).toBe(5.25e-8);
    expect(reportedUsageCostUsd({ cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } }))
      .toBe(0.0021);
    // The exact decimal sum, which binary addition misses.
    expect(1.1e-7 + 3.9e-7).not.toBe(5e-7);
    const sum = reportedUsageCostUsd({ cost: 1.1e-7, is_byok: true, cost_details: { upstream_inference_cost: 3.9e-7 } });
    expect(sum).toBe(5e-7);
    expect(reportedCostMicros(sum!)).toBe(1);
  });

  it("reports nothing without a cost, and no usable spend for a BYOK call without its upstream cost", () => {
    expect(reportedUsageCostUsd({ prompt_tokens: 5 })).toBeUndefined();
    expect(reportedUsageCostUsd({ cost: 0.0001, is_byok: true })).toBeUndefined();
    expect(reportedUsageCostUsd({ cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: null } })).toBeUndefined();
    expect(reportedUsageCostUsd({ cost: 0.0001, is_byok: true, cost_details: [] })).toBeUndefined();
  });

  it("flags a malformed amount so strict adapters reject it", () => {
    for (const cost of [-0.01, "0.0001", null, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reportedUsageCostUsd({ cost })).toBeNull();
    }
    for (const upstream of [-1e-7, "1e-7", false, Number.POSITIVE_INFINITY]) {
      expect(reportedUsageCostUsd({ cost: 1e-7, is_byok: true, cost_details: { upstream_inference_cost: upstream } })).toBeNull();
    }
    // A non-BYOK call never reads the upstream amount.
    expect(reportedUsageCostUsd({ cost: 1e-7, is_byok: "true", cost_details: { upstream_inference_cost: -1 } })).toBe(1e-7);
  });
});
