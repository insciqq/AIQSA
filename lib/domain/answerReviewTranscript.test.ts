import { describe, expect, it } from "vitest";
import {
  collapseAnswerReviews,
  collapseAnswerReviewTree,
  isAnswerReviewTurnKind,
  type AnswerReviewTranscriptMessage
} from "./answerReviewTranscript";

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
const kept = (path: readonly AnswerReviewTranscriptMessage[], removed: ReadonlySet<string>) =>
  path.filter((entry) => !removed.has(entry.id)).map((entry) => entry.id);

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

  it("collapses a path that ends on a step: the version stands for it", () => {
    const question = message("q", null, "user");
    const answer = message("a1", "q", "assistant");
    const reviewTurn = turn("s1-review", "a1", "answer_review_request");
    const cases: Array<readonly [string, AnswerReviewTranscriptMessage[]]> = [
      // A clean finish, or a review that waited for Revise: the reviewer's short summary is the leaf.
      ["clean", [question, answer, reviewTurn, stepAnswer("r1", "s1-review")]],
      // A reviewer stopped mid-answer, or one whose answer ended on an approval card.
      ["stopped review", [question, answer, reviewTurn, stepAnswer("r1", "s1-review", "cancelled")]],
      // A revision stopped mid-answer: its partial version is no version.
      ["stopped revision", [question, answer, reviewTurn, stepAnswer("r1", "s1-review"), turn("s1-revise", "r1", "answer_revision_request"),
        stepAnswer("a2", "s1-revise", "cancelled")]]
    ];
    for (const [label, path] of cases) {
      const collapse = collapseAnswerReviews(path, sessions);
      expect(kept(path, collapse.removed), label).toEqual(["q", "a1"]);
      expect(collapse.replacements.get(path.at(-1)!.id), label).toBe("a1");
    }
  });

  it("leaves a session whose source answer is outside the transcript whole", () => {
    expect(collapseAnswerReviews(reviewed.slice(2), sessions).removed.size).toBe(0);
  });

  it("changes nothing in a chat without sessions", () => {
    const plain = [message("q", null, "user"), message("a", "q", "assistant")];
    expect(collapseAnswerReviews(plain, [])).toEqual({ parents: new Map(), removed: new Set(), replacements: new Map() });
  });

  it("names the two retired server-written turn kinds", () => {
    expect(["answer_review_request", "answer_revision_request", "mcp_approval_continuation", null].map(isAnswerReviewTurnKind))
      .toEqual([true, true, false, false]);
  });
});

describe("answer review tree collapse", () => {
  it("reads a branch graph as its paths read: the version among its question's answers, the steps gone", () => {
    const tree = [...reviewed, message("next-answer", "next", "assistant"), message("a1-again", "q", "assistant")];
    const collapse = collapseAnswerReviewTree(tree, sessions);
    expect(kept(tree, collapse.removed)).toEqual(["q", "a2", "next", "next-answer", "a1-again"]);
    expect(collapse.parents).toEqual(new Map([["a2", "q"]]));
  });

  it("keeps a message a path still shows: an answer continued from before its revision, or the active leaf above a step", () => {
    const tree = [...reviewed.slice(0, 6), message("later", "r1", "user"), message("later-answer", "later", "assistant")];
    const collapse = collapseAnswerReviewTree(tree, sessions);
    // The question asked before the revision follows the answer it read: the source answer.
    expect(kept(tree, collapse.removed)).toEqual(["q", "a1", "a2", "later", "later-answer"]);
    expect(collapse.parents).toEqual(new Map([["a2", "q"], ["later", "a1"]]));
    // An active leaf checked out at the source answer keeps it, though every leaf below reads the version.
    expect(collapseAnswerReviewTree(reviewed.slice(0, 6), sessions, ["a1"]).removed.has("a1")).toBe(false);
    expect(collapseAnswerReviewTree(reviewed.slice(0, 6), sessions).removed.has("a1")).toBe(true);
  });

  it("changes nothing in a chat without sessions", () => {
    expect(collapseAnswerReviewTree(reviewed, [])).toEqual({ parents: new Map(), removed: new Set() });
  });
});
