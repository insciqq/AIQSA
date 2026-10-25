// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  answerReviewDeletionRoot,
  answerReviewStandIn,
  answerReviewVersionQuestion,
  collapseChatAnswerReviewTree,
  hiddenAnswerReviewMessageIds,
  isAnswerReviewStepToolCall,
  loadAnswerReviewPathView
} from "./legacyAnswerReviews";

/**
 * A chat as the previous release left it: a question and its answer, a
 * review and a revision of it (session s1), a second round's review after
 * the revision, and an ordinary answer elsewhere.
 */
type Row = Readonly<{
  answerReviewSessionId: string | null;
  id: string;
  parentMessageId: string | null;
  role: string;
  status: string;
  systemTurnKind: string | null;
}>;
const row = (id: string, parentMessageId: string | null, role: string, session: string | null = null,
  systemTurnKind: string | null = null, status = "complete"): Row =>
  ({ answerReviewSessionId: session, id, parentMessageId, role, status, systemTurnKind });
const rows = [
  row("q", null, "user"), row("a1", "q", "assistant"),
  row("t1", "a1", "user", "s1", "answer_review_request"), row("r1", "t1", "assistant", "s1"),
  row("t2", "r1", "user", "s1", "answer_revision_request"), row("a2", "t2", "assistant", "s1"),
  row("t3", "a2", "user", "s1", "answer_review_request"), row("r2", "t3", "assistant", "s1"),
  row("other-q", null, "user"), row("other-a", "other-q", "assistant")
];

/** The reads the module makes, over `rows`: a message, the path to one (by its id among the query's values) and the sessions. */
function client(messages: readonly Row[] = rows) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return {
    $queryRaw: async (query: Prisma.Sql) => {
      let current = byId.get(String(query.values.find((value) => byId.has(String(value)))));
      const path: Row[] = [];
      while (current) {
        path.unshift(current);
        current = current.parentMessageId ? byId.get(current.parentMessageId) : undefined;
      }
      return path;
    },
    answerReviewSession: {
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) => [{ id: "s1", sourceAssistantMessageId: "a1" }]
        .filter((session) => !where.id || where.id.in.includes(session.id))
    },
    message: {
      findFirst: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null,
      // A session's rows: its steps, and its source answer by id.
      findMany: async ({ where }: { where: { OR: [{ answerReviewSessionId: { in: string[] } }, { id: { in: string[] } }] } }) =>
        messages.filter((message) => where.OR[0].answerReviewSessionId.in.includes(message.answerReviewSessionId ?? "") ||
          where.OR[1].id.in.includes(message.id))
    }
  } as unknown as Prisma.TransactionClient;
}

describe("legacy answer review reads", () => {
  it("names the version standing for a step, and every other message as itself", async () => {
    const db = client();
    expect(await answerReviewStandIn(db, "chat", "r2")).toBe("a2");
    expect(await answerReviewStandIn(db, "chat", "a2")).toBe("a2");
    expect(await answerReviewStandIn(db, "chat", "a1")).toBe("a1");
    expect(await answerReviewStandIn(db, "chat", "other-a")).toBe("other-a");
    // Before its revision completed, a review's answer reads as the source answer.
    const unrevised = client(rows.slice(0, 4));
    expect(await answerReviewStandIn(unrevised, "chat", "r1")).toBe("a1");
  });

  it("reads a version as an answer of the source question, and no other step as one", async () => {
    const db = client();
    expect(await answerReviewVersionQuestion(db, "chat", "a2")).toBe("q");
    for (const step of ["r1", "r2", "t2"]) expect(await answerReviewVersionQuestion(db, "chat", step), step).toBeNull();
    const failed = client([...rows.slice(0, 5), row("a2", "t2", "assistant", "s1", null, "error")]);
    expect(await answerReviewVersionQuestion(failed, "chat", "a2")).toBeNull();
    // A message outside every session reads with its own parents.
    expect(await loadAnswerReviewPathView(db, "chat", "a1")).toBeNull();
    const view = await loadAnswerReviewPathView(db, "chat", "r2");
    expect([view?.standInId, view?.parentOf("a2"), view?.parentOf("r1"), view?.parentOf("q")]).toEqual(["a2", "q", undefined, null]);
  });

  it("deletes a step from its source answer, and anything else from itself", async () => {
    const db = client();
    expect(await answerReviewDeletionRoot(db, "chat", "a2")).toBe("a1");
    expect(await answerReviewDeletionRoot(db, "chat", "a1")).toBe("a1");
    expect(await answerReviewDeletionRoot(db, "chat", "other-a")).toBe("other-a");
  });

  it("reads the branch graph without steps and maps its active leaf to the version standing for it", async () => {
    const graph = await collapseChatAnswerReviewTree(client(), "chat", rows.map((entry) => ({
      ...entry, parentId: entry.parentMessageId })), "r2");
    expect(rows.map((entry) => entry.id).filter((id) => !graph.removed.has(id))).toEqual(["q", "a2", "other-q", "other-a"]);
    expect(graph.parents).toEqual(new Map([["a2", "q"]]));
    expect(graph.activeLeafId).toBe("a2");
    const plain = await collapseChatAnswerReviewTree(client(), "chat", rows.slice(8).map((entry) => ({
      ...entry, parentId: entry.parentMessageId })), "other-a");
    expect([plain.removed.size, plain.activeLeafId]).toEqual([0, "other-a"]);
  });

  it("names every step and superseded version of the user's sessions for message search", async () => {
    expect(new Set(await hiddenAnswerReviewMessageIds(client(), "user-1"))).toEqual(new Set(["a1", "t1", "r1", "t2", "t3", "r2"]));
    const unrevised = client(rows.slice(0, 4));
    expect(new Set(await hiddenAnswerReviewMessageIds(unrevised, "user-1"))).toEqual(new Set(["t1", "r1"]));
  });

  it("hides only a step run's own report from its activity", () => {
    const step = { answerReviewStep: { kind: "revision", round: 1, sessionId: "s1", step: 1, version: 1 } };
    expect(isAnswerReviewStepToolCall(step, "record_review_decisions")).toBe(true);
    expect(isAnswerReviewStepToolCall(step, "web_search")).toBe(false);
    expect(isAnswerReviewStepToolCall({}, "submit_answer_review")).toBe(false);
  });
});
