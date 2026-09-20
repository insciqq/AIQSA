"use client";
import { useEffect, useState } from "react";
import { artifactButtonClass, artifactRequest } from "./artifactClient";

type SourceFile = { path: string; mimeType: string; text?: string; binary?: true };
export function ArtifactSource({ artifactId, versionId }: { artifactId: string; versionId: string }) {
  const [files, setFiles] = useState<SourceFile[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/source`, { signal: controller.signal })
      .then((body) => {
        if (!Array.isArray(body.files) || body.versionId !== versionId || body.files.some((file) => !file || typeof file.path !== "string" || typeof file.mimeType !== "string" || (typeof file.text !== "string" && file.binary !== true))) throw new Error("The source could not be read.");
        if (!controller.signal.aborted) setFiles(body.files as SourceFile[]);
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The source could not be loaded."); });
    return () => controller.abort();
  }, [artifactId, versionId, attempt]);
  if (error) return <div role="alert" className="flex flex-wrap items-center gap-3 p-4 text-sm text-ink-secondary"><p>{error}</p><button className={artifactButtonClass} onClick={() => { setError(null); setAttempt(value => value + 1); }} type="button">Retry source</button></div>;
  if (!files) return <p role="status" className="p-4 text-sm text-ink-secondary">Loading source…</p>;
  const file = files[selected];
  return <div className="min-w-0 space-y-3">
    <label className="flex flex-wrap items-center gap-3 text-sm text-ink-secondary">Source file<select className="min-h-10 max-w-full rounded-md border border-trace-subtle bg-answer-paper px-2 text-ink" value={selected} onChange={(event) => setSelected(Number(event.target.value))}>{files.map((item, index) => <option key={item.path} value={index}>{item.path}</option>)}</select><span>Read only · {file?.mimeType}</span></label>
    {file?.text !== undefined ? <pre tabIndex={0} aria-label={file.path} className="max-h-[65dvh] overflow-auto rounded-md border border-trace-subtle bg-workspace-rail p-4 text-xs text-ink"><code>{file.text}</code></pre> : <p className="p-4 text-sm text-ink-secondary">This image is included in the artifact. Download the ZIP to save the original asset.</p>}
  </div>;
}
