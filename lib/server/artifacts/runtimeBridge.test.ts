import { resolveObjectURL } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_STORAGE_PLACEHOLDER, parseArtifactNavigateMessage } from "../../contracts/artifactRuntime";
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
    const source = artifactRuntimeBridge({ page: "a.html", media: false, files: [["x</script><!--/*AIQSA_ARTIFACT_STORAGE_STATE*/[]&", "text/plain", "block"]] });
    expect(source).not.toMatch(/<\/script|<!--/iu);
    expect(source.split(ARTIFACT_STORAGE_PLACEHOLDER)).toHaveLength(2);
    expect(source).not.toContain(ARTIFACT_SITE_PLACEHOLDER);
    expect(ARTIFACT_RUNTIME_BRIDGE.split(ARTIFACT_SITE_PLACEHOLDER)).toHaveLength(2);
  });
});
