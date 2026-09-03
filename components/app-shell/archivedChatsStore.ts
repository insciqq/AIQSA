import {
  listArchivedChats,
  loadArchivedChat,
  loadArchivedMessages,
  restoreChat
} from "@/components/app-shell/chatLifecycleApi";
import { chatDetailFromApi, messageFromApi } from "@/components/app-shell/shellApi";
import type { ChatDetail, ThreadMessage } from "@/components/app-shell/types";
import type { ArchivedChatSummaryWire } from "@/lib/contracts/chats";
import { create } from "zustand";

export type ArchivedChatPreview = ChatDetail & {
  archived: true;
  memoryMode: "NORMAL" | "EXCLUDED";
  sourceRevision: number;
};

type LoadState = "error" | "idle" | "loading" | "ready";

type ArchivedChatsStore = {
  detail: ArchivedChatPreview | null;
  detailError: string | null;
  detailLoadState: LoadState;
  listError: string | null;
  listLoadState: LoadState;
  nextCursor: string | null;
  restoring: boolean;
  summaries: ArchivedChatSummaryWire[];
};

const initialState: ArchivedChatsStore = {
  detail: null,
  detailError: null,
  detailLoadState: "idle",
  listError: null,
  listLoadState: "idle",
  nextCursor: null,
  restoring: false,
  summaries: []
};

export const useArchivedChatsStore = create<ArchivedChatsStore>(() => initialState);

let listGeneration = 0;
let detailGeneration = 0;
let restoreGeneration = 0;

function errorName(error: unknown): string {
  return error instanceof Error ? error.message : "chat_lifecycle_failed";
}

function uniqueSummaries(items: readonly ArchivedChatSummaryWire[]): ArchivedChatSummaryWire[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function previewFromWire(
  wire: Awaited<ReturnType<typeof loadArchivedChat>>["chat"]
): ArchivedChatPreview {
  return {
    ...chatDetailFromApi(wire),
    archived: true,
    memoryMode: wire.memoryMode,
    sourceRevision: wire.sourceRevision
  };
}

export async function refreshArchivedChats(append = false): Promise<void> {
  const generation = ++listGeneration;
  const current = useArchivedChatsStore.getState();
  useArchivedChatsStore.setState({ listError: null, listLoadState: "loading" });
  try {
    const response = await listArchivedChats(append ? current.nextCursor : null);
    if (generation !== listGeneration) return;
    useArchivedChatsStore.setState((state) => ({
      listError: null,
      listLoadState: "ready",
      nextCursor: response.nextCursor,
      summaries: uniqueSummaries(append ? [...state.summaries, ...response.chats] : response.chats)
    }));
  } catch (error) {
    if (generation !== listGeneration) return;
    useArchivedChatsStore.setState({ listError: errorName(error), listLoadState: "error" });
    throw error;
  }
}

export async function openArchivedChatPreview(chatId: string): Promise<void> {
  const generation = ++detailGeneration;
  useArchivedChatsStore.setState({
    detail: null,
    detailError: null,
    detailLoadState: "loading"
  });
  try {
    const response = await loadArchivedChat(chatId);
    if (generation !== detailGeneration) return;
    useArchivedChatsStore.setState({
      detail: previewFromWire(response.chat),
      detailError: null,
      detailLoadState: "ready"
    });
  } catch (error) {
    if (generation !== detailGeneration) return;
    useArchivedChatsStore.setState({
      detailError: errorName(error),
      detailLoadState: "error"
    });
    throw error;
  }
}

export function showArchivedChatList(): void {
  detailGeneration += 1;
  useArchivedChatsStore.setState({
    detail: null,
    detailError: null,
    detailLoadState: "idle"
  });
}

export function removePermanentlyDeletedArchivedChat(chatId: string): void {
  detailGeneration += 1;
  useArchivedChatsStore.setState((state) => ({
    detail: state.detail?.id === chatId ? null : state.detail,
    detailError: null,
    detailLoadState: state.detail?.id === chatId ? "idle" : state.detailLoadState,
    restoring: false,
    summaries: state.summaries.filter((chat) => chat.id !== chatId)
  }));
}

export async function loadEarlierArchivedMessages(): Promise<void> {
  const detail = useArchivedChatsStore.getState().detail;
  const before = detail?.pageInfo.beforeCursor;
  if (!detail || !before || !detail.pageInfo.hasOlder) return;
  const generation = detailGeneration;
  useArchivedChatsStore.setState({ detailError: null, detailLoadState: "loading" });
  try {
    const page = await loadArchivedMessages(detail.id, before);
    if (generation !== detailGeneration) return;
    const older: ThreadMessage[] = page.messages.map(messageFromApi);
    useArchivedChatsStore.setState((state) => state.detail?.id === detail.id
      ? {
          detail: {
            ...state.detail,
            messages: [...older, ...state.detail.messages],
            pageInfo: page.pageInfo
          },
          detailError: null,
          detailLoadState: "ready"
        }
      : {});
  } catch (error) {
    if (generation !== detailGeneration) return;
    useArchivedChatsStore.setState({
      detailError: errorName(error),
      detailLoadState: "error"
    });
    throw error;
  }
}

/**
 * Restores an archived chat directly from its list row, using the summary's
 * current source-revision fence. Returns the restored chat id, or null while
 * another restore is in flight.
 */
export async function restoreArchivedChatSummary(
  chat: Pick<ArchivedChatSummaryWire, "id" | "sourceRevision">
): Promise<string | null> {
  if (useArchivedChatsStore.getState().restoring) return null;
  const generation = ++restoreGeneration;
  useArchivedChatsStore.setState({ listError: null, restoring: true });
  try {
    const response = await restoreChat(chat.id, chat.sourceRevision);
    if (generation !== restoreGeneration) return null;
    useArchivedChatsStore.setState((state) => ({
      restoring: false,
      summaries: state.summaries.filter((item) => item.id !== chat.id)
    }));
    return response.chat.id;
  } catch (error) {
    if (generation !== restoreGeneration) return null;
    useArchivedChatsStore.setState({ listError: errorName(error), restoring: false });
    throw error;
  }
}

export async function restoreArchivedChat(): Promise<string | null> {
  const current = useArchivedChatsStore.getState();
  const detail = current.detail;
  if (!detail || current.restoring) return null;
  const generation = ++restoreGeneration;
  useArchivedChatsStore.setState({ detailError: null, restoring: true });
  try {
    const response = await restoreChat(detail.id, detail.sourceRevision);
    if (generation !== restoreGeneration) return null;
    useArchivedChatsStore.setState((state) => ({
      detail: null,
      detailLoadState: "idle",
      restoring: false,
      summaries: state.summaries.filter((chat) => chat.id !== detail.id)
    }));
    return response.chat.id;
  } catch (error) {
    if (generation !== restoreGeneration) return null;
    useArchivedChatsStore.setState({ detailError: errorName(error), restoring: false });
    throw error;
  }
}

export function deactivateArchivedChats(): void {
  listGeneration += 1;
  detailGeneration += 1;
  restoreGeneration += 1;
  useArchivedChatsStore.setState(initialState, true);
}
