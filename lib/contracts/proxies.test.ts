import { describe, expect, it } from "vitest";
import {
  isProxyCheckStatus,
  isProxyCountry,
  isProxyPort,
  isProxyProtocol,
  PROXY_ROUTES,
  toProxyRunPlan,
  type ProxyRunPlan,
  type ProxyRunPlanEntry,
  type ProxySharedWire,
  type ProxyWire
} from "./proxies";

const ENTRY: ProxyRunPlanEntry = {
  active: true,
  country: "KZ",
  domainHints: [".kz"],
  host: "proxy.example.com",
  id: "proxy-1",
  name: "Almaty",
  owner: "personal",
  port: 1080,
  protocol: "socks5"
};

// Compile-time proofs, checked by `tsc`: a read shape or a plan entry that
// gained a password stops compiling here.
const noPassword: {
  plan: "password" extends keyof ProxyRunPlanEntry ? never : true;
  shared: "password" extends keyof ProxySharedWire ? never : true;
  wire: "password" extends keyof ProxyWire ? never : true;
} = { plan: true, shared: true, wire: true };

describe("proxy contract", () => {
  it("has no password in its read shapes or plan", () => {
    expect(noPassword).toEqual({ plan: true, shared: true, wire: true });
  });

  it("copies a plan field by field, so a stored row's secret cannot ride along", () => {
    const row = { ...ENTRY, loginSealed: "sealed", password: "synthetic-secret", sealedPassword: "sealed" };
    const plan = toProxyRunPlan([row]) as ProxyRunPlan;
    expect(plan.entries).toEqual([ENTRY]);
    expect(JSON.stringify(plan)).not.toMatch(/password|sealed|synthetic-secret/iu);
    expect(plan.entries[0]!.domainHints).not.toBe(row.domainHints);
  });

  it("has no plan for a run without proxies", () => {
    expect(toProxyRunPlan([])).toBeNull();
  });

  it("recognizes its values", () => {
    expect(["http", "https", "socks5"].every(isProxyProtocol)).toBe(true);
    expect(isProxyProtocol("socks4")).toBe(false);
    expect([1, 8080, 65_535].every(isProxyPort)).toBe(true);
    expect([0, 65_536, 80.5, "80", null].some(isProxyPort)).toBe(false);
    expect(isProxyCountry("KZ")).toBe(true);
    expect(["kz", "KAZ", "", null].some(isProxyCountry)).toBe(false);
    expect(isProxyCheckStatus("ok")).toBe(true);
    expect(isProxyCheckStatus("proxy_auth_failed")).toBe(true);
    expect(isProxyCheckStatus("proxy_all_failed")).toBe(false);
  });

  it("encodes an id in its route paths", () => {
    expect(PROXY_ROUTES.personal).toBe("/api/me/proxies");
    expect(PROXY_ROUTES.personalItem("a/b")).toBe("/api/me/proxies/a%2Fb");
    expect(PROXY_ROUTES.personalCheck("p1")).toBe("/api/me/proxies/p1/check");
    expect(PROXY_ROUTES.administrator).toBe("/api/admin/proxies");
    expect(PROXY_ROUTES.administratorItem("p1")).toBe("/api/admin/proxies/p1");
    expect(PROXY_ROUTES.administratorCheck("p1")).toBe("/api/admin/proxies/p1/check");
  });
});
