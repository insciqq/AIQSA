import { describe, expect, it } from "vitest";
import {
  answerReviewFindingKey,
  answerReviewRefusalCopy,
  answerReviewStopCopy,
  decodeAnswerReviewCard,
  decodeAnswerReviewDecisionsCard,
  decodeAnswerReviewMessageWire,
  decodeAnswerReviewSessionWire,
  foldAnswerReviewCards,
  isAnswerReviewFindingKey
} from "./answerReviews";
import { decodeChatMessagesPageResponse } from "./chats";

const finding = { claim: "The answer says 42.", id: "F1", problem: "Not verified.", severity: "high", suggestion: "Cite a source." };
const card = { findings: [finding], reviewer: 0, reviewerName: "GPT-5", round: 1, verdict: "changes_needed", version: 1 };
const session = {
  author: { modelId: "model-a", name: "Claude", provider: "connection-a" },
  canAct: true,
  id: "session-1",
  maxRounds: null,
  mode: "manual",
  reviewers: [{ modelId: "model-b", name: "GPT-5", provider: "connection-b" }],
  round: 1,
  sourceAssistantMessageId: "answer-1",
  state: "running",
  stopReason: null
};

describe("answer review contract", () => {
  it("keys a finding by round, reviewer position and the reviewer's id", () => {
    expect(answerReviewFindingKey(2, 1, "F3")).toBe("R2.2.F3");
    expect(isAnswerReviewFindingKey("R2.2.F3")).toBe(true);
    expect(isAnswerReviewFindingKey("R0.1.F1")).toBe(false);
    expect(isAnswerReviewFindingKey("R1.3.F1")).toBe(false);
  });

  it("decodes a review card only with a verdict that matches its findings", () => {
    expect(decodeAnswerReviewCard(card)).toEqual(card);
    expect(decodeAnswerReviewCard({ ...card, findings: [], verdict: "clean" })).toMatchObject({ verdict: "clean" });
    // A clean review names no findings, and one that needs changes names at least one.
    expect(decodeAnswerReviewCard({ ...card, verdict: "clean" })).toBeNull();
    expect(decodeAnswerReviewCard({ ...card, findings: [] })).toBeNull();
    expect(decodeAnswerReviewCard({ ...card, findings: [finding, finding] })).toBeNull();
    expect(decodeAnswerReviewCard({ ...card, findings: [{ ...finding, severity: "low" }] })).toBeNull();
    expect(decodeAnswerReviewCard({ ...card, findings: [{ ...finding, claim: "x".repeat(401) }] })).toBeNull();
    expect(decodeAnswerReviewCard({ ...card, extra: true })).toBeNull();
    expect(decodeAnswerReviewCard({ ...card, reviewer: 2 })).toBeNull();
  });

  it("decodes decisions by finding key, each once", () => {
    const decisions = { decisions: [{ decision: "rejected", findingId: "R1.1.F1", reason: "Already sourced." }], round: 1, version: 1 };
    expect(decodeAnswerReviewDecisionsCard(decisions)).toEqual(decisions);
    expect(decodeAnswerReviewDecisionsCard({ ...decisions, decisions: [] })).toBeNull();
    expect(decodeAnswerReviewDecisionsCard({ ...decisions, decisions: [...decisions.decisions, ...decisions.decisions] })).toBeNull();
    expect(decodeAnswerReviewDecisionsCard({ ...decisions, decisions: [{ ...decisions.decisions[0], findingId: "F1" }] })).toBeNull();
  });

  it("folds a step answer's cards to its first valid one", () => {
    expect(foldAnswerReviewCards([{ broken: true }, card, { ...card, reviewerName: "Later" }])).toEqual([card]);
    expect(foldAnswerReviewCards([])).toEqual([]);
  });

  it("decodes a session only with a stop reason exactly when it ended", () => {
    expect(decodeAnswerReviewSessionWire(session)).toEqual(session);
    expect(decodeAnswerReviewSessionWire({ ...session, state: "finished", stopReason: "clean" })).toMatchObject({ state: "finished" });
    expect(decodeAnswerReviewSessionWire({ ...session, stopReason: "clean" })).toBeNull();
    expect(decodeAnswerReviewSessionWire({ ...session, state: "stopped" })).toBeNull();
    expect(decodeAnswerReviewSessionWire({ ...session, reviewers: [] })).toBeNull();
    expect(decodeAnswerReviewSessionWire({ ...session, reviewers: [...session.reviewers, ...session.reviewers, ...session.reviewers] }))
      .toBeNull();
  });

  it("decodes a step: a review names its reviewer, a revision none", () => {
    expect(decodeAnswerReviewMessageWire({ session, step: { kind: "review", reviewer: 0, round: 1, step: 0 } }))
      .toMatchObject({ step: { kind: "review", reviewer: 0 } });
    expect(decodeAnswerReviewMessageWire({ session, step: { kind: "revision", round: 1, step: 1 } }))
      .toMatchObject({ step: { kind: "revision" } });
    expect(decodeAnswerReviewMessageWire({ session, step: { kind: "review", round: 1, step: 0 } })).toBeNull();
    expect(decodeAnswerReviewMessageWire({ session, step: { kind: "revision", reviewer: 0, round: 1, step: 1 } })).toBeNull();
  });

  it("names refusals and stop reasons for the user", () => {
    expect(answerReviewRefusalCopy("answer_review_assistant_unsupported")).toContain("Assistant");
    expect(answerReviewRefusalCopy("usage_budget_exhausted")).toBeNull();
    expect(answerReviewStopCopy("clean")).toBe("No substantive issues");
    expect(answerReviewStopCopy("budget")).toContain("usage limit");
  });

  it("carries a review step's turn kind and session on chat messages", () => {
    const message = {
      citationMessageId: null, content: { blocks: [] }, createdAt: "2026-10-08T10:00:00.000Z", errorMessage: null,
      id: "turn-1", modelId: null, modelRunId: null, parentMessageId: null, provider: null, role: "user", status: "complete"
    };
    const pageInfo = { activeLeafMessageId: "turn-1", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: "2026-10-08T10:00:00.000Z" };
    const page = decodeChatMessagesPageResponse({
      messages: [{ ...message, answerReview: { session, step: { kind: "review", reviewer: 0, round: 1, step: 0 } },
        systemTurnKind: "answer_review_request" }],
      pageInfo
    });
    expect(page?.messages[0]).toMatchObject({ answerReview: { session: { id: "session-1" } }, systemTurnKind: "answer_review_request" });
    // A server-written turn is always a user message, and a malformed session drops the message.
    expect(decodeChatMessagesPageResponse({
      messages: [{ ...message, role: "assistant", systemTurnKind: "answer_review_request" }],
      pageInfo
    })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      messages: [{ ...message, answerReview: { session: { ...session, state: "stopped" } } }],
      pageInfo
    })).toBeNull();
  });
});
