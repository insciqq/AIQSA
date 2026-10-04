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
const firstPage = {
  chats: [],
  folders: [],
  messageMatches: { matches: [match("a")], nextCursor: "message_cursor" },
  nextCursor: null
};

describe("chat navigation search actions", () => {
  afterEach(() => {
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
  });

  it("loads message matches with the first page and continues them by their own cursor", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json({ matches: [match("b")], nextCursor: null }));

    await expect(loadChatNavigationSearch({ query: "budget" })).resolves.toBe(true);
    await expect(loadChatMessageMatches({ query: "budget" })).resolves.toBe(true);

    expect(useWorkspaceStore.getState().navigationMessageMatches.map((item) => item.chatId)).toEqual(["a", "b"]);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/chats/search/messages?cursor=message_cursor&limit=30&q=budget");
    // The list is complete: nothing more is requested.
    await expect(loadChatMessageMatches({ query: "budget" })).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("drops a message page that settles after the search changed", async () => {
    let settle: (response: Response) => void = () => undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve; }));
    await loadChatNavigationSearch({ query: "budget" });

    const pending = loadChatMessageMatches({ query: "budget" });
    clearChatNavigationSearch();
    settle(Response.json({ error: "internal_error" }, { status: 500 }));

    await expect(pending).resolves.toBe(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatches: [],
      navigationMessageMatchesError: null,
      navigationMessageMatchesLoading: false
    });
  });

  it("keeps the shown matches and the cursor when a later message page fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json({ error: "chat_navigation_search_timeout" }, { status: 503 }));
    await loadChatNavigationSearch({ query: "budget" });

    await expect(loadChatMessageMatches({ query: "budget" })).resolves.toBe(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      navigationMessageMatches: [match("a")],
      navigationMessageMatchesError: "chat_navigation_search_timeout",
      navigationMessageMatchesLoading: false,
      navigationMessageMatchesNextCursor: "message_cursor"
    });
  });
});
