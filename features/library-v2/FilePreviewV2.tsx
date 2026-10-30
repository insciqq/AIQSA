"use client";

import { Suspense, lazy, useEffect, useState, type ComponentType, type RefObject } from "react";
import type { PdfViewerProps } from "@/features/pdf-viewer-v2/PdfViewerV2";
import { ArtifactViewerFrameV2 } from "@/components/artifacts/ArtifactViewerFrameV2";
import { SourceCode } from "@/components/artifacts/ArtifactCodeV2";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { MarkdownPreviewBoundary } from "@/components/chat/MarkdownPreviewBoundary";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import { shellFetch } from "@/components/app-shell/shellApi";
import { fileExtension, fileTypeLabel } from "./filePresentation";
import type { FileSummaryV2 } from "./contracts";
import "@/components/ui-v2/markdown-editor.css";

const inertHref = () => "text" as const;

/** A chunk that cannot load (an old browser's parse error, a lost connection) is one more failure with Download. */
function PdfViewerUnavailable({ fileId }: Pick<PdfViewerProps, "fileId">) {
  return <div className="v2-file-preview-empty" role="alert">
    <p>The PDF couldn’t be loaded. Download the file instead.</p>
    <a className="v2-button v2-focusable" download href={attachmentDownloadHref(fileId)}>Download</a>
  </div>;
}

// pdf.js and its stylesheet load only when a PDF opens: this module is in the chat's initial chunks.
const PdfViewerV2 = lazy<ComponentType<PdfViewerProps>>(() => import("@/features/pdf-viewer-v2/PdfViewerV2")
  .then(module => ({ default: module.PdfViewerV2 }))
  .catch(() => ({ default: PdfViewerUnavailable })));

export function canPreviewFile(file: FileSummaryV2) {
  return file.status === "ready" && (file.previewKind === "image" || file.previewKind === "text" || file.previewKind === "pdf");
}

/** What the viewer needs: a file sent in a chat is known only by its thread block, so its size may be unknown. */
export type FilePreviewFileV2 = Pick<FileSummaryV2, "canOpenChat" | "id" | "name" | "previewKind" | "status"> &
  Readonly<{ byteSize: number | null }>;

export function FileTypeTileV2({ file, thumbnail = false }: { file: FilePreviewFileV2; thumbnail?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <span className="v2-resource-row-icon v2-file-type" aria-hidden="true">
    {thumbnail && !failed && file.previewKind === "image" && file.status === "ready"
      // eslint-disable-next-line @next/next/no-img-element -- Authenticated, bounded static thumbnail; no image optimizer.
      ? <img alt="" loading="lazy" decoding="async" src={`${attachmentDownloadHref(file.id)}?preview=thumb`} onError={() => setFailed(true)} />
      : fileExtension(file.name).slice(0, 4).toUpperCase() || <UiV2Icon name="file" />}
  </span>;
}

type Props = Readonly<{
  /** Offers Save to Files in the PDF viewer; a temporary chat's files have no such action. */
  canSave?: boolean;
  compact: boolean;
  file: FilePreviewFileV2;
  group: readonly FilePreviewFileV2[];
  saved: boolean;
  onClose(): void;
  onSelect(id: string): void;
  onOpen?(id: string): void;
  onUse?(id: string): void;
  useDisabled: boolean;
}>;

export function FilePreviewV2(props: Props) {
  return <ArtifactViewerFrameV2 compact={props.compact} expanded={false} host="library"
    label={`File preview: ${props.file.name}`} title={props.file.name} onClose={props.onClose}>
    {initialFocusRef => <FilePreviewPanel {...props} closeRef={initialFocusRef} />}
  </ArtifactViewerFrameV2>;
}

function FilePreviewPanel({ canSave = false, compact, file, group, saved, onClose, onSelect, onOpen, onUse, useDisabled, closeRef }:
  Props & { closeRef: RefObject<HTMLButtonElement | null> }) {
  const [chosenMode, setChosenMode] = useState<{ fileId: string; mode: "rendered" | "source" } | null>(null);
  const [failedRender, setFailedRender] = useState<string | null>(null);
  const mode = failedRender === file.id ? "source" : chosenMode?.fileId === file.id ? chosenMode.mode : "rendered";
  const markdown = file.previewKind === "text" && ["md", "markdown"].includes(fileExtension(file.name));
  const index = group.findIndex(candidate => candidate.id === file.id);
  const href = attachmentDownloadHref(file.id);
  useEffect(() => {
    // The shared modal restores its opener when changing back to a dock.
    // Keep focus in this preview through that transition as well as on entry.
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [closeRef, compact]);

  return <div className="v2-file-preview" data-testid="file-preview">
    <header className="v2-file-preview-header">
      <FileTypeTileV2 file={file} />
      <div className="v2-file-preview-heading">
        <h2 title={file.name}>{file.name}</h2>
        <p>{fileTypeLabel(file.name)}{file.byteSize === null ? null : ` · ${formatAttachmentBytes(file.byteSize)}`}</p>
      </div>
      <a aria-label={`Download ${file.name}`} className="v2-icon-button v2-focusable" download href={href}
        title={`Download ${file.name}`}><UiV2Icon name="download" /></a>
      <UiV2IconButton icon="close" label="Close preview" onClick={onClose} ref={closeRef} />
      {markdown ? <div className="v2-file-preview-modes v2-markdown-editor-modes" role="radiogroup" aria-label="Preview mode"
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || failedRender === file.id) return;
          event.preventDefault();
          const next = event.key === "Home" ? "rendered" : event.key === "End" ? "source" : mode === "rendered" ? "source" : "rendered";
          setChosenMode({ fileId: file.id, mode: next });
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-preview-mode='${next}']`)?.focus();
        }}>
        {(["rendered", "source"] as const).map(option => <button key={option} role="radio" type="button"
          aria-checked={mode === option} className="v2-focusable" data-preview-mode={option} tabIndex={mode === option ? 0 : -1}
          disabled={option === "rendered" && failedRender === file.id}
          onClick={() => setChosenMode({ fileId: file.id, mode: option })}>{option === "rendered" ? "Rendered" : "Source"}</button>)}
      </div> : null}
    </header>
    {group.length > 1 ? <div className="v2-file-preview-navigation">
      <span>{index + 1} of {group.length} {saved ? "in Saved" : "in this chat"}</span>
      <UiV2IconButton icon="arrow-left" label="Previous file" disabled={index < 1} onClick={() => onSelect(group[index - 1].id)} />
      <UiV2IconButton icon="chevron-right" label="Next file" disabled={index < 0 || index >= group.length - 1} onClick={() => onSelect(group[index + 1].id)} />
    </div> : null}
    {failedRender === file.id ? <p className="v2-file-preview-notice" role="status">Rendered view is unavailable for this file.</p> : null}
    <div className="v2-file-preview-body">
      {file.previewKind === "pdf" ? <Suspense fallback={<p className="v2-file-preview-empty" role="status">Loading preview…</p>}>
        <PdfViewerV2 byteSize={file.byteSize} canSave={canSave} fileId={file.id} fileName={file.name} key={file.id} />
      </Suspense> : <FilePreviewContent key={`${file.id}:${file.previewKind}`} file={file} rendered={markdown && mode === "rendered"}
        onRenderError={() => { setFailedRender(file.id); setChosenMode({ fileId: file.id, mode: "source" }); }} />}
    </div>
    {onUse || (onOpen && file.canOpenChat) ? <footer className="v2-file-preview-footer">
      {onUse ? <UiV2Button tone="primary" disabled={useDisabled} onClick={() => onUse(file.id)}>Use in chat</UiV2Button> : null}
      {onOpen && file.canOpenChat ? <UiV2Button icon="external" onClick={() => onOpen(file.id)}>Open chat</UiV2Button> : null}
    </footer> : null}
  </div>;
}

type Content = { kind: "loading" } | { kind: "error" } | { kind: "image"; url: string } | { kind: "text"; text: string };

function FilePreviewContent({ file, rendered, onRenderError }: {
  file: FilePreviewFileV2; rendered: boolean; onRenderError(): void;
}) {
  const [content, setContent] = useState<Content>({ kind: "loading" });
  const [imageLoaded, setImageLoaded] = useState(false);
  const href = attachmentDownloadHref(file.id);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const response = await shellFetch(`${href}?preview=${file.previewKind}`, {
        signal: controller.signal, cache: "no-store", credentials: "same-origin"
      });
      if (!response.ok) throw new Error("preview_unavailable");
      if (file.previewKind === "image") {
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setContent({ kind: "image", url: objectUrl });
      } else {
        const text = await response.text();
        if (!controller.signal.aborted) setContent({ kind: "text", text });
      }
    })().catch(() => { if (!controller.signal.aborted) setContent({ kind: "error" }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.previewKind, href]);

  if (content.kind === "loading") return <p className="v2-file-preview-empty" role="status">Loading preview…</p>;
  if (content.kind === "error") return <div className="v2-file-preview-empty" role="status">
    <p>Preview is unavailable. Download the file instead.</p>
    <a className="v2-button v2-focusable" download href={href}>Download</a>
  </div>;
  if (content.kind === "image") return <div className="v2-file-preview-image">
    {!imageLoaded ? <p role="status">Loading preview…</p> : null}
    {/* eslint-disable-next-line @next/next/no-img-element -- Validated original bytes in an owned object URL, revoked on exit. */}
    <img alt={file.name} src={content.url} onLoad={() => setImageLoaded(true)} onError={() => setContent({ kind: "error" })} />
  </div>;
  const source = <SourceCode file={{ path: file.name, mimeType: "text/plain", text: content.text }} />;
  return rendered ? <div className="v2-file-preview-markdown v2-focusable" tabIndex={0} aria-label="Rendered file">
    <MarkdownPreviewBoundary resetKey={file.id} fallback={source} onError={onRenderError}>
      <MarkdownMessage content={content.text} resolveHref={inertHref} />
    </MarkdownPreviewBoundary>
  </div> : <div className="v2-artifact-code-content">{source}</div>;
}
