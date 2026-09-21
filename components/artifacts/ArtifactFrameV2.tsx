"use client";

import { useEffect, useRef, useState } from "react";
import {
  ARTIFACT_VIEW_ALLOW,
  ARTIFACT_VIEW_SANDBOX,
  parseArtifactOpenLinkMessage,
  parseArtifactRuntimeError,
  parseArtifactStorageMessage,
  type ArtifactRuntimeError
} from "@/lib/contracts/artifactRuntime";
import { ArtifactExternalLinkDialog } from "./ArtifactExternalLinkDialog";
import { artifactBrowserStorage, injectArtifactStorageSnapshot, privateArtifactStateKey, publicArtifactStateKey } from "./artifactBrowserStorage";

type Props = {
  body: string;
  title: string;
  artifactId?: string;
  publicToken?: string;
  onRuntimeError?(error: ArtifactRuntimeError): void;
  onReset?(): void;
  onEscape?(): void;
};

/** The same iframe host protects private and anonymous views. Thumbnails never use it. */
export function ArtifactFrameV2({ body, title, artifactId, publicToken, onRuntimeError, onReset, onEscape }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onRuntimeError, onReset, onEscape });
  const [document, setDocument] = useState<{ body: string; generation: number; source: string; artifactId?: string; publicToken?: string } | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [href, setHref] = useState<string | null>(null);
  const openLink = useRef<string | null>(null);
  const lastLinkAt = useRef(-Infinity);
  useEffect(() => { callbacks.current = { onRuntimeError, onReset, onEscape }; }, [onRuntimeError, onReset, onEscape]);

  useEffect(() => {
    let active = true;
    let session: Awaited<ReturnType<typeof artifactBrowserStorage.open>> | undefined;
    let storageEpoch = 0;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!active || event.origin !== "null" || !iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const link = parseArtifactOpenLinkMessage(event.data);
      if (link) {
        const now = performance.now();
        if (!openLink.current && now - lastLinkAt.current >= 500) {
          lastLinkAt.current = now; openLink.current = link; setHref(link);
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
        setDocument(current => ({ body: injectArtifactStorageSnapshot(body, []), generation: (current?.generation ?? 0) + 1, source: body, artifactId, publicToken }));
      });
      if (!active) { session.close(); return; }
      setStorageUnavailable(!session.persistent);
      openLink.current = null; setHref(null);
      setDocument({ body: injectArtifactStorageSnapshot(body, session.snapshot()), generation: 0, source: body, artifactId, publicToken });
    };
    window.addEventListener("message", onMessage);
    void prepare();
    return () => { active = false; session?.close(); window.removeEventListener("message", onMessage); };
  }, [artifactId, body, publicToken]);

  if (!document || document.source !== body || document.artifactId !== artifactId || document.publicToken !== publicToken) return <div className="v2-artifact-empty" role="status">Loading preview…</div>;
  return <>
    {storageUnavailable ? <div className="v2-artifact-banner" role="status">Saved state is unavailable in this browser. Changes will last only while this preview stays open.</div> : null}
    <iframe ref={iframeRef} aria-label={title} className="v2-artifact-frame" sandbox={ARTIFACT_VIEW_SANDBOX} allow={ARTIFACT_VIEW_ALLOW}
      key={document.generation} srcDoc={document.body} title={title} />
    {href ? <ArtifactExternalLinkDialog href={href} onClose={() => { openLink.current = null; setHref(null); }} /> : null}
  </>;
}
