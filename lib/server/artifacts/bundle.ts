import { Buffer } from "node:buffer";
import { ArtifactToolError } from "./errors";
import { artifactRuntimeBridge, type ArtifactRuntimeSite } from "./runtimeBridge";
import { ARTIFACT_BRIDGE_VERSION, parseArtifactLink } from "@/lib/contracts/artifactRuntime";
import { parseArtifactCss, expandArtifactCssImport } from "./css";
import { assertArtifactSingleModule, isArtifactSingleModule } from "./modulePolicy";
import { artifactResourceText } from "./resourceFetch";
import { ARTIFACT_RESOURCE_LIMITS, artifactResourceByteLimit } from "./resourcePolicy";
import { artifactExcerptBefore, artifactSourceSpan, artifactTextFromBytes, withArtifactErrorExcerpt } from "./referencedFiles";
import type { ArtifactVendorMetadata } from "./vendoring";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { serialize, type DefaultTreeAdapterMap } from "parse5";
import { parseArtifactHtml } from "./htmlParse";
import {
  ARTIFACT_LIMITS,
  artifactContentSecurityPolicy,
  ARTIFACT_KINDS,
  isArtifactTextMime,
  normalizeArtifactOperation,
  normalizedArtifactPath,
  type ArtifactKind,
  type NormalizedArtifactFile,
  type NormalizedArtifactOperation
} from "@/lib/contracts/artifacts";

const artifactChecksum = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export type ArtifactBundleFile = Readonly<{
  base64?: string;
  blob?: string;
  byteSize?: number;
  mimeType: string;
  path: string;
  text?: string;
  vendor?: ArtifactVendorMetadata;
}>;

export type ArtifactBundle = Readonly<{
  entrypoint: string | null;
  files: readonly ArtifactBundleFile[];
  kind: ArtifactKind;
  version: 1 | 2;
}>;

export type ArtifactBundleAsset = Readonly<{
  bytes: Buffer;
  mimeType: string;
  path: string;
}>;

type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const BLOCKED_ELEMENTS = new Set(["iframe", "frame", "frameset", "object", "embed", "base", "portal"]);
const SVG_ELEMENTS = new Set(["svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "image", "filter", "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix", "feMerge", "feMergeNode"]);
const RESOURCE_ATTRIBUTES = new Set(["src", "href", "poster", "background", "data", "action", "formaction"]);
const MEDIA_ELEMENTS = new Set(["audio", "video", "source", "track"]);
/** A quoted script literal, which becomes a data: URL when it is the path of an included image. */
const scriptLiteral = () => /(["'])([^"'\n]+)\1/gu;
const FILE_BLOCK_MARKUP_BYTES = '<script type="application/octet-stream" data-aiqsa-file=""></script>'.length;
export const ARTIFACT_RENDERER_VERSION = 5;
export const ARTIFACT_MAX_RENDER_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_NOTE_LIMITS = Object.freeze({ maxEntries: 32, maxHrefCharacters: 200, maxRelCharacters: 64 });
/**
 * Bytes the pages validated by one build may carry together. The entry page is always
 * validated; further pages until this budget is spent, the rest when opened. A build then
 * does about two full pages' work however many pages share one large resource.
 */
export const ARTIFACT_VALIDATION_BUDGET_BYTES = 128 * 1024 * 1024;
/** Builds validating at once; each holds its hydrated files and render cache meanwhile. */
const ARTIFACT_BUILD_CONCURRENCY = 2;
/** Each SVG validation parses its markup again, so a page bounds how many it asks for. */
export const ARTIFACT_PAGE_SVG_LIMIT = 2000;

function invalid(code: string, path: string, hint: string): never {
  throw new ArtifactToolError(code, { path, hint });
}

/** Relative paths resolve from the page, root-relative paths from the bundle root; `//host` stays external. */
function localPath(value: string, from: string): string | null {
  if (!value || /[\u0000-\u0020\u007f\\:#?%]/u.test(value) || value.startsWith("//")) return null;
  const resolved = value.startsWith("/") ? posix.normalize(value.slice(1)) : posix.normalize(posix.join(posix.dirname(from), value));
  return resolved.startsWith("../") || [".", ".."].includes(resolved) ? null : resolved;
}

/** A resource reference selects its file without a cache-busting `?query` or a `#fragment`. */
export function localResourcePath(value: string, from: string): string | null {
  const end = value.search(/[?#]/u);
  return localPath(end < 0 ? value : value.slice(0, end), from);
}

/** Every authored HTML file is a page; the bridge navigates between pages instead of embedding them. */
function isArtifactPage(file: ArtifactBundleFile): boolean {
  return !file.vendor && file.mimeType === "text/html";
}

/** HTML pages of a bundle, the entrypoint first. */
export function artifactBundlePages(bundle: Pick<ArtifactBundle, "entrypoint" | "files">): string[] {
  const pages = bundle.files.filter(isArtifactPage).map(file => file.path);
  return [...pages.filter(path => path === bundle.entrypoint), ...pages.filter(path => path !== bundle.entrypoint)];
}

/**
 * Resolves a link href to a bundle path with the runtime bridge's rules: relative to the page,
 * `/` from the bundle root, `dir/` to `dir/index.html`; the query is ignored and the fragment
 * kept. Returns null for anything that is not a local path. A path escaping the root is "".
 */
export function artifactLinkTarget(value: string, from: string): Readonly<{ path: string; fragment: string }> | null {
  const raw = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
  if (raw.length > 2048 || /[\u0000-\u001f\u007f\\]/u.test(raw) || raw.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) return null;
  const hash = raw.indexOf("#");
  const fragment = hash < 0 ? "" : raw.slice(hash + 1);
  const rest = (hash < 0 ? raw : raw.slice(0, hash)).split("?")[0]!;
  if (!rest) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(rest); } catch { return { path: "", fragment }; }
  const parts = decoded.split("/");
  const segments = decoded.startsWith("/") ? [] : posix.dirname(from).split("/").filter(part => part && part !== ".");
  for (const part of parts) {
    if (part === "..") { if (!segments.length) return { path: "", fragment }; segments.pop(); }
    else if (part && part !== ".") segments.push(part);
  }
  if (["", ".", ".."].includes(parts.at(-1)!)) segments.push("index.html");
  return { path: segments.join("/"), fragment };
}

export type ArtifactRemovedLinkNote = Readonly<{ page: string; rel: string; href: string }>;
export type ArtifactMissingLinkNote = Readonly<{ page: string; href: string; path: string }>;
/** A page other than the entrypoint that fails validation; viewing it shows the same error. */
export type ArtifactInvalidPageNote = Readonly<{ page: string; code: string }>;
/** Creation-time findings for the tool result: they never block a version. */
export type ArtifactBundleNotes = Readonly<{
  pages: readonly string[];
  removedLinks: readonly ArtifactRemovedLinkNote[];
  missingLinks: readonly ArtifactMissingLinkNote[];
  invalidPages: readonly ArtifactInvalidPageNote[];
  /** Further distinct notes beyond `ARTIFACT_NOTE_LIMITS.maxEntries` per list. */
  omitted: number;
  /** Pages left for validation when opened once the build's validation budget ran out. */
  unvalidatedPages: number;
}>;
type PageValidation = { removedLinks: ArtifactRemovedLinkNote[]; missingLinks: ArtifactMissingLinkNote[]; invalidPages: ArtifactInvalidPageNote[]; omitted: number; seen: Set<string> };

function noteText(value: string, max: number): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function addNote<T extends ArtifactRemovedLinkNote | ArtifactMissingLinkNote | ArtifactInvalidPageNote>(validation: PageValidation, list: T[], note: T): void {
  const key = JSON.stringify(note);
  if (validation.seen.has(key)) return;
  validation.seen.add(key);
  if (list.length < ARTIFACT_NOTE_LIMITS.maxEntries) list.push(note);
  else validation.omitted += 1;
}

function relationTokens(value: string | undefined): string[] {
  return (value ?? "").toLowerCase().split(/[\t\n\f\r ]+/u).filter(Boolean);
}

const ICON_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/iu;
const ICON_HINT = "Use a data: image (PNG, JPEG, WebP, GIF, SVG or ICO) or an included image file as the icon href.";

/** Browsers match rel tokens case-insensitively; only plain icon relations are inert images. */
function iconRel(value: string | undefined): boolean {
  const tokens = relationTokens(value).sort().join(" ");
  return ["icon", "icon shortcut", "apple-touch-icon"].includes(tokens);
}

function imageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/u.test(value);
}

function cssImageDataUrl(value: string, path: string, countSvg: (path: string) => void): string | null {
  if (imageDataUrl(value)) return value;
  // Static frameworks commonly percent-encode small SVG icons in CSS. Parse
  // those icons using the same strict SVG boundary, then emit an inert image.
  if (/^data:image\/svg\+xml(?:;charset=utf-8)?,/iu.test(value)) {
    countSvg(path);
    let text: string;
    try { text = decodeURIComponent(value.slice(value.indexOf(",") + 1)); }
    catch { return invalid("artifact_external_image_unsupported", path, "Use a valid self-contained SVG data image."); }
    if (Buffer.byteLength(text) > ARTIFACT_LIMITS.maxTextFileBytes) invalid("artifact_resource_too_large", path, "Use a smaller inline SVG image.");
    validateSvgText(text, path);
    return `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;
  }
  return null;
}

function rejectControlCharacters(text: string, path: string): void {
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.exec(text);
  if (control) {
    const codePoint = control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
    throw new ArtifactToolError("artifact_text_invalid", { path, excerpt: artifactExcerptBefore(text, control.index),
      hint: `Remove control characters from this file; the first, U+${codePoint}, follows the excerpt. Clean a referenced file in Workspace or remove it with an edit.` });
  }
}

function validateSvgText(text: string, path = "image.svg"): void {
  // Parse character references and attributes before checking them; namespace
  // declarations are metadata, not network requests.
  const document = parseArtifactHtml(text);
  let foundSvg = false;
  function visit(node: HtmlNode) {
    if ("tagName" in node) {
      const tag = node.tagName;
      if (["html", "head", "body"].includes(tag)) { /* parser wrappers */ }
      else if (!SVG_ELEMENTS.has(tag)) invalid("artifact_external_image_unsupported", path, "Use a self-contained SVG without scripts, handlers or external resources.");
      if (tag === "svg") foundSvg = true;
      for (const attr of node.attrs) {
        if (/^on/iu.test(attr.name) || attr.name === "style" && /@import|url\(\s*(?!["']?#)/iu.test(attr.value)) invalid("artifact_external_image_unsupported", path, "Use a self-contained SVG without scripts, handlers or external resources.");
        if (["href", "src"].includes(attr.name) && !attr.value.startsWith("#") && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(attr.value)) invalid("artifact_external_image_unsupported", path, "Use a self-contained SVG without scripts, handlers or external resources.");
        if (/url\(/iu.test(attr.value) && !/^url\(["']?#[A-Za-z0-9_-]+["']?\)$/u.test(attr.value)) invalid("artifact_external_image_unsupported", path, "Use a self-contained SVG without scripts, handlers or external resources.");
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(document);
  if (!foundSvg || /<!ENTITY|<!DOCTYPE/iu.test(text)) invalid("artifact_external_image_unsupported", path, "Use a self-contained SVG without scripts, handlers or external resources.");
}

export function encodeArtifactBundle(bundle: ArtifactBundle): Buffer {
  const bytes = Buffer.from(JSON.stringify(bundle), "utf8");
  if (bytes.byteLength > ARTIFACT_LIMITS.maxBundleBytes) throw new Error("artifact_bundle_limit_exceeded");
  return bytes;
}

export function decodeArtifactBundle(bytes: Uint8Array): ArtifactBundle {
  if (bytes.byteLength < 2 || bytes.byteLength > ARTIFACT_LIMITS.maxBundleBytes) throw new Error("artifact_bundle_invalid");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("artifact_bundle_invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("artifact_bundle_invalid");
  const bundle = value as Partial<ArtifactBundle>;
  if (bundle.version !== 1 && bundle.version !== 2 || !Array.isArray(bundle.files) || bundle.files.length < 1 ||
    bundle.files.length > ARTIFACT_LIMITS.maxBundleFiles + ARTIFACT_RESOURCE_LIMITS.maxResources || !ARTIFACT_KINDS.includes(bundle.kind as ArtifactKind)) throw new Error("artifact_bundle_invalid");
  if (bundle.entrypoint !== null && typeof bundle.entrypoint !== "string") throw new Error("artifact_bundle_invalid");
  const files = bundle.files.map((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file) || typeof file.path !== "string" ||
      typeof file.mimeType !== "string" || [file.text, file.base64, file.blob].filter(value => value !== undefined).length !== 1 ||
      (file.text !== undefined && typeof file.text !== "string")) throw new Error("artifact_bundle_invalid");
    if (file.blob !== undefined && (bundle.version !== 2 || typeof file.blob !== "string" || !/^[a-f0-9]{64}$/u.test(file.blob) ||
      !Number.isSafeInteger(file.byteSize) || file.byteSize! < 1 || file.byteSize! > ARTIFACT_LIMITS.maxAssetBytes)) throw new Error("artifact_bundle_invalid");
    if (file.base64 !== undefined) {
      if (bundle.version !== 1 || typeof file.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.base64) || file.base64.length % 4 === 1) throw new Error("artifact_bundle_invalid");
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.byteLength > ARTIFACT_LIMITS.maxAssetBytes || bytes.toString("base64") !== file.base64) throw new Error("artifact_bundle_invalid");
    }
    return file as ArtifactBundleFile;
  });
  const authored = files.filter(file => !file.vendor);
  const vendors = files.filter(file => file.vendor);
  if (new Set(files.map(file => file.path)).size !== files.length || vendors.length > ARTIFACT_RESOURCE_LIMITS.maxResources ||
    vendors.reduce((sum, file) => sum + file.byteSize!, 0) > ARTIFACT_RESOURCE_LIMITS.maxBytes) throw new Error("artifact_bundle_invalid");
  for (const file of vendors) {
    const vendor = file.vendor!;
    if (bundle.version !== 2 || typeof vendor !== "object" || vendor === null || Array.isArray(vendor) ||
      !["script", "style", "font", "image"].includes(vendor.resourceClass) || vendor.sha256 !== file.blob || vendor.byteSize !== file.byteSize ||
      file.byteSize! > artifactResourceByteLimit(vendor.resourceClass) || file.text !== undefined || file.base64 !== undefined ||
      !new RegExp(`^_vendor/${vendor.sha256.slice(0, 12)}/[A-Za-z0-9._-]{1,100}$`, "u").test(file.path) || [".", ".."].includes(posix.basename(file.path))) throw new Error("artifact_bundle_invalid");
    if (vendor.resourceClass === "script" && file.mimeType !== "text/javascript" || vendor.resourceClass === "style" && file.mimeType !== "text/css" ||
      vendor.resourceClass === "image" && !/^image\/(?:png|jpeg|webp)$/u.test(file.mimeType) ||
      vendor.resourceClass === "font" && !/^(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype))$/u.test(file.mimeType)) throw new Error("artifact_bundle_invalid");
    for (const address of [vendor.sourceUrl, ...(vendor.resolvedUrl === undefined ? [] : [vendor.resolvedUrl])]) {
      if (typeof address !== "string" || address.length > ARTIFACT_RESOURCE_LIMITS.maxUrlCharacters) throw new Error("artifact_bundle_invalid");
      let url: URL; try { url = new URL(address); } catch { throw new Error("artifact_bundle_invalid"); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) throw new Error("artifact_bundle_invalid");
    }
  }
  try {
    normalizeArtifactOperation({
      entrypoint: bundle.entrypoint ?? undefined,
      files: authored.map((file) => file.text !== undefined
        ? { mimeType: file.mimeType, path: file.path, text: file.text }
        : { assetRef: "decoded", mimeType: file.mimeType, path: file.path }),
      intent: "create",
      kind: bundle.kind,
      title: "decoded artifact"
    }, undefined, { stored: true });
  } catch {
    throw new Error("artifact_bundle_invalid");
  }
  return { entrypoint: bundle.entrypoint ?? null, files, kind: bundle.kind as ArtifactKind, version: bundle.version as 1 | 2 };
}

export type BuiltArtifactBundle = Readonly<{ bundle: ArtifactBundle; bytes: Buffer; checksum: string; notes: ArtifactBundleNotes }>;

/** Builds and validates a bundle in one synchronous pass. */
export function buildArtifactBundle(
  operation: NormalizedArtifactOperation,
  assets: readonly ArtifactBundleAsset[],
  vendorFiles: readonly ArtifactBundleFile[] = []
): BuiltArtifactBundle {
  const steps = bundleBuildSteps(operation, assets, vendorFiles);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

let activeBuilds = 0;
const waitingBuilds: Array<() => void> = [];

async function acquireBuildSlot(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activeBuilds < ARTIFACT_BUILD_CONCURRENCY) { activeBuilds += 1; return; }
  await new Promise<void>((resolve, reject) => {
    const abort = () => { waitingBuilds.splice(waitingBuilds.indexOf(start), 1); reject(signal!.reason); };
    // A finishing build hands its slot over directly, so the count never exceeds the bound.
    const start = () => { signal?.removeEventListener("abort", abort); resolve(); };
    waitingBuilds.push(start);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function releaseBuildSlot(): void {
  const next = waitingBuilds.shift();
  if (next) next(); else activeBuilds -= 1;
}

/**
 * Builds a bundle without holding the event loop: pages are validated one per turn, a
 * stopped run ends between pages with its signal's reason, and at most
 * `ARTIFACT_BUILD_CONCURRENCY` builds validate at once while the others wait.
 */
export async function buildArtifactBundleAsync(
  operation: NormalizedArtifactOperation,
  assets: readonly ArtifactBundleAsset[],
  vendorFiles: readonly ArtifactBundleFile[] = [],
  options: Readonly<{ signal?: AbortSignal }> = {}
): Promise<BuiltArtifactBundle> {
  await acquireBuildSlot(options.signal);
  try {
    const steps = bundleBuildSteps(operation, assets, vendorFiles);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      await new Promise(resolve => setImmediate(resolve));
      options.signal?.throwIfAborted();
    }
  } finally { releaseBuildSlot(); }
}

/** The build, yielding before each unit of page work. */
function* bundleBuildSteps(
  operation: NormalizedArtifactOperation,
  assets: readonly ArtifactBundleAsset[],
  vendorFiles: readonly ArtifactBundleFile[]
): Generator<void, BuiltArtifactBundle, void> {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const files: ArtifactBundleFile[] = operation.files.map((file: NormalizedArtifactFile) => {
    if (file.text !== undefined) {
      rejectControlCharacters(file.text, file.path);
      return { mimeType: file.mimeType, path: file.path, text: file.text };
    }
    const asset = byPath.get(file.path);
    if (!asset || !file.assetRef) throw new Error("artifact_asset_unavailable");
    if (asset.bytes.byteLength < 1 || asset.bytes.byteLength > ARTIFACT_LIMITS.maxAssetBytes) throw new Error("artifact_bundle_limit_exceeded");
    // By-reference text is stored as a blob too and becomes text again below.
    return { blob: artifactChecksum(asset.bytes), byteSize: asset.bytes.byteLength, mimeType: file.mimeType, path: file.path };
  });
  if (files.some(file => file.path === "_vendor" || file.path.startsWith("_vendor/")) ||
    new Set([...files, ...vendorFiles].map(file => file.path)).size !== files.length + vendorFiles.length) {
    invalid("artifact_path_duplicate", "_vendor", "The _vendor namespace is read-only; use ordinary authored file paths.");
  }
  files.push(...vendorFiles);
  const bundle: ArtifactBundle = { entrypoint: operation.entrypoint, files, kind: operation.kind, version: 2 };
  const bytes = encodeArtifactBundle(bundle);
  const hydrated = { ...bundle, files: files.map(file => file.blob ? hydrateArtifactBundleFile(file, byPath.get(file.path)!.bytes) : file) };
  for (const file of hydrated.files) if (file.blob && !file.vendor && file.text !== undefined) rejectControlCharacters(file.text, file.path);
  // Every page is validated by the same renderer that later serves it. Pages share one cache
  // of their page-independent transforms, so a resource they all use is transformed once.
  const pages = artifactBundlePages(bundle);
  const validation: PageValidation = { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, seen: new Set() };
  const cache = createArtifactRenderCache(hydrated);
  yield;
  const entryAccount = newRenderAccount();
  renderBundlePage(hydrated, false, undefined, validation, cache, entryAccount);
  let spent = entryAccount.expandedBytes;
  let unvalidatedPages = 0;
  // Only the entrypoint must render: another page that fails is noted, keeps the bundle
  // editable, and shows its error when opened, like a page left unvalidated by the budget.
  for (const page of pages) if (page !== bundle.entrypoint) {
    if (spent >= ARTIFACT_VALIDATION_BUDGET_BYTES) { unvalidatedPages += 1; continue; }
    yield;
    const mark = { removed: validation.removedLinks.length, missing: validation.missingLinks.length, omitted: validation.omitted };
    const account = newRenderAccount();
    try { renderBundlePage(hydrated, false, page, validation, cache, account); }
    catch (error) {
      if (!(error instanceof ArtifactToolError)) throw error;
      // A page that cannot render contributes no link notes, only its failure.
      validation.removedLinks.length = mark.removed; validation.missingLinks.length = mark.missing; validation.omitted = mark.omitted;
      addNote(validation, validation.invalidPages, { page, code: error.code });
    }
    finally { spent += account.expandedBytes; }
  }
  // A non-entry SVG stored as bytes is only ever an image or fetched bytes; authored SVG text keeps the strict subset.
  for (const file of files) if (file.mimeType === "image/svg+xml" && !file.blob && file.path !== bundle.entrypoint) {
    yield;
    renderArtifactBundle({ ...hydrated, kind: "svg", entrypoint: file.path }, true);
  }
  const notes = { pages, removedLinks: validation.removedLinks, missingLinks: validation.missingLinks, invalidPages: validation.invalidPages,
    omitted: validation.omitted, unvalidatedPages };
  return { bundle, bytes, checksum: artifactChecksum(bytes), notes };
}

/** Whether a stored blob becomes text (vendored code, by-reference text) rather than base64. */
export function artifactBlobIsText(file: Pick<ArtifactBundleFile, "mimeType" | "vendor">): boolean {
  return file.vendor ? ["script", "style"].includes(file.vendor.resourceClass) : isArtifactTextMime(file.mimeType);
}

export function hydrateArtifactBundleFile(file: ArtifactBundleFile, bytes: Buffer): ArtifactBundleFile {
  if (!artifactBlobIsText(file)) return { ...file, base64: bytes.toString("base64") };
  return { ...file, text: file.vendor ? artifactResourceText(bytes, file.path) : artifactTextFromBytes(bytes, file.path) };
}

export function bundleFileBytes(file: ArtifactBundleFile): Buffer {
  if (file.text !== undefined) return Buffer.from(file.text, "utf8");
  if (!file.base64) throw new Error("artifact_bundle_file_invalid");
  return Buffer.from(file.base64, "base64");
}

type RenderedArtifact = Readonly<{ body: Buffer; contentType: string; fileName: string }>;

/**
 * What a page's accounting sees of a transform: SVG images counted, files embedded as data:
 * URLs (with the page's own first parse of an SVG file) and text added. Replaying a cached
 * transform's effects on a page performs the same checks in the same order as computing it
 * there; adjacent effects on one file merge, since they fail with the same error.
 */
type RenderEffect =
  | { kind: "svg"; path: string; count: number }
  | { kind: "data"; file: ArtifactBundleFile; count: number }
  | { kind: "text"; path: string; bytes: number };
/** A transform computed once: its text or its page-independent error, after its effects. */
type CachedTransform = Readonly<{ effects: readonly RenderEffect[]; text?: string; error?: unknown; overflow?: boolean }>;
/** One page's accounting; a cached transform is computed in a fresh recording account. */
type RenderAccount = { inlined: Set<string>; expandedBytes: number; svgCount: number; svgFiles: Map<string, string>; effects?: RenderEffect[]; overflow: boolean };

const newRenderAccount = (effects?: RenderEffect[]): RenderAccount =>
  ({ inlined: new Set(), expandedBytes: 0, svgCount: 0, svgFiles: new Map(), effects, overflow: false });

/**
 * Page-independent transforms of one bundle, shared by the pages rendered from it: SVG files,
 * linked stylesheets, linked scripts (per page folder, which their literal paths resolve
 * from) and the values derived from single files. Rendering with or without it is identical.
 */
export type ArtifactRenderCache = Readonly<{
  bundle: ArtifactBundle;
  enabled: boolean;
  files: ReadonlyMap<string, ArtifactBundleFile>;
  /** Last path segments of the bundle's images: a script literal ending otherwise is no image path. */
  imageNames: ReadonlySet<string>;
  svgImages: Map<string, CachedTransform>;
  stylesheets: Map<string, CachedTransform>;
  scriptLiterals: Map<string, CachedTransform>;
  values: Map<string, string | number | boolean>;
}>;

export function createArtifactRenderCache(bundle: ArtifactBundle, enabled = true): ArtifactRenderCache {
  return { bundle, enabled, files: new Map(bundle.files.map(file => [file.path, file])),
    imageNames: new Set(bundle.files.filter(file => file.mimeType.startsWith("image/")).map(file => posix.basename(file.path))),
    svgImages: new Map(), stylesheets: new Map(), scriptLiterals: new Map(), values: new Map() };
}

/**
 * Renders the entrypoint, or another HTML page of the bundle. Each page embeds every non-page
 * file it does not inline once as an inert `<script type="application/octet-stream"
 * data-aiqsa-file>` block, which the runtime bridge serves to fetch, XHR and src.
 */
export function renderArtifactBundle(bundle: ArtifactBundle, mainFile = false, page?: string, cache?: ArtifactRenderCache): RenderedArtifact {
  return renderBundlePage(bundle, mainFile, page, undefined, cache)!;
}

/** With `validation`, records notes and measures file blocks without materializing them. */
function renderBundlePage(bundle: ArtifactBundle, mainFile: boolean, page: string | undefined, validation?: PageValidation,
  cache: ArtifactRenderCache = createArtifactRenderCache(bundle), pageAccount = newRenderAccount()): RenderedArtifact | null {
  if (cache.bundle !== bundle) throw new Error("artifact_render_cache_invalid");
  if (page !== undefined && page !== bundle.entrypoint && !bundle.files.some(file => file.path === page && isArtifactPage(file))) {
    throw new ArtifactToolError("artifact_page_not_found", { ...(normalizedArtifactPath(page) === page ? { path: page } : {}),
      hint: "Open the entry page or another HTML page of this artifact." });
  }
  const selected = page ?? bundle.entrypoint;
  if (bundle.kind === "image" && bundle.files.length === 1) {
    const image = bundle.files[0]!;
    if (!image.base64 || !/^image\/(?:png|jpeg|webp)$/u.test(image.mimeType)) throw new Error("artifact_bundle_image_missing");
    return { body: bundleFileBytes(image), contentType: image.mimeType, fileName: `image.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}` };
  }
  const entry = bundle.files.find((file) => file.path === selected);
  if (bundle.kind !== "image" && (!entry || entry.text === undefined)) throw new Error("artifact_bundle_entrypoint_missing");
  const files = cache.files;
  // Files a reference needs at runtime even when an unrelated static reference inlined them.
  const runtime = new Set<string>();
  let media = false;
  // The account that checks and records effects: the page's own, or a cached transform's.
  let account = pageAccount;
  // Files this page already carries as text or data: URLs. Count only bytes this page
  // actually carries; inlined resources add their own size.
  if (entry) account.inlined.add(entry.path);
  account.expandedBytes += entry?.text === undefined ? 0 : Buffer.byteLength(entry.text);
  function memo<T extends string | number | boolean>(key: string, compute: () => T): T {
    if (!cache.enabled) return compute();
    const known = cache.values.get(key);
    if (known !== undefined) return known as T;
    const value = compute();
    cache.values.set(key, value);
    return value;
  }
  function record(effect: RenderEffect): void {
    const effects = account.effects;
    if (!effects) return;
    const last = effects.at(-1);
    if (last?.kind === "data" && effect.kind === "data" && last.file === effect.file) last.count += effect.count;
    else if (last?.kind === "svg" && effect.kind === "svg" && last.path === effect.path) last.count += effect.count;
    else if (last?.kind === "text" && effect.kind === "text" && last.path === effect.path) last.bytes += effect.bytes;
    else effects.push({ ...effect });
  }
  /** Computes a page-independent transform once per bundle, then replays its effects on each page. */
  function cached(store: Map<string, CachedTransform>, key: string, compute: () => string): string {
    if (!cache.enabled) return compute();
    let transform = store.get(key);
    if (!transform) {
      const outer = account;
      const isolated = newRenderAccount([]);
      account = isolated;
      try { transform = { effects: isolated.effects!, text: compute() }; }
      // A limit reached alone may not be reached on a page that already carries some of
      // the same SVG files, so such a transform is computed on each page instead.
      catch (error) { transform = isolated.overflow ? { effects: [], overflow: true } : { effects: isolated.effects!, error }; }
      finally { account = outer; }
      store.set(key, transform);
    }
    if (transform.overflow) return compute();
    for (const effect of transform.effects) {
      if (effect.kind === "svg") countSvg(effect.path, effect.count);
      else if (effect.kind === "data") embed(effect.file, effect.count);
      else countText(effect.path, effect.bytes);
    }
    if (transform.error !== undefined) throw transform.error;
    return transform.text!;
  }
  function countSvg(path: string, count = 1): void {
    record({ kind: "svg", path, count });
    account.svgCount += count;
    if (account.svgCount > ARTIFACT_PAGE_SVG_LIMIT) {
      account.overflow = true;
      invalid("artifact_svg_limit_exceeded", path,
        `Use at most ${ARTIFACT_PAGE_SVG_LIMIT} inline SVG images per page: define a repeated icon once as an SVG <symbol> and show it with <use href="#id">, or reference one included SVG file.`);
    }
  }
  // An SVG file renders the same for every reference, so repeated references parse it once.
  function svgImage(file: ArtifactBundleFile): string {
    const seen = account.svgFiles.get(file.path);
    if (seen !== undefined) return seen;
    const text = cached(cache.svgImages, file.path, () => {
      try { return svg(file.text ?? "", file.path); }
      catch (error) {
        // An SVG supplied as bytes (by reference or from an archive) shows here only as an image,
        // which runs no script and loads nothing, so editor markup outside the strict subset keeps
        // its own bytes. Authored SVG text keeps the strict subset.
        if (!file.blob || !(error instanceof ArtifactToolError) || error.code !== "artifact_external_image_unsupported") throw error;
        return file.text ?? "";
      }
    });
    account.svgFiles.set(file.path, text);
    return text;
  }
  /** Accounts for `count` data: URL references to one file. */
  function embed(file: ArtifactBundleFile, count: number): void {
    record({ kind: "data", file, count });
    // The file's own first SVG parse belongs to this effect, not to a transform recording it.
    const effects = account.effects;
    account.effects = undefined;
    try {
      account.inlined.add(file.path);
      const svgText = file.mimeType === "image/svg+xml" ? svgImage(file) : undefined;
      // Bound expansion before allocating repeated base64 substitutions. A tiny
      // authored document can otherwise repeat one large image thousands of times.
      account.expandedBytes += count * memo(`data-bytes:${file.path}`, () =>
        32 + (file.base64?.length ?? 4 * Math.ceil(Buffer.byteLength(svgText ?? file.text ?? "") / 3)));
      if (account.expandedBytes > ARTIFACT_MAX_RENDER_BYTES) {
        account.overflow = true;
        invalid("artifact_bundle_limit_exceeded", file.path, "Reduce repeated embedded images or use smaller image assets.");
      }
    } finally { account.effects = effects; }
  }
  function dataUrl(file: ArtifactBundleFile): string {
    embed(file, 1);
    return memo(`data-url:${file.path}`, () => {
      const svgText = file.mimeType === "image/svg+xml" ? svgImage(file) : undefined;
      return `data:${file.mimeType};base64,${file.base64 ?? (svgText === undefined ? bundleFileBytes(file) : Buffer.from(svgText)).toString("base64")}`;
    });
  }
  function countText(path: string, bytes: number): void {
    record({ kind: "text", path, bytes });
    account.expandedBytes += bytes;
    if (account.expandedBytes > ARTIFACT_MAX_RENDER_BYTES) {
      account.overflow = true;
      invalid("artifact_bundle_limit_exceeded", path, "Reduce repeated embedded scripts, styles or images.");
    }
  }
  function countExpansion(text: string, path: string): string {
    countText(path, Buffer.byteLength(text));
    return text;
  }
  function resolve(value: string, from: string, code = "artifact_external_image_unsupported", baseUrl?: string): ArtifactBundleFile {
    const path = baseUrl ? null : localResourcePath(value, from);
    let file = path ? files.get(path) : undefined;
    if (!file) {
      let url: string | undefined;
      try { url = new URL(value, baseUrl).href; } catch { /* local reference */ }
      if (url) file = bundle.files.find(file => file.vendor?.sourceUrl === url);
    }
    if (!file) invalid(code, from, "Remove the external reference; inline the code or use an included file.");
    return file;
  }
  function css(source: string, from: string, ancestry: readonly string[] = []): string {
    if (ancestry.includes(from) || ancestry.length > ARTIFACT_RESOURCE_LIMITS.cssDepth) invalid("artifact_resource_too_large", from, "Remove cyclic or deeply nested CSS imports.");
    const vendor = files.get(from)?.vendor;
    const baseUrl = vendor?.resolvedUrl ?? vendor?.sourceUrl;
    const parsed = parseArtifactCss(source, from);
    for (const reference of parsed.references) {
      if (reference.kind === "import") {
        if (!vendor) invalid("artifact_css_import_unsupported", from, "Remove authored CSS @import and include a stylesheet file instead.");
        const file = resolve(reference.value, from, "artifact_external_style_unsupported", baseUrl);
        if (file.mimeType !== "text/css" || file.text === undefined) invalid("artifact_resource_type_mismatch", from, "Import a static CSS file.");
        expandArtifactCssImport(reference, css(file.text, file.path, [...ancestry, from]), from);
        continue;
      }
      if (reference.value.startsWith("#") || /^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype));base64,[A-Za-z0-9+/]+=*$/u.test(reference.value)) continue;
      const inlineImage = cssImageDataUrl(reference.value, from, countSvg);
      if (inlineImage) { reference.replace(inlineImage); continue; }
      if (!vendor && !localResourcePath(reference.value, from)) invalid("artifact_external_image_unsupported", from, "Use included images in authored CSS; external url() is supported only inside downloaded stylesheets.");
      const file = resolve(reference.value, from, "artifact_external_image_unsupported", baseUrl);
      if (!file.mimeType.startsWith("image/") && file.vendor?.resourceClass !== "font") invalid("artifact_external_image_unsupported", from, "Use an included image or font for CSS url().");
      reference.replace(dataUrl(file));
    }
    return countExpansion(parsed.text().replace(/<\/style/giu, "<\\/style"), from);
  }
  function svg(source: string, from: string): string {
    countSvg(from);
    const parsed = parseArtifactHtml(source);
    let root: Element | undefined;
    let changed = false;
    function visit(node: HtmlNode): void {
      if ("tagName" in node) {
        if (node.tagName === "svg" && !root) root = node;
        if (node.tagName === "image") for (const attr of node.attrs) if (attr.name === "href" && !attr.value.startsWith("#") && !imageDataUrl(attr.value)) {
          const image = resolve(attr.value, from);
          if (!/^image\/(?:png|jpeg|webp)$/u.test(image.mimeType)) invalid("artifact_external_image_unsupported", from, "Use an included raster image in SVG.");
          attr.value = dataUrl(image);
          changed = true;
        }
      }
      if ("childNodes" in node) node.childNodes.forEach(visit);
    }
    visit(parsed);
    const result = root && changed ? serialize({ nodeName: "#document-fragment", childNodes: [root] }) : source;
    validateSvgText(result, from);
    return result;
  }
  function linkedScript(file: ArtifactBundleFile, source: string): string {
    const text = memo(`script:${file.path}`, () => source.replace(/<\/script/giu, "<\\/script"));
    countText(file.path, memo(`script-bytes:${file.path}`, () => Buffer.byteLength(text)));
    return text;
  }
  /** A path resolves to an image only when its last segment is that image's name or a dot segment. */
  function mayNameImage(value: string): boolean {
    const name = value.slice(value.lastIndexOf("/") + 1);
    return name === "." || name === ".." || cache.imageNames.has(name);
  }
  function imageLiteralCandidate(source: string): boolean {
    for (const match of source.matchAll(scriptLiteral())) if (mayNameImage(match[2]!)) return true;
    return false;
  }
  /** Quoted local image paths in script text become data: URLs. */
  function scriptLiterals(source: string, from: string): string {
    let changed = false;
    const result = source.replace(scriptLiteral(), (match, quote: string, value: string) => {
      if (!mayNameImage(value)) return match;
      const path = localPath(value, from);
      const file = path ? files.get(path) : null;
      if (!file?.mimeType.startsWith("image/")) return match;
      changed = true;
      return `${quote}${dataUrl(file)}${quote}`;
    });
    return changed ? result : source;
  }
  if (bundle.kind === "svg" && mainFile && selected === bundle.entrypoint) {
    return { body: Buffer.from(svg(entry!.text!, entry!.path)), contentType: "image/svg+xml; charset=utf-8", fileName: "image.svg" };
  }
  const source = bundle.kind === "image"
    ? `<!doctype html><html><head><title>Images</title></head><body style="margin:0;display:grid;gap:1rem">${bundle.files.map((file) => `<img alt="Image" style="max-width:100%;margin:auto" src="${dataUrl(file)}">`).join("")}</body></html>`
    : entry!.mimeType === "image/svg+xml"
      ? `<!doctype html><html><head><title>SVG</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh">${svg(entry!.text!, entry!.path)}</body></html>`
      : entry!.text!;
  // Source offsets locate a markup error in the entry file, so the model can
  // write an exact edit for a file it never saw (one supplied by reference).
  const document = parseArtifactHtml(source, { sourceCodeLocationInfo: true });
  const from = entry?.path ?? "index.html";
  function iconHref(value: string): string {
    // Icons load through img-src; keep them inline like other images.
    if (ICON_DATA_URL.test(value)) return value;
    if (/^data:/iu.test(value)) return cssImageDataUrl(value, from, countSvg) ?? invalid("artifact_external_image_unsupported", from, ICON_HINT);
    const path = localResourcePath(value, from);
    const file = path ? files.get(path) : undefined;
    return file?.mimeType.startsWith("image/") ? dataUrl(file) : invalid("artifact_external_image_unsupported", from, ICON_HINT);
  }
  function visit(node: HtmlNode): void {
    // The innermost failing element of the entry file names the location.
    try { visitNode(node); }
    catch (error) { throw source === entry?.text ? withArtifactErrorExcerpt(error, source, artifactSourceSpan(node), from) : error; }
  }
  function visitNode(node: HtmlNode): void {
    if ("tagName" in node) {
      let inlinedStyle = false;
      let linked: ArtifactBundleFile | undefined;
      if (BLOCKED_ELEMENTS.has(node.tagName)) invalid("artifact_element_unsupported", from, "Remove the unsupported element and use ordinary HTML, SVG or canvas.");
      if (node.tagName === "meta" && node.attrs.some((attr) => attr.name === "http-equiv")) invalid("artifact_element_unsupported", from, "Remove http-equiv metadata; the server supplies the security policy.");
      // The bridge's attributes belong to the server; authored copies are dropped.
      node.attrs = node.attrs.filter(attr => attr.name !== "data-aiqsa-src" && attr.name !== "data-aiqsa-file");
      const relation = node.attrs.find(attr => attr.name === "rel")?.value;
      const href = node.attrs.find(attr => attr.name === "href");
      // A link is inlined as a stylesheet or an icon; any other relation (resource hints,
      // manifests, alternates, metadata) would only reach the network, so the page drops it.
      if (node.tagName === "link" && !(href && (relationTokens(relation).join(" ") === "stylesheet" || iconRel(relation)))) {
        if (validation) addNote(validation, validation.removedLinks, { page: from, rel: noteText(relationTokens(relation).join(" "), ARTIFACT_NOTE_LIMITS.maxRelCharacters),
          href: noteText(href?.value ?? "", ARTIFACT_NOTE_LIMITS.maxHrefCharacters) });
        const siblings = node.parentNode?.childNodes;
        siblings?.splice(siblings.indexOf(node), 1);
        return;
      }
      if (node.tagName === "svg") {
        // Resolve image hrefs before applying the unchanged strict SVG subset.
        const rendered = parseArtifactHtml(svg(serialize({ nodeName: "#document-fragment", childNodes: [node] }), from));
        const findSvg = (candidate: HtmlNode): Element | undefined => "tagName" in candidate && candidate.tagName === "svg" ? candidate
          : "childNodes" in candidate ? candidate.childNodes.map(findSvg).find(Boolean) : undefined;
        const replacement = findSvg(rendered)!;
        node.attrs = replacement.attrs; node.childNodes = replacement.childNodes;
        for (const child of node.childNodes) child.parentNode = node;
        return;
      }
      const type = node.attrs.find(attr => attr.name === "type")?.value.toLowerCase();
      if (node.tagName === "script" && ["importmap", "text/babel", "text/jsx", "text/tsx"].includes(type ?? "")) invalid("artifact_module_graph_unsupported", from,
        "Use plain JavaScript or a self-contained UMD/IIFE build; browser compilers and import maps are unsupported. " +
        "Bundle the site into one file with esbuild in the Workspace (esbuild main.js --bundle --outfile=app.js), then reference app.js; without the Workspace, tell the user.");
      const reference = node.tagName === "link" ? href : node.attrs.find(attr => attr.name === "src");
      const iconLink = node.tagName === "link" && iconRel(relation);
      if (iconLink) reference!.value = iconHref(reference!.value);
      else if ((node.tagName === "script" || node.tagName === "link") && reference) {
        const script = node.tagName === "script";
        const file = resolve(reference.value, from, script ? "artifact_external_script_unsupported" : "artifact_external_style_unsupported");
        if (!(script ? ["text/javascript", "application/javascript", "application/x-javascript"].includes(file.mimeType) : file.mimeType === "text/css") || file.text === undefined) invalid("artifact_mime_invalid", from, "Use a text/javascript script or text/css stylesheet file.");
        const text = file.text;
        if (script && type === "module") assertArtifactSingleModule(text, file.path, memo(`module:${file.path}`, () => isArtifactSingleModule(text)));
        account.inlined.add(file.path);
        const retained = node.attrs.filter(attr => script ? ["type", "id", "nomodule"].includes(attr.name) : ["media", "id", "title"].includes(attr.name));
        node.tagName = script ? "script" : "style";
        node.nodeName = node.tagName;
        node.attrs = retained;
        node.childNodes = [{ nodeName: "#text", value: script ? linkedScript(file, text) : cached(cache.stylesheets, file.path, () => css(text, file.path)), parentNode: node }];
        inlinedStyle = !script;
        if (script) linked = file;
      }
      if (node.tagName === "a") {
        node.attrs = node.attrs.filter(attr => !["target", "rel"].includes(attr.name));
        node.attrs.push({ name: "rel", value: "noopener noreferrer" });
      }
      for (const attr of node.attrs) {
        if (["action", "formaction"].includes(attr.name)) invalid("artifact_external_link_unsupported", from, "Remove action/formaction and handle submit in JavaScript.");
        if (["srcdoc", "srcset", "ping"].includes(attr.name)) invalid("artifact_element_unsupported", from, "Replace the unsupported attribute with a direct reference to an included file.");
        if (attr.name === "style") attr.value = css(attr.value, from);
        if (RESOURCE_ATTRIBUTES.has(attr.name)) {
          if (attr.value.startsWith("#") || iconLink && attr === reference) continue;
          if (node.tagName === "a" && attr.name === "href") {
            const link = parseArtifactLink(attr.value);
            if (link) { attr.value = link; continue; }
            // Local links keep their authored href; the bridge resolves it with the same rules.
            const target = artifactLinkTarget(attr.value, from);
            if (!target) invalid("artifact_external_link_unsupported", from, "Use an http, https or mailto link, a #fragment, or the relative path of a page or file in this artifact.");
            const file = files.get(target.path);
            if (!file || file.vendor) {
              if (validation) addNote(validation, validation.missingLinks, { page: from, href: noteText(attr.value, ARTIFACT_NOTE_LIMITS.maxHrefCharacters),
                path: noteText(target.path, ARTIFACT_NOTE_LIMITS.maxHrefCharacters) });
            } else if (!isArtifactPage(file)) runtime.add(file.path);
            continue;
          }
          if (attr.name === "src" && MEDIA_ELEMENTS.has(node.tagName)) {
            if (/^data:/iu.test(attr.value)) continue;
            // Media plays from a blob: URL the bridge creates from this file's block.
            const path = localResourcePath(attr.value, from);
            const file = path ? files.get(path) : undefined;
            if (!file || file.vendor || isArtifactPage(file)) invalid("artifact_external_media_unsupported", from, "Include the audio, video or caption file in the artifact and reference it by its relative path.");
            attr.name = "data-aiqsa-src"; attr.value = file.path;
            runtime.add(file.path); media = true;
            continue;
          }
          if (attr.name === "poster" && node.tagName === "video") {
            if (imageDataUrl(attr.value)) continue;
            const file = resolve(attr.value, from);
            if (!file.mimeType.startsWith("image/")) invalid("artifact_external_image_unsupported", from, "Use an included image as the video poster.");
            attr.value = dataUrl(file); continue;
          }
          if (imageDataUrl(attr.value) && attr.name === "src" && node.tagName === "img") continue;
          const code = attr.name === "href" ? "artifact_external_link_unsupported" : "artifact_external_image_unsupported";
          const file = resolve(attr.value, from, code);
          if (!file.mimeType.startsWith("image/") || !["img", "image"].includes(node.tagName)) invalid(code, from, "Write the destination as plain text or use an included image.");
          attr.value = dataUrl(file);
        }
      }
      node.attrs = node.attrs.filter(attr => !["integrity", "crossorigin"].includes(attr.name));
      if (node.tagName === "style" && !inlinedStyle) {
        for (const child of node.childNodes) if (child.nodeName === "#text" && "value" in child) child.value = css(child.value, from);
      }
      if (node.tagName === "script") {
        for (const child of node.childNodes) if (child.nodeName === "#text" && "value" in child) {
          const text = child.value;
          if (linked) {
            // A linked file's literal paths resolve from the page's folder.
            const file = linked;
            if (type === "module") assertArtifactSingleModule(text, from, memo(`linked-module:${file.path}`, () => isArtifactSingleModule(text)));
            // Without a literal that could name an image, every folder leaves the text as it is.
            if (memo(`script-literals:${file.path}`, () => imageLiteralCandidate(text))) {
              child.value = cached(cache.scriptLiterals, `${file.path}\u0000${posix.dirname(from)}`, () => scriptLiterals(text, from));
            }
            continue;
          }
          if (type === "module") assertArtifactSingleModule(text, from);
          child.value = scriptLiterals(text, from);
        }
      }
    }
    // Iterate a copy: dropped service links leave their parent's child list.
    if ("childNodes" in node) [...node.childNodes].forEach(visit);
    if ("content" in node) visit(node.content);
  }
  visit(document);
  const { expandedBytes, inlined } = pageAccount;
  // Pages are never blocks (navigation shows them); vendored copies serve only their static references.
  const blocks = bundle.files.filter(file => !file.vendor && !isArtifactPage(file) && (!inlined.has(file.path) || runtime.has(file.path)));
  const blockPaths = new Set(blocks.map(file => file.path));
  let blockBytes = 0;
  for (const file of blocks) {
    const size = memo(`block-bytes:${file.path}`, () =>
      file.base64?.length ?? 4 * Math.ceil((file.text === undefined ? bundleFileBytes(file).byteLength : Buffer.byteLength(file.text)) / 3));
    blockBytes += FILE_BLOCK_MARKUP_BYTES + Buffer.byteLength(file.path) + size;
    if (expandedBytes + blockBytes > ARTIFACT_MAX_RENDER_BYTES) invalid("artifact_bundle_limit_exceeded", file.path, "Each page embeds every file it does not inline once; use smaller files or fewer repeated inline images.");
  }
  const site: ArtifactRuntimeSite = { page: entry?.path ?? "", media, files: bundle.files.filter(file => !file.vendor)
    .map(file => [file.path, file.mimeType, isArtifactPage(file) ? "page" : blockPaths.has(file.path) ? "block" : "inline"] as const) };
  const htmlNode = document.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "html")!;
  const head = htmlNode.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "head")!;
  const script = (attrs: Element["attrs"], text: string): Element => {
    const element: Element = { tagName: "script", nodeName: "script", namespaceURI: head.namespaceURI, attrs, childNodes: [], parentNode: head };
    element.childNodes.push({ nodeName: "#text", value: text, parentNode: element });
    return element;
  };
  // Blocks follow the bridge and precede authored content, so every authored script can read them.
  head.childNodes.unshift(script([{ name: "data-aiqsa-artifact-bridge", value: ARTIFACT_BRIDGE_VERSION }], artifactRuntimeBridge(site)),
    ...(validation ? [] : blocks.map(file => script([{ name: "type", value: "application/octet-stream" }, { name: "data-aiqsa-file", value: file.path }],
      file.base64 ?? bundleFileBytes(file).toString("base64")))));
  // Resource hints (dns-prefetch) resolve host names outside any CSP fetch
  // directive, so a name can carry data. This renderer-owned control asks the
  // browser not to prefetch DNS; it is best-effort defense in depth beside the
  // bridge, not a substitute for a policy directive.
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "http-equiv", value: "x-dns-prefetch-control" }, { name: "content", value: "off" }],
    childNodes: [], parentNode: head });
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: artifactContentSecurityPolicy("meta") }],
    childNodes: [], parentNode: head });
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "charset", value: "utf-8" }], childNodes: [], parentNode: head });
  if (validation) {
    if (Buffer.byteLength(serialize(document)) + blockBytes > ARTIFACT_MAX_RENDER_BYTES) invalid("artifact_bundle_limit_exceeded", from, "Reduce the rendered artifact size.");
    return null;
  }
  const body = Buffer.from(serialize(document), "utf8");
  if (body.byteLength > ARTIFACT_MAX_RENDER_BYTES) invalid("artifact_bundle_limit_exceeded", from, "Reduce the rendered artifact size.");
  return { body, contentType: "text/html; charset=utf-8", fileName: "index.html" };
}
