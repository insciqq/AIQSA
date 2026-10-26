import type { BrowserLiveFrameEvent, BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import type { BrowserLiveEventSource } from "./browserLiveClient";

/** A scriptable `EventSource`: tests open it, send events and fail it. */
export class FakeBrowserLiveEventSource implements BrowserLiveEventSource {
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

  send(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

export function fakeEventSources() {
  const sources: FakeBrowserLiveEventSource[] = [];
  const open = (url: string) => {
    const source = new FakeBrowserLiveEventSource(url);
    sources.push(source);
    return source;
  };
  return { open, sources };
}

export function liveState(overrides: Partial<BrowserLiveStateEvent> = {}): BrowserLiveStateEvent {
  return {
    version: 1,
    runId: "run-1",
    browser: "running",
    controller: "agent",
    handoff: null,
    signInRemembered: true,
    page: { url: "https://shop.example/cart", title: "Cart · Shop" },
    ...overrides
  };
}

// The smallest well-formed base64 the contract accepts; the image itself never decodes in jsdom.
export function liveFrame(seq: number, width = 1280, height = 800): BrowserLiveFrameEvent {
  return { seq, mime: "image/jpeg", data: "/9j/4AAQSkZJRgABAQ==", width, height };
}
