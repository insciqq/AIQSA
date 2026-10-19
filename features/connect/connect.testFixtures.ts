import { vi } from "vitest";
import type { ConnectApiResult } from "./connectApi";
import type { ConnectEventSource } from "./connectDeviceFeed";
import type { ConnectViewTransport } from "./connectTerminalSession";

/** A scriptable `EventSource`: tests open it, send frames and fail it. */
export class FakeEventSource implements ConnectEventSource {
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  send(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export const okVoid: ConnectApiResult<void> = { data: undefined, ok: true };

let viewCounter = 0;

export function nextViewId(): string {
  viewCounter += 1;
  return `00000000-0000-4000-8000-${String(viewCounter).padStart(12, "0")}`;
}

/** A transport whose view creation answers from a queue; streams and calls are recorded. */
export function fakeViewTransport() {
  const streams: FakeEventSource[] = [];
  const createResults: ConnectApiResult<{ viewId: string }>[] = [];
  const transport = {
    closeView: vi.fn<(viewId: string) => void>(),
    createView: vi.fn(async () => createResults.shift() ?? { data: { viewId: nextViewId() }, ok: true as const }),
    openStream: vi.fn((viewId: string) => {
      const stream = new FakeEventSource(`/api/connect/views/${viewId}/stream`);
      streams.push(stream);
      return stream;
    }),
    resize: vi.fn(async () => okVoid),
    sendInput: vi.fn(async (_viewId: string, _data: string): Promise<ConnectApiResult<void>> => okVoid),
    setVisibility: vi.fn(async () => okVoid)
  } satisfies ConnectViewTransport;
  return { createResults, streams, transport };
}
