"use client";

import { UiV2Button } from "@/components/ui-v2";

/** Away from the start page of a multi-page artifact: which page is shown, and the way back. */
export function ArtifactPageBar({ busy, onStart, page }: { busy: boolean; onStart(): void; page: string }) {
  return <nav aria-busy={busy || undefined} aria-label="Artifact page" className="v2-artifact-page-bar">
    <UiV2Button disabled={busy} icon="arrow-left" onClick={onStart} type="button">Start page</UiV2Button>
    <span className="v2-artifact-page-name" title={page}>{page}</span>
    {busy ? <span className="v2-artifact-page-status" role="status"><span aria-hidden="true" className="v2-spinner" />Opening…</span> : null}
  </nav>;
}
