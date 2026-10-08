import { describe, expect, it } from "vitest";
import {
  answerReviewSessionWire,
  answerReviewStepsFromMessages,
  canActOnAnswerReviewSession,
  rejectedAnswerReviewFindings,
  type AnswerReviewSessionRecord
} from "./repository";

const session: AnswerReviewSessionRecord = {
  authorModel: { modelId: "model-a", name: "Claude", provider: "connection-a" },
  chatId: "chat-1",
  id: "session-1",
  maxRounds: null,
  mode: "manual",
  reviewers: [{ modelId: "model-b", name: "GPT-5", provider: "connection-b" }],
  round: 1,
  sourceAssistantMessageId: "answer-1",
  state: "running",
  stopReason: null,
  userId: "user-1"
};

type StepRow = Parameters<typeof answerReviewStepsFromMessages>[0][number];

function row(overrides: Partial<StepRow>): StepRow {
  return { answerReviewRound: null, answerReviewStep: null, assistantModelRuns: [], createdAt: new Date(Date.UTC(2026, 9, 8)),
    id: "id", parentMessageId: null, role: "user", status: "complete", systemTurnKind: null, ...overrides } as StepRow;
}

const card = (round: number, findings: number) => ({ artifactType: "answer_review", payload: {
  findings: Array.from({ length: findings }, (_, index) => ({ claim: `Claim ${index}`, id: `F${index + 1}`, problem: "Wrong.",
    severity: "high", suggestion: "Fix." })),
  reviewer: 0, reviewerName: "GPT-5", round, verdict: findings ? "changes_needed" : "clean", version: 1
} });

describe("answer review session access", () => {
  it("lets the initiator act, and anyone take over an ended session whose initiator is gone", () => {
    expect(canActOnAnswerReviewSession(session, "user-1")).toBe(true);
    expect(canActOnAnswerReviewSession(session, "user-2")).toBe(false);
    expect(canActOnAnswerReviewSession(session, null)).toBe(false);
    expect(canActOnAnswerReviewSession({ ...session, userId: null }, "user-2")).toBe(false);
    for (const state of ["finished", "stopped"] as const) {
      expect(canActOnAnswerReviewSession({ ...session, state, userId: null }, "user-2"), state).toBe(true);
    }
  });

  it("marks only a viewer who may act", () => {
    expect(answerReviewSessionWire(session, "user-1")).toMatchObject({ canAct: true, id: "session-1" });
    expect(answerReviewSessionWire(session, "user-2")).not.toHaveProperty("canAct");
    expect(answerReviewSessionWire(session, null)).not.toHaveProperty("canAct");
    // The wire never names the initiator.
    expect(answerReviewSessionWire(session, "user-1")).not.toHaveProperty("userId");
    expect(answerReviewSessionWire({ ...session, state: "stopped", stopReason: "superseded", userId: null }, "user-2"))
      .toMatchObject({ canAct: true });
  });
});

describe("answer review steps from messages", () => {
  it("reads each step from its turn and its newest answer, in round and step order", () => {
    const steps = answerReviewStepsFromMessages([
      row({ answerReviewRound: 1, answerReviewStep: 1, id: "revise", parentMessageId: "review-answer",
        systemTurnKind: "answer_revision_request" }),
      row({ answerReviewRound: 1, answerReviewStep: 0, id: "review", parentMessageId: "answer-1", systemTurnKind: "answer_review_request" }),
      row({ assistantModelRuns: [{ events: [{ payload: card(1, 1) }], id: "run-r", mcpToolApprovals: [], normalizedRequest: {} }],
        id: "review-answer", parentMessageId: "review", role: "assistant" }),
      row({ assistantModelRuns: [{ events: [], id: "run-v", mcpToolApprovals: [{ id: "approval-1" }], normalizedRequest: {} }],
        id: "revised", parentMessageId: "revise", role: "assistant", status: "streaming" })
    ] as StepRow[]);
    expect(steps).toEqual([
      expect.objectContaining({ answerId: "review-answer", kind: "review", review: { findings: 1, verdict: "changes_needed" },
        reviewer: 0, round: 1, runId: "run-r", status: "complete", step: 0, turnId: "review" }),
      expect.objectContaining({ answerId: "revised", approvalPending: true, kind: "revision", round: 1, runId: "run-v",
        status: "running", step: 1, turnId: "revise" })
    ]);
  });

  it("leaves a step whose answer is missing running, and a turn without its claim out", () => {
    expect(answerReviewStepsFromMessages([
      row({ answerReviewRound: 1, answerReviewStep: 0, id: "review", systemTurnKind: "answer_review_request" }),
      row({ id: "copied", systemTurnKind: "answer_review_request" })
    ] as StepRow[])).toEqual([expect.objectContaining({ answerId: null, status: "running", turnId: "review" })]);
  });

  it("lists findings the author rejected in earlier rounds with their reviewer's claim", () => {
    const steps = answerReviewStepsFromMessages([
      row({ answerReviewRound: 1, answerReviewStep: 0, id: "review", systemTurnKind: "answer_review_request" }),
      row({ assistantModelRuns: [{ events: [{ payload: card(1, 2) }], id: "run-r", mcpToolApprovals: [], normalizedRequest: {} }],
        id: "review-answer", parentMessageId: "review", role: "assistant" }),
      row({ answerReviewRound: 1, answerReviewStep: 1, id: "revise", parentMessageId: "review-answer",
        systemTurnKind: "answer_revision_request" }),
      row({ assistantModelRuns: [{ events: [{ payload: { artifactType: "answer_review_decisions", payload: { decisions: [
        { decision: "rejected", findingId: "R1.1.F1", reason: "Already sourced." },
        { decision: "accepted", findingId: "R1.1.F2", reason: "Right." }
      ], round: 1, version: 1 } } }], id: "run-v", mcpToolApprovals: [], normalizedRequest: {} }],
      id: "revised", parentMessageId: "revise", role: "assistant" })
    ] as StepRow[]);
    expect(rejectedAnswerReviewFindings(steps, 2)).toEqual([{ claim: "Claim 0", key: "R1.1.F1", reason: "Already sourced." }]);
    expect(rejectedAnswerReviewFindings(steps, 1)).toEqual([]);
  });
});
