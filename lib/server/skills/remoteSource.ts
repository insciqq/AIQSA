import { createHash } from "node:crypto";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_FILE_MAX_BYTES } from "../../contracts/skills";
import { SKILL_SOURCE_URL_MAX_LENGTH, type SkillRemoteSource } from "../../contracts/skillSources";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { createMcpSafeFetch, McpSafeFetchError } from "../mcp/safeFetch";
import { parseSkillImport, type SkillImportCandidate } from "./bundle";
import { SkillBundleError } from "./bundleErrors";
import { readSkillZip, type SkillImportFile } from "./zipReader";

const SOURCE_TIMEOUT_MS = 30_000;
const API_MAX_BYTES = 1_048_576;
const MAX_REF_PARTS = 8;

export type RemoteSkillSnapshot = {
  source: SkillRemoteSource;
  fingerprint: string;
  /** Directory relative to the repository/archive, or '.' for a root Skill. */
  candidates: Array<{ path: string; candidate: SkillImportCandidate }>;
  ignoredFiles: number;
};

export type SkillRemoteSourceErrorCode =
  | "skill_source_url_invalid"
  | "skill_source_unsupported"
  | "skill_source_unavailable"
  | "skill_source_rate_limited"
  | "skill_source_forbidden"
  | "skill_source_timeout"
  | "skill_source_cancelled"
  | "skill_source_too_large"
  | "skill_source_invalid";

export class SkillRemoteSourceError extends Error {
  constructor(readonly code: SkillRemoteSourceErrorCode) {
    super(code);
    this.name = "SkillRemoteSourceError";
  }
}

type SourceLocation = {
  url: URL;
  kind: RemoteSkillSnapshot["source"]["kind"];
  repository?: string;
  view?: "tree" | "blob";
  tail?: string[];
};

function fail(code: SkillRemoteSourceErrorCode): never { throw new SkillRemoteSourceError(code); }

function parseLocation(input: string): SourceLocation {
  if (typeof input !== "string" || input.length > SKILL_SOURCE_URL_MAX_LENGTH || /[\u0000-\u0020\u007f\\]/u.test(input)) {
    fail("skill_source_url_invalid");
  }
  let url: URL;
  try { url = new URL(input); } catch { fail("skill_source_url_invalid"); }
  if (url.hostname === "gitlab.com" && url.pathname.includes("/-/") && ["?ref_type=heads", "?ref_type=tags"].includes(url.search)) url.search = "";
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.href.includes("#")) {
    fail("skill_source_url_invalid");
  }
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { fail("skill_source_url_invalid"); }
  if (parts.some((part) => /[\u0000-\u001f\u007f\\]/u.test(part) || part === "." || part === "..")) fail("skill_source_url_invalid");
  if (parts.at(-1)?.toLowerCase().endsWith(".zip")) return { url, kind: "zip" };
  if (url.hostname === "www.github.com") url.hostname = "github.com";
  if (url.hostname === "github.com") {
    if (parts.length < 2 || parts.slice(0, 2).some((part) => !/^[a-zA-Z0-9_.-]+$/u.test(part))) fail("skill_source_unsupported");
    const repository = `${parts[0]}/${parts[1]!.replace(/\.git$/u, "")}`;
    if (parts.length === 2) return { url: new URL(`https://github.com/${repository}`), kind: "github", repository };
    if ((parts[2] !== "tree" && parts[2] !== "blob") || parts.length < 4) fail("skill_source_unsupported");
    if (parts[2] === "blob" && parts.at(-1) !== "SKILL.md") fail("skill_source_unsupported");
    return { url, kind: "github", repository, view: parts[2], tail: parts.slice(3) };
  }
  if (url.hostname === "gitlab.com") {
    const marker = parts.indexOf("-");
    const repositoryParts = marker < 0 ? parts : parts.slice(0, marker);
    if (repositoryParts.length < 2 || repositoryParts.some((part) => !/^[a-zA-Z0-9_.-]+$/u.test(part))) fail("skill_source_unsupported");
    const repository = repositoryParts.join("/").replace(/\.git$/u, "");
    if (marker < 0) return { url: new URL(`https://gitlab.com/${repository}`), kind: "gitlab", repository };
    const view = parts[marker + 1];
    if ((view !== "tree" && view !== "blob") || parts.length < marker + 3) fail("skill_source_unsupported");
    if (view === "blob" && parts.at(-1) !== "SKILL.md") fail("skill_source_unsupported");
    return { url, kind: "gitlab", repository, view, tail: parts.slice(marker + 2) };
  }
  if (parts.at(-1) === "SKILL.md") return { url, kind: "markdown" };
  fail("skill_source_unsupported");
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Git hosting archives add a commit-dependent wrapper; it is never a Skill identity. */
function repositoryFiles(files: SkillImportFile[]): SkillImportFile[] {
  const wrapper = files[0]?.path.split("/")[0];
  if (!wrapper || files.some((file) => !file.path.startsWith(`${wrapper}/`))) fail("skill_source_invalid");
  return files.map((file) => ({ ...file, path: file.path.slice(wrapper.length + 1) }));
}

function discover(files: SkillImportFile[]): Pick<RemoteSkillSnapshot, "candidates" | "ignoredFiles"> {
  const parsed = parseSkillImport(files);
  const roots: string[] = [];
  const paths = [...new Set(files.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => file.path.slice(0, -"SKILL.md".length)))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const path of paths) if (!roots.some((root) => path.startsWith(root))) roots.push(path);
  return { candidates: parsed.candidates.map((candidate, index) => ({ path: roots[index]!.slice(0, -1) || ".", candidate })), ignoredFiles: parsed.ignoredFiles };
}

function readRepositorySkills(archive: Buffer, scope: string): { files: SkillImportFile[]; ignoredFiles: number } {
  let ignoredFiles = 0;
  const files = readSkillZip(archive, { selectPaths(paths) {
    const wrapper = paths[0]?.split("/")[0];
    if (!wrapper || paths.some((path) => !path.startsWith(`${wrapper}/`))) fail("skill_source_invalid");
    const scoped = paths.filter((path) => !scope || path.startsWith(`${wrapper}/${scope}/`));
    const roots = scoped.filter((path) => path.endsWith("/SKILL.md")).map((path) => path.slice(0, -"SKILL.md".length));
    const selected = scoped.filter((path) => roots.some((root) => path.startsWith(root)));
    ignoredFiles = scoped.length - selected.length;
    return new Set(selected);
  } });
  return { files: files.length ? repositoryFiles(files) : [], ignoredFiles };
}

/** All I/O uses a credential-free DNS-pinned transport, including every redirect. */
export function createRemoteSkillSourceFetcher(deps: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const safeFetch = deps.fetch ?? createMcpSafeFetch();
  return async function fetchSource(input: string, options: { signal?: AbortSignal } = {}): Promise<RemoteSkillSnapshot> {
    const location = parseLocation(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SOURCE_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

    async function read(url: string | URL, maxBytes: number, accept = "application/octet-stream", allowMissing = false): Promise<Buffer | null> {
      signal.throwIfAborted();
      const response = await safeFetch(url, { signal, method: "GET", redirect: "follow", credentials: "omit", cache: "no-store",
        headers: { accept, "accept-encoding": "identity", "user-agent": "AIQSA-Skill-Import" } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (allowMissing && (response.status === 404 || response.status === 422)) return null;
        if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) fail("skill_source_rate_limited");
        fail("skill_source_unavailable");
      }
      if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") {
        await response.body?.cancel().catch(() => undefined);
        fail("skill_source_invalid");
      }
      const request = new Request("https://skill-import.invalid/", { method: "POST", headers: response.headers, body: response.body,
        signal, ...(response.body ? { duplex: "half" } : {}) });
      return Buffer.from(await readBoundedRequestBody(request, { maxBytes, signal }));
    }

    async function resolveCommit(ref: string): Promise<string | null> {
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(ref)) return ref;
      const github = location.kind === "github";
      const endpoint = github ? `https://api.github.com/repos/${location.repository}/commits/${encodeURIComponent(ref)}`
        : `https://gitlab.com/api/v4/projects/${encodeURIComponent(location.repository!)}/repository/commits/${encodeURIComponent(ref)}?stats=false`;
      const bytes = await read(endpoint, API_MAX_BYTES, github ? "application/vnd.github.sha" : "application/json", true);
      if (!bytes) return null;
      let sha: unknown;
      try { sha = github ? bytes.toString("utf8").trim() : (JSON.parse(bytes.toString("utf8")) as { id?: unknown }).id; }
      catch { fail("skill_source_invalid"); }
      if (typeof sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) fail("skill_source_invalid");
      return sha;
    }

    try {
      if (location.kind === "markdown" || location.kind === "zip") {
        const bytes = (await read(location.url, location.kind === "markdown" ? SKILL_FILE_MAX_BYTES : SKILL_ARCHIVE_MAX_BYTES))!;
        const revision = sha256(bytes);
        const files = location.kind === "markdown" ? [{ path: "SKILL.md", bytes }] : readSkillZip(bytes);
        return { source: { kind: location.kind, url: location.url.href, revision }, fingerprint: revision, ...discover(files) };
      }

      let revision: string | null = null;
      let scope = "";
      if (!location.tail) revision = await resolveCommit("HEAD");
      else {
        // Ordinary branch links take one lookup. A slash-bearing ref is tried
        // progressively when its prefix is not itself a ref; encoded slashes
        // make an otherwise ambiguous branch/tag selection explicit.
        const maximum = Math.min(MAX_REF_PARTS, location.tail.length - (location.view === "blob" ? 1 : 0));
        for (let count = 1; count <= maximum; count += 1) {
          revision = await resolveCommit(location.tail.slice(0, count).join("/"));
          if (revision) {
            scope = location.tail.slice(count, location.view === "blob" ? -1 : undefined).join("/");
            break;
          }
        }
      }
      if (!revision) fail("skill_source_unavailable");
      const archiveUrl = location.kind === "github"
        ? `https://github.com/${location.repository}/archive/${revision}.zip`
        : `https://gitlab.com/api/v4/projects/${encodeURIComponent(location.repository!)}/repository/archive.zip?sha=${revision}&include_lfs_blobs=false${scope ? `&path=${encodeURIComponent(scope)}` : ""}`;
      const archive = (await read(archiveUrl, SKILL_ARCHIVE_MAX_BYTES, "application/vnd.github+json"))!;
      const selected = readRepositorySkills(archive, scope);
      const files = selected.files;
      const discovered = discover(files);
      if (location.view === "blob" && !files.some((file) => file.path === `${scope ? `${scope}/` : ""}SKILL.md`)) fail("skill_source_invalid");
      // Hash extracted bytes, paths and modes rather than transport ZIP timestamps.
      const fingerprint = createHash("sha256").update(revision);
      for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
        fingerprint.update(JSON.stringify([file.path, file.bytes.length, file.executable === true])).update(file.bytes);
      }
      return { source: { kind: location.kind, url: location.url.href, revision }, fingerprint: fingerprint.digest("hex"), ...discovered,
        ignoredFiles: discovered.ignoredFiles + selected.ignoredFiles };
    } catch (error) {
      if (options.signal?.aborted) fail("skill_source_cancelled");
      if (controller.signal.aborted) fail("skill_source_timeout");
      if (error instanceof SkillRemoteSourceError || error instanceof SkillBundleError) throw error;
      if (error instanceof RequestBodyTooLargeError) fail("skill_source_too_large");
      if (error instanceof McpSafeFetchError && ["mcp_http_address_forbidden", "mcp_http_url_credentials_forbidden", "mcp_http_url_fragment_forbidden", "mcp_http_https_required", "mcp_http_protocol_forbidden"].includes(error.code)) fail("skill_source_forbidden");
      fail("skill_source_unavailable");
    } finally { clearTimeout(timer); }
  };
}

export const fetchRemoteSkillSource = createRemoteSkillSourceFetcher();
