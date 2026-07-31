import { describe, expect, it, vi } from "vitest";
import {
  compareReleaseSemVer,
  createGitHubReleaseStatusReader,
  parseReleaseSemVer
} from "./releaseStatus";

function releaseResponse(
  tagName: string,
  input: Readonly<{ etag?: string; publishedAt?: string }> = {}
): Response {
  return Response.json({
    draft: false,
    prerelease: false,
    published_at: input.publishedAt ?? "2026-07-31T12:00:00.000Z",
    tag_name: tagName
  }, {
    headers: input.etag ? { etag: input.etag } : undefined
  });
}

describe("GitHub release status", () => {
  it("parses and compares SemVer precedence without treating build metadata as a release", () => {
    expect(parseReleaseSemVer("v1.2.3+build.7")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
      version: "1.2.3"
    });
    expect(parseReleaseSemVer("1.2.3-01")).toBeNull();
    expect(parseReleaseSemVer("release-1.2.3")).toBeNull();

    const beta = parseReleaseSemVer("1.2.3-beta.2")!;
    const betaNext = parseReleaseSemVer("1.2.3-beta.11")!;
    const numeric = parseReleaseSemVer("1.2.3-1")!;
    const stable = parseReleaseSemVer("1.2.3")!;
    expect(compareReleaseSemVer(betaNext, beta)).toBeGreaterThan(0);
    expect(compareReleaseSemVer(numeric, beta)).toBeLessThan(0);
    expect(compareReleaseSemVer(stable, betaNext)).toBeGreaterThan(0);
  });

  it("reports a newer stable release from the fixed public repository and caches it", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      releaseResponse("0.2.0", { etag: "etag-1" }));
    const readStatus = createGitHubReleaseStatusReader({
      currentVersion: "0.1.12",
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-07-31T13:00:00.000Z")
    });

    const first = await readStatus();
    const second = await readStatus();

    expect(first).toEqual({
      checkedAt: "2026-07-31T13:00:00.000Z",
      currentVersion: "0.1.12",
      latestVersion: "0.2.0",
      publishedAt: "2026-07-31T12:00:00.000Z",
      releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/0.2.0",
      state: "update_available"
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/insciqq/AIQSA/releases/latest"
    );
    const requestHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("Authorization")).toBeNull();
    expect(requestHeaders.get("User-Agent")).toBe("AIQSA/0.1.12");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("revalidates an expired successful result with its ETag", async () => {
    let nowMs = Date.parse("2026-07-31T13:00:00.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(releaseResponse("v0.1.12", { etag: "etag-current" }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const readStatus = createGitHubReleaseStatusReader({
      cacheTtlMs: 1_000,
      currentVersion: "0.1.12",
      fetcher: fetcher as typeof fetch,
      now: () => new Date(nowMs)
    });

    const first = await readStatus();
    nowMs += 1_001;
    const revalidated = await readStatus();

    expect(first.state).toBe("current");
    expect(revalidated).toMatchObject({
      checkedAt: new Date(nowMs).toISOString(),
      state: "current"
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("If-None-Match")).toBe(
      "etag-current"
    );
  });

  it("coalesces concurrent administrator reads into one GitHub request", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }));
    const readStatus = createGitHubReleaseStatusReader({
      currentVersion: "0.1.12",
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-07-31T13:00:00.000Z")
    });

    const first = readStatus();
    const second = readStatus();
    expect(fetcher).toHaveBeenCalledOnce();
    resolveFetch(releaseResponse("v0.2.0"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "update_available" }),
      expect.objectContaining({ state: "update_available" })
    ]);
  });

  it("serves stale successful evidence and backs off when GitHub is unavailable", async () => {
    let nowMs = Date.parse("2026-07-31T13:00:00.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(releaseResponse("v0.2.0"))
      .mockRejectedValueOnce(new Error("network unavailable"));
    const readStatus = createGitHubReleaseStatusReader({
      cacheTtlMs: 1_000,
      currentVersion: "0.1.12",
      failureCacheTtlMs: 10_000,
      fetcher: fetcher as typeof fetch,
      now: () => new Date(nowMs)
    });

    const successful = await readStatus();
    nowMs += 1_001;
    const stale = await readStatus();
    nowMs += 5_000;
    const backedOff = await readStatus();

    expect(stale).toEqual(successful);
    expect(backedOff).toEqual(successful);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails quietly and caches an unavailable result for malformed release data", async () => {
    const fetcher = vi.fn(async () => Response.json({
      draft: false,
      prerelease: false,
      published_at: null,
      tag_name: "not-semver"
    }));
    const readStatus = createGitHubReleaseStatusReader({
      currentVersion: "0.1.12",
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-07-31T13:00:00.000Z")
    });

    await expect(readStatus()).resolves.toEqual({
      checkedAt: "2026-07-31T13:00:00.000Z",
      currentVersion: "0.1.12",
      latestVersion: null,
      publishedAt: null,
      releaseUrl: null,
      state: "unavailable"
    });
    await readStatus();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds an unresponsive GitHub request with the configured deadline", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    const readStatus = createGitHubReleaseStatusReader({
      currentVersion: "0.1.12",
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-07-31T13:00:00.000Z"),
      timeoutMs: 1
    });

    await expect(readStatus()).resolves.toMatchObject({ state: "unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("rejects an oversized latest-release response without parsing or exposing it", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("x".repeat(1 * 1_024 * 1_024 + 1)));
    const readStatus = createGitHubReleaseStatusReader({
      currentVersion: "0.1.12",
      fetcher: fetcher as typeof fetch,
      now: () => new Date("2026-07-31T13:00:00.000Z")
    });

    await expect(readStatus()).resolves.toMatchObject({
      latestVersion: null,
      state: "unavailable"
    });
  });
});
