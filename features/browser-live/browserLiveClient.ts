import {
  BROWSER_LIVE_ERROR_CODES,
  browserLiveControlPath,
  browserLiveHandoffPath,
  browserLiveInputPath,
  browserLiveStreamPath,
  decodeBrowserLiveEvent,
  type BrowserLiveControlRequest,
  type BrowserLiveEndReason,
  type BrowserLiveFrameEvent,
  type BrowserLiveHandoffRequest,
  type BrowserLiveInput,
  type BrowserLiveStateEvent,
  type BrowserLiveStep
} from "@/lib/contracts/browserLive";
import type { BrowserLiveFailureCodeV2 } from "./browserLivePresentation";

/**
 * The browser side of the live Workspace browser: one owner-only SSE stream
 * while the panel is open, and the POST routes for input, control and the
 * handoff. Frames and typed text stay in memory: nothing here logs, persists
 * or reports them.
 */

/** The part of `EventSource` the stream uses; tests inject a fake. */
export type BrowserLiveEventSource = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
};

export type BrowserLiveEventSourceFactory = (url: string) => BrowserLiveEventSource;

const STREAM_EVENTS = ["state", "frame", "steps", "end"] as const;

/** Reopen delays after a failure; the stream gives up after the last one fails without an event. */
export const BROWSER_LIVE_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 5_000, 10_000];

export type BrowserLiveConnection =
  /** Opening; no state yet. */
  | "connecting"
  | "live"
  /** The stream dropped after it was live; the last frame stays, dimmed. */
  | "reconnecting"
  /** Repeated failures without a single event: the panel offers Retry. */
  | "failed"
  /** The server ended the stream with a reason. */
  | "ended";

export type BrowserLiveSnapshot = Readonly<{
  connection: BrowserLiveConnection;
  state: BrowserLiveStateEvent | null;
  frame: BrowserLiveFrameEvent | null;
  steps: readonly BrowserLiveStep[];
  endReason: BrowserLiveEndReason | null;
}>;

export const BROWSER_LIVE_IDLE_SNAPSHOT: BrowserLiveSnapshot = Object.freeze({
  connection: "connecting",
  state: null,
  frame: null,
  steps: [],
  endReason: null
});

function openBrowserEventSource(url: string): BrowserLiveEventSource {
  return new EventSource(url) as unknown as BrowserLiveEventSource;
}

export class BrowserLiveStream {
  private snapshot: BrowserLiveSnapshot = BROWSER_LIVE_IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private source: BrowserLiveEventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private generation = 0;
  private running = false;
  private readonly openEventSource: BrowserLiveEventSourceFactory | null;

  constructor(private readonly chatId: string, openEventSource?: BrowserLiveEventSourceFactory) {
    this.openEventSource = openEventSource ?? (typeof EventSource === "undefined" ? null : openBrowserEventSource);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): BrowserLiveSnapshot => this.snapshot;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.open();
  }

  /** Closes the stream and drops the frame, so no picture outlives the open panel. */
  stop(): void {
    this.running = false;
    this.generation += 1;
    this.closeSource();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.snapshot = BROWSER_LIVE_IDLE_SNAPSHOT;
  }

  /** Opens again after `failed`, `replaced` or `error`. */
  restart(): void {
    this.stop();
    this.start();
    this.emit();
  }

  private update(patch: Partial<BrowserLiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private closeSource(): void {
    if (!this.source) return;
    this.source.onerror = null;
    this.source.onopen = null;
    this.source.close();
    this.source = null;
  }

  private open(): void {
    const generation = ++this.generation;
    this.closeSource();
    if (!this.openEventSource) {
      this.fail(generation);
      return;
    }
    const source = this.openEventSource(browserLiveStreamPath(this.chatId));
    this.source = source;
    const handle = (event: MessageEvent<string>) => {
      if (generation !== this.generation) return;
      const decoded = decodeBrowserLiveEvent(event.type, String(event.data));
      // A malformed event fails visibly (reopen, then Retry) instead of becoming guessed state.
      if (!decoded) {
        this.fail(generation);
        return;
      }
      this.failures = 0;
      switch (decoded.type) {
        case "state": {
          // Another agent's tab is shown now: the previous agent's picture and steps go with it.
          const moved = this.snapshot.state !== null && this.snapshot.state.selected !== decoded.value.selected;
          this.update({ connection: "live", state: decoded.value, ...(moved ? { frame: null, steps: [] } : {}) });
          break;
        }
        case "frame":
          // Only the latest frame of the selected agent's tab is kept.
          if (this.snapshot.state && decoded.value.agent !== this.snapshot.state.selected) break;
          this.update({ frame: decoded.value });
          break;
        case "steps":
          if (this.snapshot.state && decoded.value.agent !== this.snapshot.state.selected) break;
          this.update({ steps: decoded.value.steps });
          break;
        case "end":
          this.generation += 1;
          this.closeSource();
          this.update({ connection: "ended", endReason: decoded.value.reason, frame: null });
          break;
      }
    };
    for (const name of STREAM_EVENTS) source.addEventListener(name, handle);
    source.onerror = () => this.fail(generation);
  }

  private fail(generation: number): void {
    if (generation !== this.generation || !this.running) return;
    this.closeSource();
    if (this.failures >= BROWSER_LIVE_RETRY_DELAYS_MS.length) {
      this.generation += 1;
      this.update({ connection: "failed" });
      return;
    }
    const delay = BROWSER_LIVE_RETRY_DELAYS_MS[this.failures]!;
    this.failures += 1;
    this.update({ connection: this.snapshot.state ? "reconnecting" : "connecting" });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation && this.running) this.open();
    }, delay);
  }
}

export type BrowserLiveRequestResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: BrowserLiveFailureCodeV2 }>;

const ERROR_CODES: ReadonlySet<string> = new Set(BROWSER_LIVE_ERROR_CODES);

async function post(path: string, body: unknown): Promise<BrowserLiveRequestResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  } catch {
    return { ok: false, code: "network_error" };
  }
  if (response.ok) return { ok: true };
  const payload: unknown = await response.json().catch(() => null);
  const code = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).code : null;
  return { ok: false, code: typeof code === "string" && ERROR_CODES.has(code) ? code as BrowserLiveFailureCodeV2 : "unexpected_response" };
}

export function postBrowserLiveInput(chatId: string, input: BrowserLiveInput): Promise<BrowserLiveRequestResult> {
  return post(browserLiveInputPath(chatId), input);
}

/** Take control or Return control of one agent's tab (the main agent's when `agent` is absent). */
export function postBrowserLiveControl(chatId: string, action: "take" | "return", agent?: string): Promise<BrowserLiveRequestResult> {
  return post(browserLiveControlPath(chatId), { action, ...(agent ? { agent } : {}) } satisfies BrowserLiveControlRequest);
}

/** The agent whose tab the stream shows. */
export function postBrowserLiveSelect(chatId: string, agent: string): Promise<BrowserLiveRequestResult> {
  return post(browserLiveControlPath(chatId), { action: "select", agent } satisfies BrowserLiveControlRequest);
}

export function postBrowserLiveHandoff(
  chatId: string,
  handoffId: string,
  action: BrowserLiveHandoffRequest["action"]
): Promise<BrowserLiveRequestResult> {
  return post(browserLiveHandoffPath(chatId), { action, handoffId } satisfies BrowserLiveHandoffRequest);
}
