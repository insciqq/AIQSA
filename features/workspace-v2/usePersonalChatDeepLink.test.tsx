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

type DeepLinkProps = Parameters<typeof usePersonalChatDeepLink>[0];

function renderDeepLink(overrides: Partial<DeepLinkProps> = {}) {
  const props: DeepLinkProps = {
    activeChatId: "chat-1",
    detailLoading: false,
    onAnchor: vi.fn(),
    onUnavailable: vi.fn(),
    ready: true,
    revealMessage: vi.fn(async () => true),
    ...overrides
  };
  const hook = renderHook((next: DeepLinkProps) => usePersonalChatDeepLink(next), { initialProps: props });
  return { ...hook, props };
}

describe("usePersonalChatDeepLink", () => {
  it("anchors a message once the route owner shows the addressed chat with its thread", async () => {
    window.history.replaceState(null, "", "/c/chat-1?message=message-1&keep=yes");
    const { props, rerender } = renderDeepLink({ activeChatId: null });
    rerender({ ...props, activeChatId: "chat-1", detailLoading: true });
    expect(props.revealMessage).not.toHaveBeenCalled();
    rerender({ ...props, activeChatId: "chat-1", detailLoading: false });
    await waitFor(() => expect(props.onAnchor).toHaveBeenCalledWith("chat-1", "message-1"));
    rerender({ ...props, activeChatId: "chat-1", detailLoading: false });
    expect(props.revealMessage).toHaveBeenCalledOnce();
    expect(props.onUnavailable).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/c/chat-1?message=message-1&keep=yes");
  });

  it("drops a message that cannot be revealed with the privacy-neutral notice", async () => {
    window.history.replaceState(null, "", "/c/chat-1?message=gone&keep=yes#answer");
    const { props } = renderDeepLink({ revealMessage: vi.fn(async () => false) });
    await waitFor(() => expect(props.onUnavailable).toHaveBeenCalledOnce());
    expect(props.onUnavailable).toHaveBeenCalledWith("message");
    expect(props.onAnchor).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/c/chat-1?keep=yes#answer");

    window.history.replaceState(null, "", `/c/chat-1?message=${"x".repeat(257)}`);
    const unbounded = renderDeepLink();
    await waitFor(() => expect(unbounded.props.onUnavailable).toHaveBeenCalledOnce());
    expect(unbounded.props.revealMessage).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("ignores a reveal that settles after the chat changed", async () => {
    window.history.replaceState(null, "", "/c/chat-1?message=message-1");
    let finish!: (revealed: boolean) => void;
    const { props, rerender } = renderDeepLink({
      revealMessage: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }))
    });
    await waitFor(() => expect(props.revealMessage).toHaveBeenCalledOnce());
    window.history.replaceState(null, "", "/c/chat-2");
    rerender({ ...props, activeChatId: "chat-2" });
    finish(false);
    await Promise.resolve();
    expect(props.onAnchor).not.toHaveBeenCalled();
    expect(props.onUnavailable).not.toHaveBeenCalled();
  });

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

  it("leaves Project chat routes and the new chat alone", () => {
    for (const address of ["/p/project-1/c/chat-1?message=message-1", "/?message=message-1"]) {
      window.history.replaceState(null, "", address);
      const { props, unmount } = renderDeepLink();
      expect(props.revealMessage).not.toHaveBeenCalled();
      expect(props.onUnavailable).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("reports the one-shot Memory source marker separately and clears it without details", () => {
    window.history.replaceState(
      null,
      "",
      "/c/chat-1?memorySource=unavailable&keep=yes#answer"
    );
    const { props } = renderDeepLink({ activeChatId: null, ready: false });

    expect(props.onUnavailable).toHaveBeenCalledOnce();
    expect(props.onUnavailable).toHaveBeenCalledWith("memory_source");
    expect(window.location.pathname).toBe("/c/chat-1");
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#answer");
  });
});
