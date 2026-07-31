import type { AdminReleaseStatus } from "../../contracts/adminRelease";
import packageMetadata from "../../../package.json";
import { readBoundedResponseText } from "../providers/network";

const githubLatestReleaseUrl = "https://api.github.com/repos/insciqq/AIQSA/releases/latest";
const githubReleasePagePrefix = "https://github.com/insciqq/AIQSA/releases/tag/";
const defaultCacheTtlMs = 6 * 60 * 60 * 1_000;
const defaultFailureCacheTtlMs = 15 * 60 * 1_000;
const defaultTimeoutMs = 5_000;
const githubResponseMaxBytes = 1 * 1_024 * 1_024;

type SemVer = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  version: string;
}>;

type ReleaseStatusReaderOptions = Readonly<{
  cacheTtlMs?: number;
  currentVersion?: string;
  failureCacheTtlMs?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseSemVer(value: string): SemVer | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: match[4] ?? null,
    version: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ""}`
  };
}

export function compareReleaseSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const leftIdentifiers = left.prerelease.split(".");
  const rightIdentifiers = right.prerelease.split(".");
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length > rightIdentifier.length ? 1 : -1;
      }
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function unavailableStatus(currentVersion: string, now: Date): AdminReleaseStatus {
  return {
    checkedAt: now.toISOString(),
    currentVersion,
    latestVersion: null,
    publishedAt: null,
    releaseUrl: null,
    state: "unavailable"
  };
}

function publishedAt(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function createGitHubReleaseStatusReader({
  cacheTtlMs = defaultCacheTtlMs,
  currentVersion = packageMetadata.version,
  failureCacheTtlMs = defaultFailureCacheTtlMs,
  fetcher = fetch,
  now = () => new Date(),
  timeoutMs = defaultTimeoutMs
}: ReleaseStatusReaderOptions = {}): () => Promise<AdminReleaseStatus> {
  const current = parseReleaseSemVer(currentVersion);
  const normalizedCurrentVersion = current?.version ?? currentVersion.slice(0, 64);
  let cached: Readonly<{
    etag: string | null;
    expiresAt: number;
    value: AdminReleaseStatus;
  }> | null = null;
  let pending: Promise<AdminReleaseStatus> | null = null;

  return async function readReleaseStatus(): Promise<AdminReleaseStatus> {
    const requestedAt = now();
    if (!current) return unavailableStatus(normalizedCurrentVersion, requestedAt);
    if (cached && requestedAt.getTime() < cached.expiresAt) return cached.value;
    if (pending) return pending;

    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("github_release_timeout")), timeoutMs);
      try {
        const response = await fetcher(githubLatestReleaseUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `AIQSA/${current.version}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(cached?.etag ? { "If-None-Match": cached.etag } : {})
          },
          redirect: "error",
          signal: controller.signal
        });
        const checkedAt = now();
        if (response.status === 304 && cached) {
          cached = {
            ...cached,
            expiresAt: checkedAt.getTime() + cacheTtlMs,
            value: { ...cached.value, checkedAt: checkedAt.toISOString() }
          };
          return cached.value;
        }
        if (!response.ok) throw new Error("github_release_unavailable");
        const body = JSON.parse(await readBoundedResponseText(response, {
          maxBytes: githubResponseMaxBytes,
          signal: controller.signal
        })) as unknown;
        if (!isRecord(body) || body.draft !== false || body.prerelease !== false ||
          typeof body.tag_name !== "string" || body.tag_name.trim().length > 64) {
          throw new Error("github_release_invalid");
        }
        const tagName = body.tag_name.trim();
        const latest = parseReleaseSemVer(tagName);
        const releasedAt = publishedAt(body.published_at);
        if (!latest || latest.prerelease !== null || !releasedAt) {
          throw new Error("github_release_invalid");
        }
        const updateAvailable = compareReleaseSemVer(latest, current) > 0;
        const value: AdminReleaseStatus = {
          checkedAt: checkedAt.toISOString(),
          currentVersion: current.version,
          latestVersion: latest.version,
          publishedAt: releasedAt,
          releaseUrl: `${githubReleasePagePrefix}${encodeURIComponent(tagName)}`,
          state: updateAvailable ? "update_available" : "current"
        };
        const etag = response.headers.get("etag");
        cached = {
          etag: etag && etag.length <= 1_024 ? etag : null,
          expiresAt: checkedAt.getTime() + cacheTtlMs,
          value
        };
        return value;
      } catch {
        const failedAt = now();
        if (cached) {
          cached = {
            ...cached,
            expiresAt: failedAt.getTime() + failureCacheTtlMs
          };
          return cached.value;
        }
        const value = unavailableStatus(current.version, failedAt);
        cached = {
          etag: null,
          expiresAt: failedAt.getTime() + failureCacheTtlMs,
          value
        };
        return value;
      } finally {
        clearTimeout(timeout);
        pending = null;
      }
    })();

    return pending;
  };
}

export const readGitHubReleaseStatus = createGitHubReleaseStatusReader();
