import { ARTIFACT_FRAGMENT_PLACEHOLDER, ARTIFACT_STORAGE_LIMITS, ARTIFACT_STORAGE_PLACEHOLDER } from "../../contracts/artifactRuntime";

/** Per-page bridge data: the page path and its local files as `[path, mime, kind]`. A `block`
 * file's bytes are in this page; `inline` files were inlined by a static reference and `page`
 * files open through navigation, so neither can be read at runtime. */
export type ArtifactRuntimeSite = Readonly<{
  page: string;
  media: boolean;
  files: readonly (readonly [path: string, mime: string, kind: "page" | "block" | "inline"])[];
}>;

export const ARTIFACT_SITE_PLACEHOLDER = "/*AIQSA_ARTIFACT_SITE*/null";

/** Server-owned code runs before any authored script. The state and fragment
 * markers are filled only by the viewer; shared render caches always retain empty data.
 * Local files are answered only from bytes embedded in the page: every other
 * request reaches the browser unchanged and stays under the artifact CSP. */
export const ARTIFACT_RUNTIME_BRIDGE = String.raw`(() => {
  const initial = ${ARTIFACT_STORAGE_PLACEHOLDER};
  const site = ${ARTIFACT_SITE_PLACEHOLDER} || { page: "", media: false, files: [] };
  const arrival = ${ARTIFACT_FRAGMENT_PLACEHOLDER};
  const limits = ${JSON.stringify(ARTIFACT_STORAGE_LIMITS)};
  const send = value => { try { parent.postMessage(value, "*"); } catch {} };
  // WebRTC reaches the network outside every CSP fetch directive: an
  // RTCPeerConnection with a stun:/turn: server sends UDP STUN binding requests
  // to an arbitrary host — and resolves that host's DNS name, which can carry
  // private data — as soon as a data channel's offer is applied, with no camera
  // or microphone permission. The bridge runs before any authored script and
  // shares this opaque frame's only realm (nested frames are blocked by
  // child-src 'none'/frame-src, popups by the sandbox, and a Worker does not
  // expose RTCPeerConnection), so deleting the constructors leaves no way to
  // open one and no other realm to recover them from.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription", "RTCCertificate"]) {
    try { delete window[name]; } catch {}
    try { if (name in window) Object.defineProperty(window, name, { configurable: true, value: undefined }); } catch {}
  }
  const storage = (entries, persistent) => {
    let values = new Map(entries);
    const api = Object.create(null);
    const fits = next => next.size <= limits.maxKeys &&
      [...next].every(([key, value]) => key.length <= limits.maxKeyCharacters && value.length * 2 <= limits.maxValueBytes) &&
      JSON.stringify([...next]).length * 2 <= limits.maxMapBytes;
    if (!fits(values)) values = new Map();
    Object.defineProperties(api, {
      length: { get: () => values.size },
      getItem: { value: key => values.get(String(key)) ?? null },
      key: { value: index => [...values.keys()][Number(index) >>> 0] ?? null },
      setItem: { value: (key, value) => {
        key = String(key); value = String(value);
        const next = new Map(values); next.set(key, value);
        if (!fits(next)) throw new DOMException("Artifact storage quota exceeded", "QuotaExceededError");
        values = next;
        if (persistent) send({ type: "aiqsa_artifact_storage_set", key, value });
      } },
      removeItem: { value: key => {
        key = String(key); values.delete(key);
        if (persistent) send({ type: "aiqsa_artifact_storage_remove", key });
      } },
      clear: { value: () => {
        values.clear();
        if (persistent) send({ type: "aiqsa_artifact_storage_clear" });
      } }
    });
    return api;
  };
  try { Object.defineProperty(window, "localStorage", { value: storage(initial, true) }); } catch {}
  try { Object.defineProperty(window, "sessionStorage", { value: storage([], false) }); } catch {}
  try { Object.defineProperty(document, "cookie", { get: () => "", set: () => {} }); } catch {}
  let reported = false;
  const clean = (value, max) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
  const position = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const report = details => {
    if (reported) return;
    reported = true;
    send({ type: "aiqsa_artifact_runtime_error", ...details });
  };
  const fail = message => { report({ kind: "error", message: clean(message, 300), line: 0, column: 0 }); return message; };

  // Local artifact files: relative, root-relative or below the base directory
  // of this srcdoc document (the viewer's URL). Query and fragment never select a file.
  const files = new Map((Array.isArray(site.files) ? site.files : []).map(([path, mime, kind]) => [path, { mime, kind }]));
  const pageDirectory = site.page.slice(0, site.page.lastIndexOf("/") + 1);
  const baseDirectory = () => {
    try {
      const url = new URL(document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.origin + url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) : null;
    } catch { return null; }
  };
  const locate = value => {
    let rest = String(value).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    if (rest.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(rest)) return null;
    let absolute = false;
    if (rest.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(rest)) {
      const base = baseDirectory();
      let href = "";
      try { href = new URL(rest).href; } catch { return null; }
      if (!base || !href.startsWith(base)) return null;
      rest = href.slice(base.length); absolute = true;
    }
    const hash = rest.indexOf("#");
    const fragment = hash < 0 ? "" : rest.slice(hash + 1);
    rest = (hash < 0 ? rest : rest.slice(0, hash)).split("?")[0];
    if (!rest && !absolute) return null;
    const missing = { path: "", fragment, absolute, file: undefined };
    let decoded = "";
    try { decoded = decodeURIComponent(rest); } catch { return missing; }
    const parts = decoded.split("/");
    const segments = !absolute && decoded.startsWith("/") ? [] : pageDirectory.split("/").filter(Boolean);
    for (const part of parts) {
      if (part === "..") { if (!segments.length) return missing; segments.pop(); }
      else if (part && part !== ".") segments.push(part);
    }
    if (["", ".", ".."].includes(parts[parts.length - 1])) segments.push("index.html");
    const path = segments.join("/");
    return { path, fragment, absolute, file: files.get(path) };
  };
  const lookup = value => { try { return locate(value); } catch { return null; } };
  const binaryBytes = binary => {
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    return data;
  };
  // A data: URL carries its own bytes, yet connect-src 'none' blocks reading it, so
  // fetch and XHR decode it here with the Fetch data: URL rules and make no request.
  // Returns null for any other URL and { mime, bytes: null } for an invalid data: URL.
  const token = "[\\w!#$%&'*+.^|~\\x60-]+";
  const mimeEssence = new RegExp("^(" + token + "/" + token + ")[\\t\\n\\f\\r ]*(;.*)?$");
  const mimeParameter = new RegExp("^[\\t\\n\\f\\r ]*(" + token + ")=(.*)$");
  const dataRequest = value => {
    let href = "";
    try {
      const raw = String(value);
      if (!/^[\u0000-\u0020]*data:/i.test(raw)) return null;
      href = new URL(raw).href;
    } catch { return null; }
    if (!href.startsWith("data:")) return null;
    const hash = href.indexOf("#");
    const rest = href.slice(5, hash < 0 ? href.length : hash);
    const comma = rest.indexOf(",");
    if (comma < 0) return { mime: "", bytes: null };
    let mime = rest.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
    let binary = rest.slice(comma + 1).replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (/;\u0020*base64$/i.test(mime)) {
      mime = mime.replace(/;\u0020*base64$/i, "");
      try { binary = atob(binary); } catch { return { mime: "", bytes: null }; }
    }
    if (mime.startsWith(";")) mime = "text/plain" + mime;
    const essence = mimeEssence.exec(mime);
    if (essence) {
      const parameters = [], names = new Set();
      for (const parameter of (essence[2] || "").split(";")) {
        const match = mimeParameter.exec(parameter);
        if (!match || names.has(match[1].toLowerCase())) continue;
        names.add(match[1].toLowerCase()); parameters.push(";" + match[1].toLowerCase() + "=" + match[2]);
      }
      mime = essence[1].toLowerCase() + parameters.join("");
    } else mime = "text/plain;charset=US-ASCII";
    return { mime, bytes: binaryBytes(binary) };
  };
  let blockNodes = null;
  const decoded = new Map(), blobs = new Map(), addresses = new Map();
  // Base64 blocks are decoded lazily, once per file, on first use.
  const bytes = path => {
    if (decoded.has(path)) return decoded.get(path);
    try {
      if (!blockNodes || !blockNodes.has(path)) {
        blockNodes = new Map();
        for (const node of document.querySelectorAll("script[data-aiqsa-file]")) {
          const key = node.getAttribute("data-aiqsa-file");
          if (!blockNodes.has(key)) blockNodes.set(key, node);
        }
      }
      const text = blockNodes.get(path)?.textContent;
      if (typeof text !== "string") return null;
      const data = typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64(text) : binaryBytes(atob(text));
      decoded.set(path, data);
      return data;
    } catch { return null; }
  };
  const blobFor = target => {
    if (!blobs.has(target.path)) {
      const data = bytes(target.path);
      if (!data) return null;
      blobs.set(target.path, new Blob([data], { type: target.file.mime }));
    }
    return blobs.get(target.path);
  };
  const addressFor = target => {
    if (!addresses.has(target.path)) {
      const blob = blobFor(target);
      if (!blob) return null;
      addresses.set(target.path, URL.createObjectURL(blob));
    }
    return addresses.get(target.path);
  };
  // An existing file whose bytes this page cannot serve is a visible runtime error.
  const unavailable = (target, use) => fail(target.file.kind === "page"
    ? "Artifact page " + target.path + " opens only through a link; " + use + " cannot read it"
    : target.file.kind === "inline"
      ? "Artifact file " + target.path + " is inlined into this page by a static reference or an exact path string, so " + use + " cannot read it by path"
      : "Artifact file " + target.path + " could not be read");

  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") window.fetch = function fetch(input, init) {
      let target = null, data = null, method = "GET", signal = null;
      try {
        const request = typeof Request === "function" && input instanceof Request ? input : null;
        data = dataRequest(request ? request.url : input);
        target = data ? null : lookup(request ? request.url : input);
        if (target || data) {
          method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
          signal = init?.signal ?? request?.signal ?? null;
        }
      } catch { target = null; data = null; }
      if (!target && !data) return nativeFetch.apply(window, arguments);
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        if (data) {
          if (!data.bytes) return reject(new TypeError("Invalid data: URL"));
          return resolve(new Response(method === "HEAD" ? null : data.bytes, { status: 200, statusText: "OK", headers: { "content-type": data.mime } }));
        }
        if (method !== "GET" && method !== "HEAD") return reject(new TypeError("Artifact files are read-only; " + method + " is unavailable"));
        if (!target.file) return resolve(new Response(null, { status: 404, statusText: "Not Found" }));
        const body = target.file.kind === "block" ? blobFor(target) : null;
        if (!body) return reject(new TypeError(unavailable(target, "fetch")));
        resolve(new Response(method === "HEAD" ? null : body, { status: 200, statusText: "OK",
          headers: { "content-type": target.file.mime, "content-length": String(body.size) } }));
      });
    };
  } catch {}

  try {
    const XHR = window.XMLHttpRequest;
    if (typeof XHR === "function") {
      const proto = XHR.prototype, states = new WeakMap(), overrides = new WeakMap();
      const fire = (request, type, loaded = 0, total = 0) => request.dispatchEvent(type !== "readystatechange" && typeof ProgressEvent === "function"
        ? new ProgressEvent(type, { lengthComputable: total > 0, loaded, total }) : new Event(type));
      const opened = state => { if (state.readyState !== 1 || state.sent) throw new DOMException("The object's state must be OPENED.", "InvalidStateError"); };
      const reset = state => { state.status = 0; state.statusText = ""; state.headers = null; state.data = null; state.text = undefined; state.object = undefined; };
      // The response MIME type: an overrideMimeType() value wins over the content type.
      const responseMime = state => overrides.get(state.request) ?? state.headers?.get("content-type") ?? "";
      const local = (name, action) => {
        const native = proto[name];
        if (typeof native === "function") proto[name] = function () {
          const state = states.get(this);
          return state ? action.call(this, state, ...arguments) : native.apply(this, arguments);
        };
      };
      const nativeOpen = proto.open;
      proto.open = function (method, url) {
        const previous = states.get(this);
        if (previous) clearTimeout(previous.timer);
        const data = dataRequest(url);
        const target = data ? { data } : lookup(url);
        if (!target) { states.delete(this); return nativeOpen.apply(this, arguments); }
        const state = { request: this, target, method: String(method).toUpperCase(), async: arguments.length < 3 || !!arguments[2], readyState: 1, sent: false, timer: 0 };
        reset(state);
        states.set(this, state);
        fire(this, "readystatechange");
      };
      local("setRequestHeader", opened);
      const nativeOverride = proto.overrideMimeType;
      if (typeof nativeOverride === "function") proto.overrideMimeType = function (mime) {
        overrides.set(this, String(mime));
        if (!states.has(this)) return nativeOverride.apply(this, arguments);
      };
      local("send", function (state) {
        opened(state);
        state.sent = true;
        const request = this;
        const stale = () => states.get(request) !== state || !state.sent;
        const complete = () => {
          if (stale()) return;
          const { target, method } = state;
          const error = target.data ? (target.data.bytes ? null : "Invalid data: URL")
            : method !== "GET" && method !== "HEAD" ? "Artifact files are read-only; " + method + " is unavailable"
            : target.file && (target.file.kind !== "block" || !bytes(target.path)) ? unavailable(target, "XMLHttpRequest") : null;
          if (error) {
            state.readyState = 4; state.sent = false; reset(state);
            if (!state.async) throw new DOMException(error, "NetworkError");
            fire(request, "readystatechange"); fire(request, "error"); fire(request, "loadend");
            return;
          }
          const found = !!(target.data || target.file);
          const data = target.data ? target.data.bytes : target.file ? bytes(target.path) : new Uint8Array(0);
          state.status = found ? 200 : 404; state.statusText = found ? "OK" : "Not Found";
          state.headers = new Map(target.data ? [["content-type", target.data.mime]]
            : target.file ? [["content-length", String(data.length)], ["content-type", target.file.mime]] : []);
          state.data = method === "HEAD" ? new Uint8Array(0) : data;
          const size = state.data.length;
          if (state.async) {
            for (const readyState of [2, 3]) { state.readyState = readyState; fire(request, "readystatechange"); if (stale()) return; }
            fire(request, "progress", size, size); if (stale()) return;
          }
          state.readyState = 4; state.sent = false;
          fire(request, "readystatechange"); fire(request, "load", size, size); fire(request, "loadend", size, size);
        };
        if (!state.async) return complete();
        fire(request, "loadstart");
        state.timer = setTimeout(complete, 0);
      });
      local("abort", function (state) {
        clearTimeout(state.timer);
        if (state.sent) {
          state.sent = false; state.readyState = 4; reset(state);
          fire(this, "readystatechange"); fire(this, "abort"); fire(this, "loadend");
        }
        if (state.readyState === 4) { state.readyState = 0; reset(state); }
      });
      local("getResponseHeader", (state, name) => state.headers?.get(String(name).toLowerCase()) ?? null);
      local("getAllResponseHeaders", state => state.headers ? [...state.headers].map(([key, value]) => key + ": " + value + "\r\n").join("") : "");
      // Text decodes with the charset of the response MIME type (UTF-8 by default); JSON is always UTF-8.
      const text = state => {
        if (state.text !== undefined) return state.text;
        const charset = /;[\t\n\f\r ]*charset=[\t\n\f\r ]*"?([^";\t\n\f\r ]+)/i.exec(responseMime(state));
        let decoder;
        try { decoder = new TextDecoder(charset ? charset[1] : "utf-8"); } catch { decoder = new TextDecoder(); }
        return state.text = decoder.decode(state.data);
      };
      const getter = (name, read) => {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor?.get) Object.defineProperty(proto, name, { ...descriptor, get() {
          const state = states.get(this);
          return state ? read.call(this, state) : descriptor.get.call(this);
        } });
      };
      getter("readyState", state => state.readyState);
      getter("status", state => state.status);
      getter("statusText", state => state.statusText);
      getter("responseURL", () => "");
      getter("responseXML", () => null);
      getter("responseText", function (state) {
        if (this.responseType !== "" && this.responseType !== "text") throw new DOMException("responseText needs a text responseType.", "InvalidStateError");
        return state.readyState >= 3 && state.data ? text(state) : "";
      });
      getter("response", function (state) {
        const type = this.responseType;
        if (type === "" || type === "text") return state.readyState >= 3 && state.data ? text(state) : "";
        if (state.readyState !== 4 || !state.data) return null;
        if (state.object === undefined) {
          if (type === "json") { try { state.object = JSON.parse(new TextDecoder().decode(state.data)); } catch { state.object = null; } }
          else if (type === "arraybuffer") state.object = state.data.slice().buffer;
          else if (type === "blob") state.object = new Blob([state.data], { type: responseMime(state) });
          else state.object = null;
        }
        return state.object;
      });
    }
  } catch {}

  // A worker script from the bundle starts from a cached blob: URL of its file, with the
  // caller's options. The worker inherits this page's policy and runs without the bridge;
  // any other address goes to the browser's constructor, which the policy blocks.
  try {
    const NativeWorker = window.Worker;
    const scripts = ["text/javascript", "application/javascript", "application/x-javascript"];
    if (typeof NativeWorker === "function") {
      const Worker = function Worker(url) {
        if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
        const args = [...arguments];
        const target = args.length ? lookup(url) : null;
        if (target && !target.file) fail("Artifact worker script not found: " + (target.path || clean(url, 200)));
        else if (target?.file.kind === "block" && !scripts.includes(target.file.mime)) fail("Artifact file " + target.path + " is not JavaScript, so a Worker cannot run it");
        else if (target) {
          const address = target.file.kind === "block" ? addressFor(target) : null;
          if (address) args[0] = address; else unavailable(target, "a Worker");
        }
        return Reflect.construct(NativeWorker, args, new.target);
      };
      Worker.prototype = NativeWorker.prototype;
      Object.setPrototypeOf(Worker, NativeWorker);
      window.Worker = Worker;
    }
  } catch {}

  // A script-set local src becomes a cached blob: URL; a missing or unreadable
  // file fails locally through "data:," instead of making a request.
  const sourceFor = value => {
    const target = lookup(value);
    if (!target) return null;
    if (target.file?.kind === "block") { const address = addressFor(target); if (address) return address; }
    if (target.file) unavailable(target, "this element");
    return "data:,";
  };
  const sourceTypes = ["HTMLImageElement", "HTMLMediaElement", "HTMLSourceElement", "HTMLTrackElement"].map(name => window[name]).filter(type => typeof type === "function");
  try {
    for (const type of sourceTypes) {
      const descriptor = Object.getOwnPropertyDescriptor(type.prototype, "src");
      if (descriptor?.set) Object.defineProperty(type.prototype, "src", { ...descriptor, set(value) { descriptor.set.call(this, sourceFor(value) ?? value); } });
    }
    const setAttribute = window.Element?.prototype.setAttribute;
    if (typeof setAttribute === "function" && sourceTypes.length) window.Element.prototype.setAttribute = function (name, value) {
      if (arguments.length >= 2 && String(name).toLowerCase() === "src" && sourceTypes.some(type => this instanceof type)) {
        return setAttribute.call(this, name, sourceFor(value) ?? value);
      }
      return setAttribute.apply(this, arguments);
    };
  } catch {}
  // Static audio, video, source and track elements carry data-aiqsa-src from the renderer.
  if (site.media) {
    const adopted = new WeakSet();
    const selector = "audio[data-aiqsa-src],video[data-aiqsa-src],source[data-aiqsa-src],track[data-aiqsa-src]";
    const adopt = root => {
      if (root?.nodeType !== 1) return;
      const reload = new Set();
      for (const node of [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]) {
        if (adopted.has(node)) continue;
        adopted.add(node);
        const path = node.getAttribute("data-aiqsa-src");
        const file = files.get(path);
        const address = file?.kind === "block" ? addressFor({ path, file }) : null;
        if (!address) { fail("Artifact media file " + path + " could not be read"); continue; }
        node.src = address;
        if (node.localName === "source" && typeof node.parentNode?.load === "function") reload.add(node.parentNode);
      }
      // A media element that already gave up on a source without src starts again.
      if (reload.size) setTimeout(() => { for (const element of reload) if (element.networkState === 3) element.load(); }, 0);
    };
    try {
      if (typeof MutationObserver === "function") new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) adopt(node);
      }).observe(document, { childList: true, subtree: true });
    } catch {}
    document.addEventListener("DOMContentLoaded", () => adopt(document.documentElement));
  }

  const link = value => {
    if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol) && url.href.length <= 2048 ? url.href : null;
    } catch { return null; }
  };
  const open = value => { const href = link(value); if (href) send({ type: "aiqsa_artifact_open_link", href }); };
  const scrollToFragment = fragment => {
    try { fragment = decodeURIComponent(fragment); } catch {}
    const destination = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
    if (destination) destination.scrollIntoView();
    else if (!fragment || fragment.toLowerCase() === "top") window.scrollTo(0, 0);
  };
  // A link on another page named an anchor of this one; scroll once the page has loaded.
  if (typeof arrival === "string" && arrival) window.addEventListener("load", () => scrollToFragment(arrival), { once: true });
  // Another page asks the viewer to show it; any other local file downloads from a blob: URL.
  const follow = (target, anchor, raw) => {
    if (!target.file) return void fail("Artifact link target not found: " + (target.path || raw));
    if (target.file.kind === "page") {
      if (target.path === site.page && target.fragment) return scrollToFragment(target.fragment);
      return send({ type: "aiqsa_artifact_navigate", path: target.path,
        ...(target.fragment && target.fragment.length <= 256 ? { fragment: target.fragment } : {}) });
    }
    const address = target.file.kind === "block" ? addressFor(target) : null;
    if (!address) return void unavailable(target, "a link");
    const download = document.createElement("a");
    download.href = address;
    download.download = (anchor.getAttribute("download") || "").trim() || target.path.slice(target.path.lastIndexOf("/") + 1);
    download.style.display = "none";
    (document.body || document.documentElement).appendChild(download);
    download.click();
    download.remove();
  };
  const intercept = event => {
    if (event.type === "keydown" && event.key !== "Enter") return;
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    const raw = anchor.getAttribute("href") || "";
    if (raw.startsWith("#")) {
      // srcdoc resolves relative links against its parent's URL. Scroll here
      // instead of navigating the opaque frame to an application route.
      event.preventDefault();
      scrollToFragment(raw.slice(1));
      return;
    }
    // Blob downloads remain local. Other navigation always goes through the host.
    if (anchor.hasAttribute("download") && /^(blob:|data:)/.test(raw)) return;
    event.preventDefault();
    const target = lookup(raw);
    if (target && (target.file || !target.absolute)) follow(target, anchor, raw);
    else open(raw);
  };
  document.addEventListener("click", intercept, true);
  document.addEventListener("keydown", intercept, true);
  try { Object.defineProperty(window, "open", { value: value => { open(String(value)); return null; } }); } catch {}
  window.addEventListener("error", event => report({ kind: "error", message: clean(event.message, 300), line: position(event.lineno), column: position(event.colno) }), { once: true });
  window.addEventListener("unhandledrejection", event => {
    let message = "Unhandled promise rejection";
    try { message = typeof event.reason === "string" ? event.reason : event.reason?.message || message; } catch {}
    report({ kind: "unhandledrejection", message: clean(message, 300), line: 0, column: 0 });
  }, { once: true });
  window.addEventListener("securitypolicyviolation", event => {
    let blocked = "unknown";
    const value = String(event.blockedURI || "");
    if (["inline", "eval"].includes(value)) blocked = value;
    else if (/^(data|blob):/.test(value)) blocked = value.split(":")[0];
    else try { const url = new URL(value); if (/^https?:$/.test(url.protocol)) blocked = url.origin; } catch {}
    report({ kind: "csp", message: "Blocked resource", line: position(event.lineNumber), column: position(event.columnNumber), directive: clean(event.effectiveDirective, 64), blocked: clean(blocked, 128) });
  }, { once: true });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented) send({ type: "aiqsa_artifact_escape" });
  });
})();`;

/** Embeds the page's site data as an inert JSON literal. Paths and MIME types are validated
 * bundle values; escaping still keeps `</script>`, comments and the storage marker out. */
export function artifactRuntimeBridge(site: ArtifactRuntimeSite): string {
  const json = JSON.stringify(site).replace(/[<>&*\u2028\u2029]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return ARTIFACT_RUNTIME_BRIDGE.replace(ARTIFACT_SITE_PLACEHOLDER, () => json);
}
