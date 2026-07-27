"use client";

import { useCallback, useEffect, useState } from "react";
import { shellFetch } from "@/components/app-shell/shellApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import type { Notice } from "@/components/app-shell/types";
import { decodeWorkspaceChatsResponse } from "@/lib/contracts/chats";

export function useChatContentSearch(setNotice: (notice: Notice) => void) {
  const [chatQuery, setChatQueryState] = useState("");
  const [chatContentMatchIds, setChatContentMatchIds] = useState<Set<string>>(() => new Set());
  const [chatContentSearchError, setChatContentSearchError] = useState<string | null>(null);
  const [chatContentSearchLoading, setChatContentSearchLoading] = useState(false);

  const setChatQuery = useCallback((value: string) => {
    setChatQueryState(value);
    setChatContentMatchIds(new Set());
    setChatContentSearchError(null);
    setChatContentSearchLoading(Boolean(value.trim()));
  }, []);

  useEffect(() => {
    const query = chatQuery.trim();
    if (!query) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await shellFetch(`/api/chats?q=${encodeURIComponent(query)}`, {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`chat_search_failed_${response.status}`);
        }

        const body = decodeWorkspaceChatsResponse(await response.json());
        if (!body) {
          throw new Error("workspace_malformed");
        }

        setChatContentMatchIds(new Set(body.contentMatches.map((match) => match.chatId)));
        setChatContentSearchError(null);
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = errorMessage(error);
          setNotice({
            kind: "error",
            text: message
          });
          setChatContentMatchIds(new Set());
          setChatContentSearchError(message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setChatContentSearchLoading(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [chatQuery, setNotice]);

  return {
    chatContentMatchIds,
    chatContentSearchError,
    chatContentSearchLoading,
    chatQuery,
    setChatQuery
  };
}
