import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { McpPinnedHttpRequest, McpResolvedAddress } from "../mcp/safeFetch";
import { fetchWebPage, WEB_FETCH_USER_AGENT, WebFetchError } from "./transport";

type Route = (request: McpPinnedHttpRequest) => Response | Promise<Response>;

const PUBLIC: McpResolvedAddress = { address: "93.184.216.34", family: 4 };

function harness(routes: Record<string, Route>, addresses: Record<string, readonly McpResolvedAddress[]> = {}) {
  const requests: McpPinnedHttpRequest[] = [];
  const dispatch = vi.fn(async (request: McpPinnedHttpRequest) => {
    requests.push(request);
    const route = routes[request.url.href];
    if (!route) throw new Error(`unexpected request ${request.url.href}`);
    return route(request);
  });
  const lookupHostname = vi.fn(async (hostname: string) => addresses[hostname] ?? [PUBLIC]);
  return { dispatch, lookupHostname, requests };
}

const html = (body = "<p>Hello</p>", headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers }, status: 200 });
const redirect = (location: string, status = 302) => new Response(null, { headers: { location }, status });
const acceptsAll = { acceptsContentType: () => true };

async function failure(promise: Promise<unknown>): Promise<WebFetchError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(WebFetchError);
  return error as WebFetchError;
}

describe("page transport policy", () => {
  it("sends one fixed user agent with no cookies or credentials and returns the body", async () => {
    const { dispatch, lookupHostname, requests } = harness({ "https://example.com/page": () => html() });
    const page = await fetchWebPage("https://example.com/page", { ...acceptsAll, dispatch, lookupHostname });
    expect(new TextDecoder().decode(page.body)).toBe("<p>Hello</p>");
    expect(page.finalUrl).toBe("https://example.com/page");
    const headers = requests[0]!.headers;
    expect(headers.get("user-agent")).toBe(WEB_FETCH_USER_AGENT);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.address).toEqual(PUBLIC);
  });

  it.each([
    ["private", { address: "10.1.2.3", family: 4 }],
    ["loopback", { address: "127.0.0.1", family: 4 }],
    ["CGNAT", { address: "100.64.0.9", family: 4 }],
    ["metadata link-local", { address: "169.254.169.254", family: 4 }],
    ["IPv6 loopback", { address: "::1", family: 6 }],
    ["IPv6 unique local", { address: "fd00::1", family: 6 }]
  ] as const)("refuses a host resolving to a %s address before any request", async (_label, address) => {
    const { dispatch, lookupHostname } = harness({}, { "internal.example": [PUBLIC, address] });
    const error = await failure(fetchWebPage("https://internal.example/", { ...acceptsAll, dispatch, lookupHostname }));
    expect(error.code).toBe("fetch_blocked_address");
    expect(error.dispatched).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses literal metadata and loopback addresses without DNS", async () => {
    const { dispatch } = harness({});
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://2130706433/"]) {
      expect((await failure(fetchWebPage(url, { ...acceptsAll, dispatch }))).code).toBe("fetch_blocked_address");
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses userinfo and non-default ports before any request", async () => {
    const { dispatch, lookupHostname } = harness({});
    expect((await failure(fetchWebPage("https://user:secret@example.com/", { ...acceptsAll, dispatch, lookupHostname }))).code)
      .toBe("fetch_url_credentials");
    expect((await failure(fetchWebPage("http://example.com:8080/", { ...acceptsAll, dispatch, lookupHostname }))).code)
      .toBe("fetch_port_not_allowed");
    expect(dispatch).not.toHaveBeenCalled();
    expect(lookupHostname).not.toHaveBeenCalled();
  });
});

describe("redirects", () => {
  it("follows up to five redirects, checks each hop and records the final URL", async () => {
    const { dispatch, lookupHostname } = harness({
      "http://example.com/start": () => redirect("https://example.com/next#frag"),
      "https://example.com/next": () => redirect("/final", 301),
      "https://example.com/final": () => html("<p>Done</p>")
    });
    const page = await fetchWebPage("http://example.com/start", { ...acceptsAll, dispatch, lookupHostname });
    expect(page.finalUrl).toBe("https://example.com/final");
    expect(lookupHostname).toHaveBeenCalledTimes(3);
  });

  it("refuses a redirect into a private network after the first hop", async () => {
    const { dispatch, lookupHostname } = harness({ "https://example.com/": () => redirect("http://router.example/admin") },
      { "router.example": [{ address: "192.168.1.1", family: 4 }] });
    const error = await failure(fetchWebPage("https://example.com/", { ...acceptsAll, dispatch, lookupHostname }));
    expect(error.code).toBe("fetch_blocked_address");
    expect(error.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses redirects to other ports, credentials and schemes, and more than five hops", async () => {
    const one = harness({ "https://example.com/": () => redirect("https://example.com:8443/") });
    expect((await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...one }))).code).toBe("fetch_port_not_allowed");
    const two = harness({ "https://example.com/": () => redirect("https://u:p@example.com/x") });
    expect((await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...two }))).code).toBe("fetch_url_credentials");
    const three = harness({ "https://example.com/": () => redirect("file:///etc/passwd") });
    expect((await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...three }))).code).toBe("fetch_redirect_invalid");
    // A target beyond the URL length bound is refused; a long fragment alone is dropped, not counted.
    const long = harness({ "https://example.com/": () => redirect(`/${"a".repeat(2_100)}`) });
    expect((await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...long }))).code).toBe("fetch_redirect_invalid");
    expect(long.dispatch).toHaveBeenCalledTimes(1);
    const fragment = harness({
      "https://example.com/": () => redirect(`/next#${"f".repeat(4_000)}`),
      "https://example.com/next": () => html("<p>Done</p>")
    });
    expect((await fetchWebPage("https://example.com/", { ...acceptsAll, ...fragment })).finalUrl).toBe("https://example.com/next");
    const loop = harness(Object.fromEntries(Array.from({ length: 7 }, (_, index) =>
      [`https://example.com/${index}`, () => redirect(`/${index + 1}`)])));
    expect((await failure(fetchWebPage("https://example.com/0", { ...acceptsAll, ...loop }))).code).toBe("fetch_redirect_limit");
    expect(loop.dispatch).toHaveBeenCalledTimes(6);
  });
});

describe("bounds", () => {
  it("refuses a declared oversized body before reading it and an undeclared one while streaming", async () => {
    const declared = harness({ "https://example.com/": () => html("small", { "content-length": String(6 * 1024 * 1024) }) });
    expect((await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...declared }))).code).toBe("fetch_too_large");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 100) controller.close();
      }
    });
    const streaming = harness({ "https://example.com/": () => new Response(stream, { headers: { "content-type": "text/plain" } }) });
    const error = await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...streaming, limits: { maxBytes: 4096 } }));
    expect(error.code).toBe("fetch_too_large");
    expect(pulled).toBeLessThan(20);
  });

  it("bounds a body by its media type's limit when the caller sets one, declared, streamed and decoded", async () => {
    const maxBytesFor = (type: string | null) => (type === "application/pdf" ? 8 * 1024 : 1024);
    const declared = harness({ "https://example.com/a.pdf": () => new Response("%PDF-", {
      headers: { "content-length": String(9 * 1024), "content-type": "application/pdf" } }) });
    expect((await failure(fetchWebPage("https://example.com/a.pdf", { ...acceptsAll, ...declared, maxBytesFor }))).code)
      .toBe("fetch_too_large");
    const larger = harness({ "https://example.com/b.pdf": () => new Response(new Uint8Array(4 * 1024),
      { headers: { "content-type": "application/pdf" } }) });
    expect((await fetchWebPage("https://example.com/b.pdf", { ...acceptsAll, ...larger, maxBytesFor })).body.byteLength).toBe(4096);
    const page = harness({ "https://example.com/c": () => new Response(new Uint8Array(4 * 1024), { headers: { "content-type": "text/html" } }) });
    expect((await failure(fetchWebPage("https://example.com/c", { ...acceptsAll, ...page, maxBytesFor }))).code).toBe("fetch_too_large");
    const bomb = harness({ "https://example.com/d.pdf": () => new Response(gzipSync(Buffer.alloc(64 * 1024)),
      { headers: { "content-encoding": "gzip", "content-type": "application/pdf" } }) });
    expect((await failure(fetchWebPage("https://example.com/d.pdf", { ...acceptsAll, ...bomb, maxBytesFor }))).code)
      .toBe("fetch_too_large");
  });

  it("asks for PDFs as well as pages", async () => {
    const { dispatch, lookupHostname, requests } = harness({ "https://example.com/page": () => html() });
    await fetchWebPage("https://example.com/page", { ...acceptsAll, dispatch, lookupHostname });
    expect(requests[0]!.headers.get("accept")).toContain("application/pdf");
  });

  it("decodes gzip within the same bound and refuses a decompression bomb", async () => {
    const gzip = harness({ "https://example.com/": () => new Response(gzipSync(Buffer.from("<p>compressed</p>")),
      { headers: { "content-encoding": "gzip", "content-type": "text/html" } }) });
    const page = await fetchWebPage("https://example.com/", { ...acceptsAll, ...gzip });
    expect(new TextDecoder().decode(page.body)).toBe("<p>compressed</p>");
    const bomb = harness({ "https://example.com/": () => new Response(gzipSync(Buffer.alloc(64 * 1024)),
      { headers: { "content-encoding": "gzip", "content-type": "text/html" } }) });
    expect((await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...bomb, limits: { maxBytes: 8 * 1024 } }))).code)
      .toBe("fetch_too_large");
  });

  it("ends a slow server at the deadline", async () => {
    const slow = harness({ "https://example.com/": (request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }) });
    const error = await failure(fetchWebPage("https://example.com/", { ...acceptsAll, ...slow, limits: { deadlineMs: 20 } }));
    expect(error.code).toBe("fetch_timeout");
  });

  it("refuses unsupported media types before the body and reports HTTP status codes", async () => {
    const pdf = harness({ "https://example.com/file.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) });
    expect((await failure(fetchWebPage("https://example.com/file.pdf", { ...pdf,
      acceptsContentType: (type) => type?.startsWith("text/") === true }))).code).toBe("fetch_unsupported_content_type");
    const missing = harness({ "https://example.com/gone": () => new Response("no", { status: 404 }) });
    const error = await failure(fetchWebPage("https://example.com/gone", { ...acceptsAll, ...missing }));
    expect(error.code).toBe("fetch_http_status");
    expect(error.httpStatus).toBe(404);
  });

  it("keeps the caller's cancellation instead of a fetch failure", async () => {
    const controller = new AbortController();
    const hanging = harness({ "https://example.com/": (request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      controller.abort(new DOMException("stopped", "AbortError"));
    }) });
    const error = await fetchWebPage("https://example.com/", { ...acceptsAll, ...hanging, signal: controller.signal })
      .then(() => null, (caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(WebFetchError);
    expect((error as Error).name).toBe("AbortError");
  });
});
