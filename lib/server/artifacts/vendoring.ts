import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { NormalizedArtifactOperation } from "@/lib/contracts/artifacts";
import type { ArtifactBundle, ArtifactBundleAsset, ArtifactBundleFile } from "./bundle";
import { parseArtifactCss } from "./css";
import { ArtifactToolError } from "./errors";
import { assertArtifactSingleModule } from "./modulePolicy";
import { artifactResourceText, createArtifactResourceFetcher, verifyArtifactIntegrity, type ArtifactResourceFetcher } from "./resourceFetch";
import { ARTIFACT_RESOURCE_LIMITS, artifactResourceByteLimit, artifactResourceUrlSpelling, type ArtifactResourceClass, type ArtifactResourcePolicy } from "./resourcePolicy";

export type ArtifactVendorMetadata = Readonly<{
  sourceUrl: string;
  resolvedUrl?: string;
  sha256: string;
  byteSize: number;
  resourceClass: ArtifactResourceClass;
}>;
type ResourceRef = { url: string; kind: ArtifactResourceClass; path: string; integrity?: string; module?: boolean; googleFontCss?: boolean };
const tooLarge = (path: string): never => { throw new ArtifactToolError("artifact_resource_too_large", { path,
  hint: "Use at most 16 external resources, 16 MiB total, and CSS imports no more than two levels deep." }); };

function canonicalUrl(value: string): string {
  try { return new URL(value).href; } catch { return value; }
}

function collectReferences(operation: NormalizedArtifactOperation): ResourceRef[] {
  const references: ResourceRef[] = [];
  for (const file of operation.files) {
    if (file.text === undefined || !["text/html", "image/svg+xml"].includes(file.mimeType)) continue;
    function visit(node: DefaultTreeAdapterMap["node"]): void {
      if ("tagName" in node) {
        const attr = (name: string) => node.attrs.find(item => item.name === name)?.value;
        const kind = node.tagName === "script" ? "script" : node.tagName === "link" && attr("rel")?.toLowerCase() === "stylesheet" ? "style"
          : ["img", "image"].includes(node.tagName) ? "image" : null;
        const url = kind ? attr(node.tagName === "link" || node.tagName === "image" ? "href" : "src") : undefined;
        if (url && /^https:\/\//iu.test(url) && kind) references.push({ url: canonicalUrl(url), kind, path: file.path,
          ...(attr("integrity") !== undefined ? { integrity: attr("integrity") } : {}), module: attr("type")?.toLowerCase() === "module" });
        // Check spelling before canonicalization can erase traversal.
        if (url && /^https:\/\//iu.test(url) && !artifactResourceUrlSpelling(url)) {
          throw new ArtifactToolError("artifact_resource_host_not_allowed", { path: file.path, hint: "Use a direct exact versioned HTTPS URL without traversal, userinfo or fragments." });
        }
        if (node.tagName === "script" && attr("type")?.toLowerCase() === "module" && !url) {
          assertArtifactSingleModule(node.childNodes.map(child => "value" in child ? child.value : "").join(""), file.path);
        }
      }
      if ("childNodes" in node) node.childNodes.forEach(visit);
      if ("content" in node) visit(node.content);
    }
    visit(parse(file.text));
  }
  return references;
}

export async function vendorArtifactResources(operation: NormalizedArtifactOperation, options: {
  base?: ArtifactBundle;
  fetchResource?: ArtifactResourceFetcher;
  acceptedPolicy?: ArtifactResourcePolicy;
  signal?: AbortSignal;
} = {}): Promise<{ files: ArtifactBundleFile[]; assets: ArtifactBundleAsset[] }> {
  const references = collectReferences(operation);
  if (!references.length) return { files: [], assets: [] };
  const fetchResource = options.fetchResource ?? createArtifactResourceFetcher();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), ARTIFACT_RESOURCE_LIMITS.operationTimeoutMs);
  const reusable = new Map(options.base?.files.filter(file => file.vendor).map(file => [file.vendor!.sourceUrl, file]) ?? []);
  const pending = new Map<string, Promise<ArtifactBundleFile>>();
  const imports = new Map<string, Set<string>>();
  const kinds = new Map<string, ArtifactResourceClass>();
  const resources = new Map<string, { file: ArtifactBundleFile; asset: ArtifactBundleAsset }>();
  let totalBytes = 0, active = 0;
  const waiters: Array<() => void> = [];
  async function download(reference: ResourceRef) {
    if (active >= ARTIFACT_RESOURCE_LIMITS.concurrency) await new Promise<void>(resolve => waiters.push(resolve));
    else active++;
    try {
      if (signal.aborted) throw new ArtifactToolError("artifact_resource_unreachable", { path: reference.path, hint: "The resource download was cancelled or timed out." });
      return await fetchResource({ ...reference, signal, acceptedPolicy: options.acceptedPolicy });
    } finally { const next = waiters.shift(); if (next) next(); else active--; }
  }
  async function load(reference: ResourceRef, depth = 0, parents: readonly string[] = []): Promise<ArtifactBundleFile> {
    const url = reference.url;
    if (parents.includes(url) || reference.kind === "style" && depth > ARTIFACT_RESOURCE_LIMITS.cssDepth) tooLarge(reference.path);
    const parent = parents.at(-1);
    if (parent && reference.kind === "style") {
      const dependencies = imports.get(parent) ?? new Set<string>();
      dependencies.add(url); imports.set(parent, dependencies);
      const visited = new Set<string>();
      const todo = [url];
      while (todo.length) {
        const next = todo.pop()!;
        if (next === parent) tooLarge(reference.path);
        if (visited.has(next)) continue;
        visited.add(next); todo.push(...imports.get(next) ?? []);
      }
    }
    const previousKind = kinds.get(url);
    if (previousKind && previousKind !== reference.kind) throw new ArtifactToolError("artifact_resource_type_mismatch", { path: reference.path, hint: "Use each external URL for one resource class." });
    let job = pending.get(url);
    if (!job) {
      if (pending.size >= ARTIFACT_RESOURCE_LIMITS.maxResources) tooLarge(reference.path);
      kinds.set(url, reference.kind);
      job = Promise.resolve().then(async () => {
        const reused = reusable.get(url);
        if (reused && reused.vendor!.resourceClass !== reference.kind) throw new ArtifactToolError("artifact_resource_type_mismatch", { path: reference.path, hint: "The saved resource has a different type." });
        const fetched = reused ? { bytes: reused.text !== undefined ? Buffer.from(reused.text) : Buffer.from(reused.base64 ?? "", "base64"),
          mimeType: reused.mimeType, resolvedUrl: reused.vendor!.resolvedUrl ?? url } : await download(reference);
        const { bytes, mimeType, resolvedUrl } = fetched;
        if (!bytes.length || bytes.length > artifactResourceByteLimit(reference.kind)) tooLarge(reference.path);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (reused && (reused.vendor!.sha256 !== sha256 || reused.vendor!.byteSize !== bytes.length)) throw new Error("artifact_blob_unavailable");
        const originalName = posix.basename(new URL(url).pathname);
        const basename = originalName.replace(/[^A-Za-z0-9._-]/gu, "_").slice(-100) || `resource.${reference.kind}`;
        const path = `_vendor/${sha256.slice(0, 12)}/${basename}`;
        const collision = resources.get(path);
        // Identical CSS bytes at different bases may resolve relative URLs
        // differently; never silently attach either meaning to one ZIP path.
        if (collision && collision.file.vendor!.sourceUrl !== url) throw new ArtifactToolError("artifact_resource_type_mismatch", { path: reference.path,
          hint: "Reference each identical resource through one canonical URL." });
        totalBytes += bytes.length;
        if (totalBytes > ARTIFACT_RESOURCE_LIMITS.maxBytes) tooLarge(reference.path);
        const file: ArtifactBundleFile = { path, mimeType, blob: sha256, byteSize: bytes.length, vendor: {
          sourceUrl: url, ...(resolvedUrl !== url ? { resolvedUrl } : {}), sha256, byteSize: bytes.length, resourceClass: reference.kind
        } };
        resources.set(path, { file, asset: { path, mimeType, bytes } });
        if (reference.kind === "style") {
          const css = parseArtifactCss(artifactResourceText(bytes, reference.path), reference.path);
          await Promise.all(css.references.map(async item => {
            if (item.value.startsWith("#") || item.value.startsWith("data:")) return;
            if (!artifactResourceUrlSpelling(item.value)) throw new ArtifactToolError("artifact_resource_host_not_allowed", { path: reference.path, hint: "Use direct allowed CSS resource URLs without traversal." });
            let child: URL;
            try { child = new URL(item.value, resolvedUrl); } catch { throw new ArtifactToolError("artifact_resource_host_not_allowed", {
              path: reference.path, hint: "Use an allowed absolute resource URL or a valid relative CSS resource URL."
            }); }
            const kind = item.kind === "import" ? "style" : /\.(?:woff2?|ttf|otf)$/iu.test(child.pathname) ? "font" : "image";
            await load({ url: child.href, kind, path: reference.path, googleFontCss: new URL(resolvedUrl).hostname === "fonts.googleapis.com" }, depth + (kind === "style" ? 1 : 0), [...parents, url]);
          }));
        }
        return file;
      });
      pending.set(url, job);
    }
    const file = await job;
    const bytes = resources.get(file.path)!.asset.bytes;
    verifyArtifactIntegrity(bytes, reference.integrity, reference.path);
    if (reference.module) assertArtifactSingleModule(artifactResourceText(bytes, reference.path), reference.path);
    return file;
  }
  try {
    await Promise.all(references.map(reference => load(reference)));
    if (signal.aborted) throw new ArtifactToolError("artifact_resource_unreachable", { hint: "The resource download was cancelled or timed out." });
    function checkDepth(url: string, depth: number): void {
      if (depth > ARTIFACT_RESOURCE_LIMITS.cssDepth) tooLarge(operation.entrypoint ?? "index.html");
      for (const child of imports.get(url) ?? []) checkDepth(child, depth + 1);
    }
    for (const reference of references) if (reference.kind === "style") checkDepth(reference.url, 0);
    // Sort metadata for stable snapshots regardless of network completion order.
    const ordered = [...resources.values()].sort((left, right) => left.file.path.localeCompare(right.file.path));
    return { files: ordered.map(item => item.file), assets: ordered.map(item => item.asset) };
  } finally { clearTimeout(timeout); controller.abort(); }
}
