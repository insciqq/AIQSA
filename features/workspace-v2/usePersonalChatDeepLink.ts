"use client";

import { useEffect, useRef } from "react";

type PersonalChatDeepLinkRequest = {
  key: string;
  phase: "handled" | "opening";
};

function boundedId(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 &&
    normalized.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function replaceCurrentUrl(url: URL): void {
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export async function revealPersonalChatDeepLinkMessage(input: Readonly<{
  current(): Readonly<{
    beforeCursor: string | null;
    hasOlder: boolean;
    messageIds: readonly string[];
  }>;
  loadEarlier(): Promise<boolean>;
  messageId: string;
}>): Promise<boolean> {
  const seenCursors = new Set<string>();
  while (true) {
    const current = input.current();
    if (current.messageIds.includes(input.messageId)) return true;
    if (
      !current.hasOlder ||
      !current.beforeCursor ||
      seenCursors.has(current.beforeCursor)
    ) {
      return false;
    }
    seenCursors.add(current.beforeCursor);
    if (!await input.loadEarlier()) return false;
  }
}

export async function openPersonalChatMessage(input: Readonly<{
  activateChat(chatId: string): Promise<boolean>;
  chatId: string;
  messageId: string;
  onAnchor(chatId: string, messageId: string): void;
  revealMessage(chatId: string, messageId: string): Promise<boolean>;
}>): Promise<boolean> {
  try {
    if (!await input.activateChat(input.chatId)) return false;
    if (!await input.revealMessage(input.chatId, input.messageId)) return false;
    input.onAnchor(input.chatId, input.messageId);
    return true;
  } catch {
    return false;
  }
}

export function usePersonalChatDeepLink({
  activateChat,
  onAnchor,
  onUnavailable,
  ready,
  revealMessage
}: Readonly<{
  activateChat(chatId: string): Promise<boolean>;
  onAnchor(chatId: string, messageId: string): void;
  onUnavailable(): void;
  ready: boolean;
  revealMessage(chatId: string, messageId: string): Promise<boolean>;
}>): void {
  const requestRef = useRef<PersonalChatDeepLinkRequest | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("memorySource") === "unavailable") {
      url.searchParams.delete("memorySource");
      replaceCurrentUrl(url);
      onUnavailable();
      return;
    }
    if (!ready || url.searchParams.has("project")) return;

    const rawChatId = url.searchParams.get("chat");
    const rawMessageId = url.searchParams.get("message");
    if (rawChatId === null && rawMessageId === null) return;
    const chatId = boundedId(rawChatId);
    const messageId = boundedId(rawMessageId);
    const key = `${rawChatId ?? ""}\u0000${rawMessageId ?? ""}`;
    if (!chatId || !messageId) {
      if (requestRef.current?.key === key) return;
      requestRef.current = { key, phase: "handled" };
      url.searchParams.delete("chat");
      url.searchParams.delete("message");
      replaceCurrentUrl(url);
      onUnavailable();
      return;
    }
    if (requestRef.current?.key === key) return;

    const request: PersonalChatDeepLinkRequest = { key, phase: "opening" };
    requestRef.current = request;
    void (async () => {
      let revealed = false;
      try {
        const opened = await activateChat(chatId);
        revealed = opened && await revealMessage(chatId, messageId);
      } catch {
        revealed = false;
      }
      if (requestRef.current !== request) return;
      request.phase = "handled";
      if (revealed) {
        onAnchor(chatId, messageId);
      } else {
        const currentUrl = new URL(window.location.href);
        if (
          currentUrl.searchParams.get("chat") === rawChatId &&
          currentUrl.searchParams.get("message") === rawMessageId &&
          !currentUrl.searchParams.has("project")
        ) {
          currentUrl.searchParams.delete("chat");
          currentUrl.searchParams.delete("message");
          replaceCurrentUrl(currentUrl);
        }
        onUnavailable();
      }
    })();
  }, [activateChat, onAnchor, onUnavailable, ready, revealMessage]);
}
