import { describe, expect, it } from "vitest";
import {
  PROXY_ADDRESS_FAILURE_CODES,
  PROXY_CONNECTION_FAILURE_CODES,
  PROXY_INPUT_FAILURE_CODES,
  PROXY_SELECTION_FAILURE_CODES,
  PROXY_UNAVAILABLE_CODE,
  type ProxyRunPlanEntry
} from "@/lib/contracts/proxies";
import codes from "../observability/failureCodes.json";
import { runProxiesFromRows, runProxyConnectionsFromRows, type RunProxyRow } from "./runProxies";

function entry(id: string, overrides: Partial<ProxyRunPlanEntry> = {}): ProxyRunPlanEntry {
  return {
    active: true,
    country: null,
    domainHints: [".kz"],
    host: `${id}.example.com`,
    id,
    name: id.toUpperCase(),
    owner: "personal",
    port: 1080,
    protocol: "socks5",
    ...overrides
  };
}

function row(id: string, overrides: Partial<RunProxyRow> = {}): RunProxyRow {
  return {
    active: true,
    host: `${id}.example.com`,
    id,
    login: "synthetic-login",
    password: "synthetic-password",
    port: 1080,
    protocol: "socks5",
    ...overrides
  };
}

describe("proxy failure codes", () => {
  it("registers every stable code of the contract as loggable", () => {
    const registered = new Set<string>(codes);
    const missing = [
      ...PROXY_ADDRESS_FAILURE_CODES,
      ...PROXY_CONNECTION_FAILURE_CODES,
      ...PROXY_INPUT_FAILURE_CODES,
      ...PROXY_SELECTION_FAILURE_CODES,
      PROXY_UNAVAILABLE_CODE
    ].filter((code) => !registered.has(code));
    expect(missing).toEqual([]);
  });
});

describe("a run's proxies with credentials", () => {
  it("returns credentials for the plan's proxies, in plan order", () => {
    const { connections, unavailable } = runProxyConnectionsFromRows(
      { entries: [entry("b"), entry("a")] },
      [row("a"), row("b", { login: null, password: null }), row("not-in-plan")]
    );
    expect(connections.map((connection) => connection.id)).toEqual(["b", "a"]);
    expect(connections[0]).toMatchObject({ login: null, password: null });
    expect(connections[1]).toMatchObject({ domainHints: [".kz"], login: "synthetic-login", password: "synthetic-password" });
    expect(unavailable).toEqual([]);
  });

  it.each([
    ["deleted", null],
    ["switched off", row("a", { active: false })],
    ["moved to another host", row("a", { host: "elsewhere.example.com" })],
    ["moved to another port", row("a", { port: 8080 })],
    ["moved to another protocol", row("a", { protocol: "http" })]
  ] as const)("never returns a password for a proxy %s since admission", (_label, current) => {
    const result = runProxyConnectionsFromRows({ entries: [entry("a")] }, current ? [current] : []);
    expect(result.connections).toEqual([]);
    expect(result.unavailable).toEqual([{ code: "proxy_unavailable", id: "a", name: "A" }]);
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
  });

  it("uses a password replaced on the same endpoint", () => {
    const { connections } = runProxyConnectionsFromRows({ entries: [entry("a")] }, [row("a", { password: "replaced" })]);
    expect(connections[0]!.password).toBe("replaced");
  });

  it("loads nothing for a proxy that was off at admission, even if it is on now", () => {
    const result = runProxyConnectionsFromRows({ entries: [entry("a", { active: false })] }, [row("a")]);
    expect(result).toEqual({ connections: [], unavailable: [] });
  });

  it("has an implementation a test can hand to a consumer", async () => {
    const proxies = runProxiesFromRows([row("a")]);
    const result = await proxies.load({ plan: { entries: [entry("a"), entry("b")] }, userId: "user-1" });
    expect(result.connections.map((connection) => connection.id)).toEqual(["a"]);
    expect(result.unavailable.map((item) => item.id)).toEqual(["b"]);
  });
});
