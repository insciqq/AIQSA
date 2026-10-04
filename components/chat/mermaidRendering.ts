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

const SCOPE_ID = /^[A-Za-z][\w-]*$/u;
// CSSRule.type values; the named constants are deprecated.
const STYLE_RULE = 1;
const MEDIA_RULE = 4;

/**
 * Visits a selector outside parentheses, brackets and strings; `visit`
 * returns true to stop. Returns false for unbalanced input.
 */
function scanTopLevel(selector: string, visit: (character: string, index: number) => boolean | void): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "\\") {
      index += 1;
    } else if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    } else if (depth === 0 && visit(character, index)) {
      return true;
    }
  }
  return depth === 0 && quote === null;
}

/** Splits a selector list at top-level commas. */
function splitSelectorList(selectorText: string): string[] | null {
  const selectors: string[] = [];
  let start = 0;
  const balanced = scanTopLevel(selectorText, (character, index) => {
    if (character === ",") {
      selectors.push(selectorText.slice(start, index));
      start = index + 1;
    }
  });
  if (!balanced) return null;
  selectors.push(selectorText.slice(start));
  return selectors.map((selector) => selector.trim());
}

/**
 * A selector stays only when its subject is the diagram root or one of its
 * descendants: it starts with the root's own id and has no sibling
 * combinator, nesting marker or shadow pseudo-class that could reach the page.
 */
function scopedSelector(selector: string, scopeId: string): boolean {
  const prefix = `#${scopeId}`;
  if (!selector.startsWith(prefix)) return false;
  const next = selector.charAt(prefix.length);
  if (next && !/[\s>.:[]/u.test(next)) return false;
  let escapes = false;
  const balanced = scanTopLevel(selector, (character) => {
    escapes = character === "~" || character === "+" || character === "&";
    return escapes;
  });
  return balanced && !escapes && !/:host|::slotted|::part/iu.test(selector);
}

function scopedRules(rules: CSSRuleList, scopeId: string): string[] {
  const kept: string[] = [];
  for (const rule of rules) {
    if (rule.type === STYLE_RULE) {
      const styleRule = rule as CSSStyleRule & { cssRules?: CSSRuleList };
      const selectors = splitSelectorList(styleRule.selectorText);
      // Nested rules could re-target through `&`; such a rule is dropped whole.
      const nested = styleRule.cssRules?.length ?? 0;
      if (selectors?.length && nested === 0 && selectors.every((selector) => scopedSelector(selector, scopeId))) {
        kept.push(styleRule.cssText);
      }
    } else if (rule.type === MEDIA_RULE) {
      const mediaRule = rule as CSSMediaRule;
      const inner = scopedRules(mediaRule.cssRules, scopeId);
      if (inner.length) kept.push(`@media ${mediaRule.media.mediaText} { ${inner.join(" ")} }`);
    }
    // Every other at-rule (@keyframes, @font-face, @import, @layer, @supports,
    // @property, …) is global or unscoped and is dropped.
  }
  return kept;
}

/**
 * Rebuilds diagram CSS from the browser's own parse so no rule can style the
 * page around the diagram: only rules scoped to the diagram root survive,
 * re-serialized by the CSS engine, without external resource references.
 */
export function scopeDiagramCss(cssText: string, scopeId: string): string {
  if (!SCOPE_ID.test(scopeId) || typeof CSSStyleSheet === "undefined") return "";
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    return cleanCss(scopedRules(sheet.cssRules, scopeId).join("\n"));
  } catch {
    return "";
  }
}

function sanitizeElement(element: Element, scopeId: string): void {
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
      sanitizeElement(child, scopeId);
      child.replaceWith(...child.childNodes);
      continue;
    }
    if (child.namespaceURI !== SVG_NAMESPACE || !ALLOWED_SVG_ELEMENTS.has(name)) {
      child.remove();
      continue;
    }
    sanitizeElement(child, scopeId);
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
    element.textContent = scopeDiagramCss(element.textContent ?? "", scopeId);
  }
}

/**
 * Defense in depth over Mermaid's own DOMPurify pass. Mermaid serializes its
 * SVG as HTML, so it is parsed the way the page will parse it, in an inert
 * document that runs no scripts and loads nothing. Only static SVG drawing
 * elements survive; links, event handlers, external references and imports
 * are dropped, and diagram CSS keeps only rules scoped to the diagram root.
 * The root gets its natural size so a wide diagram scrolls inside its box
 * instead of shrinking, and XML serialization escapes all text.
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

  sanitizeElement(root, root.id);
  // The root is the diagram's only CSS box; it carries no inline style.
  root.removeAttribute("style");

  const viewBox = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u).map(Number);
  const [, , width, height] = viewBox;
  if (viewBox.length === 4 && width !== undefined && height !== undefined &&
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    root.setAttribute("width", String(Math.ceil(width)));
    root.setAttribute("height", String(Math.ceil(height)));
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * Typography the diagram is measured and shown with. Mermaid lays text out
 * from measurements taken while rendering; the final box inherits the same
 * values so page or answer typography cannot change the drawing's size.
 */
export const MERMAID_DIAGRAM_TYPOGRAPHY = {
  fontSize: "16px",
  fontStyle: "normal",
  fontWeight: "400",
  letterSpacing: "normal",
  lineHeight: "normal",
  overflowWrap: "normal",
  textTransform: "none",
  whiteSpace: "normal",
  wordSpacing: "normal"
} as const satisfies Partial<CSSStyleDeclaration>;

/** An off-screen, laid-out container with the diagram typography, so measurement never depends on the page shell. */
function createMeasurementContainer(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.dataset.aiqsaMermaidMeasure = "";
  Object.assign(container.style, MERMAID_DIAGRAM_TYPOGRAPHY, {
    contain: "layout style",
    left: "-100000px",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    visibility: "hidden",
    width: "2000px"
  });
  document.body.append(container);
  return container;
}

const FIT_PADDING = 8;

/**
 * Sets the viewBox and size from the drawing's own extent in its final
 * context, so any difference between measurement and placement can never
 * offset or clip the diagram. Returns false when the drawing has no box yet.
 */
export function fitSvgToDrawing(svg: SVGSVGElement): boolean {
  if (typeof svg.getBBox !== "function") return false;
  let box: DOMRect;
  try {
    box = svg.getBBox();
  } catch {
    return false;
  }
  if (!(box.width > 0 && box.height > 0) || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return false;
  const width = box.width + FIT_PADDING * 2;
  const height = box.height + FIT_PADDING * 2;
  svg.setAttribute("viewBox", `${box.x - FIT_PADDING} ${box.y - FIT_PADDING} ${width} ${height}`);
  svg.setAttribute("width", String(Math.ceil(width)));
  svg.setAttribute("height", String(Math.ceil(height)));
  return true;
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
  const measurement = createMeasurementContainer();
  const cleanup = () => {
    measurement?.remove();
    removeRenderLeftovers(id);
  };
  let rendering: Promise<{ svg: string }>;
  try {
    mermaid.initialize(mermaidConfig(scheme, appFontFamily()));
    rendering = measurement ? mermaid.render(id, source, measurement) : mermaid.render(id, source);
  } catch {
    cleanup();
    return { result: { ok: false, reason: "invalid" }, settled: Promise.resolve() };
  }
  // A late settlement after a timeout still removes Mermaid's temporary nodes.
  const settled = rendering.then(cleanup, cleanup);

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
    cleanup();
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
