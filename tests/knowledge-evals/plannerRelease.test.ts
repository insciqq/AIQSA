import { beforeAll, describe, expect, it } from "vitest";
import {
  assertKnowledgePlannerReleaseGates,
  KNOWLEDGE_PLANNER_RELEASE_REPORT_VERSION,
  type KnowledgePlannerReleaseReport
} from "./plannerRelease";

describe("Knowledge planner release evaluation", () => {
  let evaluated: KnowledgePlannerReleaseReport | null = null;

  beforeAll(async () => {
    evaluated = await assertKnowledgePlannerReleaseGates();
  });

  function report(): KnowledgePlannerReleaseReport {
    if (!evaluated) throw new Error("knowledge_planner_release_eval_not_run");
    return evaluated;
  }

  it("passes the content-free deterministic EN/RU planner and target gates", () => {
    const result = report();

    expect(result).toMatchObject({
      aggregateOnly: true,
      contentFree: true,
      execution: {
        costMicros: 0,
        egress: "none",
        implementation: "deterministic_planner_v2",
        providerCalls: 0
      },
      passed: true,
      plannerVersion: 2,
      version: KNOWLEDGE_PLANNER_RELEASE_REPORT_VERSION
    });
    expect(result.metrics.intentAccuracy.en.rate).toBe(1);
    expect(result.metrics.intentAccuracy.ru.rate).toBe(1);
    expect(result.metrics.exactTermPreservation.overall.rate).toBe(1);
    expect(result.metrics.targetResolution.rate).toBe(1);
    expect(result.metrics.ambiguitySafety.rate).toBe(1);
    expect(result.metrics.unnecessaryRetrievalAvoidance.rate).toBe(1);
    expect(result.metrics.deterministicOutageFallback.rate).toBe(1);
    expect(result.latency.p50Milliseconds).toBeGreaterThanOrEqual(0);
    expect(result.latency.p95Milliseconds).toBeLessThanOrEqual(
      result.latency.p95ThresholdMilliseconds
    );
  });

  it("reports the inactive profile role without claiming a System Model comparison", () => {
    const result = report();

    expect(result.knowledgeProfile.queryPlanning).toEqual({
      contractDecoded: true,
      costMicros: 0,
      egress: "none",
      fallback: "deterministic_planner",
      maxCostMicros: 0,
      maxInputBytes: 0,
      maxInputTokens: 0,
      mode: "disabled",
      providerCalls: 0,
      providerModelConfigured: false,
      rawPrivateText: false,
      retention: "none"
    });
    expect(result.systemModelComparison).toEqual({
      claimed: false,
      profileAuthorized: false,
      reason: "query_planning_role_disabled",
      status: "not_run"
    });
    expect(result.execution).toMatchObject({ providerCalls: 0, costMicros: 0, egress: "none" });
  });

  it("does not expose fixture queries, Source ids, or labels in its JSON report", () => {
    const serialized = JSON.stringify(report());

    for (const privateFixtureValue of [
      "11111111-1111-4111-8111-111111111111",
      "Alpha Policy",
      "retention policy",
      "срок хранения"
    ]) {
      expect(serialized).not.toContain(privateFixtureValue);
    }
  });
});
