import { Buffer } from "node:buffer";
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
  mimeType: string;
  path: string;
  text?: string;
}>;

export type ArtifactBundle = Readonly<{
  entrypoint: string | null;
  files: readonly ArtifactBundleFile[];
  kind: ArtifactKind;
  version: 1;
}>;

export type ArtifactBundleAsset = Readonly<{
  bytes: Buffer;
  mimeType: string;
  path: string;
}>;

type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const BLOCKED_ELEMENTS = new Set(["iframe", "frame", "frameset", "object", "embed", "base", "form", "portal"]);
const SVG_ELEMENTS = new Set(["svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "image", "filter", "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix", "feMerge", "feMergeNode"]);
const RESOURCE_ATTRIBUTES = new Set(["src", "href", "poster", "background", "data", "action", "formaction"]);
const RUNTIME_ERROR_BRIDGE = `(() => {
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    try { parent.postMessage({ type: "aiqsa_artifact_runtime_error", code: "runtime_error" }, "*"); } catch {}
  };
  window.addEventListener("error", report, { once: true });
  window.addEventListener("unhandledrejection", report, { once: true });
})();`;

function localPath(value: string, from: string): string | null {
  if (!value || /[\u0000-\u0020\u007f\\:#?%]/u.test(value) || value.startsWith("/")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(from), value));
  return resolved.startsWith("../") ? null : resolved;
}

function imageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/u.test(value);
}

function rejectExternalSource(text: string): void {
  const withoutSvgNamespace = text.replace(/https?:\/\/www\.w3\.org\/2000\/svg/giu, "svg-namespace");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /(?:https?:|javascript:|vbscript:|file:|data:text\/html)/iu.test(withoutSvgNamespace)) {
    throw new Error("artifact_external_reference_invalid");
  }
}

function validateSvgText(text: string): void {
  // Parse character references and attributes before checking them; namespace
  // declarations are metadata, not network requests.
  const document = parse(text);
  let foundSvg = false;
  function visit(node: HtmlNode) {
    if ("tagName" in node) {
      const tag = node.tagName;
      if (["html", "head", "body"].includes(tag)) { /* parser wrappers */ }
      else if (!SVG_ELEMENTS.has(tag)) throw new Error("artifact_svg_invalid");
      if (tag === "svg") foundSvg = true;
      for (const attr of node.attrs) {
        if (/^on/iu.test(attr.name) || attr.name === "style" && /@import|url\(\s*(?!["']?#)/iu.test(attr.value)) throw new Error("artifact_svg_invalid");
        if (["href", "src"].includes(attr.name) && !attr.value.startsWith("#") && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(attr.value)) throw new Error("artifact_svg_invalid");
        if (/url\(/iu.test(attr.value) && !/^url\(["']?#[A-Za-z0-9_-]+["']?\)$/u.test(attr.value)) throw new Error("artifact_svg_invalid");
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(document);
  if (!foundSvg || /<!ENTITY|<!DOCTYPE/iu.test(text)) throw new Error("artifact_svg_invalid");
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
  if (bundle.version !== 1 || !Array.isArray(bundle.files) || bundle.files.length < 1 ||
    bundle.files.length > ARTIFACT_LIMITS.maxFiles || !ARTIFACT_KINDS.includes(bundle.kind as ArtifactKind)) throw new Error("artifact_bundle_invalid");
  if (bundle.entrypoint !== null && typeof bundle.entrypoint !== "string") throw new Error("artifact_bundle_invalid");
  const files = bundle.files.map((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file) || typeof file.path !== "string" ||
      typeof file.mimeType !== "string" || ((file.text !== undefined) === (file.base64 !== undefined)) ||
      (file.text !== undefined && typeof file.text !== "string") || (file.base64 !== undefined && typeof file.base64 !== "string")) {
      throw new Error("artifact_bundle_invalid");
    }
    if (file.base64 !== undefined) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(file.base64) || file.base64.length % 4 === 1) throw new Error("artifact_bundle_invalid");
      let bytes: Buffer;
      try { bytes = Buffer.from(file.base64, "base64"); } catch { throw new Error("artifact_bundle_invalid"); }
      if (bytes.byteLength > ARTIFACT_LIMITS.maxAssetBytes) throw new Error("artifact_bundle_invalid");
    }
    return file as ArtifactBundleFile;
  });
  try {
    normalizeArtifactOperation({
      entrypoint: bundle.entrypoint ?? undefined,
      files: files.map((file) => file.text !== undefined
        ? { mimeType: file.mimeType, path: file.path, text: file.text }
        : { assetRef: "decoded", mimeType: file.mimeType, path: file.path }),
      intent: "create",
      kind: bundle.kind,
      title: "decoded artifact"
    });
  } catch {
    throw new Error("artifact_bundle_invalid");
  }
  return { entrypoint: bundle.entrypoint ?? null, files, kind: bundle.kind as ArtifactKind, version: 1 };
}

export function buildArtifactBundle(
  operation: NormalizedArtifactOperation,
  assets: readonly ArtifactBundleAsset[]
): Readonly<{ bundle: ArtifactBundle; bytes: Buffer; checksum: string }> {
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const files: ArtifactBundleFile[] = operation.files.map((file: NormalizedArtifactFile) => {
    if (file.text !== undefined) {
      rejectExternalSource(file.text);
      if (operation.kind === "svg" || file.mimeType === "image/svg+xml") validateSvgText(file.text);
      return { mimeType: file.mimeType, path: file.path, text: file.text };
    }
    const asset = byPath.get(file.path);
    if (!asset || !file.assetRef) throw new Error("artifact_asset_unavailable");
    if (asset.bytes.byteLength > ARTIFACT_LIMITS.maxAssetBytes) throw new Error("artifact_bundle_limit_exceeded");
    return { base64: asset.bytes.toString("base64"), mimeType: asset.mimeType, path: file.path };
  });
  const bundle: ArtifactBundle = { entrypoint: operation.entrypoint, files, kind: operation.kind, version: 1 };
  const bytes = encodeArtifactBundle(bundle);
  renderArtifactBundle(bundle);
  return { bundle, bytes, checksum: artifactChecksum(bytes) };
}

function bundleFileBytes(file: ArtifactBundleFile): Buffer {
  if (file.text !== undefined) return Buffer.from(file.text, "utf8");
  if (!file.base64) throw new Error("artifact_bundle_file_invalid");
  return Buffer.from(file.base64, "base64");
}

export function renderArtifactBundle(bundle: ArtifactBundle): Readonly<{
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
  function dataUrl(file: ArtifactBundleFile): string {
    if (file.mimeType === "image/svg+xml") validateSvgText(file.text ?? "");
    return `data:${file.mimeType};base64,${bundleFileBytes(file).toString("base64")}`;
  }
  function resolve(value: string, from: string): ArtifactBundleFile {
    const path = localPath(value, from);
    const file = path ? files.get(path) : null;
    if (!file) throw new Error("artifact_external_reference_invalid");
    return file;
  }
  function css(source: string, from: string): string {
    if (/@import|\\|<\/style/iu.test(source)) throw new Error("artifact_external_reference_invalid");
    return source.replace(/url\(\s*(["']?)(.*?)\1\s*\)/giu, (_match, _quote, value: string) => {
      if (value.startsWith("#") || imageDataUrl(value)) return `url("${value}")`;
      const file = resolve(value, from);
      if (!file.mimeType.startsWith("image/")) throw new Error("artifact_external_reference_invalid");
      return `url("${dataUrl(file)}")`;
    });
  }
  const source = bundle.kind === "image"
    ? `<!doctype html><html><head><title>Images</title></head><body style="margin:0;display:grid;gap:1rem">${bundle.files.map((file) => `<img alt="Image" style="max-width:100%;margin:auto" src="${dataUrl(file)}">`).join("")}</body></html>`
    : entry!.mimeType === "image/svg+xml"
      ? (validateSvgText(entry!.text!), `<!doctype html><html><head><title>SVG</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh"><img alt="SVG" style="max-width:100%;max-height:100vh" src="${dataUrl(entry!)}"></body></html>`)
      : entry!.text!;
  const document = parse(source);
  const from = entry?.path ?? "index.html";
  function visit(node: HtmlNode): void {
    if ("tagName" in node) {
      if (BLOCKED_ELEMENTS.has(node.tagName)) throw new Error("artifact_external_reference_invalid");
      if (node.tagName === "meta" && node.attrs.some((attr) => attr.name === "http-equiv")) throw new Error("artifact_external_reference_invalid");
      if (node.tagName === "svg") {
        validateSvgText(serialize({ nodeName: "#document-fragment", childNodes: [node] }));
        return;
      }
      const reference = node.attrs.find((attr) => attr.name === (node.tagName === "script" ? "src" : "href"));
      if ((node.tagName === "script" || node.tagName === "link") && reference) {
        const file = resolve(reference.value, from);
        const script = node.tagName === "script";
        if (!(script ? ["text/javascript", "application/javascript", "application/x-javascript"].includes(file.mimeType) : file.mimeType === "text/css") || file.text === undefined) throw new Error("artifact_mime_invalid");
        node.tagName = script ? "script" : "style";
        node.nodeName = node.tagName;
        node.attrs = [];
        node.childNodes = [{ nodeName: "#text", value: script ? file.text.replace(/<\/script/giu, "<\\/script") : css(file.text, file.path), parentNode: node }];
      }
      for (const attr of node.attrs) {
        if (["srcdoc", "srcset", "ping"].includes(attr.name)) throw new Error("artifact_external_reference_invalid");
        if (attr.name === "style") attr.value = css(attr.value, from);
        if (RESOURCE_ATTRIBUTES.has(attr.name)) {
          if (attr.value.startsWith("#")) continue;
          if (imageDataUrl(attr.value) && attr.name === "src" && node.tagName === "img") continue;
          const file = resolve(attr.value, from);
          if (!file.mimeType.startsWith("image/") || !["img", "image"].includes(node.tagName)) throw new Error("artifact_external_reference_invalid");
          attr.value = dataUrl(file);
        }
      }
      if (node.tagName === "style") {
        for (const child of node.childNodes) if (child.nodeName === "#text" && "value" in child) child.value = css(child.value, from);
      }
      if (node.tagName === "script") {
        for (const child of node.childNodes) if (child.nodeName === "#text" && "value" in child) {
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
    attrs: [], childNodes: [], parentNode: head };
  runtimeBridge.childNodes.push({ nodeName: "#text", value: RUNTIME_ERROR_BRIDGE, parentNode: runtimeBridge });
  head.childNodes.unshift(runtimeBridge);
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "http-equiv", value: "Content-Security-Policy" }, { name: "content", value: artifactContentSecurityPolicy() }],
    childNodes: [], parentNode: head });
  head.childNodes.unshift({ tagName: "meta", nodeName: "meta", namespaceURI: head.namespaceURI,
    attrs: [{ name: "charset", value: "utf-8" }], childNodes: [], parentNode: head });
  return { body: Buffer.from(serialize(document), "utf8"), contentType: "text/html; charset=utf-8", fileName: "index.html" };
}
