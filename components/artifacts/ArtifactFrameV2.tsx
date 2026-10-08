"use client";

import { useEffect, useRef, useState } from "react";
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
import { ArtifactExternalLinkDialog } from "./ArtifactExternalLinkDialog";
import { artifactBrowserStorage, injectArtifactStorageSnapshot, privateArtifactStateKey, publicArtifactStateKey } from "./artifactBrowserStorage";

/** Messages that leave the frame (a confirmed link or another page) are accepted at most once per interval. */
const FRAME_REQUEST_INTERVAL_MS = 500;

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
  /** A link asks to show another page of the artifact; `focused` tells whether the frame had keyboard focus. */
  onNavigate?(target: ArtifactNavigateMessage, focused: boolean): void;
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
  // Kept for the life of this host, across the pages it shows: authored code can post
  // navigation itself, so a page that keeps sending it still waits between requests.
  const lastNavigationAt = useRef(-Infinity);
  useEffect(() => { callbacks.current = { onRuntimeError, onNavigate, onReset, onEscape, focusOnLoad }; }, [onRuntimeError, onNavigate, onReset, onEscape, focusOnLoad]);

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
        }
        return;
      }
      const navigation = parseArtifactNavigateMessage(event.data);
      if (navigation) {
        const now = performance.now();
        // Never under an open link confirmation: the dialog stays about the page it came from.
        if (!openLink.current && now - lastNavigationAt.current >= FRAME_REQUEST_INTERVAL_MS) {
          lastNavigationAt.current = now;
          callbacks.current.onNavigate?.(navigation, window.document.activeElement === iframeRef.current);
        }
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
        setStorageUnavailable(!session?.persistent);
        callbacks.current.onReset?.();
        setDocument(current => ({ body: injectArtifactStorageSnapshot(body, []), generation: (current?.generation ?? 0) + 1, source: body, revision, artifactId, publicToken, focus: false }));
      });
      if (!active) { session.close(); return; }
      setStorageUnavailable(!session.persistent);
      openLink.current = null; setHref(null);
      // Every page of the artifact starts from the same saved state.
      const loaded = injectArtifactStorageSnapshot(body, session.snapshot());
      const focus = callbacks.current.focusOnLoad === true;
      setDocument(current => ({ body: loaded, generation: (current?.generation ?? 0) + 1, source: body, revision, artifactId, publicToken, focus }));
    };
    window.addEventListener("message", onMessage);
    void prepare();
    return () => { active = false; session?.close(); window.removeEventListener("message", onMessage); };
  }, [artifactId, body, publicToken, revision]);

  useEffect(() => {
    if (document?.focus) iframeRef.current?.focus({ preventScroll: true });
  }, [document]);

  if (!document || document.source !== body || document.revision !== revision || document.artifactId !== artifactId || document.publicToken !== publicToken) {
    return <div className="v2-artifact-empty" role="status">Loading preview…</div>;
  }
  return <>
    {storageUnavailable ? <div className="v2-artifact-banner" role="status">Saved state is unavailable in this browser. Changes will last only while this preview stays open.</div> : null}
    <iframe ref={iframeRef} aria-label={title} className="v2-artifact-frame" sandbox={ARTIFACT_VIEW_SANDBOX} allow={ARTIFACT_VIEW_ALLOW}
      key={document.generation} srcDoc={document.body} title={title} />
    {href ? <ArtifactExternalLinkDialog href={href} onClose={() => { openLink.current = null; setHref(null); }} /> : null}
  </>;
}
