import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectComputerSchema } from "@/lib/contracts/computer";
import {
  CONNECT_DEFAULT_HELLO_V2_LIMITS,
  CONNECT_MAX_CONCURRENT_OPS,
  CONNECT_MAX_REPLY_BYTES,
  connectServerCommandV2Schema,
  type ConnectDeviceEventV2,
  type ConnectOp,
  type ConnectOpArgs
} from "@/lib/contracts/connect";
import {
  CONNECT_MAX_OP_COMMAND_BYTES,
  CONNECT_OP_REPLY_GRACE_MS,
  CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER,
  CONNECT_RELAY_MAX_UNDELIVERED_RUN_ENDS,
  CONNECT_RELAY_UNDELIVERED_RUN_END_TTL_MS,
  createConnectRelay,
  type ConnectDeviceRecord,
  type ConnectRelay,
  type ConnectRelayEvent
} from "./relay";

const logs = vi.hoisted(() => ({ logConnect: vi.fn() }));
vi.mock("./observability", () => logs);

type Frame = Readonly<{ data: unknown; event: string }>;

/** A device stream in memory: the frames the relay sent, and the final frame it closed with. */
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

function record(userId: string, os: ConnectDeviceRecord["os"] = "darwin"): ConnectDeviceRecord {
  return {
    arch: "arm64",
    clientVersion: "0.4.22",
    createdAt: new Date("2026-11-07T08:00:00.000Z"),
    hostname: "synthetic-host.local",
    id: randomUUID(),
    lastSeenAt: new Date("2026-11-07T09:00:00.000Z"),
    name: "Synthetic laptop",
    os,
    userId
  };
}

function attach(relay: ConnectRelay, device: ConnectDeviceRecord, tokenHash: string = randomUUID(), capacity?: number) {
  const stream = fakeWriter(capacity);
  const attached = relay.attachDevice({
    epoch: relay.epoch(),
    hello: {
      deviceId: device.id,
      limits: CONNECT_DEFAULT_HELLO_V2_LIMITS,
      minClientVersion: "0.3.20",
      protocol: 2,
      serverVersion: "0.4.22"
    },
    record: device,
    tokenHash,
    writer: stream.writer
  });
  if (attached.kind !== "attached") throw new Error("not attached");
  return { ...stream, streamId: attached.streamId, tokenHash };
}

const RUN_ID = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const readArgs: ConnectOpArgs<"read"> = { cwd: "~", limit: 2000, offset: 1, path: "notes.txt" };
const readResult = { content: "hello\n", encoding: "utf-8", lineEnding: "lf", startLine: 1, totalLines: 1, truncated: false } as const;

function call(
  relay: ConnectRelay,
  device: ConnectDeviceRecord,
  input: Partial<{ args: ConnectOpArgs; op: ConnectOp; signal: AbortSignal; timeoutMs: number; userId: string }> = {}
) {
  return relay.callOp({
    args: input.args ?? readArgs,
    deviceId: device.id,
    op: input.op ?? "read",
    runId: RUN_ID,
    signal: input.signal ?? new AbortController().signal,
    timeoutMs: input.timeoutMs ?? 60_000,
    userId: input.userId ?? device.userId
  });
}

/** The last `op` command the device got, checked against the protocol. */
function lastOp(stream: ReturnType<typeof attach>) {
  const command = connectServerCommandV2Schema.parse(stream.commands().at(-1));
  if (command.type !== "op") throw new Error(`not an op: ${command.type}`);
  return command;
}

const reply = (requestId: string, result: unknown = readResult): ConnectDeviceEventV2 =>
  ({ ok: true, requestId, result, type: "reply" }) as ConnectDeviceEventV2;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AIQSA Connect relay: device streams", () => {
  it("sends hello first and lets a newer stream of the device replace the older one", () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const first = attach(relay, device);
    expect(first.state.frames[0]).toMatchObject({ event: "hello", data: { protocol: 2 } });

    const second = attach(relay, device);
    expect(first.state.final).toEqual({ data: {}, event: "replaced" });
    expect(second.state.closed).toBe(false);
    relay.detachDevice(device.id, first.streamId);
    expect(relay.projectComputer(device).online).toBe(true);
  });

  it("refuses an attach that started before a revocation, so a stream never outlives its device", () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const epoch = relay.epoch();
    relay.disconnectDevice(device.id, "connect_unauthorized");
    const stream = fakeWriter();
    expect(relay.attachDevice({
      epoch,
      hello: { deviceId: device.id, limits: CONNECT_DEFAULT_HELLO_V2_LIMITS, minClientVersion: "0.3.20", protocol: 2, serverVersion: "0.4.22" },
      record: device,
      tokenHash: "token",
      writer: stream.writer
    })).toEqual({ kind: "stale" });
    expect(stream.state.frames).toEqual([]);
  });

  it("keeps device_info in memory for the stream and forgets it when the stream ends", () => {
    const relay = createConnectRelay();
    const events: ConnectRelayEvent[] = [];
    relay.onEvent((event) => events.push(event));
    const device = record("user-alice", "windows");
    const stream = attach(relay, device);
    expect(relay.projectComputer(device)).not.toHaveProperty("info");

    const info = {
      arch: "amd64",
      home: "C:\\Users\\synthetic",
      hostname: "DESKTOP-SYNTH",
      os: "windows",
      osVersion: "Windows 11 Pro 23H2",
      shell: { kind: "powershell", name: "Windows PowerShell", version: "5.1" },
      type: "device_info"
    } as const;
    expect(relay.acceptEvents(stream.tokenHash, [info])).toBe(true);
    const projected = connectComputerSchema.parse(relay.projectComputer(device));
    expect(projected).toMatchObject({ info: { home: "C:\\Users\\synthetic", osVersion: "Windows 11 Pro 23H2" }, online: true, os: "windows" });
    expect(relay.onlineDevice("user-alice", device.id)?.info?.shell).toEqual(info.shell);
    expect(events.at(-1)).toMatchObject({ computer: { info: { osVersion: "Windows 11 Pro 23H2" } }, type: "device", userId: "user-alice" });
    // Nobody else's lookup reaches it.
    expect(relay.onlineDevice("user-bob", device.id)).toBeNull();

    relay.detachDevice(device.id, stream.streamId);
    expect(relay.projectComputer(device)).toEqual(expect.not.objectContaining({ info: expect.anything() }));
    expect(relay.projectComputer(device).online).toBe(false);
    expect(events.at(-1)).toMatchObject({ computer: { online: false }, type: "device" });
    attach(relay, device);
    expect(relay.onlineDevice("user-alice", device.id)?.info).toBeNull();
  });
});

describe("AIQSA Connect relay: operations", () => {
  it("sends an op with its deadline and settles it with the reply checked against the op", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);

    const pending = call(relay, device, { timeoutMs: 45_000.4 })!;
    const command = lastOp(stream);
    expect(command).toMatchObject({ args: readArgs, deadlineMs: 45_001, op: "read", runId: RUN_ID });
    expect(relay.size().pendingOps).toBe(1);
    relay.acceptEvents(stream.tokenHash, [reply(command.requestId)]);
    await expect(pending).resolves.toEqual({ ok: true, result: readResult });
    expect(relay.size().pendingOps).toBe(0);

    // A device error code passes through; the device may have started the op.
    const failed = call(relay, device, { args: { cwd: "~", newString: "b", oldString: "a", path: "x", replaceAll: false }, op: "edit" })!;
    relay.acceptEvents(stream.tokenHash, [{ code: "computer_edit_ambiguous", ok: false, requestId: lastOp(stream).requestId, type: "reply" }]);
    await expect(failed).resolves.toEqual({ code: "computer_edit_ambiguous", ok: false, sent: true });
  });

  it("rejects a reply that does not match its op or exceeds the reply bound", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);

    const mismatched = call(relay, device)!;
    relay.acceptEvents(stream.tokenHash, [reply(lastOp(stream).requestId, { bytes: 3, created: true })]);
    await expect(mismatched).resolves.toEqual({ code: "connect_device_error", ok: false, sent: true });

    const oversize = call(relay, device, { args: { command: "cat big", cwd: "~", timeoutSeconds: 60, background: false }, op: "shell" })!;
    const big = "x".repeat(CONNECT_MAX_REPLY_BYTES / 2);
    relay.acceptEvents(stream.tokenHash, [reply(lastOp(stream).requestId, {
      durationMs: 5, exitCode: 0, stderr: big, stderrBytes: big.length, stdout: big, stdoutBytes: big.length, truncated: false
    })]);
    await expect(oversize).resolves.toEqual({ code: "connect_device_error", ok: false, sent: true });

    // A malformed batch's reply fails its op now.
    const salvaged = call(relay, device)!;
    relay.rejectReplies(stream.tokenHash, [lastOp(stream).requestId]);
    await expect(salvaged).resolves.toEqual({ code: "connect_device_error", ok: false, sent: true });
    expect(logs.logConnect).toHaveBeenCalledWith(expect.objectContaining({ code: "connect_reply_invalid" }));
  });

  it("times an op out after its deadline and a grace, sends cancel and ignores the late reply", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);

    const pending = call(relay, device, { timeoutMs: 5_000 })!;
    const { requestId } = lastOp(stream);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_000 + CONNECT_OP_REPLY_GRACE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ code: "computer_timeout", ok: false, sent: true });
    expect(stream.commands().at(-1)).toEqual({ requestId, type: "cancel" });

    // The late reply finds nothing to settle.
    expect(relay.acceptEvents(stream.tokenHash, [reply(requestId)])).toBe(true);
    expect(relay.size().pendingOps).toBe(0);
  });

  it("cancels on abort exactly once and never sends an op whose signal is already aborted", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);

    const controller = new AbortController();
    const pending = call(relay, device, { signal: controller.signal })!;
    const { requestId } = lastOp(stream);
    controller.abort();
    controller.abort();
    await expect(pending).resolves.toEqual({ code: "computer_cancelled", ok: false, sent: true });
    expect(stream.commands().filter((command) => command.type === "cancel")).toEqual([{ requestId, type: "cancel" }]);
    relay.acceptEvents(stream.tokenHash, [reply(requestId)]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stream.commands().filter((command) => command.type === "cancel")).toHaveLength(1);

    const sentBefore = stream.commands().length;
    await expect(call(relay, device, { signal: AbortSignal.abort() })).resolves.toEqual({ code: "computer_cancelled", ok: false, sent: false });
    expect(stream.commands()).toHaveLength(sentBefore);
  });

  it("keeps waiting ops across a reconnect of the device and settles them with the reply from its new stream", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");

    const ended = attach(relay, device);
    const first = call(relay, device)!;
    const firstId = lastOp(ended).requestId;
    relay.detachDevice(device.id, ended.streamId);
    expect(relay.size().pendingOps).toBe(1);
    const reconnected = attach(relay, device, ended.tokenHash);
    relay.acceptEvents(reconnected.tokenHash, [reply(firstId)]);
    await expect(first).resolves.toEqual({ ok: true, result: readResult });

    // A newer stream replacing the current one answers the older stream's request.
    const second = call(relay, device)!;
    const secondId = lastOp(reconnected).requestId;
    const next = attach(relay, device, reconnected.tokenHash);
    expect(reconnected.state.final).toEqual({ data: {}, event: "replaced" });
    relay.acceptEvents(next.tokenHash, [reply(secondId)]);
    await expect(second).resolves.toEqual({ ok: true, result: readResult });

    // Cancel goes to the stream the device has when the op is aborted.
    const controller = new AbortController();
    const third = call(relay, device, { signal: controller.signal })!;
    const thirdId = lastOp(next).requestId;
    const latest = attach(relay, device, next.tokenHash);
    controller.abort();
    await expect(third).resolves.toEqual({ code: "computer_cancelled", ok: false, sent: true });
    expect(latest.commands().at(-1)).toEqual({ requestId: thirdId, type: "cancel" });
    expect(relay.size().pendingOps).toBe(0);
  });

  it("fails waiting ops of a device that does not come back at their deadline, and at once on revocation or switch-off", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const disconnected = { code: "connect_device_disconnected", ok: false, sent: true };

    const ended = attach(relay, device);
    const timed = call(relay, device, { timeoutMs: 5_000 })!;
    relay.detachDevice(device.id, ended.streamId);
    let settled = false;
    void timed.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_000 + CONNECT_OP_REPLY_GRACE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(timed).resolves.toEqual({ code: "computer_timeout", ok: false, sent: true });

    // Revoked while offline or online: its waiting ops fail now.
    const offline = attach(relay, device);
    const whileOffline = call(relay, device)!;
    relay.detachDevice(device.id, offline.streamId);
    relay.disconnectDevice(device.id, "connect_unauthorized");
    await expect(whileOffline).resolves.toEqual(disconnected);

    const online = attach(relay, device);
    const whileOnline = call(relay, device)!;
    relay.disconnectDevice(device.id, "connect_unauthorized");
    await expect(whileOnline).resolves.toEqual(disconnected);
    expect(online.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });

    const account = attach(relay, device);
    const beforeAccountRevoked = call(relay, device)!;
    relay.detachDevice(device.id, account.streamId);
    relay.disconnectUser(device.userId);
    await expect(beforeAccountRevoked).resolves.toEqual(disconnected);

    const again = attach(relay, device);
    const beforeDisabled = call(relay, device)!;
    relay.disable();
    await expect(beforeDisabled).resolves.toEqual({ code: "connect_disabled", ok: false, sent: true });
    expect(again.state.final).toEqual({ data: { code: "connect_disabled" }, event: "closed" });

    const closed = attach(relay, device);
    const beforeClosed = call(relay, device)!;
    relay.closeDeviceStream(device.id, closed.streamId, "connect_disabled");
    await expect(beforeClosed).resolves.toEqual({ code: "connect_disabled", ok: false, sent: true });
    expect(relay.size().pendingOps).toBe(0);
  });

  it("answers null for an offline, missing or foreign device and sends nothing to it", () => {
    const relay = createConnectRelay();
    const alice = record("user-alice");
    const stream = attach(relay, alice);

    expect(call(relay, alice, { userId: "user-bob" })).toBeNull();
    expect(call(relay, record("user-alice"))).toBeNull();
    expect(stream.commands()).toEqual([]);
    relay.runEnded({ deviceId: alice.id, runId: RUN_ID, userId: "user-bob" });
    expect(stream.commands()).toEqual([]);
  });

  it("limits waiting ops per device and refuses an oversize command before sending it", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);
    for (let index = 0; index < CONNECT_MAX_CONCURRENT_OPS; index += 1) call(relay, device);
    const sent = stream.commands().length;
    await expect(call(relay, device)).resolves.toEqual({ code: "computer_limit", ok: false, sent: false });
    expect(stream.commands()).toHaveLength(sent);

    const other = record("user-alice");
    const otherStream = attach(relay, other);
    const content = "\u0001".repeat(CONNECT_MAX_OP_COMMAND_BYTES / 6 + 1);
    await expect(call(relay, other, { args: { content, cwd: "~", path: "x" }, op: "write" }))
      .resolves.toEqual({ code: "computer_file_too_large", ok: false, sent: false });
    expect(otherStream.commands()).toEqual([]);
    expect(otherStream.state.closed).toBe(false);
  });

  it("ends a device that stopped reading; the op it could not send was never sent", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    // Room for hello and one command.
    const stream = attach(relay, device, randomUUID(), 2);
    const first = call(relay, device, { timeoutMs: 1_000 })!;
    await expect(call(relay, device)).resolves.toEqual({ code: "connect_device_disconnected", ok: false, sent: false });
    expect(stream.state.closed).toBe(true);
    expect(relay.projectComputer(device).online).toBe(false);
    // The op that was sent waits for the device's next stream until its deadline.
    await vi.advanceTimersByTimeAsync(1_000 + CONNECT_OP_REPLY_GRACE_MS);
    await expect(first).resolves.toEqual({ code: "computer_timeout", ok: false, sent: true });
  });

  it("sends run_ended without waiting for anything", () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);
    relay.runEnded({ deviceId: device.id, runId: RUN_ID, userId: device.userId });
    expect(connectServerCommandV2Schema.parse(stream.commands().at(-1))).toEqual({ runId: RUN_ID, type: "run_ended" });
    relay.runEnded({ deviceId: randomUUID(), runId: RUN_ID, userId: device.userId });
    expect(stream.commands()).toHaveLength(1);
  });
});

describe("AIQSA Connect relay: run_ended for a device without a stream", () => {
  const OTHER_RUN = "8f14e45f-ceea-467a-9575-cb5bc5b0d5e1";
  const runEnds = (stream: ReturnType<typeof attach>) => stream.commands().filter((command) => command.type === "run_ended");

  it("sends a run_ended the offline device missed right after its next hello", () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const first = attach(relay, device);
    relay.detachDevice(device.id, first.streamId);
    relay.runEnded({ deviceId: device.id, runId: RUN_ID, userId: device.userId });
    relay.runEnded({ deviceId: device.id, runId: RUN_ID, userId: device.userId });
    relay.runEnded({ deviceId: device.id, runId: OTHER_RUN, userId: device.userId });
    expect(relay.undeliveredRunEndCount()).toBe(2);

    const next = attach(relay, device, first.tokenHash);
    expect(next.state.frames[0]!.event).toBe("hello");
    expect(next.state.frames.slice(1)).toEqual([
      { data: { runId: RUN_ID, type: "run_ended" }, event: "command" },
      { data: { runId: OTHER_RUN, type: "run_ended" }, event: "command" }
    ]);
    expect(relay.undeliveredRunEndCount()).toBe(0);
    // Delivered once.
    const later = attach(relay, device, first.tokenHash);
    expect(runEnds(later)).toEqual([]);
  });

  it("keeps a run_ended whose stream was gone, and one the next stream had no room for", () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    // Room for hello only: the send fails and ends the stream.
    attach(relay, device, randomUUID(), 1);
    relay.runEnded({ deviceId: device.id, runId: RUN_ID, userId: device.userId });
    expect(relay.projectComputer(device).online).toBe(false);
    relay.runEnded({ deviceId: device.id, runId: OTHER_RUN, userId: device.userId });

    // Room for hello and one command: the second waits again.
    const cramped = attach(relay, device, randomUUID(), 2);
    expect(runEnds(cramped)).toEqual([{ runId: RUN_ID, type: "run_ended" }]);
    expect(cramped.state.closed).toBe(true);
    const roomy = attach(relay, device);
    expect(runEnds(roomy)).toEqual([{ runId: OTHER_RUN, type: "run_ended" }]);
  });

  it("never sends another user's run ids, bounds what it keeps and forgets it after a day", async () => {
    const relay = createConnectRelay();
    const alice = record("user-alice");
    // A run of another user naming Alice's device, offline or online, reaches nothing.
    relay.runEnded({ deviceId: alice.id, runId: OTHER_RUN, userId: "user-bob" });
    const online = attach(relay, alice);
    relay.runEnded({ deviceId: alice.id, runId: OTHER_RUN, userId: "user-bob" });
    expect(runEnds(online)).toEqual([]);
    relay.detachDevice(alice.id, online.streamId);

    const runIds = Array.from({ length: CONNECT_RELAY_MAX_UNDELIVERED_RUN_ENDS + 10 }, () => randomUUID());
    for (const runId of runIds) relay.runEnded({ deviceId: alice.id, runId, userId: alice.userId });
    const bounded = attach(relay, alice);
    expect(runEnds(bounded).map((command) => command.runId)).toEqual(runIds.slice(-CONNECT_RELAY_MAX_UNDELIVERED_RUN_ENDS));
    relay.detachDevice(alice.id, bounded.streamId);

    relay.runEnded({ deviceId: alice.id, runId: RUN_ID, userId: alice.userId });
    await vi.advanceTimersByTimeAsync(CONNECT_RELAY_UNDELIVERED_RUN_END_TTL_MS);
    expect(runEnds(attach(relay, alice))).toEqual([]);
  });

  it("forgets a revoked device's and a revoked account's run_ended", () => {
    const relay = createConnectRelay();
    const alice = record("user-alice");
    const laptop = record("user-alice");
    const bob = record("user-bob");
    relay.runEnded({ deviceId: alice.id, runId: RUN_ID, userId: alice.userId });
    relay.runEnded({ deviceId: laptop.id, runId: RUN_ID, userId: laptop.userId });
    relay.runEnded({ deviceId: bob.id, runId: RUN_ID, userId: bob.userId });
    relay.disconnectDevice(alice.id, "connect_unauthorized");
    expect(relay.undeliveredRunEndCount()).toBe(2);
    relay.disconnectUser("user-alice");
    expect(relay.undeliveredRunEndCount()).toBe(1);
    expect(runEnds(attach(relay, bob))).toEqual([{ runId: RUN_ID, type: "run_ended" }]);
  });
});

describe("AIQSA Connect relay: revocation, switch-off and listeners", () => {
  it("ends every stream of an account when its access is revoked, and only that account's", () => {
    const relay = createConnectRelay();
    const events: ConnectRelayEvent[] = [];
    relay.onEvent((event) => events.push(event));
    const alice = attach(relay, record("user-alice"));
    const bob = attach(relay, record("user-bob"));
    relay.disconnectUser("user-alice");
    expect(alice.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(bob.state.closed).toBe(false);
    expect(events.at(-1)).toEqual({ type: "devices_changed", userId: "user-alice" });
    expect(relay.hasDeviceStream(alice.tokenHash)).toBe(false);
    expect(relay.acceptEvents(alice.tokenHash, [reply(randomUUID())])).toBe(false);

    relay.disconnectAll();
    expect(bob.state.final).toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    expect(events.at(-1)).toEqual({ code: "connect_unauthorized", type: "closed" });
  });

  it("bounds the device-list streams of one account", () => {
    const relay = createConnectRelay();
    for (let index = 0; index < CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER; index += 1) {
      expect(relay.acquireEventsStream("user-alice")).toBe(true);
    }
    expect(relay.acquireEventsStream("user-alice")).toBe(false);
    expect(relay.acquireEventsStream("user-bob")).toBe(true);
    relay.releaseEventsStream("user-alice");
    expect(relay.acquireEventsStream("user-alice")).toBe(true);
  });

  it("never logs commands, paths, content, output or identifiers", async () => {
    const relay = createConnectRelay();
    const device = record("user-alice");
    const stream = attach(relay, device);
    const pending = call(relay, device, { args: { command: "cat /secret/path", cwd: "/home/secret", timeoutSeconds: 1, background: false }, op: "shell", timeoutMs: 1_000 })!;
    relay.acceptEvents(stream.tokenHash, [reply(lastOp(stream).requestId, { secret: "output" })]);
    await pending;
    const timed = call(relay, device, { timeoutMs: 1 })!;
    await vi.advanceTimersByTimeAsync(CONNECT_OP_REPLY_GRACE_MS + 1);
    await timed;
    const logged = JSON.stringify(logs.logConnect.mock.calls);
    expect(logs.logConnect).toHaveBeenCalled();
    for (const secret of ["/secret", "/home/secret", "output", device.id, "user-alice", RUN_ID, stream.tokenHash]) {
      expect(logged).not.toContain(secret);
    }
  });
});
