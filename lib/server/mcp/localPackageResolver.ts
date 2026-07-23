import { maxSatisfying, valid as validSemver } from "semver";
import type { McpSource, McpValidationIssue } from "@/lib/contracts/mcp";
import type { ToolHiveFetch } from "./toolhiveClient";

const REGISTRY_TIMEOUT_MS = 30_000;
const MAX_REGISTRY_RESPONSE_BYTES = 8 * 1_024 * 1_024;

export type McpResolvedPackage = Readonly<{
  artifactUrl: string;
  exactVersion: string;
  integrity: string;
  materializer: "npx" | "uvx";
  packageName: string;
  protocolImage: string;
  sourceKind: "npm" | "pypi";
}>;

export type McpPackageResolution =
  | Readonly<{ kind: "ok"; value: McpResolvedPackage }>
  | Readonly<{ issue: McpValidationIssue; kind: "invalid" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(code: string, path = "source.versionSelector"): McpPackageResolution {
  return { issue: { code, path }, kind: "invalid" };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REGISTRY_RESPONSE_BYTES) {
    throw new Error("registry_response_too_large");
  }
  if (!response.body) throw new Error("registry_response_invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        chunks.push(decoder.decode());
        return JSON.parse(chunks.join("")) as unknown;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REGISTRY_RESPONSE_BYTES) throw new Error("registry_response_too_large");
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function registryJson(
  fetchImplementation: ToolHiveFetch,
  url: URL,
  headers?: HeadersInit
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS);
  const response = await fetchImplementation(url, {
    headers,
    method: "GET",
    redirect: "error",
    signal: timeout
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("registry_request_failed");
  }
  return boundedJson(response);
}

function npmVersion(packument: Record<string, unknown>, selector: string): string | null {
  const versions = isRecord(packument.versions) ? packument.versions : null;
  const tags = isRecord(packument["dist-tags"]) ? packument["dist-tags"] : null;
  if (!versions || !tags) return null;
  const tagged = tags[selector];
  if (typeof tagged === "string" && isRecord(versions[tagged])) return tagged;
  if (validSemver(selector) && isRecord(versions[selector])) return selector;
  try {
    return maxSatisfying(Object.keys(versions), selector, { includePrerelease: false });
  } catch {
    return null;
  }
}

async function resolveNpm(
  source: Extract<McpSource, { kind: "npm" }>,
  fetchImplementation: ToolHiveFetch
): Promise<McpPackageResolution> {
  let value: unknown;
  try {
    value = await registryJson(
      fetchImplementation,
      new URL(`https://registry.npmjs.org/${encodeURIComponent(source.packageName)}`),
      { accept: "application/vnd.npm.install-v1+json" }
    );
  } catch {
    return invalid("npm_registry_unavailable", "source.packageName");
  }
  if (!isRecord(value)) return invalid("npm_registry_response_invalid", "source.packageName");
  const selector = source.versionSelector ?? "latest";
  const exactVersion = npmVersion(value, selector);
  const versions = isRecord(value.versions) ? value.versions : null;
  const metadata = exactVersion && versions && isRecord(versions[exactVersion])
    ? versions[exactVersion]
    : null;
  const dist = metadata && isRecord(metadata.dist) ? metadata.dist : null;
  const artifactUrl = dist?.tarball;
  const integrity = typeof dist?.integrity === "string"
    ? dist.integrity
    : typeof dist?.shasum === "string" && /^[a-f0-9]{40}$/u.test(dist.shasum)
      ? `sha1:${dist.shasum}`
      : null;
  if (!exactVersion || !metadata || typeof artifactUrl !== "string" || !integrity) {
    return invalid("npm_version_unresolved");
  }
  try {
    if (new URL(artifactUrl).protocol !== "https:") throw new Error("invalid");
  } catch {
    return invalid("npm_registry_response_invalid", "source.packageName");
  }
  return {
    kind: "ok",
    value: {
      artifactUrl,
      exactVersion,
      integrity,
      materializer: "npx",
      packageName: source.packageName,
      protocolImage: `npx://${source.packageName}@${exactVersion}`,
      sourceKind: "npm"
    }
  };
}

async function resolvePyPi(
  source: Extract<McpSource, { kind: "pypi" }>,
  fetchImplementation: ToolHiveFetch
): Promise<McpPackageResolution> {
  let value: unknown;
  try {
    value = await registryJson(
      fetchImplementation,
      new URL(`https://pypi.org/pypi/${encodeURIComponent(source.packageName)}/json`),
      { accept: "application/json" }
    );
  } catch {
    return invalid("pypi_registry_unavailable", "source.packageName");
  }
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.releases)) {
    return invalid("pypi_registry_response_invalid", "source.packageName");
  }
  const selector = source.versionSelector?.trim();
  const selected = !selector || selector.toLowerCase() === "latest"
    ? value.info.version
    : selector.startsWith("==")
      ? selector.slice(2)
      : selector;
  if (typeof selected !== "string" || !selected || /[<>=!~,*\s]/u.test(selected)) {
    return invalid("pypi_version_selector_unsupported");
  }
  const files = value.releases[selected];
  if (!Array.isArray(files)) return invalid("pypi_version_unresolved");
  const candidates = files.filter((file) => isRecord(file) && file.yanked !== true &&
    typeof file.url === "string" && isRecord(file.digests) &&
    typeof file.digests.sha256 === "string" && /^[a-f0-9]{64}$/u.test(file.digests.sha256));
  const selectedFile = candidates.find((file) => file.packagetype === "sdist") ?? candidates[0];
  if (!selectedFile || !isRecord(selectedFile.digests) ||
    typeof selectedFile.url !== "string" || typeof selectedFile.digests.sha256 !== "string") {
    return invalid("pypi_version_unresolved");
  }
  try {
    if (new URL(selectedFile.url).protocol !== "https:") throw new Error("invalid");
  } catch {
    return invalid("pypi_registry_response_invalid", "source.packageName");
  }
  return {
    kind: "ok",
    value: {
      artifactUrl: selectedFile.url,
      exactVersion: selected,
      integrity: `sha256:${selectedFile.digests.sha256}`,
      materializer: "uvx",
      packageName: source.packageName,
      protocolImage: `uvx://${source.packageName}@${selected}`,
      sourceKind: "pypi"
    }
  };
}

export function createMcpLocalPackageResolver(
  fetchImplementation: ToolHiveFetch = (input, init) => fetch(input, init)
) {
  return async function resolve(source: McpSource): Promise<McpPackageResolution> {
    if (source.kind === "npm") return resolveNpm(source, fetchImplementation);
    if (source.kind === "pypi") return resolvePyPi(source, fetchImplementation);
    return invalid("local_package_source_required", "source.kind");
  };
}
