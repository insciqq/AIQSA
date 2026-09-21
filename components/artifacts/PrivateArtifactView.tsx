"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import type { ArtifactRuntimeError } from "@/lib/contracts/artifactRuntime";
import { ArtifactFrameV2 } from "./ArtifactFrameV2";

type State = { body: string; contentType: string; runtimeError: ArtifactRuntimeError | null } | { error: string } | { loading: true };

export function PrivateArtifactView({ artifactId, versionId, onFix, onEscape, fixDisabled }: {
  artifactId: string;
  versionId: string;
  onFix?(error: ArtifactRuntimeError): void;
  onEscape?(): void;
  fixDisabled?: boolean;
}) {
  const [state, setState] = useState<State>({ loading: true });
  const [attempt, setAttempt] = useState(0);
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
          setState({ body: objectUrl, contentType, runtimeError: null });
        } else {
          const body = await response.text();
          if (!active || controller.signal.aborted) return;
          setState({ body, contentType, runtimeError: null });
        }
      } catch (error: unknown) {
        if (!active || controller.signal.aborted) return;
        setState({ error: error instanceof Error && error.message === "artifact_unavailable" ? "This artifact is unavailable." : "Could not load this artifact." });
      }
    })();
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, versionId, attempt]);

  if ("loading" in state) return <div className="v2-artifact-empty" role="status"><span className="v2-spinner" aria-hidden="true" />Loading preview…</div>;
  if ("error" in state) return <div className="v2-artifact-empty" role="alert"><p>{state.error}</p><UiV2Button onClick={() => { setState({ loading: true }); setAttempt(value => value + 1); }} type="button">Retry</UiV2Button></div>;
  return state.contentType.startsWith("image/")
    ? <div className="v2-artifact-scene"><img alt="Artifact preview" className="v2-artifact-image" src={state.body} /></div>
    : <>
        {state.runtimeError ? <div className="v2-artifact-banner" role="alert">
          <span className="v2-artifact-runtime-error">{state.runtimeError.kind === "csp" ? <>
            The artifact tried to use a blocked resource: <code title={`${state.runtimeError.directive} · ${state.runtimeError.blocked}`}>{state.runtimeError.directive} · {state.runtimeError.blocked}</code>
          </> : <>The artifact reported a runtime error: <code title={state.runtimeError.message}>{state.runtimeError.message}</code>
            <small> (line {state.runtimeError.line}, approximate)</small></>}</span>
          {onFix ? <UiV2Button disabled={fixDisabled} icon="edit" onClick={() => onFix(state.runtimeError!)} type="button">Fix with AI</UiV2Button> : null}
        </div> : null}
        <ArtifactFrameV2 artifactId={artifactId} body={state.body} title="Artifact preview" onEscape={onEscape}
          onReset={() => setState(current => "body" in current ? { ...current, runtimeError: null } : current)}
          onRuntimeError={runtimeError => setState(current => "body" in current && !current.runtimeError ? { ...current, runtimeError } : current)} />
      </>;
}
