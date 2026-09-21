import { createHash, timingSafeEqual } from "node:crypto";
import { mcpSafeFetch, networkAddressScope, type McpSafeFetchOptions } from "../mcp/safeFetch";
import { validateGeneratedImage } from "../providers/imageGeneration";
import { ArtifactToolError } from "./errors";
import { ARTIFACT_RESOURCE_LIMITS, artifactResourceByteLimit, artifactResourceDenied, artifactResourceUrlSpelling,
  getArtifactResourcePolicy, validateArtifactResourceUrl, type ArtifactResourceClass, type ArtifactResourcePolicy } from "./resourcePolicy";

const MIME: Record<ArtifactResourceClass, readonly string[]> = {
  script: ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript"],
  style: ["text/css"],
  font: ["font/woff", "font/woff2", "font/ttf", "font/otf", "application/font-woff", "application/x-font-ttf", "application/x-font-opentype"],
  image: ["image/png", "image/jpeg", "image/webp"]
};
export type ArtifactResourceRequest = Readonly<{
  url: string; kind: ArtifactResourceClass; path?: string; googleFontCss?: boolean; signal?: AbortSignal;
}>;
export type ArtifactDownloadedResource = Readonly<{ bytes: Buffer; mimeType: string; resolvedUrl: string }>;
export type ArtifactResourceFetcher = (input: ArtifactResourceRequest) => Promise<ArtifactDownloadedResource>;

const error = (code: string, path?: string): ArtifactToolError => new ArtifactToolError(code, { path, hint:
  code === "artifact_resource_too_large" ? "Use a smaller static resource or include the required code locally."
    : code === "artifact_resource_type_mismatch" ? "Use a direct static file with the matching Content-Type; raster images must be valid PNG, JPEG or WebP."
      : "The static resource could not be downloaded. Use an included file or another exact versioned URL from an allowed host." });

export function artifactResourceText(bytes: Uint8Array, path?: string): string {
  // Preserve a UTF-8 BOM as text so a later copy recreates the exact pinned bytes.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw error("artifact_resource_type_mismatch", path); }
}

export function verifyArtifactIntegrity(bytes: Uint8Array, integrity: string | undefined, path?: string): void {
  if (integrity === undefined) return;
  const entries = integrity.trim().split(/\s+/u).map(part => /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(part)).filter(item => item !== null);
  const strength = ["sha512", "sha384", "sha256"].find(algorithm => entries.some(entry => entry[1] === algorithm));
  if (strength) {
    const digest = createHash(strength).update(bytes).digest();
    if (entries.some(entry => {
      const supplied = Buffer.from(entry[2]!, "base64");
      return entry[1] === strength && supplied.length === digest.length && timingSafeEqual(supplied, digest);
    })) return;
  }
  throw new ArtifactToolError("artifact_resource_integrity_mismatch", { path,
    hint: "The integrity attribute does not match the downloaded bytes. Remove an invented integrity attribute or provide the exact hash." });
}

/** The injectable boundary remains the pinned transport; tests never bypass URL/DNS policy. */
export function createArtifactResourceFetcher(options: Pick<McpSafeFetchOptions, "dispatch" | "lookupHostname"> & {
  policy?: () => ArtifactResourcePolicy;
} = {}): ArtifactResourceFetcher {
  const policy = options.policy ?? getArtifactResourcePolicy;
  return async input => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARTIFACT_RESOURCE_LIMITS.resourceTimeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let response: Response | undefined;
    let deniedAfterDns: ArtifactToolError | undefined;
    try {
      let url = input.url;
      for (let redirects = 0; ; redirects++) {
        if (signal.aborted) throw error("artifact_resource_unreachable", input.path);
        const checked = validateArtifactResourceUrl(url, input.kind, { ...input, policy: policy() });
        response = await mcpSafeFetch(checked, { method: "GET", redirect: "manual", signal,
          headers: { accept: MIME[input.kind].join(", "), "accept-encoding": "identity" } }, {
          dispatch: options.dispatch, lookupHostname: options.lookupHostname, maxRedirects: 0,
          addressAllowed(address, requestUrl) {
            // DNS is asynchronous: recheck policy after resolving, immediately
            // before dispatch, so disabling a host during lookup fails closed.
            try { validateArtifactResourceUrl(requestUrl.href, input.kind, { ...input, policy: policy() }); }
            catch (failure) { if (failure instanceof ArtifactToolError) deniedAfterDns = failure; return false; }
            return networkAddressScope(address.address) === "public";
          }
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (redirects >= ARTIFACT_RESOURCE_LIMITS.maxRedirects || !location) throw error("artifact_resource_unreachable", input.path);
        if (!artifactResourceUrlSpelling(location)) artifactResourceDenied(policy(), input.path);
        try { url = new URL(location, checked).href; } catch { throw error("artifact_resource_unreachable", input.path); }
      }
      if (!response.ok || !response.body) throw error("artifact_resource_unreachable", input.path);
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!MIME[input.kind].includes(mimeType) || ![null, "identity"].includes(response.headers.get("content-encoding"))) throw error("artifact_resource_type_mismatch", input.path);
      const maxBytes = artifactResourceByteLimit(input.kind);
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw error("artifact_resource_too_large", input.path);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          const next = await reader.read();
          if (signal.aborted) throw error("artifact_resource_unreachable", input.path);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) { await reader.cancel(); throw error("artifact_resource_too_large", input.path); }
          chunks.push(next.value);
        }
      } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
      if (!size || declared !== null && Number(declared) !== size) throw error("artifact_resource_unreachable", input.path);
      const bytes = Buffer.concat(chunks, size);
      if (input.kind === "image") {
        try { await validateGeneratedImage(bytes, mimeType); }
        catch { throw error("artifact_resource_type_mismatch", input.path); }
      } else if (input.kind === "script" || input.kind === "style") artifactResourceText(bytes, input.path);
      else {
        const magic = bytes.subarray(0, 4).toString("latin1");
        const expected = mimeType.includes("woff2") ? ["wOF2"] : mimeType.includes("woff") ? ["wOFF"]
          : mimeType.includes("ttf") ? ["\u0000\u0001\u0000\u0000", "true"] : ["OTTO"];
        if (!expected.includes(magic)) throw error("artifact_resource_type_mismatch", input.path);
      }
      return { bytes, mimeType: input.kind === "script" ? "text/javascript" : mimeType, resolvedUrl: url };
    } catch (failure) {
      await response?.body?.cancel().catch(() => undefined);
      if (deniedAfterDns) throw deniedAfterDns;
      if (failure instanceof ArtifactToolError) throw failure;
      throw error("artifact_resource_unreachable", input.path);
    } finally { clearTimeout(timeout); }
  };
}
