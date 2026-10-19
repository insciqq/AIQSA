import { randomUUID } from "node:crypto";
import {
  CONNECT_MAX_VIEWS_PER_DEVICE,
  CONNECT_REPLY_TIMEOUT_SECONDS,
  CONNECT_VIEW_ORPHAN_TIMEOUT_SECONDS,
  parseConnectCommandResult,
  type ConnectArch,
  type ConnectCommandResult,
  type ConnectDevice,
  type ConnectDeviceEvent,
  type ConnectDeviceStreamClosedCode,
  type ConnectEventsStreamClosedCode,
  type ConnectHello,
  type ConnectOs,
  type ConnectReasonCode,
  type ConnectRequestCommandType,
  type ConnectServerCommand,
  type ConnectSession,
  type ConnectSessionStatus,
  type ConnectStatusReason,
  type ConnectViewStreamClosedReason
} from "@/lib/contracts/connect";
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

/** A view belongs to one account and the browser session that opened it. */
export type ConnectViewOwner = Readonly<{ authSessionId: string; userId: string }>;

/**
 * What the relay tells in-process listeners. Device events carry the full
 * browser projection of the device; `status` also names the session title
 * and its previous status for notification consumers. `closed` ends every
 * browser device-list stream; `devices_changed` asks one account's lists to
 * reload, after a device was added or removed.
 */
export type ConnectRelayEvent =
  | Readonly<{ device: ConnectDevice; deviceId: string; type: "device_online"; userId: string }>
  | Readonly<{ device: ConnectDevice; deviceId: string; type: "device_offline"; userId: string }>
  | Readonly<{
    device: ConnectDevice;
    deviceId: string;
    sessions: readonly ConnectSession[];
    type: "sessions";
    userId: string;
  }>
  | Readonly<{
    device: ConnectDevice;
    deviceId: string;
    previousStatus: ConnectSessionStatus;
    reason: ConnectStatusReason | null;
    sessionId: string;
    status: ConnectSessionStatus;
    statusAt: string;
    title: string;
    type: "status";
    userId: string;
  }>
  | Readonly<{ type: "devices_changed"; userId: string }>
  | Readonly<{ code: ConnectEventsStreamClosedCode; type: "closed" }>;

export type ConnectRelayListener = (event: ConnectRelayEvent) => void;

type RequestCommand = Extract<ConnectServerCommand, { requestId: string }>;
export type ConnectRequestCommand<T extends ConnectRequestCommandType> = Omit<Extract<RequestCommand, { type: T }>, "requestId">;
export type ConnectRequestOutcome<T extends ConnectRequestCommandType> =
  | Readonly<{ ok: true; result: ConnectCommandResult<T> }>
  | Readonly<{ code: ConnectReasonCode; ok: false }>;

export type ConnectAttachDeviceResult = Readonly<{ kind: "attached"; streamId: string }> | Readonly<{ kind: "stale" }>;

/** Requests waiting for one device's reply; the browser gets `connect_rate_limited` beyond it. */
export const CONNECT_RELAY_MAX_PENDING_REPLIES = 32;
/** Open device-list streams per account. */
export const CONNECT_RELAY_MAX_EVENTS_STREAMS_PER_USER = 16;
/** Output kept for a view whose browser stream is not attached yet (or reconnecting). */
export const CONNECT_RELAY_VIEW_BUFFER_BYTES = 1_048_576;
/** A view counts as on screen this long after its browser last reported it visible. */
export const CONNECT_VIEW_VISIBLE_WINDOW_MS = 30_000;
const REPLY_TIMEOUT_MS = CONNECT_REPLY_TIMEOUT_SECONDS * 1000;
const VIEW_ORPHAN_TIMEOUT_MS = CONNECT_VIEW_ORPHAN_TIMEOUT_SECONDS * 1000;

type PendingReply = {
  readonly resolve: (outcome: ConnectRequestOutcome<ConnectRequestCommandType>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly type: ConnectRequestCommandType;
};

type OnlineDevice = {
  readonly pending: Map<string, PendingReply>;
  record: ConnectDeviceRecord;
  sessions: readonly ConnectSession[] | null;
  readonly streamId: string;
  readonly tokenHash: string;
  readonly viewIds: Set<string>;
  readonly writer: ConnectStreamWriter;
};

type OutputFrame = Readonly<{ data: string; seq: number }>;

type ViewState = {
  readonly authSessionId: string;
  buffer: OutputFrame[];
  bufferBytes: number;
  readonly deviceId: string;
  readonly id: string;
  lastVisibleAt: number | null;
  nextSeq: number;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  readonly sessionId: string;
  readonly userId: string;
  visible: boolean;
  writer: Readonly<{ id: string; stream: ConnectStreamWriter }> | null;
};

type DeviceEnd = Readonly<{
  final?: Readonly<{ data: unknown; event: string }>;
  pendingCode: ConnectReasonCode;
  viewReason: ConnectViewStreamClosedReason;
}>;

export type ConnectRelay = ReturnType<typeof createConnectRelay>;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function deviceWire(record: ConnectDeviceRecord, online: boolean, sessions: readonly ConnectSession[] | null): ConnectDevice {
  return {
    arch: record.arch,
    clientVersion: record.clientVersion,
    createdAt: record.createdAt.toISOString(),
    hostname: record.hostname,
    id: record.id,
    lastSeenAt: iso(record.lastSeenAt),
    name: record.name,
    online,
    os: record.os,
    sessions: online && sessions ? [...sessions] : []
  };
}

function ownedBy(view: ViewState, owner: ConnectViewOwner): boolean {
  return view.userId === owner.userId && view.authSessionId === owner.authSessionId;
}

/**
 * The in-memory relay between paired devices and their owners' browsers. It
 * holds online device streams, request/reply correlation and terminal views,
 * and nothing it holds is persisted or logged: terminal bytes pass through
 * bounded queues only. It assumes the single application process.
 */
export function createConnectRelay(options: Readonly<{ now?: () => number }> = {}) {
  const now = options.now ?? Date.now;
  const devices = new Map<string, OnlineDevice>();
  const deviceIdsByToken = new Map<string, string>();
  const views = new Map<string, ViewState>();
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

  function wire(device: OnlineDevice): ConnectDevice {
    return deviceWire(device.record, true, device.sessions);
  }

  function current(device: OnlineDevice): boolean {
    return devices.get(device.record.id) === device;
  }

  /** Enqueues a command; a device that stopped reading loses its stream and reconnects. */
  function sendCommand(device: OnlineDevice, command: ConnectServerCommand): boolean {
    if (!current(device)) return false;
    if (device.writer.send("command", command)) return true;
    logConnect({ action: "retry", code: "connect_device_queue_full", outcome: "failed", stage: "dispatch" });
    endDevice(device, { pendingCode: "connect_device_offline", viewReason: "connect_device_offline" });
    return false;
  }

  function failPending(device: OnlineDevice, code: ConnectReasonCode): void {
    const pending = [...device.pending.values()];
    device.pending.clear();
    for (const reply of pending) {
      clearTimeout(reply.timer);
      reply.resolve({ code, ok: false });
    }
  }

  function startOrphanTimer(view: ViewState): void {
    if (view.orphanTimer) clearTimeout(view.orphanTimer);
    const timer = setTimeout(() => {
      const latest = views.get(view.id);
      if (latest === view && view.writer === null && view.orphanTimer === timer) closeView(view, "detached", true);
    }, VIEW_ORPHAN_TIMEOUT_MS);
    timer.unref?.();
    view.orphanTimer = timer;
  }

  /** Removes a view, tells its browser stream why and, unless the device ended it, tells the device. */
  function closeView(view: ViewState, reason: ConnectViewStreamClosedReason, notifyDevice: boolean): void {
    if (views.get(view.id) !== view) return;
    views.delete(view.id);
    if (view.orphanTimer) clearTimeout(view.orphanTimer);
    view.orphanTimer = null;
    view.buffer = [];
    view.bufferBytes = 0;
    const device = devices.get(view.deviceId);
    device?.viewIds.delete(view.id);
    const writer = view.writer;
    view.writer = null;
    writer?.stream.close({ data: { reason }, event: "closed" });
    if (notifyDevice && device) sendCommand(device, { type: "view_close", viewId: view.id });
  }

  function closeViews(viewIds: Iterable<string>, reason: ConnectViewStreamClosedReason, notifyDevice: boolean): void {
    for (const viewId of [...viewIds]) {
      const view = views.get(viewId);
      if (view) closeView(view, reason, notifyDevice);
    }
  }

  /** Ends a device stream that is still current: its replies fail, its views close and its owner sees it offline. */
  function endDevice(device: OnlineDevice, end: DeviceEnd): void {
    if (!current(device)) return;
    devices.delete(device.record.id);
    if (deviceIdsByToken.get(device.tokenHash) === device.record.id) deviceIdsByToken.delete(device.tokenHash);
    device.writer.close(end.final);
    failPending(device, end.pendingCode);
    closeViews(device.viewIds, end.viewReason, false);
    device.viewIds.clear();
    emit({
      device: deviceWire(device.record, false, null),
      deviceId: device.record.id,
      type: "device_offline",
      userId: device.record.userId
    });
  }

  /**
   * Forwards one chunk to the view's browser stream, or keeps it while no
   * stream is attached (a new view's first screen often arrives before the
   * browser's stream does). A stalled browser ends the view; it reopens.
   */
  function deliverOutput(view: ViewState, frame: OutputFrame): void {
    if (view.writer) {
      if (view.writer.stream.send("output", frame)) return;
      logConnect({ action: "retry", code: "connect_view_queue_full", outcome: "failed", stage: "dispatch" });
      closeView(view, "error", true);
      return;
    }
    if (view.bufferBytes + frame.data.length > CONNECT_RELAY_VIEW_BUFFER_BYTES) {
      logConnect({ action: "retry", code: "connect_view_queue_full", outcome: "failed", stage: "dispatch" });
      closeView(view, "error", true);
      return;
    }
    view.buffer.push(frame);
    view.bufferBytes += frame.data.length;
  }

  function applyEvent(device: OnlineDevice, event: ConnectDeviceEvent): void {
    switch (event.type) {
      case "sessions": {
        device.sessions = [...event.sessions];
        emit({
          device: wire(device),
          deviceId: device.record.id,
          sessions: device.sessions,
          type: "sessions",
          userId: device.record.userId
        });
        return;
      }
      case "status": {
        const sessions = device.sessions;
        const index = sessions?.findIndex((session) => session.id === event.sessionId) ?? -1;
        if (!sessions || index < 0) return;
        const previous = sessions[index]!;
        device.sessions = sessions.map((session, position) =>
          position === index ? { ...session, status: event.status, statusAt: event.statusAt } : session);
        emit({
          device: wire(device),
          deviceId: device.record.id,
          previousStatus: previous.status,
          reason: event.reason ?? null,
          sessionId: event.sessionId,
          status: event.status,
          statusAt: event.statusAt,
          title: previous.title,
          type: "status",
          userId: device.record.userId
        });
        return;
      }
      case "output": {
        const view = views.get(event.viewId);
        // Another device's view is invisible to this one: its token never reaches foreign views.
        if (!view || view.deviceId !== device.record.id) return;
        if (event.seq < view.nextSeq) return;
        if (event.seq > view.nextSeq) {
          // A lost chunk would corrupt the screen; a new view redraws it.
          logConnect({ action: "retry", code: "connect_view_seq_gap", outcome: "failed", stage: "validate" });
          closeView(view, "error", true);
          return;
        }
        view.nextSeq += 1;
        deliverOutput(view, { data: event.data, seq: event.seq });
        return;
      }
      case "view_closed": {
        const view = views.get(event.viewId);
        if (view && view.deviceId === device.record.id) closeView(view, event.reason, false);
        return;
      }
      case "reply": {
        const pending = device.pending.get(event.requestId);
        if (!pending) return;
        device.pending.delete(event.requestId);
        clearTimeout(pending.timer);
        if (!event.ok) {
          pending.resolve({ code: event.code, ok: false });
          return;
        }
        const result = parseConnectCommandResult(pending.type, event.result);
        if (result === null) {
          logConnect({ action: "retry", code: "connect_reply_invalid", outcome: "failed", stage: "validate" });
          pending.resolve({ code: "connect_device_error", ok: false });
          return;
        }
        pending.resolve({ ok: true, result });
        return;
      }
    }
  }

  function ownedView(owner: ConnectViewOwner, viewId: string): ViewState | null {
    const view = views.get(viewId);
    return view && ownedBy(view, owner) ? view : null;
  }

  function endAll(end: DeviceEnd): void {
    for (const device of [...devices.values()]) endDevice(device, end);
    closeViews(views.keys(), end.viewReason, false);
  }

  return {
    /** Read before a stream's database checks; a revocation or switch-off in between makes the attach stale. */
    epoch(): number {
      return epoch;
    },

    /**
     * Makes a stream the device's current one and sends `hello` first. A
     * previous stream gets `replaced`; its views end (the browser reopens them)
     * and its unanswered requests fail.
     */
    attachDevice(input: Readonly<{
      epoch: number;
      hello: ConnectHello;
      record: ConnectDeviceRecord;
      tokenHash: string;
      writer: ConnectStreamWriter;
    }>): ConnectAttachDeviceResult {
      if (input.epoch !== epoch) return { kind: "stale" };
      const previous = devices.get(input.record.id);
      const device: OnlineDevice = {
        pending: new Map(),
        record: input.record,
        sessions: null,
        streamId: randomUUID(),
        tokenHash: input.tokenHash,
        viewIds: new Set(),
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
        failPending(previous, "connect_device_offline");
        // The new client may not know these views; the browser opens fresh ones.
        closeViews(previous.viewIds, "error", true);
        previous.viewIds.clear();
      }
      emit({ device: wire(device), deviceId: device.record.id, type: "device_online", userId: device.record.userId });
      return { kind: "attached", streamId: device.streamId };
    },

    /** The device's stream ended (client, network or server close). */
    detachDevice(deviceId: string, streamId: string): void {
      const device = devices.get(deviceId);
      if (device && device.streamId === streamId) {
        endDevice(device, { pendingCode: "connect_device_offline", viewReason: "connect_device_offline" });
      }
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
        pendingCode: code === "connect_disabled" ? "connect_disabled" : "connect_device_offline",
        viewReason: code === "connect_disabled" ? "connect_disabled" : "connect_device_offline"
      });
    },

    /** Whether the token's device has an open stream; events need one. */
    hasDeviceStream(tokenHash: string): boolean {
      return deviceIdsByToken.has(tokenHash);
    },

    /**
     * Applies a validated batch from the device holding `tokenHash`, in order.
     * Views and requests of other devices are invisible to it. False without
     * an open stream.
     */
    acceptEvents(tokenHash: string, events: readonly ConnectDeviceEvent[]): boolean {
      const deviceId = deviceIdsByToken.get(tokenHash);
      const device = deviceId ? devices.get(deviceId) : undefined;
      if (!device || device.tokenHash !== tokenHash) return false;
      for (const event of events) {
        if (!current(device)) break;
        applyEvent(device, event);
      }
      return true;
    },

    /** The browser projection of a stored device: online with its sessions while its stream is open. */
    projectDevice(record: ConnectDeviceRecord): ConnectDevice {
      const device = devices.get(record.id);
      return device && device.record.userId === record.userId
        ? deviceWire(device.record, true, device.sessions)
        : deviceWire(record, false, null);
    },

    /**
     * Sends a request command and waits up to the reply timeout. An offline
     * device answers `connect_device_offline` (the caller decides whether it
     * exists); another account's online device answers `connect_not_found`.
     */
    request<T extends ConnectRequestCommandType>(input: Readonly<{
      command: ConnectRequestCommand<T>;
      deviceId: string;
      userId: string;
    }>): Promise<ConnectRequestOutcome<T>> {
      const device = devices.get(input.deviceId);
      if (!device) return Promise.resolve({ code: "connect_device_offline", ok: false });
      if (device.record.userId !== input.userId) return Promise.resolve({ code: "connect_not_found", ok: false });
      if (device.pending.size >= CONNECT_RELAY_MAX_PENDING_REPLIES) {
        return Promise.resolve({ code: "connect_rate_limited", ok: false });
      }
      const requestId = randomUUID();
      return new Promise<ConnectRequestOutcome<T>>((resolve) => {
        const timer = setTimeout(() => {
          if (device.pending.get(requestId)?.timer !== timer) return;
          device.pending.delete(requestId);
          logConnect({ action: "retry", code: "connect_device_timeout", outcome: "failed", stage: "dispatch" });
          resolve({ code: "connect_device_timeout", ok: false });
        }, REPLY_TIMEOUT_MS);
        timer.unref?.();
        device.pending.set(requestId, {
          resolve: resolve as PendingReply["resolve"],
          timer,
          type: input.command.type
        });
        // A failed send ends the device, which fails this request too.
        sendCommand(device, { ...input.command, requestId } as RequestCommand);
      });
    },

    /** Opens a terminal view of a session on the owner's online device. */
    openView(input: Readonly<{
      cols: number;
      deviceId: string;
      owner: ConnectViewOwner;
      rows: number;
      sessionId: string;
    }>): Readonly<{ ok: true; viewId: string }> | Readonly<{ code: ConnectReasonCode; ok: false }> {
      const device = devices.get(input.deviceId);
      if (!device) return { code: "connect_device_offline", ok: false };
      if (device.record.userId !== input.owner.userId) return { code: "connect_not_found", ok: false };
      if (device.viewIds.size >= CONNECT_MAX_VIEWS_PER_DEVICE) return { code: "connect_view_limit", ok: false };
      const view: ViewState = {
        authSessionId: input.owner.authSessionId,
        buffer: [],
        bufferBytes: 0,
        deviceId: device.record.id,
        id: randomUUID(),
        // Opening a view is the browser showing it.
        lastVisibleAt: now(),
        nextSeq: 0,
        orphanTimer: null,
        sessionId: input.sessionId,
        userId: input.owner.userId,
        visible: true,
        writer: null
      };
      views.set(view.id, view);
      device.viewIds.add(view.id);
      startOrphanTimer(view);
      const opened = sendCommand(device, {
        cols: input.cols,
        rows: input.rows,
        sessionId: input.sessionId,
        type: "view_open",
        viewId: view.id
      });
      return opened ? { ok: true, viewId: view.id } : { code: "connect_device_offline", ok: false };
    },

    /**
     * Attaches the owner's browser stream to a view: output kept while it was
     * detached follows first. A newer stream replaces an older one.
     */
    attachView(input: Readonly<{ owner: ConnectViewOwner; viewId: string; writer: ConnectStreamWriter }>):
      Readonly<{ ok: true; writerId: string }> | Readonly<{ ok: false }> {
      const view = ownedView(input.owner, input.viewId);
      if (!view) return { ok: false };
      const previous = view.writer;
      const writerId = randomUUID();
      view.writer = { id: writerId, stream: input.writer };
      if (view.orphanTimer) clearTimeout(view.orphanTimer);
      view.orphanTimer = null;
      previous?.stream.close();
      const buffered = view.buffer;
      view.buffer = [];
      view.bufferBytes = 0;
      for (const frame of buffered) {
        if (!input.writer.send("output", frame)) {
          logConnect({ action: "retry", code: "connect_view_queue_full", outcome: "failed", stage: "dispatch" });
          closeView(view, "error", true);
          return { ok: true, writerId };
        }
      }
      return { ok: true, writerId };
    },

    /** The browser stream ended; the view closes unless a stream attaches within the orphan timeout. */
    detachView(viewId: string, writerId: string): void {
      const view = views.get(viewId);
      if (!view || view.writer?.id !== writerId) return;
      view.writer = null;
      startOrphanTimer(view);
    },

    /** A heartbeat on the view's current browser stream; a full queue ends the view. */
    pingView(viewId: string, writerId: string): boolean {
      const view = views.get(viewId);
      if (!view || view.writer?.id !== writerId) return false;
      if (view.writer.stream.send("ping", {})) return true;
      logConnect({ action: "retry", code: "connect_view_queue_full", outcome: "failed", stage: "heartbeat" });
      closeView(view, "error", true);
      return false;
    },

    viewInput(owner: ConnectViewOwner, viewId: string, data: string): ConnectReasonCode | null {
      const view = ownedView(owner, viewId);
      if (!view) return "connect_not_found";
      const device = devices.get(view.deviceId);
      if (!device) return "connect_device_offline";
      return sendCommand(device, { data, type: "view_input", viewId }) ? null : "connect_device_offline";
    },

    viewResize(owner: ConnectViewOwner, viewId: string, size: Readonly<{ cols: number; rows: number }>): ConnectReasonCode | null {
      const view = ownedView(owner, viewId);
      if (!view) return "connect_not_found";
      const device = devices.get(view.deviceId);
      if (!device) return "connect_device_offline";
      return sendCommand(device, { cols: size.cols, rows: size.rows, type: "view_resize", viewId }) ? null : "connect_device_offline";
    },

    viewVisibility(owner: ConnectViewOwner, viewId: string, visible: boolean): ConnectReasonCode | null {
      const view = ownedView(owner, viewId);
      if (!view) return "connect_not_found";
      view.visible = visible;
      if (visible) view.lastVisibleAt = now();
      return null;
    },

    /** The owner closed the view, or its stream found the feature switched off. */
    closeOwnedView(
      owner: ConnectViewOwner,
      viewId: string,
      reason: ConnectViewStreamClosedReason = "detached"
    ): ConnectReasonCode | null {
      const view = ownedView(owner, viewId);
      if (!view) return "connect_not_found";
      closeView(view, reason, true);
      return null;
    },

    /** Whether the owner has this session open on screen: visible reported within the last 30 seconds. */
    isSessionVisible(userId: string, deviceId: string, sessionId: string, at: number = now()): boolean {
      for (const view of views.values()) {
        if (view.userId === userId && view.deviceId === deviceId && view.sessionId === sessionId && view.visible &&
          view.lastVisibleAt !== null && at - view.lastVisibleAt <= CONNECT_VIEW_VISIBLE_WINDOW_MS) {
          return true;
        }
      }
      return false;
    },

    /** The browser session ended: its views close as unauthorized. */
    closeViewsForAuthSession(authSessionId: string): void {
      closeViews(
        [...views.values()].filter((view) => view.authSessionId === authSessionId).map((view) => view.id),
        "connect_unauthorized",
        true
      );
    },

    /** The device was revoked: its stream gets `closed {code}` and ends at once. */
    disconnectDevice(deviceId: string, code: ConnectDeviceStreamClosedCode): void {
      epoch += 1;
      const device = devices.get(deviceId);
      if (!device) return;
      endDevice(device, {
        final: { data: { code }, event: "closed" },
        pendingCode: code === "connect_disabled" ? "connect_disabled" : "connect_device_offline",
        viewReason: code === "connect_disabled" ? "connect_disabled" : "connect_device_offline"
      });
    },

    /**
     * The account lost its devices: every device stream of theirs gets
     * `closed {connect_unauthorized}` (its token is gone) and their lists
     * reload. A view whose browser session was revoked with them closes as
     * unauthorized; a view of a session that stays signed in (a password
     * change keeps the current one) closes as `connect_device_offline`.
     */
    disconnectUser(userId: string, input: Readonly<{ activeAuthSessionIds: Iterable<string> }>): void {
      epoch += 1;
      const active = new Set(input.activeAuthSessionIds);
      const userViews = () => [...views.values()].filter((view) => view.userId === userId);
      // The device streams end below, so the devices are not told about these views.
      closeViews(userViews().filter((view) => !active.has(view.authSessionId)).map((view) => view.id), "connect_unauthorized", false);
      for (const device of [...devices.values()]) {
        if (device.record.userId === userId) {
          endDevice(device, {
            final: { data: { code: "connect_unauthorized" }, event: "closed" },
            pendingCode: "connect_device_offline",
            viewReason: "connect_device_offline"
          });
        }
      }
      closeViews(userViews().map((view) => view.id), "connect_device_offline", false);
      emit({ type: "devices_changed", userId });
    },

    /** Every session of the installation was revoked: all streams, views and device lists end as unauthorized. */
    disconnectAll(): void {
      epoch += 1;
      endAll({
        final: { data: { code: "connect_unauthorized" }, event: "closed" },
        pendingCode: "connect_device_offline",
        viewReason: "connect_unauthorized"
      });
      emit({ code: "connect_unauthorized", type: "closed" });
    },

    /** The administrator turned AIQSA Connect off: everything ends with `connect_disabled`. */
    disable(): void {
      epoch += 1;
      endAll({
        final: { data: { code: "connect_disabled" }, event: "closed" },
        pendingCode: "connect_disabled",
        viewReason: "connect_disabled"
      });
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
    size(): Readonly<{ devices: number; listeners: number; pendingReplies: number; views: number }> {
      let pendingReplies = 0;
      for (const device of devices.values()) pendingReplies += device.pending.size;
      return { devices: devices.size, listeners: listeners.size, pendingReplies, views: views.size };
    }
  };
}

const globalForConnectRelay = globalThis as typeof globalThis & { __aiqsaConnectRelay?: ConnectRelay };

/** The relay of this application process, shared by every route bundle (single replica). */
export function getConnectRelay(): ConnectRelay {
  return globalForConnectRelay.__aiqsaConnectRelay ??= createConnectRelay();
}
