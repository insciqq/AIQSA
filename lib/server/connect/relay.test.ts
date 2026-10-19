import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_DEFAULT_HELLO_LIMITS,
  CONNECT_MAX_VIEWS_PER_DEVICE,
  connectDeviceSchema,
  type ConnectDeviceEvent,
  type ConnectSession
} from "@/lib/contracts/connect";
import {
  CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER,
  CONNECT_RELAY_MAX_PENDING_REPLIES,
  createConnectRelay,
  type ConnectDeviceRecord,
  type ConnectRelay,
  type ConnectRelayEvent,
  type ConnectViewOwner
} from "./relay";

const logs = vi.hoisted(() => ({ logConnect: vi.fn() }));
vi.mock("./observability", () => logs);

type Frame = Readonly<{ data: unknown; event: string }>;

function fakeWriter(capacity = Number.POSITIVE_INFINITY) {
  const state = { capacity, closed: false, final: undefined as Frame | undefined, frames: [] as Frame[] };
  return {
    state,
    commands: () => state.frames.filter((frame) => frame.event === "command").map((frame) => frame.data as Record<string, unknown>),
    writer: {
      close(final?: Frame) {
        if (state.closed) return;
        state.final = final;
        state.closed = true;
      },
      send(event: string, data: unknown) {
        if (state.closed || state.frames.length >= state.capacity) return false;
        state.frames.push({ data, event });
        return true;
      }
    }
  };
}

function record(userId: string): ConnectDeviceRecord {
  return {
    arch: "arm64",
    clientVersion: "0.3.20",
    createdAt: new Date("2026-10-19T08:00:00.000Z"),
    hostname: "synthetic-host.local",
    id: randomUUID(),
    lastSeenAt: new Date("2026-10-19T09:00:00.000Z"),
    name: "Synthetic laptop",
    os: "darwin",
    userId
  };
}

function session(id: string, title = "Claude Code · project", status: ConnectSession["status"] = "running"): ConnectSession {
  return {
    attachedClients: 0,
    createdAt: "2026-10-19T09:00:00.000Z",
    cwd: "/home/synthetic/project",
    id,
    program: "claude",
    status,
    statusAt: "2026-10-19T09:00:00.000Z",
    title
  };
}

function attach(relay: ConnectRelay, device: ConnectDeviceRecord, tokenHash: string = randomUUID()) {
  const stream = fakeWriter();
  const attached = relay.attachDevice({
    epoch: relay.epoch(),
    hello: {
      deviceId: device.id,
      limits: CONNECT_DEFAULT_HELLO_LIMITS,
      minClientVersion: "0.3.20",
      protocol: 1,
      serverVersion: "0.3.20"
    },
    record: device,
    tokenHash,
    writer: stream.writer
  });
  if (attached.kind !== "attached") throw new Error("not attached");
  return { ...stream, streamId: attached.streamId, tokenHash };
}

function openView(relay: ConnectRelay, owner: ConnectViewOwner, deviceId: string, sessionId = "ac-session1") {
  const opened = relay.openView({ cols: 80, deviceId, owner, rows: 24, sessionId });
  if (!opened.ok) throw new Error(opened.code);
  return opened.viewId;
}

function browser(relay: ConnectRelay, owner: ConnectViewOwner, viewId: string, capacity?: number) {
  const stream = fakeWriter(capacity);
  const attached = relay.attachView({ owner, viewId, writer: stream.writer });
  if (!attached.ok) throw new Error("view not attached");
  return { ...stream, writerId: attached.writerId };
}

const output = (viewId: string, seq: number, data = "aGVsbG8="): ConnectDeviceEvent => ({ data, seq, type: "output", viewId });

const alice: ConnectViewOwner = { authSessionId: "session-alice", userId: "user-alice" };
const aliceOtherTab: ConnectViewOwner = { authSessionId: "session-alice-2", userId: "user-alice" };
const bob: ConnectViewOwner = { authSessionId: "session-bob", userId: "user-bob" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AIQSA Connect relay: device streams", () => {
  it("sends hello first and lets a newer stream of the device replace the older one", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const first = attach(relay, laptop, "token-laptop");
    expect(first.state.frames[0]).toMatchObject({ event: "hello", data: { deviceId: laptop.id, protocol: 1 } });
    const viewId = openView(relay, alice, laptop.id);
    const view = browser(relay, alice, viewId);
    const pending = relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: laptop.id, userId: alice.userId });

    const second = attach(relay, laptop, "token-laptop");

    expect(first.state.closed).toBe(true);
    expect(first.state.final).toEqual({ data: {}, event: "replaced" });
    expect(second.state.frames[0]?.event).toBe("hello");
    expect(second.commands()).toEqual([{ type: "view_close", viewId }]);
    expect(view.state.final).toEqual({ data: { reason: "error" }, event: "closed" });
    // The older stream's late close leaves the newer one online.
    relay.detachDevice(laptop.id, first.streamId);
    expect(relay.projectDevice(laptop).online).toBe(true);
    expect(relay.hasDeviceStream("token-laptop")).toBe(true);
    return expect(pending).resolves.toEqual({ code: "connect_device_offline", ok: false });
  });

  it("ends a device that stopped reading its commands", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    device.state.capacity = device.state.frames.length;

    expect(relay.openView({ cols: 80, deviceId: laptop.id, owner: alice, rows: 24, sessionId: "ac-session1" }))
      .toEqual({ code: "connect_device_offline", ok: false });
    expect(device.state.closed).toBe(true);
    expect(relay.projectDevice(laptop).online).toBe(false);
    expect(logs.logConnect).toHaveBeenCalledWith(expect.objectContaining({ code: "connect_device_queue_full" }));
  });

  it("closes the views, fails the requests and reports the device offline when its stream ends", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    relay.acceptEvents(device.tokenHash, [{ sessions: [session("ac-session1")], type: "sessions" }]);
    const events: ConnectRelayEvent[] = [];
    relay.onEvent((event) => events.push(event));
    const view = browser(relay, alice, openView(relay, alice, laptop.id));
    const pending = relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: laptop.id, userId: alice.userId });

    relay.detachDevice(laptop.id, device.streamId);

    expect(view.state.final).toEqual({ data: { reason: "connect_device_offline" }, event: "closed" });
    await expect(pending).resolves.toEqual({ code: "connect_device_offline", ok: false });
    expect(events).toEqual([expect.objectContaining({ deviceId: laptop.id, type: "device_offline", userId: alice.userId })]);
    const offline = relay.projectDevice(laptop);
    expect(connectDeviceSchema.parse(offline)).toMatchObject({ lastSeenAt: "2026-10-19T09:00:00.000Z", online: false, sessions: [] });
    expect(relay.hasDeviceStream(device.tokenHash)).toBe(false);
    expect(relay.size()).toEqual({ devices: 0, listeners: 1, pendingReplies: 0, views: 0 });
  });

  it("refuses an attach that started before a revocation, so a stream never outlives its device", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const epoch = relay.epoch();
    relay.disconnectUser(alice.userId, { activeAuthSessionIds: [] });
    const stream = fakeWriter();

    expect(relay.attachDevice({
      epoch,
      hello: { deviceId: laptop.id, limits: CONNECT_DEFAULT_HELLO_LIMITS, minClientVersion: "0.3.20", protocol: 1, serverVersion: "0.3.20" },
      record: laptop,
      tokenHash: "token",
      writer: stream.writer
    })).toEqual({ kind: "stale" });
    expect(stream.state.frames).toEqual([]);
    expect(relay.projectDevice(laptop).online).toBe(false);
  });
});

describe("AIQSA Connect relay: requests", () => {
  it("correlates replies, validates results against the command and keeps foreign devices invisible", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const intruder = attach(relay, record(bob.userId));

    expect(await relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: randomUUID(), userId: alice.userId }))
      .toEqual({ code: "connect_device_offline", ok: false });
    expect(await relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: laptop.id, userId: bob.userId }))
      .toEqual({ code: "connect_not_found", ok: false });

    const history = relay.request<"session_history">({
      command: { sessionId: "ac-session1", type: "session_history" },
      deviceId: laptop.id,
      userId: alice.userId
    });
    const sent = device.commands().at(-1)!;
    expect(sent).toMatchObject({ sessionId: "ac-session1", type: "session_history" });
    const requestId = sent.requestId as string;
    // Another device's token cannot answer this device's request.
    relay.acceptEvents(intruder.tokenHash, [{ ok: true, requestId, result: { text: "forged" }, type: "reply" }]);
    relay.acceptEvents(device.tokenHash, [{ ok: true, requestId, result: { text: "line one\nline two" }, type: "reply" }]);
    await expect(history).resolves.toEqual({ ok: true, result: { text: "line one\nline two" } });

    const create = relay.request<"session_create">({
      command: { cwd: "~/project", program: "shell", type: "session_create" },
      deviceId: laptop.id,
      userId: alice.userId
    });
    relay.acceptEvents(device.tokenHash, [{
      ok: true,
      requestId: device.commands().at(-1)!.requestId as string,
      result: { text: "not a session" },
      type: "reply"
    }]);
    await expect(create).resolves.toEqual({ code: "connect_device_error", ok: false });

    const kill = relay.request<"session_kill">({
      command: { sessionId: "ac-missing1", type: "session_kill" },
      deviceId: laptop.id,
      userId: alice.userId
    });
    relay.acceptEvents(device.tokenHash, [{
      code: "connect_session_not_found",
      ok: false,
      requestId: device.commands().at(-1)!.requestId as string,
      type: "reply"
    }]);
    await expect(kill).resolves.toEqual({ code: "connect_session_not_found", ok: false });
  });

  it("times a request out after ten seconds and bounds the requests waiting on one device", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    attach(relay, laptop);
    const waiting = Array.from({ length: CONNECT_RELAY_MAX_PENDING_REPLIES }, () =>
      relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: laptop.id, userId: alice.userId }));

    expect(await relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: laptop.id, userId: alice.userId }))
      .toEqual({ code: "connect_rate_limited", ok: false });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(relay.size().pendingReplies).toBe(CONNECT_RELAY_MAX_PENDING_REPLIES);
    await vi.advanceTimersByTimeAsync(1);
    for (const request of waiting) await expect(request).resolves.toEqual({ code: "connect_device_timeout", ok: false });
    expect(relay.size().pendingReplies).toBe(0);
    expect(logs.logConnect).toHaveBeenCalledWith(expect.objectContaining({ code: "connect_device_timeout" }));
  });
});

describe("AIQSA Connect relay: views", () => {
  it("sends input in order and output only to the view's own browser stream", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const first = openView(relay, alice, laptop.id, "ac-session1");
    const second = openView(relay, aliceOtherTab, laptop.id, "ac-session1");
    const firstTab = browser(relay, alice, first);
    const secondTab = browser(relay, aliceOtherTab, second);
    const intruder = attach(relay, record(bob.userId));

    expect(relay.viewInput(alice, first, "ls")).toBeNull();
    expect(relay.viewInput(alice, first, "\r")).toBeNull();
    expect(relay.viewResize(alice, first, { cols: 120, rows: 40 })).toBeNull();
    expect(device.commands().filter((command) => command.viewId === first)).toEqual([
      { cols: 80, rows: 24, sessionId: "ac-session1", type: "view_open", viewId: first },
      { data: "ls", type: "view_input", viewId: first },
      { data: "\r", type: "view_input", viewId: first },
      { cols: 120, rows: 40, type: "view_resize", viewId: first }
    ]);
    // A view belongs to its account and its browser session.
    expect(relay.viewInput(aliceOtherTab, first, "x")).toBe("connect_not_found");
    expect(relay.viewInput(bob, first, "x")).toBe("connect_not_found");
    expect(relay.viewResize(bob, first, { cols: 80, rows: 24 })).toBe("connect_not_found");
    expect(relay.viewVisibility(bob, first, true)).toBe("connect_not_found");
    expect(relay.closeOwnedView(bob, first)).toBe("connect_not_found");

    relay.acceptEvents(device.tokenHash, [output(first, 0, "Zmlyc3Q="), output(second, 0, "c2Vjb25k")]);
    relay.acceptEvents(intruder.tokenHash, [output(first, 1, "Zm9yZ2Vk")]);
    relay.acceptEvents(device.tokenHash, [output(first, 0, "ZHVwbGljYXRl"), output(first, 1, "bmV4dA==")]);

    expect(firstTab.state.frames).toEqual([
      { data: { data: "Zmlyc3Q=", seq: 0 }, event: "output" },
      { data: { data: "bmV4dA==", seq: 1 }, event: "output" }
    ]);
    expect(secondTab.state.frames).toEqual([{ data: { data: "c2Vjb25k", seq: 0 }, event: "output" }]);
  });

  it("closes a view whose output skips a sequence number, and the device's attach with it", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const viewId = openView(relay, alice, laptop.id);
    const tab = browser(relay, alice, viewId);

    relay.acceptEvents(device.tokenHash, [output(viewId, 0), output(viewId, 2)]);

    expect(tab.state.final).toEqual({ data: { reason: "error" }, event: "closed" });
    expect(device.commands().at(-1)).toEqual({ type: "view_close", viewId });
    expect(relay.viewInput(alice, viewId, "x")).toBe("connect_not_found");
    expect(logs.logConnect).toHaveBeenCalledWith(expect.objectContaining({ code: "connect_view_seq_gap" }));
  });

  it("keeps output that arrives before the browser stream and ends a view its browser stops reading", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const viewId = openView(relay, alice, laptop.id);
    relay.acceptEvents(device.tokenHash, [output(viewId, 0, "Zmlyc3Q="), output(viewId, 1, "c2NyZWVu")]);

    const tab = browser(relay, alice, viewId, 3);
    expect(tab.state.frames.map((frame) => frame.data)).toEqual([{ data: "Zmlyc3Q=", seq: 0 }, { data: "c2NyZWVu", seq: 1 }]);

    relay.acceptEvents(device.tokenHash, [output(viewId, 2), output(viewId, 3)]);
    expect(tab.state.final).toEqual({ data: { reason: "error" }, event: "closed" });
    expect(device.commands().at(-1)).toEqual({ type: "view_close", viewId });
    expect(logs.logConnect).toHaveBeenCalledWith(expect.objectContaining({ code: "connect_view_queue_full" }));
  });

  it("closes a view whose browser stream is gone for thirty seconds", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const neverAttached = openView(relay, alice, laptop.id);
    const reconnecting = openView(relay, alice, laptop.id);
    const first = browser(relay, alice, reconnecting);
    relay.detachView(reconnecting, first.writerId);

    await vi.advanceTimersByTimeAsync(20_000);
    const second = browser(relay, alice, reconnecting);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(device.commands().filter((command) => command.type === "view_close")).toEqual([{ type: "view_close", viewId: neverAttached }]);
    expect(relay.viewInput(alice, neverAttached, "x")).toBe("connect_not_found");
    expect(relay.viewInput(alice, reconnecting, "x")).toBeNull();

    relay.detachView(reconnecting, second.writerId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(device.commands().at(-1)).toEqual({ type: "view_close", viewId: reconnecting });
    expect(relay.size().views).toBe(0);
  });

  it("limits views per device and answers foreign devices like missing ones", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    attach(relay, laptop);
    for (let index = 0; index < CONNECT_MAX_VIEWS_PER_DEVICE; index += 1) openView(relay, alice, laptop.id);

    expect(relay.openView({ cols: 80, deviceId: laptop.id, owner: alice, rows: 24, sessionId: "ac-session1" }))
      .toEqual({ code: "connect_view_limit", ok: false });
    expect(relay.openView({ cols: 80, deviceId: laptop.id, owner: bob, rows: 24, sessionId: "ac-session1" }))
      .toEqual({ code: "connect_not_found", ok: false });
    expect(relay.openView({ cols: 80, deviceId: randomUUID(), owner: alice, rows: 24, sessionId: "ac-session1" }))
      .toEqual({ code: "connect_device_offline", ok: false });
  });

  it("knows whether the owner has a session on screen within the last thirty seconds", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    attach(relay, laptop);
    const viewId = openView(relay, alice, laptop.id, "ac-session1");
    browser(relay, alice, viewId);

    expect(relay.isSessionVisible(alice.userId, laptop.id, "ac-session1", Date.now())).toBe(true);
    expect(relay.isSessionVisible(bob.userId, laptop.id, "ac-session1", Date.now())).toBe(false);
    expect(relay.isSessionVisible(alice.userId, laptop.id, "ac-session2", Date.now())).toBe(false);
    expect(relay.isSessionVisible(alice.userId, randomUUID(), "ac-session1", Date.now())).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(relay.isSessionVisible(alice.userId, laptop.id, "ac-session1", Date.now())).toBe(false);
    expect(relay.viewVisibility(alice, viewId, true)).toBeNull();
    expect(relay.isSessionVisible(alice.userId, laptop.id, "ac-session1", Date.now())).toBe(true);
    expect(relay.viewVisibility(alice, viewId, false)).toBeNull();
    expect(relay.isSessionVisible(alice.userId, laptop.id, "ac-session1", Date.now())).toBe(false);
  });
});

describe("AIQSA Connect relay: revocation and switch-off", () => {
  it("ends a revoked device's stream with closed and refuses its events", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const tab = browser(relay, alice, openView(relay, alice, laptop.id));

    relay.disconnectDevice(laptop.id, "connect_unauthorized");

    expect(device.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(tab.state.final).toEqual({ data: { reason: "connect_device_offline" }, event: "closed" });
    expect(relay.acceptEvents(device.tokenHash, [output(randomUUID(), 0)])).toBe(false);
  });

  it("ends every stream and view of an account when its access is revoked, and only that account's", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const desktop = record(alice.userId);
    const other = record(bob.userId);
    const laptopStream = attach(relay, laptop);
    const desktopStream = attach(relay, desktop);
    const otherStream = attach(relay, other);
    const tab = browser(relay, alice, openView(relay, alice, laptop.id));
    const events: ConnectRelayEvent[] = [];
    relay.onEvent((event) => events.push(event));

    relay.disconnectUser(alice.userId, { activeAuthSessionIds: [] });

    expect(laptopStream.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(desktopStream.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(tab.state.final).toEqual({ data: { reason: "connect_unauthorized" }, event: "closed" });
    expect(otherStream.state.closed).toBe(false);
    expect(events.filter((event) => event.type === "devices_changed")).toEqual([{ type: "devices_changed", userId: alice.userId }]);
    expect(events.some((event) => event.type === "closed")).toBe(false);
  });

  it("closes the views of a session that stays signed in as device offline when only the devices are revoked", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const kept = browser(relay, alice, openView(relay, alice, laptop.id));
    const revoked = browser(relay, aliceOtherTab, openView(relay, aliceOtherTab, laptop.id));

    // A password change keeps the current session and revokes the others.
    relay.disconnectUser(alice.userId, { activeAuthSessionIds: [alice.authSessionId] });

    expect(device.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(kept.state.final).toEqual({ data: { reason: "connect_device_offline" }, event: "closed" });
    expect(revoked.state.final).toEqual({ data: { reason: "connect_unauthorized" }, event: "closed" });
    expect(device.commands().filter((command) => command.type === "view_close")).toEqual([]);
    expect(relay.size()).toMatchObject({ devices: 0, views: 0 });
  });

  it("closes only the views of a revoked browser session", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const revokedTab = browser(relay, alice, openView(relay, alice, laptop.id));
    const otherTab = browser(relay, aliceOtherTab, openView(relay, aliceOtherTab, laptop.id));

    relay.closeViewsForAuthSession(alice.authSessionId);

    expect(revokedTab.state.final).toEqual({ data: { reason: "connect_unauthorized" }, event: "closed" });
    expect(otherTab.state.closed).toBe(false);
    expect(device.state.closed).toBe(false);
    expect(device.commands().filter((command) => command.type === "view_close")).toHaveLength(1);
  });

  it("ends everything with connect_disabled when the administrator turns the feature off", async () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop);
    const other = attach(relay, record(bob.userId));
    const tab = browser(relay, alice, openView(relay, alice, laptop.id));
    const pending = relay.request<"recent_dirs">({ command: { type: "recent_dirs" }, deviceId: laptop.id, userId: alice.userId });
    const events: ConnectRelayEvent[] = [];
    relay.onEvent((event) => events.push(event));
    const epoch = relay.epoch();

    relay.disable();

    expect(device.state.final).toEqual({ data: { code: "connect_disabled" }, event: "closed" });
    expect(other.state.final).toEqual({ data: { code: "connect_disabled" }, event: "closed" });
    expect(tab.state.final).toEqual({ data: { reason: "connect_disabled" }, event: "closed" });
    await expect(pending).resolves.toEqual({ code: "connect_disabled", ok: false });
    expect(events.at(-1)).toEqual({ code: "connect_disabled", type: "closed" });
    expect(relay.epoch()).toBeGreaterThan(epoch);
    expect(relay.size()).toMatchObject({ devices: 0, views: 0 });
  });

  it("ends everything as unauthorized when every session of the installation is revoked", () => {
    const relay = createConnectRelay();
    const device = attach(relay, record(alice.userId));
    const events: ConnectRelayEvent[] = [];
    relay.onEvent((event) => events.push(event));

    relay.disconnectAll();

    expect(device.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(events.at(-1)).toEqual({ code: "connect_unauthorized", type: "closed" });
  });
});

describe("AIQSA Connect relay: listeners", () => {
  it("reports online, sessions and status changes with the session title and the previous status", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const events: ConnectRelayEvent[] = [];
    const failing = vi.fn(() => {
      throw new Error("listener failure");
    });
    relay.onEvent(failing);
    const unsubscribe = relay.onEvent((event) => events.push(event));
    const device = attach(relay, laptop);

    relay.acceptEvents(device.tokenHash, [
      { sessions: [session("ac-session1", "Fix the build"), session("ac-session2", "Shell", "idle")], type: "sessions" },
      { reason: "permission", sessionId: "ac-session1", status: "needs_approval", statusAt: "2026-10-19T10:00:01.000Z", type: "status" },
      { sessionId: "ac-unknown1", status: "waiting", statusAt: "2026-10-19T10:00:02.000Z", type: "status" }
    ]);

    expect(events.map((event) => event.type)).toEqual(["device_online", "sessions", "status"]);
    for (const event of events) {
      if ("device" in event) connectDeviceSchema.parse(event.device);
    }
    expect(events[2]).toMatchObject({
      deviceId: laptop.id,
      previousStatus: "running",
      reason: "permission",
      sessionId: "ac-session1",
      status: "needs_approval",
      statusAt: "2026-10-19T10:00:01.000Z",
      title: "Fix the build",
      type: "status",
      userId: alice.userId
    });
    const projected = relay.projectDevice(laptop);
    expect(projected.online).toBe(true);
    expect(projected.sessions.map((entry) => [entry.id, entry.status])).toEqual([["ac-session1", "needs_approval"], ["ac-session2", "idle"]]);
    expect(failing).toHaveBeenCalled();

    unsubscribe();
    relay.notifyDevicesChanged(alice.userId);
    expect(events).toHaveLength(3);
  });

  it("bounds the device-list streams of one account", () => {
    const relay = createConnectRelay();
    for (let index = 0; index < CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER; index += 1) {
      expect(relay.acquireEventsStream(alice.userId)).toBe(true);
    }
    expect(relay.acquireEventsStream(alice.userId)).toBe(false);
    expect(relay.acquireEventsStream(bob.userId)).toBe(true);
    relay.releaseEventsStream(alice.userId);
    expect(relay.acquireEventsStream(alice.userId)).toBe(true);
  });

  it("never logs terminal data, titles, paths or identifiers", () => {
    const relay = createConnectRelay();
    const laptop = record(alice.userId);
    const device = attach(relay, laptop, "token-hash-secret");
    const viewId = openView(relay, alice, laptop.id);
    browser(relay, alice, viewId, 1);
    relay.acceptEvents(device.tokenHash, [
      { sessions: [session("ac-session1", "Secret project title")], type: "sessions" },
      output(viewId, 0, "c2VjcmV0LW91dHB1dA=="),
      output(viewId, 1, "bW9yZQ=="),
      output(viewId, 5, "Z2Fw")
    ]);
    relay.request<"session_create">({ command: { cwd: "/home/synthetic/secret", program: "shell", type: "session_create" }, deviceId: laptop.id, userId: alice.userId });
    relay.acceptEvents(device.tokenHash, [{
      ok: true,
      requestId: device.commands().at(-1)!.requestId as string,
      result: { text: "wrong shape" },
      type: "reply"
    }]);

    const logged = JSON.stringify(logs.logConnect.mock.calls);
    expect(logs.logConnect).toHaveBeenCalled();
    for (const secret of ["c2VjcmV0", "Secret project", "/home/synthetic", "token-hash-secret", viewId, laptop.id, alice.userId, "wrong shape"]) {
      expect(logged).not.toContain(secret);
    }
    for (const [fields] of logs.logConnect.mock.calls) {
      expect(Object.keys(fields as object).every((key) => ["action", "code", "count", "error", "outcome", "stage"].includes(key))).toBe(true);
    }
  });
});
