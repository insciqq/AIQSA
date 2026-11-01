import { describe, expect, it } from "vitest";
import { decodeFetchUrlActivity, FETCH_URL_PROXY_FAILURE_CODES } from "./fetchUrlActivity";

describe("page-reading activity facts", () => {
  it("keeps legacy rows and only the display name and stable proxy code from new rows", () => {
    const legacy = { fetchOutcome: "read", fetchTarget: "news.example/page", origin: "web_fetch" };
    expect(decodeFetchUrlActivity(legacy)).toEqual({ fetchOutcome: "read", fetchTarget: "news.example/page" });
    const fields = { ...legacy, fetchOutcome: "fetch_network_error", fetchProxyName: "My connection", fetchProxyCode: "proxy_auth_failed" };
    expect(decodeFetchUrlActivity({ ...fields, host: "PRIVATE_HOST", address: "PRIVATE_ADDRESS", login: "PRIVATE_LOGIN",
      password: "PRIVATE_PASSWORD", proxy: { password: "PRIVATE_PASSWORD" } })).toEqual({
      fetchOutcome: "fetch_network_error", fetchTarget: "news.example/page", fetchProxyName: "My connection", fetchProxyCode: "proxy_auth_failed"
    });
    expect(decodeFetchUrlActivity({ ...fields, origin: "mcp" })).toEqual({});
  });

  it.each(FETCH_URL_PROXY_FAILURE_CODES)("accepts the stable proxy reason %s", (fetchProxyCode) => {
    expect(decodeFetchUrlActivity({ origin: "web_fetch", fetchProxyCode })).toEqual({ fetchProxyCode });
  });

  it("drops malformed names and codes rather than interpreting arbitrary text", () => {
    for (const fetchProxyName of [null, 1, {}, "", " ", "x".repeat(65), "bad\nname", "bad\0name"]) {
      expect(decodeFetchUrlActivity({ origin: "web_fetch", fetchProxyName, fetchProxyCode: "PRIVATE_CODE" })).toEqual({});
    }
    // A display name is user text, not markup; rendering owns escaping it.
    expect(decodeFetchUrlActivity({ origin: "web_fetch", fetchProxyName: "<b>Mine</b>" })).toEqual({ fetchProxyName: "<b>Mine</b>" });
  });
});
