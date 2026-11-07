import { randomUUID } from "node:crypto";
import type { ComputerFailureCode, ConnectComputerInfoWire, ConnectComputerWire } from "@/lib/contracts/computer";
import {
  CONNECT_MAX_CONCURRENT_OPS,
  CONNECT_MAX_OP_DEADLINE_MS,
  CONNECT_MAX_REPLY_BYTES,
  connectUtf8ByteLength,
  parseConnectOpResult,
  type ConnectArch,
  type ConnectDeviceEventV2,
  type ConnectDeviceStreamClosedCode,
  type ConnectEventsStreamClosedCode,
  type ConnectHelloV2,
  type ConnectOp,
  type ConnectOpArgs,
  type ConnectOs,
  type ConnectServerCommandV2
} from "@/lib/contracts/connect";
import type { ComputerOpOutcome } from "./computerPort";
import { logConnect } from "./observability";

/** A paired device as the database holds it; the relay never stores more than this about a computer. */
export type ConnectDeviceRecord = Readonly<{
  arch: ConnectArch;
  clientVersion: string;
  createdAt: Date;
  hostname: string;
  id: string;
  lastSeenAt: Date | null;
  name: string;
  os: ConnectOs;
  userId: string;
}>;

/** One SSE stream. `send` is false once the stream is closed or its bounded queue is full. */
export type ConnectStreamWriter = Readonly<{
  close(final?: Readonly<{ data: unknown; event: string }>): void;
  send(event: string, data: unknown): boolean;
}>;

/**
 * What the relay tells in-process listeners: `device` carries the owner's
 * browser projection of one computer after it came online, went offline or
 * reported its `device_info`; `devices_changed` asks one account's lists to
 * reload after a device was added or removed; `closed` ends every browser
 * device-list stream.
 */
export type ConnectRelayEvent =
  | Readonly<{ computer: ConnectComputerWire; deviceId: string; type: "device"; userId: string }>
  | Readonly<{ type: "devices_changed"; userId: string }>
  | Readonly<{ code: ConnectEventsStreamClosedCode; type: "closed" }>;

export type ConnectRelayListener = (event: ConnectRelayEvent) => void;

export type ConnectAttachDeviceResult = Readonly<{ kind: "attached"; streamId: string }> | Readonly<{ kind: "stale" }>;

/** One operation for {@link ConnectRelay.callOp}; the caller has checked the switch and bounded `args`. */
export type ConnectRelayOpCall = Readonly<{
  args: ConnectOpArgs;
  deviceId: string;
  op: ConnectOp;
  runId: string;
  signal: AbortSignal;
  timeoutMs: number;
  userId: string;
}>;

/** Open device-list streams per account. */
export const CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER = 16;
/**
 * How long the relay waits past an operation's `deadlineMs` before it gives
 * up: the device answers `computer_timeout` itself at the deadline, and this
 * leaves its reply time to arrive.
 */
export const CONNECT_OP_REPLY_GRACE_MS = 2_000;
/**
 * One `op` command as JSON. Contract bounds allow a megabyte of content and
 * as much of each edit string; escaping can grow that several times, and a
 * command beyond this is refused before it would stall the device's stream.
 */
export const CONNECT_MAX_OP_COMMAND_BYTES = 8_388_608;
/**
 * `run_ended` commands kept per device while it has no stream to take them
 * (offline, or its stream was gone), sent right after its next `hello`. A
 * background job of a run whose `run_ended` is lost anyway (a server restart)
 * ends by the device's own lease.
 */
export const CONNECT_RELAY_MAX_UNDELIVERED_RUN_ENDS = 256;
/** How long an undelivered `run_ended` is kept. */
export const CONNECT_RELAY_UNDELIVERED_RUN_END_TTL_MS = 24 * 60 * 60 * 1000;
/** Devices with undelivered `run_ended` commands; the one waiting longest is dropped beyond it. */
export const CONNECT_RELAY_MAX_UNDELIVERED_DEVICES = 4_096;

type PendingOp = Readonly<{
  op: ConnectOp;
  settle: (outcome: ComputerOpOutcome) => void;
}>;

/**
 * The operations waiting on one device. They outlive its streams: the device
 * keeps running an operation across a reconnect and posts the reply on its
 * next stream, so only the deadline, an abort, revocation or the switch-off
 * fail them.
 */
type DevicePending = Readonly<{ ops: Map<string, PendingOp>; userId: string }>;

/** A `run_ended` that found no stream; `userId` is the caller's, checked against the device's owner on delivery. */
type UndeliveredRunEnd = Readonly<{ at: number; runId: string; userId: string }>;

type OnlineDevice = {
  /** `device_info` of this stream; null until the device reports it. */
  info: ConnectComputerInfoWire | null;
  record: ConnectDeviceRecord;
  readonly streamId: string;
  readonly tokenHash: string;
  readonly writer: ConnectStreamWriter;
};

/** How a stream ends; `failPending` fails the device's waiting operations (revocation, switch-off). */
type DeviceEnd = Readonly<{
  failPending?: ComputerFailureCode;
  final?: Readonly<{ data: unknown; event: string }>;
}>;

export type ConnectRelay = ReturnType<typeof createConnectRelay>;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function computerWire(record: ConnectDeviceRecord, online: boolean, info: ConnectComputerInfoWire | null): ConnectComputerWire {
  return {
    arch: record.arch,
    clientVersion: record.clientVersion,
    id: record.id,
    ...(online && info ? { info } : {}),
    lastSeenAt: iso(record.lastSeenAt),
    name: record.name,
    online,
    os: record.os
  };
}

function failure(code: ComputerFailureCode, sent: boolean): ComputerOpOutcome {
  return { code, ok: false, sent };
}

/**
 * The in-memory relay between paired devices and the server: online device
 * streams, the operations waiting for their replies, the `run_ended`
 * commands a device has yet to receive and what each device reported about
 * itself. Nothing it holds is persisted or logged: operation arguments and
 * results pass through bounded queues only. It assumes the single
 * application process (D-01).
 */
export function createConnectRelay(options: Readonly<{ now?: () => number }> = {}) {
  const now = options.now ?? Date.now;
  const devices = new Map<string, OnlineDevice>();
  const pendingByDevice = new Map<string, DevicePending>();
  const undeliveredRunEnds = new Map<string, UndeliveredRunEnd[]>();
  const deviceIdsByToken = new Map<string, string>();
  const listeners = new Set<ConnectRelayListener>();
  const eventsStreams = new Map<string, number>();
  let epoch = 0;

  function emit(event: ConnectRelayEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One failing listener never breaks the relay or another listener.
      }
    }
  }

  function emitDevice(device: OnlineDevice, online: boolean): void {
    emit({
      computer: computerWire(device.record, online, device.info),
      deviceId: device.record.id,
      type: "device",
      userId: device.record.userId
    });
  }

  function current(device: OnlineDevice): boolean {
    return devices.get(device.record.id) === device;
  }

  /** Enqueues a command; a device that stopped reading loses its stream and reconnects. */
  function sendCommand(device: OnlineDevice, command: ConnectServerCommandV2): boolean {
    if (!current(device)) return false;
    if (device.writer.send("command", command)) return true;
    logConnect({ action: "retry", code: "connect_device_queue_full", outcome: "failed", stage: "dispatch" });
    endDevice(device, {});
    return false;
  }

  /** Every operation still waiting on the device: it may have started them. */
  function failPending(deviceId: string, code: ComputerFailureCode): void {
    const entry = pendingByDevice.get(deviceId);
    if (!entry) return;
    pendingByDevice.delete(deviceId);
    for (const pending of [...entry.ops.values()]) pending.settle(failure(code, true));
  }

  /** The device's waiting operations, only while they are its owner's. */
  function devicePending(device: OnlineDevice): Map<string, PendingOp> | null {
    const entry = pendingByDevice.get(device.record.id);
    return entry && entry.userId === device.record.userId ? entry.ops : null;
  }

  /** Ends a device stream that is still current; its owner sees it offline. */
  function endDevice(device: OnlineDevice, end: DeviceEnd): void {
    if (!current(device)) return;
    devices.delete(device.record.id);
    if (deviceIdsByToken.get(device.tokenHash) === device.record.id) deviceIdsByToken.delete(device.tokenHash);
    device.writer.close(end.final);
    if (end.failPending) failPending(device.record.id, end.failPending);
    emitDevice(device, false);
  }

  function freshRunEnds(entries: readonly UndeliveredRunEnd[]): UndeliveredRunEnd[] {
    const oldest = now() - CONNECT_RELAY_UNDELIVERED_RUN_END_TTL_MS;
    return entries.filter((entry) => entry.at > oldest);
  }

  /** Keeps a `run_ended` the device could not take, bounded per device and in devices. */
  function rememberRunEnd(deviceId: string, runId: string, userId: string): void {
    const entries = freshRunEnds(undeliveredRunEnds.get(deviceId) ?? []);
    if (!entries.some((entry) => entry.runId === runId && entry.userId === userId)) entries.push({ at: now(), runId, userId });
    // Reinserted, so the map's first key is the device waiting longest.
    undeliveredRunEnds.delete(deviceId);
    undeliveredRunEnds.set(deviceId, entries.slice(-CONNECT_RELAY_MAX_UNDELIVERED_RUN_ENDS));
    while (undeliveredRunEnds.size > CONNECT_RELAY_MAX_UNDELIVERED_DEVICES) {
      undeliveredRunEnds.delete(undeliveredRunEnds.keys().next().value!);
    }
  }

  /**
   * Sends the device's undelivered `run_ended` commands on its new stream.
   * Only those its owner's runs asked for go; the others are dropped. What a
   * full queue refuses waits for the next stream.
   */
  function deliverRunEnds(device: OnlineDevice): void {
    const entries = undeliveredRunEnds.get(device.record.id);
    if (!entries) return;
    undeliveredRunEnds.delete(device.record.id);
    const owned = freshRunEnds(entries).filter((entry) => entry.userId === device.record.userId);
    for (const [index, entry] of owned.entries()) {
      if (!sendCommand(device, { runId: entry.runId, type: "run_ended" })) {
        undeliveredRunEnds.set(device.record.id, owned.slice(index));
        return;
      }
    }
  }

  function applyEvent(device: OnlineDevice, event: ConnectDeviceEventV2): void {
    switch (event.type) {
      case "device_info": {
        device.info = { home: event.home, osVersion: event.osVersion, shell: event.shell };
        emitDevice(device, true);
        return;
      }
      case "reply": {
        // A reply to an operation that already settled (timeout, cancel) or was never sent is ignored.
        const pending = devicePending(device)?.get(event.requestId);
        if (!pending) return;
        if (connectUtf8ByteLength(JSON.stringify(event)) > CONNECT_MAX_REPLY_BYTES) {
          logConnect({ action: "fail", code: "connect_reply_invalid", outcome: "failed", stage: "validate" });
          pending.settle(failure("connect_device_error", true));
          return;
        }
        if (!event.ok) {
          pending.settle(failure(event.code, true));
          return;
        }
        const result = parseConnectOpResult(pending.op, event.result);
        if (result === null) {
          logConnect({ action: "fail", code: "connect_reply_invalid", outcome: "failed", stage: "validate" });
          pending.settle(failure("connect_device_error", true));
          return;
        }
        pending.settle({ ok: true, result });
        return;
      }
    }
  }

  function tokenDevice(tokenHash: string): OnlineDevice | null {
    const deviceId = deviceIdsByToken.get(tokenHash);
    const device = deviceId ? devices.get(deviceId) : undefined;
    return device && device.tokenHash === tokenHash ? device : null;
  }

  function ownedDevice(userId: string, deviceId: string): OnlineDevice | null {
    const device = devices.get(deviceId);
    return device && device.record.userId === userId ? device : null;
  }

  function endAll(end: DeviceEnd): void {
    for (const device of [...devices.values()]) endDevice(device, end);
  }

  return {
    /** Read before a stream's database checks; a revocation or switch-off in between makes the attach stale. */
    epoch(): number {
      return epoch;
    },

    /**
     * Makes a stream the device's current one and sends `hello` first, then
     * the `run_ended` commands the device has yet to receive. A previous
     * stream gets `replaced`; the device's waiting operations keep waiting
     * for their replies on the new stream.
     */
    attachDevice(input: Readonly<{
      epoch: number;
      hello: ConnectHelloV2;
      record: ConnectDeviceRecord;
      tokenHash: string;
      writer: ConnectStreamWriter;
    }>): ConnectAttachDeviceResult {
      if (input.epoch !== epoch) return { kind: "stale" };
      const previous = devices.get(input.record.id);
      const device: OnlineDevice = {
        info: null,
        record: input.record,
        streamId: randomUUID(),
        tokenHash: input.tokenHash,
        writer: input.writer
      };
      devices.set(device.record.id, device);
      deviceIdsByToken.set(device.tokenHash, device.record.id);
      input.writer.send("hello", input.hello);
      if (previous) {
        if (previous.tokenHash !== device.tokenHash && deviceIdsByToken.get(previous.tokenHash) === device.record.id) {
          deviceIdsByToken.delete(previous.tokenHash);
        }
        previous.writer.close({ data: {}, event: "replaced" });
      }
      // Operations of another owner never wait on this device's streams.
      const waiting = pendingByDevice.get(device.record.id);
      if (waiting && waiting.userId !== device.record.userId) failPending(device.record.id, "connect_device_disconnected");
      emitDevice(device, true);
      deliverRunEnds(device);
      return { kind: "attached", streamId: device.streamId };
    },

    /**
     * The device's stream ended (client, network or server close). Its
     * waiting operations keep waiting: the device posts their replies on its
     * next stream, or their deadline fails them.
     */
    detachDevice(deviceId: string, streamId: string): void {
      const device = devices.get(deviceId);
      if (device && device.streamId === streamId) endDevice(device, {});
    },

    /** Keeps the online record current after the stream refreshed `lastSeenAt`. */
    markDeviceSeen(deviceId: string, streamId: string, lastSeenAt: Date): void {
      const device = devices.get(deviceId);
      if (device && device.streamId === streamId) device.record = { ...device.record, lastSeenAt };
    },

    /** Ends one stream of a device with `closed {code}`, unless a newer stream already replaced it. */
    closeDeviceStream(deviceId: string, streamId: string, code: ConnectDeviceStreamClosedCode): void {
      const device = devices.get(deviceId);
      if (!device || device.streamId !== streamId) return;
      epoch += 1;
      endDevice(device, {
        failPending: code === "connect_disabled" ? "connect_disabled" : "connect_device_disconnected",
        final: { data: { code }, event: "closed" }
      });
    },

    /** Whether the token's device has an open stream; events need one. */
    hasDeviceStream(tokenHash: string): boolean {
      return deviceIdsByToken.has(tokenHash);
    },

    /**
     * Applies a validated batch from the device holding `tokenHash`, in order.
     * Operations of other devices are invisible to it. False without an open
     * stream.
     */
    acceptEvents(tokenHash: string, events: readonly ConnectDeviceEventV2[]): boolean {
      const device = tokenDevice(tokenHash);
      if (!device) return false;
      for (const event of events) {
        if (!current(device)) break;
        applyEvent(device, event);
      }
      return true;
    },

    /**
     * Settles operations whose reply the device sent in a malformed batch, so
     * they fail now as `connect_device_error` instead of waiting for their
     * deadline. Only the token's own device's operations are reachable.
     */
    rejectReplies(tokenHash: string, requestIds: readonly string[]): void {
      const device = tokenDevice(tokenHash);
      if (!device) return;
      for (const requestId of requestIds) {
        const pending = devicePending(device)?.get(requestId);
        if (!pending) continue;
        logConnect({ action: "fail", code: "connect_reply_invalid", outcome: "failed", stage: "validate" });
        pending.settle(failure("connect_device_error", true));
      }
    },

    /** The owner's browser projection of a stored device: online with what it reported while its stream is open. */
    projectComputer(record: ConnectDeviceRecord): ConnectComputerWire {
      const device = ownedDevice(record.userId, record.id);
      return device ? computerWire(device.record, true, device.info) : computerWire(record, false, null);
    },

    /** The user's own device while its stream is open; null when it is offline, missing or someone else's. */
    onlineDevice(userId: string, deviceId: string): Readonly<{ info: ConnectComputerInfoWire | null; record: ConnectDeviceRecord }> | null {
      const device = ownedDevice(userId, deviceId);
      return device ? { info: device.info, record: device.record } : null;
    },

    /**
     * Sends one operation to the user's own online device and waits for its
     * reply, at most its deadline and a short grace, also across a reconnect
     * of the device. Null when the device has no open stream of this user
     * (offline, missing or someone else's: the caller tells them apart). An
     * abort or the deadline sends `cancel` to the device's current stream
     * and settles at once; a reply that arrives later is ignored.
     */
    callOp(input: ConnectRelayOpCall): Promise<ComputerOpOutcome> | null {
      const owned = ownedDevice(input.userId, input.deviceId);
      if (!owned) return null;
      // Narrowed once for the closures below, which TypeScript does not narrow.
      const device: OnlineDevice = owned;
      if (input.signal.aborted) return Promise.resolve(failure("computer_cancelled", false));
      if ((devicePending(device)?.size ?? 0) >= CONNECT_MAX_CONCURRENT_OPS) {
        logConnect({ action: "skip", code: "computer_limit", outcome: "blocked", stage: "dispatch" });
        return Promise.resolve(failure("computer_limit", false));
      }
      const requestId = randomUUID();
      const deadlineMs = Math.min(CONNECT_MAX_OP_DEADLINE_MS, Math.max(1, Math.ceil(input.timeoutMs)));
      const command: ConnectServerCommandV2 = {
        args: input.args,
        deadlineMs,
        op: input.op,
        requestId,
        runId: input.runId,
        type: "op"
      } as ConnectServerCommandV2;
      if (connectUtf8ByteLength(JSON.stringify(command)) > CONNECT_MAX_OP_COMMAND_BYTES) {
        logConnect({ action: "skip", code: "computer_file_too_large", outcome: "blocked", stage: "dispatch" });
        return Promise.resolve(failure("computer_file_too_large", false));
      }
      // A failed send ends the stream; the command never reached the device.
      if (!sendCommand(device, command)) return Promise.resolve(failure("connect_device_disconnected", false));
      const startedAt = now();
      return new Promise<ComputerOpOutcome>((resolve) => {
        let settled = false;
        const cancel = () => {
          const online = ownedDevice(input.userId, input.deviceId);
          if (online) sendCommand(online, { requestId, type: "cancel" });
        };
        const timer = setTimeout(() => {
          logConnect({ action: "stop", code: "computer_timeout", durationMs: now() - startedAt, outcome: "failed", stage: "dispatch" });
          settle(failure("computer_timeout", true));
          cancel();
        }, deadlineMs + CONNECT_OP_REPLY_GRACE_MS);
        timer.unref?.();
        const onAbort = () => {
          settle(failure("computer_cancelled", true));
          cancel();
        };
        const entry: PendingOp = { op: input.op, settle };
        function settle(outcome: ComputerOpOutcome): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
          const waiting = pendingByDevice.get(input.deviceId);
          if (waiting?.ops.get(requestId) === entry) {
            waiting.ops.delete(requestId);
            if (waiting.ops.size === 0) pendingByDevice.delete(input.deviceId);
          }
          resolve(outcome);
        }
        let waiting = pendingByDevice.get(input.deviceId);
        if (!waiting) {
          waiting = { ops: new Map(), userId: input.userId };
          pendingByDevice.set(input.deviceId, waiting);
        }
        waiting.ops.set(requestId, entry);
        input.signal.addEventListener("abort", onAbort, { once: true });
      });
    },

    /**
     * Tells the user's own device that a run is over. While it has no stream
     * to take the command, it waits for the device's next `hello`, sent then
     * only when the device is still this user's; nothing when the online
     * device is someone else's.
     */
    runEnded(input: Readonly<{ deviceId: string; runId: string; userId: string }>): void {
      const device = devices.get(input.deviceId);
      if (device && device.record.userId !== input.userId) return;
      if (device && sendCommand(device, { runId: input.runId, type: "run_ended" })) return;
      rememberRunEnd(input.deviceId, input.runId, input.userId);
    },

    /**
     * The device was revoked: its stream gets `closed {code}` and ends at
     * once, and its waiting operations fail.
     */
    disconnectDevice(deviceId: string, code: ConnectDeviceStreamClosedCode): void {
      epoch += 1;
      const pendingCode: ComputerFailureCode = code === "connect_disabled" ? "connect_disabled" : "connect_device_disconnected";
      // A revoked device never connects again; an offline one stops everything when it is refused.
      if (code === "connect_unauthorized") undeliveredRunEnds.delete(deviceId);
      const device = devices.get(deviceId);
      if (device) endDevice(device, { failPending: pendingCode, final: { data: { code }, event: "closed" } });
      failPending(deviceId, pendingCode);
    },

    /**
     * The account lost its devices: every device stream of theirs gets
     * `closed {connect_unauthorized}` (its token is gone) and their lists
     * reload.
     */
    disconnectUser(userId: string): void {
      epoch += 1;
      for (const device of [...devices.values()]) {
        if (device.record.userId === userId) {
          endDevice(device, {
            failPending: "connect_device_disconnected",
            final: { data: { code: "connect_unauthorized" }, event: "closed" }
          });
        }
      }
      for (const [deviceId, entry] of [...pendingByDevice]) {
        if (entry.userId === userId) failPending(deviceId, "connect_device_disconnected");
      }
      for (const [deviceId, entries] of [...undeliveredRunEnds]) {
        const kept = entries.filter((entry) => entry.userId !== userId);
        if (kept.length > 0) undeliveredRunEnds.set(deviceId, kept);
        else undeliveredRunEnds.delete(deviceId);
      }
      emit({ type: "devices_changed", userId });
    },

    /** Every session of the installation was revoked: all device streams and device lists end as unauthorized. */
    disconnectAll(): void {
      epoch += 1;
      endAll({ failPending: "connect_device_disconnected", final: { data: { code: "connect_unauthorized" }, event: "closed" } });
      for (const deviceId of [...pendingByDevice.keys()]) failPending(deviceId, "connect_device_disconnected");
      emit({ code: "connect_unauthorized", type: "closed" });
    },

    /** The administrator turned AIQSA Connect off: everything ends with `connect_disabled`. */
    disable(): void {
      epoch += 1;
      endAll({ failPending: "connect_disabled", final: { data: { code: "connect_disabled" }, event: "closed" } });
      for (const deviceId of [...pendingByDevice.keys()]) failPending(deviceId, "connect_disabled");
      emit({ code: "connect_disabled", type: "closed" });
    },

    /** A device was added to or removed from the account: its device lists reload. */
    notifyDevicesChanged(userId: string): void {
      emit({ type: "devices_changed", userId });
    },

    /** Reserves one device-list stream of the account; false at the per-account limit. */
    acquireEventsStream(userId: string): boolean {
      const open = eventsStreams.get(userId) ?? 0;
      if (open >= CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER) return false;
      eventsStreams.set(userId, open + 1);
      return true;
    },

    releaseEventsStream(userId: string): void {
      const open = (eventsStreams.get(userId) ?? 0) - 1;
      if (open > 0) eventsStreams.set(userId, open);
      else eventsStreams.delete(userId);
    },

    onEvent(listener: ConnectRelayListener): () => void {
      const subscription: ConnectRelayListener = (event) => listener(event);
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    },

    /** Counts for tests and bounded diagnostics; never identifiers or content. */
    size(): Readonly<{ devices: number; listeners: number; pendingOps: number }> {
      let pendingOps = 0;
      for (const entry of pendingByDevice.values()) pendingOps += entry.ops.size;
      return { devices: devices.size, listeners: listeners.size, pendingOps };
    },

    /** Undelivered `run_ended` commands, for tests; a count, never identifiers. */
    undeliveredRunEndCount(): number {
      let count = 0;
      for (const entries of undeliveredRunEnds.values()) count += entries.length;
      return count;
    }
  };
}

const globalForConnectRelay = globalThis as typeof globalThis & { __aiqsaConnectRelay?: ConnectRelay };

/** The relay of this application process, shared by every route bundle (single replica). */
export function getConnectRelay(): ConnectRelay {
  return globalForConnectRelay.__aiqsaConnectRelay ??= createConnectRelay();
}
