import { describe, expect, it } from "vitest";
import { collapseAnswerReviews, type AnswerReviewTranscriptMessage } from "./answerReviewTranscript";

const message = (id: string, parentId: string | null, role: "assistant" | "user",
  extra: Partial<AnswerReviewTranscriptMessage> = {}): AnswerReviewTranscriptMessage =>
  ({ id, parentId, role, status: "complete", ...extra });
const turn = (id: string, parentId: string, kind: "answer_review_request" | "answer_revision_request") =>
  message(id, parentId, "user", { answerReviewSessionId: "s1", systemTurnKind: kind });
const stepAnswer = (id: string, parentId: string, status = "complete") =>
  message(id, parentId, "assistant", { answerReviewSessionId: "s1", status });

/** Question, answer, a review, a revision and the next question after it. */
const reviewed = [
  message("q", null, "user"), message("a1", "q", "assistant"),
  turn("s1-review", "a1", "answer_review_request"), stepAnswer("r1", "s1-review"),
  turn("s1-revise", "r1", "answer_revision_request"), stepAnswer("a2", "s1-revise"),
  message("next", "a2", "user")
];
const sessions = [{ id: "s1", sourceAssistantMessageId: "a1" }];

describe("answer review transcript collapse", () => {
  it("reads a session as its question followed by the latest version", () => {
    const collapse = collapseAnswerReviews(reviewed, sessions);
    expect([...collapse.removed].sort()).toEqual(["a1", "r1", "s1-review", "s1-revise"]);
    // The version takes the source answer's place; the next question stays under it.
    expect(collapse.parents.get("a2")).toBe("q");
    expect(collapse.parents.has("next")).toBe(false);
    expect(collapse.replacements.get("r1")).toBe("a2");
  });

  it("keeps the source answer when no revision completed", () => {
    const failed = [...reviewed.slice(0, 5), stepAnswer("a2", "s1-revise", "error"), message("next", "a2", "user")];
    const collapse = collapseAnswerReviews(failed, sessions);
    expect([...collapse.removed].sort()).toEqual(["a2", "r1", "s1-review", "s1-revise"]);
    // A later question that followed a removed step hangs from the kept version.
    expect(collapse.parents.get("next")).toBe("a1");
  });

  it("keeps the session of a step whole and never removes a kept message", () => {
    expect(collapseAnswerReviews(reviewed, sessions, { keepSessionId: "s1" }).removed.size).toBe(0);
    const collapse = collapseAnswerReviews(reviewed.slice(0, 5), sessions, { keepMessageIds: new Set(["s1-revise"]) });
    expect(collapse.removed.has("s1-revise")).toBe(false);
  });

  it("collapses a send's previous message too: a session that ended on a review step leaves no step behind", () => {
    const question = message("q", null, "user");
    const answer = message("a1", "q", "assistant");
    const reviewTurn = turn("s1-review", "a1", "answer_review_request");
    const cases: Array<readonly [string, AnswerReviewTranscriptMessage[]]> = [
      // A clean finish: the last reviewer's short summary is the leaf.
      ["clean", [question, answer, reviewTurn, stepAnswer("r1", "s1-review")]],
      // A reviewer stopped mid-answer, or one whose answer ended on an approval card.
      ["stopped review", [question, answer, reviewTurn, stepAnswer("r1", "s1-review", "cancelled")]],
      // A revision stopped mid-answer: its partial version is no version.
      ["stopped revision", [question, answer, reviewTurn, stepAnswer("r1", "s1-review"), turn("s1-revise", "r1", "answer_revision_request"),
        stepAnswer("a2", "s1-revise", "cancelled")]]
    ];
    for (const [label, path] of cases) {
      const collapse = collapseAnswerReviews(path, sessions);
      expect(path.filter((entry) => !collapse.removed.has(entry.id)).map((entry) => entry.id), label).toEqual(["q", "a1"]);
    }
  });

  it("leaves a session whose source answer is outside the transcript whole", () => {
    expect(collapseAnswerReviews(reviewed.slice(2), sessions).removed.size).toBe(0);
  });

  it("changes nothing in a chat without sessions", () => {
    const plain = [message("q", null, "user"), message("a", "q", "assistant")];
    expect(collapseAnswerReviews(plain, [])).toEqual({ parents: new Map(), removed: new Set(), replacements: new Map() });
  });
});
