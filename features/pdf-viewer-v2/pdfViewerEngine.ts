import { PDFJS_ASSET_ROOT } from "./pdfViewerOptions";

/**
 * The only place that imports pdf.js, and only when a PDF is opened, so none of
 * it reaches the chat's initial chunks. The legacy build carries the polyfills
 * the modern one assumes: 6.2.108's modern build calls `Map.getOrInsertComputed`,
 * `Math.sumPrecise` and `Uint8Array.fromBase64` unguarded, which current iOS
 * Safari and Android Chrome do not all have. Its one remaining floor is the
 * regular expression `v` flag (Safari 17, Chrome 112, Firefox 116); an older
 * browser fails to load the chunk and gets the viewer's Download fallback.
 */
export async function loadPdfEngine() {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The viewer module reads the library from this global when it evaluates.
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib ??= lib;
  const viewer = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
  const assetBase = new URL(`${PDFJS_ASSET_ROOT}/${lib.version}/`, window.location.origin).href;
  lib.GlobalWorkerOptions.workerSrc = `${assetBase}pdf.worker.min.mjs`;
  return { assetBase, lib, viewer };
}

export type PdfEngine = Awaited<ReturnType<typeof loadPdfEngine>>;
