"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button } from "@/components/ui-v2";
import { ANNOUNCEMENT_BODY_LIMIT, ANNOUNCEMENT_TITLE_LIMIT, decodeAnnouncementContent,
  type AnnouncementDetail, type AnnouncementPage } from "@/lib/contracts/announcements";
import { AnnouncementRequestError, discardAnnouncement, getAnnouncement, listAnnouncements, saveAnnouncement } from "@/components/announcements/api";
import { announcementDate } from "@/components/announcements/AnnouncementsBell";
import { useAdminSectionTopbar } from "./AdminShell";
import { AdminSheet } from "./AdminSheet";
import type { AdminConfirmationConfig } from "./useAdminConfirmationController";

const inputClass = "v2-focusable w-full min-w-0 rounded-control border border-control-boundary bg-answer-paper px-3 py-2 text-sm text-ink";
const message = (error: unknown) => error instanceof AnnouncementRequestError ? error.message : "Could not save the announcement. Please try again.";

function AnnouncementEditor({ entry, onSaved, onBack }: Readonly<{
  entry: AnnouncementDetail | null;
  onSaved(entry: AnnouncementDetail | null): void;
  onBack(): void;
}>) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, requestConfirmation] = useState<AdminConfirmationConfig | null>(null);
  const pending = useRef(false);
  const alive = useRef(false);
  const dirty = title !== (entry?.title ?? "") || body !== (entry?.body ?? "");
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  function back() {
    if (pending.current) return;
    if (!dirty) return onBack();
    requestConfirmation({ title: "Discard unsaved changes?", dialogLabel: "Unsaved announcement", body: "Your saved announcement will stay unchanged.",
      confirmLabel: "Discard changes", testId: "announcement-discard-changes", onConfirm: onBack });
  }
  async function save(published: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await saveAnnouncement({ title, body }, entry ? { id: entry.id, version: entry.version, published } : undefined, published);
      if (!alive.current) return;
      setTitle(saved.title); setBody(saved.body);
      setNotice(saved.published ? "Announcement published. Edits do not notify readers again." : "Draft saved.");
      onSaved(saved);
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  function changePublication() {
    if (pending.current) return;
    const published = !entry?.published;
    requestConfirmation({
      title: published ? "Publish this announcement?" : "Unpublish this announcement?",
      dialogLabel: published ? "Publish announcement" : "Unpublish announcement",
      body: published ? `“${title.trim()}” will be available to everyone on this installation.` : `“${entry?.title}” will disappear from users' announcement history. You can publish it again later.`,
      confirmLabel: published ? "Publish to everyone" : "Unpublish", testId: "announcement-publication-confirmation", tone: "warning",
      onConfirm: () => save(published)
    });
  }
  function discard() {
    if (!entry) return;
    requestConfirmation({ title: "Delete this announcement permanently?", dialogLabel: "Delete announcement", body: `“${entry.title}” and its read receipts will be deleted. This cannot be undone.`,
      confirmLabel: "Delete announcement", testId: "announcement-delete-confirmation", onConfirm: async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError(null);
        try { await discardAnnouncement(entry.id, entry.version); if (alive.current) onSaved(null); }
        catch (e) { if (alive.current) setError(message(e)); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      } });
  }
  const valid = !!decodeAnnouncementContent({ title, body });
  return <AdminSheet open width="wide" testId="announcement-editor" title={entry ? "Edit announcement" : "New announcement"}
    description={entry?.published ? `Published ${announcementDate(entry.publishedAt)}. Edits do not notify readers again.` : entry?.publishedAt ? "Unpublished · Read history is preserved." : "Draft · Only administrators can see this message."}
    closeBlocked={busy} onClose={back} footer={<>
      <UiV2Button type="button" tone="primary" busy={busy} disabled={!valid} onClick={() => { void save(entry?.published ?? false); }}>{entry?.published ? "Save changes" : "Save draft"}</UiV2Button>
      <UiV2Button type="button" disabled={busy || !valid} onClick={changePublication}>{entry?.published ? "Unpublish" : "Publish to everyone"}</UiV2Button>
      {entry && !entry.published ? <UiV2Button type="button" tone="destructive" disabled={busy} onClick={discard}>Delete announcement</UiV2Button> : null}
    </>}>
    <div className="space-y-5">
    <label className="block space-y-2 text-sm font-medium text-ink">Title
      <input className={inputClass} value={title} maxLength={ANNOUNCEMENT_TITLE_LIMIT} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
    </label>
    <div className="overflow-hidden rounded-panel border border-trace-subtle bg-answer-paper">
      <div className="flex items-center gap-1 border-b border-trace-subtle p-2">
        <UiV2Button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</UiV2Button>
        <UiV2Button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</UiV2Button>
        <span className="ml-auto pr-2 text-xs text-ink-muted">Markdown supported</span>
      </div>
      {preview ? <article aria-label="Announcement preview" className="min-h-64 break-words p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">
        <h2 className="mb-4 text-xl font-semibold text-ink">{title || "Untitled announcement"}</h2>
        {body ? <MarkdownMessage content={body} /> : <p className="text-ink-secondary">Your message preview will appear here.</p>}
      </article> : <label className="block p-3">
        <span className="sr-only">Message</span>
        <textarea className={`${inputClass} min-h-64 resize-y font-mono`} value={body} maxLength={ANNOUNCEMENT_BODY_LIMIT} disabled={busy}
          placeholder="What would you like everyone to know?" onChange={(event) => setBody(event.target.value)} />
      </label>}
    </div>
    <p className="text-xs text-ink-muted">{body.length.toLocaleString()} / {ANNOUNCEMENT_BODY_LIMIT.toLocaleString()} characters</p>
    {error ? <div role="alert" className="space-y-2 text-sm text-critical"><p>{error}</p>
      {entry ? <UiV2Button type="button" disabled={busy} onClick={() => requestConfirmation({ title: "Reload saved announcement?", dialogLabel: "Reload announcement", body: "Unsaved changes will be discarded.", confirmLabel: "Reload", testId: "announcement-reload", onConfirm: async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true);
        try { const next = await getAnnouncement(entry.id, true); if (alive.current) { setTitle(next.title); setBody(next.body); setError(null); onSaved(next); } }
        catch (e) { if (alive.current) setError(message(e)); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      } })}>Reload saved version</UiV2Button> : null}
    </div> : null}
    {notice ? <p role="status" className="text-sm text-ink-secondary">{notice}</p> : null}
    <p className="text-xs text-ink-secondary">{entry?.published ? "Changes are visible immediately. Create a new announcement to notify everyone again." : "Save a draft, preview it, then publish it to everyone."}</p>
    </div>
    {confirmation ? <ConfirmationDialog confirmLabel={confirmation.confirmLabel} dialogLabel={confirmation.dialogLabel}
      icon={confirmation.icon} testId={confirmation.testId} title={confirmation.title} tone={confirmation.tone}
      onCancel={() => requestConfirmation(null)} onConfirm={() => {
        requestConfirmation(null);
        void confirmation.onConfirm();
      }}>{confirmation.body}</ConfirmationDialog> : null}
  </AdminSheet>;
}

export function AdminAnnouncementsSection({ resource, onSelectResource }: Readonly<{
  resource: string | null;
  onSelectResource(id: string | null): void;
}>) {
  const [page, setPage] = useState<AnnouncementPage | null>(null);
  const [entry, setEntry] = useState<AnnouncementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const createButton = useRef<HTMLButtonElement | null>(null);
  const editorOpener = useRef<HTMLButtonElement | null>(null);
  const restoreOpener = useRef(false);
  const topbar = useMemo(() => ({ title: "Announcements", actions:
    <UiV2Button ref={createButton} type="button" tone="primary" icon="plus" onClick={(event) => {
      editorOpener.current = event.currentTarget;
      onSelectResource("new");
    }}>New announcement</UiV2Button>
  }), [onSelectResource]);
  useAdminSectionTopbar(topbar);
  useEffect(() => {
    if (resource || !restoreOpener.current) return;
    restoreOpener.current = false;
    queueMicrotask(() => {
      const target = editorOpener.current;
      (target?.isConnected ? target : createButton.current)?.focus({ preventScroll: true });
    });
  }, [resource]);
  function closeEditor(deleted = false) {
    if (deleted) editorOpener.current = createButton.current;
    restoreOpener.current = true;
    onSelectResource(null);
  }

  const load = useCallback(async (cursor: string | null = null) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    try {
      if (resource && resource !== "new") {
        const next = await getAnnouncement(resource, true, controller.signal);
        if (!controller.signal.aborted) setEntry(next);
      } else if (!resource) {
        const next = await listAnnouncements(true, cursor, controller.signal);
        if (!controller.signal.aborted) setPage((prior) => ({ ...next, items: cursor && prior ? [...prior.items, ...next.items.filter((item) => !prior.items.some((old) => old.id === item.id))] : next.items }));
      } else setEntry(null);
    } catch (e) { if (!controller.signal.aborted) setError(message(e)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [resource]);
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void load(); });
    return () => { disposed = true; pending.current?.abort(); };
  }, [load]);

  return <section className="mx-auto w-full max-w-4xl space-y-4" aria-label="Installation announcements">
    <p className="text-sm text-ink-secondary">Write release notes or installation news. Published announcements appear in everyone’s inbox.</p>
    {error ? <div role="alert" className="space-y-2 text-sm text-critical"><p>{error}</p><UiV2Button type="button" onClick={() => { void load(); }}>Try again</UiV2Button></div> : null}
    {loading ? <p role="status" className="text-sm text-ink-secondary">Loading announcements…</p> : null}
    {page ? <>
      {page.items.length === 0 ? <div className="rounded-panel border border-dashed border-trace-subtle p-10 text-center text-sm text-ink-secondary">No announcements yet. Create a draft to get started.</div> :
        <ul className="divide-y divide-trace-subtle rounded-panel border border-trace-subtle bg-answer-paper">
          {page.items.map((item) => <li key={item.id}><button type="button" className="v2-focusable flex w-full flex-wrap items-center gap-3 rounded-control px-4 py-4 text-left hover:bg-control-hover" onClick={(event) => {
            editorOpener.current = event.currentTarget;
            onSelectResource(item.id);
          }}>
            <span className="min-w-0 flex-1 basis-48"><span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{item.title}</span>
              <span className="mt-1 line-clamp-1 break-words text-xs text-ink-secondary">{item.excerpt}</span></span>
            <span className="text-xs text-ink-secondary">{item.published ? `Published · ${announcementDate(item.publishedAt)}` : item.publishedAt ? "Unpublished" : "Draft"}</span>
          </button></li>)}
        </ul>}
      {page.nextCursor ? <UiV2Button type="button" busy={loading} onClick={() => { void load(page.nextCursor); }}>Show earlier</UiV2Button> : null}
    </> : null}
    {resource && !loading && (resource === "new" || entry?.id === resource) ? <AnnouncementEditor key={resource} entry={resource === "new" ? null : entry}
      onBack={() => closeEditor()} onSaved={(saved) => {
        setEntry(saved);
        if (!saved) closeEditor(true);
        else if (resource !== saved.id) onSelectResource(saved.id);
      }} /> : null}
  </section>;
}
