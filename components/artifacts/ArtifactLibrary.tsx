"use client";
import { useEffect, useRef, useState } from "react";
import { ARTIFACT_KINDS } from "@/lib/contracts/artifacts";
import { artifactButtonClass, artifactRequest } from "./artifactClient";

type Item = { id: string; title: string; kind: string; currentVersionId: string; publicationCount: number; version: { versionNumber: number } };

function decodeItems(value: unknown): Item[] {
  if (!Array.isArray(value)) throw new Error("The artifact list could not be read.");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("The artifact list could not be read.");
    const row = item as Record<string, unknown>;
    const version = row.version as Record<string, unknown> | null;
    if (typeof row.id !== "string" || typeof row.title !== "string" || !ARTIFACT_KINDS.some(kind => kind === row.kind) ||
      typeof row.currentVersionId !== "string" || !Number.isSafeInteger(row.publicationCount) || !version || !Number.isSafeInteger(version.versionNumber)) throw new Error("The artifact list could not be read.");
    return { id: row.id, title: row.title, kind: row.kind as string, currentVersionId: row.currentVersionId,
      publicationCount: Number(row.publicationCount), version: { versionNumber: Number(version.versionNumber) } };
  });
}

export function ArtifactLibrary() {
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState<Item | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void artifactRequest(`/api/artifacts?archived=${archived}`, { signal: controller.signal }).then((body) => {
      if (!controller.signal.aborted) { setItems(decodeItems(body.artifacts)); setError(null); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load artifacts."); });
    return () => controller.abort();
  }, [archived, reload]);
  async function change(item: Item, method: "PATCH" | "DELETE", body?: unknown) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      await artifactRequest(`/api/artifacts/${encodeURIComponent(item.id)}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (active.current) { setRenaming(null); setDeleting(null); setReload(value => value + 1); }
    } catch (error) { if (active.current) setError(error instanceof Error ? error.message : "The request could not finish."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Artifacts</h1><p className="mt-1 text-sm text-ink-secondary">Your recent pages, slides, games and images. Ask for an artifact in chat to create one.</p></div>
      <button className={artifactButtonClass} disabled={busy} onClick={() => { setArchived(value => !value); setItems(null); setError(null); setRenaming(null); setDeleting(null); }} type="button">{archived ? "Show recent" : "Show archived"}</button></div>
    {error ? <div className="flex flex-wrap items-center gap-3 text-sm" role="alert"><p>{error}</p><button className={artifactButtonClass} disabled={busy} onClick={() => setReload(value => value + 1)} type="button">Retry</button></div> : null}
    {!items && !error ? <p role="status" className="text-sm text-ink-secondary">Loading artifacts…</p> : null}
    {items?.length === 0 ? <p className="py-8 text-sm text-ink-secondary">{archived ? "No archived artifacts." : "No artifacts yet. Create one in a personal chat, then return here to open or share it."}</p> : null}
    <ul className="divide-y divide-trace-subtle">{items?.map(item => <li key={item.id} className="space-y-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><h2 className="break-words font-medium">{item.title}</h2><p className="text-xs text-ink-secondary">{item.kind} · v{item.version.versionNumber} · {archived ? "Archived" : item.publicationCount ? `${item.publicationCount} published ${item.publicationCount === 1 ? "link" : "links"}` : "Private"}</p></div>
        <div className="flex flex-wrap gap-2">
          {!archived ? <><a className={artifactButtonClass} href={`/artifacts/${encodeURIComponent(item.id)}/versions/${encodeURIComponent(item.currentVersionId)}`}>Open</a><button className={artifactButtonClass} disabled={busy} onClick={() => { setRenaming(item.id); setTitle(item.title); setDeleting(null); }} type="button">Rename</button></> : null}
          <button className={artifactButtonClass} disabled={busy} onClick={() => void change(item, "PATCH", { archived: !archived })} type="button">{archived ? "Unarchive" : "Archive"}</button>
          <button className={artifactButtonClass} disabled={busy} onClick={() => { setDeleting(item); setRenaming(null); }} type="button">Delete</button>
        </div></div>
      {renaming === item.id ? <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void change(item, "PATCH", { title }); }}><label className="min-w-0 flex-1 text-sm">Artifact title<input className="mt-1 block min-h-10 w-full rounded-md border border-trace-subtle bg-workspace-rail px-3" value={title} maxLength={240} onChange={event => setTitle(event.target.value)} autoFocus /></label><button className={artifactButtonClass} disabled={busy || !title.trim()} type="submit">Save title</button><button className={artifactButtonClass} disabled={busy} onClick={() => setRenaming(null)} type="button">Cancel</button></form> : null}
      {deleting?.id === item.id ? <div className="space-y-2 text-sm" role="alert"><p>Delete this artifact and all its versions? Published links will stop working. This cannot be undone.</p><div className="flex gap-2"><button className={artifactButtonClass} disabled={busy} onClick={() => void change(item, "DELETE")} type="button">Delete permanently</button><button className={artifactButtonClass} disabled={busy} onClick={() => setDeleting(null)} type="button">Cancel</button></div></div> : null}
    </li>)}</ul>
    {!archived && items?.length ? <p className="text-xs text-ink-muted">Archiving keeps your versions and revokes their published links. You can unarchive later.</p> : null}
  </div>;
}
