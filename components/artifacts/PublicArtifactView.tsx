"use client";
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2IconSprite, UiV2MenuItem } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import type { ArtifactPublicManifest } from "@/lib/contracts/artifacts";
import { artifactKindLabel } from "./artifactPresentation";
import { ArtifactFrameV2 } from "./ArtifactFrameV2";
import { artifactBrowserStorage, publicArtifactStateKey } from "./artifactBrowserStorage";
import { ArtifactPublicRequestError, fetchPublicArtifactManifest, fetchPublicArtifactVersion, publicArtifactDownloadName, publicArtifactSelection } from "./artifactPublicClient";

type PublicVersion = ArtifactPublicManifest["versions"][number];
type Content = { attempt: number; selected: PublicVersion; body: string; image: boolean };

function PublicArtifactActions({ onReset }: { onReset(): void }) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  return <div className="v2-artifact-more-control">
    <UiV2IconButton aria-expanded={open} aria-haspopup="menu" icon="more" label="Artifact actions" onClick={() => setOpen(value => !value)} ref={triggerRef} />
    {open ? <UiV2ResponsiveMenu anchorRef={triggerRef} className="v2-artifact-menu" label="Artifact actions" menuRef={menuRef} onClose={() => setOpen(false)}>
      <UiV2MenuItem onClick={() => { closeForAction(); onReset(); }} type="button">Reset saved state</UiV2MenuItem>
    </UiV2ResponsiveMenu> : null}
  </div>;
}

function PublishedVersionMenu({ manifest, selected, onChange }: { manifest: ArtifactPublicManifest; selected: PublicVersion; onChange(number: number): void }) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  if (manifest.mode === "single") return <span className="v2-public-artifact-kind">v{selected.versionNumber}</span>;
  return <div className="v2-artifact-version-control">
    <UiV2Button aria-expanded={open} aria-haspopup="menu" aria-label={`Version v${selected.versionNumber}`} onClick={() => setOpen(value => !value)} ref={triggerRef} type="button">
      v{selected.versionNumber}<UiV2Icon name="chevron-down" />
    </UiV2Button>
    {open ? <UiV2ResponsiveMenu anchorRef={triggerRef} className="v2-artifact-menu" label="Published versions" menuRef={menuRef} onClose={() => setOpen(false)}>
      {manifest.versions.map(version => <UiV2MenuItem aria-label={`v${version.versionNumber}`} key={version.versionNumber}
        selected={selected.versionNumber === version.versionNumber} sub={version.title}
        onClick={() => { closeForAction(); onChange(version.versionNumber); }} type="button">
        v{version.versionNumber}{version.versionNumber === manifest.defaultVersionNumber ? " · default" : ""}
      </UiV2MenuItem>)}
    </UiV2ResponsiveMenu> : null}
  </div>;
}

export function PublicArtifactView(props: { initialManifest: ArtifactPublicManifest; token: string }) {
  return <PublicArtifactState key={props.token} {...props} />;
}

function PublicArtifactState({ initialManifest, token }: { initialManifest: ArtifactPublicManifest; token: string }) {
  const [manifest, setManifest] = useState(initialManifest);
  const [selected, setSelected] = useState(() => publicArtifactSelection(initialManifest, "").selected);
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const loadAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const navigation = useRef("");
  const active = useRef(true);
  const ready = content?.attempt === attempt && !error ? content : null;

  useEffect(() => {
    active.current = true;
    navigation.current = window.location.hash;
    const navigate = () => {
      if (navigation.current === window.location.hash) return;
      navigation.current = window.location.hash;
      loadAbort.current?.abort(); downloadAbort.current?.abort(); downloadAbort.current = null;
      setError(null); setNotice(null); setDownloading(false); setAttempt(value => value + 1);
    };
    window.addEventListener("hashchange", navigate); window.addEventListener("popstate", navigate);
    return () => {
      active.current = false; downloadAbort.current?.abort();
      window.removeEventListener("hashchange", navigate); window.removeEventListener("popstate", navigate);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController(); loadAbort.current = controller;
    let objectUrl: string | null = null;
    const select = (fresh: ArtifactPublicManifest, fragment: string) => {
      const choice = publicArtifactSelection(fresh, fragment);
      if (choice.fallback) {
        window.history.replaceState(window.history.state, "", `#v${choice.selected.versionNumber}`);
        navigation.current = window.location.hash;
        setNotice(`Requested version is unavailable. Showing v${choice.selected.versionNumber}.`);
      }
      setManifest(fresh); setSelected(choice.selected);
      return choice.selected;
    };
    void (async () => {
      try {
        let fresh = await fetchPublicArtifactManifest(token, controller.signal);
        if (controller.signal.aborted) return;
        let version = select(fresh, window.location.hash);
        let response: Response;
        try { response = await fetchPublicArtifactVersion(token, version.versionNumber, controller.signal); }
        catch (failure) {
          if (!(failure instanceof ArtifactPublicRequestError) || failure.status !== 404 || fresh.mode !== "version_set") throw failure;
          fresh = await fetchPublicArtifactManifest(token, controller.signal);
          if (controller.signal.aborted) return;
          // A still-published member may be corrupt. Never disguise that failure as another version.
          if (fresh.versions.some(item => item.versionNumber === version.versionNumber)) throw failure;
          version = select(fresh, `#v${version.versionNumber}`);
          response = await fetchPublicArtifactVersion(token, version.versionNumber, controller.signal);
        }
        const image = (response.headers.get("content-type") ?? "").startsWith("image/");
        const body = image ? await response.blob() : await response.text();
        if (controller.signal.aborted) return;
        const source = typeof body === "string" ? body : (objectUrl = URL.createObjectURL(body));
        setContent({ body: source, image, selected: version, attempt }); setError(null);
        document.title = `${version.title} · AIQSA`;
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof ArtifactPublicRequestError ? failure.message : "Could not load this artifact. Try again.");
      }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attempt, token]);

  function changeVersion(number: number) {
    const fragment = `#v${number}`;
    if (window.location.hash === fragment && ready) return;
    loadAbort.current?.abort(); downloadAbort.current?.abort(); downloadAbort.current = null;
    window.history.pushState(window.history.state, "", fragment); navigation.current = fragment;
    setError(null); setNotice(null); setDownloading(false); setAttempt(value => value + 1);
  }
  async function resetState() {
    try {
      const cleared = await artifactBrowserStorage.clear(await publicArtifactStateKey(token));
      if (active.current) setNotice(cleared ? "Saved state reset for this artifact." : "Could not clear saved state in this browser. This preview has been reset.");
    } catch {
      if (active.current) { setReset(value => value + 1); setNotice("This preview has been reset. Saved state is unavailable in this browser."); }
    }
  }
  async function download() {
    if (!ready || downloadAbort.current) return;
    const controller = new AbortController(); downloadAbort.current = controller; setDownloading(true);
    try {
      const response = await fetchPublicArtifactVersion(token, ready.selected.versionNumber, controller.signal, true);
      const body = await response.blob();
      if (!active.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(body);
      const link = document.createElement("a"); link.href = url; link.download = publicArtifactDownloadName(response, ready.selected.versionNumber);
      link.hidden = true; document.body.append(link); link.click(); link.remove();
      const revoke = URL.revokeObjectURL.bind(URL);
      window.setTimeout(() => revoke(url), 1000);
    } catch (failure) {
      if (!active.current || controller.signal.aborted) return;
      if (failure instanceof ArtifactPublicRequestError && failure.status === 404 && manifest.mode === "version_set") {
        try {
          const fresh = await fetchPublicArtifactManifest(token, controller.signal);
          if (!active.current || controller.signal.aborted) return;
          if (fresh.versions.some(version => version.versionNumber === ready.selected.versionNumber)) setError("This download is unavailable. Try again.");
          else {
            window.history.replaceState(window.history.state, "", `#v${fresh.defaultVersionNumber}`);
            navigation.current = window.location.hash;
            setNotice(`Requested version is unavailable. Showing v${fresh.defaultVersionNumber}.`);
            setContent(null); setAttempt(value => value + 1);
          }
        } catch (refreshFailure) {
          if (active.current && !controller.signal.aborted) setError(refreshFailure instanceof ArtifactPublicRequestError ? refreshFailure.message : "This artifact is unavailable.");
        }
      } else setError(failure instanceof ArtifactPublicRequestError ? failure.message : "The download could not finish. Try again.");
    } finally {
      if (downloadAbort.current === controller) { downloadAbort.current = null; if (active.current) setDownloading(false); }
    }
  }
  const displayed = ready?.selected ?? selected;
  return <main className="v2-artifact-page v2-public-artifact">
    <UiV2IconSprite />
    <header className="v2-public-artifact-toolbar">
      <Link className="v2-public-artifact-brand v2-focusable" href="/">AIQSA</Link>
      <h1 title={displayed.title}>{displayed.title}</h1>
      <span className="v2-public-artifact-kind v2-public-artifact-type">{artifactKindLabel(displayed.kind)}</span>
      <PublishedVersionMenu manifest={manifest} selected={displayed} onChange={changeVersion} />
      <span className="v2-public-artifact-readonly"><UiV2Icon name="lock" />Read-only snapshot</span>
      <UiV2Button busy={downloading} disabled={!ready || downloading} icon="download" onClick={() => void download()} type="button">Download</UiV2Button>
      <PublicArtifactActions onReset={() => void resetState()} />
    </header>
    {notice ? <div className="v2-artifact-banner" role="status">{notice}</div> : null}
    <div className="v2-artifact-scene">
      {error ? <div className="v2-artifact-empty" role="alert"><p>{error}</p>
        <UiV2Button onClick={() => { setError(null); setContent(null); setNotice(null); setAttempt(value => value + 1); }}>Try again</UiV2Button></div>
        : ready ? ready.image ? <img alt={ready.selected.title} className="v2-artifact-image" src={ready.body} />
          : <ArtifactFrameV2 key={`${token}:${reset}`} publicToken={token} body={ready.body} title={ready.selected.title} />
          : <div className="v2-artifact-empty" role="status">Loading artifact…</div>}
    </div>
  </main>;
}
