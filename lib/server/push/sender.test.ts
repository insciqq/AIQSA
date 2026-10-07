import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PushTransportError, type PushPost, type PushPostRequest } from "./pushTransport";
import { createBrowserPushSender, RUN_PUSH_GRACE_MS } from "./sender";
import type { BrowserPushEvent, BrowserPushStore, BrowserPushTarget } from "./store";
import { generateVapidKeyPair } from "./webPushCrypto";

function device(id: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const target: BrowserPushTarget = {
    auth: auth.toString("base64url"), endpoint: `https://push.example/${id}`, id, p256dh: ecdh.getPublicKey().toString("base64url"),
    sessionId: `session-${id}`
  };
  return {
    target,
    /** Decrypts like the browser would (RFC 8291). */
    open(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      const senderPublic = body.subarray(21, 21 + body.readUInt8(20));
      const record = body.subarray(21 + senderPublic.length);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), senderPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(senderPublic), auth, info, 32));
      const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const decipher = createDecipheriv("aes-128-gcm", key, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      return JSON.parse(padded.subarray(0, padded.lastIndexOf(0x02)).toString());
    }
  };
}

const runEvent: BrowserPushEvent = { chatId: "chat-1", kind: "run", status: "complete", title: "Trip plan", userId: "owner-1" };

function harness(options: Readonly<{
  events?: Map<string, BrowserPushEvent>; post?: PushPost; sleep?: (ms: number) => Promise<void>; targets?: BrowserPushTarget[];
}> = {}) {
  const claimed = new Set<string>();
  const events = options.events ?? new Map<string, BrowserPushEvent>([["run-1", runEvent]]);
  const recorded: Array<[string, string]> = [];
  const store: BrowserPushStore = {
    claimOccurrence: vi.fn(async (id: string) => {
      const event = events.get(id);
      if (!event || event.kind !== "occurrence" || claimed.has(id)) return null;
      claimed.add(id);
      return event;
    }),
    claimRun: vi.fn(async (id: string) => {
      const event = events.get(id);
      if (!event || event.kind !== "run" || claimed.has(id)) return null;
      claimed.add(id);
      return event;
    }),
    deleteSubscription: vi.fn(),
    listTargets: vi.fn(async () => options.targets ?? []),
    recordDelivery: vi.fn(async (target, outcome) => { recorded.push([target.id, outcome]); }),
    saveSubscription: vi.fn()
  };
  const requests: PushPostRequest[] = [];
  const post: PushPost = options.post ?? (async (request) => {
    requests.push(request);
    return { status: 201 };
  });
  const keys = generateVapidKeyPair();
  const loadKeys = vi.fn(async () => keys);
  const clock = { now: new Date("2026-10-04T12:00:00.000Z") };
  const sleeps: number[] = [];
  const sender = createBrowserPushSender({
    keys: loadKeys, now: () => clock.now, post,
    sleep: options.sleep ?? (async (ms) => { sleeps.push(ms); }),
    store, subject: "https://aiqsa.example"
  });
  return { clock, keys, loadKeys, recorded, requests, sender, sleeps, store };
}

describe("browser push sender", () => {
  it("delivers one encrypted, content-free message per live device with VAPID and Web Push headers", async () => {
    const phone = device("phone");
    const laptop = device("laptop");
    const h = harness({ targets: [phone.target, laptop.target] });
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    expect(h.store.listTargets).toHaveBeenCalledWith("owner-1", expect.any(Date));
    expect(h.requests.map((request) => request.endpoint.toString())).toEqual([phone.target.endpoint, laptop.target.endpoint]);
    const [request] = h.requests;
    expect(request!.headers).toMatchObject({
      "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal"
    });
    expect(phone.open(request!.body)).toEqual({ body: "Answer ready", tag: "aiqsa-chat-chat-1", title: "Trip plan", url: "/c/chat-1", v: 1 });
    expect(laptop.open(h.requests[1]!.body)).toMatchObject({ title: "Trip plan" });

    const [, token, key] = /^vapid t=(.+), k=(.+)$/u.exec(request!.headers.authorization!)!;
    expect(key).toBe(h.keys.publicKey);
    const [header, claims, signature] = token!.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ aud: "https://push.example", sub: "https://aiqsa.example" });
    const point = Buffer.from(h.keys.publicKey, "base64url");
    const publicKey = createPublicKey({ format: "jwk", key: { crv: "P-256", kty: "EC",
      x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { dsaEncoding: "ieee-p1363", key: publicKey },
      Buffer.from(signature!, "base64url"))).toBe(true);
    expect(h.recorded).toEqual([["phone", "delivered"], ["laptop", "delivered"]]);
  });

  it("sends at most once per event when several paths report it", async () => {
    const h = harness({ targets: [device("phone").target] });
    h.sender.notifyRun("run-1");
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    expect(h.store.claimRun).toHaveBeenCalledTimes(3);
    expect(h.requests).toHaveLength(1);
  });

  it("sends nothing for an event the store does not claim (cancelled, scheduled, setting off, no device)", async () => {
    const h = harness({ events: new Map(), targets: [device("phone").target] });
    h.sender.notifyRun("run-cancelled");
    h.sender.notifyOccurrence("occurrence-paused");
    await h.sender.idle();
    expect(h.store.listTargets).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
  });

  it("delivers scheduled settlements through the occurrence claim", async () => {
    const occurrence: BrowserPushEvent = {
      chatId: null, kind: "occurrence", reasonCode: null, state: "COMPLETED", taskPauseReason: null, title: "Brief", trigger: "schedule",
      unavailableSources: [], userId: "owner-1"
    };
    const phone = device("phone");
    const h = harness({ events: new Map([["occurrence-1", occurrence]]), targets: [phone.target] });
    h.sender.notifyOccurrence("occurrence-1");
    await h.sender.idle();
    expect(phone.open(h.requests[0]!.body)).toMatchObject({ body: "Scheduled task finished", title: "Brief", url: "/scheduled" });
  });

  it("drops expired subscriptions, counts other failures and keeps going after a transport error", async () => {
    const statuses = [410, 404, 500, 201];
    const post: PushPost = vi.fn(async (request: PushPostRequest) => {
      if (request.endpoint.pathname === "/broken") throw new PushTransportError("push_endpoint_forbidden");
      return { status: statuses.shift()! };
    });
    const targets = ["gone", "missing", "failing", "broken", "fine"].map((id) => device(id).target);
    const h = harness({ post, targets });
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    expect(h.recorded).toEqual([["gone", "gone"], ["missing", "gone"], ["failing", "failed"], ["broken", "failed"], ["fine", "delivered"]]);
  });

  it("sends a ready message to a user's devices now and counts the devices that accepted it", async () => {
    const phone = device("phone");
    const statuses = [201, 410, 201];
    const post: PushPost = vi.fn(async (request: PushPostRequest) => {
      if (request.endpoint.pathname === "/broken") throw new PushTransportError("push_endpoint_forbidden");
      return { status: statuses.shift()! };
    });
    const h = harness({ post, targets: [phone.target, device("gone").target, device("broken").target, device("laptop").target] });
    const message = { body: "82% used", tag: "aiqsa-usage-cap", title: "Monthly cap almost used", url: "/admin?section=limits", v: 1 } as const;
    // A failed health record does not hide the device's delivery.
    vi.mocked(h.store.recordDelivery).mockRejectedValueOnce(new Error("database down"));
    await expect(h.sender.sendMessage("admin-1", message, "alert-1")).resolves.toBe(2);
    expect(h.store.listTargets).toHaveBeenCalledWith("admin-1", expect.any(Date));
    expect(h.store.claimRun).not.toHaveBeenCalled();
    expect(phone.open(vi.mocked(post).mock.calls[0]![0].body)).toEqual(message);
    expect(h.recorded).toEqual([["gone", "gone"], ["broken", "failed"], ["laptop", "delivered"]]);

    h.loadKeys.mockRejectedValueOnce(new Error("secret_encryption_invalid_key"));
    await expect(h.sender.sendMessage("admin-1", message, "alert-2")).resolves.toBe(0);
    vi.mocked(h.store.listTargets).mockRejectedValueOnce(new Error("database down"));
    await expect(h.sender.sendMessage("admin-1", message, "alert-3")).resolves.toBe(0);
  });

  it("claims nothing while the VAPID key is unavailable, so a later report can still notify", async () => {
    const h = harness({ targets: [device("phone").target] });
    h.loadKeys.mockRejectedValueOnce(new Error("secret_encryption_invalid_key"));
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    expect(h.store.claimRun).not.toHaveBeenCalled();
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    expect(h.requests).toHaveLength(1);
  });

  it("waits out the run grace, then skips only the devices of the session that showed that run", async () => {
    const phone = device("phone");
    const laptop = device("laptop");
    const sleeps: number[] = [];
    let wake: () => void = () => undefined;
    const h = harness({
      sleep: (ms) => new Promise((resolve) => { sleeps.push(ms); wake = resolve; }),
      targets: [phone.target, laptop.target]
    });
    h.sender.notifyRun("run-1");
    await vi.waitFor(() => expect(sleeps).toEqual([RUN_PUSH_GRACE_MS]));
    expect(h.store.claimRun).not.toHaveBeenCalled();
    h.sender.runShown("run-1", phone.target.sessionId);
    h.sender.runShown("run-2", laptop.target.sessionId);
    h.sender.runShown("run-1", "session-of-another-account");
    wake();
    await h.sender.idle();
    expect(h.requests.map((request) => request.endpoint.toString())).toEqual([laptop.target.endpoint]);
  });

  it("skips a device for a shown run only while the report is fresh", async () => {
    const phone = device("phone");
    const events = new Map<string, BrowserPushEvent>([["run-1", runEvent], ["run-2", runEvent]]);
    const h = harness({ events, targets: [phone.target] });
    h.sender.runShown("run-1", phone.target.sessionId);
    h.sender.runShown("run-2", phone.target.sessionId);
    h.sender.notifyRun("run-1");
    await h.sender.idle();
    expect(h.requests).toHaveLength(0);
    h.clock.now = new Date(h.clock.now.getTime() + 15 * 60_000);
    h.sender.notifyRun("run-2");
    await h.sender.idle();
    expect(h.requests).toHaveLength(1);
  });

  it("sends scheduled settlements without the grace, whatever this device showed", async () => {
    const occurrence: BrowserPushEvent = {
      chatId: "chat-1", kind: "occurrence", reasonCode: null, state: "COMPLETED", taskPauseReason: null, title: "Brief", trigger: "schedule",
      unavailableSources: [], userId: "owner-1"
    };
    const phone = device("phone");
    const h = harness({ events: new Map([["occurrence-1", occurrence]]), targets: [phone.target] });
    h.sender.runShown("occurrence-1", phone.target.sessionId);
    h.sender.notifyOccurrence("occurrence-1");
    await h.sender.idle();
    expect(h.sleeps).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });

  it("sends events one at a time and survives a failing store", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const post: PushPost = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { status: 201 };
    };
    const events = new Map<string, BrowserPushEvent>([["run-1", runEvent], ["run-2", { ...runEvent, chatId: "chat-2" }]]);
    const h = harness({ events, post, targets: [device("phone").target] });
    vi.mocked(h.store.claimRun).mockRejectedValueOnce(new Error("database unavailable"));
    h.sender.notifyRun("run-0");
    h.sender.notifyRun("run-1");
    h.sender.notifyRun("run-2");
    await vi.waitFor(() => expect(active).toBe(1));
    release();
    await h.sender.idle();
    expect(peak).toBe(1);
    expect(h.recorded).toEqual([["phone", "delivered"], ["phone", "delivered"]]);
  });
});
