// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AnnotationEditorType,
  AnnotationMode,
  AnnotationType,
  GlobalWorkerOptions,
  OPS,
  OutputScale,
  VerbosityLevel,
  getDocument,
  type PDFDocumentLoadingTask
} from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  activeContentPdf,
  cidFontPdf,
  damagedPdf,
  jbig2Pdf,
  jpxPdf,
  maliciousFontPdf,
  manyPagesPdf,
  oversizedPagePdf,
  passwordPdf,
  pdfBeaconPdf,
  predefinedCmapPdf
} from "@/tests/support/pdfFixtures";
import {
  PDF_TEXT_ANNOTATION_ICONS,
  PDF_VIEWER_MAX_PAGES,
  guardPdfDocumentPages,
  pdfDocumentOptions,
  pdfPageViewOptions,
  pdfViewerLimits,
  safePdfAnnotations
} from "./pdfViewerOptions";

// The real library, in Node with its worker in-process, through the viewer's own options.
const packageRoot = `${process.cwd()}/node_modules/pdfjs-dist`;
const desktop = { android: false, constrained: false };
const phone = { android: false, constrained: true };
const options = pdfDocumentOptions({ assetBase: `${packageRoot}/`, environment: desktop, useWorkerFetch: false });

type Pwnable = typeof globalThis & { __aiqsaPdfPwned?: boolean };
const realEval = globalThis.eval;
const realFunction = globalThis.Function;
const realWebAssembly = globalThis.WebAssembly;
const dynamicCode: string[] = [];
const wasmCalls: string[] = [];
const tasks: PDFDocumentLoadingTask[] = [];

function open(data: Uint8Array) {
  const task = getDocument({ ...options, data });
  tasks.push(task);
  return task.promise;
}

beforeAll(() => {
  GlobalWorkerOptions.workerSrc = `file://${packageRoot}/legacy/build/pdf.worker.mjs`;
  globalThis.eval = new Proxy(realEval, { apply(target, self, args) { dynamicCode.push(String(args[0])); return Reflect.apply(target, self, args); } });
  // Not a stub: the proxies only record, so what the library does stays what would run in a browser.
  globalThis.Function = new Proxy(realFunction, {
    apply(target, self, args) { dynamicCode.push(args.join(",")); return Reflect.apply(target, self, args); },
    construct(target, args, newTarget) { dynamicCode.push(args.join(",")); return Reflect.construct(target, args, newTarget); }
  });
  globalThis.WebAssembly = new Proxy(realWebAssembly, {
    get(target, property, receiver) {
      if (["compile", "compileStreaming", "instantiate", "instantiateStreaming", "Module", "Instance"].includes(String(property))) wasmCalls.push(String(property));
      return Reflect.get(target, property, receiver);
    }
  });
});

afterEach(async () => {
  await Promise.all(tasks.splice(0).map(task => task.destroy()));
});

afterAll(() => {
  globalThis.eval = realEval;
  globalThis.Function = realFunction;
  globalThis.WebAssembly = realWebAssembly;
});

function expectNothingRan() {
  expect((globalThis as Pwnable).__aiqsaPdfPwned).toBeUndefined();
  expect(dynamicCode).toEqual([]);
}

describe("the options the viewer passes to pdf.js", () => {
  it("states the hardening explicitly at the document", () => {
    expect(options).toMatchObject({
      disableAutoFetch: true, disableRange: true, disableStream: true, enableHWA: false, enableScripting: false,
      enableWebGPU: false, enableXfa: false, isEvalSupported: false, pdfBug: false, useWasm: false,
      verbosity: VerbosityLevel.ERRORS
    });
    expect(options).not.toHaveProperty("url");
    expect(options.maxImageSize).toBeGreaterThan(0);
    expect(options.canvasMaxAreaInBytes).toBeGreaterThan(0);
  });

  it("renders links but no forms, editors or scripting, with the library's own enum values", () => {
    const view = pdfPageViewOptions({ assetBase: "/pdfjs/1/", environment: desktop });
    expect(view.annotationMode).toBe(AnnotationMode.ENABLE);
    expect(view.annotationEditorMode).toBe(AnnotationEditorType.DISABLE);
    expect(view.textLayerMode).toBe(1);
    expect(view).not.toHaveProperty("scriptingManager");
    expect(view.imageResourcesPath).toBe("/pdfjs/1/images/");
  });

  it("gives a phone a smaller canvas and image budget, under iOS Safari's canvas limit", () => {
    const small = pdfViewerLimits(phone);
    const large = pdfViewerLimits(desktop);
    expect(small.maxCanvasPixels).toBeLessThanOrEqual(2 ** 24);
    expect(small.maxCanvasPixels).toBeLessThan(large.maxCanvasPixels);
    expect(small.maxImageSize).toBeLessThan(large.maxImageSize);
    expect(pdfDocumentOptions({ assetBase: "/x/", environment: { android: true, constrained: true } }).useSystemFonts).toBe(false);
  });

});

describe("hostile documents through the real library", () => {
  it("runs no document JavaScript and reports no script to a viewer", async () => {
    const document = await open(activeContentPdf());
    expect(await document.getFieldObjects()).toBeNull();
    const page = await document.getPage(1);
    await page.getOperatorList();
    const annotations = await page.getAnnotations();
    await document.getPage(2);
    expectNothingRan();

    // The worker never accepts the javascript: address as a link target; the JavaScript action has no address at all.
    const urls = annotations.map(annotation => annotation.url).filter(Boolean);
    expect(urls).toEqual(["https://example.test/from-pdf?x=1"]);
    expect(annotations.some(annotation => annotation.dest)).toBe(true);
  });

  it("lets nothing in a PDF name a request: icons become shipped names, and fonts and CMaps stay on their tables", async () => {
    const requested: string[] = [];
    class RecordingBinaryData {
      async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
        requested.push(filename);
        throw new Error("synthetic: assets are not read in this test");
      }
    }
    const task = getDocument({ ...options, BinaryDataFactory: RecordingBinaryData, data: pdfBeaconPdf(), useSystemFonts: false } as never);
    tasks.push(task);
    const document = await task.promise;

    const raw = await (await document.getPage(1)).getAnnotations();
    const text = raw.find(annotation => annotation.annotationType === AnnotationType.TEXT);
    expect(text.name).toContain("/");
    expect(text.name).toContain("pdf-beacon");
    expect(safePdfAnnotations(raw).find(annotation => annotation.annotationType === AnnotationType.TEXT).name).toBe("Note");

    guardPdfDocumentPages(document);
    const page = await document.getPage(1);
    const guarded = await page.getAnnotations();
    expect(PDF_TEXT_ANNOTATION_ICONS.has(guarded.find(annotation => annotation.annotationType === AnnotationType.TEXT).name.toLowerCase())).toBe(true);
    expect(JSON.stringify(guarded.map(annotation => annotation.url ?? null))).not.toContain("pdf-beacon");
    expect(await document.getPage(1)).toBe(page);
    await page.getOperatorList();
    await page.getTextContent();

    for (const filename of requested) {
      expect(filename).toMatch(/^[\w.-]+$/u);
      expect(filename).not.toContain("beacon");
    }
  });

  it("does not execute a font program's matrix payload and survives its garbage", async () => {
    const document = await open(maliciousFontPdf());
    const page = await document.getPage(1);
    await page.getOperatorList();
    await page.getTextContent();
    expectNothingRan();
  });

  it("keeps an oversized page within the canvas cap on desktop and on a phone", async () => {
    const document = await open(oversizedPagePdf());
    const viewport = (await document.getPage(1)).getViewport({ scale: 1 });
    expect(viewport.width).toBeGreaterThan(100_000);
    for (const environment of [desktop, phone]) {
      const { maxCanvasDim, maxCanvasPixels } = pdfViewerLimits(environment);
      const scale = new OutputScale();
      scale.limitCanvas(viewport.width, viewport.height, maxCanvasPixels, maxCanvasDim, -1);
      const pixels = Math.floor(viewport.width * scale.sx) * Math.floor(viewport.height * scale.sy);
      expect(pixels).toBeLessThanOrEqual(maxCanvasPixels * 1.01);
    }
  });

  it("reports a page count the viewer refuses to lay out", async () => {
    const document = await open(manyPagesPdf(PDF_VIEWER_MAX_PAGES + 1));
    expect(document.numPages).toBeGreaterThan(PDF_VIEWER_MAX_PAGES);
  });

  it("names a password-protected document", async () => {
    await expect(open(passwordPdf())).rejects.toMatchObject({ name: "PasswordException" });
  });

  it("names a damaged document", async () => {
    await expect(open(damagedPdf())).rejects.toMatchObject({ name: "InvalidPDFException" });
  });

  it("stops at the image size cap instead of decoding a larger image", async () => {
    const task = getDocument({ ...options, data: jpxPdf(), maxImageSize: 10 });
    tasks.push(task);
    const list = await (await (await task.promise).getPage(1)).getOperatorList();
    expect(list.fnArray).not.toContain(OPS.paintImageXObject);
  });
});

describe("text and decoders under the application's CSP", () => {
  it("extracts Cyrillic text from an embedded CID font", async () => {
    const document = await open(cidFontPdf([["Съешь же ещё этих мягких французских булок"], ["Вторая страница"]]));
    expect(document.numPages).toBe(2);
    const text = await (await document.getPage(1)).getTextContent();
    expect(text.items.map(item => "str" in item ? item.str : "").join("")).toBe("Съешь же ещё этих мягких французских булок");
  });

  it("reads a predefined CMap from the served assets for a non-embedded CID font", async () => {
    const document = await open(predefinedCmapPdf());
    const text = await (await document.getPage(1)).getTextContent();
    expect(text.items.map(item => "str" in item ? item.str : "").join("")).toBe("日本語");
  });

  it.each([["JPEG2000", jpxPdf], ["JBIG2", jbig2Pdf]] as const)("decodes %s with the JavaScript fallback and never compiles WebAssembly", async (_name, fixture) => {
    wasmCalls.length = 0;
    const document = await open(fixture());
    const page = await document.getPage(1);
    const list = await page.getOperatorList();
    expect(list.fnArray).toContain(OPS.paintImageXObject);
    const name = list.argsArray[list.fnArray.indexOf(OPS.paintImageXObject)][0] as string;
    const image = await new Promise<{ data?: Uint8ClampedArray; height: number; width: number }>(done => page.objs.get(name, done));
    expect(image).toMatchObject({ height: 8, width: 8 });
    expect(wasmCalls).toEqual([]);
  });
});
