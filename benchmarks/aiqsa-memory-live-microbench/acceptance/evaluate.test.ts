import { describe, expect, it, vi } from "vitest";
import type { AcceptanceDriver, Identity, SendResult } from "./driver";
import type { Scenario } from "./contract";
import { SOURCE_AWARE_GRADING_CALIBRATION, evaluateScenario } from "./evaluate";

const owner: Identity = { userId: "synthetic-owner", cookie: "synthetic-session" };
const judgeIdentity: Identity = { userId: "synthetic-judge", cookie: "synthetic-judge-session" };
const reply: SendResult = { answer: "York", runId: "synthetic-run", userMessageId: "synthetic-message",
  memoryOutcome: "USED", degradationCode: null, memoryItems: 1, ownerIsolation: true,
  deliveredMemoryEvidence: [], elapsedMs: 10, totalTokens: 10,
  userMessageCreatedAt: "2026-09-14T00:00:00.000Z" };
const scenario: Scenario = { id: "acquisition-independent-judge", category: "acquisition", partition: "development",
  language: "en", steps: [{ action: "check", question: "Where do I live?", expectation: "York", surface: "both" }] };
const sourceScenario: Scenario = { id: "source-aware-independent-judge", category: "acquisition", partition: "development",
  language: "en", steps: [
    { action: "message", content: "I moved from Leeds to York." },
    { action: "check", question: "Where do I live now?", expectation: "York", surface: "answer" }
  ] };

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
  it("freezes the seven source-aware controls before a paid regrade", () => {
    expect(SOURCE_AWARE_GRADING_CALIBRATION).toHaveLength(7);
    expect(SOURCE_AWARE_GRADING_CALIBRATION).toEqual(expect.arrayContaining([
      expect.objectContaining({ answer: true, passed: true, values: ["Do not give Miso chicken; the vet advised it."] }),
      expect.objectContaining({ answer: true, passed: false, values: ["You should not eat chicken."] }),
      expect.objectContaining({ answer: true, passed: false, values: ["You live in Leeds."] }),
      expect.objectContaining({ answer: true, passed: false, values: ["You live in York."] }),
      expect.objectContaining({ answer: true, passed: true, values: ["Before York, you lived in Leeds."] }),
      expect.objectContaining({ answer: false, passed: false, values: [] })
    ]));
    expect(SOURCE_AWARE_GRADING_CALIBRATION.some((item) => item.sourceContext.messages
      .some((message) => message.content === "Forget that I live in Leeds."))).toBe(true);
  });

  it("sends source order, timestamp, and persisted reader evidence to the separate judge", async () => {
    const primary = { ...reader(), conversation: vi.fn(() => ({ id: "source-chat", leaf: null, mode: "NORMAL" as const })),
      send: vi.fn(async () => reply), settle: vi.fn(async () => 1) };
    const judge = scorer();
    await evaluateScenario(primary as unknown as AcceptanceDriver, judgeIdentity, sourceScenario,
      () => undefined, judge as unknown as AcceptanceDriver);
    const payload = JSON.parse(judge.send.mock.calls[0]![2]!.split("Evaluation data (JSON):\n")[1]!);
    expect(payload.sourceDialogue).toEqual({
      messages: [{ actor: "owner", content: "I moved from Leeds to York.", memoryMode: "NORMAL", ordinal: 0, role: "user",
        timestamp: "2026-09-14T00:00:00.000Z" }],
      readerAuditEvidence: []
    });
  });

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
