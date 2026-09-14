import { describe, expect, it, vi } from "vitest";
import type { AcceptanceDriver, Identity, SendResult } from "./driver";
import type { Scenario } from "./contract";
import { evaluateScenario } from "./evaluate";

const owner: Identity = { userId: "synthetic-owner", cookie: "synthetic-session" };
const judgeIdentity: Identity = { userId: "synthetic-judge", cookie: "synthetic-judge-session" };
const reply: SendResult = { answer: "York", runId: "synthetic-run", userMessageId: "synthetic-message",
  memoryOutcome: "USED", degradationCode: null, memoryItems: 1, ownerIsolation: true, elapsedMs: 10, totalTokens: 10 };
const scenario: Scenario = { id: "acquisition-independent-judge", category: "acquisition", partition: "development",
  language: "en", steps: [{ action: "check", question: "Where do I live?", expectation: "York", surface: "both" }] };

function reader() {
  return { identity: vi.fn(async () => owner), search: vi.fn(async () => [{ statement: "York", memoryRef: "synthetic-reference" }]),
    searchExecutions: [{ healthy: true }], probe: vi.fn(async () => reply), quiesce: vi.fn(async () => undefined) };
}
function scorer() {
  return { conversation: vi.fn(() => ({ id: "synthetic-judge-chat", leaf: null, mode: "EXCLUDED" as const })),
    send: vi.fn<AcceptanceDriver["send"]>(async () => ({ ...reply, memoryItems: 0, memoryOutcome: "DISABLED",
      answer: JSON.stringify({ passed: true, reason: "SUPPORTED", matchingIndices: [0] }) })) };
}

describe("separate answer and judge models", () => {
  it("routes both memory and answer verdicts through the independent judge", async () => {
    const primary = { ...reader(), send: vi.fn(async () => { throw new Error("wrong_judge_model"); }) };
    const judge = scorer();
    const evaluated = await evaluateScenario(primary as unknown as AcceptanceDriver, judgeIdentity, scenario,
      () => undefined, judge as unknown as AcceptanceDriver);
    expect(evaluated.result).toMatchObject({ complete: true, healthy: true, failureCode: null,
      checks: [{ surface: "facts", passed: true }, { surface: "answer", passed: true }] });
    expect(primary.probe).toHaveBeenCalledWith(owner, "Where do I live?", undefined);
    expect(primary.send).not.toHaveBeenCalled();
    expect(judge.send).toHaveBeenCalledTimes(2);
    expect(judge.send.mock.calls.every(([identity]) => identity === judgeIdentity)).toBe(true);
    expect(primary.quiesce).toHaveBeenCalledWith(owner);
  });

  it("keeps the primary driver as judge when no separate model is selected", async () => {
    const primary = { ...reader(), ...scorer() };
    const evaluated = await evaluateScenario(primary as unknown as AcceptanceDriver, judgeIdentity, scenario,
      () => undefined);
    expect(evaluated.result.healthy).toBe(true);
    expect(evaluated.result.checks.every(({ passed }) => passed)).toBe(true);
    expect(primary.send).toHaveBeenCalledTimes(2);
  });
});
