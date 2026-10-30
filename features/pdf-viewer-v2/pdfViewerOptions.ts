/**
 * The viewer's hardening and bounds, in one module without browser imports so
 * the hostile-input tests drive the real library through exactly these
 * options. A foreign PDF is parsed on the application origin (the accepted
 * risk in `agent_docs/SECURITY.md`), so everything here is explicit rather than
 * left to a library default that an upgrade could change.
 */

/** Where `scripts/pdf-viewer-assets.mjs` publishes the worker and its data, under the pdf.js version. */
export const PDFJS_ASSET_ROOT = "/pdfjs";

export const PDF_VIEWER_FETCH_TIMEOUT_MS = 120_000;
/** From handing the bytes to pdf.js to the first painted page. */
export const PDF_VIEWER_OPEN_TIMEOUT_MS = 45_000;
/** Every page gets a DOM node as the document opens, so a claimed page count must not lay out unbounded. */
export const PDF_VIEWER_MAX_PAGES = 5_000;
export const PDF_VIEWER_MIN_SCALE = 0.25;
export const PDF_VIEWER_MAX_SCALE = 4;
export const PDF_VIEWER_SCALE_STEP = 1.25;
/** Below this width a page opens at the full width: `auto` would open it at up to 125% and overflow sideways. */
const PDF_VIEWER_NARROW_WIDTH = 768;
const ANNOTATION_TYPE_TEXT = 1;
/** The Text annotation icons pdf.js ships (`scripts/pdf-viewer-assets.mjs` publishes them). */
export const PDF_TEXT_ANNOTATION_ICONS: ReadonlySet<string> = new Set([
  "check", "comment", "help", "insert", "key", "newparagraph", "noicon", "note", "paragraph"
]);

// pdf.js enum values, repeated so this module stays importable without the library; a test pins them to it.
const VERBOSITY_ERRORS = 0;
const TEXT_LAYER_ENABLE = 1;
const ANNOTATION_MODE_ENABLE = 1;
const ANNOTATION_EDITOR_DISABLE = -1;

export type PdfViewerEnvironment = Readonly<{
  android: boolean;
  /** A phone or tablet: iOS Safari's canvas budget applies. */
  constrained: boolean;
}>;

export function pdfViewerEnvironment(input: Readonly<{
  coarsePointer: boolean;
  maxTouchPoints: number;
  userAgent: string;
}>): PdfViewerEnvironment {
  const android = /Android/u.test(input.userAgent);
  return { android, constrained: android || /\b(?:iPad|iPhone|iPod)\b/u.test(input.userAgent) || (input.coarsePointer && input.maxTouchPoints > 1) };
}

/** 5 MP is the value pdf.js itself uses on iOS and Android; ten retained pages must fit Safari's total canvas memory. */
export function pdfViewerLimits(environment: PdfViewerEnvironment) {
  return environment.constrained
    ? { canvasMaxAreaInBytes: 2 ** 24 * 4, maxCanvasDim: 8_192, maxCanvasPixels: 5_242_880, maxImageSize: 40_000_000 }
    : { canvasMaxAreaInBytes: 2 ** 28 * 4, maxCanvasDim: 32_767, maxCanvasPixels: 2 ** 25, maxImageSize: 100_000_000 };
}

/**
 * Everything passed to `getDocument` except the bytes. `assetBase` ends in a
 * slash and is laid out like the pdfjs-dist package.
 *
 * `useWasm: false`: the application CSP has no `wasm-unsafe-eval`, and the
 * worker runs under that CSP. pdf.js then takes the JavaScript JPEG2000 and
 * JBIG2 decoders from `wasmUrl`, compiles PostScript functions to plain
 * JavaScript and renders ICC colours through their device alternates, so no
 * WebAssembly compile is ever attempted.
 *
 * `isEvalSupported` and `enableScripting` are ignored by 6.2.108, which has no
 * eval path and takes scripting only from the viewer's scripting manager (none
 * is created). They are stated so a pinned test notices if that ever changes.
 */
export function pdfDocumentOptions(input: Readonly<{
  assetBase: string;
  environment: PdfViewerEnvironment;
  /** False only in Node, where the library reads the assets from disk itself. */
  useWorkerFetch?: boolean;
}>) {
  const limits = pdfViewerLimits(input.environment);
  return {
    canvasMaxAreaInBytes: limits.canvasMaxAreaInBytes,
    cMapPacked: true,
    cMapUrl: `${input.assetBase}cmaps/`,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    docBaseUrl: undefined,
    enableHWA: false,
    enableScripting: false,
    enableWebGPU: false,
    enableXfa: false,
    fontExtraProperties: false,
    iccUrl: undefined,
    isEvalSupported: false,
    maxImageSize: limits.maxImageSize,
    pdfBug: false,
    standardFontDataUrl: `${input.assetBase}standard_fonts/`,
    // One bad operator leaves the rest of a page readable; a document that cannot open still fails.
    stopAtErrors: false,
    useSystemFonts: !input.environment.android,
    useWasm: false,
    useWorkerFetch: input.useWorkerFetch ?? true,
    verbosity: VERBOSITY_ERRORS,
    wasmUrl: `${input.assetBase}wasm/`
  } as const;
}

/** The `PDFViewer` options that decide what a page may do: text selection and links, never forms, editors or scripting. */
export function pdfPageViewOptions(input: Readonly<{ assetBase: string; environment: PdfViewerEnvironment }>) {
  const limits = pdfViewerLimits(input.environment);
  return {
    annotationEditorMode: ANNOTATION_EDITOR_DISABLE,
    annotationMode: ANNOTATION_MODE_ENABLE,
    enableAutoLinking: false,
    enablePermissions: false,
    imageResourcesPath: `${input.assetBase}images/`,
    maxCanvasDim: limits.maxCanvasDim,
    maxCanvasPixels: limits.maxCanvasPixels,
    removePageBorders: true,
    supportsPinchToZoom: false,
    textLayerMode: TEXT_LAYER_ENABLE
  } as const;
}

export function pdfDefaultScaleValue(input: Readonly<{ constrained: boolean; containerWidth: number }>): "auto" | "page-width" {
  return input.constrained || input.containerWidth < PDF_VIEWER_NARROW_WIDTH ? "page-width" : "auto";
}

/**
 * pdf.js builds `imageResourcesPath + "annotation-" + name + ".svg"` from a Text
 * annotation's /Name, so `#2F..` and `#3F` in a hostile PDF would pick a
 * same-origin path and query, sent with the user's cookies, just by opening it.
 * Every name becomes one of the shipped icons before the layer sees it.
 */
export function safePdfAnnotations<T extends object>(annotations: readonly T[]): T[] {
  return annotations.map((annotation) => {
    const { annotationType, name } = annotation as { annotationType?: unknown; name?: unknown };
    if (annotationType !== ANNOTATION_TYPE_TEXT) return annotation;
    return { ...annotation, name: typeof name === "string" && PDF_TEXT_ANNOTATION_ICONS.has(name.toLowerCase()) ? name : "Note" };
  });
}

type GuardablePdfPage = { getAnnotations(...args: never[]): Promise<object[]> };

/** Applies `safePdfAnnotations` to every page this document hands out, the viewer's included. */
export function guardPdfDocumentPages(pdfDocument: { getPage(pageNumber: number): Promise<GuardablePdfPage> }): void {
  const guarded = new WeakSet<object>();
  const getPage = pdfDocument.getPage.bind(pdfDocument);
  pdfDocument.getPage = async (pageNumber) => {
    const page = await getPage(pageNumber);
    if (!guarded.has(page)) {
      guarded.add(page);
      const getAnnotations = page.getAnnotations.bind(page);
      page.getAnnotations = async (...args) => safePdfAnnotations(await getAnnotations(...args));
    }
    return page;
  };
}

/** Only plain web addresses leave the document, and never with credentials that disguise the host. */
export function safePdfExternalHref(url: unknown): string | null {
  if (typeof url !== "string" || /[\u0000-\u001F\u007F\s]/u.test(url)) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password ? url : null;
  } catch {
    return null;
  }
}

/**
 * Replaces `PDFLinkService.addLinkAttributes`. The anchor has no `href`, so no
 * middle click, Ctrl+click, context menu or drag can reach an address, or open
 * a duplicate of the application, without the confirmation. Keyboard users
 * reach it through `tabindex` and Enter. Anything other than a web address
 * stays inert.
 */
export function bindPdfExternalLink(link: HTMLAnchorElement, url: unknown, onExternalLink: (href: string) => void): void {
  const href = safePdfExternalHref(url);
  link.removeAttribute("href");
  link.removeAttribute("target");
  link.rel = "noopener noreferrer nofollow";
  if (!href) {
    link.title = "This link can’t be opened";
    link.setAttribute("aria-disabled", "true");
    link.onclick = () => false;
    return;
  }
  link.title = href;
  link.tabIndex = 0;
  link.setAttribute("role", "link");
  link.onclick = () => {
    onExternalLink(href);
    return false;
  };
  link.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onExternalLink(href);
  };
}
