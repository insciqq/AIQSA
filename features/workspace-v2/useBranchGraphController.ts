"use client";

import {
  normalizeThreadStatus,
  shellFetch
} from "@/components/app-shell/shellApi";
import {
  errorMessage,
  responseErrorMessage
} from "@/components/app-shell/shellFormatting";
import type {
  ThreadMessage,
  WorkspaceChatSummary
} from "@/components/app-shell/types";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import {
  decodeChatBranchesResponse,
  type ChatBranchGraphWire
} from "@/lib/contracts/chats";
import { useEffect, useRef, useState } from "react";

type BranchGraphState = {
  activeLeafId: string | null;
  chatId: string;
  error: string | null;
  graph: ChatBranchGraphWire | null;
  loading: boolean;
  messages: ThreadMessage[] | null;
  snapshotUpdatedAt: string | null;
};

type BranchGraphEntry = BranchGraphState & {
  /** Summary revision this entry was requested for; automatic loads happen once per revision. */
  requestedRevision: string | null;
};

type BranchGraphRequest = {
  chatId: string;
  controller: AbortController;
  generation: number;
};

/** Recently visited chats keep their graph so returning to an unchanged chat
 * does not refetch; evicting an entry only costs one later request. */
const BRANCH_GRAPH_CACHED_CHATS = 8;

/**
 * The browser summary can lag server writes that bump `Chat.updatedAt`
 * (title generation, message deletion, another tab). A graph snapshot taken at
 * or after the summary revision already reflects that revision.
 */
export function branchSnapshotCoversRevision(
  snapshotUpdatedAt: string | null,
  summaryUpdatedAt: string
): boolean {
  if (!snapshotUpdatedAt) return false;
  if (snapshotUpdatedAt === summaryUpdatedAt) return true;
  const snapshot = Date.parse(snapshotUpdatedAt);
  const summary = Date.parse(summaryUpdatedAt);
  return Number.isFinite(snapshot) && Number.isFinite(summary) && snapshot >= summary;
}

function withEntry(
  entries: ReadonlyMap<string, BranchGraphEntry>,
  chatId: string,
  entry: BranchGraphEntry | null
): ReadonlyMap<string, BranchGraphEntry> {
  const next = new Map(entries);
  next.delete(chatId);
  if (entry) next.set(chatId, entry);
  for (const staleChatId of next.keys()) {
    if (next.size <= BRANCH_GRAPH_CACHED_CHATS) break;
    if (staleChatId !== chatId) next.delete(staleChatId);
  }
  return next;
}

export function useBranchGraphController({
  activeChatId,
  activeChatStreaming,
  branchDrawerOpen,
  chats
}: Readonly<{
  activeChatId: string | null;
  activeChatStreaming: boolean;
  branchDrawerOpen: boolean;
  chats: readonly WorkspaceChatSummary[];
}>) {
  const [entries, setEntries] = useState<ReadonlyMap<string, BranchGraphEntry>>(
    () => new Map()
  );
  const requestRef = useRef<BranchGraphRequest | null>(null);
  const generationRef = useRef(0);
  const previousChatIdRef = useRef(activeChatId);

  const writeEntry = (chatId: string, entry: BranchGraphEntry | null) => {
    setEntries((current) => withEntry(current, chatId, entry));
  };

  const startLoad = useEventCallback((chatId: string, revision: string | null) => {
    requestRef.current?.controller.abort();
    const request: BranchGraphRequest = {
      chatId,
      controller: new AbortController(),
      generation: ++generationRef.current
    };
    requestRef.current = request;
    const settled = () => {
      if (requestRef.current?.generation !== request.generation) return false;
      requestRef.current = null;
      return true;
    };
    writeEntry(chatId, {
      activeLeafId: null,
      chatId,
      error: null,
      graph: null,
      loading: true,
      messages: null,
      requestedRevision: revision,
      snapshotUpdatedAt: null
    });
    void (async () => {
      try {
        const response = await shellFetch(`/api/chats/${chatId}/branches`, {
          signal: request.controller.signal
        });
        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(response, `chat_branches_failed_${response.status}`)
          );
        }
        const decoded = decodeChatBranchesResponse(await response.json());
        if (!decoded) throw new Error("chat_branches_malformed");
        if (!settled()) return;
        writeEntry(chatId, {
          activeLeafId: decoded.branchGraph.activeLeafMessageId,
          chatId,
          error: null,
          graph: decoded.branchGraph,
          loading: false,
          messages: decoded.branchGraph.nodes.map((node) => ({
            content: node.preview,
            id: node.id,
            parentMessageId: node.parentMessageId,
            role: node.role,
            status: normalizeThreadStatus(node.status)
          })),
          requestedRevision: revision,
          snapshotUpdatedAt: decoded.branchGraph.snapshotUpdatedAt
        });
      } catch (error) {
        if (!settled()) return;
        writeEntry(chatId, {
          activeLeafId: null,
          chatId,
          error: errorMessage(error),
          graph: null,
          loading: false,
          messages: null,
          requestedRevision: revision,
          snapshotUpdatedAt: null
        });
      }
    })();
  });

  // Leaving a chat cancels its unfinished request. Its unfinished or failed
  // entry is dropped, so the next visit makes one fresh attempt.
  useEffect(() => {
    const previousChatId = previousChatIdRef.current;
    previousChatIdRef.current = activeChatId;
    if (!previousChatId || previousChatId === activeChatId) return;
    if (requestRef.current?.chatId === previousChatId) {
      requestRef.current.controller.abort();
      requestRef.current = null;
    }
    setEntries((current) => {
      const entry = current.get(previousChatId);
      return entry && (entry.loading || entry.error)
        ? withEntry(current, previousChatId, null)
        : current;
    });
  }, [activeChatId]);

  useEffect(() => () => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const summary = activeChatId
    ? chats.find((chat) => chat.id === activeChatId)
    : undefined;
  const summaryRevision = summary?.updatedAt ?? null;
  const summaryMessageCount = summary?.messageCount ?? 0;
  const activeEntry = activeChatId ? entries.get(activeChatId) ?? null : null;

  useEffect(() => {
    if (!activeChatId || summaryRevision === null) return;
    // Beyond the explicit Branch drawer, the per-message ‹N/M› version pager
    // needs the compact branch graph for any saved chat with committed
    // messages, so the graph stays current per (chat, updatedAt) revision.
    // A live stream defers background refresh until settlement bumps
    // `updatedAt`.
    if (!branchDrawerOpen && (summaryMessageCount === 0 || activeChatStreaming)) {
      return;
    }
    if (activeEntry && (
      activeEntry.loading ||
      activeEntry.requestedRevision === summaryRevision ||
      (activeEntry.messages &&
        branchSnapshotCoversRevision(activeEntry.snapshotUpdatedAt, summaryRevision))
    )) {
      return;
    }
    startLoad(activeChatId, summaryRevision);
  }, [
    activeChatId,
    activeChatStreaming,
    activeEntry,
    branchDrawerOpen,
    startLoad,
    summaryMessageCount,
    summaryRevision
  ]);

  const loadBranchGraph = useEventCallback(async () => {
    if (activeChatId) startLoad(activeChatId, summaryRevision);
  });

  const branchGraph: BranchGraphState | null = activeEntry;
  return { branchGraph, loadBranchGraph };
}
