import { afterEach, describe, expect, it, vi } from "vitest";

const safeFetchCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("../mcp/safeFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/safeFetch")>();
  return {
    ...actual,
    mcpSafeFetch: vi.fn(async (...args: unknown[]) => {
      safeFetchCalls.push(args);
      return new Response(null, { headers: { location: "https://news.example.com/a" }, status: 302 });
    })
  };
});

import {
  fetchGeminiGroundingRedirect,
  isGeminiGroundingRedirect,
  resolveGeminiGroundingRedirects,
  type GeminiGroundingRedirectFetch
} from "./geminiGroundingRedirect";

const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;

function located(location: string | null, status = 302): Response {
  return new Response(null, { headers: location === null ? {} : { location }, status });
}

afterEach(() => {
  safeFetchCalls.length = 0;
});

describe("Gemini grounding redirects", () => {
  it("requests only Google's grounding redirect links", () => {
    expect(isGeminiGroundingRedirect(redirect("AUZIYQF-abc_123="))).toBe(true);
    for (const url of [
      "http://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ",
      "https://vertexaisearch.cloud.google.com/other/AUZ",
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/",
      "https://vertexaisearch.cloud.google.com:8443/grounding-api-redirect/AUZ",
      "https://user:pass@vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ",
      `${redirect("AUZ")}#fragment`,
      "https://evil.example/grounding-api-redirect/AUZ",
      "https://vertexaisearch.cloud.google.com.evil.example/grounding-api-redirect/AUZ",
      `${redirect("A".repeat(2_100))}`,
      "not a url"
    ]) {
      expect(isGeminiGroundingRedirect(url)).toBe(false);
    }
  });

  it("maps each redirect to the https page its Location names and keeps the rest out", async () => {
    const locations: Record<string, Response | Error> = {
      [redirect("ok")]: located("https://www.finmarket.ru/news/6757758"),
      [redirect("relative")]: located("/elsewhere"),
      [redirect("http")]: located("http://plain.example/page"),
      [redirect("credentials")]: located("https://user:secret@site.example/page"),
      [redirect("not-redirect")]: located("https://site.example/page", 200),
      [redirect("no-location")]: located(null),
      [redirect("failed")]: new Error("provider_http_request_failed"),
      [redirect("permanent")]: located("https://site.example/moved?x=1#part", 308)
    };
    const fetchRedirect = vi.fn<GeminiGroundingRedirectFetch>(async (url) => {
      const answer = locations[url];
      if (answer instanceof Error) throw answer;
      return answer!;
    });
    const resolved = await resolveGeminiGroundingRedirects([
      ...Object.keys(locations), redirect("ok"), "https://example.test/direct"
    ], { fetchRedirect });

    expect(Object.fromEntries(resolved)).toEqual({
      [redirect("ok")]: "https://www.finmarket.ru/news/6757758",
      [redirect("permanent")]: "https://site.example/moved?x=1#part"
    });
    // One request per distinct redirect; a direct link is never requested.
    expect(fetchRedirect).toHaveBeenCalledTimes(Object.keys(locations).length);
    expect(fetchRedirect.mock.calls.map(([url]) => url)).not.toContain("https://example.test/direct");
  });

  it("runs a bounded number of requests at once", async () => {
    let active = 0;
    let peak = 0;
    const fetchRedirect: GeminiGroundingRedirectFetch = async (url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return located(`https://site.example/${url.slice(-2)}`);
    };
    const urls = Array.from({ length: 10 }, (_, index) => redirect(`page-${String(index).padStart(2, "0")}`));
    const resolved = await resolveGeminiGroundingRedirects(urls, { fetchRedirect, limits: { concurrency: 3 } });
    expect(resolved.size).toBe(10);
    expect(peak).toBe(3);
  });

  it("gives up on a slow request and on the whole resolution within their bounds", async () => {
    const never: GeminiGroundingRedirectFetch = (url) => url.endsWith("fast")
      ? Promise.resolve(located("https://site.example/fast"))
      : new Promise<Response>(() => undefined);
    const startedAt = Date.now();
    const resolved = await resolveGeminiGroundingRedirects([redirect("slow"), redirect("fast")], {
      fetchRedirect: never,
      limits: { requestTimeoutMs: 20, totalTimeoutMs: 1_000 }
    });
    expect(Object.fromEntries(resolved)).toEqual({ [redirect("fast")]: "https://site.example/fast" });

    const signals: AbortSignal[] = [];
    const resolvedInTotal = await resolveGeminiGroundingRedirects(
      Array.from({ length: 6 }, (_, index) => redirect(`hang-${index}`)),
      {
        fetchRedirect: (_url, signal) => { signals.push(signal); return new Promise<Response>(() => undefined); },
        limits: { concurrency: 2, requestTimeoutMs: 1_000, totalTimeoutMs: 30 }
      }
    );
    expect(resolvedInTotal.size).toBe(0);
    // The whole deadline aborts the requests in flight and starts no more.
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it("starts nothing once the search is stopped, and stops what runs when it is", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const fetchRedirect = vi.fn<GeminiGroundingRedirectFetch>(async () => located("https://site.example/a"));
    expect((await resolveGeminiGroundingRedirects([redirect("a")], { fetchRedirect, signal: stopped.signal })).size).toBe(0);
    expect(fetchRedirect).not.toHaveBeenCalled();

    const stop = new AbortController();
    const pending = resolveGeminiGroundingRedirects([redirect("a"), redirect("b")], {
      fetchRedirect: () => new Promise<Response>(() => undefined),
      signal: stop.signal
    });
    stop.abort();
    expect((await pending).size).toBe(0);
  });

  it("sends one credential-free HEAD through the pinned transport, public HTTPS addresses only, no redirect followed", async () => {
    const signal = new AbortController().signal;
    const response = await fetchGeminiGroundingRedirect(redirect("ok"), signal);
    expect(response.status).toBe(302);
    expect(safeFetchCalls).toHaveLength(1);
    const [url, init, options] = safeFetchCalls[0] as [string, RequestInit, {
      addressAllowed(address: { address: string; family: 4 | 6 }, url: URL): boolean;
      allowInsecureHttp: boolean;
      maxRedirects: number;
    }];
    expect(url).toBe(redirect("ok"));
    expect(init).toEqual({ cache: "no-store", credentials: "omit", method: "HEAD", redirect: "manual", signal });
    expect(init).not.toHaveProperty("headers");
    expect(options).toMatchObject({ allowInsecureHttp: false, maxRedirects: 0 });
    const target = new URL(redirect("ok"));
    expect(options.addressAllowed({ address: "142.250.74.10", family: 4 }, target)).toBe(true);
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.2"]) {
      expect(options.addressAllowed({ address, family: 4 }, target)).toBe(false);
    }
  });
});
