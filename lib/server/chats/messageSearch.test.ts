import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_SEARCH_STATEMENT_TIMEOUT_MS,
  findMessageMatches,
  messageMatchSnippet,
  messageSearchPattern,
  type MessageSearchClient
} from "./messageSearch";

type LegacyReview = Readonly<{
  messages: readonly Readonly<Record<string, string | null>>[];
  sessions: readonly Readonly<{ id: string; sourceAssistantMessageId: string }>[];
}>;

function client(rows: unknown[] | Error, review: LegacyReview = { messages: [], sessions: [] }) {
  const statements: Prisma.Sql[] = [];
  const executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(Prisma.sql(strings, ...values));
    return 1;
  });
  const queryRaw = vi.fn(async (sql: Prisma.Sql) => {
    statements.push(sql);
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const sessions = vi.fn(async () => review.sessions);
  const messages = vi.fn(async () => review.messages);
  const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation({
    $executeRaw: executeRaw, $queryRaw: queryRaw, answerReviewSession: { findMany: sessions }, message: { findMany: messages }
  }));
  return { client: { $transaction: transaction } as unknown as MessageSearchClient, sessions, statements };
}

describe("message content search", () => {
  it("escapes LIKE wildcards and the escape character literally", () => {
    expect(messageSearchPattern("100%_done\\now")).toBe("%100\\%\\_done\\\\now%");
    expect(messageSearchPattern("бюджет")).toBe("%бюджет%");
  });

  it("cuts a readable snippet around the first match with ellipses on cut edges only", () => {
    expect(messageMatchSnippet({
      excerpt: "Short note about the budget",
      excerptStart: 1,
      matchLength: 6,
      matchOffset: 21,
      textLength: 27
    })).toBe("Short note about the budget");

    // The database cut this excerpt inside "partial" and inside a last word.
    const excerpt = "tial words before the budget line and after it goes on and on";
    const snippet = messageMatchSnippet({
      excerpt,
      excerptStart: 40,
      matchLength: 6,
      matchOffset: excerpt.indexOf("budget"),
      textLength: 400
    });
    expect(snippet).toBe("…words before the budget line and after it goes on and…");
  });

  it("collapses whitespace and never cuts into the match or an astral character", () => {
    const excerpt = "line one\n\n\tline   two 🚀 rocket";
    const characters = Array.from(excerpt);
    expect(messageMatchSnippet({
      excerpt,
      excerptStart: 1,
      matchLength: 6,
      matchOffset: characters.length - 6,
      textLength: characters.length
    })).toBe("line one line two 🚀 rocket");
    // Cut on both sides, the astral character survives whole.
    expect(messageMatchSnippet({
      excerpt: "🚀🚀 near the rocket launch 🚀🚀",
      excerptStart: 3,
      matchLength: 6,
      matchOffset: 12,
      textLength: 200
    })).toBe("…near the rocket launch…");
    // A match at the excerpt edge keeps its word even when the edge is cut.
    expect(messageMatchSnippet({
      excerpt: "budgetary planning",
      excerptStart: 5,
      matchLength: 6,
      matchOffset: 0,
      textLength: 100
    })).toBe("…budgetary…");
    expect(messageMatchSnippet({
      excerpt: "no match position known here",
      excerptStart: 1,
      matchLength: 3,
      matchOffset: null,
      textLength: 28
    })).toBe("no match position known here");
  });

  it("bounds the query in time, keeps the pattern a parameter and maps rows to matches", async () => {
    const { client: fake, statements } = client([{
      chatId: "chat-1",
      chatUpdatedAt: new Date("2026-08-13T00:00:00.000Z"),
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
      excerpt: "the 50% budget",
      excerptStart: 1,
      matchCount: 2,
      matchPosition: 5,
      messageId: "message-1",
      textLength: 14,
      title: "Planning"
    }]);
    const rows = await findMessageMatches(fake, {
      after: { id: "chat-9", updatedAt: "2026-08-14T00:00:00.000Z" },
      limit: 31,
      query: "50%",
      userId: "user-1"
    });

    expect(rows).toEqual([{
      chatId: "chat-1",
      chatUpdatedAt: new Date("2026-08-13T00:00:00.000Z"),
      createdAt: "2026-08-12T00:00:00.000Z",
      matchCount: 2,
      messageId: "message-1",
      snippet: "the 50% budget",
      title: "Planning"
    }]);
    expect(statements[0]?.sql).toContain("statement_timeout");
    expect(statements[0]?.values).toEqual([String(MESSAGE_SEARCH_STATEMENT_TIMEOUT_MS)]);
    const query = statements[1]!;
    // The query text carries no user value; scope, keyset and pattern are parameters.
    expect(query.sql).not.toMatch(/50%|user-1|chat-9/u);
    expect(query.values).toEqual(expect.arrayContaining(["user-1", "chat-9", "%50\\%%", "50%"]));
    expect(query.sql).toContain("aiqsa_message_search_text(message.\"content\") ILIKE");
    expect(query.sql).toMatch(/chat\."archived" = false/u);
    expect(query.sql).toMatch(/chat\."memoryMode" <> 'TEMPORARY'/u);
    expect(query.sql).toMatch(/chat\."permanentDeletionAt" IS NULL/u);
    expect(query.sql).not.toContain("ANY(");
  });

  it("never matches the steps or superseded versions of an answer review recorded before the removal", async () => {
    const step = (id: string, parentMessageId: string, role: string, systemTurnKind: string | null = null) =>
      ({ answerReviewSessionId: "session-1", id, parentMessageId, role, status: "complete", systemTurnKind });
    const { client: fake, sessions, statements } = client([], {
      messages: [
        { answerReviewSessionId: null, id: "answer-1", parentMessageId: "question-1", role: "assistant", status: "complete",
          systemTurnKind: null },
        step("review-turn", "answer-1", "user", "answer_review_request"),
        step("review", "review-turn", "assistant"),
        step("revision-turn", "review", "user", "answer_revision_request"),
        step("answer-2", "revision-turn", "assistant")
      ],
      sessions: [{ id: "session-1", sourceAssistantMessageId: "answer-1" }]
    });

    await findMessageMatches(fake, { after: null, limit: 31, query: "total", userId: "user-1" });

    expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ where: { chat: { userId: "user-1" } } }));
    const query = statements[1]!;
    expect(query.sql).toContain("AND NOT (message.\"id\" = ANY(");
    // The revised answer stays searchable as the answer the chat shows.
    const hidden = query.values.find((value): value is string[] => Array.isArray(value));
    expect(new Set(hidden)).toEqual(new Set(["answer-1", "review-turn", "review", "revision-turn"]));
  });

  it("reports a statement timeout as its own outcome and rethrows other failures", async () => {
    const timeout = new Prisma.PrismaClientKnownRequestError("canceling statement due to statement timeout", {
      clientVersion: "test",
      code: "P2010",
      meta: { code: "57014" }
    });
    await expect(findMessageMatches(client(timeout).client, {
      after: null, limit: 31, query: "the", userId: "user-1"
    })).resolves.toBe("timeout");
    const failure = new Error("connection lost");
    await expect(findMessageMatches(client(failure).client, {
      after: null, limit: 31, query: "the", userId: "user-1"
    })).rejects.toBe(failure);
  });
});
