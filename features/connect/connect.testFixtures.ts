import type { ConnectEventSource } from "./connectDeviceFeed";

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
