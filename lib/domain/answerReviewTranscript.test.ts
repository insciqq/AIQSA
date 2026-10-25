import { describe, expect, it } from "vitest";
import {
  answerReviewDeletionPlan,
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

describe("a version the previous release regenerated", () => {
  // Regenerating the version copied it under the revision request without its session.
  const regenerated = message("a2-again", "s1-revise", "assistant");
  const tree = [...reviewed.slice(0, 6), regenerated];

  it("reads as the session's version on its path, the source answer and the steps gone", () => {
    const path = [...reviewed.slice(0, 5), regenerated];
    const collapse = collapseAnswerReviews(path, sessions);
    expect(kept(path, collapse.removed)).toEqual(["q", "a2-again"]);
    expect(collapse.parents).toEqual(new Map([["a2-again", "q"]]));
    expect(collapse.replacements.get("a1")).toBe("a2-again");
  });

  it("stands beside the version it copied among the question's answers", () => {
    const collapse = collapseAnswerReviewTree(tree, sessions, ["a2-again"]);
    expect(kept(tree, collapse.removed)).toEqual(["q", "a2", "a2-again"]);
    expect(collapse.parents).toEqual(new Map([["a2", "q"], ["a2-again", "q"]]));
  });

  it("is no version when it did not complete, and leaves with the steps", () => {
    const failed = [...reviewed.slice(0, 5), message("a2-again", "s1-revise", "assistant", { status: "error" })];
    expect(kept(failed, collapseAnswerReviews(failed, sessions).removed)).toEqual(["q", "a1"]);
  });

  it("resolves versions at the same depth to the later one in the list", () => {
    expect(kept(tree, collapseAnswerReviews(tree, sessions).removed)).toEqual(["q", "a2-again"]);
    const reversed = [...reviewed.slice(0, 5), regenerated, reviewed[5]!];
    expect(kept(reversed, collapseAnswerReviews(reversed, sessions).removed)).toEqual(["q", "a2"]);
  });

  it("stands where the first source answer stood when a later session reviewed it again", () => {
    const again = [...reviewed.slice(0, 5), regenerated,
      message("s2-review", "a2-again", "user", { answerReviewSessionId: "s2", systemTurnKind: "answer_review_request" }),
      message("r2", "s2-review", "assistant", { answerReviewSessionId: "s2" }),
      message("s2-revise", "r2", "user", { answerReviewSessionId: "s2", systemTurnKind: "answer_revision_request" }),
      message("a3", "s2-revise", "assistant", { answerReviewSessionId: "s2" })];
    const collapse = collapseAnswerReviews(again, [...sessions, { id: "s2", sourceAssistantMessageId: "a2-again" }]);
    expect(kept(again, collapse.removed)).toEqual(["q", "a3"]);
    expect(collapse.parents).toEqual(new Map([["a3", "q"]]));
    expect(collapse.replacements.get("r1")).toBe("a3");
  });
});

describe("deleting from a chat with a recorded review", () => {
  const secondRound = [turn("s1-review-2", "a2", "answer_review_request"), stepAnswer("r2", "s1-review-2")];
  const linear = [...reviewed.slice(0, 6), ...secondRound];

  it("deletes a linear session whole from the version, leaving the question as the chat's leaf", () => {
    for (const leaf of ["a2", "r2"]) {
      expect(answerReviewDeletionPlan(linear, sessions, leaf, "a2"), leaf).toEqual({ leafId: "q", roots: ["a1"] });
    }
  });

  it("keeps the source answer and a branch under a step, deleting only the version and the steps below it", () => {
    const branched = [...linear, message("other", "r1", "user"), message("other-answer", "other", "assistant")];
    expect(answerReviewDeletionPlan(branched, sessions, "r2", "a2")).toEqual({ leafId: "q", roots: ["s1-revise"] });
    // Deleting the branch leaves the chat on the source answer it followed.
    expect(answerReviewDeletionPlan(branched, sessions, "other-answer", "other")).toEqual({ leafId: "a1", roots: ["other"] });
  });

  it("deletes the source answer shown beside its version by what showed it, keeping the version", () => {
    const beside = [...reviewed.slice(0, 6), message("later", "r1", "user"), message("later-answer", "later", "assistant")];
    expect(answerReviewDeletionPlan(beside, sessions, "later-answer", "a1")).toEqual({ leafId: "q", roots: ["later"] });
    // Checked out at the source answer itself: it leaves the view, and nothing is deleted.
    expect(answerReviewDeletionPlan(reviewed.slice(0, 6), sessions, "a1", "a1")).toEqual({ leafId: "q", roots: [] });
  });

  it("deletes a later question under a step with the steps it hung from", () => {
    const after = [...linear, message("next-2", "r2", "user"), message("next-2-answer", "next-2", "assistant")];
    expect(answerReviewDeletionPlan(after, sessions, "next-2-answer", "next-2")).toEqual({ leafId: "a2", roots: ["s1-review-2"] });
  });

  it("deletes a regenerated version alone and keeps the one beside it", () => {
    const tree = [...reviewed.slice(0, 6), message("a2-again", "s1-revise", "assistant")];
    expect(answerReviewDeletionPlan(tree, sessions, "a2-again", "a2-again")).toEqual({ leafId: "q", roots: ["a2-again"] });
  });

  it("deletes from a hidden step a previous release's tab names, and changes nothing elsewhere", () => {
    expect(answerReviewDeletionPlan(linear, sessions, "r2", "a1")).toEqual({ leafId: "q", roots: ["a1"] });
    const plain = [message("q", null, "user"), message("a", "q", "assistant")];
    expect(answerReviewDeletionPlan(plain, [], "a", "a")).toEqual({ leafId: "q", roots: ["a"] });
    expect(answerReviewDeletionPlan(plain, [], "a", "missing")).toBeNull();
  });
});
