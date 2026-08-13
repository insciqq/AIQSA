import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createListChatNavigationHandler,
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
      page: { chats: [], folders: [], nextCursor: null }
    }));
  return { listPage, searchPage } satisfies ChatNavigationRepository;
}

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
});
