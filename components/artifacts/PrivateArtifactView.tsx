"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import type { ArtifactNavigateMessage, ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import { ArtifactFrameV2 } from "./ArtifactFrameV2";
import { ArtifactPageBar } from "./ArtifactPageBar";
import { artifactPageSearch, artifactResponsePage, injectArtifactArrivalFragment, type ArtifactPageRequest } from "./artifactNavigation";

/** The page shown now (`page` as the server named it) and the request it answered. */
type Content = Readonly<{ body: string; contentType: string; page: string | null; runtimeError: ArtifactRuntimeError | null; serial: number; focus: boolean }>;
type Failure = Readonly<{ message: string; detail: string | null; request: ArtifactPageRequest }>;

class ContentRequestError extends Error {
  constructor(readonly status: number, readonly code: string | null) { super("artifact_content_unavailable"); }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const code = body && typeof body === "object" && "error" in body ? body.error : null;
    return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : null;
  } catch { return null; }
}

function describeFailure(error: unknown, request: ArtifactPageRequest): Failure {
  const away = request.page !== undefined;
  if (!(error instanceof ContentRequestError)) return { request, detail: null, message: away ? "Could not open this page." : "Could not load this artifact." };
  if (error.status === 404 && error.code === "artifact_page_not_found") return { request, detail: null, message: "This page is not part of this version." };
  if (error.status === 429) return { request, detail: null, message: "The preview is busy. Try again in a moment." };
  // A page that breaks the artifact rules names the rule, so its owner can ask to fix it.
  if (error.status === 400 && away && error.code?.startsWith("artifact_")) return { request, detail: error.code, message: "This page cannot be displayed." };
  return { request, detail: null, message: "This artifact is unavailable." };
}

export function PrivateArtifactView({ artifactId, versionId, onFix, onEscape, fixDisabled }: {
  artifactId: string;
  versionId: string;
  onFix?(error: ArtifactRuntimeError): void;
  onEscape?(): void;
  fixDisabled?: boolean;
}) {
  const [request, setRequest] = useState<ArtifactPageRequest>({ focus: false, serial: 0 });
  const [content, setContent] = useState<Content | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The entry page's path, as the server named it when it served the entry page. */
  const [entry, setEntry] = useState<string | null>(null);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const settled = content?.serial === request.serial || failure?.request.serial === request.serial;
  // One page request at a time: links that arrive while a page loads are ignored.
  const navigation = useRef({ settled, entry });
  useEffect(() => { navigation.current = { settled, entry }; }, [settled, entry]);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/content${artifactPageSearch(request.page)}`, {
          cache: "no-store", signal: controller.signal
        });
        if (!response.ok) throw new ContentRequestError(response.status, await errorCode(response));
        const contentType = response.headers.get("content-type") ?? "text/html";
        const page = artifactResponsePage(response);
        if (request.page !== undefined && page !== request.page) throw new Error("artifact_page_mismatch");
        let body: string;
        if (contentType.startsWith("image/")) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          body = objectUrl = URL.createObjectURL(blob);
        } else {
          body = injectArtifactArrivalFragment(await response.text(), request.fragment);
          if (controller.signal.aborted) return;
        }
        if (request.page === undefined) setEntry(page);
        setContent({ body, contentType, page, runtimeError: null, serial: request.serial, focus: request.focus });
        setFailure(null);
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        // A failed page replaces the preview: the way back never shows a stale page.
        setContent(null); setFailure(describeFailure(error, request));
      }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, versionId, request]);

  useEffect(() => { if (failure?.request.focus) recoveryRef.current?.focus(); }, [failure]);

  const open = (next: Omit<ArtifactPageRequest, "serial">) => setRequest(previous => ({ ...next, serial: previous.serial + 1 }));
  const navigate = (target: ArtifactNavigateMessage, focused: boolean) => {
    if (!navigation.current.settled) return;
    navigation.current = { ...navigation.current, settled: false };
    open({ ...(target.path === navigation.current.entry ? {} : { page: target.path }), ...(target.fragment ? { fragment: target.fragment } : {}), focus: focused });
  };
  const start = () => open({ focus: true });

  if (failure?.request.serial === request.serial) {
    const away = failure.request.page !== undefined;
    return <div className="v2-artifact-empty" role="alert">
      <p>{failure.message}{failure.detail ? <> <code>{failure.detail}</code></> : null}</p>
      {away ? <UiV2Button icon="arrow-left" onClick={start} ref={recoveryRef} type="button">Start page</UiV2Button> : null}
      <UiV2Button onClick={() => open({ ...failure.request, focus: false })} ref={away ? undefined : recoveryRef} type="button">Retry</UiV2Button>
    </div>;
  }
  if (!content) return <div className="v2-artifact-empty" role="status"><span className="v2-spinner" aria-hidden="true" />Loading preview…</div>;
  if (content.contentType.startsWith("image/")) return <div className="v2-artifact-scene"><img alt="Artifact preview" className="v2-artifact-image" src={content.body} /></div>;
  const shown = content.page !== null && content.page !== entry ? content.page : null;
  const bar = settled ? shown : request.page ?? shown;
  return <>
    {bar !== null ? <ArtifactPageBar busy={!settled} onStart={start} page={bar} /> : null}
    {content.runtimeError ? <div className="v2-artifact-banner" role="alert">
      <span className="v2-artifact-runtime-error">{content.runtimeError.kind === "csp" ? <>
        The artifact tried to use a blocked resource: <code title={`${content.runtimeError.directive} · ${content.runtimeError.blocked}`}>{content.runtimeError.directive} · {content.runtimeError.blocked}</code>
      </> : <>The artifact reported a runtime error: <code title={content.runtimeError.message}>{content.runtimeError.message}</code>
        <small> (line {content.runtimeError.line}, approximate)</small></>}</span>
      {onFix ? <UiV2Button disabled={fixDisabled} icon="edit" onClick={() => onFix(content.runtimeError!)} type="button">Fix with AI</UiV2Button> : null}
    </div> : null}
    <ArtifactFrameV2 artifactId={artifactId} body={content.body} focusOnLoad={content.focus} revision={content.serial} title="Artifact preview" onEscape={onEscape}
      onNavigate={navigate}
      onReset={() => setContent(previous => previous ? { ...previous, runtimeError: null } : previous)}
      onRuntimeError={runtimeError => setContent(previous => previous && !previous.runtimeError ? { ...previous, runtimeError } : previous)} />
  </>;
}
