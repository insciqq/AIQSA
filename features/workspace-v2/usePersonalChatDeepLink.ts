"use client";

import { boundedRouteId, parseChatRoutePath } from "@/lib/domain/chatRoute";
import { useEffect, useRef } from "react";

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

/** Which deep link could not be opened: the one-shot Memory source marker or
 * an addressed chat message. */
export type PersonalChatDeepLinkTarget = "memory_source" | "message";

/**
 * Anchors `/c/<chat>?message=<id>` once the route owner has opened that
 * personal chat and loaded its thread, and consumes the one-shot
 * `?memorySource=unavailable` marker. A message that cannot be revealed is
 * dropped from the address; the caller chooses the privacy-neutral response.
 */
export function usePersonalChatDeepLink({
  activeChatId,
  detailLoading,
  onAnchor,
  onUnavailable,
  ready,
  revealMessage
}: Readonly<{
  activeChatId: string | null;
  detailLoading: boolean;
  onAnchor(chatId: string, messageId: string): void;
  onUnavailable(target: PersonalChatDeepLinkTarget): void;
  ready: boolean;
  revealMessage(chatId: string, messageId: string): Promise<boolean>;
}>): void {
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("memorySource") === "unavailable") {
      url.searchParams.delete("memorySource");
      replaceCurrentUrl(url);
      onUnavailable("memory_source");
      return;
    }
    const rawMessageId = url.searchParams.get("message");
    const route = parseChatRoutePath(url.pathname);
    if (!route?.chatId || route.projectId || activeChatId !== route.chatId) {
      // Returning to the chat later anchors its message again.
      handledRef.current = null;
      return;
    }
    if (!ready || detailLoading || rawMessageId === null) return;
    const chatId = route.chatId;
    const key = `${chatId}\u0000${rawMessageId}`;
    if (handledRef.current === key) return;
    handledRef.current = key;
    const dropMessage = () => {
      const currentUrl = new URL(window.location.href);
      if (
        parseChatRoutePath(currentUrl.pathname)?.chatId === chatId &&
        currentUrl.searchParams.get("message") === rawMessageId
      ) {
        currentUrl.searchParams.delete("message");
        replaceCurrentUrl(currentUrl);
      }
      onUnavailable("message");
    };
    const messageId = boundedRouteId(rawMessageId);
    if (!messageId) {
      dropMessage();
      return;
    }
    void revealMessage(chatId, messageId).catch(() => false).then((revealed) => {
      if (handledRef.current !== key) return;
      if (revealed) onAnchor(chatId, messageId);
      else dropMessage();
    });
  }, [activeChatId, detailLoading, onAnchor, onUnavailable, ready, revealMessage]);
}
