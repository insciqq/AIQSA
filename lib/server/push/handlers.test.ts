import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createBrowserPushHandlers } from "./handlers";
import type { SaveBrowserPushSubscriptionResult } from "./store";
import { generateVapidKeyPair } from "./webPushCrypto";

const session: AuthenticatedSession = {
  expiresAt: new Date("2026-10-11T00:00:00.000Z"), id: "session-1",
  user: { displayName: "Owner", email: null, id: "owner-1", role: "user", status: "active" }, userId: "owner-1"
};

function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: "https://push.example/device", expirationTime: null,
    keys: { auth: randomBytes(16).toString("base64url"), p256dh: ecdh.getPublicKey().toString("base64url") }
  };
}

function harness(options: Readonly<{ auth?: AuthenticatedSession | null; saved?: SaveBrowserPushSubscriptionResult }> = {}) {
  const keys = generateVapidKeyPair();
  const store = {
    deleteSubscription: vi.fn(async () => undefined),
    saveSubscription: vi.fn(async () => options.saved ?? "saved" as const)
  };
  const runShown = vi.fn();
  const handlers = createBrowserPushHandlers({
    keys: async () => keys,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
    resolveAuth: async () => options.auth === undefined ? session : options.auth,
    runShown,
    store
  });
  return { handlers, keys, runShown, store };
}

function request(method: string, body?: unknown): Request {
  return new Request("https://aiqsa.example/api/me/push-subscriptions", {
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    method
  });
}

describe("browser push owner API", () => {
  it("returns the installation's public key only to a signed-in account", async () => {
    const h = harness();
    const response = await h.handlers.key(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ applicationServerKey: h.keys.publicKey });
    expect((await harness({ auth: null }).handlers.key(request("GET"))).status).toBe(401);
  });

  it("binds the subscription to the authenticated account and session, never to request fields", async () => {
    const h = harness();
    const body = subscription();
    const response = await h.handlers.subscribe(request("POST", body));
    expect(response.status).toBe(204);
    expect(h.store.saveSubscription).toHaveBeenCalledWith({
      auth: body.keys.auth, endpoint: body.endpoint, p256dh: body.keys.p256dh, sessionId: "session-1", userId: "owner-1"
    }, new Date("2026-10-04T12:00:00.000Z"));
    const forged = await h.handlers.subscribe(request("POST", { ...body, userId: "someone-else" }));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "push_subscription_invalid" });
    expect(h.store.saveSubscription).toHaveBeenCalledTimes(1);
  });

  it("refuses unsafe endpoints, a disabled setting, an ended session and inactive accounts", async () => {
    const h = harness();
    expect((await h.handlers.subscribe(request("POST", { ...subscription(), endpoint: "https://192.168.1.10/push" }))).status).toBe(400);
    expect(h.store.saveSubscription).not.toHaveBeenCalled();

    const disabled = await harness({ saved: "disabled" }).handlers.subscribe(request("POST", subscription()));
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: "browser_notifications_disabled" });
    expect((await harness({ saved: "session_inactive" }).handlers.subscribe(request("POST", subscription()))).status).toBe(401);
    const inactive = harness({ auth: { ...session, user: { ...session.user, status: "disabled" } } });
    expect((await inactive.handlers.subscribe(request("POST", subscription()))).status).toBe(403);
    expect(inactive.store.saveSubscription).not.toHaveBeenCalled();
  });

  it("removes only the caller's own subscription by endpoint", async () => {
    const h = harness();
    expect((await h.handlers.unsubscribe(request("DELETE", { endpoint: "https://push.example/device" }))).status).toBe(204);
    expect(h.store.deleteSubscription).toHaveBeenCalledWith("owner-1", "https://push.example/device");
    expect((await h.handlers.unsubscribe(request("DELETE", { endpoint: "javascript:alert(1)" }))).status).toBe(400);
  });

  it("records a shown run for the caller's session only, from a bare run id", async () => {
    const h = harness();
    const runId = "0b7c3a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
    expect((await h.handlers.runShown(request("POST", { runId }))).status).toBe(204);
    expect(h.runShown).toHaveBeenCalledWith(runId, "session-1");
    for (const body of [{ runId: "run-1" }, { runId, sessionId: "session-2" }, { runId: 1 }, [runId]]) {
      expect((await h.handlers.runShown(request("POST", body))).status).toBe(400);
    }
    expect((await harness({ auth: null }).handlers.runShown(request("POST", { runId }))).status).toBe(401);
    const inactive = harness({ auth: { ...session, user: { ...session.user, status: "disabled" } } });
    expect((await inactive.handlers.runShown(request("POST", { runId }))).status).toBe(403);
    expect(h.runShown).toHaveBeenCalledTimes(1);
    expect(inactive.runShown).not.toHaveBeenCalled();
  });

  it("answers a stable unavailable code when keys or storage fail", async () => {
    const h = harness();
    h.store.saveSubscription.mockRejectedValueOnce(new Error("database down"));
    const response = await h.handlers.subscribe(request("POST", subscription()));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "push_unavailable" });
    const keyless = createBrowserPushHandlers({
      keys: async () => { throw new Error("secret_encryption_invalid_key"); },
      resolveAuth: async () => session,
      runShown: h.runShown,
      store: h.store
    });
    expect((await keyless.key(request("GET"))).status).toBe(503);
  });
});
