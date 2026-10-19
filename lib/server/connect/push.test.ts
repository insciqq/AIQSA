import { describe, expect, it, vi } from "vitest";
import type { BrowserPushMessage } from "@/lib/contracts/browserPush";
import type { ConnectSessionStatus } from "@/lib/contracts/connect";
import { CONNECT_PUSH_INTERVAL_MS, createConnectPush } from "./push";
import type { ConnectRelayEvent, ConnectRelayListener } from "./relay";

const logs = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("../observability", () => logs);
vi.mock("../push/defaultBrowserPush", () => ({ getDefaultBrowserPush: vi.fn() }));

const DEVICE = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11";

function setup(options: Readonly<{ fail?: boolean }> = {}) {
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
    send: async (userId, message, jobId) => {
      if (options.fail) throw new Error("push service down: secret detail");
      sent.push({ jobId, message, userId });
      return 1;
    }
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
