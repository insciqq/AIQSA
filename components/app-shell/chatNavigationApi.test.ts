import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatNavigationApiError,
  listChatNavigation,
  searchChatMessageMatches,
  searchChatNavigation
} from "./chatNavigationApi";

const page = {
  chats: [{
    activeRun: false,
    assistant: null,
    folderId: null,
    id: "chat-1",
    title: "Notes",
    updatedAt: "2026-08-13T00:00:00.000Z"
  }],
  folders: [],
  nextCursor: null
};
const matches = {
  matches: [{
    chatId: "chat-2",
    createdAt: "2026-08-12T10:00:00.000Z",
    matchCount: 1,
    messageId: "message-1",
    snippet: "the research plan",
    title: "Plans"
  }],
  nextCursor: "message_cursor"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat navigation API", () => {
  it("requests the bounded compact, title search and message match endpoints", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json(matches))
      .mockResolvedValueOnce(Response.json(matches));

    await expect(listChatNavigation({ cursor: "cursor-1", limit: 12 })).resolves.toEqual(page);
    await expect(searchChatNavigation({ query: "Research" })).resolves.toEqual(page);
    await expect(searchChatMessageMatches({ query: "Research" })).resolves.toEqual(matches);
    await expect(searchChatMessageMatches({ cursor: "message_cursor", query: "Research" }))
      .resolves.toEqual(matches);

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/chats/compact?cursor=cursor-1&limit=12",
      "/api/chats/search?limit=30&q=Research",
      "/api/chats/search/messages?limit=30&q=Research",
      "/api/chats/search/messages?cursor=message_cursor&limit=30&q=Research"
    ]);
  });

  it("fails closed for malformed success payloads and preserves stable server codes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ...page, privateContent: "no" }))
      .mockResolvedValueOnce(Response.json(
        { error: "chat_navigation_cursor_invalid" },
        { status: 400 }
      ))
      // The title response never carries message matches.
      .mockResolvedValueOnce(Response.json({ ...page, messageMatches: matches }))
      .mockResolvedValueOnce(Response.json(
        { error: "chat_navigation_search_timeout" },
        { status: 503 }
      ));

    await expect(listChatNavigation()).rejects.toMatchObject({
      message: "chat_navigation_response_invalid",
      status: 502
    });
    await expect(searchChatNavigation({ query: "Research" })).rejects.toEqual(
      expect.objectContaining<Partial<ChatNavigationApiError>>({
        message: "chat_navigation_cursor_invalid",
        status: 400
      })
    );
    await expect(searchChatNavigation({ query: "Research" })).rejects.toMatchObject({
      message: "chat_navigation_response_invalid",
      status: 502
    });
    await expect(searchChatMessageMatches({ query: "the" })).rejects.toMatchObject({
      message: "chat_navigation_search_timeout",
      status: 503
    });
  });
});
