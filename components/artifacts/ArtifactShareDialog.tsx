"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ARTIFACT_LIMITS, decodeArtifactPublicationSummary, type ArtifactDetail, type ArtifactPublicationSummary } from "@/lib/contracts/artifacts";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { ArtifactRequestError, artifactRequest, loadArtifactDetail, loadArtifactPublicationPage, loadArtifactVersionPage } from "./artifactClient";
import { ArtifactPublicationVersions } from "./ArtifactPublicationVersions";

type Props = Readonly<{ artifactId: string; versionId: string; versionNumber: number; onClose(): void; onPublished?(): void }>;
type VersionSet = Extract<ArtifactPublicationSummary, { mode: "version_set" }>;
type Confirmation = { id: string; action: "revoke" | "reissue" };
type Mutation = { action: "add" | "reorder"; versionIds: string[] } | { action: "remove" | "set_default"; versionId: string };

function publicationStatus(publication: ArtifactPublicationSummary, observedAt: number): string {
  if (publication.status === "REVOKED") return "Revoked";
  if (publication.expiresAt && Date.parse(publication.expiresAt) <= observedAt) return "Expired";
  return publication.status === "PENDING" ? "Publishing" : "Published";
}
function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function oneTimeLink(body: Record<string, unknown>): { id: string; path: string } {
  const publication = body.publication as { id?: unknown; publicPath?: unknown } | undefined;
  if (typeof publication?.id !== "string" || typeof publication.publicPath !== "string" || !/^\/a\/[A-Za-z0-9_-]{1,128}$/u.test(publication.publicPath)) {
    throw new Error("The link could not be read. Check published links before trying again.");
  }
  return { id: publication.id, path: publication.publicPath };
}

export function ArtifactShareDialog(props: Props) {
  return <ArtifactShareDialogState key={props.artifactId} {...props} />;
}

function ArtifactShareDialogState({ artifactId, versionId: initialVersionId, versionNumber: initialVersionNumber, onClose, onPublished }: Props) {
  const [{ versionId, versionNumber }] = useState(() => ({ versionId: initialVersionId, versionNumber: initialVersionNumber }));
  const [busy, setBusy] = useState<string | null>(null);
  const [links, setLinks] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("never");
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [reload, setReload] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [managedId, setManagedId] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState(Date.now);
  const [mode, setMode] = useState<"single" | "version_set">("single");
  const [included, setIncluded] = useState<string[]>([versionId]);
  const [defaultId, setDefaultId] = useState(versionId);
  const submitting = useRef(false);
  const active = useRef(true);
  const listGeneration = useRef(0);
  const actionAbort = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; actionAbort.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); const generation = ++listGeneration.current;
    void loadArtifactDetail(artifactId, controller.signal, versionId).then(value => {
      if (!controller.signal.aborted && generation === listGeneration.current) { setDetail(value); setLoadError(null); setObservedAt(Date.now()); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted && generation === listGeneration.current) setLoadError(failure instanceof Error ? failure.message : "Could not load published links.");
    });
    return () => controller.abort();
  }, [artifactId, reload, versionId]);
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose, closeBlocked: busy !== null });
  const selected = detail?.versions.find(version => version.id === versionId);
  const title = detail?.title;
  const publications = [...(detail?.publications ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const visiblePublications = showAll ? publications : publications.slice(0, 5);
  const chosenVersions = included.flatMap(id => detail?.versions.find(version => version.id === id) ?? []);
  const existingLink = Object.keys(links).length > 0;

  function changed(publication?: ArtifactPublicationSummary) {
    listGeneration.current += 1;
    if (publication) setDetail(current => current ? { ...current, publications: [publication, ...current.publications.filter(item => item.id !== publication.id)] } : current);
    onPublished?.();
  }
  function refresh() { if (active.current) { listGeneration.current += 1; setReload(value => value + 1); } }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); if (active.current) setNotice("Link copied"); }
    catch { if (active.current) setNotice("Copy the link now"); }
  }
  async function reveal(body: Record<string, unknown>) {
    const result = oneTimeLink(body);
    const publication = decodeArtifactPublicationSummary(body.publication);
    if (!active.current) return;
    const url = window.location.origin + result.path;
    setLinks(current => ({ ...current, [result.id]: url }));
    changed(publication ?? undefined);
    if (!publication) refresh();
    await copy(url);
  }
  function forgetLink(id: string) { setLinks(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))); }
  async function recover(publication: ArtifactPublicationSummary) {
    try {
      const response = await artifactRequest(`/api/artifacts/publications/${encodeURIComponent(publication.id)}`);
      const fresh = decodeArtifactPublicationSummary(response.publication);
      if (!fresh || fresh.id !== publication.id) throw new Error("unreadable");
      if (active.current) changed(fresh);
    } catch { refresh(); }
  }
  async function action(key: string, run: (signal: AbortSignal) => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true; setBusy(key); setNotice(null); setError(null);
    const controller = new AbortController(); actionAbort.current = controller;
    try { await run(controller.signal); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : "The request could not finish. Try again."); }
    finally { submitting.current = false; if (actionAbort.current === controller) actionAbort.current = null; if (active.current) { setBusy(null); setObservedAt(Date.now()); } }
  }
  async function publish() {
    if (!selected || loadError || mode === "version_set" && (!included.length || !included.includes(defaultId) || chosenVersions.length !== included.length)) return;
    await action("publish", async signal => {
      const result = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/publish`, { method: "POST", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({
          ...(mode === "single" ? { versionId } : { mode, versionIds: included, defaultVersionId: defaultId }),
          ...(expiry !== "never" ? { expiresInDays: Number(expiry) } : {})
        }) });
      await reveal(result);
    });
  }
  async function mutate(publication: VersionSet, mutation: Mutation) {
    await action(publication.id, async signal => {
      try {
        const result = await artifactRequest(`/api/artifacts/publications/${encodeURIComponent(publication.id)}`, { method: "PATCH", signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: publication.revision, ...mutation }) });
        const fresh = decodeArtifactPublicationSummary(result.publication);
        if (!fresh || fresh.id !== publication.id) throw new Error("The updated link could not be read. Reload its published versions before trying again.");
        if (active.current) { changed(fresh); setNotice("Published versions updated."); }
      } catch (failure) {
        if (active.current) await recover(publication);
        throw failure;
      }
    });
  }
  async function confirm(publication: ArtifactPublicationSummary, operation: "reissue" | "revoke") {
    await action(publication.id, async signal => {
      try {
        const result = await artifactRequest(`/api/artifacts/publications/${encodeURIComponent(publication.id)}/${operation}`, { method: "POST", signal,
          ...(publication.mode === "version_set" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: publication.revision }) } : {}) });
        if (!active.current) return;
        setConfirmation(null);
        if (operation === "reissue") await reveal(result);
        else {
          forgetLink(publication.id); changed({ ...publication, status: "REVOKED" });
          setNotice("Link revoked. It can no longer be opened.");
        }
      } catch (failure) {
        if (!active.current) return;
        setConfirmation(null);
        if (operation === "reissue") forgetLink(publication.id);
        await recover(publication);
        if (operation === "reissue" && !(failure instanceof ArtifactRequestError && failure.status < 500)) {
          throw new Error("The new link could not be retrieved and cannot be recovered. Choose Reissue link again to create another link.");
        }
        throw failure;
      }
    });
  }
  async function moreVersions() {
    const cursor = detail?.versionsNextCursor; if (!cursor) return;
    await action("versions", async signal => {
      const page = await loadArtifactVersionPage(artifactId, { cursor }, signal);
      if (active.current) setDetail(current => current ? { ...current, versionsNextCursor: page.nextCursor,
        versions: [...current.versions, ...page.versions.filter(version => !current.versions.some(item => item.id === version.id))] } : current);
    });
  }
  async function morePublications() {
    const cursor = detail?.publicationsNextCursor; if (!cursor) return;
    await action("publications", async signal => {
      const page = await loadArtifactPublicationPage(artifactId, cursor, signal);
      if (active.current) setDetail(current => current ? { ...current, publicationsNextCursor: page.nextCursor,
        publications: [...current.publications, ...page.publications.filter(publication => !current.publications.some(item => item.id === publication.id))] } : current);
    });
  }
  function toggleVersion(id: string, checked: boolean) {
    const next = checked ? [...included, id] : included.filter(current => current !== id);
    setIncluded(next); if (!next.includes(defaultId)) setDefaultId(next[0] ?? "");
  }

  if (!portalReady) return null;
  return createPortal(<div className="v2-artifact-share-layer" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section aria-label={title ? `Share “${title}”` : "Share artifact"} aria-modal="true" className="v2-artifact-share" onKeyDown={event => {
      if (event.key === "Escape" && confirmation && !busy) { event.preventDefault(); setConfirmation(null); initialFocusRef.current?.focus(); return; }
      onDialogKeyDown(event);
    }} ref={dialogRef} role="dialog">
      <header className="v2-artifact-share-heading"><div><h2>{title ? `Share “${title}”` : "Share artifact"}</h2><p>Version v{versionNumber}</p></div><UiV2IconButton disabled={busy !== null} icon="close" label="Close" onClick={onClose} ref={initialFocusRef} /></header>
      <section className="v2-artifact-share-section">
        <h3>Create a public link</h3>
        <p>Anyone with the link can open and download the published versions without signing in. Later edits stay private until you publish them.</p>
        {selected?.kind === "game" ? <p>Game progress is saved in each viewer’s browser.</p> : null}
        {Object.entries(links).map(([id, url]) => <div className="v2-artifact-new-link" key={id}>
          <label className="v2-artifact-field">Public link<input autoComplete="off" className="v2-focusable" onFocus={event => event.currentTarget.select()} readOnly value={url} /></label>
          <div className="v2-artifact-share-actions"><UiV2Button icon="copy" onClick={() => void copy(url)} tone="primary" type="button">Copy link</UiV2Button><a className="v2-button v2-focusable" data-tone="ghost" href={url} rel="noreferrer" target="_blank"><UiV2Icon name="external" />Open</a></div>
          <p className="v2-artifact-note">For privacy, this link is shown only once. You can revoke it below at any time.</p>
        </div>)}
        {!existingLink ? <>
          <fieldset className="v2-artifact-publish-mode" disabled={busy !== null || !detail || Boolean(loadError)}>
            <legend>Link type</legend>
            <label><input aria-label="Single version" checked={mode === "single"} name="artifact-publication-mode" onChange={() => setMode("single")} type="radio" value="single" />Single version<span>Only v{versionNumber}, exactly as it is now.</span></label>
            <label><input aria-label="Version set" checked={mode === "version_set"} name="artifact-publication-mode" onChange={() => setMode("version_set")} type="radio" value="version_set" />Version set<span>Choose the versions available through one stable link.</span></label>
          </fieldset>
          {mode === "version_set" ? <>
            <fieldset className="v2-artifact-version-choices" disabled={busy !== null}>
              <legend>Versions to publish</legend>
              {[...(detail?.versions ?? [])].sort((a, b) => a.versionNumber - b.versionNumber).map(version => <label key={version.id}>
                <input aria-label={`Include v${version.versionNumber}`} checked={included.includes(version.id)} disabled={!included.includes(version.id) && included.length >= ARTIFACT_LIMITS.maxPublicationVersions}
                  onChange={event => toggleVersion(version.id, event.target.checked)} type="checkbox" />
                <strong>v{version.versionNumber}</strong><span>{version.title}</span>
              </label>)}
            </fieldset>
            <p className="v2-artifact-note">{included.length} of {ARTIFACT_LIMITS.maxPublicationVersions} versions selected. New versions are never added automatically.</p>
            <label className="v2-artifact-field">Default version<select className="v2-focusable" disabled={busy !== null || !chosenVersions.length} value={defaultId} onChange={event => setDefaultId(event.target.value)}>
              {!chosenVersions.length ? <option value="">Choose a version</option> : null}{chosenVersions.map(version => <option key={version.id} value={version.id}>v{version.versionNumber}</option>)}
            </select></label>
            {detail?.versionsNextCursor ? <UiV2Button disabled={busy !== null} onClick={() => void moreVersions()} type="button">Load more versions</UiV2Button> : null}
          </> : null}
          <div className="v2-artifact-share-actions">
            <label className="v2-artifact-field v2-artifact-expiry">Link expires<select className="v2-focusable" disabled={busy !== null} onChange={event => setExpiry(event.target.value)} value={expiry}><option value="never">Never</option><option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option></select></label>
            <UiV2Button busy={busy === "publish"} disabled={busy !== null || !selected || Boolean(loadError) || mode === "version_set" && !included.length} onClick={() => void publish()} tone="primary" type="button">{mode === "single" ? `Publish v${versionNumber}` : "Publish versions"}</UiV2Button>
          </div>
        </> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <p className="v2-artifact-error" role="alert">{error}</p> : null}
      </section>
      <section aria-label="Published links" className="v2-artifact-share-section">
        <h3>Published links</h3>
        {loadError ? <div className="v2-artifact-share-load" role="alert"><p>{loadError}</p><UiV2Button disabled={busy !== null} onClick={() => { setLoadError(null); refresh(); }} type="button">Retry</UiV2Button></div> : !detail ? <p role="status"><span className="v2-spinner" aria-hidden="true" />Loading published links…</p> : publications.length === 0 ? <p>No public links yet. This artifact is private.</p> : <>
          <ul className="v2-artifact-publications">{visiblePublications.map(publication => {
            const status = publicationStatus(publication, observedAt);
            const inactive = status === "Revoked" || status === "Expired";
            const version = publication.mode === "version_set" ? null : detail.versions.find(item => item.id === publication.versionId);
            const confirming = confirmation?.id === publication.id ? confirmation.action : null;
            return <li data-inactive={inactive || undefined} data-testid={`artifact-publication-${publication.id}`} key={publication.id}>
              <div className="v2-artifact-publication"><div>
                <p>{publication.mode === "version_set" ? `Version set · ${publication.versions.map(item => `v${item.versionNumber}`).join(", ")}`
                  : publication.versionNumber !== undefined || version ? `v${publication.versionNumber ?? version!.versionNumber}` : "Single version"}</p>
                <p className="v2-artifact-note">Published {dateLabel(publication.createdAt)} · Expires {publication.expiresAt ? dateLabel(publication.expiresAt) : "Never"} · <span>{status}</span></p>
              </div></div>
              {!inactive ? <div className="v2-artifact-share-actions">
                {publication.mode === "version_set" ? <>
                  <UiV2Button aria-expanded={managedId === publication.id} disabled={busy !== null} onClick={() => setManagedId(current => current === publication.id ? null : publication.id)} type="button">Manage versions</UiV2Button>
                  {!confirming ? <UiV2Button disabled={busy !== null || publication.status !== "READY"} onClick={() => setConfirmation({ id: publication.id, action: "reissue" })} type="button">Reissue link</UiV2Button> : null}
                </> : null}
                {!confirming ? <UiV2Button disabled={busy !== null} onClick={() => setConfirmation({ id: publication.id, action: "revoke" })} type="button">Revoke</UiV2Button> : null}
              </div> : null}
              {managedId === publication.id && publication.mode === "version_set" && !inactive ? <>
                <ArtifactPublicationVersions publication={publication} versions={detail.versions} busy={busy !== null}
                  onAdd={id => void mutate(publication, { action: "add", versionIds: [id] })} onRemove={id => void mutate(publication, { action: "remove", versionId: id })}
                  onDefault={id => void mutate(publication, { action: "set_default", versionId: id })} onReorder={ids => void mutate(publication, { action: "reorder", versionIds: ids })} />
                {detail.versionsNextCursor ? <UiV2Button disabled={busy !== null} onClick={() => void moreVersions()} type="button">Load more versions</UiV2Button> : null}
              </> : null}
              {confirming ? <div className="v2-artifact-revoke-confirm">
                <p>{confirming === "reissue" ? "The old link will stop working. Published versions and the expiry date stay the same." : "Revoke this link? It stops working immediately."}</p>
                {confirming === "reissue" ? <p>The new link starts with fresh saved state in each viewer’s browser. Progress from the old link is not transferred.</p> : null}
                <div className="v2-artifact-share-actions"><UiV2Button busy={busy === publication.id} disabled={busy !== null} onClick={() => void confirm(publication, confirming)} tone="destructive" type="button">{confirming === "reissue" ? "Reissue link" : "Revoke link"}</UiV2Button><UiV2Button autoFocus disabled={busy !== null} onClick={() => { setConfirmation(null); initialFocusRef.current?.focus(); }} type="button">Cancel</UiV2Button></div>
              </div> : null}
            </li>;
          })}</ul>
          {!showAll && publications.length > 5 ? <UiV2Button disabled={busy !== null} onClick={() => setShowAll(true)} type="button">Show all ({publications.length})</UiV2Button> : null}
          {(showAll || publications.length <= 5) && detail.publicationsNextCursor ? <UiV2Button disabled={busy !== null} onClick={() => void morePublications()} type="button">Load more links</UiV2Button> : null}
        </>}
      </section>
    </section>
  </div>, document.body);
}
