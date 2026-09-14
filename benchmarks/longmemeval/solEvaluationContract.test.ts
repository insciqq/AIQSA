import { describe, expect, it } from "vitest";
import { parseSolVerdict, validateHypotheses } from "./solEvaluationContract";

describe("separately labeled Sol evaluation", () => {
  it("rejects ambiguous answers rather than matching yes inside other text", () => {
    expect(parseSolVerdict("YES.")).toBe(true);
    expect(parseSolVerdict("no")).toBe(false);
    expect(() => parseSolVerdict("Yesterday, no.")).toThrow("verdict_invalid");
    expect(() => parseSolVerdict("yes or no")).toThrow("verdict_invalid");
  });
  it("preserves missing answers as denominator failures and rejects foreign/duplicate identities", () => {
    const row = { question_id: "q1", hypothesis: "answer" };
    expect(validateHypotheses([row], ["q1", "q2"])).toHaveLength(1);
    expect(() => validateHypotheses([row, row], ["q1", "q2"])).toThrow("identity_invalid");
    expect(() => validateHypotheses([row], ["q2"])).toThrow("identity_invalid");
  });
});
