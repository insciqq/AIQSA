// @vitest-environment node
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPersonalMcpNetworkEnvironment } from "../mcp/personalNetworkPolicy";
import type { McpResolvedAddress } from "../mcp/safeFetch";
import * as addressPolicy from "../proxies/address";
import { runProxiesFromRows } from "../proxies/runProxies";
import { createFetchUrlSession, fetchUrlActivityFacts } from "../tools/fetchUrl";
import { setRecordObserver } from "../observability";
import { fetchThroughProxy } from "./index";
import { localProxy, pageResponse, proxyConnection } from "./proxy.testFixtures";
import { fetchUrlDigest } from "./urls";

vi.mock("../proxies/address", async (original) => {
  const actual = await original<typeof addressPolicy>();
  return { ...actual, checkProxyAddress: vi.fn(actual.checkProxyAddress) };
});
const actualPolicy = await vi.importActual<typeof addressPolicy>("../proxies/address");
const PUBLIC: McpResolvedAddress = { address: "93.184.216.34", family: 4 };
const lookup = vi.fn(async () => [PUBLIC]);
const environment = () => buildPersonalMcpNetworkEnvironment({
  detectContainer: () => true, env: {},
  interfaces: () => [{ address: "172.20.0.5", cidr: "172.20.0.5/16", internal: false, name: "eth0" }],
  lookupHostname: async () => [{ address: "172.20.0.9", family: 4 }]
});
const cleanups: (() => Promise<void>)[] = [];
const options = { acceptsContentType: () => true, limits: { deadlineMs: 1000 } };
const url = "http://example.com/page";

beforeEach(() => {
  lookup.mockReset().mockResolvedValue([PUBLIC]);
  vi.mocked(addressPolicy.checkProxyAddress).mockReset().mockImplementation(async (target, input) => {
    const checked = await actualPolicy.checkProxyAddress(target, { ...input, environment, lookupHostname: lookup });
    // Only this test substitutes the socket address AFTER the real public-address policy has passed.
    return checked.ok ? { ...checked, pinned: { address: "127.0.0.1", family: 4 } } : checked;
  });
});
afterEach(async () => {
  setRecordObserver(null);
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});
async function proxy(input: Parameters<typeof localProxy>[0] = {}) {
  const server = await localProxy(input);
  cleanups.push(server.close);
  return server;
}

describe("GET through a checked proxy", () => {
  it.each(["http", "socks5"] as const)("reads via %s with authentication only in the handshake", async (protocol) => {
    const server = await proxy({ protocol });
    const connection = proxyConnection(server.port, protocol);
    const response = await fetchThroughProxy(url, connection, options);
    expect(Buffer.from(response.body).toString()).toBe("Synthetic page content");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toContain("GET /page HTTP/1.1");
    expect(server.requests[0]).not.toMatch(/authorization|synthetic-user|synthetic-password/iu);
    if (protocol === "http") expect(server.connects[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from(`${connection.login}:${connection.password}`).toString("base64")}`);
    else {
      expect(server.logins).toEqual([connection.login]);
      expect(server.passwords).toEqual([connection.password]);
    }
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each(["http", "socks5"] as const)("supports unauthenticated %s proxies without inventing credentials", async (protocol) => {
    const server = await proxy({ protocol });
    await fetchThroughProxy(url, { ...proxyConnection(server.port, protocol), login: null, password: null }, options);
    expect(server.connects.join(" ")).not.toContain("Proxy-Authorization");
    expect(server.logins).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it("never reuses a target's tunnel for another proxy's credentials", async () => {
    const first = await proxy();
    const second = await proxy();
    const a = proxyConnection(first.port);
    const b = { ...proxyConnection(second.port, "http", "another"), password: "second-synthetic-password" };
    await fetchThroughProxy(url, a, options);
    await fetchThroughProxy(url, b, options);
    expect(first.connects).toHaveLength(1);
    expect(second.connects).toHaveLength(1);
    expect(second.connects[0]).toContain(Buffer.from(`${b.login}:${b.password}`).toString("base64"));
    expect(second.connects[0]).not.toContain(Buffer.from(`${a.login}:${a.password}`).toString("base64"));
  });

  it("keeps the caller's cancellation and closes a stalled handshake", async () => {
    const server = await proxy({ behavior: "silent" });
    const controller = new AbortController();
    const work = fetchThroughProxy(url, proxyConnection(server.port), { ...options, signal: controller.signal });
    const reason = new DOMException("Synthetic cancellation", "AbortError");
    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
  });

  it("bounds installation discovery with the page deadline", async () => {
    vi.mocked(addressPolicy.checkProxyAddress).mockImplementationOnce(() => new Promise(() => undefined));
    await expect(fetchThroughProxy(url, proxyConnection(8080), { ...options, limits: { deadlineMs: 20 } }))
      .rejects.toMatchObject({ code: "proxy_timeout" });
  });

  it.each([
    "garbage page bytes synthetic-password-:/@?", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
  ])("sanitizes malformed or upgraded page responses", async (response) => {
    const server = await proxy({ response: () => response });
    const error = await fetchThroughProxy(url, proxyConnection(server.port), options).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "proxy_protocol_error" });
    expect(String(error)).not.toContain("synthetic-password");
  });

  it.each(["http", "socks5"] as const)("reports a wrong %s password without retaining peer bytes or credentials", async (protocol) => {
    const server = await proxy({ behavior: "bad_password", protocol });
    const connection = proxyConnection(server.port, protocol);
    const error = await fetchThroughProxy(url, connection, options).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "proxy_auth_failed", message: "proxy_auth_failed" });
    expect(JSON.stringify(error)).not.toContain(connection.password);
    expect(server.requests).toEqual([]);
  });

  it.each([
    ["close", "proxy_connect_failed"], ["garbage", "proxy_protocol_error"], ["silent", "proxy_timeout"]
  ] as const)("bounds and sanitizes a proxy that is %s", async (behavior, code) => {
    const server = await proxy({ behavior });
    await expect(fetchThroughProxy(url, proxyConnection(server.port), { ...options, limits: { deadlineMs: 100 } }))
      .rejects.toMatchObject({ code });
    expect(server.requests).toEqual([]);
  });

  it.each(["127.0.0.1", "10.2.3.4", "169.254.169.254"])("refuses a proxy resolving to %s before opening it", async (address) => {
    const server = await proxy();
    lookup.mockResolvedValue([{ address, family: 4 }]);
    await expect(fetchThroughProxy(url, proxyConnection(server.port), options)).rejects.toMatchObject({ code: "proxy_address_forbidden", dispatched: false });
    expect(server.connects).toEqual([]);
  });

  it.each(["http://127.0.0.1/", "http://2130706433/", "http://[::1]/", "http://db/", "http://db.local/", "http://localhost/"])("refuses target %s before the proxy", async (target) => {
    const server = await proxy();
    await expect(fetchThroughProxy(target, proxyConnection(server.port), options)).rejects.toMatchObject({ code: "fetch_blocked_address", dispatched: false });
    expect(addressPolicy.checkProxyAddress).not.toHaveBeenCalled();
    expect(server.connects).toEqual([]);
  });

  it("keeps cross-site redirects on the same proxy and checks each connection", async () => {
    const server = await proxy({ response: (request) => request.includes("GET /page ")
      ? pageResponse("", 302, "Location: http://other.example.org/final\r\n") : pageResponse("Finished") });
    const result = await fetchThroughProxy(url, proxyConnection(server.port), options);
    expect(result.finalUrl).toBe("http://other.example.org/final");
    expect(server.connects).toHaveLength(2);
    expect(server.connects[0]).toContain("CONNECT example.com:80");
    expect(server.connects[1]).toContain("CONNECT other.example.org:80");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect to a private literal without asking the proxy", async () => {
    const server = await proxy({ response: () => pageResponse("", 302, "Location: http://10.0.0.1/secret\r\n") });
    await expect(fetchThroughProxy(url, proxyConnection(server.port), options)).rejects.toMatchObject({ code: "fetch_blocked_address", dispatched: true });
    expect(server.connects).toHaveLength(1);
  });

  it("catches DNS rebinding of the proxy at a redirect hop", async () => {
    const server = await proxy({ response: () => pageResponse("", 302, "Location: /next\r\n") });
    lookup.mockResolvedValueOnce([PUBLIC]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchThroughProxy(url, proxyConnection(server.port), options)).rejects.toMatchObject({ code: "proxy_address_forbidden", dispatched: true });
    expect(server.connects).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("retains raw, decoded and redirect bounds", async () => {
    const big = await proxy({ response: () => pageResponse("x".repeat(100)) });
    await expect(fetchThroughProxy(url, proxyConnection(big.port), { ...options, limits: { maxBytes: 10 } }))
      .rejects.toMatchObject({ code: "fetch_too_large" });
    const compressed = gzipSync("x".repeat(300));
    const encoded = await proxy({ response: () => Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed
    ]) });
    await expect(fetchThroughProxy(url, proxyConnection(encoded.port), { ...options, limits: { maxBytes: 50 } }))
      .rejects.toMatchObject({ code: "fetch_too_large" });
    const loop = await proxy({ response: () => pageResponse("", 302, "Location: /again\r\n") });
    await expect(fetchThroughProxy(url, proxyConnection(loop.port), { ...options, limits: { maxRedirects: 1 } }))
      .rejects.toMatchObject({ code: "fetch_redirect_limit" });
    expect(loop.connects).toHaveLength(2);
  });

  it("reads end to end through the answer's session with credential-free observations and activity", async () => {
    const server = await proxy();
    const connection = proxyConnection(server.port);
    const records: unknown[] = [];
    setRecordObserver((record) => records.push(record));
    const observeProxy = vi.fn();
    const session = createFetchUrlSession({
      plan: { userUrlDigests: [fetchUrlDigest(url)], version: 1 }, scheduled: false,
      proxyPlan: { entries: [connection] }, runProxies: runProxiesFromRows([connection]), userId: "synthetic-user-id", observeProxy,
      extractPage: async ({ body }) => ({ kind: "text", text: Buffer.from(body).toString(), title: null, truncated: false })
    });
    const call = { arguments: { url }, id: "synthetic-call", name: "fetch_url" };
    const result = await session.execute(call, { signal: new AbortController().signal });
    expect(result.status).toBe("complete");
    expect(fetchUrlActivityFacts(call.name, call.arguments, result)).toMatchObject({ fetchProxyName: connection.name });
    expect(observeProxy.mock.calls).toEqual([
      [{ proxyName: connection.name, outcome: "started" }], [{ proxyName: connection.name, outcome: "read" }]
    ]);
    expect(JSON.stringify([result.rawPreview, records, observeProxy.mock.calls])).not.toMatch(/synthetic-password|synthetic-user|Synthetic page content|proxy\.example\.net/u);
    expect(server.requests).toHaveLength(1);
  });
  it("a dead proxy fails the session visibly without calling the direct transport", async () => {
    const server = await proxy({ behavior: "close" });
    const connection = proxyConnection(server.port);
    const fetchPage = vi.fn();
    const session = createFetchUrlSession({
      plan: { userUrlDigests: [fetchUrlDigest(url)], version: 1 }, scheduled: false,
      proxyPlan: { entries: [connection] }, runProxies: runProxiesFromRows([connection]), userId: "synthetic-owner", fetchPage
    });
    const result = await session.execute({ arguments: { url }, id: "call", name: "fetch_url" }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "error", content: [{ value: { error: "proxy_all_failed" } }] });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(server.requests).toEqual([]);
  });

});
