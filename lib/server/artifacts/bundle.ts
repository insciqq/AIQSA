import { Buffer } from "node:buffer";
import { ArtifactToolError } from "./errors";
import { ARTIFACT_RUNTIME_BRIDGE } from "./runtimeBridge";
import { parseArtifactLink } from "@/lib/contracts/artifactRuntime";
import { parseArtifactCss, expandArtifactCssImport } from "./css";
import { assertArtifactSingleModule } from "./modulePolicy";
import { artifactResourceText } from "./resourceFetch";
import { ARTIFACT_RESOURCE_LIMITS, artifactResourceByteLimit } from "./resourcePolicy";
import type { ArtifactVendorMetadata } from "./vendoring";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import {
  ARTIFACT_LIMITS,
  artifactContentSecurityPolicy,
  ARTIFACT_KINDS,
  normalizeArtifactOperation,
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
export const ARTIFACT_RENDERER_VERSION = 4;
export const ARTIFACT_MAX_RENDER_BYTES = 64 * 1024 * 1024;

function invalid(code: string, path: string, hint: string): never {
  throw new ArtifactToolError(code, { path, hint });
}

function localPath(value: string, from: string): string | null {
  if (!value || /[\u0000-\u0020\u007f\\:#?%]/u.test(value) || value.startsWith("/")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(from), value));
  return resolved.startsWith("../") ? null : resolved;
}

function imageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/u.test(value);
}

function cssImageDataUrl(value: string, path: string): string | null {
  if (imageDataUrl(value)) return value;
  // Static frameworks commonly percent-encode small SVG icons in CSS. Parse
  // those icons using the same strict SVG boundary, then emit an inert image.
  if (/^data:image\/svg\+xml(?:;charset=utf-8)?,/iu.test(value)) {
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
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    invalid("artifact_text_invalid", path, "Remove control characters from this file.");
  }
}

function validateSvgText(text: string, path = "image.svg"): void {
  // Parse character references and attributes before checking them; namespace
  // declarations are metadata, not network requests.
  const document = parse(text);
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
    bundle.files.length > ARTIFACT_LIMITS.maxFiles + ARTIFACT_RESOURCE_LIMITS.maxResources || !ARTIFACT_KINDS.includes(bundle.kind as ArtifactKind)) throw new Error("artifact_bundle_invalid");
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
    });
  } catch {
    throw new Error("artifact_bundle_invalid");
  }
  return { entrypoint: bundle.entrypoint ?? null, files, kind: bundle.kind as ArtifactKind, version: bundle.version as 1 | 2 };
}

export function buildArtifactBundle(
  operation: NormalizedArtifactOperation,
  assets: readonly ArtifactBundleAsset[],
  vendorFiles: readonly ArtifactBundleFile[] = []
): Readonly<{ bundle: ArtifactBundle; bytes: Buffer; checksum: string }> {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const files: ArtifactBundleFile[] = operation.files.map((file: NormalizedArtifactFile) => {
    if (file.text !== undefined) {
      rejectControlCharacters(file.text, file.path);
      return { mimeType: file.mimeType, path: file.path, text: file.text };
    }
    const asset = byPath.get(file.path);
    if (!asset || !file.assetRef) throw new Error("artifact_asset_unavailable");
    if (asset.bytes.byteLength > ARTIFACT_LIMITS.maxAssetBytes) throw new Error("artifact_bundle_limit_exceeded");
    return { blob: artifactChecksum(asset.bytes), byteSize: asset.bytes.byteLength, mimeType: asset.mimeType, path: file.path };
  });
  if (files.some(file => file.path === "_vendor" || file.path.startsWith("_vendor/")) ||
    new Set([...files, ...vendorFiles].map(file => file.path)).size !== files.length + vendorFiles.length) {
    invalid("artifact_path_duplicate", "_vendor", "The _vendor namespace is read-only; use ordinary authored file paths.");
  }
  files.push(...vendorFiles);
  const bundle: ArtifactBundle = { entrypoint: operation.entrypoint, files, kind: operation.kind, version: 2 };
  const bytes = encodeArtifactBundle(bundle);
  const hydrated = { ...bundle, files: files.map(file => file.blob ? hydrateArtifactBundleFile(file, byPath.get(file.path)!.bytes) : file) };
  renderArtifactBundle(hydrated);
  for (const file of files) if (file.mimeType === "image/svg+xml" && file.path !== bundle.entrypoint) {
    renderArtifactBundle({ ...hydrated, kind: "svg", entrypoint: file.path }, true);
  }
  return { bundle, bytes, checksum: artifactChecksum(bytes) };
}

export function hydrateArtifactBundleFile(file: ArtifactBundleFile, bytes: Buffer): ArtifactBundleFile {
  return file.vendor && ["script", "style"].includes(file.vendor.resourceClass)
    ? { ...file, text: artifactResourceText(bytes, file.path) }
    : { ...file, base64: bytes.toString("base64") };
}

export function bundleFileBytes(file: ArtifactBundleFile): Buffer {
  if (file.text !== undefined) return Buffer.from(file.text, "utf8");
  if (!file.base64) throw new Error("artifact_bundle_file_invalid");
  return Buffer.from(file.base64, "base64");
}

export function renderArtifactBundle(bundle: ArtifactBundle, mainFile = false): Readonly<{
  body: Buffer;
  contentType: string;
  fileName: string;
}> {
  if (bundle.kind === "image" && bundle.files.length === 1) {
    const image = bundle.files[0]!;
    if (!image.base64 || !/^image\/(?:png|jpeg|webp)$/u.test(image.mimeType)) throw new Error("artifact_bundle_image_missing");
    return { body: bundleFileBytes(image), contentType: image.mimeType, fileName: `image.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}` };
  }
  const entry = bundle.files.find((file) => file.path === bundle.entrypoint);
  if (bundle.kind !== "image" && (!entry || entry.text === undefined)) throw new Error("artifact_bundle_entrypoint_missing");
  const files = new Map(bundle.files.map((file) => [file.path, file]));
  let expandedBytes = bundle.files.reduce((sum, file) => sum + (file.text === undefined ? 0 : Buffer.byteLength(file.text)), 0);
  function dataUrl(file: ArtifactBundleFile): string {
    const svgText = file.mimeType === "image/svg+xml" ? svg(file.text ?? "", file.path) : undefined;
    // Bound expansion before allocating repeated base64 substitutions. A tiny
    // authored document can otherwise repeat one large image thousands of times.
    expandedBytes += 32 + (file.base64?.length ?? 4 * Math.ceil(Buffer.byteLength(svgText ?? file.text ?? "") / 3));
    if (expandedBytes > ARTIFACT_MAX_RENDER_BYTES) invalid("artifact_bundle_limit_exceeded", file.path, "Reduce repeated embedded images or use smaller image assets.");
    return `data:${file.mimeType};base64,${file.base64 ?? (svgText === undefined ? bundleFileBytes(file) : Buffer.from(svgText)).toString("base64")}`;
  }
  function countExpansion(text: string, path: string): string {
    expandedBytes += Buffer.byteLength(text);
    if (expandedBytes > ARTIFACT_MAX_RENDER_BYTES) invalid("artifact_bundle_limit_exceeded", path, "Reduce repeated embedded scripts, styles or images.");
    return text;
  }
  function resolve(value: string, from: string, code = "artifact_external_image_unsupported", baseUrl?: string): ArtifactBundleFile {
    const path = baseUrl ? null : localPath(value, from);
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
      const inlineImage = cssImageDataUrl(reference.value, from);
      if (inlineImage) { reference.replace(inlineImage); continue; }
      if (!vendor && !localPath(reference.value, from)) invalid("artifact_external_image_unsupported", from, "Use included images in authored CSS; external url() is supported only inside downloaded stylesheets.");
      const file = resolve(reference.value, from, "artifact_external_image_unsupported", baseUrl);
      if (!file.mimeType.startsWith("image/") && file.vendor?.resourceClass !== "font") invalid("artifact_external_image_unsupported", from, "Use an included image or font for CSS url().");
      reference.replace(dataUrl(file));
    }
    return countExpansion(parsed.text().replace(/<\/style/giu, "<\\/style"), from);
  }
  function svg(source: string, from: string): string {
    const parsed = parse(source);
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
  if (bundle.kind === "svg" && mainFile) {
    return { body: Buffer.from(svg(entry!.text!, entry!.path)), contentType: "image/svg+xml; charset=utf-8", fileName: "image.svg" };
  }
  const source = bundle.kind === "image"
    ? `<!doctype html><html><head><title>Images</title></head><body style="margin:0;display:grid;gap:1rem">${bundle.files.map((file) => `<img alt="Image" style="max-width:100%;margin:auto" src="${dataUrl(file)}">`).join("")}</body></html>`
    : entry!.mimeType === "image/svg+xml"
      ? `<!doctype html><html><head><title>SVG</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh">${svg(entry!.text!, entry!.path)}</body></html>`
      : entry!.text!;
  const document = parse(source);
  const from = entry?.path ?? "index.html";
  function visit(node: HtmlNode): void {
    if ("tagName" in node) {
      let inlinedStyle = false;
      if (BLOCKED_ELEMENTS.has(node.tagName)) invalid("artifact_element_unsupported", from, "Remove the unsupported element and use ordinary HTML, SVG or canvas.");
      if (node.tagName === "meta" && node.attrs.some((attr) => attr.name === "http-equiv")) invalid("artifact_element_unsupported", from, "Remove http-equiv metadata; the server supplies the security policy.");
      if (node.tagName === "svg") {
        // Resolve image hrefs before applying the unchanged strict SVG subset.
        const rendered = parse(svg(serialize({ nodeName: "#document-fragment", childNodes: [node] }), from));
        const findSvg = (candidate: HtmlNode): Element | undefined => "tagName" in candidate && candidate.tagName === "svg" ? candidate
          : "childNodes" in candidate ? candidate.childNodes.map(findSvg).find(Boolean) : undefined;
        const replacement = findSvg(rendered)!;
        node.attrs = replacement.attrs; node.childNodes = replacement.childNodes;
        for (const child of node.childNodes) child.parentNode = node;
        return;
      }
      const type = node.attrs.find(attr => attr.name === "type")?.value.toLowerCase();
      if (node.tagName === "script" && ["importmap", "text/babel", "text/jsx", "text/tsx"].includes(type ?? "")) invalid("artifact_module_graph_unsupported", from, "Use plain JavaScript or a self-contained UMD/IIFE build; browser compilers and import maps are unsupported.");
      const reference = node.attrs.find((attr) => attr.name === (node.tagName === "script" ? "src" : "href"));
      if ((node.tagName === "script" || node.tagName === "link") && reference) {
        const script = node.tagName === "script";
        if (!script && node.attrs.find(attr => attr.name === "rel")?.value.toLowerCase() !== "stylesheet") invalid("artifact_external_style_unsupported", from, "Only static stylesheet links are supported.");
        const file = resolve(reference.value, from, script ? "artifact_external_script_unsupported" : "artifact_external_style_unsupported");
        if (!(script ? ["text/javascript", "application/javascript", "application/x-javascript"].includes(file.mimeType) : file.mimeType === "text/css") || file.text === undefined) invalid("artifact_mime_invalid", from, "Use a text/javascript script or text/css stylesheet file.");
        if (script && type === "module") assertArtifactSingleModule(file.text, file.path);
        const retained = node.attrs.filter(attr => script ? ["type", "id", "nomodule"].includes(attr.name) : ["media", "id", "title"].includes(attr.name));
        node.tagName = script ? "script" : "style";
        node.nodeName = node.tagName;
        node.attrs = retained;
        node.childNodes = [{ nodeName: "#text", value: script ? countExpansion(file.text.replace(/<\/script/giu, "<\\/script"), file.path) : css(file.text, file.path), parentNode: node }];
        inlinedStyle = !script;
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
          if (attr.value.startsWith("#")) continue;
          if (node.tagName === "a" && attr.name === "href") {
            const link = parseArtifactLink(attr.value);
            if (!link) invalid("artifact_external_link_unsupported", from, "Use an http, https or mailto link no longer than 2048 characters.");
            attr.value = link; continue;
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
          if (type === "module") assertArtifactSingleModule(child.value, from);
          child.value = child.value.replace(/(["'])([^"'\n]+)\1/gu, (match, quote: string, value: string) => {
            const path = localPath(value, from);
            const file = path ? files.get(path) : null;
            return file?.mimeType.startsWith("image/") ? `${quote}${dataUrl(file)}${quote}` : match;
          });
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  }
  visit(document);
  const htmlNode = document.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "html")!;
  const head = htmlNode.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "head")!;
  const runtimeBridge: Element = { tagName: "script", nodeName: "script", namespaceURI: head.namespaceURI,
    attrs: [{ name: "data-aiqsa-artifact-bridge", value: "3" }], childNodes: [], parentNode: head };
  runtimeBridge.childNodes.push({ nodeName: "#text", value: ARTIFACT_RUNTIME_BRIDGE, parentNode: runtimeBridge });
  head.childNodes.unshift(runtimeBridge);
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: artifactContentSecurityPolicy("meta") }],
    childNodes: [], parentNode: head });
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "charset", value: "utf-8" }], childNodes: [], parentNode: head });
  const body = Buffer.from(serialize(document), "utf8");
  if (body.byteLength > ARTIFACT_MAX_RENDER_BYTES) invalid("artifact_bundle_limit_exceeded", from, "Reduce the rendered artifact size.");
  return { body, contentType: "text/html; charset=utf-8", fileName: "index.html" };
}
