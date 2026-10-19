import { describe, expect, it, vi } from "vitest";
import type { BrowserPushMessage } from "@/lib/contracts/browserPush";
import { CONNECT_DEFAULT_HELLO_LIMITS, type ConnectDeviceEvent, type ConnectSessionStatus } from "@/lib/contracts/connect";
import {
  CONNECT_PUSH_ACCOUNT_LIMIT,
  CONNECT_PUSH_ACCOUNT_WINDOW_MS,
  CONNECT_PUSH_INTERVAL_MS,
  CONNECT_PUSH_MAX_IN_FLIGHT,
  CONNECT_PUSH_MAX_QUEUED,
  createConnectPush,
  type ConnectPushDeps
} from "./push";
import { createConnectRelay, type ConnectDeviceRecord, type ConnectRelayEvent, type ConnectRelayListener } from "./relay";

const logs = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("../observability", () => logs);
vi.mock("../push/defaultBrowserPush", () => ({ getDefaultBrowserPush: vi.fn() }));

const DEVICE = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11";

function setup(options: Readonly<{ fail?: boolean; send?: ConnectPushDeps["send"] }> = {}) {
  let listener: ConnectRelayListener | null = null;
  const clock = { now: 1_000_000 };
  const visible = new Set<string>();
  const sent: Array<Readonly<{ jobId: string; message: BrowserPushMessage; userId: string }>> = [];
  const visibilityChecks: number[] = [];
  let jobs = 0;
  const push = createConnectPush({
    jobId: () => `job-${++jobs}`,
    now: () => clock.now,
    relay: {
      isSessionVisible: (userId, deviceId, sessionId, at) => {
        visibilityChecks.push(at ?? -1);
        return visible.has(`${userId}/${deviceId}/${sessionId}`);
      },
      onEvent: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      }
    },
    send: options.send ?? (async (userId, message, jobId) => {
      if (options.fail) throw new Error("push service down: secret detail");
      sent.push({ jobId, message, userId });
      return 1;
    })
  });
  function status(status: ConnectSessionStatus, previousStatus: ConnectSessionStatus, extra: Partial<Readonly<{
    sessionId: string; title: string; userId: string;
  }>> = {}): void {
    const event = {
      device: {} as never,
      deviceId: DEVICE,
      previousStatus,
      reason: null,
      sessionId: extra.sessionId ?? "ac-abc123",
      status,
      statusAt: "2026-10-19T10:00:00.000Z",
      title: extra.title ?? "Deploy fix",
      type: "status",
      userId: extra.userId ?? "owner-1"
    } satisfies ConnectRelayEvent;
    listener?.(event);
  }
  return { clock, emit: (event: ConnectRelayEvent) => listener?.(event), hasListener: () => listener !== null, push, sent, status, visibilityChecks, visible };
}

describe("AIQSA Connect push", () => {
  it("notifies the owner when a session starts needing approval or waiting, with content-free copy", async () => {
    const t = setup();
    t.status("needs_approval", "running");
    t.clock.now += CONNECT_PUSH_INTERVAL_MS;
    t.status("waiting", "running", { sessionId: "ac-def456", title: "" });
    await t.push.idle();
    expect(t.sent).toEqual([
      {
        jobId: "job-1",
        message: { body: "Needs approval", tag: `aiqsa-connect-${DEVICE}-ac-abc123`, title: "Deploy fix", url: `/connect/${DEVICE}/ac-abc123`, v: 1 },
        userId: "owner-1"
      },
      {
        jobId: "job-2",
        message: { body: "Waiting for you", tag: `aiqsa-connect-${DEVICE}-ac-def456`, title: "AIQSA Connect", url: `/connect/${DEVICE}/ac-def456`, v: 1 },
        userId: "owner-1"
      }
    ]);
  });

  it("sends nothing for other statuses, unchanged statuses or other events", async () => {
    const t = setup();
    t.status("running", "waiting");
    t.status("idle", "needs_approval");
    t.status("waiting", "waiting");
    t.status("needs_approval", "needs_approval");
    t.emit({ type: "devices_changed", userId: "owner-1" });
    t.emit({ code: "connect_disabled", type: "closed" });
    await t.push.idle();
    expect(t.sent).toEqual([]);
    // From one attention status to the other is a new transition.
    t.status("waiting", "needs_approval");
    await t.push.idle();
    expect(t.sent.map((s) => s.message.body)).toEqual(["Waiting for you"]);
  });

  it("sends at most one notice per session every 15 seconds", async () => {
    const t = setup();
    t.status("needs_approval", "running");
    t.clock.now += 5_000;
    t.status("waiting", "running");
    t.status("needs_approval", "running", { sessionId: "ac-other1" });
    t.status("needs_approval", "running", { userId: "owner-2" });
    t.clock.now += CONNECT_PUSH_INTERVAL_MS - 5_001;
    t.status("waiting", "running");
    t.clock.now += 1;
    t.status("waiting", "running");
    await t.push.idle();
    expect(t.sent.map((s) => [s.userId, s.message.tag, s.message.body])).toEqual([
      ["owner-1", `aiqsa-connect-${DEVICE}-ac-abc123`, "Needs approval"],
      ["owner-1", `aiqsa-connect-${DEVICE}-ac-other1`, "Needs approval"],
      ["owner-2", `aiqsa-connect-${DEVICE}-ac-abc123`, "Needs approval"],
      ["owner-1", `aiqsa-connect-${DEVICE}-ac-abc123`, "Waiting for you"]
    ]);
  });

  it("sends at most 6 notices per account a minute, whatever session ids its devices report", async () => {
    logs.logEvent.mockClear();
    const t = setup();
    for (let n = 0; n < 10; n += 1) t.status("waiting", "running", { sessionId: `ac-rot${String(n).padStart(3, "0")}` });
    t.status("waiting", "running", { userId: "owner-2" });
    await t.push.idle();
    expect(t.sent.filter((s) => s.userId === "owner-1")).toHaveLength(CONNECT_PUSH_ACCOUNT_LIMIT);
    expect(t.sent.filter((s) => s.userId === "owner-2")).toHaveLength(1);
    const refusals = logs.logEvent.mock.calls.filter(([, fields]) => (fields as { code?: string }).code === "push_rate_limited");
    expect(refusals).toHaveLength(1);
    t.clock.now += CONNECT_PUSH_ACCOUNT_WINDOW_MS;
    t.status("waiting", "running", { sessionId: "ac-later1" });
    await t.push.idle();
    expect(t.sent.filter((s) => s.userId === "owner-1")).toHaveLength(CONNECT_PUSH_ACCOUNT_LIMIT + 1);
  });

  it("sends at most 8 notices at once, keeps 32 waiting and drops the rest", async () => {
    logs.logEvent.mockClear();
    const releases: Array<() => void> = [];
    let started = 0;
    let active = 0;
    let most = 0;
    const t = setup({
      send: () => {
        started += 1;
        active += 1;
        most = Math.max(most, active);
        return new Promise((resolve) => releases.push(() => {
          active -= 1;
          resolve(1);
        }));
      }
    });
    const total = CONNECT_PUSH_MAX_IN_FLIGHT + CONNECT_PUSH_MAX_QUEUED + 5;
    for (let n = 0; n < total; n += 1) t.status("needs_approval", "running", { userId: `owner-${n}` });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(CONNECT_PUSH_MAX_IN_FLIGHT);
    const dropped = logs.logEvent.mock.calls.filter(([, fields]) => (fields as { code?: string }).code === "push_queue_full");
    expect(dropped).toHaveLength(5);
    for (let round = 0; round < 100 && releases.length > 0; round += 1) {
      for (const release of releases.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await t.push.idle();
    expect(started).toBe(CONNECT_PUSH_MAX_IN_FLIGHT + CONNECT_PUSH_MAX_QUEUED);
    expect(most).toBe(CONNECT_PUSH_MAX_IN_FLIGHT);
  });

  it("skips a session the owner has open and visible, without spending its interval", async () => {
    const t = setup();
    t.visible.add(`owner-1/${DEVICE}/ac-abc123`);
    t.status("needs_approval", "running");
    await t.push.idle();
    expect(t.sent).toEqual([]);
    expect(t.visibilityChecks).toEqual([t.clock.now]);
    t.visible.clear();
    t.clock.now += 1_000;
    t.status("waiting", "running");
    await t.push.idle();
    expect(t.sent.map((s) => s.message.body)).toEqual(["Waiting for you"]);
  });

  it("notifies once when the relay learns of an approval request only from the snapshot after a reconnect", async () => {
    const relay = createConnectRelay();
    const sent: BrowserPushMessage[] = [];
    const push = createConnectPush({
      relay,
      send: async (_userId, message) => {
        sent.push(message);
        return 1;
      }
    });
    const laptop = {
      arch: "arm64", clientVersion: "0.3.20", createdAt: new Date("2026-10-19T08:00:00.000Z"), hostname: "synthetic-host.local",
      id: DEVICE, lastSeenAt: null, name: "Synthetic laptop", os: "darwin", userId: "owner-1"
    } satisfies ConnectDeviceRecord;
    const snapshot = (status: ConnectSessionStatus): ConnectDeviceEvent => ({
      sessions: [{
        attachedClients: 0, createdAt: "2026-10-19T09:00:00.000Z", cwd: "/home/synthetic/project", id: "ac-abc123",
        program: "claude", status, statusAt: "2026-10-19T09:00:00.000Z", title: "Deploy fix"
      }],
      type: "sessions"
    });
    const connect = (tokenHash: string) => {
      const attached = relay.attachDevice({
        epoch: relay.epoch(),
        hello: { deviceId: DEVICE, limits: CONNECT_DEFAULT_HELLO_LIMITS, minClientVersion: "0.3.20", protocol: 1, serverVersion: "0.3.20" },
        record: laptop,
        tokenHash,
        writer: { close: () => undefined, send: () => true }
      });
      if (attached.kind !== "attached") throw new Error("not attached");
      return attached.streamId;
    };

    const first = connect("token-1");
    relay.acceptEvents("token-1", [snapshot("running")]);
    relay.detachDevice(DEVICE, first);
    connect("token-1");
    relay.acceptEvents("token-1", [
      snapshot("needs_approval"),
      // The client's own report of the same transition arrives after the snapshot.
      { reason: "permission", sessionId: "ac-abc123", status: "needs_approval", statusAt: "2026-10-19T09:00:00.000Z", type: "status" }
    ]);
    await push.idle();
    expect(sent).toEqual([
      { body: "Needs approval", tag: `aiqsa-connect-${DEVICE}-ac-abc123`, title: "Deploy fix", url: `/connect/${DEVICE}/ac-abc123`, v: 1 }
    ]);
    push.stop();
  });

  it("logs a failed send by code only and stops listening on stop", async () => {
    const t = setup({ fail: true });
    t.status("needs_approval", "running");
    await t.push.idle();
    expect(logs.logEvent).toHaveBeenCalledWith("job_attempt", expect.objectContaining({
      code: "push_delivery_failed", job_id: "job-1", outcome: "failed", subsystem: "push"
    }));
    expect(JSON.stringify(logs.logEvent.mock.calls.map(([, fields]) => ({ ...fields, error: undefined })))).not.toMatch(/Deploy fix|ac-abc123|owner-1/u);
    t.push.stop();
    expect(t.hasListener()).toBe(false);
  });
});
