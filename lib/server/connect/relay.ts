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

type PendingOp = Readonly<{
  op: ConnectOp;
  settle: (outcome: ComputerOpOutcome) => void;
}>;

type OnlineDevice = {
  /** `device_info` of this stream; null until the device reports it. */
  info: ConnectComputerInfoWire | null;
  readonly pending: Map<string, PendingOp>;
  record: ConnectDeviceRecord;
  readonly streamId: string;
  readonly tokenHash: string;
  readonly writer: ConnectStreamWriter;
};

type DeviceEnd = Readonly<{
  final?: Readonly<{ data: unknown; event: string }>;
  pendingCode: ComputerFailureCode;
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
 * streams, the operations waiting for their replies and what each device
 * reported about itself. Nothing it holds is persisted or logged: operation
 * arguments and results pass through bounded queues only. It assumes the
 * single application process (D-01).
 */
export function createConnectRelay(options: Readonly<{ now?: () => number }> = {}) {
  const now = options.now ?? Date.now;
  const devices = new Map<string, OnlineDevice>();
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
    endDevice(device, { pendingCode: "connect_device_disconnected" });
    return false;
  }

  /** Every operation still waiting on the stream: the device may have started it. */
  function failPending(device: OnlineDevice, code: ComputerFailureCode): void {
    const pending = [...device.pending.values()];
    device.pending.clear();
    for (const entry of pending) entry.settle(failure(code, true));
  }

  /** Ends a device stream that is still current: its operations fail and its owner sees it offline. */
  function endDevice(device: OnlineDevice, end: DeviceEnd): void {
    if (!current(device)) return;
    devices.delete(device.record.id);
    if (deviceIdsByToken.get(device.tokenHash) === device.record.id) deviceIdsByToken.delete(device.tokenHash);
    device.writer.close(end.final);
    failPending(device, end.pendingCode);
    emitDevice(device, false);
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
        const pending = device.pending.get(event.requestId);
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
     * Makes a stream the device's current one and sends `hello` first. A
     * previous stream gets `replaced` and its waiting operations fail as
     * `connect_device_disconnected`.
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
        pending: new Map(),
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
        failPending(previous, "connect_device_disconnected");
      }
      emitDevice(device, true);
      return { kind: "attached", streamId: device.streamId };
    },

    /** The device's stream ended (client, network or server close). */
    detachDevice(deviceId: string, streamId: string): void {
      const device = devices.get(deviceId);
      if (device && device.streamId === streamId) endDevice(device, { pendingCode: "connect_device_disconnected" });
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
        final: { data: { code }, event: "closed" },
        pendingCode: code === "connect_disabled" ? "connect_disabled" : "connect_device_disconnected"
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
        const pending = device.pending.get(requestId);
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
     * reply, at most its deadline and a short grace. Null when the device has
     * no open stream of this user (offline, missing or someone else's: the
     * caller tells them apart). An abort or the deadline sends `cancel` and
     * settles at once; a reply that arrives later is ignored.
     */
    callOp(input: ConnectRelayOpCall): Promise<ComputerOpOutcome> | null {
      const device = ownedDevice(input.userId, input.deviceId);
      if (!device) return null;
      if (input.signal.aborted) return Promise.resolve(failure("computer_cancelled", false));
      if (device.pending.size >= CONNECT_MAX_CONCURRENT_OPS) {
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
          if (current(device)) sendCommand(device, { requestId, type: "cancel" });
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
          if (device.pending.get(requestId) === entry) device.pending.delete(requestId);
          resolve(outcome);
        }
        device.pending.set(requestId, entry);
        input.signal.addEventListener("abort", onAbort, { once: true });
      });
    },

    /** Tells the user's own online device that a run is over; nothing when it is offline or someone else's. */
    runEnded(input: Readonly<{ deviceId: string; runId: string; userId: string }>): void {
      const device = ownedDevice(input.userId, input.deviceId);
      if (device) sendCommand(device, { runId: input.runId, type: "run_ended" });
    },

    /** The device was revoked: its stream gets `closed {code}` and ends at once. */
    disconnectDevice(deviceId: string, code: ConnectDeviceStreamClosedCode): void {
      epoch += 1;
      const device = devices.get(deviceId);
      if (!device) return;
      endDevice(device, {
        final: { data: { code }, event: "closed" },
        pendingCode: code === "connect_disabled" ? "connect_disabled" : "connect_device_disconnected"
      });
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
            final: { data: { code: "connect_unauthorized" }, event: "closed" },
            pendingCode: "connect_device_disconnected"
          });
        }
      }
      emit({ type: "devices_changed", userId });
    },

    /** Every session of the installation was revoked: all device streams and device lists end as unauthorized. */
    disconnectAll(): void {
      epoch += 1;
      endAll({ final: { data: { code: "connect_unauthorized" }, event: "closed" }, pendingCode: "connect_device_disconnected" });
      emit({ code: "connect_unauthorized", type: "closed" });
    },

    /** The administrator turned AIQSA Connect off: everything ends with `connect_disabled`. */
    disable(): void {
      epoch += 1;
      endAll({ final: { data: { code: "connect_disabled" }, event: "closed" }, pendingCode: "connect_disabled" });
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
      for (const device of devices.values()) pendingOps += device.pending.size;
      return { devices: devices.size, listeners: listeners.size, pendingOps };
    }
  };
}

const globalForConnectRelay = globalThis as typeof globalThis & { __aiqsaConnectRelay?: ConnectRelay };

/** The relay of this application process, shared by every route bundle (single replica). */
export function getConnectRelay(): ConnectRelay {
  return globalForConnectRelay.__aiqsaConnectRelay ??= createConnectRelay();
}
