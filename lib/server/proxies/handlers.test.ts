// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { logEvent } from "../observability";
import { fakeProxyDb } from "./fakeProxyDb.testFixtures";
import { createProxyHandlers } from "./handlers";
import { createProxyStore } from "./store";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const PASSWORD = "synthetic-proxy-pass-0001";
const INPUT = { domainHints: [".kz"], host: "proxy.example.com", login: "bob", name: "Almaty", password: PASSWORD, port: 1080, protocol: "socks5" };
type Viewer = Readonly<{ role: string; status: string; userId: string }>;
const ALICE: Viewer = { role: "user", status: "active", userId: "alice" };
const BOB: Viewer = { role: "user", status: "active", userId: "bob" };
const ADMIN: Viewer = { role: "admin", status: "active", userId: "admin" };

function setup() {
  const fake = fakeProxyDb({ activeUsers: ["alice", "bob", "admin"] });
  let viewer: Viewer | null = ALICE;
  const store = createProxyStore(fake.db, {
    checkAddress: async ({ host, port }) => ({ host: String(host), ok: true, pinned: { address: "203.0.113.9", family: 4 }, port: Number(port) }),
    key: () => Buffer.alloc(32, 7),
    probe: async () => ({ exitAddress: "198.51.100.7", ok: true })
  });
  const handle = createProxyHandlers({ store, resolveAuth: (async () => viewer && { user: { role: viewer.role, status: viewer.status }, userId: viewer.userId }) as never });
  const send = (method: string, body?: unknown) => new Request("http://aiqsa.test/api", { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  return { handle, send, setViewer: (next: Viewer | null) => {
    viewer = next;
  }, store };
}

const json = async (response: Response) => await response.json() as Record<string, any>;

describe("proxy routes", () => {
  it("authenticate first, and keep the administrator list to administrators", async () => {
    const { handle, send, setViewer } = setup();
    setViewer(null);
    expect((await handle(send("GET"), "list", "personal")).status).toBe(401);
    setViewer({ ...ALICE, status: "disabled" });
    expect((await handle(send("GET"), "list", "personal")).status).toBe(403);
    setViewer(ALICE);
    for (const action of ["list", "create"] as const) expect((await handle(send("POST", INPUT), action, "administrator")).status).toBe(403);
    expect((await handle(send("POST"), "check", "administrator", "any")).status).toBe(403);
    setViewer(ADMIN);
    expect(await json(await handle(send("GET"), "list", "administrator"))).toEqual({ proxies: [] });
  });

  it("create, change, check and delete a personal proxy, and never send a password back", async () => {
    const { handle, send } = setup();
    const created = await handle(send("POST", INPUT), "create", "personal");
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const body = await created.text();
    expect(body).not.toMatch(/synthetic-proxy-pass|envelope|"password"/iu);
    const { proxy } = JSON.parse(body) as { proxy: { id: string } };
    const listed = await handle(send("GET"), "list", "personal");
    expect(await listed.clone().text()).not.toMatch(/synthetic-proxy-pass|envelope|"password"/iu);
    expect((await json(listed)).proxies).toMatchObject([{ hasPassword: true, id: proxy.id }]);
    expect((await json(await handle(send("PATCH", { active: false, expectedVersion: 1 }), "update", "personal", proxy.id))).proxy).toMatchObject({ active: false, version: 2 });
    const checked = await json(await handle(send("POST"), "check", "personal", proxy.id));
    expect(checked.check).toMatchObject({ exitAddress: "198.51.100.7", status: "ok" });
    expect(checked.proxy).toMatchObject({ lastCheck: { status: "ok" }, version: 2 });
    expect((await handle(send("DELETE", { expectedVersion: 1 }), "delete", "personal", proxy.id)).status).toBe(409);
    expect(await json(await handle(send("DELETE", { expectedVersion: 2 }), "delete", "personal", proxy.id))).toEqual({ ok: true });
  });

  it("answer another user's proxy and a missing one with one response", async () => {
    const { handle, send, setViewer } = setup();
    const { proxy } = await json(await handle(send("POST", INPUT), "create", "personal"));
    setViewer(BOB);
    const results: Array<[number, string]> = [];
    for (const id of [proxy.id as string, "10000000-0000-4000-8000-000000000009", "not an id"]) {
      for (const [method, action, body] of [["PATCH", "update", { active: false, expectedVersion: 1 }], ["DELETE", "delete", { expectedVersion: 1 }], ["POST", "check", undefined]] as const) {
        const response = await handle(send(method, body), action, "personal", id);
        results.push([response.status, await response.text()]);
      }
    }
    expect(new Set(results.map(([status, text]) => `${status} ${text}`))).toEqual(new Set(['404 {"error":"proxy_not_found"}']));
    expect((await json(await handle(send("GET"), "list", "personal"))).proxies).toEqual([]);
  });

  it("show a member an administrator's proxy without its address or login, and refuse them changing it", async () => {
    const { handle, send, setViewer } = setup();
    setViewer(ADMIN);
    const { proxy } = await json(await handle(send("POST", INPUT), "create", "administrator"));
    setViewer(BOB);
    const listed = await handle(send("GET"), "list", "personal");
    expect(await listed.clone().text()).not.toMatch(/proxy\.example\.com|"login"|"host"|synthetic-proxy-pass/u);
    expect((await json(listed)).shared).toMatchObject([{ id: proxy.id, name: "Almaty", owner: "administrator" }]);
    expect((await handle(send("PATCH", { active: false, expectedVersion: 1 }), "update", "personal", proxy.id)).status).toBe(404);
  });

  it("answer stable codes for what cannot be done", async () => {
    const { handle, send } = setup();
    const refuse = async (body: unknown, status: number, error: string) => {
      const response = await handle(send("POST", body), "create", "personal");
      expect([response.status, (await json(response)).error]).toEqual([status, error]);
    };
    await refuse({ ...INPUT, host: "user:pw@proxy.example.com" }, 400, "proxy_host_invalid");
    await refuse({ ...INPUT, owner: "administrator" }, 400, "proxy_input_invalid");
    await refuse(null, 400, "proxy_input_invalid");
    await handle(send("POST", INPUT), "create", "personal");
    await refuse(INPUT, 409, "proxy_name_taken");
    const bare = await handle(new Request("http://aiqsa.test/api", { body: "{}", method: "POST" }), "create", "personal");
    expect(bare.status).toBe(415);
    const created = await json(await handle(send("GET"), "list", "personal"));
    expect((await handle(send("DELETE", { expectedVersion: 1, extra: true }), "delete", "personal", created.proxies[0].id)).status).toBe(400);
    expect((await handle(send("DELETE", null), "delete", "personal", created.proxies[0].id)).status).toBe(400);
  });

  it("log an unexpected failure without its content and answer with a code", async () => {
    const store = { listPersonal: vi.fn(async () => {
      throw new Error(`boom ${PASSWORD}`);
    }) };
    const handle = createProxyHandlers({ resolveAuth: (async () => ({ user: { role: "user", status: "active" }, userId: "alice" })) as never, store: store as never });
    const response = await handle(new Request("http://aiqsa.test/api"), "list", "personal");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"proxy_unavailable"}');
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "proxy_change_failed" }));
  });
});
