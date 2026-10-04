import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserPushEnvironment } from "./browserNotificationsClient";
import { BrowserNotificationsBannerV2, BrowserNotificationsSettingsRowV2 } from "./BrowserNotificationsV2";
import { BROWSER_PUSH_RESYNC_MS, BROWSER_PUSH_RETRY_MS, useBrowserNotifications } from "./useBrowserNotifications";

function bytes(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
}

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** RFC 8291 example public keys: any two distinct P-256 points serve here. */
const serverKey = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const otherServerKey = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

function fakeSubscription(key: string) {
  return {
    options: { applicationServerKey: bytes(key).buffer },
    toJSON: () => ({ endpoint: "https://push.example/device", expirationTime: null, keys: { auth: "auth", p256dh: "p256dh" } }),
    unsubscribe: vi.fn(async () => true)
  };
}

function fakeBrowser(permission: NotificationPermission, existing: ReturnType<typeof fakeSubscription> | null = null) {
  let current = existing;
  const notification = {
    permission,
    requestPermission: vi.fn(async () => {
      notification.permission = "granted";
      return "granted" as const;
    })
  };
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: PushSubscriptionOptionsInit) => {
      current = fakeSubscription(base64url(options.applicationServerKey as Uint8Array));
      return current;
    })
  };
  const registration = { pushManager } as unknown as ServiceWorkerRegistration;
  const requests: Array<{ body?: unknown; method: string }> = [];
  const environment: BrowserPushEnvironment = {
    fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, method: init?.method ?? "GET" });
      return init?.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ applicationServerKey: serverKey });
    }) as typeof fetch,
    notification,
    serviceWorker: {
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      register: vi.fn(async () => registration)
    }
  };
  return { environment, notification, pushManager, requests };
}

function Harness({ accountId = "account-a", environment, initial = true }: Readonly<{
  accountId?: string; environment: BrowserPushEnvironment | null; initial?: boolean | null;
}>) {
  const [enabled, setEnabled] = useState<boolean | null>(initial);
  const notifications = useBrowserNotifications({ accountId, enabled, environment, setEnabled });
  return (
    <>
      <BrowserNotificationsBannerV2 notifications={notifications} />
      <BrowserNotificationsSettingsRowV2 notifications={notifications} />
    </>
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe("browser notifications", () => {
  it("asks for permission only from the banner click, then subscribes this device", async () => {
    const browser = fakeBrowser("default");
    render(<Harness environment={browser.environment} />);
    expect(screen.getByTestId("browser-notifications-banner")).toBeTruthy();
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.environment.serviceWorker!.register).not.toHaveBeenCalled();

    const banner = screen.getByRole("region", { name: "Browser notifications" });
    await act(async () => {
      fireEvent.click(banner.querySelector("button")!);
    });
    expect(browser.notification.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(browser.requests.some((request) => request.method === "POST")).toBe(true));
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
    expect(browser.environment.serviceWorker!.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
      applicationServerKey: bytes(serverKey), userVisibleOnly: true
    });
    expect(browser.requests.at(-1)).toEqual({
      body: { endpoint: "https://push.example/device", expirationTime: null, keys: { auth: "auth", p256dh: "p256dh" } }, method: "POST"
    });
    expect(screen.getByTestId("browser-notifications-status").textContent).toContain("This device shows a notification");
  });

  it("remembers a dismissed banner per account and still offers the request in Settings", async () => {
    const browser = fakeBrowser("default");
    const { rerender } = render(<Harness environment={browser.environment} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notifications banner" }));
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
    rerender(<Harness accountId="account-b" environment={browser.environment} />);
    expect(screen.getByTestId("browser-notifications-banner")).toBeTruthy();
    rerender(<Harness environment={browser.environment} />);
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
    const row = screen.getByTestId("settings-browser-notifications");
    expect(row.textContent).toContain("Allow notifications in this browser");
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
  });

  it("keeps an allowed device bound to the account and replaces a subscription for another server key", async () => {
    const stale = fakeSubscription(otherServerKey);
    const browser = fakeBrowser("granted", stale);
    render(<Harness environment={browser.environment} />);
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
    await waitFor(() => expect(browser.requests.some((request) => request.method === "POST")).toBe(true));
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it("turning the setting off removes this browser's subscription and hides the banner", async () => {
    const existing = fakeSubscription(serverKey);
    const browser = fakeBrowser("granted", existing);
    render(<Harness environment={browser.environment} />);
    await waitFor(() => expect(browser.requests.some((request) => request.method === "POST")).toBe(true));
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Browser notifications" }));
    await waitFor(() => expect(existing.unsubscribe).toHaveBeenCalled());
    expect(screen.getByTestId("browser-notifications-status").textContent).toContain("Get a notification when");
  });

  it("explains blocked and unsupported browsers without offering a prompt", () => {
    const blocked = fakeBrowser("denied");
    const { unmount } = render(<Harness environment={blocked.environment} />);
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
    expect(screen.getByTestId("browser-notifications-status").textContent).toContain("blocked for this site");
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
    unmount();

    render(<Harness environment={null} />);
    expect(screen.getByTestId("browser-notifications-status").textContent).toContain("does not support notifications");
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
  });

  it("waits for the account setting before showing or syncing anything", () => {
    const browser = fakeBrowser("default");
    render(<Harness environment={browser.environment} initial={null} />);
    expect(screen.queryByTestId("browser-notifications-banner")).toBeNull();
    expect((screen.getByRole("switch", { name: "Browser notifications" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rebinds a shown device after a while and retries a binding that failed", async () => {
    const { environment, requests } = fakeBrowser("granted");
    let failNext = true;
    const baseFetch = environment.fetch;
    environment.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && failNext) {
        failNext = false;
        requests.push({ body: undefined, method: "POST" });
        return new Response(null, { status: 503 });
      }
      return baseFetch(url, init);
    }) as typeof fetch;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      render(<Harness environment={environment} />);
      await waitFor(() => expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1));
      // The failed first binding is retried on the next showing.
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      await waitFor(() => expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(2));
      // A bound device is not rebound on every focus...
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(2);
      // ...but is after a while, in case another device turned push off and on.
      now.mockReturnValue(1_000_000 + BROWSER_PUSH_RESYNC_MS + 1);
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(3));
    } finally {
      now.mockRestore();
    }
  });

  it("registers again shortly when the server still holds the setting off right after enabling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { environment, requests } = fakeBrowser("granted");
      let refusals = 1;
      const baseFetch = environment.fetch;
      environment.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST" && refusals > 0) {
          refusals -= 1;
          requests.push({ body: undefined, method: "POST" });
          return Response.json({ error: "browser_notifications_disabled" }, { status: 409 });
        }
        return baseFetch(url, init);
      }) as typeof fetch;
      render(<Harness environment={environment} />);
      await waitFor(() => expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_PUSH_RETRY_MS + 10); });
      await waitFor(() => expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
