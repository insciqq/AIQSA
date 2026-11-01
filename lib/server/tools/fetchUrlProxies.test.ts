import { describe, expect, it, vi } from "vitest";
import { FETCH_URL_PROXY_FAILURE_CODES } from "../../contracts/fetchUrlActivity";
import { PROXY_BLOCKED_HTTP_STATUSES, toProxyRunPlan } from "../../contracts/proxies";
import { runProxiesFromRows } from "../proxies/runProxies";
import { proxyConnection } from "../webFetch/proxy.testFixtures";
import { WebFetchError, type WebFetchResponse } from "../webFetch/transport";
import { fetchUrlDigest } from "../webFetch/urls";
import { createFetchUrlSession, fetchUrlActivityFacts, type FetchUrlSessionDeps } from "./fetchUrl";
import type { ToolExecutionResult } from "./types";

const signal = new AbortController().signal;
const url = "http://example.com/page";
const one = proxyConnection(8080);
const two = proxyConnection(8081, "socks5", "proxy-two");
const call = (target = url, proxy?: unknown) => ({ arguments: { url: target, ...(proxy !== undefined ? { proxy } : {}) }, id: "call", name: "fetch_url" });
const page = (text = "synthetic text"): WebFetchResponse => ({ body: Buffer.from(text), contentType: "text/plain", finalUrl: url, status: 200 });
const json = (result: ToolExecutionResult) => {
  const content = result.content[0];
  if (content?.type !== "json") throw new Error("synthetic_missing_json");
  return content.value as Record<string, unknown>;
};

function session(overrides: Partial<FetchUrlSessionDeps> = {}) {
  const fetchPage = vi.fn(async () => page("direct"));
  const fetchProxyPage = vi.fn<NonNullable<FetchUrlSessionDeps["fetchProxyPage"]>>(async (_url, connection) => page(connection.name));
  const observeProxy = vi.fn();
  const runProxies = { load: vi.fn(runProxiesFromRows([one, two]).load) };
  const deps: FetchUrlSessionDeps = {
    plan: { userUrlDigests: [url, "http://example.com/next", "http://sub.example.com/page", "http://other.org/"].map(fetchUrlDigest), version: 1 },
    proxyPlan: toProxyRunPlan([one, two])!, runProxies, userId: "synthetic-owner", scheduled: false,
    fetchPage, fetchProxyPage, observeProxy,
    extractPage: async ({ body }) => ({ kind: "text", text: Buffer.from(body).toString(), title: null, truncated: false }),
    ...overrides
  };
  return { ...createFetchUrlSession(deps), fetchPage, fetchProxyPage, observeProxy, runProxies };
}

describe("fetch_url proxy selection in one answer", () => {
  it("uses hints and keeps a site on its proxy across agents and pages", async () => {
    const reader = session();
    for (const target of [url, "http://example.com/next", "http://sub.example.com/page"]) {
      expect(json(await reader.execute(call(target), { signal })).proxy).toBe(one.name);
    }
    expect(reader.fetchPage).not.toHaveBeenCalled();
    expect(reader.fetchProxyPage.mock.calls.map((args) => args[1].id)).toEqual([one.id, one.id, one.id]);
    expect(reader.runProxies.load).toHaveBeenCalledWith({ plan: toProxyRunPlan([one, two]), userId: "synthetic-owner" });
  });

  it("allows explicit direct or a name to override hints, and unmatched sites go direct", async () => {
    const reader = session();
    expect(json(await reader.execute(call(url, "direct"), { signal })).text).toBe("direct");
    expect(json(await reader.execute(call(url, two.name), { signal })).text).toBe(two.name);
    expect(json(await reader.execute(call("http://other.org/"), { signal })).text).toBe("direct");
    expect(json(await reader.execute(call("http://other.org/", one.name), { signal })).text).toBe(one.name);
    expect(reader.fetchPage).toHaveBeenCalledTimes(2);
    expect(reader.fetchProxyPage).toHaveBeenCalledTimes(2);
  });

  it("leaves absent arguments and legacy direct results byte-compatible", async () => {
    const reader = session({ proxyPlan: undefined, runProxies: undefined });
    const input = call();
    const before = JSON.stringify(input);
    const result = await reader.execute(input, { signal });
    expect(JSON.stringify(input)).toBe(before);
    expect(result.rawPreview).toEqual({ fetchUrl: { version: 1, outcome: "read", dispatched: true, url } });
    expect(json(result)).not.toHaveProperty("proxy");
    expect(reader.fetchProxyPage).not.toHaveBeenCalled();
  });

  it("moves on after a failed proxy and keeps the successful proxy for the site", async () => {
    const reader = session();
    reader.fetchProxyPage.mockImplementation(async (_url, connection) => {
      if (connection.id === one.id) throw new WebFetchError("proxy_connect_failed", { dispatched: true });
      return page(connection.name);
    });
    expect(json(await reader.execute(call(), { signal })).proxy).toBe(two.name);
    expect(json(await reader.execute(call("http://example.com/next"), { signal })).proxy).toBe(two.name);
    expect(reader.fetchProxyPage.mock.calls.map((args) => args[1].id)).toEqual([one.id, two.id, two.id]);
    expect(reader.fetchPage).not.toHaveBeenCalled();
  });

  it("fails visibly with none left and never goes direct, including on another call", async () => {
    const reader = session();
    reader.fetchProxyPage.mockRejectedValue(new WebFetchError("proxy_connect_failed", { dispatched: true }));
    const result = await reader.execute(call(), { signal });
    expect(json(result).error).toBe("proxy_all_failed");
    expect(fetchUrlActivityFacts("fetch_url", call().arguments, result)).toMatchObject({ fetchProxyCode: "proxy_all_failed" });
    expect(json(await reader.execute(call("http://example.com/next"), { signal })).error).toBe("proxy_all_failed");
    expect(reader.fetchProxyPage).toHaveBeenCalledTimes(4);
    expect(reader.fetchPage).not.toHaveBeenCalled();
  });

  it("never replaces an explicitly named failed proxy or changes the site's implicit selection", async () => {
    const reader = session();
    reader.fetchProxyPage.mockRejectedValueOnce(new WebFetchError("proxy_auth_failed", { dispatched: true }));
    expect(json(await reader.execute(call(url, two.name), { signal }))).toMatchObject({ error: "proxy_auth_failed", proxy: two.name });
    expect(reader.fetchProxyPage).toHaveBeenCalledTimes(1);
    expect(json(await reader.execute(call(), { signal })).proxy).toBe(one.name);
    expect(reader.fetchPage).not.toHaveBeenCalled();
  });

  it("treats unavailable plan entries as failed for each site", async () => {
    const entries = [{ ...one, domainHints: [".com", ".org"] }, { ...two, domainHints: [".com"] }];
    const reader = session({ proxyPlan: toProxyRunPlan(entries)!, runProxies: runProxiesFromRows([two]) });
    expect(json(await reader.execute(call(), { signal })).proxy).toBe(two.name);
    expect(json(await reader.execute(call("http://other.org/"), { signal })).error).toBe("proxy_all_failed");
    expect(json(await reader.execute(call(url, one.name), { signal })).error).toBe("proxy_unavailable");
    expect(reader.fetchProxyPage).toHaveBeenCalledTimes(1);
    expect(reader.fetchPage).not.toHaveBeenCalled();
  });

  it("fails closed when credentials cannot be loaded, without leaking store errors", async () => {
    const reader = session({ runProxies: { load: async () => { throw new Error("synthetic-password-:/@?"); } } });
    const result = await reader.execute(call(), { signal });
    expect(json(result).error).toBe("proxy_all_failed");
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
    expect(reader.fetchPage).not.toHaveBeenCalled();
  });

  it.each(FETCH_URL_PROXY_FAILURE_CODES)("keeps address and login out of failure text for %s", async (code) => {
    const reader = session(code === "proxy_inactive" ? { proxyPlan: toProxyRunPlan([{ ...one, active: false }])! }
      : code === "proxy_unavailable" ? { runProxies: runProxiesFromRows([]) } : {});
    if (code === "proxy_all_failed") reader.fetchProxyPage.mockRejectedValue(new WebFetchError("proxy_connect_failed", { dispatched: true }));
    else if (code !== "proxy_inactive" && code !== "proxy_unavailable" && code !== "proxy_not_found") {
      reader.fetchProxyPage.mockRejectedValue(new WebFetchError(code, { dispatched: true }));
    }
    const result = json(await reader.execute(call(url, code === "proxy_all_failed" ? undefined : code === "proxy_not_found" ? "missing" : one.name), { signal }));
    expect(result.error).toBe(code);
    expect(String(result.message)).toContain(code);
    for (const secret of [one.host, one.login!, one.password!, `${one.login}:${one.password}@${one.host}`]) {
      expect(String(result.message)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("never widens link authority and validates explicit choices before credentials load", async () => {
    const reader = session();
    expect(json(await reader.execute(call("http://unknown.example/", one.name), { signal })).error).toBe("fetch_url_not_in_conversation");
    for (const choice of [null, 1, {}, "", "x".repeat(65), "bad\nname"]) {
      expect(json(await reader.execute(call(url, choice), { signal })).error).toBe("fetch_url_invalid");
    }
    expect(reader.runProxies.load).not.toHaveBeenCalled();
    expect(reader.fetchPage).not.toHaveBeenCalled();
    expect(reader.fetchProxyPage).not.toHaveBeenCalled();
  });

  it.each(PROXY_BLOCKED_HTTP_STATUSES)("names proxies before the browser step after HTTP %i, without rotation", async (httpStatus) => {
    const reader = session({ browserStep: () => "user" });
    reader.fetchProxyPage.mockRejectedValue(new WebFetchError("fetch_http_status", { dispatched: true, httpStatus }));
    const result = json(await reader.execute(call(), { signal }));
    const message = String(result.message);
    expect(message.indexOf(one.name)).toBeGreaterThan(-1);
    expect(message.indexOf(two.name)).toBeLessThan(message.indexOf("Workspace browser"));
    await reader.execute(call("http://example.com/next"), { signal });
    expect(reader.fetchProxyPage.mock.calls.map((args) => args[1].id)).toEqual([one.id, one.id]);
  });

  it("separates cached and concurrent reads by the actual proxy; explicit and implicit same-proxy reads coalesce", async () => {
    const reader = session();
    const [direct, first, same, second] = await Promise.all([
      reader.execute(call(url, "direct"), { signal }), reader.execute(call(), { signal }),
      reader.execute(call(url, one.name), { signal }), reader.execute(call(url, two.name), { signal })
    ]);
    expect([direct, first, same, second].map((result) => json(result).text)).toEqual(["direct", one.name, one.name, two.name]);
    expect(reader.fetchProxyPage).toHaveBeenCalledTimes(2);
    expect(reader.fetchPage).toHaveBeenCalledTimes(1);
    for (const choice of ["direct", one.name, two.name]) expect(json(await reader.execute(call(url, choice), { signal })).cached).toBe(true);
  });

  it("recovers direct and proxy caches separately, retaining only id and name", async () => {
    const live = session();
    const direct = await live.execute(call(url, "direct"), { signal });
    const proxied = await live.execute(call(url, one.name), { signal });
    const recovered = session({ loadCalls: async () => [{ result: direct }, { result: proxied }] });
    expect(json(await recovered.execute(call(url, "direct"), { signal }))).toMatchObject({ cached: true, text: "direct" });
    expect(json(await recovered.execute(call(), { signal }))).toMatchObject({ cached: true, text: one.name });
    expect(recovered.fetchProxyPage).not.toHaveBeenCalled();
    expect(recovered.fetchPage).not.toHaveBeenCalled();
    expect(JSON.stringify([proxied, recovered.observeProxy.mock.calls])).not.toMatch(/synthetic-password|synthetic-user|proxy\.example\.net/u);
  });
});
