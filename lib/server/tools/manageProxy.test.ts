// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeResourceChangeCard, type ProxyChangeCard } from "@/lib/contracts/resourceChanges";
import { createAgentProxyService } from "../proxies/agentProxies";
import { fakeProxyDb } from "../proxies/fakeProxyDb.testFixtures";
import type { ProxyProbe } from "../proxies/probe";
import { ADMINISTRATOR_PROXY_SCOPE, createProxyStore, personalProxyScope } from "../proxies/store";
import { MANAGE_PROXY_TOOL_NAME, executeManageProxy, manageProxyTool, manageProxyValues } from "./manageProxy";
import type { SelfServiceCallStore } from "./selfServiceCall";
import type { ToolExecutionResult } from "./types";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const PASSWORD = "synthetic-proxy-pass-0001";
const ADMIN_PASSWORD = "synthetic-admin-pass-0001";
const SAVE = { action: "create", domainHints: [".kz"], host: "Proxy.Example.com", login: "bob", name: "Almaty", password: PASSWORD, port: 1080, protocol: "socks5" };
const key = () => Buffer.alloc(32, 7);
const passing = async ({ host, port }: { host: unknown; port: unknown }) =>
  ({ host: String(host), ok: true as const, pinned: { address: "203.0.113.9", family: 4 as const }, port: Number(port) });
const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_proxy", name: MANAGE_PROXY_TOOL_NAME });
const json = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, any> }).value;
const card = (result: ToolExecutionResult) => decodeResourceChangeCard((result.artifacts?.[0] as { data: { payload: unknown } }).data.payload) as ProxyChangeCard;

function setup() {
  const fake = fakeProxyDb({ activeUsers: ["alice", "bob"] });
  const probe = vi.fn<ProxyProbe>(async () => ({ exitAddress: "198.51.100.7", ok: true }));
  const checkAddress = vi.fn(passing);
  const options = { checkAddress, key, now: () => new Date("2026-11-01T10:00:00.000Z"), probe };
  const callStore = { claim: vi.fn<SelfServiceCallStore["claim"]>(async () => ({ kind: "open" })), settle: vi.fn<SelfServiceCallStore["settle"]>(async () => undefined) };
  const serviceFor = (userId: string) => createAgentProxyService({ db: fake.db, options, scope: { callId: "c1", chatId: "chat", runId: "run", userId }, store: callStore });
  const service = serviceFor("alice");
  return { ...fake, callStore, checkAddress, probe, run: (args: Record<string, unknown>) => executeManageProxy(service, call(args)), serviceFor,
    settings: createProxyStore(fake.db, options) };
}

let test: ReturnType<typeof setup>;
beforeEach(() => {
  test = setup();
});

describe("manage_proxy", () => {
  it("is a local tool that needs neither approval nor the VM", () => {
    expect(manageProxyTool).toMatchObject({ effects: "local", name: "manage_proxy", needsApproval: false, requiresVm: false });
    expect(manageProxyTool.description).toContain("from the next message");
  });

  it("names only a passed password to mask, on writes", () => {
    expect(manageProxyValues(SAVE)).toEqual([PASSWORD]);
    expect(manageProxyValues({ action: "update", name: "Almaty", password: "other" })).toEqual(["other"]);
    expect(manageProxyValues({ action: "update", name: "Almaty", password: null, login: "bob" })).toEqual([]);
    expect(manageProxyValues({ action: "read", name: "Almaty", password: "other" })).toEqual([]);
  });

  it("saves a pasted proxy for a zone, with a card and Undo's version, committed with the call and with no password in the result", async () => {
    const result = await test.run(SAVE);
    expect(result.status).toBe("complete");
    expect(json(result)).toMatchObject({ proxy: { domainHints: [".kz"], hasPassword: true, host: "proxy.example.com", login: "bob", name: "Almaty", owner: "personal" }, saved: true });
    expect(json(result).note).toContain("from the next message");
    expect(card(result)).toMatchObject({ action: "created", domainHints: [".kz"], name: "Almaty", proposalId: null, protocol: "socks5", proxyVersion: 1, resource: "proxy" });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(card(result))).not.toMatch(/proxy\.example\.com|"login"|"bob"/u);
    expect(test.callStore.settle).toHaveBeenCalledWith(expect.anything(), result);
    expect(test.rows[0]).toMatchObject({ userId: "alice" });
    expect(test.rows[0]!.passwordEnvelope).not.toContain(PASSWORD);
  });

  it("returns a settled call's result without applying it twice", async () => {
    const settled: ToolExecutionResult = { callId: "call_proxy", content: [{ text: "settled", type: "text" }], name: MANAGE_PROXY_TOOL_NAME, status: "complete" };
    test.callStore.claim.mockResolvedValueOnce({ kind: "settled", result: settled });
    expect(await test.run(SAVE)).toBe(settled);
    expect(test.rows).toEqual([]);
    test.callStore.claim.mockResolvedValueOnce({ kind: "unavailable" });
    expect(json(await test.run(SAVE))).toMatchObject({ code: "proxy_change_unavailable", saved: false });
    expect(test.rows).toEqual([]);
  });

  it("refuses with what to fix and writes nothing", async () => {
    for (const [args, code] of [
      [{ ...SAVE, host: "user:pw@proxy.example.com" }, "proxy_host_invalid"],
      [{ ...SAVE, domainHints: ["https://x.kz/"] }, "proxy_hint_invalid"],
      [{ ...SAVE, port: "1080" }, "proxy_port_invalid"],
      [{ ...SAVE, login: undefined }, "proxy_login_invalid"],
      [{ ...SAVE, proxyId: "abc" }, "proxy_arguments_invalid"],
      [{ ...SAVE, unknown: 1 }, "proxy_arguments_invalid"],
      [{ action: "drop" }, "proxy_arguments_invalid"],
      [{ action: "create", host: "proxy.example.com", port: 1080, protocol: "socks5" }, "proxy_name_invalid"]
    ] as const) {
      const result = await test.run(args);
      expect(result.status).toBe("error");
      expect(json(result)).toMatchObject({ code, saved: false });
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
    expect(test.rows).toEqual([]);
  });

  it("refuses an address the rule refuses, before the transaction", async () => {
    test.checkAddress.mockResolvedValueOnce({ code: "proxy_address_forbidden", ok: false } as never);
    expect(json(await test.run(SAVE))).toMatchObject({ code: "proxy_address_forbidden", saved: false });
    expect(test.callStore.claim).not.toHaveBeenCalled();
    expect(test.rows).toEqual([]);
  });

  it("changes a proxy by name, keeping what is absent, and shows no Undo's version it did not leave", async () => {
    await test.run(SAVE);
    const result = await test.run({ action: "update", domainHints: [".kz", "ozon.ru"], name: "almaty", newName: "Astana", password: "synthetic-proxy-pass-0002" });
    expect(json(result)).toMatchObject({ passwordChanged: expect.any(String), proxy: { domainHints: [".kz", "ozon.ru"], host: "proxy.example.com", name: "Astana" }, renamedFrom: "Almaty" });
    expect(card(result)).toMatchObject({ action: "updated", passwordChanged: true, previousName: "Almaty", proxyVersion: 2 });
    expect(JSON.stringify(result)).not.toContain("synthetic-proxy-pass-0002");
    expect(json(await test.run({ action: "update", active: false, proxyId: test.rows[0]!.id }))).toMatchObject({ proxy: { active: false } });
    expect(card(await test.run({ action: "update", active: true, name: "Astana" }))).toMatchObject({ passwordChanged: false, previousName: null });
  });

  it("takes a null of a field that cannot be cleared as absent, and clears those that can", async () => {
    await test.run(SAVE);
    const result = await test.run({ action: "update", country: "kz", host: null, name: "Almaty", port: null });
    expect(json(result).proxy).toMatchObject({ country: "KZ", host: "proxy.example.com", port: 1080 });
    expect(json(await test.run({ action: "update", country: null, name: "Almaty" })).proxy).toMatchObject({ country: null });
    expect(json(await test.run({ action: "update", login: null, name: "Almaty", password: null })).proxy).toMatchObject({ hasPassword: false, login: null });
  });

  it("runs the address rule on a moved proxy, and refuses an update with nothing to change", async () => {
    await test.run(SAVE);
    test.checkAddress.mockClear();
    expect(json(await test.run({ action: "update", name: "Almaty" }))).toMatchObject({ code: "proxy_arguments_invalid" });
    expect(json(await test.run({ action: "update", name: "Almaty", port: 1080 }))).toMatchObject({ code: "proxy_unchanged" });
    expect(test.checkAddress).not.toHaveBeenCalled();
    test.checkAddress.mockResolvedValueOnce({ code: "proxy_address_forbidden", ok: false } as never);
    expect(json(await test.run({ action: "update", host: "10.0.0.1", name: "Almaty" }))).toMatchObject({ code: "proxy_address_forbidden" });
    expect(test.rows[0]).toMatchObject({ host: "proxy.example.com", version: 1 });
  });

  it("refuses a name the user already holds", async () => {
    await test.run(SAVE);
    expect(json(await test.run({ ...SAVE, name: "ALMATY" }))).toMatchObject({ code: "proxy_name_taken", saved: false });
  });

  it("lists the user's own and the administrators' by name, with no password and no administrator address", async () => {
    await test.run(SAVE);
    await test.settings.create(ADMINISTRATOR_PROXY_SCOPE, { domainHints: [".ru"], host: "shared.example.com", login: "ops", name: "Shared", password: ADMIN_PASSWORD, port: 3128, protocol: "http" });
    await test.settings.create(personalProxyScope("bob"), { host: "bobs.example.com", name: "Bobs", port: 3128, protocol: "http" });
    const result = await test.run({ action: "list" });
    const value = json(result);
    expect(value.personal).toMatchObject([{ hasPassword: true, host: "proxy.example.com", login: "bob", name: "Almaty" }]);
    expect(value.administrator).toMatchObject([{ domainHints: [".ru"], name: "Shared", owner: "administrator" }]);
    expect(value.administrator[0]).not.toHaveProperty("host");
    expect(value.administrator[0]).not.toHaveProperty("login");
    expect(JSON.stringify(result)).not.toMatch(/synthetic-|bobs\.example|shared\.example|envelope/u);
    expect(json(await test.run({ action: "list", name: "Almaty" }))).toMatchObject({ code: "proxy_arguments_invalid" });
  });

  it("reads one proxy's credentials, an administrator's too unless switched off", async () => {
    await test.run(SAVE);
    const shared = await test.settings.create(ADMINISTRATOR_PROXY_SCOPE, { host: "shared.example.com", login: "ops", name: "Shared", password: ADMIN_PASSWORD, port: 3128, protocol: "http" });
    expect(json(await test.run({ action: "read", name: "Almaty" })).proxy).toMatchObject({ host: "proxy.example.com", login: "bob", owner: "personal", password: PASSWORD });
    expect(json(await test.run({ action: "read", name: "shared" })).proxy).toMatchObject({ host: "shared.example.com", login: "ops", owner: "administrator", password: ADMIN_PASSWORD });
    await test.settings.update(ADMINISTRATOR_PROXY_SCOPE, shared.id, { active: false, expectedVersion: 1 });
    const off = await test.run({ action: "read", proxyId: shared.id });
    expect(json(off)).toMatchObject({ code: "proxy_inactive" });
    expect(JSON.stringify(off)).not.toContain(ADMIN_PASSWORD);
  });

  it("prefers the user's own of two proxies with one name, as selection does", async () => {
    await test.settings.create(ADMINISTRATOR_PROXY_SCOPE, { host: "shared.example.com", name: "Almaty", port: 3128, protocol: "http" });
    await test.run(SAVE);
    expect(json(await test.run({ action: "read", name: "Almaty" })).proxy).toMatchObject({ owner: "personal" });
  });

  it("cannot change, test or delete an administrator's proxy", async () => {
    const shared = await test.settings.create(ADMINISTRATOR_PROXY_SCOPE, { host: "shared.example.com", name: "Shared", port: 3128, protocol: "http" });
    for (const args of [{ action: "update", active: false, name: "Shared" }, { action: "update", active: false, proxyId: shared.id }, { action: "test", name: "Shared" }, { action: "propose_delete", proxyId: shared.id }]) {
      const result = await test.run(args);
      expect(json(result)).toMatchObject({ code: "proxy_administrator_read_only" });
      expect(result.artifacts).toBeUndefined();
    }
    expect(test.probe).not.toHaveBeenCalled();
    expect(test.rows[0]).toMatchObject({ active: true, lastCheckStatus: null, version: 1 });
  });

  it("answers another user's proxy like a missing one, by id and by name", async () => {
    const bobs = await test.settings.create(personalProxyScope("bob"), { host: "bobs.example.com", login: "b", name: "Bobs", password: "synthetic-bob-pass", port: 3128, protocol: "http" });
    const missing = "10000000-0000-4000-8000-000000000009";
    for (const [action, extra] of [["update", { active: false }], ["read", {}], ["test", {}], ["propose_delete", {}]] as const) {
      const forId = async (proxyId: string) => json(await test.run({ action, proxyId, ...extra }));
      const forName = async (name: string) => json(await test.run({ action, name, ...extra }));
      expect(await forId(bobs.id)).toEqual(await forId(missing));
      expect(await forName("Bobs")).toEqual(await forName("Nobody"));
      expect(await forId(bobs.id)).toMatchObject({ code: "proxy_not_found" });
    }
    expect(test.rows[0]).toMatchObject({ active: true, lastCheckStatus: null, version: 1 });
  });

  it("tests a just-saved proxy, returning its exit address and a stable status", async () => {
    await test.run(SAVE);
    expect(json(await test.run({ action: "test", name: "Almaty" }))).toEqual({ checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: "198.51.100.7",
      name: "Almaty", proxyId: test.rows[0]!.id, status: "ok" });
    expect(test.probe.mock.calls[0]![0]).toMatchObject({ login: "bob", password: PASSWORD });
    test.probe.mockResolvedValueOnce({ code: "proxy_auth_failed", ok: false });
    const failed = await test.run({ action: "test", name: "Almaty" });
    expect(failed.status).toBe("complete");
    expect(json(failed)).toMatchObject({ exitAddress: null, status: "proxy_auth_failed" });
    expect(test.rows[0]).toMatchObject({ lastCheckStatus: "proxy_auth_failed", version: 1 });
    expect(JSON.stringify(failed)).not.toContain(PASSWORD);
  });

  it("proposes a deletion with a card of its own and deletes nothing", async () => {
    await test.run(SAVE);
    const first = await test.run({ action: "propose_delete", name: "Almaty" });
    expect(json(first)).toMatchObject({ deleted: false, deletionProposed: true, proxy: { name: "Almaty" } });
    expect(card(first)).toMatchObject({ action: "delete_proposed", proxyVersion: 1, resource: "proxy" });
    expect(card(first).proposalId).toEqual(expect.any(String));
    expect(card(await test.run({ action: "propose_delete", name: "Almaty" })).proposalId).not.toBe(card(first).proposalId);
    expect(test.rows).toHaveLength(1);
    expect(test.callStore.settle).toHaveBeenCalledTimes(1);
    expect(json(await test.run({ action: "propose_delete", host: "x.example.com", name: "Almaty" }))).toMatchObject({ code: "proxy_arguments_invalid" });
  });

  it("refuses for an owner who is no longer active", async () => {
    const service = test.serviceFor("gone");
    expect(json(await executeManageProxy(service, call({ action: "list" })))).toMatchObject({ code: "proxy_unavailable" });
    expect(json(await executeManageProxy(service, call(SAVE)))).toMatchObject({ code: "proxy_unavailable", saved: false });
  });

  it("has no service in a run that cannot change anything", async () => {
    expect(json(await executeManageProxy(undefined, call({ action: "list" })))).toMatchObject({ code: "proxy_change_unavailable" });
  });

  it("keeps the failure to itself when the store breaks", async () => {
    const service = { ...test.serviceFor("alice"), list: async () => {
      throw new Error(`boom ${PASSWORD}`);
    } };
    const result = await executeManageProxy(service, call({ action: "list" }));
    expect(json(result)).toMatchObject({ code: "proxy_change_failed" });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("keeps a cancelled call's own failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(executeManageProxy(test.serviceFor("alice"), call({ action: "list" }), { signal: controller.signal })).rejects.toThrow("stopped");
  });
});
