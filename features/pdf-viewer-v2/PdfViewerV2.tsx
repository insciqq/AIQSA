"use client";

import "pdfjs-dist/legacy/web/pdf_viewer.css";
import "./pdf-viewer.css";
import { useEffect, useRef, useState } from "react";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { ArtifactExternalLinkDialog } from "@/components/artifacts/ArtifactExternalLinkDialog";
import { UiV2IconButton } from "@/components/ui-v2";
import { SaveToFilesButtonV2 } from "@/features/attachments-v2/FileActionsMenuV2";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import { PDF_PREVIEW_MAX_BYTES } from "@/lib/domain/attachmentPreview";
import {
  PDF_VIEWER_MAX_PAGES,
  PDF_VIEWER_MAX_SCALE,
  PDF_VIEWER_MIN_SCALE,
  pdfViewerEnvironment
} from "./pdfViewerOptions";
import {
  startPdfViewerSession,
  type PdfFindStatus,
  type PdfViewerFailure,
  type PdfViewerSession,
  type PdfViewerUpdate
} from "./pdfViewerSession";

const failureCopy: Readonly<Record<PdfViewerFailure, string>> = {
  damaged: "This PDF is damaged and can’t be shown here. Download the file instead.",
  failed: "The PDF couldn’t be loaded. Download the file instead.",
  password: "This PDF is password-protected and can’t be shown here. Download the file instead.",
  timeout: "This PDF took too long to open. Download the file instead.",
  too_large: `This PDF is larger than ${formatAttachmentBytes(PDF_PREVIEW_MAX_BYTES)} and can’t be shown here. Download the file instead.`,
  too_many_pages: `This PDF has more than ${PDF_VIEWER_MAX_PAGES.toLocaleString("en-US")} pages and can’t be shown here. Download the file instead.`,
  unavailable: "This file is unavailable."
};

export type PdfViewerProps = Readonly<{ canSave: boolean; fileId: string; fileName: string; byteSize: number | null }>;

type ViewerState = Readonly<{
  find: PdfFindStatus | null;
  page: number;
  pageCount: number;
  scale: number;
  status: "loading" | "ready" | Readonly<{ failure: PdfViewerFailure }>;
}>;

const initialState: ViewerState = { find: null, page: 1, pageCount: 0, scale: 1, status: "loading" };

function findCopy(find: PdfFindStatus | null, query: string): string {
  if (!query || !find) return "";
  if (find.total > 0) return `${find.current} of ${find.total}`;
  return find.pending ? "Searching…" : "No matches";
}

/** The pages of one PDF, inside the existing viewer frame. It is lazily loaded with its stylesheet. */
export function PdfViewerV2({ byteSize, canSave, fileId, fileName }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PdfViewerSession | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ViewerState>(initialState);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [externalHref, setExternalHref] = useState<string | null>(null);
  const href = attachmentDownloadHref(fileId);

  useEffect(() => {
    const container = containerRef.current;
    const pages = pagesRef.current;
    if (!container || !pages) return;
    const session = startPdfViewerSession({
      byteSize,
      container,
      environment: pdfViewerEnvironment({
        coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
        maxTouchPoints: navigator.maxTouchPoints,
        userAgent: navigator.userAgent
      }),
      href,
      onExternalLink: setExternalHref,
      onUpdate: (update: PdfViewerUpdate) => setState(current => ({ ...current, ...update })),
      pages
    });
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.close();
    };
  }, [byteSize, href]);

  const ready = state.status === "ready";
  const failure = typeof state.status === "object" ? state.status.failure : null;

  useEffect(() => {
    if (!ready || externalHref) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [externalHref, ready]);

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
    setState(current => ({ ...current, find: null }));
    sessionRef.current?.findClosed();
    requestAnimationFrame(() => searchToggleRef.current?.focus());
  }

  function toggleSearch() {
    if (searchOpen) closeSearch();
    else {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }

  if (failure) {
    return <div className="v2-file-preview-empty" role="alert" data-pdf-failure={failure}>
      <p>{failureCopy[failure]}</p>
      {failure === "unavailable" ? null : <a className="v2-button v2-focusable" download href={href}>Download</a>}
    </div>;
  }

  const percent = `${Math.round(state.scale * 100)}%`;
  const hasMatches = (state.find?.total ?? 0) > 0;
  return <div className="v2-pdf-viewer" data-testid="pdf-viewer">
    <div aria-label="PDF controls" className="v2-pdf-toolbar" role="toolbar">
      <span className="v2-pdf-page-count" data-testid="pdf-page-indicator">
        {state.pageCount > 0 ? `${state.page} / ${state.pageCount}` : null}
      </span>
      <UiV2IconButton disabled={!ready || state.scale <= PDF_VIEWER_MIN_SCALE} icon="minus" label="Zoom out"
        onClick={() => sessionRef.current?.zoom("out")} />
      <button aria-label={`Fit page, now ${percent}`} className="v2-pdf-zoom-value v2-focusable" disabled={!ready}
        onClick={() => sessionRef.current?.resetZoom()} title="Fit page" type="button">{percent}</button>
      <UiV2IconButton disabled={!ready || state.scale >= PDF_VIEWER_MAX_SCALE} icon="plus" label="Zoom in"
        onClick={() => sessionRef.current?.zoom("in")} />
      <UiV2IconButton aria-expanded={searchOpen} disabled={!ready} icon="search" label="Search in document"
        onClick={toggleSearch} ref={searchToggleRef} />
      {canSave ? <SaveToFilesButtonV2 attachmentId={fileId} iconOnly /> : null}
    </div>
    {searchOpen ? <div className="v2-pdf-search">
      <input aria-label="Search text" autoComplete="off" className="v2-focusable" enterKeyHint="search" onChange={event => {
        setQuery(event.target.value);
        sessionRef.current?.find(event.target.value);
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          // The search closes first; the next Escape closes the viewer.
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        } else if (event.key === "Enter" && query) {
          event.preventDefault();
          sessionRef.current?.find(query, { again: true, previous: event.shiftKey });
        }
      }} placeholder="Search in document" ref={searchInputRef} type="search" value={query} />
      <span aria-live="polite" className="v2-pdf-search-count" data-testid="pdf-search-count">{findCopy(state.find, query)}</span>
      <UiV2IconButton disabled={!hasMatches} icon="arrow-up" label="Previous match"
        onClick={() => sessionRef.current?.find(query, { again: true, previous: true })} />
      <UiV2IconButton disabled={!hasMatches} icon="arrow-down" label="Next match"
        onClick={() => sessionRef.current?.find(query, { again: true })} />
      <UiV2IconButton icon="close" label="Close search" onClick={closeSearch} />
    </div> : null}
    <div className="v2-pdf-stage">
      {/* pdf.js requires an absolutely positioned scroller and throws without it, so this does not wait for the stylesheet. */}
      <div aria-label={`Pages of ${fileName}`} className="v2-pdf-scroller v2-focusable" ref={containerRef} role="region"
        style={{ inset: 0, overflow: "auto", position: "absolute" }} tabIndex={0}>
        <div className="pdfViewer" ref={pagesRef} />
      </div>
      {state.status === "loading" ? <p className="v2-pdf-loading" role="status">Loading preview…</p> : null}
    </div>
    {externalHref ? <ArtifactExternalLinkDialog description="This link is in the PDF. AIQSA doesn’t control the destination."
      href={externalHref} onClose={() => setExternalHref(null)} /> : null}
  </div>;
}
