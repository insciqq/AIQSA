"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { artifactButtonClass } from "./artifactClient";

type State = { body: string; contentType: string; runtimeError: boolean } | { error: string } | { loading: true };

export function PrivateArtifactView({ artifactId, versionId, onFix, fixDisabled }: { artifactId: string; versionId: string; onFix?(): void; fixDisabled?: boolean }) {
  const [state, setState] = useState<State>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/content`, {
          cache: "no-store", signal: controller.signal
        });
        if (!response.ok) throw new Error("artifact_unavailable");
        const contentType = response.headers.get("content-type") ?? "text/html";
        if (contentType.startsWith("image/")) {
          const blob = await response.blob();
          if (!active || controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ body: objectUrl, contentType, runtimeError: false });
        } else {
          const body = await response.text();
          if (!active || controller.signal.aborted) return;
          setState({ body, contentType, runtimeError: false });
        }
      } catch (error: unknown) {
        if (!active || controller.signal.aborted) return;
        setState({ error: error instanceof Error && error.message === "artifact_unavailable" ? "This artifact is unavailable." : "Could not load this artifact." });
      }
    })();
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, versionId, attempt]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== "null" || event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const message = data as { code?: unknown; type?: unknown };
      if (message.type === "aiqsa_artifact_runtime_error" && message.code === "runtime_error") {
        setState((current) => "body" in current ? { ...current, runtimeError: true } : current);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if ("loading" in state) return <p className="p-6 text-sm text-ink-secondary">Loading artifact…</p>;
  if ("error" in state) return <div className="flex flex-wrap items-center gap-3 p-6 text-sm text-ink-secondary" role="alert"><p>{state.error}</p><button className={artifactButtonClass} onClick={() => { setState({ loading: true }); setAttempt(value => value + 1); }} type="button">Retry preview</button></div>;
  const image = state.contentType.startsWith("image/");
  return image
    ? <img alt="Artifact preview" className="mx-auto block max-h-[calc(100dvh-8rem)] max-w-full object-contain" src={state.body} />
    : <div className="space-y-3">
        {state.runtimeError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-trace-subtle px-3 py-2 text-sm text-ink" role="alert">
            <span>The artifact reported a runtime error.</span>
            {onFix ? <button className="v2-focusable min-h-10 rounded-md border border-current px-3 py-1.5 text-xs font-medium disabled:opacity-50" disabled={fixDisabled} onClick={onFix} type="button">Fix with AI</button> : null}
          </div>
        ) : null}
        <iframe ref={iframeRef} aria-label="Artifact preview" className="h-[65dvh] min-h-[18rem] w-full border-0" sandbox="allow-scripts" srcDoc={state.body} title="Artifact preview" />
      </div>;
}
