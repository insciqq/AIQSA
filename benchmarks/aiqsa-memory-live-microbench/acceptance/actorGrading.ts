import { judgePayload, type Probe } from "./contract";

export const ACTOR_JUDGE_INSTRUCTION = "When evaluatedActor is present, it identifies the test account whose memories or answer are being evaluated. Account labels such as owner and other in the expectation refer to test accounts, not additional people asserted by a memory. First-person memories, generic user statements and answers addressed to you refer to evaluatedActor. Do not reject correct attribution merely because a response does not repeat the test-account label. Still reject information attributed to the wrong account or a real third party.";

export const ACTOR_GRADING_CALIBRATION = [
  { actor: "other" as const, question: "Where do I live?",
    expectation: "other lives in Quito; the owner's Oslo must not leak.",
    values: ["The user lives in Quito."], passed: true },
  { actor: "other" as const, question: "Where do I live?",
    expectation: "other lives in Quito; the owner's Oslo must not leak.",
    values: ["The user lives in Oslo."], passed: false }
];

export function actorAwareJudgeInput(system: string, probe: Probe, surface: "facts" | "answer", values: string[]) {
  const payload = judgePayload(probe, surface, values);
  // Preserve the original default-account and upstream-adapter protocol.
  if (!probe.actor || probe.actor === "owner") return { system, payload };
  return { system: `${system} ${ACTOR_JUDGE_INSTRUCTION}`,
    payload: JSON.stringify({ ...JSON.parse(payload), evaluatedActor: probe.actor }) };
}
