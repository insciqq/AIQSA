import { describe, expect, it, vi } from "vitest";
import { toProxyRunPlan } from "../../contracts/proxies";
import { runProxiesFromRows } from "../proxies/runProxies";
import { proxyConnection } from "../webFetch/proxy.testFixtures";
import { fetchWebPage, WebFetchError, type WebFetchOptions } from "../webFetch/transport";
import { fetchUrlDigest } from "../webFetch/urls";
import { createFetchUrlSession, type FetchUrlSessionDeps } from "./fetchUrl";

const start = "https://short.example/link";
const target = "https://shop.example.kz/private-path";
const proxy = { ...proxyConnection(8080), domainHints: [".kz"] };
const second = { ...proxy, id: "second-proxy", name: "Second proxy" };
const signal = new AbortController().signal;
const call = (choice?: string) => ({ name: "fetch_url", id: "call", arguments: { url: start, ...(choice ? { proxy: choice } : {}) } });

function setup(overrides: Partial<FetchUrlSessionDeps> = {}, limits?: WebFetchOptions["limits"]) {
  const direct: string[] = [];
  const dispatch = vi.fn<NonNullable<WebFetchOptions["dispatch"]>>(async ({ url }) => {
    direct.push(url.href);
    return url.href === start ? new Response(null, { status: 302, headers: { location: target } })
      : new Response("page", { headers: { "content-type": "text/plain" } });
  });
  const fetchProxyPage = vi.fn<NonNullable<FetchUrlSessionDeps["fetchProxyPage"]>>(async (url) => ({
    body: Buffer.from("page"), contentType: "text/plain", finalUrl: url, status: 200
  }));
  const session = createFetchUrlSession({
    plan: { version: 1, userUrlDigests: [fetchUrlDigest(start)] }, scheduled: false,
    userId: "alice", proxyPlan: toProxyRunPlan([proxy])!, runProxies: runProxiesFromRows([proxy]), fetchProxyPage,
    fetchPage: (url, options) => fetchWebPage(url, { ...options, limits,
      lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }], dispatch }),
    extractPage: async () => ({ kind: "text", text: "page", title: null, truncated: false }), ...overrides
  });
  return { direct, dispatch, fetchProxyPage, session };
}

describe("automatic direct redirects and proxy hints", () => {
  it("does not redirect directly into a hinted site", async () => {
    const { direct, fetchProxyPage, session } = setup();
    const result = await session.execute(call(), { signal });
    expect(direct).toEqual([start]);
    expect(fetchProxyPage).toHaveBeenCalledWith(target, proxy, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ status: "complete", content: [{ value: { url: start, finalUrl: target, proxy: proxy.name } }],
      rawPreview: { fetchUrl: { proxy: { id: proxy.id, name: proxy.name } } } });
  });

  it("fails visibly when the redirect's matching proxy is unavailable", async () => {
    const { direct, fetchProxyPage, session } = setup({ runProxies: runProxiesFromRows([]) });
    const result = await session.execute(call(), { signal });
    expect(direct).toEqual([start]);
    expect(fetchProxyPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error", content: [{ value: { error: "proxy_all_failed" } }],
      rawPreview: { fetchUrl: { dispatched: true } } });
  });

  it("fails over on the hinted site and records the successful proxy", async () => {
    const { direct, fetchProxyPage, session } = setup({ proxyPlan: toProxyRunPlan([proxy, second])!, runProxies: runProxiesFromRows([proxy, second]) });
    fetchProxyPage.mockRejectedValueOnce(new WebFetchError("proxy_connect_failed", { dispatched: true }));
    const result = await session.execute(call(), { signal });
    expect(direct).toEqual([start]);
    expect(fetchProxyPage.mock.calls.map(([url, connection]) => [url, connection.id])).toEqual([[target, proxy.id], [target, second.id]]);
    expect(result).toMatchObject({ status: "complete", rawPreview: { fetchUrl: { proxy: { id: second.id, name: second.name } } } });
  });

  it("never goes direct with every matching proxy dead", async () => {
    const { direct, fetchProxyPage, session } = setup();
    fetchProxyPage.mockRejectedValue(new WebFetchError("proxy_connect_failed", { dispatched: true }));
    expect(await session.execute(call(), { signal })).toMatchObject({ status: "error", content: [{ value: { error: "proxy_all_failed" } }] });
    expect(fetchProxyPage).toHaveBeenCalledTimes(1);
    expect(direct).toEqual([start]);
  });

  it.each([true, false])("keeps explicit direct and automatic cached reads separate (direct first=%s)", async (directFirst) => {
    const { direct, fetchProxyPage, session } = setup();
    const explicit = async () => {
      const result = await session.execute(call("direct"), { signal });
      expect(result.rawPreview).toMatchObject({ fetchUrl: { outcome: "read" } });
      expect(result.rawPreview?.fetchUrl).not.toHaveProperty("proxy");
    };
    const automatic = async () => {
      expect(await session.execute(call(), { signal })).toMatchObject({ rawPreview: { fetchUrl: { proxy: { id: proxy.id } } } });
    };
    if (directFirst) { await explicit(); await automatic(); } else { await automatic(); await explicit(); }
    await explicit(); await automatic();
    expect(direct).toEqual(directFirst ? [start, target, start] : [start, start, target]);
    expect(fetchProxyPage).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce concurrent automatic and explicit direct reads", async () => {
    const { direct, fetchProxyPage, session } = setup();
    const [automatic, explicit] = await Promise.all([session.execute(call(), { signal }), session.execute(call("direct"), { signal })]);
    expect(automatic.rawPreview).toMatchObject({ fetchUrl: { proxy: { id: proxy.id } } });
    expect(explicit.rawPreview?.fetchUrl).not.toHaveProperty("proxy");
    expect(direct.filter((url) => url === target)).toHaveLength(1);
    expect(fetchProxyPage).toHaveBeenCalledTimes(1);
  });

  it("rechecks automatic redirects on recovery instead of reusing a stored explicit direct read", async () => {
    const live = setup();
    const result = await live.session.execute(call("direct"), { signal });
    const recovered = setup({ loadCalls: async () => [{ result }] });
    expect(await recovered.session.execute(call(), { signal })).toMatchObject({ rawPreview: { fetchUrl: { proxy: { id: proxy.id } } } });
    expect(recovered.direct).toEqual([start]);
    expect(recovered.fetchProxyPage).toHaveBeenCalledTimes(1);
  });

  it("checks every direct hop, keeping an unmatched redirect direct", async () => {
    const { direct, dispatch, fetchProxyPage, session } = setup();
    const middle = "https://another.example/link";
    dispatch.mockImplementation(async ({ url }) => {
      direct.push(url.href);
      return new Response(null, { status: 302, headers: { location: url.href === start ? middle : target } });
    });
    expect(await session.execute(call(), { signal })).toMatchObject({ status: "complete" });
    expect(direct).toEqual([start, middle]);
    expect(fetchProxyPage).toHaveBeenCalledWith(target, proxy, expect.anything());
  });

  it("never treats an invalid routing response as permission to go direct", async () => {
    const { direct, fetchProxyPage, session } = setup();
    fetchProxyPage.mockResolvedValue(undefined as never);
    expect(await session.execute(call(), { signal })).toMatchObject({ status: "error", content: [{ value: { error: "fetch_network_error" } }] });
    expect(direct).toEqual([start]);
  });

  it("does not reset the redirect limit after switching routes", async () => {
    const { direct, session, fetchProxyPage } = setup({}, { maxRedirects: 2 });
    const proxyHops: string[] = [];
    fetchProxyPage.mockImplementation(async (url, _connection, options) => fetchWebPage(url, { ...options,
      lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }], dispatch: async ({ url }) => {
        proxyHops.push(url.href);
        return new Response(null, { status: 302, headers: { location: "/again" } });
      } }));
    expect(await session.execute(call(), { signal })).toMatchObject({ status: "error", content: [{ value: { error: "fetch_redirect_limit" } }] });
    expect(direct).toEqual([start]);
    expect(proxyHops).toEqual([target, "https://shop.example.kz/again"]);
  });

  it("passes the remaining redirect allowance and original deadline to the proxy", async () => {
    const { session, fetchProxyPage } = setup({}, { maxRedirects: 2, deadlineMs: 100 });
    fetchProxyPage.mockImplementation(async (_url, _connection, options) => {
      expect(options.limits?.maxRedirects).toBe(1);
      expect(options.redirectRoute).toBeUndefined();
      return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    });
    expect(await session.execute(call(), { signal })).toMatchObject({ status: "error", content: [{ value: { error: "fetch_timeout" } }] });
  });
});
