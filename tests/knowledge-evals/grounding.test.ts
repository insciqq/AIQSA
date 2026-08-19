import { describe, expect, it } from "vitest";
import {
  assertKnowledgeGroundingEvalGates,
  runKnowledgeGroundingEval
} from "./grounding";

describe("Knowledge grounding golden evaluation", () => {
  it("passes citation, unsupported-claim, no-answer, repair, and injection launch gates", () => {
    const report = runKnowledgeGroundingEval();
    expect(() => assertKnowledgeGroundingEvalGates(report)).not.toThrow();
    expect(report).toMatchObject({
      fixtureCount: 15,
      metrics: {
        boundedRepair: true,
        citationCoverage: 1,
        citationHandleValidity: 1,
        citationPrecision: 1,
        correctNoAnswer: 1,
        expectedPassAccuracy: 1,
        promptInjectionBlocked: true,
        unsupportedFinalClaimRate: 0
      },
      passed: true,
      version: 1
    });
    expect(JSON.stringify(report)).not.toMatch(
      /INJECTION_SUCCESS|synthetic-base|30 days|private launch/u
    );
  });

  it("is deterministic and emits only aggregate evidence", () => {
    expect(runKnowledgeGroundingEval()).toEqual(runKnowledgeGroundingEval());
  });
});
