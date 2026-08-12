import { describe, expect, it } from "vitest";
import {
  memoryLearningMatrixBaseCandidate,
  memoryLearningMatrixCases,
  memoryLearningMatrixGoldPlan,
  memoryLearningVerificationCases
} from "../../../scripts/memory-learning-beta-evaluation";
import { evaluateMemoryFactConsolidationPlan } from
  "../../server/memory/learning/consolidation/policy";

describe("automatic Memory verifier qualification fixtures", () => {
  const matrices = memoryLearningMatrixCases({
    EN: memoryLearningMatrixBaseCandidate("EN"),
    RU: memoryLearningMatrixBaseCandidate("RU")
  }, 3);
  const verificationCases = memoryLearningVerificationCases(matrices, 24);

  it("uses a fixed balanced gold matrix independent of provider outputs", () => {
    expect(matrices).toHaveLength(42);
    expect(verificationCases).toHaveLength(48);
    expect(() => memoryLearningVerificationCases(matrices, 30)).toThrowError(
      "memory_learning_verification_case_count_invalid"
    );

    for (const language of ["RU", "EN"] as const) {
      for (const operation of ["ADD", "SUPERSEDE", "CONFLICT", "EXPIRE"] as const) {
        for (const variant of ["supported", "mismatched_target"] as const) {
          expect(verificationCases.filter((candidate) =>
            candidate.language === language &&
            candidate.operation === operation &&
            candidate.variant === variant
          )).toHaveLength(3);
        }
      }
    }
  });

  it("constructs every positive verifier case from a policy-valid risky transition", () => {
    for (const matrix of matrices.filter(({ expected }) =>
      ["ADD", "SUPERSEDE", "CONFLICT", "EXPIRE"].includes(expected)
    )) {
      const plan = memoryLearningMatrixGoldPlan(matrix);
      expect(evaluateMemoryFactConsolidationPlan(matrix.input, plan)).toEqual({
        requiresVerification: true,
        status: "VALID"
      });
    }
  });

  it("expires the same value and mismatches only the negative decision target", () => {
    for (const matrix of matrices.filter(({ expected }) => expected === "EXPIRE")) {
      const target = matrix.input.relatedFacts[0]?.versions[0];
      expect(target?.structuredValue).toEqual(matrix.input.candidate.proposedValue);
    }

    for (const negative of verificationCases.filter(({ variant }) =>
      variant === "mismatched_target"
    )) {
      expect(negative.expectedApprove).toBe(false);
      expect(negative.input.decision.targetFactId).toBe("qualification-mismatched-fact");
      expect(negative.input.decision.targetVersionId).toBe(
        "qualification-mismatched-version"
      );
    }
  });
});
