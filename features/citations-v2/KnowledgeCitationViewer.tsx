"use client";

import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type { ThreadKnowledgeCitation } from "@/lib/contracts/chats";
import type {
  KnowledgeCitationViewer,
  KnowledgeSourceViewer,
  KnowledgeViewerAvailable,
  KnowledgeViewerBlock,
  KnowledgeViewerSourceStatus,
  KnowledgeViewerTable,
  KnowledgeViewerWorkbook,
  KnowledgeViewerWorkbookRange
} from "@/lib/contracts/knowledgeCitations";
import { ExternalLink, FileSearch, LoaderCircle, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import {
  knowledgeCitationOriginalUrl,
  knowledgeCitationPageUrl,
  knowledgeSourceOriginalUrl,
  knowledgeSourcePageUrl,
  loadKnowledgeCitationLibraryTarget,
  loadKnowledgeCitationViewer,
  loadKnowledgeSourceViewer,
  type KnowledgeCitationReference
} from "./knowledgeCitationApi";

type ViewerRequest =
  | Readonly<{ kind: "citation"; reference: KnowledgeCitationReference }>
  | Readonly<{ kind: "source"; sourceId: string }>;

type LoadedViewer = Readonly<{
  highlighted: boolean;
  originalUrl: string | null;
  pageUrl: string | null;
  value: KnowledgeCitationViewer | KnowledgeSourceViewer;
}>;

type ViewerLoadState = Readonly<{
  key: string;
  loaded: LoadedViewer | null;
  request: ViewerRequest;
  status: "error" | "loading" | "ready";
}>;

type PreviewState = ViewerLoadState & Readonly<{
  position: Readonly<{ left: number; top: number }>;
}>;

type KnowledgeViewerContextValue = Readonly<{
  activePreviewKey: string | null;
  dismissPreview(key: string): void;
  openCitation(reference: KnowledgeCitationReference, trigger: HTMLElement): void;
  openSource(sourceId: string, trigger: HTMLElement): void;
  previewCitation(reference: KnowledgeCitationReference, trigger: HTMLElement): void;
}>;

const KnowledgeViewerContext = createContext<KnowledgeViewerContextValue | null>(null);

function requestKey(request: ViewerRequest): string {
  return request.kind === "citation"
    ? `citation:${request.reference.runId}:${request.reference.messageId}:${request.reference.handle}`
    : `source:${request.sourceId}`;
}

async function loadRequest(request: ViewerRequest, signal: AbortSignal): Promise<LoadedViewer> {
  if (request.kind === "citation") {
    const value = await loadKnowledgeCitationViewer(request.reference, signal);
    return {
      highlighted: value.state === "available" && value.locator.boundingBoxes.some((box) =>
        box.page === value.locator.pageStart
      ),
      originalUrl: value.state === "available" && value.originalKind !== null
        ? knowledgeCitationOriginalUrl(request.reference)
        : null,
      pageUrl: value.state === "available" && value.originalKind === "pdf"
        ? knowledgeCitationPageUrl(request.reference)
        : null,
      value
    };
  }
  const value = await loadKnowledgeSourceViewer(request.sourceId, signal);
  return {
    highlighted: false,
    originalUrl: value.originalKind !== null ? knowledgeSourceOriginalUrl(request.sourceId) : null,
    pageUrl: value.originalKind === "pdf"
      ? knowledgeSourcePageUrl(request.sourceId, value.locator.pageStart)
      : null,
    value
  };
}

function previewPosition(trigger: HTMLElement): { left: number; top: number } {
  const bounds = trigger.getBoundingClientRect();
  const width = Math.min(340, Math.max(240, window.innerWidth - 24));
  const height = 190;
  const left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12));
  const top = bounds.bottom + 8 + height <= window.innerHeight
    ? bounds.bottom + 8
    : Math.max(12, bounds.top - height - 8);
  return { left, top };
}

function sourceStatusText(status: KnowledgeViewerSourceStatus): string {
  if (status === "earlier_version") return "Earlier accepted version";
  if (status === "removed") return "Removed from this base after the answer";
  return "In Trash · excluded from future chats";
}

function pageLabel(pageStart: number, pageEnd: number): string {
  return pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}–${pageEnd}`;
}

function PreviewCard({ state }: Readonly<{ state: PreviewState }>) {
  const style: CSSProperties = { left: state.position.left, top: state.position.top };
  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <span className="flex items-center gap-2 text-ink-secondary">
        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Checking current access…
      </span>
    );
  } else if (state.status === "error" || !state.loaded) {
    body = <span className="text-ink-secondary">This document is unavailable.</span>;
  } else if (state.loaded.value.state === "deleted") {
    body = (
      <span className="text-ink-secondary">
        Deleted Knowledge document · citation evidence removed.
      </span>
    );
  } else {
    const value = state.loaded.value;
    body = (
      <>
        <span className="block truncate font-semibold text-ink">{value.source.name}</span>
        <span className="mt-0.5 block text-[11px] text-ink-muted">
          {value.source.baseName ?? "Individual document"} · {pageLabel(value.locator.pageStart, value.locator.pageEnd)}
        </span>
        {value.source.statuses.length > 0 ? (
          <span className="mt-1 line-clamp-2 block text-attention">
            {value.source.statuses.map(sourceStatusText).join(" · ")}
          </span>
        ) : null}
        <span className="mt-2 line-clamp-3 block text-ink-secondary">{value.excerpt}</span>
      </>
    );
  }
  return (
    <div
      className="pointer-events-none fixed z-[80] w-[min(21.25rem,calc(100vw-1.5rem))] rounded-control border border-trace-strong bg-answer-paper px-3 py-2.5 text-xs leading-5 text-ink shadow-xl"
      id="knowledge-citation-preview"
      role="tooltip"
      style={style}
    >
      {body}
    </div>
  );
}

function TableBlock({ table }: Readonly<{ table: KnowledgeViewerTable }>) {
  const rows = Array.from({ length: table.rowCount }, (_value, row) =>
    table.cells.filter((cell) => cell.row === row).sort((left, right) => left.column - right.column)
  ).filter((row) => row.length > 0);
  return (
    <div className="mt-2 max-w-full overflow-x-auto rounded-control border border-trace-subtle">
      <table className="min-w-full border-collapse text-left text-xs">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr className="border-b border-trace-subtle last:border-b-0" key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  className="border-r border-trace-subtle px-2 py-1.5 align-top last:border-r-0"
                  colSpan={cell.columnSpan}
                  key={`${cell.column}:${cellIndex}`}
                  rowSpan={cell.rowSpan}
                >
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated ? (
        <p className="border-t border-trace-subtle px-2 py-1.5 text-[11px] text-ink-muted">
          Large table preview is bounded to the cited range.
        </p>
      ) : null}
    </div>
  );
}

function NormalizedPassage({ blocks }: Readonly<{ blocks: readonly KnowledgeViewerBlock[] }>) {
  if (blocks.length === 0) {
    return (
      <p className="text-xs leading-5 text-ink-muted">
        The exact accepted excerpt is available above; surrounding normalized blocks are unavailable.
      </p>
    );
  }
  return (
    <div className="space-y-0" data-testid="knowledge-normalized-passage">
      {blocks.map((block, index) => (
        <section
          className={block.relation === "target"
            ? "border-l-2 border-proof bg-proof/[0.045] px-3 py-2.5 text-ink"
            : "border-l-2 border-transparent px-3 py-2 text-ink-secondary"}
          data-citation-target={block.relation === "target" || undefined}
          key={`${block.pageStart}:${block.type}:${index}`}
        >
          <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
            {block.text || (block.type === "image" ? "Image region" : "")}
          </p>
          {block.table ? <TableBlock table={block.table} /> : null}
        </section>
      ))}
    </div>
  );
}

function workbookValue(value: boolean | number | string | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function columnLabel(column: number): string {
  let value = column + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function rangeRole(role: KnowledgeViewerWorkbookRange["role"]): string {
  if (role === "group") return "Group";
  if (role === "join") return "Join key";
  if (role === "sort") return "Sort";
  if (role === "filter") return "Filter";
  if (role === "value") return "Calculated value";
  return "Read";
}

function WorkbookRangeGrid({ range }: Readonly<{ range: KnowledgeViewerWorkbookRange }>) {
  const rows = [...new Set(range.cells.map((cell) => cell.row))].sort((left, right) => left - right);
  const columns = [...new Set(range.cells.map((cell) => cell.column))]
    .sort((left, right) => left - right);
  const cells = new Map(range.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  return (
    <section className="border-t border-trace-subtle first:border-t-0" data-testid="knowledge-workbook-range">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-ink">{range.sheet}</span>
          <span className="font-mono text-[11px] text-proof">{range.range}</span>
        </div>
        <span className="rounded-full border border-trace-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-ink-muted">
          {rangeRole(range.role)}
        </span>
      </div>
      {range.cells.length > 0 ? (
        <div className="overflow-x-auto border-t border-trace-subtle">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-app-canvas text-[10px] font-medium text-ink-muted">
              <tr>
                <th className="w-10 border-r border-trace-subtle px-2 py-1.5" scope="col">#</th>
                {columns.map((column) => (
                  <th className="border-r border-trace-subtle px-2 py-1.5 last:border-r-0" key={column} scope="col">
                    {columnLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-t border-trace-subtle" key={row}>
                  <th className="border-r border-trace-subtle bg-app-canvas px-2 py-1.5 font-mono text-[10px] font-normal text-ink-muted" scope="row">
                    {row + 1}
                  </th>
                  {columns.map((column) => {
                    const cell = cells.get(`${row}:${column}`);
                    return (
                      <td
                        className="min-w-28 border-r border-trace-subtle bg-proof/[0.045] px-2 py-1.5 align-top text-ink last:border-r-0"
                        key={column}
                      >
                        <span className="break-words [overflow-wrap:anywhere]">{cell?.display || "—"}</span>
                        {cell?.formula ? (
                          <span className="mt-0.5 block max-w-64 truncate font-mono text-[10px] text-ink-muted" title={cell.formula}>
                            ƒ {cell.formula}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="border-t border-trace-subtle px-3 py-2 text-xs text-ink-muted">
          The cited range contains only missing cells.
        </p>
      )}
      {range.truncated ? (
        <p className="border-t border-trace-subtle px-3 py-1.5 text-[11px] text-ink-muted">
          Range preview is bounded to the first stored cells.
        </p>
      ) : null}
    </section>
  );
}

function WorkbookEvidence({ workbook }: Readonly<{ workbook: KnowledgeViewerWorkbook }>) {
  return (
    <section aria-labelledby="knowledge-workbook-operation-heading" data-testid="knowledge-workbook-evidence">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
        Structured operation
      </p>
      <h3 className="mt-2 text-base font-semibold leading-6 text-ink" id="knowledge-workbook-operation-heading">
        {workbook.operationSummary}
      </h3>
      <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Cited workbook ranges">
        {workbook.ranges.map((range, index) => (
          <span className="rounded-control border border-proof/30 bg-proof/[0.04] px-2 py-1 font-mono text-[11px] text-proof" key={`${range.sheet}:${range.range}:${range.role}:${index}`}>
            {range.sheet}!{range.range}
          </span>
        ))}
      </div>

      <div className="mt-5">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
          Derived result
        </p>
        <div className="overflow-x-auto rounded-control border border-trace-strong">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-app-canvas text-ink-secondary">
              <tr>
                {workbook.result.columns.map((column, index) => (
                  <th className="border-r border-trace-subtle px-3 py-2 font-semibold last:border-r-0" key={`${column}:${index}`} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workbook.result.rows.map((row, rowIndex) => (
                <tr className="border-t border-trace-subtle" key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td className="border-r border-trace-subtle px-3 py-2 font-mono text-ink last:border-r-0" key={cellIndex}>
                      {workbookValue(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-7 overflow-hidden rounded-control border border-trace-strong">
        {workbook.ranges.map((range, index) => (
          <WorkbookRangeGrid key={`${range.sheet}:${range.range}:${range.role}:${index}`} range={range} />
        ))}
      </div>
      {workbook.warnings.length > 0 ? (
        <p className="mt-3 border-l-2 border-attention pl-3 text-xs leading-5 text-ink-secondary">
          {workbook.warnings.join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function ViewerDocument({ loaded }: Readonly<{ loaded: LoadedViewer }>) {
  const [failedPageUrl, setFailedPageUrl] = useState<string | null>(null);
  if (loaded.value.state === "deleted") {
    return (
      <div className="mx-auto max-w-xl px-5 py-10 sm:px-8">
        <p className="text-sm font-semibold text-ink">Deleted Knowledge document</p>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Citation evidence was removed with the document. No filename, passage, or locator is retained.
        </p>
      </div>
    );
  }
  const value = loaded.value as KnowledgeViewerAvailable;
  const heading = value.headingPath.join(" › ");
  const originalPdfUrl = loaded.originalUrl && value.originalKind === "pdf"
    ? loaded.originalUrl
    : null;
  const imageUrl = loaded.originalUrl && value.originalKind === "image"
    ? loaded.originalUrl
    : null;
  const pageImageUrl = loaded.pageUrl !== failedPageUrl ? loaded.pageUrl : null;
  const hasHighlight = loaded.highlighted;
  const pageImageAlt = hasHighlight
    ? `Highlighted cited area on page ${value.locator.pageStart}`
    : `${value.source.fileName}, page ${value.locator.pageStart}`;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-12 pt-5 sm:px-7">
      {value.source.statuses.length > 0 ? (
        <div className="mb-5 border-l-2 border-attention pl-3 text-xs leading-5 text-ink-secondary">
          {value.source.statuses.map(sourceStatusText).join(" · ")}
        </div>
      ) : null}

      {value.visual ? (
        <section aria-labelledby="knowledge-visual-evidence-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted" id="knowledge-visual-evidence-heading">
              Original visual evidence
            </h3>
            <span className="font-mono text-[11px] text-proof">
              {pageLabel(value.locator.pageStart, value.locator.pageEnd)}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium leading-6 text-ink">{value.visual.label}</p>
          {value.visual.caption ? (
            <p className="mt-1 text-xs leading-5 text-ink-secondary">{value.visual.caption}</p>
          ) : null}
          {pageImageUrl ? (
            // The same-origin asset is authorized by the citation route and rendered privately.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={pageImageAlt}
              className="mt-3 max-h-[min(58vh,42rem)] w-full rounded-control border border-trace-strong bg-app-canvas object-contain"
              onError={() => setFailedPageUrl(loaded.pageUrl)}
              src={pageImageUrl}
            />
          ) : imageUrl ? (
            // The source URL is authenticated and same-origin. Next's server-side image optimizer
            // cannot carry the viewer's session authority across this private boundary.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={value.visual.caption ?? value.visual.label}
              className="mt-3 max-h-[min(58vh,42rem)] w-full rounded-control border border-trace-strong bg-app-canvas object-contain"
              src={imageUrl}
            />
          ) : null}
          {!pageImageUrl && !imageUrl ? (
            <p className="mt-4 border-l-2 border-attention pl-3 text-xs leading-5 text-ink-secondary">
              Original visual preview is unavailable. Only the retained caption
              {value.visual.status === "available" ? " and bounded analysis are shown." : " is shown."}
            </p>
          ) : null}
          {value.visual.status === "available" ? (
            <div className="mt-4 border-l-2 border-proof pl-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Bounded analysis</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">{value.visual.description}</p>
            </div>
          ) : (
            <p className="mt-4 border-l-2 border-attention pl-4 text-xs leading-5 text-ink-secondary">
              Automatic visual analysis is unavailable.
              {originalPdfUrl || imageUrl
                ? " Inspect the original and extracted caption; no generated description is being substituted."
                : " No generated description is being substituted."}
            </p>
          )}
        </section>
      ) : value.workbook ? <WorkbookEvidence workbook={value.workbook} /> : (
      <section aria-labelledby="knowledge-exact-excerpt-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted" id="knowledge-exact-excerpt-heading">
            Cited passage
          </h3>
          <span className="font-mono text-[11px] text-proof">
            {pageLabel(value.locator.pageStart, value.locator.pageEnd)}
          </span>
        </div>
        {heading ? <p className="mt-2 text-xs leading-5 text-ink-muted">{heading}</p> : null}
        <blockquote className="mt-3 border-l-2 border-proof pl-4 text-[15px] leading-7 text-ink">
          {value.excerpt}
        </blockquote>
        {value.excerptTruncated ? (
          <p className="mt-2 text-xs text-ink-muted">The passage was bounded at answer time.</p>
        ) : null}
      </section>
      )}

      {!value.visual && originalPdfUrl ? (
        <section className="mt-8" aria-labelledby="knowledge-original-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted" id="knowledge-original-heading">
              Original PDF
            </h3>
            <a
              className="inline-flex min-h-9 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-proof outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
              href={`${originalPdfUrl}#page=${value.locator.pageStart}`}
              rel="noreferrer"
              target="_blank"
            >
              Open page {value.locator.pageStart}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
          {pageImageUrl ? (
            <>
              {hasHighlight ? (
                <p className="mt-2 text-[11px] text-ink-muted">
                  Highlighted cited area · page {value.locator.pageStart}
                </p>
              ) : null}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={pageImageAlt}
                className="mt-2 max-h-[min(58vh,42rem)] w-full rounded-control border border-trace-strong bg-app-canvas object-contain"
                onError={() => setFailedPageUrl(loaded.pageUrl)}
                src={pageImageUrl}
              />
            </>
          ) : (
            <p className="mt-3 border-l-2 border-attention pl-3 text-xs leading-5 text-ink-secondary">
              Page preview is unavailable. Open the original to inspect this page.
            </p>
          )}
        </section>
      ) : !value.visual && !value.workbook && !loaded.originalUrl ? (
        <p className="mt-5 border-l-2 border-trace-strong pl-3 text-xs leading-5 text-ink-muted">
          Original page preview is unavailable. The accepted excerpt and page locator above are the retained evidence for this citation.
        </p>
      ) : null}

      {!value.workbook || value.blocks.length > 0 ? (
        <section className="mt-8" aria-labelledby="knowledge-context-heading">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted" id="knowledge-context-heading">
            Context
          </h3>
          <NormalizedPassage blocks={value.blocks} />
        </section>
      ) : null}
    </div>
  );
}

function ViewerRail({
  libraryOpenStatus,
  onClose,
  onOpenInLibrary,
  restoreFocus,
  state
}: Readonly<{
  libraryOpenStatus: "error" | "idle" | "loading";
  onClose(): void;
  onOpenInLibrary: (() => void) | null;
  restoreFocus: HTMLElement | null;
  state: ViewerLoadState;
}>) {
  const dialogRef = useDialogFocus<HTMLElement>({
    onClose,
    restoreFocus: () => restoreFocus
  });
  const available = state.loaded?.value.state === "available"
    ? state.loaded.value
    : null;
  const title = available?.source.name ?? (state.status === "error" ? "Document unavailable" : "Document evidence");
  const eyebrow = state.request.kind === "citation"
    ? state.request.reference.handle
    : null;
  return (
    <>
      <button
        aria-hidden="true"
        className="fixed inset-0 z-[69] cursor-default bg-ink/10 backdrop-blur-[1px]"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <aside
        aria-label="Knowledge document viewer"
        aria-modal="true"
        className="fixed inset-y-0 right-0 z-[70] flex w-full flex-col border-l border-trace-strong bg-answer-paper text-ink shadow-2xl sm:max-w-[44rem]"
        data-testid="knowledge-source-viewer"
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex min-w-0 shrink-0 items-start gap-3 border-b border-trace-subtle px-4 py-3 sm:px-6">
          <FileSearch className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {eyebrow ? (
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-proof">{eyebrow}</p>
            ) : null}
            <h2 className="mt-0.5 truncate text-sm font-semibold text-ink">{title}</h2>
            {available ? (
              <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                {available.source.fileName}
                {available.source.baseName ? ` · ${available.source.baseName}` : ""}
              </p>
            ) : null}
            {libraryOpenStatus === "error" ? (
              <p className="mt-1 text-[11px] text-danger" role="alert">
                This document could not be opened in Library.
              </p>
            ) : null}
          </div>
          {available?.libraryAvailable && state.request.kind === "citation" && onOpenInLibrary ? (
            <button
              className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-control border border-trace-strong px-3 text-xs font-medium text-ink outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait disabled:opacity-60"
              disabled={libraryOpenStatus === "loading"}
              onClick={onOpenInLibrary}
              type="button"
            >
              {libraryOpenStatus === "loading" ? "Opening…" : "Open in Library"}
            </button>
          ) : null}
          <button
            aria-label="Close document viewer"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {state.status === "loading" ? (
            <div className="flex min-h-64 items-center justify-center gap-2 px-6 text-sm text-ink-secondary" role="status">
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Checking current access and locating evidence…
            </div>
          ) : state.status === "error" || !state.loaded ? (
            <div className="mx-auto max-w-xl px-6 py-12" role="status">
              <p className="text-sm font-semibold text-ink">Document unavailable</p>
              <p className="mt-2 text-sm leading-6 text-ink-secondary">
                The reference cannot be opened under your current access or retention state.
              </p>
            </div>
          ) : <ViewerDocument loaded={state.loaded} />}
        </div>
      </aside>
    </>
  );
}

export function KnowledgeCitationViewerProvider({
  children,
  onOpenLibrarySource
}: Readonly<{
  children: ReactNode;
  onOpenLibrarySource?(sourceId: string): void;
}>) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [viewer, setViewer] = useState<ViewerLoadState | null>(null);
  const [libraryOpenStatus, setLibraryOpenStatus] = useState<"error" | "idle" | "loading">("idle");
  const [restoreFocus, setRestoreFocus] = useState<HTMLElement | null>(null);
  const libraryTargetAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const viewerAbort = useRef<AbortController | null>(null);
  const viewerKey = useRef<string | null>(null);

  const beginPreview = useCallback((request: ViewerRequest, trigger: HTMLElement) => {
    const key = requestKey(request);
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    const position = previewPosition(trigger);
    setPreview({ key, loaded: null, position, request, status: "loading" });
    void loadRequest(request, controller.signal).then(
      (loaded) => setPreview((current) => current?.key === key
        ? { ...current, loaded, status: "ready" }
        : current),
      () => {
        if (!controller.signal.aborted) {
          setPreview((current) => current?.key === key
            ? { ...current, loaded: null, status: "error" }
            : current);
        }
      }
    );
  }, []);

  const openRequest = useCallback((request: ViewerRequest, trigger: HTMLElement) => {
    const key = requestKey(request);
    previewAbort.current?.abort();
    viewerAbort.current?.abort();
    libraryTargetAbort.current?.abort();
    setPreview(null);
    setLibraryOpenStatus("idle");
    setRestoreFocus(trigger);
    const controller = new AbortController();
    viewerAbort.current = controller;
    viewerKey.current = key;
    setViewer({ key, loaded: null, request, status: "loading" });
    void loadRequest(request, controller.signal).then(
      (loaded) => setViewer((current) => current?.key === key
        ? { ...current, loaded, status: "ready" }
        : current),
      () => {
        if (!controller.signal.aborted) {
          setViewer((current) => current?.key === key
            ? { ...current, loaded: null, status: "error" }
            : current);
        }
      }
    );
  }, []);

  const value = useMemo<KnowledgeViewerContextValue>(() => ({
    activePreviewKey: preview?.key ?? null,
    dismissPreview(key) {
      setPreview((current) => {
        if (current?.key !== key) return current;
        previewAbort.current?.abort();
        return null;
      });
    },
    openCitation(reference, trigger) {
      openRequest({ kind: "citation", reference }, trigger);
    },
    openSource(sourceId, trigger) {
      openRequest({ kind: "source", sourceId }, trigger);
    },
    previewCitation(reference, trigger) {
      beginPreview({ kind: "citation", reference }, trigger);
    }
  }), [beginPreview, openRequest, preview?.key]);

  useEffect(() => () => {
    libraryTargetAbort.current?.abort();
    previewAbort.current?.abort();
    viewerAbort.current?.abort();
  }, []);

  useEffect(() => {
    if (!preview) return;
    const dismiss = () => {
      previewAbort.current?.abort();
      setPreview(null);
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [preview]);

  const closeViewer = () => {
    libraryTargetAbort.current?.abort();
    viewerAbort.current?.abort();
    viewerKey.current = null;
    setLibraryOpenStatus("idle");
    setViewer(null);
  };

  const openCitationInLibrary = viewer?.request.kind === "citation" &&
    viewer.loaded?.value.state === "available" && viewer.loaded.value.libraryAvailable &&
    onOpenLibrarySource
    ? () => {
        const key = viewer.key;
        const reference = viewer.request.kind === "citation" ? viewer.request.reference : null;
        if (!reference) return;
        libraryTargetAbort.current?.abort();
        const controller = new AbortController();
        libraryTargetAbort.current = controller;
        setLibraryOpenStatus("loading");
        void loadKnowledgeCitationLibraryTarget(reference, controller.signal).then(
          (sourceId) => {
            if (viewerKey.current !== key) return;
            viewerKey.current = null;
            setLibraryOpenStatus("idle");
            setViewer(null);
            onOpenLibrarySource(sourceId);
          },
          () => {
            if (!controller.signal.aborted && viewerKey.current === key) {
              setLibraryOpenStatus("error");
            }
          }
        );
      }
    : null;

  return (
    <KnowledgeViewerContext.Provider value={value}>
      {children}
      {preview ? <PreviewCard state={preview} /> : null}
      {viewer ? (
        <ViewerRail
          libraryOpenStatus={libraryOpenStatus}
          onClose={closeViewer}
          onOpenInLibrary={openCitationInLibrary}
          restoreFocus={restoreFocus}
          state={viewer}
        />
      ) : null}
    </KnowledgeViewerContext.Provider>
  );
}

function useKnowledgeViewerContext(): KnowledgeViewerContextValue {
  const value = useContext(KnowledgeViewerContext);
  if (!value) throw new Error("knowledge_citation_viewer_provider_missing");
  return value;
}

export function useKnowledgeSourceViewer() {
  const viewer = useContext(KnowledgeViewerContext);
  return useCallback((sourceId: string, trigger: HTMLElement) => {
    viewer?.openSource(sourceId, trigger);
  }, [viewer]);
}

export function KnowledgeCitationControl({
  className = "",
  reference
}: Readonly<{
  className?: string;
  reference: KnowledgeCitationReference;
}>) {
  const viewer = useKnowledgeViewerContext();
  const key = requestKey({ kind: "citation", reference });
  return (
    <button
      aria-describedby={viewer.activePreviewKey === key
        ? "knowledge-citation-preview"
        : undefined}
      aria-haspopup="dialog"
      aria-label={`Open document ${reference.handle}`}
      className={`knowledge-citation-control ${className}`.trim()}
      data-knowledge-citation={reference.handle}
      onBlur={() => viewer.dismissPreview(key)}
      onClick={(event) => viewer.openCitation(reference, event.currentTarget)}
      onFocus={(event) => viewer.previewCitation(reference, event.currentTarget)}
      onMouseEnter={(event) => viewer.previewCitation(reference, event.currentTarget)}
      onMouseLeave={() => viewer.dismissPreview(key)}
      type="button"
    >
      {reference.handle}
    </button>
  );
}

export function KnowledgeCitationSourceTrigger({
  citation,
  reference
}: Readonly<{
  citation: ThreadKnowledgeCitation;
  reference: Omit<KnowledgeCitationReference, "handle">;
}>) {
  const fullReference = { ...reference, handle: citation.handle };
  const viewer = useKnowledgeViewerContext();
  const key = requestKey({ kind: "citation", reference: fullReference });
  return (
    <button
      aria-describedby={viewer.activePreviewKey === key
        ? "knowledge-citation-preview"
        : undefined}
      aria-haspopup="dialog"
      aria-label={citation.deleted
        ? "Deleted Knowledge document"
        : `Knowledge document [${citation.handle}]`}
      className="v2-answer-knowledge-link"
      onBlur={() => viewer.dismissPreview(key)}
      onClick={(event) => viewer.openCitation(fullReference, event.currentTarget)}
      onFocus={(event) => viewer.previewCitation(fullReference, event.currentTarget)}
      onMouseEnter={(event) => viewer.previewCitation(fullReference, event.currentTarget)}
      onMouseLeave={() => viewer.dismissPreview(key)}
      type="button"
    >
      {citation.deleted ? "Deleted Knowledge document" : "Open document ›"}
    </button>
  );
}
