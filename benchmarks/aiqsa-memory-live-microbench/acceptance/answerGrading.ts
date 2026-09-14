import type { AcceptanceDriver, Identity } from "./driver";
import { JUDGE_SYSTEM, decodeJudgement, type Probe } from "./contract";
import { actorAwareJudgeInput } from "./actorGrading";

export const ANSWER_JUDGE_SYSTEM = `${JUDGE_SYSTEM} For answer-only evaluation, require the expected information needed to answer the actual question. The expectation may also contain background details for checking stored facts: do not require the answer to volunteer those unasked details. Still reject a missing requested detail, a wrong attribution, an unsupported assertion, or an answer contradicted by the expectation.`;

export const ANSWER_GRADING_CALIBRATION = [
  { question: "Which city do I live in?", expectation: "The user lives in York and their brother is a doctor.",
    values: ["You live in York."], passed: true, answer: true },
  { question: "Which days do I commute and what train do I take?",
    expectation: "Tuesdays and Thursdays on the 07:10 train; other days work from home.",
    values: ["You commute on Tuesdays and Thursdays."], passed: false, answer: true }
];

export async function judgeAnswer(driver: AcceptanceDriver, identity: Identity, probe: Probe, values: string[]) {
  const input = actorAwareJudgeInput(ANSWER_JUDGE_SYSTEM, probe, "answer", values);
  const response = await driver.send(identity, driver.conversation("EXCLUDED"),
    `${input.system}\n\nEvaluation data (JSON):\n${input.payload}`);
  if (!response.ownerIsolation || response.memoryItems !== 0 ||
    ["DEGRADED", "FAILED_SAFE"].includes(response.memoryOutcome)) {
    throw new Error("memory_acceptance_judge_memory_contaminated");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(response.answer.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")); }
  catch { throw new Error("memory_acceptance_judge_json_invalid"); }
  return decodeJudgement(parsed, values.length);
}
