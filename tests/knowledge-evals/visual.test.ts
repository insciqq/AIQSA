import { describe, expect, it } from "vitest";
import {
  assertKnowledgeVisualEvalGates,
  runKnowledgeVisualEval
} from "./visual";

describe("Knowledge visual-evidence golden evaluation", () => {
  it("passes region, egress, scope, injection, outage, and fallback gates", async () => {
    const report = await runKnowledgeVisualEval();
    expect(() => assertKnowledgeVisualEvalGates(report)).not.toThrow();
    expect(report).toMatchObject({
      fixtureCount: 9,
      metrics: {
        ambiguitySafety: 1,
        approvedEgress: 1,
        boundedSource: 1,
        exactRegion: 1,
        localOnlyFallback: 1,
        ordinaryFallback: 1,
        outageFallback: 1,
        promptInjectionBoundary: 1,
        scopeIsolation: 1
      },
      passed: true,
      version: 1
    });
  });

  it("emits aggregate-only evidence", async () => {
    const report = await runKnowledgeVisualEval();
    expect(JSON.stringify(report)).not.toMatch(
      /Quarterly|Private appendix|Ignore previous|vision-model|original\//u
    );
  });
});
