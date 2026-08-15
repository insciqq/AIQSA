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
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
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
  const [branchGraph, setBranchGraph] = useState<BranchGraphState | null>(null);
  const branchGraphRequestRef = useRef(0);

  const loadBranchGraph = useEventCallback(async () => {
    const chatId = activeChatId;
    if (!chatId) return;
    const requestGeneration = ++branchGraphRequestRef.current;
    setBranchGraph({
      activeLeafId: null,
      chatId,
      error: null,
      graph: null,
      loading: true,
      messages: null,
      snapshotUpdatedAt: null
    });
    try {
      const response = await shellFetch(`/api/chats/${chatId}/branches`);
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, `chat_branches_failed_${response.status}`)
        );
      }
      const decoded = decodeChatBranchesResponse(await response.json());
      if (!decoded) throw new Error("chat_branches_malformed");
      if (
        branchGraphRequestRef.current !== requestGeneration ||
        useWorkspaceStore.getState().activeChatId !== chatId
      ) return;
      setBranchGraph({
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
        snapshotUpdatedAt: decoded.branchGraph.snapshotUpdatedAt
      });
    } catch (error) {
      if (
        branchGraphRequestRef.current === requestGeneration &&
        useWorkspaceStore.getState().activeChatId === chatId
      ) {
        setBranchGraph({
          activeLeafId: null,
          chatId,
          error: errorMessage(error),
          graph: null,
          loading: false,
          messages: null,
          snapshotUpdatedAt: null
        });
      }
    }
  });

  useEffect(() => {
    if (!activeChatId) return;
    const summary = chats.find((chat) => chat.id === activeChatId);
    if (!summary) return;
    // Beyond the explicit Branch drawer, the per-message ‹N/M› version pager
    // needs the compact branch graph for any saved chat with committed
    // messages, so the graph stays current per (chat, updatedAt) revision.
    // A live stream defers background refresh until settlement bumps
    // `updatedAt`.
    if (!branchDrawerOpen && (summary.messageCount === 0 || activeChatStreaming)) {
      return;
    }
    const current = branchGraph?.chatId === activeChatId ? branchGraph : null;
    if (current?.loading || current?.error || (
      current?.messages &&
      current.snapshotUpdatedAt === summary.updatedAt
    )) {
      return;
    }
    void loadBranchGraph();
  }, [
    activeChatId,
    activeChatStreaming,
    branchDrawerOpen,
    branchGraph,
    chats,
    loadBranchGraph
  ]);

  return { branchGraph, loadBranchGraph };
}
