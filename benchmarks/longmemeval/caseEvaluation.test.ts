import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadLongMemEvalLatestCaseEvaluations,
  readLongMemEvalCaseEvaluation,
  settleLongMemEvalCaseEvaluation
} from "./caseEvaluation";

function evaluator(label: boolean) {
  return vi.fn(async (hypotheses: readonly Readonly<{
    hypothesis: string;
    questionId: string;
  }>[]) => {
    const hypothesis = hypotheses[0]!;
    const row = Object.freeze({
      label,
      questionId: hypothesis.questionId,
      value: {
        autoeval_label: {
          label,
          model: "gpt-4o-2024-08-06"
        },
        hypothesis: hypothesis.hypothesis,
        question_id: hypothesis.questionId
      }
    });
    return Object.freeze({
      labels: new Map([[hypothesis.questionId, label]]),
      rows: Object.freeze([row]),
      shards: 1
    });
  });
}

describe("LongMemEval per-case evaluator journal", () => {
  it("persists one answer-bound official result and reuses it exactly", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aiqsa-lme-case-eval-"));
    try {
      const runEvaluator = evaluator(false);
      const input = {
        attempt: 1,
        hypothesis: "A grounded answer.",
        outputDirectory: root,
        questionId: "case_01"
      };

      const first = await settleLongMemEvalCaseEvaluation(input, runEvaluator);
      const second = await settleLongMemEvalCaseEvaluation(input, runEvaluator);

      expect(first).toMatchObject({
        attempt: 1,
        label: false,
        questionId: "case_01",
        version: 1
      });
      expect(second).toEqual(first);
      expect(runEvaluator).toHaveBeenCalledOnce();
      await expect(loadLongMemEvalLatestCaseEvaluations({
        hypotheses: [{
          hypothesis: input.hypothesis,
          questionId: input.questionId
        }],
        outputDirectory: root
      })).resolves.toEqual([first]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects reuse when the latest answer no longer matches the journal", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "aiqsa-lme-case-eval-"));
    try {
      await settleLongMemEvalCaseEvaluation({
        attempt: 2,
        hypothesis: "Original answer.",
        outputDirectory: root,
        questionId: "case_02"
      }, evaluator(true));

      await expect(readLongMemEvalCaseEvaluation({
        attempt: 2,
        hypothesis: "Different answer.",
        outputDirectory: root,
        questionId: "case_02"
      })).rejects.toThrow("longmemeval_case_evaluation_invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
