"use client";

import { UiV2Toast } from "@/components/ui-v2";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2,
  type NewChatMode
} from "@/features/navigation-v2/NavigationV2";
import { useMemo, useState } from "react";

const baseChats: ChatNavigationSummaryWire[] = [
  {
    activeRun: true,
    folderId: "folder-research",
    id: "chat-running",
    title: "Research plan for multilingual recall",
    updatedAt: "2026-08-13T04:20:00.000Z"
  },
  {
    activeRun: false,
    folderId: "folder-research",
    id: "chat-evidence",
    title: "Source review notes",
    updatedAt: "2026-08-12T15:00:00.000Z"
  },
  {
    activeRun: false,
    folderId: null,
    id: "chat-selected",
    title: "Quarterly product brief",
    updatedAt: "2026-08-13T02:00:00.000Z"
  },
  {
    activeRun: false,
    folderId: null,
    id: "chat-older",
    title: "Deployment checklist",
    updatedAt: "2026-08-05T09:00:00.000Z"
  }
];

const folders = [
  { id: "folder-research", name: "Исследования", parentId: null }
];

export type NavigationGalleryState =
  | "default"
  | "empty"
  | "error"
  | "loading"
  | "search";

export function NavigationV2Gallery({ state = "default" }: { state?: NavigationGalleryState }) {
  const [chats, setChats] = useState(baseChats);
  const [selected, setSelected] = useState("chat-selected");
  const [toastChat, setToastChat] = useState<ChatNavigationSummaryWire | null>(null);
  const [mode, setMode] = useState<NewChatMode>("NORMAL");
  const [search, setSearch] = useState(state === "search" ? "research" : "");
  const visible = useMemo(
    () => search
      ? chats.filter((chat) => chat.title.toLowerCase().includes(search.toLowerCase()))
      : chats,
    [chats, search]
  );

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      accountLabel="operator@aiqsa.local"
      activeChatId={selected}
      chats={state === "empty" ? [] : visible}
      currentNewChatMode={mode}
      error={state === "error" ? "fixture_error" : null}
      folders={folders}
      hasMore={state === "default"}
      loading={state === "loading"}
      now={new Date("2026-08-13T12:00:00.000Z")}
      onArchive={(chat) => {
        setChats((items) => items.filter((item) => item.id !== chat.id));
        setToastChat(chat);
      }}
      onClose={onClose}
      onLoadMore={() => undefined}
      onMemoryMode={(_chat, nextMode) => setMode(nextMode)}
      onNewChat={setMode}
      onRetry={() => undefined}
      onSearch={setSearch}
      onSelectChat={(chat) => setSelected(chat.id)}
      ready={state !== "loading" && state !== "error"}
      searchError={null}
      searchLoading={false}
      searchQuery={search}
    />
  );

  return (
    <div data-testid="ui-v2-navigation-gallery">
      <ReadingRoomShellV2
        onNewChat={setMode}
        onSelectChat={(chat) => setSelected(chat.id)}
        sidebar={sidebar}
      >
        <main className="v2-navigation-fixture-main">
          <p className="v2-navigation-fixture-kicker">Reading Room</p>
          <h1>Quarterly product brief</h1>
          <p>
            A calm working surface keeps navigation nearby without turning the
            conversation into a dashboard. Active new-chat mode: <strong>{mode}</strong>.
          </p>
          <div className="v2-navigation-fixture-rule" />
          <p>
            Selected chat: <strong>{selected}</strong>. Ctrl/Cmd+K uses the same
            server-side title and folder search.
          </p>
        </main>
      </ReadingRoomShellV2>
      {toastChat ? (
        <div className="v2-navigation-fixture-toast">
          <UiV2Toast
            action="Undo"
            onAction={() => {
              setChats((items) => [toastChat, ...items]);
              setToastChat(null);
            }}
          >
            Chat moved to archive
          </UiV2Toast>
        </div>
      ) : null}
    </div>
  );
}
