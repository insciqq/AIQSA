import { ArtifactToolError } from "./errors";

export const ARTIFACT_RESOURCE_LIMITS = Object.freeze({
  maxResources: 16,
  maxBytes: 16 * 1024 * 1024,
  scriptBytes: 3 * 1024 * 1024,
  styleBytes: 3 * 1024 * 1024,
  fontBytes: 1024 * 1024,
  imageBytes: 8 * 1024 * 1024,
  maxRedirects: 3,
  resourceTimeoutMs: 10_000,
  operationTimeoutMs: 25_000,
  concurrency: 4,
  cssDepth: 2,
  maxUrlCharacters: 256
});

export type ArtifactResourceClass = "script" | "style" | "font" | "image";
export type ArtifactResourcePolicy = Readonly<{
  on: boolean;
  libraryHosts: readonly string[];
  imageHosts: readonly string[];
}>;
const DEFAULT_LIBRARY_HOSTS = ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

export function validArtifactResourcePolicy(value: unknown): value is ArtifactResourcePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return Object.keys(policy).length === 3 && typeof policy.on === "boolean" &&
    [policy.libraryHosts, policy.imageHosts].every(list => Array.isArray(list) && list.length <= 16 &&
      list.every(host => typeof host === "string" && hosts(host, []).length === 1 && hosts(host, [])[0] === host));
}

/** Admission is a ceiling; live installation policy can only narrow it. */
export function effectiveArtifactResourcePolicy(accepted: ArtifactResourcePolicy | undefined, current: ArtifactResourcePolicy): ArtifactResourcePolicy {
  return accepted ? { on: accepted.on && current.on,
    libraryHosts: accepted.libraryHosts.filter(host => current.libraryHosts.includes(host)),
    imageHosts: accepted.imageHosts.filter(host => current.imageHosts.includes(host)) } : current;
}

function hosts(value: string | undefined, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return [...fallback];
  if (!value.trim()) return [];
  const entries = value.split(",").map(host => host.trim().toLowerCase());
  if (value.length > 4096 || entries.length > 16 || entries.some(host =>
    host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(host))) return [];
  return [...new Set(entries)];
}

/** Read at each dispatch. An admitted tool description is not egress authority. */
export function getArtifactResourcePolicy(): ArtifactResourcePolicy {
  return {
    on: process.env.AIQSA_ARTIFACT_EXTERNAL_RESOURCES === undefined || process.env.AIQSA_ARTIFACT_EXTERNAL_RESOURCES === "on",
    libraryHosts: hosts(process.env.AIQSA_ARTIFACT_LIBRARY_HOSTS, DEFAULT_LIBRARY_HOSTS),
    imageHosts: hosts(process.env.AIQSA_ARTIFACT_IMAGE_HOSTS, [])
  };
}

export function artifactResourceDenied(policy: ArtifactResourcePolicy, path?: string): never {
  throw new ArtifactToolError("artifact_resource_host_not_allowed", { path, hint: policy.on
    ? `Use an exact versioned HTTPS resource from the current library hosts (${policy.libraryHosts.join(", ") || "none"}) or image hosts (${policy.imageHosts.join(", ") || "none"}); otherwise include a local file. Browser compilers are unsupported.`
    : "External downloads are disabled. Use inline or included files and conversation images; existing saved resources can be reused." });
}

const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const safePath = (path: string) => /^\/[A-Za-z0-9._@+/-]+$/u.test(path) &&
  path.slice(1).split("/").every(part => part !== "" && part !== "." && part !== "..");

/** Check the spelling before URL normalization erases dot segments. */
export function artifactResourceUrlSpelling(value: string): boolean {
  if (!value || value.length > ARTIFACT_RESOURCE_LIMITS.maxUrlCharacters || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  const withoutOrigin = value.replace(/^https:\/\/[^/?#]+/iu, "");
  const path = withoutOrigin.split(/[?#]/u)[0]!;
  return !path.includes("%") && !path.split("/").some(part => part === "." || part === "..") && !path.includes("//");
}

export function validateArtifactResourceUrl(value: string, kind: ArtifactResourceClass, options: {
  policy?: ArtifactResourcePolicy; googleFontCss?: boolean; path?: string;
} = {}): URL {
  const policy = options.policy ?? getArtifactResourcePolicy();
  const deny = (): never => artifactResourceDenied(policy, options.path);
  if (!policy.on || !artifactResourceUrlSpelling(value)) deny();
  let url: URL;
  try { url = new URL(value); } catch { return deny(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.href.length > ARTIFACT_RESOURCE_LIMITS.maxUrlCharacters || !safePath(url.pathname)) deny();
  const host = url.hostname;
  if (!(kind === "image" ? policy.imageHosts : policy.libraryHosts).includes(host)) deny();
  // A broader operator allowlist never enables a browser compilation runtime.
  if (host === "cdn.tailwindcss.com" || /(?:^|\/)(?:@tailwindcss\/browser(?:@|\/)|(?:babel-standalone|@babel\/standalone)(?:@|\/)|tailwindcss-browser(?:\/|@))/iu.test(url.pathname)) deny();
  if (kind === "image") {
    if (url.search.slice(1).length > 128 || host === "fonts.gstatic.com" || host === "fonts.googleapis.com") deny();
    return url;
  }
  if (host === "fonts.googleapis.com") {
    if (kind !== "style" || !["/css", "/css2"].includes(url.pathname) || url.search.slice(1).length > 256) deny();
    let families = 0, displays = 0;
    for (const [key, entry] of url.searchParams) {
      if (!entry || !/^[A-Za-z0-9 +:;,@.]+$/u.test(entry)) deny();
      if (key === "family") families++;
      else if (key === "display") displays++;
      else deny();
    }
    if (!families || displays > 1) deny();
    return url;
  }
  if (url.search) deny();
  if (host === "fonts.gstatic.com") {
    if (kind !== "font" || !options.googleFontCss || !policy.libraryHosts.includes("fonts.googleapis.com")) deny();
    return url;
  }
  const parts = url.pathname.slice(1).split("/");
  if (host === "cdnjs.cloudflare.com") {
    if (parts.length < 5 || parts[0] !== "ajax" || parts[1] !== "libs" || !exactVersion.test(parts[3]!)) deny();
    if (["babel-standalone", "tailwindcss-browser"].includes(parts[2]!.toLowerCase())) deny();
  } else if (host === "cdn.jsdelivr.net" || host === "unpkg.com") {
    const npm = host === "cdn.jsdelivr.net" ? parts.slice(1) : parts;
    if (host === "cdn.jsdelivr.net" && parts[0] !== "npm") deny();
    const packageIndex = npm[0]?.startsWith("@") ? 1 : 0;
    const named = npm[packageIndex] ?? "";
    const separator = named.lastIndexOf("@");
    if (separator < 1 || npm.length <= packageIndex + 1 || !exactVersion.test(named.slice(separator + 1)) ||
      !/^[A-Za-z0-9._-]+$/u.test(named.slice(0, separator)) ||
      packageIndex === 1 && !/^@[A-Za-z0-9._-]+$/u.test(npm[0]!)) deny();
  }
  return url;
}

export const artifactResourceByteLimit = (kind: ArtifactResourceClass): number => ARTIFACT_RESOURCE_LIMITS[`${kind}Bytes`];
