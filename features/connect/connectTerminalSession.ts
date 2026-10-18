import {
  CONNECT_MAX_COLS,
  CONNECT_MAX_INPUT_BYTES,
  CONNECT_MAX_ROWS,
  CONNECT_MIN_COLS,
  CONNECT_MIN_ROWS,
  CONNECT_VIEW_STREAM_EVENTS,
  connectUtf8ByteLength,
  connectViewStreamPath,
  decodeConnectViewStreamEvent,
  type ConnectViewCreateRequest,
  type ConnectViewCreateResponse,
  type ConnectViewStreamClosedReason
} from "@/lib/contracts/connect";
import {
  closeConnectView,
  createConnectView,
  resizeConnectView,
  sendConnectViewInput,
  setConnectViewVisibility,
  type ConnectApiResult,
  type ConnectFailureCode
} from "./connectApi";
import { openBrowserEventSource, type ConnectEventSource, type ConnectLeaveReason } from "./connectDeviceFeed";

/** What the session controller needs from the terminal on screen. */
export type ConnectTerminalSink = Readonly<{
  reset(): void;
  write(data: Uint8Array): void;
}>;

/** The browser API of one terminal view; tests and fixtures inject their own. */
export type ConnectViewTransport = Readonly<{
  closeView(viewId: string): void;
  createView(request: ConnectViewCreateRequest): Promise<ConnectApiResult<ConnectViewCreateResponse>>;
  openStream(viewId: string): ConnectEventSource;
  resize(viewId: string, cols: number, rows: number): Promise<ConnectApiResult<void>>;
  sendInput(viewId: string, data: string): Promise<ConnectApiResult<void>>;
  setVisibility(viewId: string, visible: boolean): Promise<ConnectApiResult<void>>;
}>;

export const browserConnectViewTransport: ConnectViewTransport = {
  closeView(viewId) {
    void closeConnectView(viewId);
  },
  createView: createConnectView,
  openStream: (viewId) => openBrowserEventSource(connectViewStreamPath(viewId)),
  resize: resizeConnectView,
  sendInput: sendConnectViewInput,
  setVisibility: setConnectViewVisibility
};

export type ConnectReconnectCause = ConnectFailureCode | ConnectViewStreamClosedReason | "out_of_order" | "stream_lost";

export type ConnectViewState =
  | Readonly<{ kind: "connecting" }>
  | Readonly<{ kind: "live" }>
  | Readonly<{ kind: "offline" }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ cause: ConnectReconnectCause; kind: "reconnecting"; retryAt: number }>
  | Readonly<{ code: ConnectFailureCode; kind: "failed" }>
  | Readonly<{ kind: "left"; reason: ConnectLeaveReason }>;

/** Reopen delays after a lost view; the last one repeats until the view is live again. */
export const CONNECT_VIEW_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
/** A visible view repeats its visibility this often, so notifications stay quiet while it is watched. */
export const CONNECT_VISIBILITY_REFRESH_MS = 20_000;

export function clampConnectSize(cols: number, rows: number): Readonly<{ cols: number; rows: number }> {
  const bound = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
  return { cols: bound(cols, CONNECT_MIN_COLS, CONNECT_MAX_COLS), rows: bound(rows, CONNECT_MIN_ROWS, CONNECT_MAX_ROWS) };
}

/** Splits typed input at a code-point boundary so each request stays within the input limit. */
export function takeConnectInputChunk(buffer: string, maxBytes = CONNECT_MAX_INPUT_BYTES): [string, string] {
  if (connectUtf8ByteLength(buffer) <= maxBytes) return [buffer, ""];
  let bytes = 0;
  let index = 0;
  for (const character of buffer) {
    const size = connectUtf8ByteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += character.length;
  }
  return [buffer.slice(0, index), buffer.slice(index)];
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type Options = Readonly<{
  deviceId: string;
  now?(): number;
  onState(state: ConnectViewState): void;
  sessionId: string;
  /** The terminal's current size, already fitted to its box. */
  size(): Readonly<{ cols: number; rows: number }>;
  terminal: ConnectTerminalSink;
  transport?: ConnectViewTransport;
}>;

/**
 * One terminal on screen attached to one session: opens a view sized to the
 * terminal, writes its output stream in order, sends keystrokes strictly one
 * request at a time and reopens a lost view with backoff (tmux redraws the
 * screen on each attach). Only the latest view's answers count.
 */
export class ConnectTerminalSession {
  private state: ConnectViewState = { kind: "connecting" };
  private readonly transport: ConnectViewTransport;
  private readonly now: () => number;
  private viewId: string | null = null;
  private source: ConnectEventSource | null = null;
  private generation = 0;
  private attempt = 0;
  private expectedSeq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityTimer: ReturnType<typeof setInterval> | null = null;
  private inputBuffer = "";
  private inputInFlight = false;
  private inputRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private sentVisible: boolean | null = null;
  private sentSize: string | null = null;
  private deviceOnline: boolean | null = null;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.transport = options.transport ?? browserConnectViewTransport;
    this.now = options.now ?? Date.now;
  }

  getState(): ConnectViewState {
    return this.state;
  }

  start(): void {
    void this.openView();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearTimers();
    this.releaseView();
  }

  /** Keystrokes from the terminal; ignored unless the view is live. */
  input(data: string): void {
    if (this.disposed || this.state.kind !== "live" || !data) return;
    this.inputBuffer += data;
    this.flushInput();
  }

  resize(cols: number, rows: number): void {
    const size = clampConnectSize(cols, rows);
    const key = `${size.cols}x${size.rows}`;
    if (this.disposed || !this.viewId || this.state.kind !== "live" || key === this.sentSize) return;
    this.sentSize = key;
    void this.transport.resize(this.viewId, size.cols, size.rows);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.sendVisibility(false);
  }

  /** The device list's online flag; a computer coming back online reopens an offline view. */
  setDeviceOnline(online: boolean): void {
    const wasOnline = this.deviceOnline;
    this.deviceOnline = online;
    if (online && wasOnline === false && this.state.kind === "offline") void this.openView();
  }

  /** The user's "Try again" in a failed, offline or reconnecting state. */
  retryNow(): void {
    if (this.disposed || this.state.kind === "live" || this.state.kind === "left") return;
    this.attempt = 0;
    void this.openView();
  }

  private setState(state: ConnectViewState): void {
    this.state = state;
    this.options.onState(state);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.inputRetryTimer) clearTimeout(this.inputRetryTimer);
    if (this.visibilityTimer) clearInterval(this.visibilityTimer);
    this.retryTimer = null;
    this.inputRetryTimer = null;
    this.visibilityTimer = null;
  }

  /** Closes the current stream and view; keystrokes typed for it are dropped. */
  private releaseView(): void {
    if (this.source) {
      this.source.onerror = null;
      this.source.onopen = null;
      this.source.close();
      this.source = null;
    }
    if (this.viewId) this.transport.closeView(this.viewId);
    this.viewId = null;
    this.inputBuffer = "";
    this.sentVisible = null;
    this.sentSize = null;
  }

  private async openView(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.clearTimers();
    this.releaseView();
    if (this.state.kind !== "reconnecting") this.setState({ kind: "connecting" });
    const fitted = this.options.size();
    const size = clampConnectSize(fitted.cols, fitted.rows);
    const result = await this.transport.createView({
      cols: size.cols,
      deviceId: this.options.deviceId,
      rows: size.rows,
      sessionId: this.options.sessionId
    });
    if (generation !== this.generation || this.disposed) {
      if (result.ok) this.transport.closeView(result.data.viewId);
      return;
    }
    if (!result.ok) {
      this.refused(result.code, result.retryAfterSeconds);
      return;
    }
    const viewId = result.data.viewId;
    this.viewId = viewId;
    this.sentSize = `${size.cols}x${size.rows}`;
    this.expectedSeq = 0;
    const source = this.transport.openStream(viewId);
    this.source = source;
    const current = () => generation === this.generation && !this.disposed;
    source.onopen = () => {
      if (current()) this.becameLive(generation);
    };
    source.onerror = () => {
      if (current()) this.reconnect("stream_lost");
    };
    const handle = (event: MessageEvent<string>) => {
      if (!current()) return;
      const frame = decodeConnectViewStreamEvent(event.type, String(event.data));
      if (!frame) {
        this.reconnect("stream_lost");
        return;
      }
      if (frame.event === "output") {
        if (frame.data.seq !== this.expectedSeq) {
          // A lost chunk would corrupt the screen: a fresh view redraws it.
          this.reconnect("out_of_order", 0);
          return;
        }
        this.expectedSeq += 1;
        if (this.state.kind !== "live") this.becameLive(generation);
        if (!current()) return;
        this.options.terminal.write(decodeBase64(frame.data.data));
      } else if (frame.event === "closed") {
        this.closed(frame.data.reason);
      } else if (this.state.kind !== "live") {
        this.becameLive(generation);
      }
    };
    for (const name of CONNECT_VIEW_STREAM_EVENTS) source.addEventListener(name, handle);
  }

  private becameLive(generation: number): void {
    if (generation !== this.generation || this.state.kind === "live") return;
    this.attempt = 0;
    // The new attach redraws the whole screen; the old one would stay underneath.
    this.options.terminal.reset();
    this.setState({ kind: "live" });
    this.sendVisibility(true);
    if (this.visibilityTimer) clearInterval(this.visibilityTimer);
    this.visibilityTimer = setInterval(() => {
      if (this.visible) this.sendVisibility(true);
    }, CONNECT_VISIBILITY_REFRESH_MS);
    const size = this.options.size();
    this.resize(size.cols, size.rows);
  }

  private sendVisibility(force: boolean): void {
    if (this.disposed || !this.viewId || this.state.kind !== "live") return;
    if (!force && this.sentVisible === this.visible) return;
    this.sentVisible = this.visible;
    void this.transport.setVisibility(this.viewId, this.visible);
  }

  private closed(reason: ConnectViewStreamClosedReason): void {
    switch (reason) {
      case "session_ended":
        this.settle({ kind: "ended" });
        return;
      case "connect_device_offline":
        this.settle({ kind: "offline" });
        return;
      case "connect_disabled":
        this.settle({ kind: "left", reason: "disabled" });
        return;
      case "connect_unauthorized":
        this.settle({ kind: "left", reason: "signed_out" });
        return;
      default:
        this.reconnect(reason);
    }
  }

  private refused(code: ConnectFailureCode, retryAfterSeconds?: number): void {
    switch (code) {
      case "connect_device_offline":
        this.settle({ kind: "offline" });
        return;
      case "connect_session_not_found":
        this.settle({ kind: "ended" });
        return;
      case "connect_not_found":
        this.settle({ kind: "not_found" });
        return;
      case "connect_disabled":
        this.settle({ kind: "left", reason: "disabled" });
        return;
      case "connect_unauthorized":
        this.settle({ kind: "left", reason: "signed_out" });
        return;
      case "connect_request_invalid":
      case "connect_unsupported":
        this.settle({ code, kind: "failed" });
        return;
      case "connect_rate_limited":
        this.reconnect(code, (retryAfterSeconds ?? 5) * 1000);
        return;
      default:
        this.reconnect(code);
    }
  }

  /** A terminal state: no stream, no retries until the user or the device list asks again. */
  private settle(state: ConnectViewState): void {
    this.generation += 1;
    this.clearTimers();
    this.releaseView();
    this.setState(state);
  }

  private reconnect(cause: ConnectReconnectCause, delayMs?: number): void {
    const delays = CONNECT_VIEW_RETRY_DELAYS_MS;
    const delay = delayMs ?? delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt += 1;
    this.generation += 1;
    this.clearTimers();
    this.releaseView();
    this.setState({ cause, kind: "reconnecting", retryAt: this.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.openView();
    }, delay);
  }

  private flushInput(): void {
    if (this.inputInFlight || !this.inputBuffer || !this.viewId) return;
    const [chunk, rest] = takeConnectInputChunk(this.inputBuffer);
    this.inputBuffer = rest;
    this.inputInFlight = true;
    const viewId = this.viewId;
    void this.transport.sendInput(viewId, chunk).then((result) => {
      this.inputInFlight = false;
      if (this.disposed) return;
      // Keystrokes typed into a reopened view wait only for this request.
      if (viewId !== this.viewId) {
        this.flushInput();
        return;
      }
      if (result.ok) {
        this.flushInput();
        return;
      }
      if (result.code === "connect_rate_limited") {
        this.inputBuffer = chunk + this.inputBuffer;
        this.inputRetryTimer = setTimeout(() => {
          this.inputRetryTimer = null;
          this.flushInput();
        }, (result.retryAfterSeconds ?? 1) * 1000);
        return;
      }
      this.inputBuffer = "";
      // An unknown view expired on the server: a new one continues the session.
      if (result.code === "connect_not_found") this.reconnect("stream_lost", 0);
      else if (result.code === "connect_device_offline" || result.code === "connect_session_not_found" ||
        result.code === "connect_disabled" || result.code === "connect_unauthorized") {
        this.refused(result.code);
      }
    });
  }
}
