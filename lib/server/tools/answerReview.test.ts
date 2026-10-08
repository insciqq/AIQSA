import { describe, expect, it } from "vitest";
import { isRunOutputArtifactEvent, projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { reservedToolCallForRequest } from "./reservedToolCall";
import {
  answerReviewCallSubmitted,
  answerReviewToolsForRequest,
  executeAnswerReviewCall,
  isAnswerReviewCall,
  isAnswerReviewStepMarker,
  RECORD_REVIEW_DECISIONS_TOOL_NAME,
  SUBMIT_ANSWER_REVIEW_TOOL_NAME
} from "./answerReview";

const reviewStep = {
  answerReviewStep: { kind: "review", modelName: "GPT-5", rejectedKeys: ["R1.1.F1"], reviewer: 1, round: 2, sessionId: "session-1",
    step: 1, version: 1 }
} as const;
const revisionStep = {
  answerReviewStep: { findingKeys: ["R2.1.F1", "R2.2.F1"], kind: "revision", modelName: "Claude", round: 2,
    sessionId: "session-1", step: 2, version: 1 }
} as const;
const finding = {
  claim: "The total is 42.", evidence: null, id: "F1", problem: "The sum is 41.", repeatsFindingId: null, severity: "critical",
  suggestion: "Correct the total."
};
const call = (name: string, args: Record<string, unknown>) => ({ arguments: args, id: "call-1", name });

describe("answer review tools", () => {
  it("are offered only by a valid step marker, one tool per step kind", () => {
    expect(isAnswerReviewStepMarker(reviewStep.answerReviewStep)).toBe(true);
    expect(isAnswerReviewStepMarker(revisionStep.answerReviewStep)).toBe(true);
    // A review's step is its reviewer; a revision decides at least one finding and names no reviewer.
    expect(isAnswerReviewStepMarker({ ...reviewStep.answerReviewStep, step: 0 })).toBe(false);
    expect(isAnswerReviewStepMarker({ ...revisionStep.answerReviewStep, findingKeys: [] })).toBe(false);
    expect(isAnswerReviewStepMarker({ ...revisionStep.answerReviewStep, reviewer: 0 })).toBe(false);
    expect(isAnswerReviewStepMarker({ ...reviewStep.answerReviewStep, modelName: "" })).toBe(false);
    expect(answerReviewToolsForRequest(reviewStep).map((tool) => tool.name)).toEqual([SUBMIT_ANSWER_REVIEW_TOOL_NAME]);
    expect(answerReviewToolsForRequest(revisionStep).map((tool) => tool.name)).toEqual([RECORD_REVIEW_DECISIONS_TOOL_NAME]);
    expect(answerReviewToolsForRequest({})).toEqual([]);
    expect(isAnswerReviewCall(reviewStep, RECORD_REVIEW_DECISIONS_TOOL_NAME)).toBe(false);
    expect(answerReviewToolsForRequest(reviewStep)[0]).toMatchObject({ capability: "session", strict: true });
  });

  it("reserves the step's first report outside the tool budgets", () => {
    expect(reservedToolCallForRequest(reviewStep)).toMatchObject({ name: SUBMIT_ANSWER_REVIEW_TOOL_NAME });
    expect(reservedToolCallForRequest(revisionStep)?.instruction).toContain(RECORD_REVIEW_DECISIONS_TOOL_NAME);
    expect(reservedToolCallForRequest({ monitoringVerdictTool: true })?.name).toBe("report_monitoring_result");
    expect(reservedToolCallForRequest({})).toBeNull();
  });

  it("turns a valid review into its card with the step's server-owned facts", () => {
    const result = executeAnswerReviewCall(call(SUBMIT_ANSWER_REVIEW_TOOL_NAME, { findings: [finding], verdict: "changes_needed" }),
      reviewStep, { submitted: false });
    expect(result.status).toBe("complete");
    const artifact = result.artifacts?.[0];
    expect(artifact).toEqual({ data: { artifactType: "answer_review", payload: {
      findings: [{ claim: finding.claim, id: "F1", problem: finding.problem, severity: "critical", suggestion: finding.suggestion }],
      reviewer: 1, reviewerName: "GPT-5", round: 2, verdict: "changes_needed", version: 1
    } }, type: "artifact" });
    // The card crosses the durable output boundary exactly as produced.
    const projected = projectRunOutputArtifactEvent(artifact!);
    expect(projected).toEqual(artifact);
    expect(isRunOutputArtifactEvent(projected!)).toBe(true);
  });

  it("refuses a malformed review the model may correct", () => {
    const refused = (args: Record<string, unknown>) =>
      executeAnswerReviewCall(call(SUBMIT_ANSWER_REVIEW_TOOL_NAME, args), reviewStep, { submitted: false });
    expect(refused({ findings: [finding], verdict: "clean" }).status).toBe("error");
    expect(refused({ findings: [], verdict: "changes_needed" }).status).toBe("error");
    expect(refused({ findings: [finding, finding], verdict: "changes_needed" }).status).toBe("error");
    expect(refused({ findings: [{ ...finding, severity: "low" }], verdict: "changes_needed" }).status).toBe("error");
    // A repeat names only a finding the author rejected earlier.
    expect(refused({ findings: [{ ...finding, repeatsFindingId: "R1.2.F9" }], verdict: "changes_needed" }).status).toBe("error");
    expect(refused({ findings: [{ ...finding, repeatsFindingId: "R1.1.F1" }], verdict: "changes_needed" }).status).toBe("complete");
    expect(refused({ verdict: "clean" }).status).toBe("error");
    expect(refused({ findings: [], verdict: "clean" }).status).toBe("complete");
  });

  it("reports once per step", () => {
    const again = executeAnswerReviewCall(call(SUBMIT_ANSWER_REVIEW_TOOL_NAME, { findings: [], verdict: "clean" }), reviewStep,
      { submitted: true });
    expect(again).toMatchObject({ status: "error" });
    expect(again.artifacts).toBeUndefined();
  });

  it("records a decision on every finding of the round, by key", () => {
    const decide = (decisions: unknown[]) => executeAnswerReviewCall(call(RECORD_REVIEW_DECISIONS_TOOL_NAME, { decisions }),
      revisionStep, { submitted: false });
    const all = [
      { decision: "accepted", findingId: "R2.1.F1", reason: "Right." },
      { decision: "rejected", findingId: "R2.2.F1", reason: "Already sourced." }
    ];
    const result = decide(all);
    expect(result.status).toBe("complete");
    expect(result.artifacts?.[0]).toMatchObject({ data: { artifactType: "answer_review_decisions", payload: { decisions: all, round: 2 } } });
    expect(isRunOutputArtifactEvent(projectRunOutputArtifactEvent(result.artifacts![0]!)!)).toBe(true);
    expect(decide(all.slice(0, 1)).status).toBe("error");
    expect(decide([...all, all[0]]).status).toBe("error");
    expect(decide([{ ...all[0], findingId: "R9.1.F1" }, all[1]]).status).toBe("error");
    expect(decide([{ ...all[0], decision: "maybe" }, all[1]]).status).toBe("error");
  });

  it("persists a report with its card, so a replay or recovery reads the same one", () => {
    for (const [name, args, request] of [
      [SUBMIT_ANSWER_REVIEW_TOOL_NAME, { findings: [finding], verdict: "changes_needed" }, reviewStep],
      [RECORD_REVIEW_DECISIONS_TOOL_NAME, { decisions: [{ decision: "accepted", findingId: "R2.1.F1", reason: "Right." },
        { decision: "rejected", findingId: "R2.2.F1", reason: "Sourced." }] }, revisionStep]
    ] as const) {
      const executed = executeAnswerReviewCall(call(name, args), request, { submitted: false });
      const snapshot = snapshotToolExecutionResult(executed, 64_000);
      expect(snapshot, name).not.toBeNull();
      expect(parsePersistedToolExecutionResult({ id: "call-1", name }, snapshot)?.artifacts, name).toEqual(executed.artifacts);
      expect(answerReviewCallSubmitted(request, { result: snapshot, state: "complete", toolName: name }), name).toBe(true);
    }
  });

  it("knows a persisted call settled its step's card", () => {
    const settled = executeAnswerReviewCall(call(SUBMIT_ANSWER_REVIEW_TOOL_NAME, { findings: [], verdict: "clean" }), reviewStep,
      { submitted: false });
    expect(answerReviewCallSubmitted(reviewStep, { result: settled, state: "complete", toolName: SUBMIT_ANSWER_REVIEW_TOOL_NAME }))
      .toBe(true);
    expect(answerReviewCallSubmitted(reviewStep, { result: { content: [] }, state: "complete", toolName: SUBMIT_ANSWER_REVIEW_TOOL_NAME }))
      .toBe(false);
    expect(answerReviewCallSubmitted(revisionStep, { result: settled, state: "complete", toolName: SUBMIT_ANSWER_REVIEW_TOOL_NAME }))
      .toBe(false);
  });
});
