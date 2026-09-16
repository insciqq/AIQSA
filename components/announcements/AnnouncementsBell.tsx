"use client";

import { ArrowLeft, Bell, CheckCheck, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import type { UserAnnouncementDetail, UserAnnouncementPage } from "@/lib/contracts/announcements";
import { AnnouncementRequestError, getAnnouncement, listAnnouncements } from "./api";
import { useAnnouncements } from "./AnnouncementsProvider";

export function announcementDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Draft";
}
const errorMessage = (error: unknown) => error instanceof AnnouncementRequestError ? error.message : "Announcements could not be loaded. Please try again.";
const iconButton = "v2-focusable flex size-10 shrink-0 items-center justify-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-ink";

function AnnouncementsInbox({ onClose }: Readonly<{ onClose(): void }>) {
  const announcements = useAnnouncements()!;
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose });
  const [page, setPage] = useState<Pick<UserAnnouncementPage, "items" | "nextCursor"> | null>(null);
  const [selected, setSelected] = useState<UserAnnouncementDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const readPending = useRef(false);
  const alive = useRef(false);
  const version = useRef(0);
  const lastAttempt = useRef<{ kind: "list"; cursor: string | null } | { kind: "detail"; id: string } | { kind: "read"; id: string | null }>({ kind: "list", cursor: null });
  const heading = useRef<HTMLHeadingElement>(null);
  const selectedId = useRef<string | null>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const loadedPages = useRef(1);
  const activeId = selected?.id ?? null;

  const load = useCallback(async (cursor: string | null = null) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = ++version.current;
    lastAttempt.current = { kind: "list", cursor };
    setBusy(true); setError(null);
    try {
      let next = await listAnnouncements(false, cursor, controller.signal);
      let fetched = 1;
      if (!cursor) {
        while (fetched < loadedPages.current && next.nextCursor && !controller.signal.aborted) {
          const earlier = await listAnnouncements(false, next.nextCursor, controller.signal);
          next = { ...earlier, items: [...next.items, ...earlier.items.filter(item => !next.items.some(old => old.id === item.id))] };
          fetched++;
        }
      }
      if (controller.signal.aborted || current !== version.current) return;
      loadedPages.current = cursor ? loadedPages.current + 1 : fetched;
      setPage((prior) => ({ nextCursor: next.nextCursor, items: cursor && prior ? [...prior.items, ...next.items.filter((item) => !prior.items.some((old) => old.id === item.id))] : next.items }));
      setSelected(null);
    } catch (e) { if (!controller.signal.aborted && current === version.current) setError(errorMessage(e)); }
    finally { if (!controller.signal.aborted && current === version.current) setBusy(false); }
  }, []);

  useEffect(() => {
    let disposed = false;
    alive.current = true;
    queueMicrotask(() => { if (!disposed) void load(); });
    return () => { disposed = true; alive.current = false; pending.current?.abort(); };
  }, [load]);
  useEffect(() => {
    if (activeId) {
      if (selectedId.current !== activeId) heading.current?.focus();
      selectedId.current = activeId;
    } else if (selectedId.current) {
      if (busy) initialFocusRef.current?.focus();
      else {
        (rowButtons.current.get(selectedId.current) ?? initialFocusRef.current)?.focus();
        selectedId.current = null;
      }
    }
  }, [activeId, busy, initialFocusRef]);

  async function markRead(id: string | null) {
    if (readPending.current) return;
    readPending.current = true;
    const current = ++version.current;
    pending.current?.abort();
    lastAttempt.current = { kind: "read", id };
    setBusy(true); setError(null);
    try {
      await announcements.markRead(id);
      if (!alive.current || current !== version.current) return;
      setPage((prior) => prior ? { ...prior,
        items: prior.items.map((item) => id === null || item.id === id ? { ...item, read: true } : item) } : prior);
      setSelected((prior) => prior && (id === null || prior.id === id) ? { ...prior, read: true } : prior);
    } catch (e) {
      if (alive.current && current === version.current) {
        setError(errorMessage(e));
        if (e instanceof AnnouncementRequestError && e.code === "announcement_not_found") {
          lastAttempt.current = { kind: "list", cursor: null };
          setSelected(null); setPage(prior => prior ? { ...prior, items: prior.items.filter(item => item.id !== id) } : prior);
          void announcements.refresh();
        }
      }
    } finally { readPending.current = false; if (alive.current && current === version.current) setBusy(false); }
  }

  async function open(id: string) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = ++version.current;
    lastAttempt.current = { kind: "detail", id };
    setBusy(true); setError(null);
    try {
      const value = await getAnnouncement(id, false, controller.signal);
      if (controller.signal.aborted || current !== version.current) return;
      setSelected(value);
      setPage(prior => prior ? { ...prior, items: prior.items.map(item => item.id === id ? {
        ...item, title: value.title, excerpt: value.excerpt, publishedAt: value.publishedAt, read: value.read
      } : item) } : prior);
      if (!value.read) await markRead(id);
    } catch (e) {
      if (!controller.signal.aborted && current === version.current) {
        setSelected(null); setError(errorMessage(e));
        if (e instanceof AnnouncementRequestError && e.code === "announcement_not_found") {
          lastAttempt.current = { kind: "list", cursor: null };
          setPage((prior) => prior ? { ...prior, items: prior.items.filter((item) => item.id !== id) } : prior);
          void announcements.refresh();
        }
      }
    } finally { if (!controller.signal.aborted && current === version.current) setBusy(false); }
  }

  function retry() {
    const attempt = lastAttempt.current;
    if (attempt.kind === "list") void load(attempt.cursor);
    else if (attempt.kind === "detail") void open(attempt.id);
    else void markRead(attempt.id);
  }

  if (!portalReady) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/40 p-2 sm:items-center sm:p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Announcements" onKeyDown={(event) => {
        onDialogKeyDown(event);
        if (event.defaultPrevented) event.stopPropagation();
      }}
        className="flex max-h-[min(80dvh,44rem)] w-full max-w-lg flex-col overflow-hidden rounded-panel border border-trace-subtle bg-overlay-surface text-ink shadow-overlay">
        <header className="flex shrink-0 items-center gap-2 border-b border-trace-subtle px-3 py-2">
          {selected ? <button type="button" className={iconButton} aria-label="Back to announcements" onClick={() => setSelected(null)}><ArrowLeft size={18} /></button> : <Bell className="ml-2 size-5 text-ink-secondary" aria-hidden="true" />}
          <h2 className="min-w-0 flex-1 text-base font-semibold">Announcements</h2>
          <button type="button" className={iconButton} aria-label="Refresh announcements" disabled={busy} onClick={() => { void announcements.refresh(); void (selected ? open(selected.id) : load()); }}><RefreshCw size={16} /></button>
          <button ref={initialFocusRef} type="button" className={iconButton} aria-label="Close announcements" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3" aria-busy={busy}>
          {error ? <div role="alert" className="mb-3 text-sm text-critical"><p>{error}</p><button type="button" disabled={busy} className="v2-focusable mt-1 min-h-10 rounded-control px-2 text-ink" onClick={retry}>Try again</button></div> : null}
          {!page && busy ? <p role="status" className="py-8 text-center text-sm text-ink-secondary">Loading announcements…</p> : null}
          {selected ? (
            <article className="min-w-0 break-words [overflow-wrap:anywhere]">
              <p className="mb-2 text-xs text-ink-muted">{announcementDate(selected.publishedAt)}</p>
              <h3 ref={heading} tabIndex={-1} className="v2-focusable mb-4 text-lg font-semibold">{selected.title}</h3>
              <div className="text-sm leading-relaxed"><MarkdownMessage content={selected.body} /></div>
              {!selected.read && !busy ? <button type="button" className="v2-focusable mt-4 rounded-control px-2 py-2 text-sm text-proof" onClick={() => { void markRead(selected.id); }}>Mark as read</button> : null}
            </article>
          ) : page ? (
            <>
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-secondary">
                <span>{announcements.unreadCount ? `${announcements.unreadCount} unread` : "You're all caught up"}</span>
                <button type="button" className="v2-focusable flex min-h-10 items-center gap-1.5 rounded-control px-2 hover:bg-control-hover disabled:opacity-50"
                  disabled={busy || announcements.unreadCount === 0} onClick={() => { void markRead(null); }}><CheckCheck size={15} />Mark all read</button>
              </div>
              {page.items.length === 0 ? <p className="py-10 text-center text-sm text-ink-secondary">No announcements yet.</p> : (
                <ul className="divide-y divide-trace-subtle">
                  {page.items.map((item) => <li key={item.id}>
                    <button ref={node => { if (node) rowButtons.current.set(item.id, node); else rowButtons.current.delete(item.id); }} disabled={busy} type="button" className="v2-focusable flex w-full items-start gap-3 rounded-control py-4 text-left hover:bg-control-hover" onClick={() => { void open(item.id); }}>
                      <span className={`mt-2 size-1.5 shrink-0 rounded-full ${item.read ? "bg-transparent" : "bg-proof"}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">{item.title}{!item.read ? <span className="sr-only"> (unread)</span> : null}</span>
                        <span className="mt-1 block text-xs text-ink-muted">{announcementDate(item.publishedAt)}</span>
                        <span className="mt-2 line-clamp-2 break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">{item.excerpt}</span>
                      </span>
                    </button>
                  </li>)}
                </ul>
              )}
              {page.nextCursor ? <button type="button" className="v2-focusable mt-2 min-h-10 w-full rounded-control text-sm text-ink-secondary hover:bg-control-hover" disabled={busy} onClick={() => { void load(page.nextCursor); }}>{busy ? "Loading…" : "Show earlier"}</button> : null}
            </>
          ) : null}
        </div>
      </section>
    </div>, document.body
  );
}

export function AnnouncementsBell({ compact = true }: Readonly<{ compact?: boolean }>) {
  const [open, setOpen] = useState(false);
  const announcements = useAnnouncements();
  if (!announcements) return null;
  const { unreadCount, refresh } = announcements;
  return <>
    <button type="button" aria-label={unreadCount ? `Announcements, ${unreadCount} unread` : "Announcements"} aria-haspopup="dialog" aria-expanded={open}
      className={compact ? "v2-rail-button v2-focusable relative" : "v2-focusable relative flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-sm text-ink-secondary hover:bg-control-hover"}
      data-tooltip={compact ? "Announcements" : undefined} data-tooltip-side="right" onClick={() => { setOpen(true); void refresh(); }}>
      <Bell className="size-5 shrink-0" aria-hidden="true" />
      {!compact ? <span className="flex-1 text-left">Announcements</span> : null}
      {unreadCount > 0 ? <span aria-hidden="true" className={compact ? "absolute right-1 top-1 size-2 rounded-full bg-proof ring-2 ring-workspace-rail" : "rounded-full bg-proof px-1.5 text-xs text-proof-contrast"}>{compact ? null : unreadCount > 99 ? "99+" : unreadCount}</span> : null}
    </button>
    {open ? <AnnouncementsInbox onClose={() => setOpen(false)} /> : null}
  </>;
}
