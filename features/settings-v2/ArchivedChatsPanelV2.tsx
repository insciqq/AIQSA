"use client";

import {
  deactivateArchivedChats,
  loadEarlierArchivedMessages,
  openArchivedChatPreview,
  refreshArchivedChats,
  restoreArchivedChat,
  restoreArchivedChatSummary,
  showArchivedChatList,
  useArchivedChatsStore
} from "@/components/app-shell/archivedChatsStore";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import {
  openPermanentChatDeletion,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuActions
} from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import type { ArchivedChatSummaryWire } from "@/lib/contracts/chats";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import { useEffect, useId, useRef, useState } from "react";

const ARCHIVE_FILTER_MAX_LENGTH = 120;

function formatLastMessageDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function matchesArchiveFilter(chat: ArchivedChatSummaryWire, query: string): boolean {
  return chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function ArchivedChatRowV2({
  canDelete,
  chat,
  restoring,
  onDelete,
  onOpen,
  primaryRef,
  onRestore
}: Readonly<{
  canDelete: boolean;
  chat: ArchivedChatSummaryWire;
  restoring: boolean;
  onDelete(focusTarget: HTMLElement | null): void;
  onOpen(): void;
  onRestore(): void;
  primaryRef(node: HTMLButtonElement | null): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const metadataId = useId();
  const closeMenu = () => setMenuOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: closeMenu, open: menuOpen });
  return (
    <li className="v2-archived-chat-row">
      <button
        ref={primaryRef}
        aria-describedby={metadataId}
        aria-label={`Open preview: ${chat.title}`}
        className="v2-archived-chat-primary v2-focusable"
        type="button"
        onClick={onOpen}
      >
        <UiV2Icon name="chat" />
        <span>
          <strong>{chat.title}</strong>
          <small id={metadataId}>
            {chat.lastMessageAt
              ? `Last message ${formatLastMessageDate(chat.lastMessageAt)}`
              : "No messages yet"} · {chat.messageCount} {chat.messageCount === 1 ? "message" : "messages"}
            {chat.memoryMode === "EXCLUDED" ? " · Excluded from Memory" : ""}
          </small>
        </span>
      </button>
      <UiV2Button
        aria-label={`Restore ${chat.title}`}
        className="v2-archived-chat-restore"
        disabled={restoring}
        onClick={onRestore}
      >
        {resolveMemoryCopy("restore.action")}
      </UiV2Button>
      {canDelete ? (
        <>
          <UiV2IconButton
            ref={triggerRef}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="v2-archived-chat-menu-trigger"
            disabled={restoring}
            icon="more"
            label={`Actions: ${chat.title}`}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          />
          {menuOpen ? (
            <UiV2ResponsiveMenu
              anchorRef={triggerRef}
              label={`Archived chat actions: ${chat.title}`}
              menuRef={menuRef}
              onClose={closeMenu}
            >
              <UiV2MenuActions
                actions={[{
                  icon: "trash",
                  label: "Delete permanently…",
                  onSelect: () => {
                    triggerRef.current?.focus({ preventScroll: true });
                    onDelete(triggerRef.current);
                  },
                  tone: "destructive"
                }]}
                onClose={closeMenu}
              />
            </UiV2ResponsiveMenu>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export function ArchivedChatsPanelV2({
  onRestored
}: Readonly<{
  onRestored(chatId: string): Promise<void> | void;
}>) {
  const detail = useArchivedChatsStore((state) => state.detail);
  const detailError = useArchivedChatsStore((state) => state.detailError);
  const detailLoadState = useArchivedChatsStore((state) => state.detailLoadState);
  const listError = useArchivedChatsStore((state) => state.listError);
  const listLoadState = useArchivedChatsStore((state) => state.listLoadState);
  const nextCursor = useArchivedChatsStore((state) => state.nextCursor);
  const restoring = useArchivedChatsStore((state) => state.restoring);
  const summaries = useArchivedChatsStore((state) => state.summaries);
  const canDelete = useMemorySettingsStore(
    (state) => Boolean(state.data?.capabilities.permanentChatDeletion)
  );
  const permanentDialogOpen = usePermanentChatDeletionStore(
    (state) => Boolean(state.target) || state.statusOpen
  );
  const [query, setQuery] = useState("");
  const previewBackRef = useRef<HTMLButtonElement | null>(null);
  const previewFocusSettledRef = useRef(false);
  const previewLoadingRef = useRef<HTMLDivElement | null>(null);
  const previewOriginChatIdRef = useRef<string | null>(null);
  const rowButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const visibleSummaries = query.trim()
    ? summaries.filter((chat) => matchesArchiveFilter(chat, query))
    : summaries;

  useEffect(() => {
    if (useArchivedChatsStore.getState().listLoadState === "idle") {
      void refreshArchivedChats().catch(() => undefined);
    }
    return () => deactivateArchivedChats();
  }, []);

  useEffect(() => {
    if (!previewOriginChatIdRef.current || previewFocusSettledRef.current) return;
    if (!detail && detailLoadState === "loading") {
      previewLoadingRef.current?.focus({ preventScroll: true });
      return;
    }
    if (detail || detailLoadState === "error") {
      previewBackRef.current?.focus({ preventScroll: true });
      previewFocusSettledRef.current = true;
    }
  }, [detail, detailLoadState]);

  function openPreview(chatId: string): void {
    previewOriginChatIdRef.current = chatId;
    previewFocusSettledRef.current = false;
    void openArchivedChatPreview(chatId).catch(() => undefined);
  }

  function focusListAfterRemoval(chatId: string): void {
    const removedIndex = visibleSummaries.findIndex((chat) => chat.id === chatId);
    const preferredId = removedIndex < 0
      ? null
      : visibleSummaries[removedIndex + 1]?.id ?? visibleSummaries[removedIndex - 1]?.id ?? null;
    window.requestAnimationFrame(() => {
      const target = preferredId ? rowButtonRefs.current.get(preferredId) : null;
      (target ?? searchRef.current)?.focus({ preventScroll: true });
    });
  }

  function returnToArchivedList(): void {
    const originChatId = previewOriginChatIdRef.current;
    previewOriginChatIdRef.current = null;
    previewFocusSettledRef.current = false;
    showArchivedChatList();
    window.requestAnimationFrame(() => {
      const target = originChatId ? rowButtonRefs.current.get(originChatId) : null;
      (target ?? searchRef.current)?.focus({ preventScroll: true });
    });
  }

  async function restoreCurrent(): Promise<void> {
    const chatId = await restoreArchivedChat();
    if (!chatId) return;
    focusListAfterRemoval(chatId);
    await onRestored(chatId);
  }

  async function restoreSummary(chat: ArchivedChatSummaryWire): Promise<void> {
    const chatId = await restoreArchivedChatSummary(chat);
    if (!chatId) return;
    focusListAfterRemoval(chatId);
    await onRestored(chatId);
  }

  return (
    <div
      aria-hidden={permanentDialogOpen || undefined}
      className="v2-archived-chats"
      data-testid="settings-archived-panel"
      inert={permanentDialogOpen || undefined}
    >
      {detail ? (
        <section className="v2-archived-preview" aria-labelledby="v2-archived-preview-heading">
          <header className="v2-archived-preview-header">
            <UiV2Button ref={previewBackRef} icon="arrow-left" onClick={returnToArchivedList}>Archived chats</UiV2Button>
            <div>
              <h3 id="v2-archived-preview-heading">{detail.title}</h3>
              <p>Read-only preview · {detail.messageCount} {detail.messageCount === 1 ? "message" : "messages"}</p>
            </div>
          </header>
          <div className="v2-archived-preview-note">
            <UiV2Icon name="alert" />
            <span>
              {detail.memoryMode === "EXCLUDED"
                ? `${resolveMemoryCopy("exclude.explanation")} Restoring this chat does not resume Memory.`
                : resolveMemoryCopy("archive.explanation")}
            </span>
          </div>
          {detail.pageInfo.hasOlder ? (
            <UiV2Button
              className="v2-archived-load-earlier"
              busy={detailLoadState === "loading"}
              disabled={detailLoadState === "loading"}
              onClick={() => void loadEarlierArchivedMessages().catch(() => undefined)}
            >
              Load earlier messages
            </UiV2Button>
          ) : null}
          <ol className="v2-archived-messages" aria-label="Archived chat messages">
            {detail.messages.map((message) => (
              <li key={message.id}>
                <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
                <p>{textFromThreadContent(message.content) || "No text content"}</p>
              </li>
            ))}
          </ol>
          {detailError ? <p className="v2-archived-error" role="alert">{detailError}</p> : null}
          <footer className="v2-archived-preview-actions">
            {canDelete ? (
              <UiV2Button
                disabled={restoring}
                tone="destructive"
                onClick={(event) => openPermanentChatDeletion({
                  chatId: detail.id,
                  location: "ARCHIVED",
                  title: detail.title
                }, event.currentTarget, () => searchRef.current)}
              >
                Delete permanently…
              </UiV2Button>
            ) : null}
            <UiV2Button
              aria-label={`Restore ${detail.title}`}
              busy={restoring}
              disabled={restoring}
              onClick={() => void restoreCurrent().catch(() => undefined)}
            >
              {resolveMemoryCopy("restore.action")}
            </UiV2Button>
          </footer>
        </section>
      ) : detailLoadState === "loading" ? (
        <div ref={previewLoadingRef} className="v2-archived-state" role="status" tabIndex={-1}>
          <span className="v2-spinner" aria-hidden="true" />
          <p>Loading archived chat preview…</p>
        </div>
      ) : detailLoadState === "error" ? (
        <div className="v2-archived-state">
          <p className="v2-archived-error" role="alert">Could not open the archived chat.</p>
          <UiV2Button ref={previewBackRef} icon="arrow-left" onClick={returnToArchivedList}>Back to archived chats</UiV2Button>
        </div>
      ) : (
        <>
          <div className="v2-archived-search">
            <UiV2Icon name="search" />
            <input
              ref={searchRef}
              aria-label="Search archived chats"
              autoComplete="off"
              maxLength={ARCHIVE_FILTER_MAX_LENGTH}
              placeholder="Search archived chats…"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                if (query) setQuery("");
                else event.currentTarget.blur();
              }}
            />
            {query ? (
              <UiV2IconButton icon="close" label="Clear archived chat search" onClick={() => setQuery("")} />
            ) : null}
          </div>
          {listError && summaries.length > 0 ? (
            <div className="v2-archived-inline-error" role="alert">
              <span>Could not refresh archived chats. The loaded chats are still shown.</span>
              <UiV2Button onClick={() => void refreshArchivedChats().catch(() => undefined)}>Retry</UiV2Button>
            </div>
          ) : null}
          {listLoadState === "loading" && summaries.length === 0 ? (
            <div className="v2-archived-state" role="status">
              <span className="v2-spinner" aria-hidden="true" />
              <p>Loading archived chats…</p>
            </div>
          ) : null}
          {listError && summaries.length === 0 ? (
            <div className="v2-archived-state">
              <p className="v2-archived-error" role="alert">Archived chats did not load. Nothing was changed.</p>
              <UiV2Button onClick={() => void refreshArchivedChats().catch(() => undefined)}>Try again</UiV2Button>
            </div>
          ) : null}
          {listLoadState === "ready" && summaries.length === 0 ? (
            <div className="v2-archived-state">
              <UiV2Icon name="archive" />
              <h3>No archived chats</h3>
              <p>Chats you archive will appear here.</p>
            </div>
          ) : null}
          {summaries.length > 0 && visibleSummaries.length === 0 ? (
            <div className="v2-archived-state">
              <h3>No matching chats</h3>
              <p>Try another title.</p>
            </div>
          ) : null}
          {visibleSummaries.length > 0 ? (
            <ul className="v2-archived-list" aria-busy={listLoadState === "loading" || undefined} aria-label="Archived chats">
              {visibleSummaries.map((chat) => (
                <ArchivedChatRowV2
                  canDelete={canDelete}
                  chat={chat}
                  key={chat.id}
                  restoring={restoring}
                  onDelete={(focusTarget) => openPermanentChatDeletion({
                    chatId: chat.id,
                    location: "ARCHIVED",
                    title: chat.title
                  }, focusTarget, () => searchRef.current)}
                  onOpen={() => openPreview(chat.id)}
                  onRestore={() => void restoreSummary(chat).catch(() => undefined)}
                  primaryRef={(node) => {
                    if (node) rowButtonRefs.current.set(chat.id, node);
                    else rowButtonRefs.current.delete(chat.id);
                  }}
                />
              ))}
            </ul>
          ) : null}
          {nextCursor ? (
            <div className="v2-archived-load-more">
              <UiV2Button
                busy={listLoadState === "loading"}
                disabled={listLoadState === "loading"}
                onClick={() => void refreshArchivedChats(true).catch(() => undefined)}
              >
                Load more
              </UiV2Button>
            </div>
          ) : null}
          <div className="v2-archived-memory-note">
            <UiV2Icon name="alert" />
            <p>
              Archiving only hides a chat from the active list. Unless it was already excluded, Memory can still use it. Restore the chat, then choose <strong>Exclude from Memory</strong> from its menu to stop future recall and learning.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
