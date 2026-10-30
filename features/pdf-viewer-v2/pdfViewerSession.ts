import { PDF_PREVIEW_MAX_BYTES } from "@/lib/domain/attachmentPreview";
import { shellFetch } from "@/components/app-shell/shellApi";
import type { PdfEngine } from "./pdfViewerEngine";
import { loadPdfEngine } from "./pdfViewerEngine";
import {
  PDF_VIEWER_FETCH_TIMEOUT_MS,
  PDF_VIEWER_MAX_PAGES,
  PDF_VIEWER_MAX_SCALE,
  PDF_VIEWER_MIN_SCALE,
  PDF_VIEWER_OPEN_TIMEOUT_MS,
  PDF_VIEWER_SCALE_STEP,
  bindPdfExternalLink,
  guardPdfDocumentPages,
  pdfDefaultScaleValue,
  pdfDocumentOptions,
  pdfPageViewOptions,
  type PdfViewerEnvironment
} from "./pdfViewerOptions";

export type PdfViewerFailure = "damaged" | "failed" | "password" | "timeout" | "too_large" | "too_many_pages" | "unavailable";

export type PdfFindStatus = Readonly<{ current: number; pending: boolean; total: number }>;

export type PdfViewerUpdate = Partial<Readonly<{
  find: PdfFindStatus;
  page: number;
  pageCount: number;
  scale: number;
  status: "ready" | Readonly<{ failure: PdfViewerFailure }>;
}>>;

export type PdfViewerSession = Readonly<{
  close(): void;
  find(query: string, options?: Readonly<{ again?: boolean; previous?: boolean }>): void;
  findClosed(): void;
  resetZoom(): void;
  zoom(direction: "in" | "out"): void;
}>;

class PdfViewerFailed extends Error {
  override name = "PdfViewerFailed";
  constructor(readonly failure: PdfViewerFailure) { super(failure); }
}

/**
 * The first paint needs `requestAnimationFrame`, which does not fire in a hidden
 * tab: only time with the tab visible counts, so a background tab does not fail.
 */
function visibleTimeout(milliseconds: number, onExpire: () => void): () => void {
  let remaining = milliseconds;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    if (timer !== undefined) return;
    startedAt = Date.now();
    timer = setTimeout(onExpire, remaining);
  };
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - startedAt;
  };
  const onChange = () => { if (document.visibilityState === "visible") start(); else pause(); };
  onChange();
  document.addEventListener("visibilitychange", onChange);
  return () => {
    pause();
    document.removeEventListener("visibilitychange", onChange);
  };
}

/** pdf.js's own English strings stay out: its default localization fetches locale files from a relative path. */
const silentL10n = {
  destroy: async () => undefined,
  get: async (ids: unknown, _args?: unknown, fallback?: string) => Array.isArray(ids) ? ids.map(() => "") : fallback ?? "",
  getDirection: () => "ltr",
  getLanguage: () => "en-us",
  pause: () => undefined,
  resume: () => undefined,
  translate: async () => undefined,
  translateOnce: async () => undefined
};

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PDF_PREVIEW_MAX_BYTES) throw new PdfViewerFailed("too_large");
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PDF_PREVIEW_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PdfViewerFailed("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function loadFailure(error: unknown): PdfViewerFailure {
  if (error instanceof PdfViewerFailed) return error.failure;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "PasswordException") return "password";
  if (name === "InvalidPDFException") return "damaged";
  return "failed";
}

/**
 * One opened document: bytes through the authorized route with `fetch`, then
 * pdf.js on those bytes alone (it does no networking for the document). Every
 * way out, a failure or `close`, goes through `teardown`, which aborts the
 * fetch and ends the worker, the pages and their listeners.
 *
 * The session owns its worker: with a port pdf.js cannot fall back to parsing on
 * the main thread when the worker fails to load, and `terminate` does not depend
 * on `task.destroy()`, which waits for an answer a stalled worker never sends.
 * Parsing is in the worker and bounded by a timer. Painting is on the main thread
 * and yields between operators; a single operator cannot be interrupted, which
 * the canvas cap bounds rather than removes.
 */
export function startPdfViewerSession(input: Readonly<{
  byteSize: number | null;
  container: HTMLDivElement;
  environment: PdfViewerEnvironment;
  href: string;
  onExternalLink(href: string): void;
  onUpdate(update: PdfViewerUpdate): void;
  pages: HTMLDivElement;
}>): PdfViewerSession {
  const requests = new AbortController();
  const views = new AbortController();
  let closed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stopPaintWatchdog: (() => void) | undefined;
  let workerPort: Worker | null = null;
  let pdfWorker: InstanceType<PdfEngine["lib"]["PDFWorker"]> | null = null;
  let task: ReturnType<PdfEngine["lib"]["getDocument"]> | null = null;
  let viewer: InstanceType<PdfEngine["viewer"]["PDFViewer"]> | null = null;
  let linkService: InstanceType<PdfEngine["viewer"]["PDFLinkService"]> | null = null;
  let findController: InstanceType<PdfEngine["viewer"]["PDFFindController"]> | null = null;
  let eventBus: InstanceType<PdfEngine["viewer"]["EventBus"]> | null = null;

  function teardown() {
    closed = true;
    clearTimeout(watchdog);
    stopPaintWatchdog?.();
    requests.abort();
    try {
      findController?.setDocument(null as never);
      viewer?.setDocument(null as never);
      linkService?.setDocument(null);
    } catch {
      // A half-built viewer has nothing more to release; the worker still ends below.
    }
    views.abort();
    void task?.destroy().catch(() => undefined);
    task = null;
    pdfWorker?.destroy();
    pdfWorker = null;
    workerPort?.terminate();
    workerPort = null;
    viewer = null;
    linkService = null;
    findController = null;
    eventBus = null;
  }

  function fail(failure: PdfViewerFailure) {
    if (closed) return;
    teardown();
    input.onUpdate({ status: { failure } });
  }

  async function fetchBytes(): Promise<Uint8Array> {
    if (input.byteSize !== null && input.byteSize > PDF_PREVIEW_MAX_BYTES) throw new PdfViewerFailed("too_large");
    const limit = setTimeout(() => requests.abort(), PDF_VIEWER_FETCH_TIMEOUT_MS);
    try {
      const response = await shellFetch(input.href, { cache: "no-store", credentials: "same-origin", signal: requests.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new PdfViewerFailed(response.status === 401 || response.status === 403 || response.status === 404 ? "unavailable" : "failed");
      }
      return await readBounded(response);
    } finally {
      clearTimeout(limit);
    }
  }

  async function open() {
    const bytes = await fetchBytes();
    if (closed) return;
    const engine = await loadPdfEngine();
    if (closed) return;
    const { assetBase, lib, viewer: components, workerSrc } = engine;
    const options = pdfDocumentOptions({ assetBase, environment: input.environment });
    watchdog = setTimeout(() => fail("timeout"), PDF_VIEWER_OPEN_TIMEOUT_MS);
    const port = new Worker(workerSrc, { type: "module" });
    workerPort = port;
    // A worker that cannot load or dies is a failure, never a silent stall until the watchdog.
    port.addEventListener("error", () => fail("failed"));
    port.addEventListener("messageerror", () => fail("failed"));
    pdfWorker = lib.PDFWorker.create({ port, verbosity: options.verbosity });
    const loading = lib.getDocument({ ...options, data: bytes, worker: pdfWorker });
    task = loading;
    const pdf = await loading.promise;
    if (closed) return;
    if (pdf.numPages > PDF_VIEWER_MAX_PAGES) throw new PdfViewerFailed("too_many_pages");
    guardPdfDocumentPages(pdf);
    // The viewer logs a first page it cannot read and shows nothing, so that failure is caught here.
    await pdf.getPage(1).catch(() => { throw new PdfViewerFailed("damaged"); });
    if (closed) return;
    clearTimeout(watchdog);

    const bus = new components.EventBus();
    eventBus = bus;
    const links = new components.PDFLinkService({ eventBus: bus, ignoreDestinationZoom: true });
    links.externalLinkEnabled = false;
    links.addLinkAttributes = (link, url) => bindPdfExternalLink(link, url, input.onExternalLink);
    linkService = links;
    const finder = new components.PDFFindController({ eventBus: bus, linkService: links, updateMatchesCountOnProgress: true });
    findController = finder;
    // The constructor honours this signal (its observer and scroll listener), but 6.2.108's types omit the option.
    const release = { abortSignal: views.signal };
    const pageViewer = new components.PDFViewer({
      ...pdfPageViewOptions({ assetBase, environment: input.environment }),
      ...release,
      container: input.container,
      eventBus: bus,
      findController: finder,
      l10n: silentL10n as never,
      linkService: links,
      viewer: input.pages
    });
    viewer = pageViewer;
    links.setViewer(pageViewer);

    const defaultScale = () => pdfDefaultScaleValue({ constrained: input.environment.constrained, containerWidth: input.container.clientWidth });
    bus.on("pagesinit", () => { pageViewer.currentScaleValue = defaultScale(); });
    // A turned phone or resized window refits a page the person has not zoomed.
    window.addEventListener("resize", () => {
      if (pageViewer.currentScaleValue === "auto" || pageViewer.currentScaleValue === "page-width") pageViewer.currentScaleValue = defaultScale();
    }, { signal: views.signal });
    bus.on("scalechanging", ({ scale }: { scale: number }) => input.onUpdate({ scale }));
    bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => input.onUpdate({ page: pageNumber }));
    bus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      input.onUpdate({ find: { ...matchesCount, pending: false } });
    });
    bus.on("updatefindcontrolstate", ({ matchesCount, state }: { matchesCount: { current: number; total: number }; state: number }) => {
      input.onUpdate({ find: { ...matchesCount, pending: state === components.FindState.PENDING } });
    });
    const firstPage = ({ error }: { error?: { name?: string } | null }) => {
      if (error?.name === "RenderingCancelledException") return;
      bus.off("pagerendered", firstPage);
      stopPaintWatchdog?.();
      if (error) fail("damaged");
      else input.onUpdate({ status: "ready" });
    };
    bus.on("pagerendered", firstPage);

    input.onUpdate({ page: 1, pageCount: pdf.numPages });
    stopPaintWatchdog = visibleTimeout(PDF_VIEWER_OPEN_TIMEOUT_MS, () => fail("timeout"));
    pageViewer.setDocument(pdf);
    links.setDocument(pdf, null);
    finder.setDocument(pdf);
  }

  void open().catch((error: unknown) => fail(loadFailure(error)));

  return {
    close: () => { if (!closed) teardown(); },
    find(query, options = {}) {
      eventBus?.dispatch("find", {
        caseSensitive: false, entireWord: false, findPrevious: options.previous === true, highlightAll: true,
        matchDiacritics: false, query, source: null, type: options.again ? "again" : ""
      });
    },
    findClosed() { eventBus?.dispatch("findbarclose", { source: null }); },
    resetZoom() {
      if (viewer) viewer.currentScaleValue = pdfDefaultScaleValue({ constrained: input.environment.constrained, containerWidth: input.container.clientWidth });
    },
    zoom(direction) {
      if (!viewer) return;
      const next = direction === "in" ? viewer.currentScale * PDF_VIEWER_SCALE_STEP : viewer.currentScale / PDF_VIEWER_SCALE_STEP;
      viewer.currentScale = Math.min(PDF_VIEWER_MAX_SCALE, Math.max(PDF_VIEWER_MIN_SCALE, next));
    }
  };
}
