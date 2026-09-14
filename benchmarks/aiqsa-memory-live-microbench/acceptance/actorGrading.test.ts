import { describe, expect, it } from "vitest";
import { JUDGE_SYSTEM, judgePayload, type Probe } from "./contract";
import { ACTOR_JUDGE_INSTRUCTION, actorAwareJudgeInput } from "./actorGrading";

describe("judge account attribution", () => {
  const probe: Probe = { action: "check", surface: "facts", question: "Where do I live?", expectation: "Quito." };

  it("keeps the existing default-account and upstream protocol byte-identical", () => {
    expect(actorAwareJudgeInput(JUDGE_SYSTEM, probe, "facts", ["Quito"]))
      .toEqual({ system: JUDGE_SYSTEM, payload: judgePayload(probe, "facts", ["Quito"]) });
  });

  it("binds another account as evaluation data without turning its label into an instruction", () => {
    const result = actorAwareJudgeInput(JUDGE_SYSTEM, { ...probe, actor: "other" }, "facts", ["Quito"]);
    expect(result.system).toBe(`${JUDGE_SYSTEM} ${ACTOR_JUDGE_INSTRUCTION}`);
    expect(JSON.parse(result.payload)).toEqual({ ...JSON.parse(judgePayload(probe, "facts", ["Quito"])), evaluatedActor: "other" });
  });
});
