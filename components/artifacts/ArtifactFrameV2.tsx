"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ARTIFACT_VIEW_ALLOW,
  ARTIFACT_VIEW_SANDBOX,
  parseArtifactNavigateMessage,
  parseArtifactOpenLinkMessage,
  parseArtifactRuntimeError,
  parseArtifactStorageMessage,
  type ArtifactNavigateMessage,
  type ArtifactRuntimeError
} from "@/lib/contracts/artifactRuntime";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import { UiV2Button } from "@/components/ui-v2";
import { ArtifactExternalLinkDialog } from "./ArtifactExternalLinkDialog";
import { artifactBrowserStorage, injectArtifactStorageSnapshot, privateArtifactStateKey, publicArtifactStateKey } from "./artifactBrowserStorage";
import { ARTIFACT_DOWNLOAD_LIMITS, artifactDownloadDecision, parseArtifactDownloadMessage, saveArtifactDownload,
  type ArtifactDownloadRequest } from "./artifactDownload";

/** Messages that leave the frame (a confirmed link, another page or a download prompt) are acted on at most once per interval. */
const FRAME_REQUEST_INTERVAL_MS = 500;

/** A download the user confirms in the viewer, or one too large to save. */
type DownloadPrompt = Readonly<{ kind: "ask"; request: ArtifactDownloadRequest }> | Readonly<{ kind: "too_large"; name: string }>;

type Props = {
  body: string;
  title: string;
  artifactId?: string;
  publicToken?: string;
  /** A new value loads the same body as a new document: a link to the page already shown. */
  revision?: number;
  /** Moves keyboard focus into the next document loaded for a new body or revision. */
  focusOnLoad?: boolean;
  onRuntimeError?(error: ArtifactRuntimeError): void;
  /**
   * A link asks to show another page of the artifact; `focused` tells whether the frame had keyboard focus.
   * Returns false while another page still loads: the request then waits for the next document.
   */
  onNavigate?(target: ArtifactNavigateMessage, focused: boolean): boolean | void;
  onReset?(): void;
  onEscape?(): void;
};

type FrameDocument = { body: string; generation: number; source: string; revision?: number; artifactId?: string; publicToken?: string; focus: boolean };

/** The same iframe host protects private and anonymous views. Thumbnails never use it. */
export function ArtifactFrameV2({ body, title, artifactId, publicToken, revision, focusOnLoad, onRuntimeError, onNavigate, onReset, onEscape }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onRuntimeError, onNavigate, onReset, onEscape, focusOnLoad });
  const [document, setDocument] = useState<FrameDocument | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [href, setHref] = useState<string | null>(null);
  const openLink = useRef<string | null>(null);
  const lastLinkAt = useRef(-Infinity);
  // One download prompt at a time, at most once per interval: the frame cannot stack them.
  const [downloadPrompt, setDownloadPrompt] = useState<DownloadPrompt | null>(null);
  const shownDownloadPrompt = useRef<DownloadPrompt | null>(null);
  const lastDownloadPromptAt = useRef(-Infinity);
  const showDownloadPrompt = useCallback((prompt: DownloadPrompt | null) => {
    shownDownloadPrompt.current = prompt;
    if (prompt) lastDownloadPromptAt.current = performance.now();
    setDownloadPrompt(prompt);
  }, []);
  // Kept for the life of this host, across the pages it shows: authored code can post
  // navigation itself, so a page that keeps sending it still waits between requests.
  const lastNavigationAt = useRef(-Infinity);
  // A request inside the interval, or while another page loads, waits here; a newer one replaces it.
  const pendingNavigation = useRef<{ target: ArtifactNavigateMessage; focused: boolean } | null>(null);
  const navigationTimer = useRef<number | null>(null);
  useEffect(() => { callbacks.current = { onRuntimeError, onNavigate, onReset, onEscape, focusOnLoad }; }, [onRuntimeError, onNavigate, onReset, onEscape, focusOnLoad]);

  const flushNavigation = useCallback(function flush() {
    const pending = pendingNavigation.current;
    if (!pending || navigationTimer.current !== null) return;
    const wait = lastNavigationAt.current + FRAME_REQUEST_INTERVAL_MS - performance.now();
    if (wait > 0) {
      navigationTimer.current = window.setTimeout(() => { navigationTimer.current = null; flush(); }, wait);
      return;
    }
    // Never under an open link confirmation: the dialog stays about the page it came from.
    if (openLink.current || callbacks.current.onNavigate?.(pending.target, pending.focused) === false) return;
    pendingNavigation.current = null;
    lastNavigationAt.current = performance.now();
  }, []);
  // Another artifact, or leaving the viewer, forgets a waiting request.
  useEffect(() => () => {
    pendingNavigation.current = null;
    if (navigationTimer.current !== null) window.clearTimeout(navigationTimer.current);
    navigationTimer.current = null;
  }, [artifactId, publicToken]);

  useEffect(() => {
    let active = true;
    let session: Awaited<ReturnType<typeof artifactBrowserStorage.open>> | undefined;
    let storageEpoch = 0;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!active || event.origin !== "null" || !iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const link = parseArtifactOpenLinkMessage(event.data);
      if (link) {
        const now = performance.now();
        if (!openLink.current && now - lastLinkAt.current >= FRAME_REQUEST_INTERVAL_MS) {
          lastLinkAt.current = now; openLink.current = link; setHref(link);
          pendingNavigation.current = null;
        }
        return;
      }
      const download = parseArtifactDownloadMessage(event.data);
      if (download) {
        const now = performance.now();
        const decision = artifactDownloadDecision(download, now, window.document.activeElement === iframeRef.current);
        if (decision === "save") saveArtifactDownload(download);
        else if (!shownDownloadPrompt.current && now - lastDownloadPromptAt.current >= FRAME_REQUEST_INTERVAL_MS) {
          showDownloadPrompt(decision === "ask" ? { kind: "ask", request: download } : { kind: "too_large", name: download.name });
        }
        return;
      }
      const navigation = parseArtifactNavigateMessage(event.data);
      if (navigation) {
        // Never under an open link confirmation: the dialog stays about the page it came from.
        if (openLink.current) return;
        pendingNavigation.current = { target: navigation, focused: window.document.activeElement === iframeRef.current };
        flushNavigation();
        return;
      }
      const message = parseArtifactStorageMessage(event.data);
      if (message && session) {
        const epoch = storageEpoch;
        void session.apply(message).then(saved => { if (active && epoch === storageEpoch) setStorageUnavailable(!saved); });
        return;
      }
      const runtimeError = parseArtifactRuntimeError(event.data);
      if (runtimeError) callbacks.current.onRuntimeError?.(runtimeError);
      const input = event.data;
      if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 1 &&
        (input as { type?: unknown }).type === "aiqsa_artifact_escape" && window.document.activeElement === iframeRef.current) callbacks.current.onEscape?.();
    };
    const prepare = async () => {
      let key: string | null = null;
      try { key = publicToken !== undefined ? await publicArtifactStateKey(publicToken) : artifactId ? privateArtifactStateKey(artifactId) : null; }
      catch { /* A browser without Web Crypto uses only in-memory state. */ }
      if (!active) return;
      session = await artifactBrowserStorage.open(key, () => {
        if (!active) return;
        storageEpoch += 1;
        openLink.current = null; setHref(null);
        showDownloadPrompt(null);
        setStorageUnavailable(!session?.persistent);
        callbacks.current.onReset?.();
        setDocument(current => ({ body: injectArtifactStorageSnapshot(body, []), generation: (current?.generation ?? 0) + 1, source: body, revision, artifactId, publicToken, focus: false }));
      });
      if (!active) { session.close(); return; }
      setStorageUnavailable(!session.persistent);
      openLink.current = null; setHref(null);
      // A prompt belongs to the document that asked; the next one starts without it.
      showDownloadPrompt(null);
      // Every page of the artifact starts from the same saved state.
      const loaded = injectArtifactStorageSnapshot(body, session.snapshot());
      const focus = callbacks.current.focusOnLoad === true;
      setDocument(current => ({ body: loaded, generation: (current?.generation ?? 0) + 1, source: body, revision, artifactId, publicToken, focus }));
    };
    window.addEventListener("message", onMessage);
    void prepare();
    return () => { active = false; session?.close(); window.removeEventListener("message", onMessage); };
  }, [artifactId, body, flushNavigation, publicToken, revision, showDownloadPrompt]);

  useEffect(() => {
    if (document?.focus) iframeRef.current?.focus({ preventScroll: true });
    // The page that was loading has arrived: a request that waited for it goes now.
    if (document) flushNavigation();
  }, [document, flushNavigation]);

  if (!document || document.source !== body || document.revision !== revision || document.artifactId !== artifactId || document.publicToken !== publicToken) {
    return <div className="v2-artifact-empty" role="status">Loading preview…</div>;
  }
  return <>
    {storageUnavailable ? <div className="v2-artifact-banner" role="status">Saved state is unavailable in this browser. Changes will last only while this preview stays open.</div> : null}
    {downloadPrompt ? <div className="v2-artifact-banner" role="status" data-testid="artifact-download-prompt">
      {downloadPrompt.kind === "ask" ? <>
        <span>Save “{downloadPrompt.request.name}” ({formatAttachmentBytes(downloadPrompt.request.blob.size)}) from this artifact?</span>
        <UiV2Button onClick={() => { saveArtifactDownload(downloadPrompt.request); showDownloadPrompt(null); }} type="button">Save file</UiV2Button>
      </> : <span>“{downloadPrompt.name}” is too large to save from the preview. Files up to {formatAttachmentBytes(ARTIFACT_DOWNLOAD_LIMITS.maxBytes)} can be saved.</span>}
      <UiV2Button onClick={() => showDownloadPrompt(null)} type="button">Dismiss</UiV2Button>
    </div> : null}
    <iframe ref={iframeRef} aria-label={title} className="v2-artifact-frame" sandbox={ARTIFACT_VIEW_SANDBOX} allow={ARTIFACT_VIEW_ALLOW}
      key={document.generation} srcDoc={document.body} title={title} />
    {href ? <ArtifactExternalLinkDialog href={href} onClose={() => { openLink.current = null; setHref(null); }} /> : null}
  </>;
}
