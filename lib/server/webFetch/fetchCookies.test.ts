import { readFileSync } from "node:fs";
import { createServer, request, type RequestListener } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { McpPinnedHttpRequest } from "../mcp/safeFetch";
import { setRecordObserver } from "../observability";
import { createFetchUrlSession } from "../tools/fetchUrl";
import { extractPage } from "./extract";
import { fetchWebPage } from "./transport";
import { fetchUrlDigest } from "./urls";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  setRecordObserver(null);
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function localOrigin(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic_origin_address");
  // Only the dispatch seam dials loopback, AFTER the real public-address
  // policy passes. Requests retain the checked URL's Host and headers.
  return (input: McpPinnedHttpRequest) => new Promise<Response>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: address.port, method: input.method,
      path: `${input.url.pathname}${input.url.search}`, signal: input.signal,
      headers: { ...Object.fromEntries(input.headers), host: input.url.host } }, (incoming) => {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("fetch_url redirect cookies and tabbed HTML", () => {
  it("opens a cookie-setting redirect in one call, keeps the tab specification and isolates later calls", async () => {
    const start = "http://shop.example.com/start";
    const other = "http://another.example.org/probe";
    const probe = "http://shop.example.com/probe";
    const received: { host: string | undefined; path: string | undefined; cookie: string | undefined }[] = [];
    const fixture = readFileSync(new URL("./tabbedProduct.testFixture.html", import.meta.url));
    const dispatch = await localOrigin((incoming, response) => {
      received.push({ host: incoming.headers.host, path: incoming.url, cookie: incoming.headers.cookie });
      if (incoming.url === "/start") {
        response.writeHead(302, { location: "/product", "set-cookie": ["gate=synthetic-cookie-value; Path=/; HttpOnly",
          "second=synthetic-second-value; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT"] }).end();
      } else if (incoming.url === "/product") {
        if (incoming.headers.cookie !== "gate=synthetic-cookie-value; second=synthetic-second-value") {
          response.writeHead(302, { location: "/start" }).end();
        } else response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fixture);
      } else if (incoming.url === "/leave") {
        response.writeHead(302, { location: other, "set-cookie": "gate=synthetic-cookie-value; Domain=example.com; Path=/" }).end();
      } else response.writeHead(200, { "content-type": "text/plain" }).end("Cookie isolation probe");
    });
    const records: unknown[] = [];
    setRecordObserver((record) => records.push(record));
    const session = () => createFetchUrlSession({
      plan: { version: 1, userUrlDigests: [start, probe, "http://shop.example.com/leave"].map(fetchUrlDigest) }, scheduled: false,
      fetchPage: (url, options) => fetchWebPage(url, { ...options, dispatch,
        lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }] }),
      // Same extraction as the disposable parser; no parser service or database needed.
      extractPage: async (input) => extractPage(input)
    });
    const reader = session();
    const execute = (url: string, active = reader) => active.execute({ name: "fetch_url", id: "synthetic-call", arguments: { url } },
      { signal: new AbortController().signal });
    const result = await execute(start);
    expect(result).toMatchObject({ status: "complete", content: [{ value: { finalUrl: "http://shop.example.com/product",
      text: expect.stringContaining("| Латекс | 30 мм |") } }] });
    expect(received).toHaveLength(2);
    expect(received[0]!.cookie).toBeUndefined();
    expect(received[1]!.cookie).toContain("gate=synthetic-cookie-value");
    await execute(probe);
    await execute(probe, session());
    await execute("http://shop.example.com/leave");
    expect(received.slice(2).map(({ cookie }) => cookie)).toEqual([undefined, undefined, undefined, undefined]);
    expect(received.at(-1)!.host).toBe("another.example.org");
    expect(JSON.stringify([result, records])).not.toMatch(/synthetic-cookie-value|synthetic-second-value|BOILERPLATE/u);
  });

  it("still refuses private redirect targets and redirect loops after cookies are set", async () => {
    const requests: string[] = [];
    const dispatch = await localOrigin((incoming, response) => {
      requests.push(incoming.url!);
      response.writeHead(302, { location: incoming.url === "/private" ? "http://127.0.0.1/" : "/loop",
        "set-cookie": "gate=synthetic-cookie-value; Path=/" }).end();
    });
    const options = { acceptsContentType: () => true, dispatch,
      lookupHostname: async (hostname: string) => [{ address: hostname === "127.0.0.1" ? hostname : "93.184.216.34", family: 4 as const }] };
    const blocked = await fetchWebPage("http://shop.example.com/private", options).catch((error: unknown) => error);
    expect(blocked).toMatchObject({ code: "fetch_blocked_address", dispatched: true });
    expect(requests).toEqual(["/private"]);
    const loop = await fetchWebPage("http://shop.example.com/loop", { ...options, limits: { maxRedirects: 1 } })
      .catch((error: unknown) => error);
    expect(loop).toMatchObject({ code: "fetch_redirect_limit", dispatched: true });
    expect(requests).toEqual(["/private", "/loop", "/loop"]);
    expect(JSON.stringify([blocked, loop])).not.toContain("synthetic-cookie-value");
  });
});
