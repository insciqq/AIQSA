import { resolveObjectURL } from "node:buffer";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_FRAGMENT_PLACEHOLDER, ARTIFACT_STORAGE_PLACEHOLDER, parseArtifactNavigateMessage } from "../../contracts/artifactRuntime";
import { ARTIFACT_RUNTIME_BRIDGE, ARTIFACT_SITE_PLACEHOLDER, artifactRuntimeBridge, type ArtifactRuntimeSite } from "./runtimeBridge";

function bridge(initial: Array<[string, string]> = []) {
  const postMessage = vi.fn();
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const destination = { scrollIntoView: vi.fn() };
  const document = { addEventListener: (name: string, action: (event: Record<string, unknown>) => void) => listeners.set(name, action),
    getElementById: vi.fn((id: string) => id === "section name" ? destination : null), getElementsByName: vi.fn(() => []) };
  const window = { addEventListener: vi.fn(), scrollTo: vi.fn() } as unknown as Window;
  // Execute the shipped source with isolated browser facades, including its
  // synchronous quota behavior; there are no network or provider calls.
  new Function("window", "document", "parent", "DOMException", "URL", ARTIFACT_RUNTIME_BRIDGE.replace(
    ARTIFACT_STORAGE_PLACEHOLDER, JSON.stringify(initial).replaceAll("<", "\\u003c")
  ))(window, document, { postMessage }, DOMException, URL);
  return { window, document, destination, postMessage, listeners };
}

describe("artifact sandbox bridge", () => {
  it("initializes opaque state synchronously, preserves special keys and keeps sessions private", () => {
    const h = bridge([["__proto__", "</script><script>synthetic()</script>"]]);
    expect(h.window.localStorage.getItem("__proto__")).toBe("</script><script>synthetic()</script>");
    h.window.localStorage.setItem("constructor", "value");
    expect(h.window.localStorage.length).toBe(2);
    expect(h.window.localStorage.key(0)).toBe("__proto__");
    expect(h.postMessage).toHaveBeenCalledWith({ type: "aiqsa_artifact_storage_set", key: "constructor", value: "value" }, "*");
    h.postMessage.mockClear();
    h.window.sessionStorage.setItem("temporary", "private");
    expect(h.window.sessionStorage.getItem("temporary")).toBe("private");
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(Reflect.get(h.document, "cookie")).toBe("");
    Reflect.set(h.document, "cookie", "synthetic=value");
    expect(Reflect.get(h.document, "cookie")).toBe("");
  });

  it("rejects UTF-16/map/count quota before mutating values or notifying the parent", () => {
    const h = bridge();
    const store = h.window.localStorage;
    store.setItem("key", "old"); h.postMessage.mockClear();
    expect(() => store.setItem("key", "🙂".repeat(8193))).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(store.getItem("key")).toBe("old");
    expect(h.postMessage).not.toHaveBeenCalled();
    store.clear();
    for (let i = 0; i < 64; i++) store.setItem(String(i), "");
    expect(() => store.setItem("one-too-many", "")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(store.length).toBe(64);
    store.clear();
    for (let i = 0; i < 7; i++) store.setItem(String(i), "a".repeat(16384));
    expect(() => store.setItem("eighth", "a".repeat(16384))).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(store.length).toBe(7);
  });

  it("mediates clicks, Enter and window.open while leaving fragment links and local downloads usable", () => {
    const h = bridge();
    const event = (href: string, type: string, download = false) => ({ type, key: "Enter", preventDefault: vi.fn(),
      target: { closest: () => ({ getAttribute: () => href, hasAttribute: () => download }) } });
    for (const type of ["click", "keydown"]) {
      const e = event("https://example.invalid/path", type);
      h.listeners.get(type)!(e);
      expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    expect(h.postMessage).toHaveBeenCalledTimes(2);
    expect(h.window.open("mailto:person@example.invalid")).toBeNull();
    expect(h.postMessage).toHaveBeenLastCalledWith({ type: "aiqsa_artifact_open_link", href: "mailto:person@example.invalid" }, "*");
    const fragment = event("#section%20name", "click"); h.listeners.get("click")!(fragment);
    expect(fragment.preventDefault).toHaveBeenCalledOnce();
    expect(h.destination.scrollIntoView).toHaveBeenCalledOnce();
    const top = event("#top", "keydown"); h.listeners.get("keydown")!(top);
    expect(top.preventDefault).toHaveBeenCalledOnce();
    expect(h.window.scrollTo).toHaveBeenCalledWith(0, 0);
    const download = event("blob:null/synthetic", "click", true); h.listeners.get("click")!(download);
    expect(download.preventDefault).not.toHaveBeenCalled();
    const script = event("javascript:synthetic()", "click"); h.listeners.get("click")!(script);
    expect(script.preventDefault).toHaveBeenCalledOnce();
    h.window.open("javascript:synthetic()");
    expect(h.postMessage).toHaveBeenCalledTimes(3);
    // A root-relative link is a local path: a missing one is reported, never navigated.
    const local = event("/api/private", "click"); h.listeners.get("click")!(local);
    expect(local.preventDefault).toHaveBeenCalledOnce();
    expect(h.postMessage).toHaveBeenLastCalledWith({ type: "aiqsa_artifact_runtime_error", kind: "error",
      message: "Artifact link target not found: api/private", line: 0, column: 0 }, "*");
  });

  const WEBRTC_GLOBALS = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection",
    "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription", "RTCCertificate"] as const;

  /** Runs the shipped bridge source against a window pre-seeded with browser globals. */
  function runBridge(window: Record<string, unknown>): void {
    const document = { addEventListener: vi.fn(), getElementById: vi.fn(() => null), getElementsByName: vi.fn(() => []) };
    new Function("window", "document", "parent", "DOMException", "URL",
      ARTIFACT_RUNTIME_BRIDGE.replace(ARTIFACT_STORAGE_PLACEHOLDER, "[]"))(window, document, { postMessage: vi.fn() }, DOMException, URL);
  }

  it("deletes every WebRTC entry point so no peer connection or STUN channel can open", () => {
    const window: Record<string, unknown> = { addEventListener: vi.fn(), scrollTo: vi.fn() };
    for (const name of WEBRTC_GLOBALS) window[name] = class {};
    // A global the bridge never touches must survive untouched.
    const sentinel = class WebSocket {};
    window.WebSocket = sentinel;
    runBridge(window);
    for (const name of WEBRTC_GLOBALS) {
      expect(name in window, name).toBe(false);
      expect(window[name], name).toBeUndefined();
    }
    expect(window.WebSocket).toBe(sentinel);
  });

  it("neutralizes a WebRTC global defined only on the prototype chain", () => {
    // An engine may expose the constructor through the global's prototype rather
    // than as an own property; overwriting the own slot with undefined shadows it.
    const window: Record<string, unknown> = Object.create({ RTCPeerConnection: class {} });
    window.addEventListener = vi.fn(); window.scrollTo = vi.fn();
    runBridge(window);
    expect(window.RTCPeerConnection).toBeUndefined();
    expect((window as { localStorage?: unknown }).localStorage).toBeDefined();
  });

  it("does not throw when a WebRTC global cannot be deleted or redefined", () => {
    const window: Record<string, unknown> = { addEventListener: vi.fn(), scrollTo: vi.fn() };
    Object.defineProperty(window, "RTCPeerConnection", { configurable: false, writable: false, value: class {} });
    for (const name of WEBRTC_GLOBALS.slice(1)) window[name] = class {};
    expect(() => runBridge(window)).not.toThrow();
    // The locked global is a stated residual; every removable one is still gone,
    // and the bridge finished setting up (storage is defined).
    for (const name of WEBRTC_GLOBALS.slice(1)) expect(name in window, name).toBe(false);
    expect((window as { localStorage?: unknown }).localStorage).toBeDefined();
  });
});

type Site = Partial<Pick<ArtifactRuntimeSite, "page" | "media">> & { files?: ArtifactRuntimeSite["files"] };

/** Runs the bridge for one page against browser-shaped fakes: a native XHR and fetch that only
 * record calls, src-bearing elements, and the page's base64 file blocks. */
function localBridge(site: Site = {}, blocks: Record<string, string | Uint8Array> = {}, baseURI = "https://app.example/c/chat-1") {
  const postMessage = vi.fn();
  const listeners = new Map<string, (event: unknown) => void>();
  class NativeXHR extends EventTarget {
    calls: unknown[][] = [];
    responseType: XMLHttpRequestResponseType = "";
    open(...args: unknown[]) { this.calls.push(["open", ...args]); }
    send(...args: unknown[]) { this.calls.push(["send", ...args]); }
    abort() { this.calls.push(["abort"]); }
    setRequestHeader(...args: unknown[]) { this.calls.push(["setRequestHeader", ...args]); }
    overrideMimeType(...args: unknown[]) { this.calls.push(["overrideMimeType", ...args]); }
    getResponseHeader(name: string): string | null { return name ? "native" : null; }
    getAllResponseHeaders() { return "native"; }
    get readyState() { return 0; }
    get status() { return 0; }
    get statusText() { return "native"; }
    get response(): unknown { return "native"; }
    get responseText() { return "native"; }
    get responseURL() { return "https://native.example/"; }
    get responseXML() { return null; }
  }
  class FakeElement {
    attributes = new Map<string, string>();
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  }
  class FakeImage extends FakeElement {
    assigned: string[] = [];
    get src() { return this.attributes.get("src") ?? ""; }
    set src(value: string) { this.assigned.push(value); this.attributes.set("src", value); }
  }
  class NativeWorker { args: unknown[]; constructor(...args: unknown[]) { this.args = args; } }
  class FakeMedia extends FakeImage { localName = "audio"; nodeType = 1; networkState = 0; load = vi.fn(); }
  class FakeSource extends FakeImage { localName = "source"; nodeType = 1; parentNode: unknown = null; }
  const blockNodes = Object.entries(blocks).map(([path, data]) => ({ textContent: Buffer.from(data).toString("base64"),
    getAttribute: (name: string) => name === "data-aiqsa-file" ? path : null }));
  const downloads: Array<{ href: string; download: string; style: object; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = [];
  const document = {
    baseURI,
    body: { appendChild: vi.fn() },
    documentElement: { nodeType: 1, matches: () => false, querySelectorAll: vi.fn((): unknown[] => []) },
    addEventListener: (name: string, action: (event: unknown) => void) => listeners.set(name, action),
    querySelectorAll: vi.fn((selector: string) => selector === "script[data-aiqsa-file]" ? blockNodes : []),
    getElementById: vi.fn(() => null), getElementsByName: vi.fn(() => []),
    createElement: () => { const anchor = { href: "", download: "", style: {}, click: vi.fn(), remove: vi.fn() }; downloads.push(anchor); return anchor; }
  };
  const nativeFetch = vi.fn(async (...args: unknown[]) => new Response(`native ${args.length}`));
  const window = { addEventListener: vi.fn(), scrollTo: vi.fn(), fetch: nativeFetch as (input?: unknown, init?: RequestInit) => Promise<Response>,
    XMLHttpRequest: NativeXHR, Worker: NativeWorker as unknown as typeof Worker, Element: FakeElement, HTMLImageElement: FakeImage, HTMLMediaElement: FakeMedia, HTMLSourceElement: FakeSource };
  new Function("window", "document", "parent", "DOMException", "URL", artifactRuntimeBridge({ page: "index.html", media: false, files: [], ...site })
    .replace(ARTIFACT_STORAGE_PLACEHOLDER, "[]"))(window, document, { postMessage }, DOMException, URL);
  const click = (href: string, download: string | null = null) => {
    const anchor = { getAttribute: (name: string) => name === "href" ? href : name === "download" ? download : null, hasAttribute: (name: string) => name === "download" && download !== null };
    const event = { type: "click", preventDefault: vi.fn(), target: { closest: () => anchor } };
    listeners.get("click")!(event);
    return event;
  };
  return { window, document, postMessage, listeners, nativeFetch, downloads, click, NativeXHR, NativeWorker, FakeElement, FakeImage, FakeMedia, FakeSource };
}

describe("artifact local files", () => {
  it("serves local fetch reads from embedded bytes and passes every other request to the browser unchanged", async () => {
    const h = localBridge({ page: "docs/index.html", files: [["docs/index.html", "text/html", "page"], ["data.json", "application/json", "block"],
      ["docs/data.json", "application/json", "block"], ["docs/inline.png", "image/png", "inline"]] },
    { "data.json": '{"root":true}', "docs/data.json": '{"docs":true}' }, "https://app.example/c/chat-1?page=docs");
    const read = async (input: unknown, init?: RequestInit) => {
      const response = await h.window.fetch(input, init);
      return [response.status, response.headers.get("content-type"), await response.text()];
    };
    const docs = [200, "application/json", '{"docs":true}'], root = [200, "application/json", '{"root":true}'];
    expect(await read("data.json")).toEqual(docs);
    expect(await read(" ./data.json?cache=1#part ")).toEqual(docs);
    expect(await read("/data.json")).toEqual(root);
    expect(await read("../data.json")).toEqual(root);
    expect(await read(new URL("data.json", "https://app.example/c/chat-1"))).toEqual(docs);
    expect(await read(new Request("https://app.example/c/data.json"))).toEqual(docs);
    expect(await read("data.json", { method: "get" })).toEqual(docs);
    const head = await h.window.fetch("data.json", { method: "HEAD" });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "13", ""]);
    expect((await h.window.fetch("missing.json")).status).toBe(404);
    expect((await h.window.fetch("../../escape.json")).status).toBe(404);
    expect(h.nativeFetch).not.toHaveBeenCalled();
    await expect(h.window.fetch("data.json", { method: "POST", body: "x" })).rejects.toThrow(TypeError);
    const aborted = new AbortController(); aborted.abort();
    await expect(h.window.fetch("data.json", { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.postMessage).not.toHaveBeenCalled();
    await expect(h.window.fetch("inline.png")).rejects.toThrow("docs/inline.png is inlined into this page");
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "aiqsa_artifact_runtime_error", kind: "error",
      message: expect.stringContaining("so fetch cannot read it") }), "*");
    const external = ["https://example.invalid/data.json", "//example.invalid/data.json", "https://app.example/other/data.json", "blob:https://app.example/1", "", "?page=x", "#data"];
    for (const input of external) await h.window.fetch(input);
    expect(h.nativeFetch.mock.calls.map(call => call[0])).toEqual(external);
  });

  it("answers local XMLHttpRequest reads with ordered events and typed responses", async () => {
    const h = localBridge({ files: [["data.json", "application/json", "block"], ["page.html", "text/html", "page"]] }, { "data.json": '{"answer":42}' });
    const request = new h.NativeXHR();
    const events: string[] = [];
    for (const type of ["readystatechange", "loadstart", "progress", "load", "error", "loadend"]) request.addEventListener(type, () => events.push(`${type}:${request.readyState}`));
    const done = new Promise(resolve => request.addEventListener("loadend", resolve));
    request.open("GET", "data.json");
    request.setRequestHeader("Accept", "application/json");
    request.responseType = "json";
    request.send();
    expect(events).toEqual(["readystatechange:1", "loadstart:1"]);
    await done;
    expect(events).toEqual(["readystatechange:1", "loadstart:1", "readystatechange:2", "readystatechange:3", "progress:3", "readystatechange:4", "load:4", "loadend:4"]);
    expect([request.status, request.statusText, request.response]).toEqual([200, "OK", { answer: 42 }]);
    expect(request.getResponseHeader("Content-Type")).toBe("application/json");
    expect(request.getAllResponseHeaders()).toBe("content-length: 13\r\ncontent-type: application/json\r\n");
    expect(() => request.responseText).toThrow(DOMException);
    expect(request.calls).toEqual([]);
    const read = (responseType: XMLHttpRequestResponseType) => {
      const sync = new h.NativeXHR();
      sync.open("GET", "/data.json", false); sync.responseType = responseType; sync.send();
      return sync;
    };
    expect(read("").responseText).toBe('{"answer":42}');
    expect(read("text").response).toBe('{"answer":42}');
    expect(new TextDecoder().decode(read("arraybuffer").response as ArrayBuffer)).toBe('{"answer":42}');
    expect(await (read("blob").response as Blob).text()).toBe('{"answer":42}');
    const missing = new h.NativeXHR(); missing.open("GET", "missing.json", false); missing.send();
    expect([missing.status, missing.responseText, missing.getResponseHeader("content-type")]).toEqual([404, "", null]);
    const head = new h.NativeXHR(); head.open("HEAD", "data.json", false); head.send();
    expect([head.status, head.responseText, head.getResponseHeader("content-length")]).toEqual([200, "", "13"]);
    const post = new h.NativeXHR(); post.open("POST", "data.json", false);
    expect(() => post.send("x")).toThrow(expect.objectContaining({ name: "NetworkError" }));
    expect(h.postMessage).not.toHaveBeenCalled();
    const page = new h.NativeXHR();
    const failed = new Promise(resolve => page.addEventListener("error", resolve));
    page.open("GET", "page.html"); page.send(); await failed;
    expect([page.readyState, page.status]).toEqual([4, 0]);
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("page.html opens only through a link") }), "*");
    const external = new h.NativeXHR(); external.open("GET", "https://example.invalid/data.json"); external.send();
    expect(external.calls).toEqual([["open", "GET", "https://example.invalid/data.json"], ["send"]]);
    expect([external.readyState, external.responseText]).toEqual([0, "native"]);
    const aborted = new h.NativeXHR();
    const abortEvents: string[] = [];
    for (const type of ["readystatechange", "abort", "load", "loadend"]) aborted.addEventListener(type, () => abortEvents.push(`${type}:${aborted.readyState}`));
    aborted.open("GET", "data.json"); aborted.send(); aborted.abort();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(abortEvents).toEqual(["readystatechange:1", "readystatechange:4", "abort:4", "loadend:4"]);
    expect([aborted.readyState, aborted.status]).toEqual([0, 0]);
  });

  it("turns script-set local sources into one cached blob: URL and leaves other values alone", async () => {
    const h = localBridge({ files: [["img/a.png", "image/png", "block"], ["img/i.png", "image/png", "inline"]] }, { "img/a.png": new Uint8Array([137, 80, 78, 71]) });
    const image = new h.FakeImage();
    image.src = "img/a.png";
    const address = image.assigned[0]!;
    expect(address).toMatch(/^blob:/u);
    const blob = resolveObjectURL(address)!;
    expect([blob.type, [...new Uint8Array(await blob.arrayBuffer())]]).toEqual(["image/png", [137, 80, 78, 71]]);
    const other = new h.FakeImage();
    other.setAttribute("src", "./img/a.png?v=2");
    expect(other.getAttribute("src")).toBe(address);
    for (const value of ["https://example.invalid/a.png", "data:image/png;base64,AA==", "missing.png", ""]) image.src = value;
    expect(image.assigned.slice(1)).toEqual(["https://example.invalid/a.png", "data:image/png;base64,AA==", "data:,", ""]);
    const plain = new h.FakeElement();
    plain.setAttribute("src", "img/a.png");
    expect(plain.getAttribute("src")).toBe("img/a.png");
    expect(h.postMessage).not.toHaveBeenCalled();
    image.src = "img/i.png";
    expect(image.assigned.at(-1)).toBe("data:,");
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("img/i.png is inlined into this page") }), "*");
  });

  it("adopts renderer media sources once the document is parsed and restarts a media element that gave up", async () => {
    const h = localBridge({ media: true, files: [["clip.wav", "audio/wav", "block"]] }, { "clip.wav": "RIFF" });
    const audio = new h.FakeMedia();
    audio.setAttribute("data-aiqsa-src", "clip.wav");
    const video = new h.FakeMedia();
    video.networkState = 3;
    const source = new h.FakeSource();
    source.setAttribute("data-aiqsa-src", "clip.wav");
    source.parentNode = video;
    h.document.documentElement.querySelectorAll.mockReturnValue([audio, source]);
    h.listeners.get("DOMContentLoaded")!({});
    expect(audio.assigned).toEqual([expect.stringMatching(/^blob:/u)]);
    expect(source.assigned).toEqual(audio.assigned);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(video.load).toHaveBeenCalledOnce();
    h.listeners.get("DOMContentLoaded")!({});
    expect(audio.assigned).toHaveLength(1);
    expect(h.postMessage).not.toHaveBeenCalled();
  });

  it("navigates to local pages, downloads other local files and reports unavailable targets", () => {
    const files: ArtifactRuntimeSite["files"] = [["docs/index.html", "text/html", "page"], ["docs/b.html", "text/html", "page"], ["index.html", "text/html", "page"],
      ["files/report.csv", "text/csv", "block"], ["img/a.png", "image/png", "inline"]];
    const h = localBridge({ page: "docs/index.html", files }, { "files/report.csv": "a,b\n" });
    const navigate = (path: string, fragment?: string) => ({ type: "aiqsa_artifact_navigate", path, ...(fragment ? { fragment } : {}) });
    for (const [href, message] of [
      ["b.html#part", navigate("docs/b.html", "part")], ["../index.html", navigate("index.html")], ["/", navigate("index.html")],
      ["./", navigate("docs/index.html")], ["https://app.example/c/b.html?x=1", navigate("docs/b.html")], [`b.html#${"x".repeat(300)}`, navigate("docs/b.html")]
    ] as const) {
      expect(h.click(href).preventDefault).toHaveBeenCalledOnce();
      expect(h.postMessage).toHaveBeenLastCalledWith(message, "*");
      expect(parseArtifactNavigateMessage(h.postMessage.mock.lastCall![0])).toEqual({ path: message.path, ...("fragment" in message ? { fragment: message.fragment } : {}) });
    }
    h.postMessage.mockClear();
    h.click("index.html#top");
    expect(h.window.scrollTo).toHaveBeenCalledWith(0, 0);
    h.click("https://app.example/c/nothing.html");
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "aiqsa_artifact_open_link", href: "https://app.example/c/nothing.html" }, "*");
    h.click("/files/report.csv");
    h.click("../files/report.csv?x=1", "Report 2026.csv");
    expect(h.downloads.map(({ href, download }) => [href.slice(0, 5), download])).toEqual([["blob:", "report.csv"], ["blob:", "Report 2026.csv"]]);
    expect(h.downloads.every(anchor => anchor.click.mock.calls.length === 1 && anchor.remove.mock.calls.length === 1)).toBe(true);
    expect(h.document.body.appendChild).toHaveBeenCalledTimes(2);
    expect(h.postMessage).toHaveBeenCalledOnce();
    for (const [href, message] of [["missing.html", "Artifact link target not found: docs/missing.html"],
      ["../../outside.html", "Artifact link target not found: ../../outside.html"],
      ["../img/a.png", "Artifact file img/a.png is inlined into this page by a static reference or an exact path string, so a link cannot read it by path"]]) {
      const fresh = localBridge({ page: "docs/index.html", files });
      fresh.click(href!);
      expect(fresh.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "aiqsa_artifact_runtime_error", kind: "error", message, line: 0, column: 0 }, "*");
    }
  });

  it("decodes data: URLs for fetch locally with the Fetch rules and never calls the browser's fetch", async () => {
    const h = localBridge();
    const read = async (input: unknown, init?: RequestInit) => {
      const response = await h.window.fetch(input, init);
      return [response.status, response.headers.get("content-type"), [...new Uint8Array(await response.arrayBuffer())]];
    };
    const png = [137, 80, 78, 71, 0, 255];
    expect(await read(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)).toEqual([200, "image/png", png]);
    expect(await read(" DATA:Image/PNG ; Base64 ,iVBO\nRwD/#frag")).toEqual([200, "image/png", png]);
    expect(await read("data:,a%20b%FF")).toEqual([200, "text/plain;charset=US-ASCII", [97, 32, 98, 255]]);
    expect(await read("data:;charset=UTF-8,%D0%96")).toEqual([200, "text/plain;charset=UTF-8", [0xd0, 0x96]]);
    expect(await read("data:Text/HTML;Charset=windows-1251;charset=x,%CF")).toEqual([200, "text/html;charset=windows-1251", [0xcf]]);
    expect(await read("data:not a type,x")).toEqual([200, "text/plain;charset=US-ASCII", [120]]);
    expect(await read(new URL("data:application/json,%7B%7D"))).toEqual([200, "application/json", [123, 125]]);
    expect(await read(new Request("data:text/plain,req"))).toEqual([200, "text/plain", [114, 101, 113]]);
    expect(await (await h.window.fetch('data:application/json,{"a":1}')).json()).toEqual({ a: 1 });
    expect(await (await h.window.fetch("data:,body", { method: "HEAD" })).text()).toBe("");
    await expect(h.window.fetch("data:text/plain;base64")).rejects.toThrow("Invalid data: URL");
    await expect(h.window.fetch("data:;base64,a")).rejects.toThrow("Invalid data: URL");
    const aborted = new AbortController(); aborted.abort();
    await expect(h.window.fetch("data:,x", { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.nativeFetch).not.toHaveBeenCalled();
    expect(h.postMessage).not.toHaveBeenCalled();
    await h.window.fetch("datax:,x");
    await h.window.fetch("https://example.invalid/?u=data:,x");
    expect(h.nativeFetch.mock.calls.map(call => call[0])).toEqual(["datax:,x", "https://example.invalid/?u=data:,x"]);
  });

  it("answers XMLHttpRequest for data: URLs and decodes text with the response or overridden charset", async () => {
    const h = localBridge({ files: [["legacy.txt", "text/plain", "block"]] }, { "legacy.txt": new Uint8Array([0xcf, 0xf0]) });
    const sync = (url: string, setup: (request: InstanceType<typeof h.NativeXHR>) => void = () => {}) => {
      const request = new h.NativeXHR();
      request.open("GET", url, false); setup(request); request.send();
      return request;
    };
    const cp1251 = sync("data:text/plain;charset=windows-1251,%CF%F0");
    expect([cp1251.status, cp1251.responseText, cp1251.getResponseHeader("content-type")]).toEqual([200, "Пр", "text/plain;charset=windows-1251"]);
    expect(sync("data:text/plain,%D0%96").responseText).toBe("Ж");
    expect(sync("data:application/json;charset=windows-1251;base64,eyJhIjoi0JYifQ==", request => { request.responseType = "json"; }).response).toEqual({ a: "Ж" });
    expect([...new Uint8Array(sync("data:;base64,AAEC", request => { request.responseType = "arraybuffer"; }).response as ArrayBuffer)]).toEqual([0, 1, 2]);
    expect(sync("legacy.txt").responseText).toBe("��");
    expect(sync("legacy.txt", request => request.overrideMimeType("text/plain; charset=windows-1251")).responseText).toBe("Пр");
    // An override set before open() also reaches the browser's own request, and still applies locally.
    const early = new h.NativeXHR();
    early.overrideMimeType("text/plain;charset=windows-1251"); early.open("GET", "legacy.txt", false); early.send();
    expect([early.responseText, early.calls]).toEqual(["Пр", [["overrideMimeType", "text/plain;charset=windows-1251"]]]);
    expect((sync("data:,x", request => request.overrideMimeType("image/png")).response)).toBe("x");
    const blob = sync("data:,x", request => { request.overrideMimeType("image/png"); request.responseType = "blob"; }).response as Blob;
    expect(blob.type).toBe("image/png");
    const invalid = new h.NativeXHR(); invalid.open("GET", "data:text/plain", false);
    expect(() => invalid.send()).toThrow(expect.objectContaining({ name: "NetworkError" }));
    const async = new h.NativeXHR();
    const loaded = new Promise(resolve => async.addEventListener("load", resolve));
    async.open("GET", "data:,hello"); async.send(); await loaded;
    expect([async.readyState, async.status, async.responseText]).toEqual([4, 200, "hello"]);
    const unknown = sync("data:text/plain;charset=no-such-charset,%D0%96");
    expect(unknown.responseText).toBe("Ж");
    expect([cp1251, unknown, invalid, async].flatMap(request => request.calls)).toEqual([]);
    expect(h.postMessage).not.toHaveBeenCalled();
  });

  it("starts a Worker from a bundle script's blob: URL with the caller's options and leaves other addresses to the browser", async () => {
    const files: ArtifactRuntimeSite["files"] = [["index.html", "text/html", "page"], ["workers/sum.js", "text/javascript", "block"],
      ["data.json", "application/json", "block"], ["inline.js", "text/javascript", "inline"]];
    const h = localBridge({ files }, { "workers/sum.js": "onmessage = event => postMessage(event.data + 1);", "data.json": "{}" });
    const worker = new h.window.Worker("workers/sum.js", { type: "module", name: "sum" }) as unknown as InstanceType<typeof h.NativeWorker>;
    expect(worker).toBeInstanceOf(h.NativeWorker);
    expect(worker).toBeInstanceOf(h.window.Worker);
    const [address, options] = worker.args as [string, object];
    expect(options).toEqual({ type: "module", name: "sum" });
    const blob = resolveObjectURL(address)!;
    expect([blob.type, await blob.text()]).toEqual(["text/javascript", "onmessage = event => postMessage(event.data + 1);"]);
    const absolute = new h.window.Worker(new URL("workers/sum.js?v=2", h.document.baseURI)) as unknown as InstanceType<typeof h.NativeWorker>;
    expect(absolute.args).toEqual([address]);
    const external = ["https://example.invalid/w.js", "blob:https://app.example/1", "data:text/javascript,1"];
    for (const url of external) expect((new h.window.Worker(url) as unknown as InstanceType<typeof h.NativeWorker>).args).toEqual([url]);
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(() => (h.window.Worker as unknown as (url: string) => unknown)("workers/sum.js")).toThrow(TypeError);
    for (const [url, message] of [["missing.js", "Artifact worker script not found: missing.js"],
      ["data.json", "Artifact file data.json is not JavaScript, so a Worker cannot run it"],
      ["inline.js", "Artifact file inline.js is inlined into this page by a static reference or an exact path string, so a Worker cannot read it by path"]]) {
      const fresh = localBridge({ files });
      expect((new fresh.window.Worker(url!) as unknown as InstanceType<typeof h.NativeWorker>).args).toEqual([url]);
      expect(fresh.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "aiqsa_artifact_runtime_error", kind: "error", message, line: 0, column: 0 }, "*");
    }
  });

  it("embeds site data as one inert literal that cannot close the script or forge the storage marker", () => {
    const source = artifactRuntimeBridge({ page: "a.html", media: false, files: [["x</script><!--/*AIQSA_ARTIFACT_STORAGE_STATE*/[]/*AIQSA_ARTIFACT_FRAGMENT*/\"\"&", "text/plain", "block"]] });
    expect(source).not.toMatch(/<\/script|<!--/iu);
    expect(source.split(ARTIFACT_STORAGE_PLACEHOLDER)).toHaveLength(2);
    expect(source.split(ARTIFACT_FRAGMENT_PLACEHOLDER)).toHaveLength(2);
    expect(source).not.toContain(ARTIFACT_SITE_PLACEHOLDER);
    expect(ARTIFACT_RUNTIME_BRIDGE.split(ARTIFACT_SITE_PLACEHOLDER)).toHaveLength(2);
  });

  it("scrolls to the anchor named by the link that opened the page once the page has loaded", () => {
    const run = (fragment: string | null) => {
      const load = vi.fn<() => void>();
      const destination = { scrollIntoView: vi.fn() };
      const document = { addEventListener: vi.fn(), getElementById: vi.fn((id: string) => id === "part two" ? destination : null), getElementsByName: vi.fn(() => []) };
      const window = { scrollTo: vi.fn(), addEventListener: vi.fn((name: string, action: () => void, options?: unknown) => {
        if (name === "load") { expect(options).toEqual({ once: true }); load.mockImplementation(action); }
      }) };
      const source = ARTIFACT_RUNTIME_BRIDGE.replace(ARTIFACT_STORAGE_PLACEHOLDER, "[]")
        .replace(ARTIFACT_FRAGMENT_PLACEHOLDER, fragment === null ? ARTIFACT_FRAGMENT_PLACEHOLDER : JSON.stringify(fragment));
      new Function("window", "document", "parent", "DOMException", "URL", source)(window, document, { postMessage: vi.fn() }, DOMException, URL);
      return { load, destination, window };
    };
    const arrived = run("part%20two");
    expect(arrived.destination.scrollIntoView).not.toHaveBeenCalled();
    arrived.load();
    expect(arrived.destination.scrollIntoView).toHaveBeenCalledOnce();
    // The unfilled marker of a shared render is an empty fragment: nothing waits for load.
    for (const plain of [run(null), run("")]) {
      expect(plain.window.addEventListener.mock.calls.some(([name]) => name === "load")).toBe(false);
    }
  });
});

type HintWindow = Window & typeof globalThis & { eval(source: string): unknown };
// jsdom ships without type declarations; this is the one constructor the hint tests use.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { runScripts: "outside-only"; url: string }) => { window: HintWindow };
};
type Native = (...args: never[]) => unknown;
const XHTML = "http://www.w3.org/1999/xhtml";
const HINT = /(?:^|[\t\n\f\r ])(?:preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)(?:$|[\t\n\f\r ])/iu;
const MARKUP_HINT = /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\b(?:preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)\b|<i?frame\b[^>]*\b(?:srcdoc|src\s*=\s*["']?\s*javascript:)/iu;

/**
 * A real DOM (jsdom) with the shipped bridge on top. Before the bridge runs, every
 * native operation it captures is wrapped so that it records a violation whenever it
 * would connect a hint link or a nested document, or hand one to a connected link or
 * frame, as the engine would see it at that moment. Sinks jsdom lacks are recorders.
 * The wrappers read the DOM through natives captured first, so a page that later
 * replaces built-ins cannot hide a violation from them.
 */
function hintPage(body = '<div id="host"></div>') {
  const { window } = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { runScripts: "outside-only", url: "https://app.example/c/chat-1" });
  const proto = (name: string) => (window as unknown as Record<string, { prototype: Record<string, unknown> }>)[name]!.prototype;
  const descriptor = (name: string, key: string) => Object.getOwnPropertyDescriptor(proto(name), key)!;
  const reader = (name: string, key: string) => { const get = descriptor(name, key).get!; return (self: unknown) => Reflect.apply(get, self, []); };
  const methodOf = (name: string, key: string) => proto(name)[key] as Native;
  const call = (native: Native, self: unknown, ...args: unknown[]) => Reflect.apply(native, self, args);
  const raw = { getAttribute: methodOf("Element", "getAttribute"), setAttribute: methodOf("Element", "setAttribute"), appendChild: methodOf("Node", "appendChild") };
  const isConnected = reader("Node", "isConnected"), nodeType = reader("Node", "nodeType"), localName = reader("Element", "localName"),
    namespace = reader("Element", "namespaceURI"), shadowRoot = reader("Element", "shadowRoot"), listLength = reader("NodeList", "length"),
    attrOwner = reader("Attr", "ownerElement"), attrName = reader("Attr", "localName"), attrValue = reader("Attr", "value");
  const item = methodOf("NodeList", "item");
  const queries: Record<number, Native> = { 1: methodOf("Element", "querySelectorAll"), 9: methodOf("Document", "querySelectorAll"), 11: methodOf("DocumentFragment", "querySelectorAll") };
  const attribute = (element: unknown, name: string) => call(raw.getAttribute, element, name) as string | null;
  const connected = (node: unknown) => { try { return isConnected(node) === true; } catch { return false; } };
  const scriptUrl = (value: string) => value.replace(/[\t\n\r]/gu, "").replace(/^[\u0000- ]+/u, "").toLowerCase().startsWith("javascript:");
  const htmlName = (node: unknown) => { try { return nodeType(node) === 1 && namespace(node) === XHTML ? localName(node) as string : ""; } catch { return ""; } };
  // What a native insertion of node would connect that must never be connected.
  const unsafe = (node: unknown): string[] => {
    const found: string[] = [];
    const visit = (element: unknown) => {
      const name = htmlName(element);
      if (name === "link" && HINT.test(attribute(element, "rel") ?? "")) found.push(`link ${attribute(element, "rel")}`);
      if (name === "iframe" && attribute(element, "srcdoc")) found.push("iframe srcdoc");
      if ((name === "iframe" || name === "frame") && scriptUrl(attribute(element, "src") ?? "")) found.push(`${name} javascript:`);
      const shadow = name ? shadowRoot(element) : null;
      if (shadow) found.push(...unsafe(shadow));
    };
    let type: unknown;
    try { type = nodeType(node); } catch { return found; }
    if (type === 1) visit(node);
    const query = queries[type as number];
    if (query) {
      const list = call(query, node, "*");
      for (let i = 0, count = listLength(list) as number; i < count; i++) visit(call(item, list, i));
    }
    return found;
  };
  // What one attribute write would hand to an element that must never hold it.
  const attributeWrite = (element: unknown, name: string, value: unknown) => {
    const local = htmlName(element), text = String(value);
    if (local === "link" && name === "rel" && HINT.test(text) && connected(element)) return `link rel ${text}`;
    if (local === "link" && name === "href" && HINT.test(attribute(element, "rel") ?? "") && connected(element)) return "link href under a hint";
    if (local === "iframe" && name === "srcdoc" && text) return "iframe srcdoc";
    if ((local === "iframe" || local === "frame") && name === "src" && scriptUrl(text)) return `${local} src javascript:`;
    return null;
  };
  const violations: string[] = [], sinks: unknown[][] = [], written: string[] = [], executed: unknown[][] = [], posted: unknown[] = [];
  const flag = (where: string, found: string | null) => { if (found) violations.push(`${where}: ${found}`); };
  const spyMethod = (name: string, key: string, check: (self: unknown, args: unknown[]) => void) => {
    const owner = proto(name), native = owner[key] as Native | undefined;
    if (typeof native === "function") owner[key] = function (this: unknown, ...args: unknown[]) { check(this, args); return Reflect.apply(native, this, args); };
  };
  const spySetter = (name: string, key: string, check: (self: unknown, value: unknown) => void) => {
    const found = descriptor(name, key);
    Object.defineProperty(proto(name), key, { ...found, set(value: unknown) { check(this, value); Reflect.apply(found.set!, this, [value]); } });
  };
  const inserting = (first: number, count: number, always = false) => (self: unknown, args: unknown[]) => {
    if (always || connected(self)) for (const node of args.slice(first, count < 0 ? undefined : first + count)) for (const found of unsafe(node)) flag("insert", found);
  };
  for (const key of ["appendChild", "insertBefore", "replaceChild"]) spyMethod("Node", key, inserting(0, 1));
  for (const name of ["Element", "Document", "DocumentFragment"]) for (const key of ["append", "prepend", "replaceChildren"]) spyMethod(name, key, inserting(0, -1));
  for (const name of ["Element", "CharacterData"]) for (const key of ["before", "after", "replaceWith"]) spyMethod(name, key, inserting(0, -1));
  spyMethod("Element", "insertAdjacentElement", inserting(1, 1));
  spyMethod("Range", "insertNode", inserting(0, 1, true));
  spyMethod("Element", "setAttribute", (self, [name, value]) => flag("setAttribute", attributeWrite(self, String(name).toLowerCase(), value)));
  spyMethod("Element", "setAttributeNS", (self, [space, name, value]) => { if (space === null || space === "") flag("setAttributeNS", attributeWrite(self, String(name), value)); });
  for (const key of ["setAttributeNode", "setAttributeNodeNS"]) spyMethod("Element", key, (self, [attr]) => flag(key, attributeWrite(self, attrName(attr) as string, attrValue(attr))));
  const maps = new WeakMap<object, unknown>(), relLists = new WeakMap<object, unknown>();
  const attributes = descriptor("Element", "attributes");
  Object.defineProperty(proto("Element"), "attributes", { ...attributes, get() { const map = Reflect.apply(attributes.get!, this, []) as object; maps.set(map, this); return map; } });
  for (const key of ["setNamedItem", "setNamedItemNS"]) spyMethod("NamedNodeMap", key, (self, [attr]) => flag(key, attributeWrite(maps.get(self as object), attrName(attr) as string, attrValue(attr))));
  for (const [name, key] of [["HTMLLinkElement", "rel"], ["HTMLLinkElement", "href"], ["HTMLIFrameElement", "srcdoc"], ["HTMLIFrameElement", "src"], ["HTMLFrameElement", "src"]] as const) {
    spySetter(name, key, (self, value) => flag(`${name}.${key}`, attributeWrite(self, key, value)));
  }
  spySetter("Attr", "value", (self, value) => flag("Attr.value", attributeWrite(attrOwner(self), attrName(self) as string, value)));
  for (const key of ["textContent", "nodeValue"]) spySetter("Node", key, (self, value) => { if (nodeType(self) === 2) flag(`Attr.${key}`, attributeWrite(attrOwner(self), attrName(self) as string, value)); });
  const relList = descriptor("HTMLLinkElement", "relList");
  Object.defineProperty(proto("HTMLLinkElement"), "relList", { ...relList, get() { const list = Reflect.apply(relList.get!, this, []) as object; relLists.set(list, this); return list; } });
  const relWrite = (self: unknown, tokens: unknown[]) => {
    const link = relLists.get(self as object);
    if (link && connected(link) && tokens.some(token => HINT.test(String(token)))) violations.push(`relList: ${tokens.join(" ")}`);
  };
  spyMethod("DOMTokenList", "add", (self, tokens) => relWrite(self, tokens));
  spyMethod("DOMTokenList", "toggle", (self, [token, force]) => { if (force !== false) relWrite(self, [token]); });
  spyMethod("DOMTokenList", "replace", (self, [, token]) => relWrite(self, [token]));
  spySetter("DOMTokenList", "value", (self, value) => relWrite(self, [value]));
  const markupSink = (key: string) => (self: unknown, markup: unknown) => {
    sinks.push([key, self, markup]);
    // A template's markup lands in its inert content, never in the page.
    if (connected(self) && htmlName(self) !== "template" && MARKUP_HINT.test(String(markup))) violations.push(`${key}: native parse into this page`);
  };
  for (const name of ["Element", "ShadowRoot"]) spySetter(name, "innerHTML", markupSink(`${name}.innerHTML`));
  spySetter("Element", "outerHTML", markupSink("outerHTML"));
  spyMethod("Element", "insertAdjacentHTML", (self, [, markup]) => markupSink("insertAdjacentHTML")(self, markup));
  // Sinks that parse on their own are recorders: jsdom lacks some, and document.write
  // must not replace the test document.
  const record = (owner: Record<string, unknown>, key: string, log: (args: unknown[]) => void) => { owner[key] = (...args: unknown[]) => { log(args); }; };
  record(proto("Document"), "write", args => written.push(args.join("")));
  record(proto("Document"), "writeln", args => written.push(`${args.join("")}\n`));
  record(proto("Document"), "execCommand", args => executed.push(["execCommand", ...args]));
  for (const name of ["Element", "ShadowRoot"]) record(proto(name), "setHTMLUnsafe", args => executed.push([`${name}.setHTMLUnsafe`, ...args]));
  record(window.Document as unknown as Record<string, unknown>, "parseHTMLUnsafe", args => executed.push(["parseHTMLUnsafe", ...args]));
  window.postMessage = ((message: unknown) => { posted.push(message); }) as typeof window.postMessage;
  window.eval(ARTIFACT_RUNTIME_BRIDGE);
  return { window, document: window.document, violations, sinks, written, executed, posted, raw, unsafe };
}

describe("artifact resource hints and nested documents", () => {
  it("keeps hint tokens out of a link on every attribute path, case-insensitively and in order", () => {
    const page = hintPage();
    const { document } = page;
    const connectedLink = () => { const link = document.createElement("link"); link.href = "https://trap.example/"; document.head.append(link); return link; };
    const attr = (value: string) => { const node = document.createAttribute("rel"); node.value = value; return node; };
    const writes: Record<string, (link: HTMLLinkElement) => void> = {
      property: link => { link.rel = "Stylesheet PRECONNECT\ticon"; },
      setAttribute: link => link.setAttribute("REL", "dns-prefetch stylesheet"),
      setAttributeNS: link => link.setAttributeNS(null, "rel", "prefetch"),
      relListAdd: link => link.relList.add("preload", "icon"),
      relListToggle: link => { expect(link.relList.toggle("modulepreload")).toBe(false); },
      relListReplace: link => { link.rel = "author"; expect(link.relList.replace("author", "prerender")).toBe(true); },
      relListValue: link => { link.relList.value = "preconnect author"; },
      relListAssign: link => { Reflect.set(link, "relList", "preconnect"); },
      attrValue: link => { link.rel = "author"; link.getAttributeNode("rel")!.value = "preconnect"; },
      attrNodeValue: link => { link.rel = "author"; link.getAttributeNode("rel")!.nodeValue = "dns-prefetch"; },
      attrTextContent: link => { link.rel = "author"; link.getAttributeNode("rel")!.textContent = "prefetch"; },
      setAttributeNode: link => { link.setAttributeNode(attr("preconnect icon")); },
      setNamedItem: link => { link.attributes.setNamedItem(attr("dns-prefetch")); }
    };
    const rels = Object.fromEntries(Object.entries(writes).map(([name, write]) => { const link = connectedLink(); write(link); return [name, link.getAttribute("rel")]; }));
    expect(rels).toEqual({ property: "Stylesheet icon", setAttribute: "stylesheet", setAttributeNS: "", relListAdd: "icon", relListToggle: null, relListReplace: "",
      relListValue: "author", relListAssign: "", attrValue: "", attrNodeValue: "", attrTextContent: "", setAttributeNode: "icon", setNamedItem: "" });
    // A detached link is kept clean as well, so a later insertion has nothing to drop.
    const detached = document.createElement("link");
    detached.rel = "preconnect";
    expect(detached.getAttribute("rel")).toBe("");
    expect(page.violations).toEqual([]);
    expect(page.posted).toEqual([]);
  });

  it("drops a hint a link already carries before any insertion connects it or a new address reaches it", () => {
    const page = hintPage('<div id="host"></div><select id="select"></select>');
    const { document } = page;
    // A link that carries a hint through some path the bridge missed.
    const missed = () => { const link = document.createElement("link"); Reflect.apply(page.raw.setAttribute, link, ["rel", "preconnect stylesheet"]); return link; };
    const host = document.getElementById("host")!;
    const inserts: Record<string, (link: HTMLLinkElement) => void> = {
      appendChild: link => document.head.appendChild(link),
      insertBefore: link => document.body.insertBefore(link, host),
      replaceChild: link => { const old = document.createElement("i"); host.append(old); host.replaceChild(link, old); },
      append: link => document.head.append("text", link),
      prepend: link => host.prepend(link),
      before: link => host.before(link),
      after: link => host.after(link),
      replaceWith: link => { const old = document.createElement("i"); host.append(old); old.replaceWith(link); },
      replaceChildren: link => { const holder = document.createElement("div"); document.body.append(holder); holder.replaceChildren(link); },
      insertAdjacentElement: link => host.insertAdjacentElement("afterend", link),
      textAfter: link => { const text = document.createTextNode("t"); host.append(text); text.after(link); },
      rangeInsertNode: link => { const range = document.createRange(); range.selectNodeContents(host); range.insertNode(link); },
      fragment: link => { const fragment = document.createDocumentFragment(); fragment.append(link); host.append(fragment); },
      subtree: link => { const holder = document.createElement("div"); holder.append(document.createElement("b"), link); host.append(holder); },
      selectAdd: link => { const option = document.createElement("option"); option.append(link); (document.getElementById("select") as HTMLSelectElement).add(option); }
    };
    const rels = Object.fromEntries(Object.entries(inserts).map(([name, insert]) => { const link = missed(); insert(link); return [name, link.getAttribute("rel")]; }));
    expect(rels).toEqual(Object.fromEntries(Object.keys(inserts).map(name => [name, "stylesheet"])));
    // A detached parent only parks the link; the hint goes when that tree is connected.
    const parked = missed(), holder = document.createElement("div");
    holder.append(parked);
    expect(parked.getAttribute("rel")).toBe("preconnect stylesheet");
    host.append(holder);
    expect(parked.getAttribute("rel")).toBe("stylesheet");
    // Inside a closed shadow root of a detached host, connected with that host.
    const shadowHost = document.createElement("div"), shadowed = missed();
    Reflect.apply(page.raw.appendChild, shadowHost.attachShadow({ mode: "closed" }), [shadowed]);
    host.append(shadowHost);
    expect(shadowed.getAttribute("rel")).toBe("stylesheet");
    // A link connected around the bridge never takes a new address under its hint.
    const moved = missed();
    Reflect.apply(page.raw.appendChild, document.head, [moved]);
    moved.href = "https://trap.example/new";
    expect(moved.getAttribute("rel")).toBe("stylesheet");
    expect(page.violations).toEqual([]);
  });

  it("parses markup for this page like the target would and inserts only checked nodes", () => {
    const page = hintPage('<div id="host"></div><table id="table"></table><section id="shadow-host"></section><div id="positions"><p id="target">t</p></div><template id="template"></template>');
    const { document, window } = page;
    const markup = '<p>a</p><link rel="preconnect stylesheet" href="https://trap.example/"><iframe srcdoc="<b>nested</b>" src="https://example.invalid/"></iframe>' +
      '<template><link rel="preload" href="https://trap.example/t"></template>';
    const host = document.getElementById("host")!;
    host.innerHTML = markup;
    const detached = document.createElement("div");
    detached.innerHTML = markup;
    expect(host.innerHTML).toBe(detached.innerHTML);
    expect(host.innerHTML).toBe('<p>a</p><link rel="stylesheet" href="https://trap.example/"><iframe src="https://example.invalid/"></iframe><template><link rel="" href="https://trap.example/t"></template>');
    // Rows in a table get the implied tbody exactly as the native parse gives them.
    const table = document.getElementById("table")!, rows = '<tr><td>1</td></tr><link rel="dns-prefetch" href="https://trap.example/">';
    table.innerHTML = rows;
    const detachedTable = document.createElement("table");
    detachedTable.innerHTML = rows;
    expect(table.innerHTML).toBe(detachedTable.innerHTML);
    expect(table.querySelector("tbody > tr > td")?.textContent).toBe("1");
    const target = document.getElementById("target")!;
    for (const position of ["beforebegin", "afterbegin", "beforeend", "afterend"] as const) target.insertAdjacentHTML(position, `<link rel="prefetch" href="https://trap.example/${position}"><i>${position}</i>`);
    expect([...document.getElementById("positions")!.children].map(element => element.localName)).toEqual(["link", "i", "p", "link", "i"]);
    expect(target.innerHTML).toBe('<link rel="" href="https://trap.example/afterbegin"><i>afterbegin</i>t<link rel="" href="https://trap.example/beforeend"><i>beforeend</i>');
    target.outerHTML = '<link rel="preload" href="https://trap.example/outer"><b>outer</b>';
    const shadow = document.getElementById("shadow-host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<link rel="modulepreload" href="https://trap.example/shadow"><i>shadow</i>';
    expect(shadow.innerHTML).toBe('<link rel="" href="https://trap.example/shadow"><i>shadow</i>');
    const template = document.getElementById("template") as HTMLTemplateElement;
    template.innerHTML = '<link rel="preconnect" href="https://trap.example/template">';
    expect(template.content.querySelector("link")!.getAttribute("rel")).toBe("");
    // A custom element target parses like any element; no extra constructor runs.
    window.eval('window.built = 0; customElements.define("x-widget", class extends HTMLElement { constructor() { super(); window.built++; } });');
    const widget = document.createElement("x-widget");
    host.append(widget);
    widget.innerHTML = '<link rel="preconnect" href="https://trap.example/widget"><span>s</span>';
    expect([(window as unknown as { built: number }).built, widget.innerHTML]).toEqual([1, '<link rel="" href="https://trap.example/widget"><span>s</span>']);
    // Detached results are checked before any script can connect them.
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(page.unsafe(range.createContextualFragment('<link rel="preconnect" href="https://trap.example/range">'))).toEqual([]);
    const parsed = new window.DOMParser().parseFromString('<link rel="prefetch" href="https://trap.example/parsed"><template><link rel="preload" href="https://trap.example/inner"></template>', "text/html");
    expect([parsed.querySelector("link")!.getAttribute("rel"), (parsed.querySelector("template") as HTMLTemplateElement).content.querySelector("link")!.getAttribute("rel")]).toEqual(["", ""]);
    expect(page.unsafe(document)).toEqual([]);
    expect(page.violations).toEqual([]);
    expect(page.posted).toEqual([expect.objectContaining({ type: "aiqsa_artifact_runtime_error", message: expect.stringContaining("cannot show nested documents") })]);
  });

  it("leaves unrelated markup, nodes and attributes to the native operations", () => {
    const page = hintPage();
    const { document } = page;
    const host = document.getElementById("host")!;
    const plain = "<p>plain <b>markup</b> with &lt;link rel=preconnect&gt; as text</p>";
    page.sinks.length = 0;
    host.innerHTML = plain;
    host.insertAdjacentHTML("beforeend", "<i>more</i>");
    expect(page.sinks).toEqual([["Element.innerHTML", host, plain], ["insertAdjacentHTML", host, "<i>more</i>"]]);
    const anchor = document.createElement("a");
    anchor.setAttribute("rel", "prefetch");
    const svgLink = document.createElementNS("http://www.w3.org/2000/svg", "link");
    svgLink.setAttribute("rel", "preconnect");
    host.append(anchor, svgLink);
    const div = document.createElement("div");
    div.classList.add("preload");
    const frame = document.createElement("iframe");
    frame.src = "https://example.invalid/page";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://example.invalid/style.css";
    document.head.append(link);
    expect([anchor.rel, svgLink.getAttribute("rel"), div.className, frame.getAttribute("src"), link.getAttribute("rel")])
      .toEqual(["prefetch", "preconnect", "preload", "https://example.invalid/page", "stylesheet"]);
    expect(() => document.body.appendChild({} as Node)).toThrow();
    expect(() => document.body.setAttribute(Symbol("name") as unknown as string, "x")).toThrow();
    expect(page.posted).toEqual([]);
    expect(page.violations).toEqual([]);
  });

  it("renames link and frame tags in markup that a sink parses on its own and holds back a split tag name", async () => {
    const page = hintPage();
    const { document, window } = page;
    document.write('<p>x</p><link rel="preconnect" href="https://trap.example/a"><LINK/>');
    document.write("<if", "rame srcdoc='z'>q</iframe><frameset><frame src=x>");
    document.write("<li");
    document.write('nk rel="dns-prefetch" href="https://trap.example/b">');
    document.writeln("<lin");
    document.write("tail </IFRA");
    await Promise.resolve();
    // The end of the task dropped the dangling tag name instead of joining it later.
    document.write("me>");
    expect(page.written).toEqual([
      '<p>x</p><basefont data-aiqsa-link rel="preconnect" href="https://trap.example/a"><basefont data-aiqsa-link/>',
      "<noembed data-aiqsa-iframe srcdoc='z'>q</noembed><frameset><basefont data-aiqsa-frame src=x>",
      "",
      '<basefont data-aiqsa-link rel="dns-prefetch" href="https://trap.example/b">',
      "<lin\n",
      "tail ",
      "me>"
    ]);
    document.execCommand("insertHTML", false, '<link rel="preconnect" href="https://trap.example/c"><iframe src="javascript:1"></iframe>');
    document.execCommand("bold", false, "<link rel=preconnect>");
    document.execCommand("insertHTML");
    const host = document.getElementById("host")!;
    host.setHTMLUnsafe('<template shadowrootmode="closed"><link rel="preconnect" href="https://trap.example/d"></template>');
    (window.Document as unknown as { parseHTMLUnsafe(html: string): unknown }).parseHTMLUnsafe("<link rel=prefetch href=https://trap.example/e>");
    expect(page.executed).toEqual([
      ["execCommand", "insertHTML", false, '<basefont data-aiqsa-link rel="preconnect" href="https://trap.example/c"><noembed data-aiqsa-iframe src="javascript:1"></noembed>'],
      ["execCommand", "bold", false, "<link rel=preconnect>"],
      ["execCommand", "insertHTML"],
      ["Element.setHTMLUnsafe", '<template shadowrootmode="closed"><basefont data-aiqsa-link rel="preconnect" href="https://trap.example/d"></template>'],
      ["parseHTMLUnsafe", "<basefont data-aiqsa-link rel=prefetch href=https://trap.example/e>"]
    ]);
  });

  it("removes what a frame would show as a nested document and reports that once", () => {
    const page = hintPage();
    const { document } = page;
    const frame = document.createElement("iframe");
    frame.srcdoc = "<b>nested</b>";
    const srcdoc = frame.getAttribute("srcdoc");
    frame.setAttribute("SRCDOC", "<b>nested</b>");
    const values = [srcdoc, frame.getAttribute("srcdoc")];
    for (const address of [" \u0001java\tscript:alert(1)", "JAVASCRIPT:alert(1)", "https://example.invalid/", "about:blank"]) { frame.src = address; values.push(frame.getAttribute("src")); }
    const old = document.createElement("frame");
    old.setAttribute("src", "javascript:1");
    values.push(old.getAttribute("src"));
    const host = document.getElementById("host")!;
    host.innerHTML = '<iframe srcdoc="<b>x</b>" src="javascript:1"></iframe>';
    values.push(host.innerHTML);
    expect(values).toEqual(["", "", "about:blank", "about:blank", "https://example.invalid/", "about:blank", "about:blank", '<iframe src="about:blank"></iframe>']);
    expect(page.posted).toEqual([{ type: "aiqsa_artifact_runtime_error", kind: "error", line: 0, column: 0,
      message: "Artifact pages cannot show nested documents, so an iframe srcdoc or javascript: address was removed; render that content in the page itself" }]);
    expect(page.violations).toEqual([]);
  });

  it("keeps its decisions when the page later replaces the built-ins they use", () => {
    const page = hintPage();
    const { document, window } = page;
    window.eval(`
      Object.defineProperty(Array.prototype, "0", { set() {}, configurable: true });
      Object.defineProperty(NodeList.prototype, "length", { get: () => 0 });
      String.prototype.toLowerCase = () => "x"; String.prototype.split = () => []; String.prototype.slice = () => "";
      String.prototype.charCodeAt = () => 120; String.fromCharCode = () => "x";
      RegExp.prototype.exec = () => null; RegExp.prototype.test = () => false;
      Array.prototype[Symbol.iterator] = function* () {}; NodeList.prototype[Symbol.iterator] = function* () {};
      NodeList.prototype.item = () => null; Element.prototype.querySelectorAll = () => []; DocumentFragment.prototype.querySelectorAll = () => [];
      Element.prototype.getAttribute = () => null; WeakMap.prototype.get = () => undefined; WeakMap.prototype.set = function () { return this; };
      Function.prototype.call = () => undefined; Function.prototype.apply = () => undefined; Reflect.apply = () => undefined; Object.defineProperty = () => {};
    `);
    const rel = (element: Element) => Reflect.apply(page.raw.getAttribute, element, ["rel"]) as string | null;
    const link = document.createElement("link");
    document.head.append(link);
    link.rel = "preconnect icon";
    const listed = document.createElement("link");
    document.head.append(listed);
    listed.relList.add("preload");
    const host = document.getElementById("host")!;
    host.innerHTML = '<p>a</p><link rel="dns-prefetch" href="https://trap.example/">';
    const missed = document.createElement("link");
    Reflect.apply(page.raw.setAttribute, missed, ["rel", "prefetch"]);
    host.append(missed);
    document.write('<link rel="preconnect" href="https://trap.example/w">');
    expect([rel(link), rel(listed), rel(missed)]).toEqual(["icon", null, ""]);
    expect(page.written).toEqual(['<basefont data-aiqsa-link rel="preconnect" href="https://trap.example/w">']);
    expect(page.unsafe(document)).toEqual([]);
    expect(page.violations).toEqual([]);
  });
});
