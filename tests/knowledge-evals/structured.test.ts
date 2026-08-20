import { describe, expect, it } from "vitest";
import {
  assertKnowledgeStructuredEvalGates,
  runKnowledgeStructuredEval
} from "./structured";

describe("Knowledge structured-data golden evaluation", () => {
  it("passes exactness, safety, format, routing, and latency gates", async () => {
    const report = await runKnowledgeStructuredEval();
    expect(() => assertKnowledgeStructuredEvalGates(report)).not.toThrow();
    expect(report).toMatchObject({
      fixtureCount: 25,
      metrics: {
        ambiguitySafety: 1,
        arithmeticCorrectness: 1,
        boundedFailure: 1,
        cachedFormula: 1,
        dateExactness: 1,
        formatPassRate: 1,
        formulaInjectionBlocked: true,
        hiddenPolicy: 1,
        localeExactness: 1,
        missingValue: 1,
        multiSheet: 1,
        numericExactness: 1,
        ordinaryFallback: 1,
        plannerRouting: 1
      },
      passed: true,
      version: 2
    });
    expect(report.metrics.executionP95Ms).toBeLessThanOrEqual(
      report.gates.maximumExecutionP95Ms
    );
  });

  it("emits aggregate-only evidence", async () => {
    const report = await runKnowledgeStructuredEval();
    expect(JSON.stringify(report)).not.toMatch(
      /HYPERLINK|Revenue|Sales|Forecast|synthetic-structured/u
    );
  });
});
