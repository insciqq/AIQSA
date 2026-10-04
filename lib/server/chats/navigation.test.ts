import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import {
  createListChatNavigationHandler,
  createPrismaChatNavigationRepository,
  createSearchChatMessagesHandler,
  createSearchChatNavigationHandler,
  type ChatNavigationRepository
} from "./navigation";

const config = getAuthConfig({
  AIQSA_AUTH_SESSION_SECRET: "secret",
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

function repository() {
  const listPage = vi.fn<ChatNavigationRepository["listPage"]>(async () => ({
      kind: "ok",
      page: {
        chats: [{
          activeRun: true,
          assistant: null,
          folderId: "folder-1",
          id: "chat-1",
          title: "Quarterly review",
          updatedAt: "2026-08-13T00:00:00.000Z"
        }],
        folders: [{ id: "folder-1", name: "Work", parentId: null }],
        nextCursor: "next_cursor"
      }
    }));
  const searchPage = vi.fn<ChatNavigationRepository["searchPage"]>(async () => ({
      kind: "ok",
      page: { chats: [], folders: [], messageMatches: null, nextCursor: null }
    }));
  const searchMessagesPage = vi.fn<ChatNavigationRepository["searchMessagesPage"]>(async () => ({
      kind: "ok",
      page: { matches: [], nextCursor: null }
    }));
  return { listPage, searchMessagesPage, searchPage } satisfies ChatNavigationRepository;
}

const messageMatch = {
  chatId: "chat-2",
  createdAt: "2026-08-12T10:00:00.000Z",
  matchCount: 2,
  messageId: "message-9",
  snippet: "…moved the quarterly budget to…",
  title: "Planning"
};

describe("chat navigation handlers", () => {
  it("returns only the compact owner projection with private caching", async () => {
    const repo = repository();
    const GET = createListChatNavigationHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      "http://app.local/api/chats/compact?limit=12&cursor=previous_cursor",
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(repo.listPage).toHaveBeenCalledWith({
      cursor: "previous_cursor",
      limit: 12,
      userId: config.bootstrapUserId
    });
    const body = await response.json();
    expect(body.chats[0]).toEqual({
      activeRun: true,
      assistant: null,
      folderId: "folder-1",
      id: "chat-1",
      title: "Quarterly review",
      updatedAt: "2026-08-13T00:00:00.000Z"
    });
    expect(JSON.stringify(body)).not.toMatch(/message|model|provider|content|prompt/iu);
  });

  it("requires auth before calling either repository path", async () => {
    const repo = repository();
    const deps = { repository: repo, resolveAuth: auth.resolveAuth };
    const responses = await Promise.all([
      createListChatNavigationHandler(deps)(
        new Request("http://app.local/api/chats/compact")
      ),
      createSearchChatNavigationHandler(deps)(
        new Request("http://app.local/api/chats/search?q=work")
      )
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect(repo.listPage).not.toHaveBeenCalled();
    expect(repo.searchPage).not.toHaveBeenCalled();
    const messages = await createSearchChatMessagesHandler(deps)(
      new Request("http://app.local/api/chats/search/messages?q=budget")
    );
    expect(messages.status).toBe(401);
    expect(repo.searchMessagesPage).not.toHaveBeenCalled();
  });

  it.each([
    "?limit=0",
    "?limit=51",
    "?limit=2.5",
    "?cursor=",
    "?unknown=1",
    "?limit=2&limit=3"
  ])("rejects malformed compact query controls: %s", async (suffix) => {
    const repo = repository();
    const GET = createListChatNavigationHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      `http://app.local/api/chats/compact${suffix}`,
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "chat_navigation_query_invalid"
    });
    expect(repo.listPage).not.toHaveBeenCalled();
  });

  it("searches title and folder through the owner-fenced repository contract", async () => {
    const repo = repository();
    const GET = createSearchChatNavigationHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      "http://app.local/api/chats/search?q=%20Work%20&limit=7",
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(200);
    expect(repo.searchPage).toHaveBeenCalledWith({
      cursor: null,
      limit: 7,
      query: "work",
      userId: config.bootstrapUserId
    });
  });

  it.each([
    "",
    "?q=",
    "?q=%20%20",
    "?q=a&q=b",
    `?q=${"x".repeat(121)}`,
    `?q=${encodeURIComponent("㍍".repeat(31))}`,
    "?q=work&content=secret"
  ])("rejects malformed search query controls: %s", async (suffix) => {
    const repo = repository();
    const GET = createSearchChatNavigationHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      `http://app.local/api/chats/search${suffix}`,
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(400);
    expect(repo.searchPage).not.toHaveBeenCalled();
  });

  it("returns message matches as a separate page beside the title results", async () => {
    const repo = repository();
    repo.searchPage.mockResolvedValueOnce({
      kind: "ok",
      page: {
        chats: [],
        folders: [],
        messageMatches: { matches: [messageMatch], nextCursor: "message_cursor" },
        nextCursor: null
      }
    });
    const GET = createSearchChatNavigationHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      "http://app.local/api/chats/search?q=Budget",
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      chats: [],
      folders: [],
      messageMatches: { matches: [messageMatch], nextCursor: "message_cursor" },
      nextCursor: null
    });
  });

  it("fails a search whose message matching timed out with a stable code", async () => {
    const repo = repository();
    repo.searchPage.mockResolvedValueOnce({ kind: "message_search_timeout" });
    repo.searchMessagesPage.mockResolvedValueOnce({ kind: "message_search_timeout" });
    const deps = { repository: repo, resolveAuth: auth.resolveAuth };
    const responses = await Promise.all([
      createSearchChatNavigationHandler(deps)(new Request(
        "http://app.local/api/chats/search?q=the",
        { headers: { cookie: auth.cookie } }
      )),
      createSearchChatMessagesHandler(deps)(new Request(
        "http://app.local/api/chats/search/messages?q=the&cursor=next_page",
        { headers: { cookie: auth.cookie } }
      ))
    ]);

    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({ error: "chat_navigation_search_timeout" });
    }
  });

  it("continues message matches through their own owner-fenced route", async () => {
    const repo = repository();
    repo.searchMessagesPage.mockResolvedValueOnce({
      kind: "ok",
      page: { matches: [messageMatch], nextCursor: null }
    });
    const GET = createSearchChatMessagesHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      "http://app.local/api/chats/search/messages?q=%20Budget%20&cursor=message_cursor&limit=20",
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(200);
    expect(repo.searchMessagesPage).toHaveBeenCalledWith({
      cursor: "message_cursor",
      limit: 20,
      query: "budget",
      userId: config.bootstrapUserId
    });
    await expect(response.json()).resolves.toEqual({ matches: [messageMatch], nextCursor: null });
  });

  it.each([
    "?q=ab",
    "?q=%20a%20",
    "?q=budget&cursor=",
    "?q=budget&limit=51",
    `?q=${"x".repeat(121)}`,
    "?q=budget&content=secret"
  ])("rejects message continuation controls that cannot match text: %s", async (suffix) => {
    const repo = repository();
    const GET = createSearchChatMessagesHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      `http://app.local/api/chats/search/messages${suffix}`,
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "chat_navigation_query_invalid" });
    expect(repo.searchMessagesPage).not.toHaveBeenCalled();
  });

  it("maps a rejected message cursor like a rejected title cursor", async () => {
    const repo = repository();
    repo.searchMessagesPage.mockResolvedValueOnce({ kind: "cursor_invalid" });
    const GET = createSearchChatMessagesHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      "http://app.local/api/chats/search/messages?q=budget&cursor=title_cursor",
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "chat_navigation_cursor_invalid" });
  });

  it("maps a query-bound cursor rejection without retrying loosely", async () => {
    const repo = repository();
    repo.searchPage.mockResolvedValueOnce({ kind: "cursor_invalid" });
    const GET = createSearchChatNavigationHandler({
      repository: repo,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request(
      "http://app.local/api/chats/search?q=work&cursor=wrong_scope",
      { headers: { cookie: auth.cookie } }
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "chat_navigation_cursor_invalid"
    });
  });

  it("shows an Assistant avatar only while the viewer can use that Assistant, with one lookup per page", async () => {
    const avatar = {
      accents: [0, 4],
      backgroundShape: "circle",
      foregroundShape: "diamond",
      kind: "generated",
      paletteId: "ocean",
      recipeVersion: 1,
      rotations: [0, 2]
    };
    const updatedAt = new Date("2026-09-28T00:00:00.000Z");
    const row = (id: string, assistantId: string | null) => ({
      assistantId, folderId: null, id, modelRuns: [], scheduledTaskOccurrences: [], scheduledTasks: [], title: id, updatedAt
    });
    const queryRaw = vi.fn(async () => [{ avatar, id: "assistant-live", name: "Live helper" }]);
    const client = {
      $queryRaw: queryRaw,
      chat: {
        findMany: vi.fn(async () => [
          row("chat-live", "assistant-live"),
          row("chat-live-2", "assistant-live"),
          row("chat-revoked", "assistant-revoked"),
          row("chat-plain", null)
        ])
      },
      folder: { findMany: vi.fn(async () => []) }
    };
    const result = await createPrismaChatNavigationRepository(client as never)
      .listPage({ cursor: null, limit: 30, userId: "user-1" });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: "ok" });
    const chats = result.kind === "ok" ? result.page.chats : [];
    expect(chats.map((chat) => [chat.id, chat.assistant])).toEqual([
      ["chat-live", { avatar, name: "Live helper" }],
      ["chat-live-2", { avatar, name: "Live helper" }],
      ["chat-revoked", null],
      ["chat-plain", null]
    ]);

    queryRaw.mockClear();
    client.chat.findMany.mockResolvedValueOnce([row("chat-plain", null)]);
    await createPrismaChatNavigationRepository(client as never)
      .listPage({ cursor: null, limit: 30, userId: "user-1" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("projects only a task chat's task id and the unread marker of its own results", async () => {
    const updatedAt = new Date("2026-10-04T09:00:00.000Z");
    const chat = (id: string, scheduledTasks: Array<{ id: string }>, occurrences: Array<{ taskId: string; unseenAt: Date | null }>) => ({
      assistantId: null, folderId: null, id, modelRuns: [], scheduledTaskOccurrences: occurrences, scheduledTasks, title: id, updatedAt
    });
    const client = {
      $queryRaw: vi.fn(async () => []),
      chat: {
        findMany: vi.fn(async () => [
          chat("chat-unread", [{ id: "task-1" }], [{ taskId: "task-1", unseenAt: updatedAt }]),
          // The task's newest chat with no unread result of its own.
          chat("chat-read", [{ id: "task-2" }], [{ taskId: "task-2", unseenAt: null }]),
          // An earlier "new chat each run" chat keeps its own unread result.
          chat("chat-earlier", [], [{ taskId: "task-2", unseenAt: updatedAt }]),
          chat("chat-plain", [], [])
        ])
      },
      folder: { findMany: vi.fn(async () => []) }
    };
    const result = await createPrismaChatNavigationRepository(client as never)
      .listPage({ cursor: null, limit: 30, userId: "user-1" });
    const chats = result.kind === "ok" ? result.page.chats : [];
    expect(chats.map((row) => [row.id, row.scheduledTask])).toEqual([
      ["chat-unread", { taskId: "task-1", unseen: true }],
      ["chat-read", { taskId: "task-2", unseen: false }],
      ["chat-earlier", { taskId: "task-2", unseen: true }],
      ["chat-plain", null]
    ]);
    expect(client.chat.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        scheduledTaskOccurrences: expect.objectContaining({ select: { taskId: true, unseenAt: true }, take: 1 }),
        scheduledTasks: expect.objectContaining({ select: { id: true } })
      })
    }));
  });
});
