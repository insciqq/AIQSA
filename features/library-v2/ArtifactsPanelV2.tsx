"use client";

import { useRef, useState } from "react";
import type { ArtifactLibraryItem } from "@/components/app-shell/artifactLibraryStore";
import { artifactKindLabel } from "@/components/artifacts/artifactPresentation";
import { ArtifactThumbnailV2 } from "@/components/artifacts/ArtifactThumbnailV2";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2MenuItem, UiV2MenuSeparator } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { SectionHeading } from "./LibraryV2";

export type ArtifactLibraryFilter = "recent" | "published" | "archived";
type Change = { title: string } | { archived: boolean } | "delete" | "duplicate";
type Props = Readonly<{
  recent: readonly ArtifactLibraryItem[] | null;
  archived: readonly ArtifactLibraryItem[] | null;
  error: string | null;
  filter: ArtifactLibraryFilter;
  loadState: "idle" | "loading" | "ready" | "error";
  mutations: Readonly<Record<string, boolean>>;
  onFilterChange(filter: ArtifactLibraryFilter): void;
  onOpen(item: ArtifactLibraryItem): void;
  onOpenChat(chatId: string): Promise<void>;
  onChange(id: string, change: Change): Promise<ArtifactLibraryItem | void>;
  onRetry(): void;
}>;

export function ArtifactsPanelV2({ recent, archived, error, filter, loadState, mutations, onFilterChange, onOpen, onOpenChat, onChange, onRetry }: Props) {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const items = (filter === "archived" ? archived : recent) ?? [];
  const visible = items.filter(item => (filter !== "published" || item.publicationCount > 0) &&
    item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div data-testid="library-artifacts-panel">
    <SectionHeading description="Pages, slides, games and images made in your chats. Open one to preview it, share a link or return to its chat.">Artifacts</SectionHeading>
    <p className="v2-library-disclosure"><UiV2Icon name="lock" />Artifacts are private until you publish a link.</p>
    <div className="v2-artifact-library-toolbar">
      <div className="v2-resource-filters" role="group" aria-label="Filter artifacts">
        {(["recent", "published", "archived"] as const).map(candidate => <button key={candidate}
          type="button" className="v2-resource-filter v2-focusable" aria-pressed={filter === candidate}
          data-selected={filter === candidate || undefined} onClick={() => { onFilterChange(candidate); setNotice(null); }}>
          {candidate === "recent" ? `Recent ${recent?.length ?? 0}` : candidate === "published"
            ? `Published ${recent?.filter(item => item.publicationCount > 0).length ?? 0}` : "Archived"}
        </button>)}
      </div>
      <label className="v2-resource-search"><UiV2Icon name="search" /><input type="search"
        aria-label="Search artifacts" placeholder="Search artifacts…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    {notice ? <p className="v2-library-note" role="status">{notice}</p> : null}
    {loadState === "error" ? <div className="v2-resource-empty" role="alert"><p>{error ?? "Artifacts could not be loaded."}</p><UiV2Button onClick={onRetry}>Retry</UiV2Button></div> : null}
    {(loadState === "loading" || loadState === "idle") && items.length === 0 ? <p className="v2-resource-empty" role="status"><span className="v2-spinner" aria-hidden="true" />Loading artifacts…</p>
      : visible.length ? <ul className="v2-resource-list v2-artifact-library-list" aria-label="Artifacts">
        {visible.map(item => <ArtifactRow key={item.id} item={item} archived={filter === "archived"} busy={Boolean(mutations[item.id])}
          onOpen={() => onOpen(item)} onOpenChat={onOpenChat} onChange={async change => {
            const result = await onChange(item.id, change);
            if (change === "duplicate") {
              if (!result) throw new Error("The copy could not be confirmed. Refresh the list and try again.");
              setQuery("");
              if (filter !== "recent") onFilterChange("recent");
              setNotice(`Duplicated as “${result.title}”`);
              return;
            }
            setNotice(change === "delete" ? `“${item.title}” was deleted.` : "title" in change ? "Title updated."
              : change.archived ? `“${item.title}” was archived. Versions are kept.` : `“${item.title}” was restored.`);
          }} />)}
      </ul> : loadState === "ready" ? query.trim() ? <p className="v2-resource-empty">No artifacts match “{query.trim()}”.</p>
        : filter === "recent" ? <div className="v2-assistant-empty"><span className="v2-assistant-empty-icon"><UiV2Icon name="artifact" /></span>
          <h3>No artifacts yet</h3><p>Ask for a page, slides, a game or a chart in a personal chat. It will be saved here.</p></div>
          : <p className="v2-resource-empty">{filter === "published" ? "No published artifacts." : "No archived artifacts."}</p> : null}
    <p className="v2-library-note">Archiving keeps versions and revokes published links.</p>
  </div>;
}

function ArtifactRow({ item, archived, busy, onOpen, onOpenChat, onChange }: Readonly<{
  item: ArtifactLibraryItem;
  archived: boolean;
  busy: boolean;
  onOpen(): void;
  onOpenChat(chatId: string): Promise<void>;
  onChange(change: Change): Promise<void>;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [action, setAction] = useState<"rename" | "archive" | "delete" | null>(null);
  const [title, setTitle] = useState(item.title);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const { menuRef, triggerRef, closeForAction } = useMenuDismissalV2({ open: menuOpen, onClose: () => setMenuOpen(false) });
  const cancel = () => { setAction(null); setError(null); triggerRef.current?.focus({ preventScroll: true }); };
  const choose = (next: typeof action) => { closeForAction(); setError(null); setTitle(item.title); setAction(next); };
  const change = async (value: Change) => {
    if (pending.current) return;
    pending.current = true;
    setError(null);
    try { await onChange(value); cancel(); }
    catch (error) { setError(error instanceof Error ? error.message : "The request could not finish. Try again."); }
    finally { pending.current = false; }
  };
  const base = `/api/artifacts/${encodeURIComponent(item.id)}/versions/${encodeURIComponent(item.currentVersionId)}/content`;
  return <li className="v2-artifact-library-row">
    <div className="v2-resource-row">
      <button className="v2-artifact-library-open v2-focusable" type="button" aria-label={`Open ${item.title}`}
        disabled={archived} title={archived ? "Restore this artifact to open it" : undefined} onClick={onOpen}>
        <ArtifactThumbnailV2 artifactId={item.id} versionId={item.currentVersionId} kind={item.kind} byteSize={archived ? undefined : item.byteSize} />
        <span className="v2-artifact-library-copy"><h3 title={item.title}>{item.title}</h3><span>{artifactKindLabel(item.kind)} · v{item.version.versionNumber} · Updated {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.updatedAt))}
          {item.publicationCount > 0 ? ` · ${item.publicationCount} published ${item.publicationCount === 1 ? "link" : "links"}` : ""}</span></span>
      </button>
      <UiV2IconButton icon="more" label={`Actions for ${item.title}`} ref={triggerRef} aria-haspopup="menu" aria-expanded={menuOpen}
        disabled={busy} onClick={() => setMenuOpen(value => !value)} />
      {menuOpen ? <UiV2ResponsiveMenu anchorRef={triggerRef} menuRef={menuRef} label={`Actions for ${item.title}`} onClose={() => setMenuOpen(false)}>
        {!archived ? <a className="v2-menu-item v2-focusable" role="menuitem" href={`/artifacts/${encodeURIComponent(item.id)}/versions/${encodeURIComponent(item.currentVersionId)}`} target="_blank" rel="noreferrer" onClick={closeForAction}>Open in new tab</a> : null}
        <UiV2MenuItem disabled={!item.sourceChatId} onClick={() => {
          closeForAction(); if (item.sourceChatId) void onOpenChat(item.sourceChatId).catch(() => setError("This chat is no longer available."));
        }}>Open source chat</UiV2MenuItem>
        {!archived ? <><UiV2MenuItem onClick={() => choose("rename")}>Rename</UiV2MenuItem>
          <UiV2MenuItem disabled={busy} onClick={() => { closeForAction(); void change("duplicate"); }}>Duplicate</UiV2MenuItem>
          <a className="v2-menu-item v2-focusable" role="menuitem" href={`${base}?download=zip`} download onClick={closeForAction}>Download ZIP</a></> : null}
        <UiV2MenuSeparator />
        <UiV2MenuItem onClick={() => {
          if (!archived && item.publicationCount > 0) choose("archive");
          else { closeForAction(); void change({ archived: !archived }); }
        }}>{archived ? "Restore" : "Archive"}</UiV2MenuItem>
        <UiV2MenuItem tone="destructive" onClick={() => choose("delete")}>Delete…</UiV2MenuItem>
      </UiV2ResponsiveMenu> : null}
    </div>
    {action === "rename" ? <form className="v2-artifact-library-inline" onSubmit={event => { event.preventDefault(); void change({ title }); }}
      onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); cancel(); } }}>
      <label>Artifact title<input aria-label="Artifact title" value={title} maxLength={240} autoFocus onChange={event => setTitle(event.target.value)} /></label>
      <div><UiV2Button type="submit" tone="primary" busy={busy} disabled={!title.trim()}>Save title</UiV2Button><UiV2Button disabled={busy} onClick={cancel}>Cancel</UiV2Button></div>
    </form> : action ? <div className="v2-artifact-library-inline" role="alert">
      <p>{action === "delete" ? `Delete “${item.title}” and all its versions? Published links stop working. This cannot be undone.`
        : `Archive “${item.title}”? Its ${item.publicationCount} published ${item.publicationCount === 1 ? "link will" : "links will"} be revoked. Versions are kept.`}</p>
      <div><UiV2Button tone="destructive" busy={busy} onClick={() => void change(action === "delete" ? "delete" : { archived: true })}>
        {action === "delete" ? "Delete permanently" : "Archive artifact"}</UiV2Button><UiV2Button disabled={busy} onClick={cancel}>Cancel</UiV2Button></div>
    </div> : null}
    {error ? <p className="v2-artifact-library-error" role="alert">{error}</p> : null}
  </li>;
}
