"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { artifactButtonClass, artifactRequest } from "./artifactClient";

export function ArtifactShareDialog({ artifactId, versionId, versionNumber, onClose, onPublished }: {
  artifactId: string; versionId: string; versionNumber: number; onClose(): void; onPublished?(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("never");
  const submitting = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose, closeBlocked: busy });
  async function publish() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setNotice(null);
    try {
      const result = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/publish`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId,
          ...(expiry !== "never" ? { expiresInDays: Number(expiry) } : {}) }) });
      const publication = result.publication as { id?: unknown; publicPath?: unknown } | undefined;
      if (typeof publication?.id !== "string" || typeof publication.publicPath !== "string" || !/^\/a\/[A-Za-z0-9_-]+$/u.test(publication.publicPath)) throw new Error("The link could not be read. Check published links before trying again.");
      if (active.current) { setLink(window.location.origin + publication.publicPath); setPublicationId(publication.id); onPublished?.(); }
    } catch (error) { if (active.current) setNotice(error instanceof Error ? error.message : "Publishing failed."); }
    finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link!); setNotice("Link copied."); }
    catch { setNotice("Select the link and copy it manually."); }
  }
  async function revoke() {
    if (submitting.current || !publicationId) return;
    submitting.current = true; setBusy(true);
    try {
      await artifactRequest(`/api/artifacts/publications/${encodeURIComponent(publicationId)}/revoke`, { method: "POST" });
      if (active.current) { setLink(null); setPublicationId(null); setNotice("Link revoked. It can no longer be opened."); onPublished?.(); }
    } catch (error) { if (active.current) setNotice(error instanceof Error ? error.message : "Could not revoke this link."); }
    finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  if (!portalReady) return null;
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--v2-color-scrim)] p-3" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Publish version ${versionNumber}`} onKeyDown={onDialogKeyDown}
      className="max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border border-trace-subtle bg-answer-paper p-5 text-ink shadow-xl">
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Share v{versionNumber}</h2><button ref={initialFocusRef} className={artifactButtonClass} disabled={busy} onClick={onClose} type="button">Close</button></div>
      <p className="text-sm text-ink-secondary">Anyone with the link can open and download this version without signing in, including its HTML, code, text and images. Remove private information before publishing.</p>
      <p className="text-sm text-ink-secondary">Later edits stay private until you publish them. Game state stays in the viewer’s current session.</p>
      {link ? <>
        <label className="block text-sm">Public link<input className="mt-2 block w-full min-w-0 rounded-md border border-trace-subtle bg-workspace-rail p-2" readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></label>
        <p className="text-xs text-ink-muted">Copy this link now. For privacy, AIQSA cannot display it again after closing this dialog.</p>
        <div className="flex flex-wrap gap-2"><button className={artifactButtonClass} onClick={() => void copy()} type="button">Copy link</button><a className={artifactButtonClass} href={link} target="_blank" rel="noreferrer">Open link</a><button className={artifactButtonClass} disabled={busy} onClick={() => void revoke()} type="button">{busy ? "Revoking…" : "Revoke link"}</button></div>
      </> : <>
        <label className="flex flex-wrap items-center gap-3 text-sm">Link expires<select className="min-h-10 rounded-md border border-trace-subtle bg-answer-paper px-2" value={expiry} disabled={busy} onChange={(event) => setExpiry(event.target.value)}><option value="never">Never</option><option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option></select></label>
        <button className={artifactButtonClass} disabled={busy} onClick={() => void publish()} type="button">{busy ? "Publishing…" : `Publish v${versionNumber}`}</button>
      </>}
      {notice ? <p role="status" className="text-sm text-ink-secondary">{notice}</p> : null}
    </section>
  </div>, document.body);
}
