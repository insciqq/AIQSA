"use client";

import type { Mermaid, MermaidConfig } from "mermaid";

/** Diagram source above this length stays a code block; Mermaid's own default is 50 000. */
export const MERMAID_SOURCE_MAX_CHARACTERS = 20_000;
/** Mermaid's default edge limit, pinned here so a directive cannot raise it. */
export const MERMAID_MAX_EDGES = 500;
/** A rendered diagram larger than this is not inserted into the page. */
export const MERMAID_SVG_MAX_CHARACTERS = 2_000_000;
/** Asynchronous render work slower than this falls back to the code block. */
export const MERMAID_RENDER_TIMEOUT_MS = 8_000;
export const MERMAID_RENDER_CACHE_LIMIT = 64;

export type MermaidColorScheme = "dark" | "light";
export type MermaidFailureReason = "invalid" | "timeout" | "too_large" | "unavailable";
export type MermaidRenderResult =
  | Readonly<{ ok: true; svg: string }>
  | Readonly<{ ok: false; reason: MermaidFailureReason }>;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Configuration that diagram text (`%%{init}%%` directives or front matter)
// must never change. Mermaid strips these keys at every nesting level, so
// `htmlLabels` also locks `flowchart.htmlLabels`.
const LOCKED_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "dompurifyConfig",
  "theme",
  "themeCSS",
  "themeVariables",
  "darkMode",
  "fontFamily",
  "altFontFamily",
  "arrowMarkerAbsolute",
  "deterministicIds",
  "deterministicIDSeed"
];

// Static SVG drawing vocabulary. Everything else, including `a`,
// `foreignObject`, `image`, `script`, animation and any HTML element, is removed.
const ALLOWED_SVG_ELEMENTS = new Set([
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "filter",
  "g",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tspan",
  "use"
]);

// Link elements keep their drawing but lose the link.
const UNWRAPPED_SVG_ELEMENTS = new Set(["a"]);

const NON_FRAGMENT_URL = /url\(\s*(?!['"]?\s*#)[^)]*\)/giu;
const CSS_IMPORT = /@import[^;]*;?/giu;
const SCRIPT_URL = /(?:java|vb)script\s*:|expression\s*\(/iu;

let mermaidPromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;
const renderCache = new Map<string, Promise<MermaidRenderResult>>();

export function isMermaidLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "mermaid";
}

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    const pending = import("mermaid")
      .then((module) => module.default)
      .catch((error: unknown) => {
        if (mermaidPromise === pending) mermaidPromise = null;
        throw error;
      });
    mermaidPromise = pending;
  }
  return mermaidPromise;
}

function appFontFamily(): string {
  try {
    const family = window.getComputedStyle(document.body).fontFamily.trim();
    // A resolved local font stack; anything unusual keeps the generic family.
    return family && family.length <= 300 && !/[<>{};]|url\(/iu.test(family) ? family : "sans-serif";
  } catch {
    return "sans-serif";
  }
}

export function mermaidConfig(scheme: MermaidColorScheme, fontFamily = "sans-serif"): MermaidConfig {
  return {
    darkMode: scheme === "dark",
    deterministicIds: false,
    flowchart: { htmlLabels: false },
    fontFamily,
    htmlLabels: false,
    // Mermaid 12 defaults to ELK, a 1.5 MB layout engine; dagre is the light
    // classic layout. A diagram may still ask for ELK explicitly.
    layout: "dagre",
    maxEdges: MERMAID_MAX_EDGES,
    maxTextSize: MERMAID_SOURCE_MAX_CHARACTERS,
    secure: LOCKED_CONFIG_KEYS,
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: scheme === "dark" ? "dark" : "neutral"
  };
}

function cleanCss(value: string): string {
  return value.replace(CSS_IMPORT, "").replace(NON_FRAGMENT_URL, "none");
}

function safeAttribute(name: string, value: string): boolean {
  if (name.startsWith("on")) return false;
  if (name === "href" || name === "xlink:href" || name.endsWith(":href") || name === "src") {
    return value.trim().startsWith("#");
  }
  if (SCRIPT_URL.test(value)) return false;
  // Presentation attributes may reference local gradients and markers only.
  return !/url\(/iu.test(value) || value.replace(NON_FRAGMENT_URL, "") === value;
}

function sanitizeElement(element: Element): void {
  for (const node of [...element.childNodes]) {
    // Keep plain text only: comments, processing instructions and CDATA
    // sections do not survive into the HTML parser.
    if (node.nodeType === Node.CDATA_SECTION_NODE) {
      node.replaceWith(element.ownerDocument.createTextNode(node.textContent ?? ""));
    } else if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
      node.remove();
    }
  }

  for (const child of [...element.children]) {
    const name = child.localName.toLowerCase();
    if (child.namespaceURI === SVG_NAMESPACE && UNWRAPPED_SVG_ELEMENTS.has(name)) {
      sanitizeElement(child);
      child.replaceWith(...child.childNodes);
      continue;
    }
    if (child.namespaceURI !== SVG_NAMESPACE || !ALLOWED_SVG_ELEMENTS.has(name)) {
      child.remove();
      continue;
    }
    sanitizeElement(child);
  }

  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (!safeAttribute(name, attribute.value)) {
      element.removeAttributeNode(attribute);
    } else if (name === "style") {
      attribute.value = cleanCss(attribute.value);
    }
  }

  if (element.localName.toLowerCase() === "style") {
    element.textContent = cleanCss(element.textContent ?? "");
  }
}

/**
 * Defense in depth over Mermaid's own DOMPurify pass. Mermaid serializes its
 * SVG as HTML, so it is parsed the way the page will parse it, in an inert
 * document that runs no scripts and loads nothing. Only static SVG drawing
 * elements survive; links, event handlers, external references and imports
 * are dropped. The root gets its natural size so a wide diagram scrolls inside
 * its box instead of shrinking, and XML serialization escapes all text.
 */
export function sanitizeMermaidSvg(svg: string): string | null {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  const root = parsed.body.firstElementChild;
  if (
    !root ||
    parsed.body.childElementCount !== 1 ||
    parsed.head.childElementCount !== 0 ||
    root.namespaceURI !== SVG_NAMESPACE ||
    root.localName !== "svg"
  ) {
    return null;
  }

  sanitizeElement(root);

  const viewBox = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u).map(Number);
  const [, , width, height] = viewBox;
  if (viewBox.length === 4 && width !== undefined && height !== undefined &&
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    root.setAttribute("width", String(Math.ceil(width)));
    root.setAttribute("height", String(Math.ceil(height)));
    const style = (root.getAttribute("style") ?? "").replace(/(?:^|;)\s*max-width\s*:[^;]*/giu, "").trim();
    if (style.replace(/;/gu, "").trim()) root.setAttribute("style", style.replace(/^;\s*/u, ""));
    else root.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(root);
}

function removeRenderLeftovers(id: string): void {
  if (typeof document === "undefined") return;
  for (const leftover of [`d${id}`, `i${id}`, id]) {
    const element = document.getElementById(leftover);
    // Only Mermaid's temporary nodes directly under body; rendered diagrams live elsewhere.
    if (element?.parentElement === document.body) element.remove();
  }
}

const TIMED_OUT = Symbol("timed-out");

function timeoutAfter(milliseconds: number): Promise<typeof TIMED_OUT> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(TIMED_OUT), milliseconds);
  });
}

async function renderNow(source: string, scheme: MermaidColorScheme): Promise<{
  result: MermaidRenderResult;
  settled: Promise<unknown>;
}> {
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { result: { ok: false, reason: "unavailable" }, settled: Promise.resolve() };
  }

  renderSequence += 1;
  const id = `aiqsa-mermaid-${renderSequence}`;
  let rendering: Promise<{ svg: string }>;
  try {
    mermaid.initialize(mermaidConfig(scheme, appFontFamily()));
    rendering = mermaid.render(id, source);
  } catch {
    removeRenderLeftovers(id);
    return { result: { ok: false, reason: "invalid" }, settled: Promise.resolve() };
  }
  // A late settlement after a timeout still removes Mermaid's temporary nodes.
  const settled = rendering.then(
    () => removeRenderLeftovers(id),
    () => removeRenderLeftovers(id)
  );

  try {
    const rendered = await Promise.race([rendering, timeoutAfter(MERMAID_RENDER_TIMEOUT_MS)]);
    if (rendered === TIMED_OUT) return { result: { ok: false, reason: "timeout" }, settled };
    const svg = sanitizeMermaidSvg(rendered.svg);
    if (!svg) return { result: { ok: false, reason: "invalid" }, settled };
    if (svg.length > MERMAID_SVG_MAX_CHARACTERS) return { result: { ok: false, reason: "too_large" }, settled };
    return { result: { ok: true, svg }, settled };
  } catch {
    return { result: { ok: false, reason: "invalid" }, settled };
  } finally {
    removeRenderLeftovers(id);
  }
}

function enqueueRender(source: string, scheme: MermaidColorScheme): Promise<MermaidRenderResult> {
  // Mermaid configuration is global: one render at a time, each with its own theme.
  const run = renderQueue.then(() => renderNow(source, scheme));
  renderQueue = run.then(
    // A render that never settles releases the queue after a bounded wait.
    ({ settled }) => Promise.race([settled, timeoutAfter(MERMAID_RENDER_TIMEOUT_MS * 3)]),
    () => undefined
  );
  return run.then(({ result }) => result, (): MermaidRenderResult => ({ ok: false, reason: "invalid" }));
}

/** Renders model-written Mermaid source into sanitized, inert SVG markup. */
export function renderMermaidDiagram(source: string, scheme: MermaidColorScheme): Promise<MermaidRenderResult> {
  if (source.length > MERMAID_SOURCE_MAX_CHARACTERS) {
    return Promise.resolve({ ok: false, reason: "too_large" });
  }
  if (!source.trim()) {
    return Promise.resolve({ ok: false, reason: "invalid" });
  }

  const cacheKey = `${scheme}\0${source}`;
  const cached = renderCache.get(cacheKey);
  if (cached) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached;
  }

  const pending = enqueueRender(source, scheme).then((result) => {
    // A failed load may succeed on the next mount; keep it out of the cache.
    if (!result.ok && result.reason === "unavailable" && renderCache.get(cacheKey) === pending) {
      renderCache.delete(cacheKey);
    }
    return result;
  });

  // Bounded long-session cache; Map iteration order gives simple LRU eviction.
  if (renderCache.size >= MERMAID_RENDER_CACHE_LIMIT) {
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey !== undefined) renderCache.delete(oldestKey);
  }
  renderCache.set(cacheKey, pending);
  return pending;
}
