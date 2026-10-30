import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDF_PREVIEW_MAX_BYTES } from "@/lib/domain/attachmentPreview";
import { PdfViewerV2 } from "./PdfViewerV2";
import { PDF_VIEWER_MAX_PAGES, PDF_VIEWER_OPEN_TIMEOUT_MS } from "./pdfViewerOptions";

// pdf.js needs a real canvas and worker, so its real behavior is in pdfHostileInput.test.ts and the browser
// spec. Here a fake engine stands in, to observe which states the viewer reaches and what it releases.
type Listener = (event: never) => void;

const engine = vi.hoisted(() => ({
  load: vi.fn()
}));

vi.mock("./pdfViewerEngine", () => ({ loadPdfEngine: engine.load }));
vi.mock("pdfjs-dist/legacy/web/pdf_viewer.css", () => ({}));

class FakeBus {
  listeners = new Map<string, Set<Listener>>();
  dispatched: { name: string; data: unknown }[] = [];
  on(name: string, listener: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  off(name: string, listener: Listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string, data: unknown) {
    this.dispatched.push({ name, data });
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(data as never);
  }
}

function fakeEngine(overrides: Readonly<{
  documentError?: unknown;
  firstPageError?: unknown;
  neverRenders?: boolean;
  numPages?: number;
}> = {}) {
  const buses: FakeBus[] = [];
  const viewers: FakeViewer[] = [];
  const links: { addLinkAttributes(link: HTMLAnchorElement, url: string): void; setDocument: ReturnType<typeof vi.fn> }[] = [];
  const destroy = vi.fn(() => Promise.resolve());
  const getDocument = vi.fn((options: Record<string, unknown>) => {
    void options;
    return {
      destroy,
      promise: overrides.documentError
        ? Promise.reject(overrides.documentError)
        : Promise.resolve({
          getPage: () => overrides.firstPageError ? Promise.reject(overrides.firstPageError) : Promise.resolve({}),
          numPages: overrides.numPages ?? 3
        })
    };
  });
  class FakeViewer {
    currentScaleValue = "auto";
    scale = 1;
    setDocument = vi.fn((document: unknown) => {
      if (!document || overrides.neverRenders) return;
      queueMicrotask(() => {
        this.options.eventBus.dispatch("pagesinit", {});
        this.options.eventBus.dispatch("pagerendered", { pageNumber: 1 });
      });
    });
    constructor(readonly options: { eventBus: FakeBus; abortSignal: AbortSignal; container: HTMLElement } & Record<string, unknown>) {
      viewers.push(this);
    }
    get currentScale() { return this.scale; }
    set currentScale(value: number) {
      this.scale = value;
      this.options.eventBus.dispatch("scalechanging", { scale: value });
    }
  }
  const result = {
    assetBase: "http://localhost/pdfjs/1.2.3/",
    buses, destroy, getDocument, links, viewers,
    lib: { getDocument },
    viewer: {
      EventBus: class extends FakeBus { constructor() { super(); buses.push(this); } },
      FindState: { FOUND: 0, NOT_FOUND: 1, PENDING: 3, WRAPPED: 2 },
      PDFFindController: class { setDocument = vi.fn(); },
      PDFLinkService: class {
        externalLinkEnabled = true;
        addLinkAttributes = () => undefined;
        setDocument = vi.fn();
        setViewer = vi.fn();
        constructor() { links.push(this); }
      },
      PDFViewer: FakeViewer
    }
  };
  engine.load.mockResolvedValue(result);
  return result;
}

const pdfResponse = (headers: Record<string, string> = {}) => new Response(new Uint8Array([37, 80, 68, 70]), { headers });
const props = { byteSize: null, canSave: false, fileId: "file-1", fileName: "отчёт.pdf" };

function stubFetch(response: Response | Promise<Response> = pdfResponse()) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => { engine.load.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("PDF viewer", () => {
  it("fetches through the authorized route, hands pdf.js only bytes, and shows loading until the first page", async () => {
    const fake = fakeEngine();
    const fetchMock = stubFetch();
    render(<PdfViewerV2 {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading preview");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/attachments/file-1/content");
    const options = fake.getDocument.mock.calls[0][0];
    expect(options.data).toBeInstanceOf(Uint8Array);
    expect(options).not.toHaveProperty("url");
    expect(options).toMatchObject({ enableXfa: false, isEvalSupported: false, useWasm: false, wasmUrl: `${fake.assetBase}wasm/` });
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("1 / 3");
    expect(fake.viewers[0].options.annotationMode).toBe(1);
    expect(fake.viewers[0].options).not.toHaveProperty("scriptingManager");
  });

  it.each([404, 401, 403])("a %i is a visible unavailable state with nothing to download and no pdf.js", async status => {
    fakeEngine();
    stubFetch(new Response("{}", { status }));
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This file is unavailable.");
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(engine.load).not.toHaveBeenCalled();
  });

  it("a server failure offers Download", async () => {
    fakeEngine();
    stubFetch(new Response("{}", { status: 503 }));
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn’t be loaded");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/attachments/file-1/content");
  });

  it("refuses a known oversized file before any request", async () => {
    fakeEngine();
    const fetchMock = stubFetch();
    render(<PdfViewerV2 {...props} byteSize={PDF_PREVIEW_MAX_BYTES + 1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Download" })).toBeVisible();
  });

  it("refuses a declared oversized response before parsing", async () => {
    fakeEngine();
    stubFetch(pdfResponse({ "content-length": String(PDF_PREVIEW_MAX_BYTES + 1) }));
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than");
    expect(engine.load).not.toHaveBeenCalled();
  });

  it("stops reading a response that grows past the bound without declaring it", async () => {
    fakeEngine();
    const cancel = vi.fn();
    let sent = 0;
    const chunk = new Uint8Array(16 * 1024 * 1024);
    stubFetch(new Response(new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        sent += 1;
        if (sent > 10) controller.close();
        else controller.enqueue(chunk);
      }
    })));
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than");
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThan(10);
  });

  it.each([
    ["PasswordException", "password-protected"],
    ["InvalidPDFException", "damaged"],
    ["UnknownErrorException", "couldn’t be loaded"]
  ])("%s is a visible failure with Download, and the worker ends", async (name, copy) => {
    const fake = fakeEngine({ documentError: Object.assign(new Error("synthetic"), { name }) });
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.getByRole("link", { name: "Download" })).toBeVisible();
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("refuses a page count it will not lay out, before building any page", async () => {
    const fake = fakeEngine({ numPages: PDF_VIEWER_MAX_PAGES + 1 });
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("pages");
    expect(fake.viewers).toHaveLength(0);
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("a first page that cannot be read fails visibly", async () => {
    const fake = fakeEngine({ firstPageError: new Error("synthetic"), neverRenders: true });
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("damaged");
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("a first page that fails to paint fails visibly, and a cancelled paint does not", async () => {
    const fake = fakeEngine({ neverRenders: true });
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    await waitFor(() => expect(fake.viewers).toHaveLength(1));
    await act(async () => {
      fake.buses[0].dispatch("pagerendered", { error: { name: "RenderingCancelledException" }, pageNumber: 1 });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { fake.buses[0].dispatch("pagerendered", { error: { name: "Error" }, pageNumber: 1 }); });
    expect(screen.getByRole("alert")).toHaveTextContent("damaged");
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("the watchdog ends a load or first paint that exceeds its bound", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = fakeEngine({ neverRenders: true });
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    await vi.waitFor(() => expect(fake.viewers).toHaveLength(1));
    expect(fake.destroy).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(PDF_VIEWER_OPEN_TIMEOUT_MS + 1); });
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(screen.getByRole("link", { name: "Download" })).toBeVisible();
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("closing during the fetch aborts it and never starts pdf.js", async () => {
    fakeEngine();
    let resolve!: (response: Response) => void;
    const fetchMock = stubFetch(new Promise<Response>(settle => { resolve = settle; }));
    const { unmount } = render(<PdfViewerV2 {...props} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(pdfResponse()); });
    expect(engine.load).not.toHaveBeenCalled();
  });

  it("closing destroys the task and worker, the pages and their listeners", async () => {
    const fake = fakeEngine();
    stubFetch();
    const { unmount } = render(<PdfViewerV2 {...props} />);
    await waitFor(() => expect(fake.viewers).toHaveLength(1));
    const [viewer] = fake.viewers;
    unmount();
    expect(viewer.setDocument).toHaveBeenLastCalledWith(null);
    expect(viewer.options.abortSignal.aborted).toBe(true);
    expect(fake.links[0].setDocument).toHaveBeenLastCalledWith(null);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("a PDF's web link opens only after the full-address confirmation, and other schemes stay inert", async () => {
    const fake = fakeEngine();
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    await waitFor(() => expect(fake.links).toHaveLength(1));
    const open = vi.fn();
    vi.stubGlobal("open", open);

    const web = document.createElement("a");
    fake.links[0].addLinkAttributes(web, "https://example.test/from-pdf");
    expect(web.getAttribute("href")).toBe("#");
    expect(web.target).toBe("");
    await act(async () => { web.onclick?.(new MouseEvent("click")); });
    const dialog = await screen.findByRole("dialog", { name: "Open external link?" });
    expect(dialog).toHaveTextContent("This link is in the PDF.");
    expect(dialog).toHaveTextContent("https://example.test/from-pdf");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(open).toHaveBeenCalledWith("https://example.test/from-pdf", "_blank", "noopener,noreferrer");

    for (const hostile of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:a@example.test", "https://bank.test@evil.test/"]) {
      const link = document.createElement("a");
      fake.links[0].addLinkAttributes(link, hostile);
      expect(link.getAttribute("href")).toBe("#");
      expect(link.title).not.toContain(hostile);
      expect(link.getAttribute("aria-disabled")).toBe("true");
      await act(async () => { expect(link.onclick?.(new MouseEvent("click"))).toBe(false); });
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("searches, steps through matches, and closes the search before the viewer on Escape", async () => {
    const fake = fakeEngine();
    stubFetch();
    const onViewerEscape = vi.fn();
    render(<div onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) onViewerEscape(); }}><PdfViewerV2 {...props} /></div>);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    const input = await screen.findByRole("searchbox", { name: "Search text" });
    fireEvent.change(input, { target: { value: "страница" } });
    const finds = () => fake.buses[0].dispatched.filter(event => event.name === "find").map(event => event.data as Record<string, unknown>);
    expect(finds().at(-1)).toMatchObject({ query: "страница", type: "" });
    await act(async () => {
      fake.buses[0].dispatch("updatefindcontrolstate", { matchesCount: { current: 0, total: 0 }, state: 3 });
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("Searching");
    await act(async () => {
      fake.buses[0].dispatch("updatefindmatchescount", { matchesCount: { current: 1, total: 4 } });
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("1 of 4");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(finds().at(-1)).toMatchObject({ findPrevious: true, type: "again" });
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(finds().at(-1)).toMatchObject({ findPrevious: false, type: "again" });
    await act(async () => {
      fake.buses[0].dispatch("updatefindcontrolstate", { matchesCount: { current: 0, total: 0 }, state: 1 });
    });
    expect(screen.getByTestId("pdf-search-count")).toHaveTextContent("No matches");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onViewerEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(fake.buses[0].dispatched.some(event => event.name === "findbarclose")).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Search in document" })).toHaveFocus());
  });

  it("zooms within its bounds and fits again", async () => {
    const fake = fakeEngine();
    stubFetch();
    render(<PdfViewerV2 {...props} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: /^Fit page/u })).toHaveTextContent("125%");
    for (let step = 0; step < 12; step += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fake.viewers[0].scale).toBe(4);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Fit page/u }));
    expect(fake.viewers[0].currentScaleValue).toBe("auto");
  });

  it("offers Save to Files only when the file can be saved", async () => {
    fakeEngine();
    stubFetch();
    const { rerender } = render(<PdfViewerV2 {...props} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByRole("button", { name: "Save to Files" })).toBeNull();
    rerender(<PdfViewerV2 {...props} canSave />);
    expect(screen.getByRole("button", { name: "Save to Files" })).toBeVisible();
  });
});
