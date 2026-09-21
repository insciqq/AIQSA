"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { highlightCodeBlock } from "@/components/chat/codeHighlighting";
import { artifactRequest } from "./artifactClient";

type SourceFile = Readonly<{ path: string; mimeType: string; text?: string; binary?: true; group?: "authored" | "vendored"; byteSize?: number }>;
const MAX_HIGHLIGHT_CHARACTERS = 100_000;
const MAX_VENDOR_HIGHLIGHT_BYTES = 256 * 1024;

function sourceLanguage(file: SourceFile): string {
  const extension = file.path.split(".").at(-1)?.toLowerCase();
  if (extension && ["html", "css", "js", "ts", "tsx", "json"].includes(extension)) return extension;
  return file.mimeType === "image/svg+xml" ? "html" : file.mimeType.split("/")[1] ?? "";
}

function SourceCode({ file }: { file: SourceFile }) {
  const text = file.text ?? "";
  const largeVendor = file.group === "vendored" && Math.max(file.byteSize ?? 0, new TextEncoder().encode(text).byteLength) > MAX_VENDOR_HIGHLIGHT_BYTES;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (!largeVendor && text.length <= MAX_HIGHLIGHT_CHARACTERS) {
      void highlightCodeBlock(text, sourceLanguage(file)).then(result => {
        if (active && result) setHighlighted(result.html);
      });
    }
    return () => { active = false; mounted.current = false; };
  }, [file, largeVendor, text]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setCopyState("copied");
    } catch {
      if (mounted.current) setCopyState("failed");
    }
  }
  return <>
    <div className="v2-artifact-code-actions">
      <span>{file.path}</span>
      {copyState === "failed" ? <span role="status">Select the code and copy it manually.</span> : null}
      <UiV2Button icon={copyState === "copied" ? "check" : "copy"} onClick={() => void copy()} type="button">{copyState === "copied" ? "Copied" : "Copy"}</UiV2Button>
    </div>
    <div aria-label={file.path} className="v2-artifact-code-scroll v2-focusable" tabIndex={0}>
      {largeVendor ? <pre><code>{text}</code></pre> : highlighted ? <div className="v2-artifact-code-highlight" dangerouslySetInnerHTML={{ __html: highlighted }} /> :
        <pre><code>{text.split("\n").map((line, index, lines) => <Fragment key={index}><span className="line">{line}</span>{index < lines.length - 1 ? "\n" : ""}</Fragment>)}</code></pre>}
    </div>
  </>;
}

export function ArtifactCodeV2({ artifactId, versionId }: { artifactId: string; versionId: string }) {
  const [files, setFiles] = useState<readonly SourceFile[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const tabsId = useId();
  useEffect(() => {
    const controller = new AbortController();
    void artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/source`, { signal: controller.signal })
      .then((body) => {
        if (!Array.isArray(body.files) || body.versionId !== versionId || body.files.some((file) => !file || typeof file.path !== "string" || typeof file.mimeType !== "string" ||
          (typeof file.text !== "string" && file.binary !== true) || file.group !== undefined && !["authored", "vendored"].includes(file.group) ||
          file.byteSize !== undefined && (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0))) throw new Error("The code could not be read.");
        if (!controller.signal.aborted) setFiles(body.files as SourceFile[]);
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The code could not be loaded."); });
    return () => controller.abort();
  }, [artifactId, versionId, attempt]);
  if (error) return <div role="alert" className="v2-artifact-empty"><p>{error}</p><UiV2Button onClick={() => { setError(null); setAttempt(value => value + 1); }} type="button">Retry</UiV2Button></div>;
  if (!files) return <div role="status" className="v2-artifact-empty"><span className="v2-spinner" aria-hidden="true" />Loading code…</div>;
  if (files.length === 0) return <div className="v2-artifact-empty">This version has no files.</div>;
  const orderedFiles = [...files.filter(file => file.group !== "vendored"), ...files.filter(file => file.group === "vendored")];
  const file = orderedFiles[selected] ?? orderedFiles[0]!;
  const vendorStart = orderedFiles.findIndex(file => file.group === "vendored");
  return <div className="v2-artifact-code">
    <div aria-label="Artifact files" className="v2-artifact-files" role="tablist" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? orderedFiles.length - 1 : (selected + (event.key === "ArrowRight" ? 1 : -1) + orderedFiles.length) % orderedFiles.length;
      setSelected(next);
      document.getElementById(`${tabsId}-file-${next}`)?.focus();
    }}>
      {orderedFiles.map((item, index) => <Fragment key={item.path}>
        {vendorStart >= 0 && (index === 0 || index === vendorStart) ? <span className="v2-artifact-file-group" role="presentation">{item.group === "vendored" ? "Vendored" : "Authored"}</span> : null}
        <button aria-controls={`${tabsId}-source`} aria-selected={selected === index} className="v2-artifact-file v2-focusable" id={`${tabsId}-file-${index}`} onClick={() => setSelected(index)} role="tab" tabIndex={selected === index ? 0 : -1} type="button">{item.path}</button>
      </Fragment>)}
    </div>
    <div aria-labelledby={`${tabsId}-file-${selected}`} className="v2-artifact-code-content" id={`${tabsId}-source`} role="tabpanel">
      {file.text !== undefined ? <SourceCode file={file} key={file.path} /> : <div className="v2-artifact-empty">{file.group === "vendored" ? "This resource is bundled with the artifact. Download the ZIP to save it." : "This image is part of the artifact. Download the ZIP to save the original."}</div>}
    </div>
  </div>;
}
