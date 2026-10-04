import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import {
  clearChatNavigationSearch,
  loadChatMessageMatches,
  loadChatNavigationSearch
} from "./chatNavigationActions";
import { useWorkspaceStore } from "./workspaceStore";

const match = (chatId: string) => ({
  chatId,
  createdAt: "2026-08-12T10:00:00.000Z",
  matchCount: 1,
  messageId: `message-${chatId}`,
  snippet: "the budget line",
  title: `Chat ${chatId}`
});
const titleChat = {
  activeRun: false,
  assistant: null,
  folderId: null,
  id: "title-chat",
  title: "Budget review",
  updatedAt: "2026-08-13T00:00:00.000Z"
};
const titlePage = { chats: [titleChat], folders: [], nextCursor: null };
const firstMessagePage = { matches: [match("a")], nextCursor: "message_cursor" };

type Responder = (url: URL) => Promise<Response> | Response;

/** Answers each search route by path, so parallel requests settle independently. */
function routeFetch(routes: Readonly<Record<string, Responder>>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://app.local");
    const responder = routes[url.pathname];
    if (!responder) throw new Error(`unexpected request ${url.pathname}`);
    return responder(url);
  });
}

function search(query: string) {
  useWorkspaceStore.getState().setNavigationSearchQuery(query);
}

describe("chat navigation search actions", () => {
  afterEach(() => {
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
  });

  it("loads titles and message matches side by side, a slow message query never holding titles", async () => {
    let releaseMessages: (response: Response) => void = () => undefined;
    const fetch = routeFetch({
      "/api/chats/search": () => Response.json(titlePage),
      "/api/chats/search/messages": () => new Promise<Response>((resolve) => { releaseMessages = resolve; })
    });
    search("budget");

    const messages = loadChatMessageMatches({ query: "budget" });
    await expect(loadChatNavigationSearch({ query: "budget" })).resolves.toBe(true);
    // Titles are shown while the message query still runs.
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatchesLoading: true,
      navigationMessageMatchesReady: false,
      navigationSearchChats: [titleChat],
      navigationSearchLoading: false
    });

    releaseMessages(Response.json(firstMessagePage));
    await expect(messages).resolves.toBe(true);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatches: [match("a")],
      navigationMessageMatchesLoading: false,
      navigationMessageMatchesNextCursor: "message_cursor",
      navigationMessageMatchesReady: true,
      navigationSearchChats: [titleChat]
    });
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      "/api/chats/search?limit=30&q=budget",
      "/api/chats/search/messages?limit=30&q=budget"
    ]));
  });

  it("continues message matches by their own cursor and stops at the end", async () => {
    const fetch = routeFetch({
      "/api/chats/search/messages": (url) => Response.json(url.searchParams.get("cursor")
        ? { matches: [match("b")], nextCursor: null }
        : firstMessagePage)
    });
    search("budget");

    await expect(loadChatMessageMatches({ query: "budget" })).resolves.toBe(true);
    await expect(loadChatMessageMatches({ append: true, query: "budget" })).resolves.toBe(true);
    expect(useWorkspaceStore.getState().navigationMessageMatches.map((item) => item.chatId)).toEqual(["a", "b"]);
    expect(String(fetch.mock.calls[1]?.[0])).toBe("/api/chats/search/messages?cursor=message_cursor&limit=30&q=budget");
    await expect(loadChatMessageMatches({ append: true, query: "budget" })).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never requests message matches below three characters", async () => {
    const fetch = routeFetch({});
    search("ab");
    await expect(loadChatMessageMatches({ query: "ab" })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a message response or failure that settles after the query changed", async () => {
    const pending: Array<(response: Response) => void> = [];
    routeFetch({
      "/api/chats/search/messages": () => new Promise<Response>((resolve) => { pending.push(resolve); })
    });
    search("budget");
    const older = loadChatMessageMatches({ query: "budget" });
    search("budgets");
    const newer = loadChatMessageMatches({ query: "budgets" });

    // The older query's page arrives last and is ignored.
    pending[1]!(Response.json({ matches: [match("new")], nextCursor: null }));
    await expect(newer).resolves.toBe(true);
    pending[0]!(Response.json(firstMessagePage));
    await expect(older).resolves.toBe(false);
    expect(useWorkspaceStore.getState().navigationMessageMatches.map((item) => item.chatId)).toEqual(["new"]);

    const failing = loadChatMessageMatches({ query: "budgets" });
    clearChatNavigationSearch();
    pending[2]!(Response.json({ error: "internal_error" }, { status: 500 }));
    await expect(failing).resolves.toBe(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatches: [],
      navigationMessageMatchesError: null,
      navigationMessageMatchesLoading: false
    });
  });

  it("lets a repeated first page supersede one still in flight for the same query", async () => {
    const pending: Array<(response: Response) => void> = [];
    routeFetch({
      "/api/chats/search/messages": () => new Promise<Response>((resolve) => { pending.push(resolve); })
    });
    search("budget");
    const first = loadChatMessageMatches({ query: "budget" });
    const retry = loadChatMessageMatches({ query: "budget" });
    pending[1]!(Response.json({ matches: [match("fresh")], nextCursor: null }));
    pending[0]!(Response.json({ error: "chat_navigation_search_timeout" }, { status: 503 }));
    await expect(retry).resolves.toBe(true);
    await expect(first).resolves.toBe(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatches: [match("fresh")],
      navigationMessageMatchesError: null
    });
  });

  it("keeps the message failure to its own list and the shown matches on a later page failure", async () => {
    let messagesFail = true;
    routeFetch({
      "/api/chats/search": () => Response.json(titlePage),
      "/api/chats/search/messages": (url) => messagesFail
        ? Response.json({ error: "chat_navigation_search_timeout" }, { status: 503 })
        : Response.json(url.searchParams.get("cursor") ? { error: "internal_error" } : firstMessagePage,
          { status: url.searchParams.get("cursor") ? 500 : 200 })
    });
    search("the");
    await Promise.all([loadChatNavigationSearch({ query: "the" }), loadChatMessageMatches({ query: "the" })]);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatchesError: "chat_navigation_search_timeout",
      navigationMessageMatchesLoading: false,
      navigationSearchChats: [titleChat],
      navigationSearchError: null
    });

    // A title retry for the same query leaves the message state as it is.
    await loadChatNavigationSearch({ query: "the" });
    expect(useWorkspaceStore.getState().navigationMessageMatchesError).toBe("chat_navigation_search_timeout");

    messagesFail = false;
    await expect(loadChatMessageMatches({ query: "the" })).resolves.toBe(true);
    await expect(loadChatMessageMatches({ append: true, query: "the" })).resolves.toBe(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatches: [match("a")],
      navigationMessageMatchesError: "internal_error",
      navigationMessageMatchesLoading: false,
      navigationMessageMatchesNextCursor: "message_cursor"
    });
  });
});
