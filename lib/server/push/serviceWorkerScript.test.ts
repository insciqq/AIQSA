// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type WindowClient = { focus: ReturnType<typeof vi.fn>; focused: boolean; url: string; visibilityState: "hidden" | "visible" };

const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");

function worker(windows: WindowClient[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Array<{ options: Record<string, unknown>; title: string }> = [];
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null)
    },
    location: new URL("https://aiqsa.example/sw.js"),
    registration: {
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => { shown.push({ options, title }); })
    },
    skipWaiting: vi.fn()
  };
  new Function("self", source)(self);
  async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return {
    push: (data: unknown) => dispatch("push", { data: { json: () => (typeof data === "string" ? JSON.parse(data) : data) } }),
    click: (url: unknown) => {
      const notification = { close: vi.fn(), data: { url } };
      return dispatch("notificationclick", { notification }).then(() => notification);
    },
    self,
    shown
  };
}

const message = { body: "Answer ready", tag: "aiqsa-chat-chat-1", title: "Trip plan", url: "/c/chat-1", v: 1 };
const window = (url: string, focused = true, visibilityState: WindowClient["visibilityState"] = "visible"): WindowClient =>
  ({ focus: vi.fn(async () => undefined), focused, url, visibilityState });

describe("push service worker", () => {
  it("shows the notification with its title, outcome and chat link", async () => {
    const sw = worker([window("https://aiqsa.example/c/another-chat")]);
    await sw.push(message);
    expect(sw.shown).toEqual([{
      options: { badge: "/icon-192.png", body: "Answer ready", data: { url: "/c/chat-1" }, icon: "/icon-192.png", tag: "aiqsa-chat-chat-1" },
      title: "Trip plan"
    }]);
  });

  it("shows every push, even while a focused window shows that chat", async () => {
    // Safari revokes subscriptions whose pushes show nothing; the server skips the device instead.
    for (const client of [window("https://aiqsa.example/c/chat-1"), window("https://aiqsa.example/c/chat-1", false)]) {
      const sw = worker([client]);
      await sw.push(message);
      expect(sw.shown).toHaveLength(1);
    }
  });

  it("shows a generic notice for an unreadable message and never links off-site", async () => {
    for (const data of [{ ...message, v: 2 }, { ...message, url: "https://evil.example/c/chat-1" }, { title: 1 }]) {
      const sw = worker();
      await sw.push(data);
      expect(sw.shown).toEqual([{ options: { body: "Something finished in AIQSA.", tag: "aiqsa" }, title: "AIQSA" }]);
    }
  });

  it("focuses the window already on the chat, otherwise opens it", async () => {
    const existing = window("https://aiqsa.example/c/chat-1", false);
    const focusing = worker([window("https://aiqsa.example/"), existing]);
    const notification = await focusing.click("/c/chat-1");
    expect(notification.close).toHaveBeenCalled();
    expect(existing.focus).toHaveBeenCalled();
    expect(focusing.self.clients.openWindow).not.toHaveBeenCalled();

    const opening = worker([window("https://aiqsa.example/c/other")]);
    await opening.click("/c/chat-1");
    expect(opening.self.clients.openWindow).toHaveBeenCalledWith("https://aiqsa.example/c/chat-1");

    const foreign = worker();
    await foreign.click("https://evil.example/");
    expect(foreign.self.clients.openWindow).not.toHaveBeenCalled();
  });
});
