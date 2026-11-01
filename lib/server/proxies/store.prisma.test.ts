// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/server/prisma";
import { executeManageProxy } from "../tools/manageProxy";
import type { SelfServiceCallStore } from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import { createAgentProxyService } from "./agentProxies";
import type { ProxyProbe } from "./probe";
import { ADMINISTRATOR_PROXY_SCOPE, createPrismaRunProxies, createProxyRunPlanner, createProxyStore, personalProxyScope, type ProxyStoreOptions } from "./store";
import { ProxyError } from "./validation";

const key = () => Buffer.alloc(32, 41);
const PASSWORD = "synthetic-proxy-pass-0001";
const users: string[] = [];
const administratorProxies: string[] = [];
const probe: ProxyProbe = async () => ({ exitAddress: "198.51.100.7", ok: true });
const options: ProxyStoreOptions = {
  checkAddress: async ({ host, port }) => ({ host: String(host), ok: true, pinned: { address: "203.0.113.9", family: 4 }, port: Number(port) }),
  key,
  probe
};
const store = createProxyStore(prisma, options);
const input = (name = `Proxy ${randomUUID()}`) => ({ domainHints: [".kz"], host: "proxy.example.com", login: "bob", name, password: PASSWORD, port: 1080, protocol: "socks5" });

async function owner(): Promise<string> {
  const id = `network-proxy-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic proxies", id, status: "active" } });
  users.push(id);
  return id;
}

async function administratorProxy(overrides: Record<string, unknown> = {}) {
  const proxy = await store.create(ADMINISTRATOR_PROXY_SCOPE, { ...input(), ...overrides });
  administratorProxies.push(proxy.id);
  return proxy;
}

const codeOf = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    return error instanceof ProxyError ? error.code : "other";
  }
  return "none";
};

afterAll(async () => {
  await prisma.networkProxy.deleteMany({ where: { id: { in: administratorProxies } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

describe("proxy store on PostgreSQL", () => {
  it("keeps one user's proxy from another, who gets what a missing proxy gets", async () => {
    const [alice, bob] = [await owner(), await owner()];
    const own = await store.create(personalProxyScope(alice), input());
    const bobScope = personalProxyScope(bob);
    expect((await store.listPersonal(bob)).proxies).toEqual([]);
    expect(JSON.stringify(await store.listPersonal(bob))).not.toContain(own.id);
    for (const id of [own.id, randomUUID()]) {
      expect(await codeOf(store.update(bobScope, id, { expectedVersion: 1, name: "Taken" }))).toBe("proxy_not_found");
      expect(await codeOf(store.remove(bobScope, id, 1))).toBe("proxy_not_found");
      expect(await codeOf(store.check(bobScope, id))).toBe("proxy_not_found");
    }
    expect(await codeOf(store.update(ADMINISTRATOR_PROXY_SCOPE, own.id, { expectedVersion: 1, name: "Taken" }))).toBe("proxy_not_found");
    expect(await prisma.networkProxy.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ name: own.name, userId: alice, version: 1 });
  });

  it("gives a run another user's proxy as missing, whatever its plan says", async () => {
    const [alice, bob] = [await owner(), await owner()];
    const own = await store.create(personalProxyScope(alice), input());
    const shared = await administratorProxy();
    const planner = createProxyRunPlanner(prisma);
    const plan = await planner.planForRun(alice);
    expect(plan?.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([own.id, shared.id]));
    expect(plan?.entries.findIndex((entry) => entry.id === own.id)).toBe(0);
    expect((await planner.planForRun(bob))?.entries.map((entry) => entry.id)).not.toContain(own.id);
    expect(JSON.stringify(plan)).not.toMatch(/synthetic-proxy-pass|envelope|"login"/u);
    const proxies = createPrismaRunProxies(prisma, { key });
    const foreign = await proxies.load({ plan: plan!, userId: bob });
    expect(foreign.unavailable).toContainEqual({ code: "proxy_unavailable", id: own.id, name: own.name });
    expect(foreign.connections.map((connection) => connection.id)).not.toContain(own.id);
    const mine = await proxies.load({ plan: plan!, userId: alice });
    expect(mine.connections.find((connection) => connection.id === own.id)).toMatchObject({ login: "bob", password: PASSWORD });
    expect(mine.connections.find((connection) => connection.id === shared.id)).toMatchObject({ password: PASSWORD });
  });

  it("makes a run's proxy unavailable once it is deleted, switched off or moved, and takes a new password", async () => {
    const alice = await owner();
    const scope = personalProxyScope(alice);
    const moved = await store.create(scope, input());
    const off = await store.create(scope, input());
    const gone = await store.create(scope, input());
    const renewed = await store.create(scope, input());
    const plan = (await createProxyRunPlanner(prisma).planForRun(alice))!;
    await store.update(scope, moved.id, { expectedVersion: 1, host: "moved.example.com" });
    await store.update(scope, off.id, { active: false, expectedVersion: 1 });
    await store.remove(scope, gone.id, 1);
    await store.update(scope, renewed.id, { expectedVersion: 1, password: "synthetic-proxy-pass-0002" });
    const loaded = await createPrismaRunProxies(prisma, { key }).load({ plan, userId: alice });
    expect(loaded.unavailable.map((entry) => entry.id)).toEqual(expect.arrayContaining([moved.id, off.id, gone.id]));
    expect(loaded.connections.find((connection) => connection.id === renewed.id)).toMatchObject({ password: "synthetic-proxy-pass-0002" });
  });

  it("removes a user's proxies with the user and leaves an administrator's", async () => {
    const alice = await owner();
    const own = await store.create(personalProxyScope(alice), input());
    const shared = await administratorProxy();
    await prisma.user.delete({ where: { id: alice } });
    expect(await prisma.networkProxy.findUnique({ where: { id: own.id } })).toBeNull();
    expect(await prisma.networkProxy.findUnique({ where: { id: shared.id } })).not.toBeNull();
  });

  it("holds one owner to one name in any case, in the database too", async () => {
    const alice = await owner();
    const scope = personalProxyScope(alice);
    const name = `Almaty ${randomUUID()}`;
    await store.create(scope, input(name));
    expect(await codeOf(store.create(scope, input(name.toUpperCase())))).toBe("proxy_name_taken");
    await expect(prisma.networkProxy.create({ data: { host: "proxy.example.com", name: name.toUpperCase(), port: 1080, protocol: "http", userId: alice } }))
      .rejects.toMatchObject({ code: "P2002" });
    await store.create(personalProxyScope(await owner()), input(name));
    await administratorProxy({ name });
    expect(await codeOf(store.create(ADMINISTRATOR_PROXY_SCOPE, input(name.toLowerCase())))).toBe("proxy_name_taken");
    const parallel = await Promise.allSettled([store.create(scope, input("Twin")), store.create(scope, input("twin"))]);
    expect(parallel.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("refuses a row no writer should make", async () => {
    const alice = await owner();
    const row = { host: "proxy.example.com", port: 1080, protocol: "http", userId: alice };
    for (const data of [{ ...row, name: "Bad port", port: 70_000 }, { ...row, name: "Bad protocol", protocol: "socks4" }, { ...row, name: " spaced " },
      { ...row, name: "Bad country", country: "kz" }, { ...row, name: "Orphan password", passwordEnvelope: "v2.a.b.c" },
      { ...row, lastCheckStatus: "ok", name: "Half a check" }, { ...row, lastCheckStatus: "proxy_timeout", lastCheckedAt: new Date(), lastExitAddress: "198.51.100.7", name: "Exit of a failure" },
      { ...row, domainHints: Array.from({ length: 51 }, (_, index) => `site${index}.ru`), name: "Too many hints" }]) {
      await expect(prisma.networkProxy.create({ data: data as never })).rejects.toThrow();
    }
    expect(await prisma.networkProxy.count({ where: { userId: alice } })).toBe(0);
  });

  it("stores the password sealed and answers without it, and a check leaves the version", async () => {
    const alice = await owner();
    const scope = personalProxyScope(alice);
    const own = await store.create(scope, input());
    const row = await prisma.networkProxy.findUniqueOrThrow({ where: { id: own.id } });
    expect(row.passwordEnvelope).toMatch(/^v2\./u);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    const checked = await store.check(scope, own.id);
    expect(checked.proxy).toMatchObject({ lastCheck: { exitAddress: "198.51.100.7", status: "ok" }, version: 1 });
    expect(JSON.stringify(checked)).not.toContain(PASSWORD);
  });
});

describe("manage_proxy on PostgreSQL", () => {
  function callStore(): SelfServiceCallStore & { settled: ToolExecutionResult[] } {
    const settled: ToolExecutionResult[] = [];
    return { claim: async () => settled[0] ? { kind: "settled", result: settled[0] } : { kind: "open" }, settle: async (_tx, result) => {
      settled.push(result);
    }, settled };
  }
  const service = (userId: string, calls = callStore()) => createAgentProxyService({ db: prisma, options, scope: { callId: randomUUID(), chatId: "chat", runId: "run", userId }, store: calls });
  const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_proxy", name: "manage_proxy" });
  const json = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, any> }).value;

  it("saves, replays a settled call once, changes, reads and proposes deleting the user's own", async () => {
    const alice = await owner();
    const name = `Almaty ${randomUUID()}`;
    const calls = callStore();
    const saved = await executeManageProxy(service(alice, calls), call({ action: "create", ...input(name) }));
    expect(json(saved)).toMatchObject({ saved: true });
    expect(await executeManageProxy(service(alice, calls), call({ action: "create", ...input(name) }))).toBe(saved);
    expect(await prisma.networkProxy.count({ where: { userId: alice } })).toBe(1);
    expect(json(await executeManageProxy(service(alice), call({ action: "update", country: "kz", name }))).proxy).toMatchObject({ country: "KZ" });
    expect(json(await executeManageProxy(service(alice), call({ action: "read", name }))).proxy).toMatchObject({ login: "bob", password: PASSWORD });
    expect(json(await executeManageProxy(service(alice), call({ action: "propose_delete", name })))).toMatchObject({ deleted: false, deletionProposed: true });
    expect(await prisma.networkProxy.count({ where: { userId: alice } })).toBe(1);
  });

  it("rolls a change back when its call cannot settle", async () => {
    const alice = await owner();
    const failing: SelfServiceCallStore = { claim: async () => ({ kind: "open" }), settle: async () => {
      throw new Error("settle failed");
    } };
    const result = await executeManageProxy(service(alice, failing as never), call({ action: "create", ...input() }));
    expect(json(result)).toMatchObject({ code: "proxy_change_failed" });
    expect(await prisma.networkProxy.count({ where: { userId: alice } })).toBe(0);
  });

  it("keeps another user's proxy out of reach, and an administrator's unchanged", async () => {
    const [alice, bob] = [await owner(), await owner()];
    const own = await store.create(personalProxyScope(alice), input());
    const shared = await administratorProxy();
    const missing = randomUUID();
    for (const [action, extra] of [["update", { active: false }], ["read", {}], ["test", {}], ["propose_delete", {}]] as const) {
      const foreign = json(await executeManageProxy(service(bob), call({ action, proxyId: own.id, ...extra })));
      expect(foreign).toEqual(json(await executeManageProxy(service(bob), call({ action, proxyId: missing, ...extra }))));
      expect(foreign.code).toBe("proxy_not_found");
    }
    for (const [action, extra] of [["update", { active: false }], ["test", {}], ["propose_delete", {}]] as const) {
      expect(json(await executeManageProxy(service(bob), call({ action, proxyId: shared.id, ...extra })))).toMatchObject({ code: "proxy_administrator_read_only" });
    }
    expect(await prisma.networkProxy.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ active: true, lastCheckStatus: null, version: 1 });
    expect(await prisma.networkProxy.findUniqueOrThrow({ where: { id: shared.id } })).toMatchObject({ active: true, lastCheckStatus: null, version: 1 });
  });
});
