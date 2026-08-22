import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openPersonalChatMessage,
  revealPersonalChatDeepLinkMessage,
  usePersonalChatDeepLink
} from "./usePersonalChatDeepLink";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("usePersonalChatDeepLink", () => {
  it("opens and anchors an explicit Library file source only after it is revealed", async () => {
    const activateChat = vi.fn(async () => true);
    const revealMessage = vi.fn(async () => true);
    const onAnchor = vi.fn();

    await expect(openPersonalChatMessage({
      activateChat,
      chatId: "chat-1",
      messageId: "message-1",
      onAnchor,
      revealMessage
    })).resolves.toBe(true);
    expect(revealMessage).toHaveBeenCalledWith("chat-1", "message-1");
    expect(onAnchor).toHaveBeenCalledWith("chat-1", "message-1");

    revealMessage.mockResolvedValueOnce(false);
    await expect(openPersonalChatMessage({
      activateChat,
      chatId: "chat-1",
      messageId: "missing",
      onAnchor,
      revealMessage
    })).resolves.toBe(false);
    expect(onAnchor).toHaveBeenCalledOnce();
  });

  it("loads older pages until the exact linked message is present", async () => {
    let current = {
      beforeCursor: "cursor-older" as string | null,
      hasOlder: true,
      messageIds: ["latest-message"] as readonly string[]
    };
    const loadEarlier = vi.fn(async () => {
      current = {
        beforeCursor: null,
        hasOlder: false,
        messageIds: ["linked-message", "latest-message"]
      };
      return true;
    });

    await expect(revealPersonalChatDeepLinkMessage({
      current: () => current,
      loadEarlier,
      messageId: "linked-message"
    })).resolves.toBe(true);
    expect(loadEarlier).toHaveBeenCalledOnce();
  });

  it("opens and anchors a Personal chat only once while leaving Project links alone", async () => {
    window.history.replaceState(null, "", "/?chat=chat-1&message=message-1");
    const activateChat = vi.fn(async () => true);
    const revealMessage = vi.fn(async () => true);
    const onAnchor = vi.fn();
    const onUnavailable = vi.fn();
    const { rerender, unmount } = renderHook(() => usePersonalChatDeepLink({
      activateChat,
      onAnchor,
      onUnavailable,
      ready: true,
      revealMessage
    }));

    await waitFor(() => expect(onAnchor).toHaveBeenCalledWith("chat-1", "message-1"));
    rerender();
    expect(activateChat).toHaveBeenCalledOnce();
    expect(revealMessage).toHaveBeenCalledOnce();
    expect(onUnavailable).not.toHaveBeenCalled();
    unmount();

    window.history.replaceState(
      null,
      "",
      "/?project=project-1&chat=project-chat&message=project-message"
    );
    const projectActivate = vi.fn(async () => true);
    renderHook(() => usePersonalChatDeepLink({
      activateChat: projectActivate,
      onAnchor: vi.fn(),
      onUnavailable: vi.fn(),
      ready: true,
      revealMessage: vi.fn(async () => true)
    }));

    expect(projectActivate).not.toHaveBeenCalled();
    expect(window.location.search).toContain("project=project-1");
  });

  it("announces and clears the one-shot unavailable marker without exposing details", () => {
    window.history.replaceState(
      null,
      "",
      "/?memorySource=unavailable&keep=yes#answer"
    );
    const onUnavailable = vi.fn();
    renderHook(() => usePersonalChatDeepLink({
      activateChat: vi.fn(async () => true),
      onAnchor: vi.fn(),
      onUnavailable,
      ready: false,
      revealMessage: vi.fn(async () => true)
    }));

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#answer");
  });
});
