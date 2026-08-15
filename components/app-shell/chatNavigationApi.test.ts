import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatNavigationApiError,
  listChatNavigation,
  searchChatNavigation
} from "./chatNavigationApi";

const page = {
  chats: [{
    activeRun: false,
    folderId: null,
    id: "chat-1",
    title: "Notes",
    updatedAt: "2026-08-13T00:00:00.000Z"
  }],
  folders: [],
  nextCursor: null
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat navigation API", () => {
  it("requests the bounded compact and title/folder search endpoints", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json(page));

    await expect(listChatNavigation({ cursor: "cursor-1", limit: 12 })).resolves.toEqual(page);
    await expect(searchChatNavigation({ query: "Research" })).resolves.toEqual(page);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/chats/compact?cursor=cursor-1&limit=12"
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "/api/chats/search?limit=30&q=Research"
    );
  });

  it("fails closed for malformed success payloads and preserves stable server codes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ...page, privateContent: "no" }))
      .mockResolvedValueOnce(Response.json(
        { error: "chat_navigation_cursor_invalid" },
        { status: 400 }
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
  });
});
