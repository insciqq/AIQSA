import { CONNECT_EVENTS_PATH } from "@/lib/contracts/connect";
import {
  decodeConnectComputerEventsStreamEvent,
  type ConnectComputerEventsStreamEvent,
  type ConnectComputerListResponse,
  type ConnectComputerWire
} from "@/lib/contracts/computer";
import { listConnectComputers, type ConnectApiResult, type ConnectFailureCode } from "./connectApi";

/** The part of `EventSource` the Connect stream uses; tests inject a fake. */
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

/** Every frame name of `/api/connect/events`. */
const EVENT_NAMES = ["devices", "device", "closed", "ping"] as const satisfies
  readonly ConnectComputerEventsStreamEvent["event"][];

/** Why the page must leave AIQSA Connect: the feature was turned off, or the sign-in ended. */
export type ConnectLeaveReason = "disabled" | "signed_out";

export type ConnectComputerFeedSnapshot = Readonly<{
  /** Null until the first list arrives. */
  computers: readonly ConnectComputerWire[] | null;
  connection: "connecting" | "live" | "reconnecting";
  /** The last failure while no list could be read; cleared by the next one. */
  loadError: ConnectFailureCode | null;
}>;

/** Reconnect delays of the computer-list stream; the last one repeats. */
export const CONNECT_FEED_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

type Options = Readonly<{
  listComputers?(): Promise<ConnectApiResult<ConnectComputerListResponse>>;
  onLeave(reason: ConnectLeaveReason): void;
  openEventSource?: ConnectEventSourceFactory;
}>;

/**
 * The live list of the user's computers: one `/api/connect/events` stream,
 * reopened with backoff after any failure. Each reopen first reads the list
 * once, which both refreshes it and names the refusal (EventSource itself
 * cannot read a refusal body). Malformed frames count as a failure.
 */
export class ConnectComputerFeed {
  private snapshot: ConnectComputerFeedSnapshot = { computers: null, connection: "connecting", loadError: null };
  private readonly listeners = new Set<() => void>();
  private source: ConnectEventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private generation = 0;
  private stopped = true;
  private readonly listComputers: () => Promise<ConnectApiResult<ConnectComputerListResponse>>;
  private readonly openEventSource: ConnectEventSourceFactory | null;

  constructor(private readonly options: Options) {
    this.listComputers = options.listComputers ?? (() => listConnectComputers());
    this.openEventSource = options.openEventSource ??
      (typeof EventSource === "undefined" ? null : openBrowserEventSource);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConnectComputerFeedSnapshot => this.snapshot;

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

  /** Drops a revoked computer at once; the next list confirms it. */
  removeComputer(computerId: string): void {
    const computers = this.snapshot.computers;
    if (computers) this.update({ computers: computers.filter((computer) => computer.id !== computerId) });
  }

  private update(patch: Partial<ConnectComputerFeedSnapshot>): void {
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
      const frame = decodeConnectComputerEventsStreamEvent(event.type, String(event.data));
      if (!frame) {
        this.fail(generation);
        return;
      }
      if (frame.event === "devices") {
        this.attempt = 0;
        this.update({ computers: frame.data.computers, connection: "live", loadError: null });
      } else if (frame.event === "device") {
        const next = frame.data.computer;
        const computers = this.snapshot.computers;
        // A computer the last list does not hold arrives with the next list.
        if (computers?.some((computer) => computer.id === next.id)) {
          this.update({ computers: computers.map((computer) => computer.id === next.id ? next : computer) });
        }
      } else if (frame.event === "closed") {
        this.leave(frame.data.code === "connect_disabled" ? "disabled" : "signed_out");
      }
    };
    for (const name of EVENT_NAMES) source.addEventListener(name, handle);
    source.onerror = () => this.fail(generation);
  }

  private fail(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.closeSource();
    this.update({ connection: this.snapshot.computers ? "reconnecting" : "connecting" });
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
    const result = await this.listComputers();
    if (generation !== this.generation || this.stopped) return;
    if (result.ok) {
      this.update({ computers: result.data.computers, loadError: null });
      this.open();
      return;
    }
    if (result.code === "connect_disabled") return this.leave("disabled");
    if (result.code === "connect_unauthorized") return this.leave("signed_out");
    this.update({ loadError: result.code });
    this.fail(generation);
  }
}
