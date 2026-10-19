import {
  CONNECT_EVENTS_PATH,
  CONNECT_EVENTS_STREAM_EVENTS,
  decodeConnectEventsStreamEvent,
  type ConnectDevice,
  type ConnectDevicesResponse
} from "@/lib/contracts/connect";
import { listConnectDevices, type ConnectApiResult, type ConnectFailureCode } from "./connectApi";

/** The part of `EventSource` the Connect streams use; tests inject a fake. */
export type ConnectEventSource = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
};

export type ConnectEventSourceFactory = (url: string) => ConnectEventSource;

export function openBrowserEventSource(url: string): ConnectEventSource {
  return new EventSource(url) as unknown as ConnectEventSource;
}

/** Why the shell must leave AIQSA Connect: the feature was turned off, or the sign-in ended. */
export type ConnectLeaveReason = "disabled" | "signed_out";

export type ConnectDeviceFeedSnapshot = Readonly<{
  connection: "connecting" | "live" | "reconnecting";
  /** Null until the first snapshot arrives. */
  devices: readonly ConnectDevice[] | null;
  /** The last failure while no snapshot could be read; cleared by the next one. */
  loadError: ConnectFailureCode | null;
}>;

/** Reconnect delays of the device-list stream; the last one repeats. */
export const CONNECT_FEED_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

type Options = Readonly<{
  listDevices?(): Promise<ConnectApiResult<ConnectDevicesResponse>>;
  onLeave(reason: ConnectLeaveReason): void;
  openEventSource?: ConnectEventSourceFactory;
}>;

/**
 * The live list of the user's computers: one `/api/connect/events` stream,
 * reopened with backoff after any failure. Each reopen first reads the list
 * once, which both refreshes it and names the refusal (EventSource itself
 * cannot read a refusal body). Malformed frames count as a failure.
 */
export class ConnectDeviceFeed {
  private snapshot: ConnectDeviceFeedSnapshot = { connection: "connecting", devices: null, loadError: null };
  private readonly listeners = new Set<() => void>();
  private source: ConnectEventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private generation = 0;
  private stopped = true;
  private readonly listDevices: () => Promise<ConnectApiResult<ConnectDevicesResponse>>;
  private readonly openEventSource: ConnectEventSourceFactory | null;

  constructor(private readonly options: Options) {
    this.listDevices = options.listDevices ?? (() => listConnectDevices());
    this.openEventSource = options.openEventSource ??
      (typeof EventSource === "undefined" ? null : openBrowserEventSource);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConnectDeviceFeedSnapshot => this.snapshot;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.closeSource();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drops a revoked computer at once; the next snapshot confirms it. */
  removeDevice(deviceId: string): void {
    const devices = this.snapshot.devices;
    if (devices) this.update({ devices: devices.filter((device) => device.id !== deviceId) });
  }

  /** Drops an ended session at once; the computer's next update confirms it. */
  removeSession(deviceId: string, sessionId: string): void {
    const devices = this.snapshot.devices;
    if (!devices) return;
    this.update({
      devices: devices.map((device) => device.id === deviceId
        ? { ...device, sessions: device.sessions.filter((session) => session.id !== sessionId) }
        : device)
    });
  }

  private update(patch: Partial<ConnectDeviceFeedSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private closeSource(): void {
    if (!this.source) return;
    this.source.onerror = null;
    this.source.onopen = null;
    this.source.close();
    this.source = null;
  }

  private leave(reason: ConnectLeaveReason): void {
    this.stop();
    this.options.onLeave(reason);
  }

  private open(): void {
    const generation = ++this.generation;
    this.closeSource();
    if (!this.openEventSource) {
      this.fail(generation);
      return;
    }
    const source = this.openEventSource(CONNECT_EVENTS_PATH);
    this.source = source;
    const handle = (event: MessageEvent<string>) => {
      if (generation !== this.generation) return;
      const frame = decodeConnectEventsStreamEvent(event.type, String(event.data));
      if (!frame) {
        this.fail(generation);
        return;
      }
      if (frame.event === "devices") {
        this.attempt = 0;
        this.update({ connection: "live", devices: frame.data.devices, loadError: null });
      } else if (frame.event === "device") {
        const next = frame.data.device;
        const devices = this.snapshot.devices;
        // A device the last snapshot does not hold arrives with the next snapshot.
        if (devices?.some((device) => device.id === next.id)) {
          this.update({ devices: devices.map((device) => device.id === next.id ? next : device) });
        }
      } else if (frame.event === "closed") {
        this.leave(frame.data.code === "connect_disabled" ? "disabled" : "signed_out");
      }
    };
    for (const name of CONNECT_EVENTS_STREAM_EVENTS) source.addEventListener(name, handle);
    source.onerror = () => this.fail(generation);
  }

  private fail(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.closeSource();
    this.update({ connection: this.snapshot.devices ? "reconnecting" : "connecting" });
    const delays = CONNECT_FEED_RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.probe(generation);
    }, delay);
  }

  private async probe(generation: number): Promise<void> {
    if (generation !== this.generation || this.stopped) return;
    const result = await this.listDevices();
    if (generation !== this.generation || this.stopped) return;
    if (result.ok) {
      this.update({ devices: result.data.devices, loadError: null });
      this.open();
      return;
    }
    if (result.code === "connect_disabled") return this.leave("disabled");
    if (result.code === "connect_unauthorized") return this.leave("signed_out");
    this.update({ loadError: result.code });
    this.fail(generation);
  }
}
