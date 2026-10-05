import {
  BROWSER_PUSH_SERVICE_WORKER_PATH,
  BROWSER_PUSH_SHOWN_RUNS_PATH,
  BROWSER_PUSH_SUBSCRIPTIONS_PATH,
  decodeBrowserPushKeyResponse,
  type BrowserPushShownRunRequest
} from "@/lib/contracts/browserPush";

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";

/** The browser APIs push needs; injectable so the flow is testable without a real browser. */
export type BrowserPushEnvironment = Readonly<{
  fetch: typeof fetch;
  notification: Readonly<{ permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> }> | null;
  serviceWorker: Pick<ServiceWorkerContainer, "getRegistration" | "ready" | "register"> | null;
}>;

export function browserPushEnvironment(): BrowserPushEnvironment | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const supported = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window &&
    typeof window.Notification === "function";
  return {
    fetch: window.fetch.bind(window),
    notification: supported ? window.Notification : null,
    serviceWorker: supported ? navigator.serviceWorker : null
  };
}

export function notificationPermission(environment: BrowserPushEnvironment | null): BrowserNotificationPermission {
  if (!environment?.notification || !environment.serviceWorker) return "unsupported";
  return environment.notification.permission;
}

/** Web Push on iPhone and iPad works only for the app added to the Home Screen. */
export function isAppleMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}

async function registration(environment: BrowserPushEnvironment): Promise<ServiceWorkerRegistration> {
  const container = environment.serviceWorker!;
  await container.register(BROWSER_PUSH_SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" });
  // Subscribing needs the active worker; `ready` waits for it.
  return container.ready;
}

export type BrowserPushSyncResult = "disabled" | "failed" | "subscribed" | "unsupported";

/**
 * Registers the worker and binds this device's push subscription to the
 * signed-in account and session. A subscription made for another server key
 * is replaced. Safe to repeat: the server upserts by endpoint.
 */
export async function syncBrowserPushSubscription(environment: BrowserPushEnvironment | null): Promise<BrowserPushSyncResult> {
  if (notificationPermission(environment) !== "granted") return "unsupported";
  const env = environment!;
  try {
    const keyResponse = await env.fetch(BROWSER_PUSH_SUBSCRIPTIONS_PATH, { cache: "no-store", credentials: "same-origin" });
    const key = keyResponse.ok ? decodeBrowserPushKeyResponse(await keyResponse.json().catch(() => null)) : null;
    if (!key) return "failed";
    const applicationServerKey = decodeKey(key.applicationServerKey);
    const worker = await registration(env);
    let subscription = await worker.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({ applicationServerKey, userVisibleOnly: true });
    const response = await env.fetch(BROWSER_PUSH_SUBSCRIPTIONS_PATH, {
      body: JSON.stringify(subscription.toJSON()),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (response.status === 409) return "disabled";
    return response.ok ? "subscribed" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Drops this browser's push subscription after notifications were turned
 * off; the server already removed every subscription of the account.
 */
export async function removeBrowserPushSubscription(environment: BrowserPushEnvironment | null): Promise<void> {
  if (!environment?.serviceWorker) return;
  try {
    const worker = await environment.serviceWorker.getRegistration("/");
    const subscription = await worker?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Nothing is delivered to it any more: the server holds no subscription.
  }
}

/**
 * Tells the server this device showed the run's end, so the run's push skips
 * it. Best effort: a lost report only means the notification still arrives.
 */
export function reportShownRun(environment: BrowserPushEnvironment, runId: string): void {
  void environment.fetch(BROWSER_PUSH_SHOWN_RUNS_PATH, {
    body: JSON.stringify({ runId } satisfies BrowserPushShownRunRequest),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    keepalive: true,
    method: "POST"
  }).catch(() => undefined);
}
