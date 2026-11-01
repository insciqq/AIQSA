// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { fakeProxyDb } from "./fakeProxyDb.testFixtures";
import type { ProxyProbe } from "./probe";
import { ADMINISTRATOR_PROXY_SCOPE, createPrismaRunProxies, createProxyRunPlanner, createProxyStore, personalProxyScope, type ProxyStoreOptions } from "./store";
import { ProxyError } from "./validation";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const ALICE = personalProxyScope("alice");
const BOB = personalProxyScope("bob");
const PASSWORD = "synthetic-proxy-pass-0001";
const INPUT = { domainHints: [".kz"], host: "proxy.example.com", login: "bob", name: "Almaty", password: PASSWORD, port: 1080, protocol: "socks5" };
const key = () => Buffer.alloc(32, 7);
const passing: NonNullable<ProxyStoreOptions["checkAddress"]> = async ({ host, port }) =>
  ({ host: String(host), ok: true, pinned: { address: "203.0.113.9", family: 4 }, port: Number(port) });

function setup(options: ProxyStoreOptions = {}) {
  const fake = fakeProxyDb({ activeUsers: ["alice", "bob"] });
  const probe = vi.fn<ProxyProbe>(async () => ({ exitAddress: "198.51.100.7", ok: true }));
  const store = createProxyStore(fake.db, { checkAddress: passing, key, now: () => new Date("2026-11-01T10:00:00.000Z"), probe, ...options });
  return { ...fake, probe, store };
}

const codeOf = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    return error instanceof ProxyError ? error.code : "other";
  }
  return "none";
};

describe("proxy store", () => {
  it("seals the password and returns no form of it", async () => {
    const { rows, store } = setup();
    const proxy = await store.create(ALICE, INPUT);
    expect(proxy).toMatchObject({ hasPassword: true, login: "bob", owner: "personal", version: 1 });
    expect(JSON.stringify(proxy)).not.toMatch(/synthetic-proxy-pass|envelope/iu);
    expect(rows[0]!.passwordEnvelope).toMatch(/^v2\./u);
    expect(rows[0]!.passwordEnvelope).not.toContain(PASSWORD);
    expect(JSON.stringify(await store.listPersonal("alice"))).not.toMatch(/synthetic-proxy-pass|envelope/iu);
  });

  it("runs the address rule before saving, and only when the endpoint changes", async () => {
    const checkAddress = vi.fn(passing);
    const { rows, store } = setup({ checkAddress });
    const proxy = await store.create(ALICE, INPUT);
    expect(checkAddress).toHaveBeenCalledTimes(1);
    await store.update(ALICE, proxy.id, { expectedVersion: 1, name: "Renamed" });
    expect(checkAddress).toHaveBeenCalledTimes(1);
    await store.update(ALICE, proxy.id, { expectedVersion: 2, port: 1081 });
    expect(checkAddress).toHaveBeenLastCalledWith({ host: "proxy.example.com", port: 1081 }, {});
    checkAddress.mockResolvedValueOnce({ code: "proxy_address_forbidden", ok: false });
    expect(await codeOf(store.create(ALICE, { ...INPUT, name: "Internal" }))).toBe("proxy_address_forbidden");
    checkAddress.mockResolvedValueOnce({ code: "proxy_address_forbidden", ok: false });
    expect(await codeOf(store.update(ALICE, proxy.id, { expectedVersion: 3, host: "internal.example.com" }))).toBe("proxy_address_forbidden");
    expect(rows.map((row) => [row.name, row.host, row.version])).toEqual([["Renamed", "proxy.example.com", 3]]);
  });

  it("answers another user's proxy, the other audience's and a missing one alike", async () => {
    const { store } = setup();
    const own = await store.create(ALICE, INPUT);
    const shared = await store.create(ADMINISTRATOR_PROXY_SCOPE, INPUT);
    for (const [scope, id] of [[BOB, own.id], [ALICE, shared.id], [ADMINISTRATOR_PROXY_SCOPE, own.id], [BOB, "missing"]] as const) {
      expect(await codeOf(store.update(scope, id, { expectedVersion: 1, name: "Taken over" }))).toBe("proxy_not_found");
      expect(await codeOf(store.remove(scope, id, 1))).toBe("proxy_not_found");
      expect(await codeOf(store.check(scope, id))).toBe("proxy_not_found");
    }
    expect((await store.listPersonal("bob")).proxies).toEqual([]);
  });

  it("shows a member an administrator's proxy without its address, login or check", async () => {
    const { store } = setup();
    const shared = await store.create(ADMINISTRATOR_PROXY_SCOPE, { ...INPUT, country: "KZ" });
    await store.check(ADMINISTRATOR_PROXY_SCOPE, shared.id);
    const member = await store.listPersonal("bob");
    expect(member.proxies).toEqual([]);
    expect(member.shared).toEqual([{ active: true, country: "KZ", domainHints: [".kz"], id: shared.id, name: "Almaty", owner: "administrator", protocol: "socks5" }]);
    expect(await store.listAdministrator()).toMatchObject([{ host: "proxy.example.com", lastCheck: { status: "ok" }, login: "bob", owner: "administrator" }]);
  });

  it("guards a change with the version, and leaves an unchanged one at it", async () => {
    const { store } = setup();
    const proxy = await store.create(ALICE, INPUT);
    expect(await store.update(ALICE, proxy.id, { expectedVersion: 1, name: "Almaty" })).toMatchObject({ version: 1 });
    expect(await store.update(ALICE, proxy.id, { active: false, expectedVersion: 1 })).toMatchObject({ active: false, version: 2 });
    expect(await codeOf(store.update(ALICE, proxy.id, { active: true, expectedVersion: 1 }))).toBe("proxy_conflict");
    expect(await codeOf(store.remove(ALICE, proxy.id, 1))).toBe("proxy_conflict");
    await store.remove(ALICE, proxy.id, 2);
    expect((await store.listPersonal("alice")).proxies).toEqual([]);
  });

  it("keeps a password when absent, replaces it when given, removes it on null", async () => {
    const { rows, store } = setup();
    const proxy = await store.create(ALICE, INPUT);
    const sealed = rows[0]!.passwordEnvelope;
    await store.update(ALICE, proxy.id, { expectedVersion: 1, name: "Renamed" });
    expect(rows[0]!.passwordEnvelope).toBe(sealed);
    await store.update(ALICE, proxy.id, { expectedVersion: 2, password: "synthetic-proxy-pass-0002" });
    expect(rows[0]!.passwordEnvelope).not.toBe(sealed);
    expect(await codeOf(store.update(ALICE, proxy.id, { expectedVersion: 3, login: null }))).toBe("proxy_login_invalid");
    expect(await store.update(ALICE, proxy.id, { expectedVersion: 3, login: null, password: null })).toMatchObject({ hasPassword: false, login: null });
    expect(rows[0]!.passwordEnvelope).toBeNull();
  });

  it("refuses a name its owner holds in any case, while another owner may use it", async () => {
    const { store } = setup();
    const first = await store.create(ALICE, INPUT);
    expect(await codeOf(store.create(ALICE, { ...INPUT, name: "ALMATY" }))).toBe("proxy_name_taken");
    await store.create(BOB, INPUT);
    await store.create(ADMINISTRATOR_PROXY_SCOPE, INPUT);
    const second = await store.create(ALICE, { ...INPUT, name: "Astana" });
    expect(await codeOf(store.update(ALICE, second.id, { expectedVersion: 1, name: "almaty" }))).toBe("proxy_name_taken");
    expect(await store.update(ALICE, first.id, { expectedVersion: 1, name: "ALMATY" })).toMatchObject({ name: "ALMATY" });
  });

  it("holds each owner to the limit", async () => {
    const { store } = setup();
    for (let index = 0; index < 50; index += 1) await store.create(ALICE, { ...INPUT, name: `Proxy ${index}` });
    expect(await codeOf(store.create(ALICE, { ...INPUT, name: "One more" }))).toBe("proxy_limit");
    await store.create(BOB, INPUT);
  });

  it("refuses a change from an inactive owner", async () => {
    const { store } = setup();
    expect(await codeOf(store.create(personalProxyScope("gone"), INPUT))).toBe("proxy_unavailable");
  });
});

describe("proxy check", () => {
  it("runs the address rule first, gives the probe the pinned address, and records the result without moving the version", async () => {
    const order: string[] = [];
    const probe = vi.fn<ProxyProbe>(async () => {
      order.push("probe");
      return { exitAddress: "198.51.100.7", ok: true };
    });
    const { store } = setup({ checkAddress: async (target) => {
      order.push("address");
      return passing(target);
    }, probe });
    const proxy = await store.create(ALICE, INPUT);
    order.length = 0;
    const result = await store.check(ALICE, proxy.id);
    expect(order).toEqual(["address", "probe"]);
    expect(probe.mock.calls[0]![0]).toEqual({ host: "proxy.example.com", login: "bob", password: PASSWORD, pinned: { address: "203.0.113.9", family: 4 }, port: 1080, protocol: "socks5" });
    expect(result.check).toEqual({ checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: "198.51.100.7", status: "ok" });
    expect(result.proxy).toMatchObject({ lastCheck: result.check, version: 1 });
  });

  it("never reaches a refused endpoint, and records why", async () => {
    const checkAddress = vi.fn(passing);
    const { probe, rows, store } = setup({ checkAddress });
    const proxy = await store.create(ALICE, INPUT);
    checkAddress.mockResolvedValueOnce({ code: "proxy_address_forbidden", ok: false });
    expect((await store.check(ALICE, proxy.id)).check).toMatchObject({ exitAddress: null, status: "proxy_address_forbidden" });
    expect(probe).not.toHaveBeenCalled();
    expect(rows[0]!.lastCheckStatus).toBe("proxy_address_forbidden");
  });

  it.each([
    ["a stable code from the probe", async () => ({ code: "proxy_auth_failed", ok: false }), "proxy_auth_failed"],
    ["an address that is none", async () => ({ exitAddress: "<script>", ok: true }), "proxy_protocol_error"],
    ["an address with a zone id", async () => ({ exitAddress: "fe80::1%eth0", ok: true }), "proxy_protocol_error"],
    ["a probe that throws", async () => {
      throw new Error("synthetic");
    }, "proxy_connect_failed"]
  ] as const)("reads %s as a failed check", async (_label, probe, status) => {
    const { store } = setup({ probe: probe as never });
    const proxy = await store.create(ALICE, INPUT);
    expect((await store.check(ALICE, proxy.id)).check).toMatchObject({ exitAddress: null, status });
  });

  it("does not record a result that lost a race with a change", async () => {
    const changed = { version: () => undefined as void };
    const { rows, store } = setup({ probe: async () => {
      changed.version();
      return { exitAddress: "198.51.100.7", ok: true };
    } });
    const proxy = await store.create(ALICE, INPUT);
    changed.version = () => {
      rows[0]!.version = 2;
    };
    expect((await store.check(ALICE, proxy.id)).check.status).toBe("ok");
    expect(rows[0]!.lastCheckStatus).toBeNull();
  });

  it("keeps the caller's own cancellation", async () => {
    const controller = new AbortController();
    const { store } = setup({ probe: async () => {
      controller.abort(new Error("stopped"));
      throw new Error("aborted");
    } });
    const proxy = await store.create(ALICE, INPUT);
    await expect(store.check(ALICE, proxy.id, controller.signal)).rejects.toThrow("aborted");
  });

  it("is unavailable when the sealed password cannot be read, and sends nothing", async () => {
    const { probe, rows, store } = setup();
    const proxy = await store.create(ALICE, INPUT);
    rows[0]!.passwordEnvelope = "v2.bad.bad.bad";
    expect(await codeOf(store.check(ALICE, proxy.id))).toBe("proxy_unavailable");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("run proxies", () => {
  it("freezes the user's own first, switched-off ones too, with no password, and no plan without any", async () => {
    const { db, store } = setup();
    const planner = createProxyRunPlanner(db);
    expect(await planner.planForRun("alice")).toBeNull();
    await store.create(ADMINISTRATOR_PROXY_SCOPE, { ...INPUT, name: "Shared" });
    await store.create(BOB, { ...INPUT, name: "Bobs" });
    await store.create(ALICE, { ...INPUT, active: false, name: "Mine" });
    const plan = await planner.planForRun("alice");
    expect(plan?.entries.map((entry) => [entry.name, entry.owner, entry.active])).toEqual([["Mine", "personal", false], ["Shared", "administrator", true]]);
    expect(JSON.stringify(plan)).not.toMatch(/password|envelope|login|synthetic-proxy-pass|lastCheck/iu);
  });

  it("opens the password for the plan's user, and counts another user's proxy as missing", async () => {
    const { db, rows, store } = setup();
    const own = await store.create(ALICE, { ...INPUT, name: "Mine" });
    const shared = await store.create(ADMINISTRATOR_PROXY_SCOPE, { ...INPUT, name: "Shared" });
    const plan = await createProxyRunPlanner(db).planForRun("alice");
    const proxies = createPrismaRunProxies(db, { key });
    expect(await proxies.load({ plan: plan!, userId: "alice" })).toMatchObject({
      connections: [{ id: own.id, login: "bob", password: PASSWORD }, { id: shared.id, password: PASSWORD }], unavailable: [] });
    expect(await proxies.load({ plan: plan!, userId: "bob" })).toMatchObject({
      connections: [{ id: shared.id }], unavailable: [{ code: "proxy_unavailable", id: own.id }] });
    rows[0]!.host = "moved.example.com";
    expect((await proxies.load({ plan: plan!, userId: "alice" })).unavailable).toMatchObject([{ id: own.id }]);
  });

  it("makes a proxy unavailable when its password cannot be opened, never sent without one", async () => {
    const { db, rows, store } = setup();
    const own = await store.create(ALICE, INPUT);
    const plan = await createProxyRunPlanner(db).planForRun("alice");
    rows[0]!.passwordEnvelope = "v2.bad.bad.bad";
    expect(await createPrismaRunProxies(db, { key }).load({ plan: plan!, userId: "alice" }))
      .toEqual({ connections: [], unavailable: [{ code: "proxy_unavailable", id: own.id, name: "Almaty" }] });
  });

  it("binds a sealed password to its row", async () => {
    const { db, rows, store } = setup();
    await store.create(ALICE, { ...INPUT, name: "First" });
    const second = await store.create(ALICE, { ...INPUT, name: "Second" });
    const plan = await createProxyRunPlanner(db).planForRun("alice");
    rows[1]!.passwordEnvelope = rows[0]!.passwordEnvelope;
    expect((await createPrismaRunProxies(db, { key }).load({ plan: plan!, userId: "alice" })).unavailable).toMatchObject([{ id: second.id }]);
  });
});
