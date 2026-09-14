import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import selection from "./memory-quality-selection.json";
import { LONGMEMEVAL_QUESTION_TYPES, LONGMEMEVAL_S_SHA256 } from "./contract";

describe("Memory quality LongMemEval selection", () => {
  it("preserves the reused fifty and the independently frozen reserved set", () => {
    const prior = JSON.parse(readFileSync(new URL("./qualifications/fu09-blind-50-v1.json", import.meta.url), "utf8"));
    expect(selection.datasetSha256).toBe(LONGMEMEVAL_S_SHA256);
    expect(selection.regression.cases).toEqual(prior.selection.cases);
    const regressionIds = new Set(selection.regression.cases.map((item) => item.questionId));
    expect(regressionIds.size).toBe(50);
    expect(new Set(selection.heldout.cases.map((item) => item.questionId)).size).toBe(12);
    expect(selection.heldout.cases.some((item) => regressionIds.has(item.questionId))).toBe(false);
    for (const category of LONGMEMEVAL_QUESTION_TYPES) {
      expect(selection.heldout.cases.filter((item) => item.questionType === category)).toHaveLength(2);
    }
    expect(createHash("sha256").update(JSON.stringify(selection.heldout.cases)).digest("hex"))
      .toBe("b0f870e124c6ddcc653e25762c8952903de74adfabf9b1a9b975de7777b5750c");
  });
});
