import { ARTIFACT_STORAGE_LIMITS, ARTIFACT_STORAGE_PLACEHOLDER } from "../../contracts/artifactRuntime";

/** Per-page bridge data: the page path and its local files as `[path, mime, kind]`. A `block`
 * file's bytes are in this page; `inline` files were inlined by a static reference and `page`
 * files open through navigation, so neither can be read at runtime. */
export type ArtifactRuntimeSite = Readonly<{
  page: string;
  media: boolean;
  files: readonly (readonly [path: string, mime: string, kind: "page" | "block" | "inline"])[];
}>;

export const ARTIFACT_SITE_PLACEHOLDER = "/*AIQSA_ARTIFACT_SITE*/null";

/** Server-owned code runs before any authored script. The single state marker
 * is filled only by the viewer; shared render caches always retain empty data.
 * Local files are answered only from bytes embedded in the page: every other
 * request reaches the browser unchanged and stays under the artifact CSP. */
export const ARTIFACT_RUNTIME_BRIDGE = String.raw`(() => {
  const initial = ${ARTIFACT_STORAGE_PLACEHOLDER};
  const site = ${ARTIFACT_SITE_PLACEHOLDER} || { page: "", media: false, files: [] };
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

  // Resource hints and nested documents. WebKit opens a TCP connection for a
  // preconnect link (and resolves a dns-prefetch host name) as soon as such a
  // link element is connected, or a connected one gains that relation or a new
  // href, under any CSP: neither is a CSP fetch. That happens synchronously
  // inside the insertion or attribute change, so an observer is too late. A
  // nested srcdoc document, or a javascript: frame, is a fresh realm without
  // this bridge whose own markup and scripts reach the same channels and
  // WebRTC. So, before the native operation runs, on every script path that
  // creates, changes or connects such an element:
  //   - a link loses its preconnect, dns-prefetch, prefetch, prerender, preload
  //     and modulepreload tokens. They are only hints and default-src 'none'
  //     lets none of them serve the page, so this stays silent;
  //   - an iframe loses its srcdoc and a frame or iframe a javascript: src,
  //     reported as a runtime error because that content then never shows.
  // Decisions use intrinsics captured here, before any authored script, so a
  // page that later replaces String, RegExp, Array, Reflect, NodeList or DOM
  // members cannot steer them; a nested about:blank frame is another opaque
  // origin, so no untouched realm is reachable. Element and shadow root
  // innerHTML, outerHTML and insertAdjacentHTML parse in a detached element of
  // the same document, namespace and name and move the checked nodes in.
  // DOMParser, createContextualFragment and XSLT results are checked before
  // they are returned. Sinks that parse on their own (document.write, execCommand
  // insertHTML, setHTMLUnsafe, setHTML, parseHTMLUnsafe, parseHTML) get link and
  // frame tags renamed to inert basefont and noembed elements, also where such
  // a tag only appears as text; document.write holds back a tag name split
  // across calls. Not covered: HTML a user pastes or drops into an editable
  // region, and a subtree connected by an indexed select or options setter,
  // which matters only for a link that escaped every path above.
  try {
    const apply = Reflect.apply, describe = Object.getOwnPropertyDescriptor, define = Object.defineProperty;
    const toText = String, fromCharCode = String.fromCharCode, charCodeAt = String.prototype.charCodeAt, cut = String.prototype.slice;
    const exec = RegExp.prototype.exec, mapGet = WeakMap.prototype.get, mapSet = WeakMap.prototype.set;
    const HTML = "http://www.w3.org/1999/xhtml";
    const protoOf = name => typeof window[name] === "function" ? window[name].prototype : null;
    const slot = (owner, key) => owner && describe(owner, key) || null;
    const getter = (name, key) => { const found = slot(protoOf(name), key); return found && found.get || null; };
    const method = (name, key) => { const found = slot(protoOf(name), key); return found && typeof found.value === "function" ? found.value : null; };
    const read = (get, self) => apply(get, self, []);
    // A DOMString argument, converted once so the checked value is the stored one.
    const text = value => typeof value === "symbol" ? value : toText(value);
    const ElementProto = protoOf("Element"), DocumentProto = protoOf("Document"), FragmentProto = protoOf("DocumentFragment");
    const nodeType = getter("Node", "nodeType"), isConnected = getter("Node", "isConnected"), parentNode = getter("Node", "parentNode"),
      firstChild = getter("Node", "firstChild"), nextSibling = getter("Node", "nextSibling"), ownerDocument = getter("Node", "ownerDocument"),
      localName = getter("Element", "localName"), namespaceURI = getter("Element", "namespaceURI"),
      getAttribute = method("Element", "getAttribute"), setAttribute = method("Element", "setAttribute"), removeAttribute = method("Element", "removeAttribute"),
      queries = [method("Element", "querySelectorAll"), method("DocumentFragment", "querySelectorAll"), method("Document", "querySelectorAll")],
      firstMatches = [method("Element", "querySelector"), method("DocumentFragment", "querySelector")],
      listLength = getter("NodeList", "length"), listItem = method("NodeList", "item"),
      appendChild = method("Node", "appendChild"), insertBefore = method("Node", "insertBefore"), replaceChild = method("Node", "replaceChild"),
      removeChild = method("Node", "removeChild"), createElementNS = method("Document", "createElementNS"), createFragment = method("Document", "createDocumentFragment"),
      elementReplace = method("Element", "replaceChildren"), fragmentReplace = method("DocumentFragment", "replaceChildren"),
      contains = method("DOMTokenList", "contains"), remove = method("DOMTokenList", "remove"),
      templateContent = getter("HTMLTemplateElement", "content"), innerHTML = slot(ElementProto, "innerHTML");
    if (!innerHTML || typeof innerHTML.set !== "function" || [nodeType, isConnected, parentNode, firstChild, nextSibling, ownerDocument, localName, namespaceURI,
      getAttribute, setAttribute, removeAttribute, ...queries, ...firstMatches, listLength, listItem, appendChild, insertBefore, replaceChild, removeChild, createElementNS, createFragment]
      .some(native => typeof native !== "function")) throw 0;
    const lower = value => {
      let out = "";
      for (let i = 0; i < value.length; i++) { const code = apply(charCodeAt, value, [i]); out += fromCharCode(code > 64 && code < 91 ? code + 32 : code); }
      return out;
    };
    const hint = token => token === "preconnect" || token === "dns-prefetch" || token === "prefetch" || token === "prerender" || token === "preload" || token === "modulepreload";
    // The rel value without hint tokens (ASCII case-insensitive), or null when it has none.
    const unhinted = value => {
      let kept = "", token = "", dropped = false;
      for (let i = 0; i <= value.length; i++) {
        const code = i < value.length ? apply(charCodeAt, value, [i]) : 32;
        if (code !== 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) { token += fromCharCode(code); continue; }
        if (!token) continue;
        if (hint(lower(token))) dropped = true; else kept = kept ? kept + " " + token : token;
        token = "";
      }
      return dropped ? kept : null;
    };
    const isHint = token => typeof token === "string" && unhinted(token) === "";
    // URL parsing drops leading C0 controls and spaces and every tab or newline.
    const scriptAddress = value => {
      let scheme = "";
      for (let i = 0; i < value.length && scheme.length < 11; i++) {
        const code = apply(charCodeAt, value, [i]);
        if (code === 9 || code === 10 || code === 13 || (code <= 32 && !scheme)) continue;
        scheme += fromCharCode(code > 64 && code < 91 ? code + 32 : code);
      }
      return scheme === "javascript:";
    };
    const hasDash = value => { for (let i = 0; i < value.length; i++) if (apply(charCodeAt, value, [i]) === 45) return true; return false; };
    const htmlName = node => { try { return read(nodeType, node) === 1 && read(namespaceURI, node) === HTML ? read(localName, node) : ""; } catch { return ""; } };
    const kind = node => { const name = htmlName(node); return name === "link" || name === "iframe" || name === "frame" ? name : ""; };
    // Only this page's document has a browsing context: a link elsewhere (a
    // DOMParser or template document) reaches no network until it moves here.
    const page = document;
    const connected = node => { try { return read(isConnected, node) === true; } catch { return false; } };
    const live = node => connected(node) && read(ownerDocument, node) === page;
    // Reporting must not throw: a check stopped halfway would leave later elements untouched.
    const frameBlocked = () => { try { fail("Artifact pages cannot show nested documents, so an iframe srcdoc or javascript: address was removed; render that content in the page itself"); } catch {} };
    // Makes one element inert in place.
    const neutralize = (element, name) => {
      if (name === "link") {
        const rel = apply(getAttribute, element, ["rel"]);
        const kept = rel === null ? null : unhinted(rel);
        if (kept !== null) apply(setAttribute, element, ["rel", kept]);
        return;
      }
      let removed = false;
      if (name === "iframe" && apply(getAttribute, element, ["srcdoc"]) !== null) { apply(removeAttribute, element, ["srcdoc"]); removed = true; }
      const src = apply(getAttribute, element, ["src"]);
      if (src !== null && scriptAddress(src)) { apply(setAttribute, element, ["src", "about:blank"]); removed = true; }
      if (removed) frameBlocked();
    };
    const query = (root, selector) => {
      const type = read(nodeType, root);
      const run = type === 1 ? queries[0] : type === 11 ? queries[1] : type === 9 ? queries[2] : null;
      return run ? apply(run, root, [selector]) : null;
    };
    const each = (list, action) => { if (list) for (let i = 0, count = read(listLength, list); i < count; i++) action(apply(listItem, list, [i])); };
    const shadows = new WeakMap();
    let shadowed = false;
    // Neutralizes root and everything below it, including shadow roots attached
    // through attachShadow and, when deep, inert template contents.
    const scrub = (root, deep) => {
      const check = element => { const name = kind(element); if (name) neutralize(element, name); };
      const descend = (element, inner) => { const nested = inner(element); if (nested) scrub(nested, deep); };
      const shadowOf = element => apply(mapGet, shadows, [element]);
      const contentOf = element => { try { return read(templateContent, element); } catch { return null; } };
      const isElement = read(nodeType, root) === 1;
      if (isElement) check(root);
      each(query(root, "link,iframe,frame"), check);
      if (shadowed) { if (isElement) descend(root, shadowOf); each(query(root, "*"), element => descend(element, shadowOf)); }
      if (deep && templateContent) { if (htmlName(root) === "template") descend(root, contentOf); each(query(root, "template"), element => descend(element, contentOf)); }
    };
    const wrap = (owner, key, make) => {
      const found = slot(owner, key);
      if (found && typeof found.value === "function") define(owner, key, { ...found, value: make(found.value) });
    };
    const wrapSet = (owner, key, make) => {
      const found = slot(owner, key);
      if (found && typeof found.set === "function") define(owner, key, { ...found, set: make(found.set) });
    };

    // Insertion: nodes headed into this page's tree are checked first. Any other
    // target only parks them; they are checked when that tree is connected here.
    // The common case stays cheap: the node's own name, then one query that stops
    // at the first link or frame below it; the full walk runs only when one is
    // there, or once a shadow root exists (its contents are not query results).
    const inserted = node => {
      const type = read(nodeType, node);
      if (type === 1) {
        const name = read(localName, node);
        if ((name === "link" || name === "iframe" || name === "frame") && read(namespaceURI, node) === HTML) neutralize(node, name);
      } else if (type !== 11) return;
      if (shadowed || apply(firstMatches[type === 1 ? 0 : 1], node, ["link,iframe,frame"]) !== null) scrub(node, false);
    };
    const inserting = (first, count, always) => native => function () {
      if (always || connected(this)) {
        const end = count < 0 || first + count > arguments.length ? arguments.length : first + count;
        for (let i = first; i < end; i++) { const node = arguments[i]; if (node !== null && typeof node === "object") try { inserted(node); } catch {} }
      }
      return apply(native, this, arguments);
    };
    for (const key of ["appendChild", "insertBefore", "replaceChild"]) wrap(protoOf("Node"), key, inserting(0, 1));
    for (const owner of [ElementProto, DocumentProto, FragmentProto]) {
      for (const key of ["append", "prepend", "replaceChildren"]) wrap(owner, key, inserting(0, -1));
      wrap(owner, "moveBefore", inserting(0, 1));
    }
    for (const owner of [ElementProto, protoOf("CharacterData"), protoOf("DocumentType")]) for (const key of ["before", "after", "replaceWith"]) wrap(owner, key, inserting(0, -1));
    wrap(ElementProto, "insertAdjacentElement", inserting(1, 1));
    for (const key of ["insertNode", "surroundContents"]) wrap(protoOf("Range"), key, inserting(0, 1, true));
    wrapSet(DocumentProto, "body", inserting(0, 1));
    for (const key of ["caption", "tHead", "tFoot"]) wrapSet(protoOf("HTMLTableElement"), key, inserting(0, 1));
    wrap(protoOf("HTMLSelectElement"), "add", inserting(0, 1));
    wrap(protoOf("HTMLOptionsCollection"), "add", inserting(0, 1, true));
    wrap(ElementProto, "attachShadow", native => function () {
      const root = apply(native, this, arguments);
      try { apply(mapSet, shadows, [this, root]); shadowed = true; } catch {}
      return root;
    });

    // Markup sinks.
    const MARKUP = /<(?:[\w.-]+:)?(?:link|i?frame)[\t\n\f\r \/>]/i;
    const mentions = value => typeof value === "string" && apply(exec, MARKUP, [value]) !== null;
    const markupOf = value => value === null ? "" : text(value);
    const replaceAll = (target, fragment, replace) => {
      if (typeof replace === "function") return void apply(replace, target, [fragment]);
      for (let child = read(firstChild, target); child !== null; child = read(firstChild, target)) apply(removeChild, target, [child]);
      apply(appendChild, target, [fragment]);
    };
    const body = node => apply(createElementNS, read(ownerDocument, node), [HTML, "body"]);
    // Parses markup in a detached element that parses like context (same document,
    // namespace and name; a custom element name parses like any other, so no
    // constructor runs) and returns the checked nodes in a fragment.
    const parsed = (context, markup) => {
      const owner = read(ownerDocument, context), space = read(namespaceURI, context);
      let name = read(localName, context), holder;
      if (space === HTML && hasDash(name)) name = "div";
      try { holder = apply(createElementNS, owner, [space, name]); } catch { holder = apply(createElementNS, owner, [space, "div"]); }
      apply(innerHTML.set, holder, [markup]);
      const source = htmlName(holder) === "template" ? read(templateContent, holder) : holder;
      scrub(source, true);
      const fragment = apply(createFragment, owner, []);
      for (let child = read(firstChild, source); child !== null; child = read(firstChild, source)) apply(appendChild, fragment, [child]);
      return fragment;
    };
    wrapSet(ElementProto, "innerHTML", native => function (value) {
      const markup = markupOf(value);
      if (!mentions(markup)) return apply(native, this, [markup]);
      if (!live(this) || htmlName(this) === "template") {
        apply(native, this, [markup]);
        try { scrub(this, true); } catch {}
        return;
      }
      replaceAll(this, parsed(this, markup), elementReplace);
    });
    const shadowHost = getter("ShadowRoot", "host");
    wrapSet(protoOf("ShadowRoot"), "innerHTML", native => function (value) {
      const markup = markupOf(value);
      if (!mentions(markup)) return apply(native, this, [markup]);
      if (!live(this) || !shadowHost) {
        apply(native, this, [markup]);
        try { scrub(this, true); } catch {}
        return;
      }
      replaceAll(this, parsed(read(shadowHost, this), markup), fragmentReplace);
    });
    wrapSet(ElementProto, "outerHTML", native => function (value) {
      const markup = markupOf(value);
      if (!mentions(markup)) return apply(native, this, [markup]);
      let parent = null;
      try { parent = read(parentNode, this); } catch {}
      if (parent === null || read(nodeType, parent) === 9 || !live(this)) {
        apply(native, this, [markup]);
        if (parent !== null) try { scrub(parent, true); } catch {}
        return;
      }
      apply(replaceChild, parent, [parsed(read(nodeType, parent) === 1 ? parent : body(this), markup), this]);
    });
    wrap(ElementProto, "insertAdjacentHTML", native => function (position, value) {
      if (arguments.length < 2) return apply(native, this, arguments);
      const where = text(position), markup = text(value);
      if (typeof where !== "string" || !mentions(markup)) return apply(native, this, [where, markup]);
      const at = lower(where), outside = at === "beforebegin" || at === "afterend";
      let parent = null;
      try { parent = read(parentNode, this); } catch {}
      if (!live(this) || (!outside && at !== "afterbegin" && at !== "beforeend") || (outside && (parent === null || read(nodeType, parent) === 9))) {
        const result = apply(native, this, [where, markup]);
        try { scrub(outside && parent !== null ? parent : this, true); } catch {}
        return result;
      }
      let context = outside ? parent : this;
      if (read(nodeType, context) !== 1 || htmlName(context) === "html") context = body(this);
      const fragment = parsed(context, markup);
      if (at === "beforebegin") apply(insertBefore, parent, [fragment, this]);
      else if (at === "afterbegin") apply(insertBefore, this, [fragment, read(firstChild, this)]);
      else if (at === "beforeend") apply(appendChild, this, [fragment]);
      else apply(insertBefore, parent, [fragment, read(nextSibling, this)]);
    });
    const TAG = /<(\/?)(link|i?frame)(?=[\t\n\f\r \/>])/gi;
    // Renames link and frame tags in markup a sink parses on its own; end tags of
    // the raw-text noembed stand-in keep an iframe's content where it was.
    const inert = value => {
      let out = "", last = 0, match;
      TAG.lastIndex = 0;
      while ((match = apply(exec, TAG, [value])) !== null) {
        const name = lower(match[2]);
        out += apply(cut, value, [last, match.index]) + (match[1] ? (name === "iframe" ? "</noembed" : match[0])
          : name === "link" ? "<basefont data-aiqsa-link" : name === "iframe" ? "<noembed data-aiqsa-iframe" : "<basefont data-aiqsa-frame");
        last = match.index + match[0].length;
      }
      return last ? out + apply(cut, value, [last]) : value;
    };
    const renaming = native => function (value) {
      const markup = arguments.length ? text(value) : value;
      if (typeof markup !== "string") return apply(native, this, arguments);
      return apply(native, this, arguments.length > 1 ? [inert(markup), arguments[1]] : [inert(markup)]);
    };
    for (const owner of [ElementProto, protoOf("ShadowRoot")]) for (const key of ["setHTMLUnsafe", "setHTML"]) wrap(owner, key, renaming);
    for (const key of ["parseHTMLUnsafe", "parseHTML"]) wrap(typeof window.Document === "function" ? window.Document : null, key, renaming);
    wrap(DocumentProto, "execCommand", native => function (command, showUI, value) {
      if (arguments.length < 3) return apply(native, this, arguments);
      const name = text(command), markup = text(value);
      const html = typeof name === "string" && typeof markup === "string" && lower(name) === "inserthtml";
      return apply(native, this, [name, showUI, html ? inert(markup) : markup]);
    });
    // document.write feeds the parser in pieces: a tag name split across calls is
    // held back until the next call completes it, or dropped at the end of the
    // task, where the parser would only have joined it with the following source.
    const TAIL = /<\/?(?:l(?:i(?:nk?)?)?|i(?:f(?:r(?:a(?:me?)?)?)?)?|f(?:r(?:a(?:me?)?)?)?)?$/i;
    const queue = typeof window.queueMicrotask === "function" ? window.queueMicrotask : null;
    let held = "", clearing = false;
    const writing = (native, newline) => function () {
      let markup = held;
      for (let i = 0; i < arguments.length; i++) {
        const part = text(arguments[i]);
        if (typeof part !== "string") return apply(native, this, arguments);
        markup += part;
      }
      held = "";
      if (newline) markup += "\n";
      const tail = apply(exec, TAIL, [markup]);
      if (tail !== null) {
        held = tail[0];
        markup = apply(cut, markup, [0, tail.index]);
        if (queue && !clearing) { clearing = true; apply(queue, window, [() => { held = ""; clearing = false; }]); }
      }
      return apply(native, this, [inert(markup)]);
    };
    // Some engines alias HTMLDocument to Document: one prototype is wrapped once.
    for (const owner of new Set([DocumentProto, protoOf("HTMLDocument")])) {
      const write = slot(owner, "write"), writeln = slot(owner, "writeln");
      if (!write || typeof write.value !== "function") continue;
      define(owner, "write", { ...write, value: writing(write.value, false) });
      if (writeln) define(owner, "writeln", { ...writeln, value: writing(write.value, true) });
    }
    // Detached results are checked before any script can connect them.
    const scrubbing = native => function () {
      const result = apply(native, this, arguments);
      try { if (result !== null && typeof result === "object") scrub(result, true); } catch {}
      return result;
    };
    wrap(protoOf("DOMParser"), "parseFromString", scrubbing);
    wrap(protoOf("Range"), "createContextualFragment", scrubbing);
    for (const key of ["transformToFragment", "transformToDocument"]) wrap(protoOf("XSLTProcessor"), key, scrubbing);

    // Attribute writes.
    const watched = name => name === "rel" || name === "href" || name === "src" || name === "srcdoc";
    const attributeName = value => {
      if (typeof value !== "string" || value.length < 3 || value.length > 6) return "";
      const first = apply(charCodeAt, value, [0]) | 32;
      return first === 104 || first === 114 || first === 115 ? lower(value) : "";
    };
    // The value one attribute write may store on element; an href change first
    // drops any hint a link still carries, so no hint follows a new address.
    const allowed = (element, name, value) => {
      const target = kind(element);
      if (!target || typeof value !== "string") return value;
      if (target === "link") {
        if (name === "rel") { const kept = unhinted(value); return kept === null ? value : kept; }
        if (name === "href") neutralize(element, "link");
        return value;
      }
      if (name === "srcdoc" && target === "iframe") { if (value) frameBlocked(); return ""; }
      if (name === "src" && scriptAddress(value)) { frameBlocked(); return "about:blank"; }
      return value;
    };
    wrap(ElementProto, "setAttribute", native => function setAttribute(name, value) {
      if (arguments.length < 2) return apply(native, this, arguments);
      const key = text(name), normalized = attributeName(key);
      return apply(native, this, [key, watched(normalized) ? allowed(this, normalized, text(value)) : value]);
    });
    wrap(ElementProto, "setAttributeNS", native => function setAttributeNS(space, name, value) {
      if (arguments.length < 3) return apply(native, this, arguments);
      const ns = space === null || space === undefined ? null : text(space), key = text(name);
      const plain = (ns === null || ns === "") && watched(key);
      return apply(native, this, [ns, key, plain ? allowed(this, key, text(value)) : value]);
    });
    wrap(ElementProto, "toggleAttribute", native => function toggleAttribute(name) {
      if (!arguments.length) return apply(native, this, arguments);
      const key = text(name);
      if (watched(attributeName(key)) && kind(this) === "link") neutralize(this, "link");
      return apply(native, this, arguments.length > 1 ? [key, arguments[1]] : [key]);
    });
    const AttrProto = protoOf("Attr"), attrValue = slot(AttrProto, "value");
    const attrSpace = getter("Attr", "namespaceURI"), attrName = getter("Attr", "localName"), attrOwner = getter("Attr", "ownerElement");
    if (attrValue && attrValue.get && attrValue.set && attrSpace && attrName && attrOwner) {
      // The value an attribute node may hold on owner (its own element by default).
      const attrAllowed = (attr, value, owner) => {
        try {
          if (read(attrSpace, attr) !== null) return value;
          const holder = read(attrOwner, attr);
          if (owner === undefined) owner = holder;
          else if (holder !== null && holder !== owner) return value;
          return owner ? allowed(owner, read(attrName, attr), value) : value;
        } catch { return value; }
      };
      define(AttrProto, "value", { ...attrValue, set(value) {
        const content = text(value);
        return apply(attrValue.set, this, [typeof content === "string" ? attrAllowed(this, content) : value]);
      } });
      for (const key of ["nodeValue", "textContent"]) wrapSet(protoOf("Node"), key, native => function (value) {
        let attribute = false;
        try { attribute = read(nodeType, this) === 2; } catch {}
        if (!attribute) return apply(native, this, arguments);
        const content = value === null ? "" : text(value);
        return apply(native, this, [typeof content === "string" ? attrAllowed(this, content) : value]);
      });
      const placing = ownerOf => native => function (attr) {
        const owner = ownerOf(this);
        if (owner) try {
          if (read(nodeType, attr) === 2) {
            const current = read(attrValue.get, attr), next = attrAllowed(attr, current, owner);
            if (next !== current) apply(attrValue.set, attr, [next]);
          }
        } catch {}
        return apply(native, this, arguments);
      };
      for (const key of ["setAttributeNode", "setAttributeNodeNS"]) wrap(ElementProto, key, placing(element => element));
      const maps = new WeakMap(), attributes = slot(ElementProto, "attributes");
      if (attributes && attributes.get) define(ElementProto, "attributes", { ...attributes, get() {
        const map = apply(attributes.get, this, []);
        if (kind(this)) try { apply(mapSet, maps, [map, this]); } catch {}
        return map;
      } });
      const mapOwner = map => { try { return apply(mapGet, maps, [map]); } catch { return undefined; } };
      for (const key of ["setNamedItem", "setNamedItemNS"]) wrap(protoOf("NamedNodeMap"), key, placing(mapOwner));
    }
    const reflecting = name => native => function (value) {
      const content = text(value);
      return apply(native, this, [typeof content === "string" ? allowed(this, name, content) : value]);
    };
    const LinkProto = protoOf("HTMLLinkElement");
    wrapSet(LinkProto, "rel", reflecting("rel"));
    wrapSet(LinkProto, "href", reflecting("href"));
    wrapSet(protoOf("HTMLIFrameElement"), "srcdoc", reflecting("srcdoc"));
    wrapSet(protoOf("HTMLIFrameElement"), "src", reflecting("src"));
    wrapSet(protoOf("HTMLFrameElement"), "src", reflecting("src"));
    // relList: every token list a link hands out is remembered, so its add,
    // toggle, replace and value writes keep hint tokens out of that link.
    const relList = slot(LinkProto, "relList"), TokenProto = protoOf("DOMTokenList");
    if (relList && relList.get && TokenProto && contains && remove) {
      const relLists = new WeakMap();
      define(LinkProto, "relList", { ...relList, get() {
        const list = apply(relList.get, this, []);
        try { apply(mapSet, relLists, [list, this]); } catch {}
        return list;
      }, ...(relList.set ? { set: reflecting("rel")(relList.set) } : {}) });
      const linkOf = list => { try { return apply(mapGet, relLists, [list]); } catch { return undefined; } };
      wrap(TokenProto, "add", native => function add() {
        const link = linkOf(this);
        if (!link) return apply(native, this, arguments);
        neutralize(link, "link");
        const tokens = [];
        for (let i = 0; i < arguments.length; i++) {
          const token = text(arguments[i]);
          if (typeof token !== "string") return apply(native, this, arguments);
          if (!isHint(token)) define(tokens, tokens.length, { value: token, writable: true, enumerable: true, configurable: true });
        }
        return apply(native, this, tokens);
      });
      wrap(TokenProto, "toggle", native => function toggle(token) {
        const link = linkOf(this);
        if (!link || !arguments.length) return apply(native, this, arguments);
        neutralize(link, "link");
        const value = text(token);
        if (isHint(value)) return false;
        return apply(native, this, typeof value !== "string" ? arguments : arguments.length > 1 ? [value, arguments[1]] : [value]);
      });
      wrap(TokenProto, "replace", native => function replace(token, newToken) {
        const link = linkOf(this);
        if (!link || arguments.length < 2) return apply(native, this, arguments);
        neutralize(link, "link");
        const old = text(token), next = text(newToken);
        if (typeof old !== "string" || !isHint(next)) return apply(native, this, [old, next]);
        // A hint never replaces a token: the old one only goes away.
        const present = apply(contains, this, [old]);
        apply(remove, this, [old]);
        return present;
      });
      wrapSet(TokenProto, "value", native => function (value) {
        const link = linkOf(this);
        if (!link) return apply(native, this, arguments);
        const content = text(value);
        return apply(native, this, [typeof content === "string" ? allowed(link, "rel", content) : value]);
      });
    }
  } catch {}

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
