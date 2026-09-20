"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ArtifactDetail } from "@/lib/contracts/artifacts";
import { PrivateArtifactView } from "./PrivateArtifactView";
import { ArtifactShareDialog } from "./ArtifactShareDialog";
import { ArtifactSource } from "./ArtifactSource";
import { artifactButtonClass, artifactRequest, loadArtifactDetail, prepareArtifactEdit } from "./artifactClient";

export function ArtifactWorkbench({ artifactId, versionId }: { artifactId: string; versionId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"stage" | "source">("stage");
  const [shareOpen, setShareOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [observedAt, setObservedAt] = useState(Date.now);
  const mutation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadArtifactDetail(artifactId, controller.signal).then((value) => { if (!controller.signal.aborted) { setDetail(value); setObservedAt(Date.now()); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Could not load version history."); });
    return () => controller.abort();
  }, [artifactId, reload]);
  const selected = detail?.versions.find((version) => version.id === versionId);
  const current = detail?.currentVersionId === versionId;
  async function mutate(action: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setNotice(null);
    try { await action(); }
    catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : "The request could not finish."); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }
  const refresh = () => { if (mounted.current) setReload((value) => value + 1); };
  async function restore() {
    await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
    if (mounted.current) { setNotice(`Version ${selected?.versionNumber} is now current.`); refresh(); }
  }
  async function edit(runtimeError = false) {
    const chatId = await prepareArtifactEdit(artifactId, versionId);
    if (mounted.current) router.push(`/?chat=${encodeURIComponent(chatId)}&artifactEdit=${runtimeError ? "runtime_error" : "edit"}&artifactId=${encodeURIComponent(artifactId)}&versionId=${encodeURIComponent(versionId)}`);
  }
  const contentPath = `/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/content`;
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h1 className="break-words text-xl font-semibold">{detail?.title ?? "Artifact"}</h1><p className="text-sm text-ink-secondary">{selected ? `${selected.kind} · v${selected.versionNumber}${current ? " · current" : " · historical version"}` : "Loading version…"}</p></div><div className="flex flex-wrap gap-2">{detail?.sourceChatId ? <a className={artifactButtonClass} href={`/?chat=${encodeURIComponent(detail.sourceChatId)}`}>Source chat</a> : null}<Link className={artifactButtonClass} href="/artifacts">All artifacts</Link></div></div>
    {notice ? <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-ink-secondary"><span>{notice}</span><button className={artifactButtonClass} onClick={refresh} type="button">Refresh</button></div> : null}
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y border-trace-subtle bg-answer-paper py-3" aria-label="Artifact controls">
      <div className="flex gap-1" role="tablist" aria-label="Artifact view"><button role="tab" aria-selected={tab === "stage"} aria-controls="artifact-stage" className={`${artifactButtonClass} aria-selected:border-control-accent aria-selected:text-control-accent`} onClick={() => setTab("stage")} type="button">Stage</button><button role="tab" aria-selected={tab === "source"} aria-controls="artifact-source" className={`${artifactButtonClass} aria-selected:border-control-accent aria-selected:text-control-accent`} onClick={() => setTab("source")} type="button">Source</button></div>
      <label className="flex items-center gap-2 text-sm">Version<select className="min-h-10 max-w-[12rem] rounded-md border border-trace-subtle bg-answer-paper px-2 text-sm text-ink" disabled={!detail || busy} value={versionId} onChange={(event) => router.push(`/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(event.target.value)}`, { scroll: false })}>
        {detail?.versions.map((version) => <option key={version.id} value={version.id}>v{version.versionNumber}{version.id === detail.currentVersionId ? " · current" : ""}</option>)}
      </select></label>
      <button className={artifactButtonClass} disabled={busy || !selected || current} onClick={() => void mutate(restore)} type="button">Restore version</button>
      <button className={artifactButtonClass} disabled={busy || !selected || !current} onClick={() => void mutate(() => edit())} type="button">Edit with AI</button>
      <button className={artifactButtonClass} disabled={busy || !selected} onClick={() => setShareOpen(true)} type="button">Share</button>
      <a className={artifactButtonClass} download href={`${contentPath}?download=zip`}>Download ZIP</a>
      <a className={artifactButtonClass} download href={contentPath}>Download file</a>
    </div>
    <section id="artifact-stage" aria-label="Stage" role="tabpanel" hidden={tab !== "stage"}><PrivateArtifactView key={versionId} artifactId={artifactId} versionId={versionId} onFix={() => void mutate(() => edit(true))} fixDisabled={!current || busy} /></section>
    <section id="artifact-source" aria-label="Source" role="tabpanel" hidden={tab !== "source"}>{tab === "source" ? <ArtifactSource key={versionId} artifactId={artifactId} versionId={versionId} /> : null}</section>
    {detail ? <details className="border-t border-trace-subtle pt-3"><summary className="cursor-pointer text-sm font-medium">Published links ({detail.publications.length})</summary>
      <p className="my-2 text-xs text-ink-muted">Each link shares one saved version. Revocation prevents future opens; downloaded copies remain with their viewers.</p>
      {detail.publications.length ? <ul className="space-y-2">{detail.publications.map((publication) => {
        const expired = publication.expiresAt !== null && new Date(publication.expiresAt).getTime() <= observedAt;
        const status = publication.status === "REVOKED" ? "Revoked" : expired ? "Expired" : publication.status === "PENDING" ? "Publishing" : "Published";
        return <li key={publication.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>v{detail.versions.find((version) => version.id === publication.versionId)?.versionNumber ?? "?"} · {status} · {new Date(publication.createdAt).toLocaleString()}</span>{publication.status !== "REVOKED" ? <button className={artifactButtonClass} disabled={busy} onClick={() => void mutate(async () => { await artifactRequest(`/api/artifacts/publications/${encodeURIComponent(publication.id)}/revoke`, { method: "POST" }); refresh(); })} type="button">Revoke link</button> : null}</li>;
      })}</ul> : <p className="text-sm text-ink-secondary">This artifact is private.</p>}
    </details> : null}
    {shareOpen && selected ? <ArtifactShareDialog key={versionId} artifactId={artifactId} versionId={versionId} versionNumber={selected.versionNumber} onClose={() => setShareOpen(false)} onPublished={refresh} /> : null}
  </div>;
}
