/** Wire contract of `/api/me/push-subscriptions`. */

export const BROWSER_PUSH_SUBSCRIPTIONS_PATH = "/api/me/push-subscriptions";
/** POST `{ runId }`: this device showed that run's end on screen, so its push skips the device. */
export const BROWSER_PUSH_SHOWN_RUNS_PATH = "/api/me/push-subscriptions/shown-runs";
/** The service worker that shows browser push notifications; served anonymously at the root scope. */
export const BROWSER_PUSH_SERVICE_WORKER_PATH = "/sw.js";

export type BrowserPushErrorCode =
  | "browser_notifications_disabled"
  | "push_subscription_invalid"
  | "push_unavailable";

/** GET: the installation's VAPID public key (uncompressed P-256 point, base64url). */
export type BrowserPushKeyResponse = Readonly<{
  applicationServerKey: string;
}>;

/** POST and DELETE: the browser's `PushSubscription.toJSON()`; DELETE reads only `endpoint`. */
export type BrowserPushSubscriptionRequest = Readonly<{
  endpoint: string;
  keys: Readonly<{ auth: string; p256dh: string }>;
}>;

export type BrowserPushShownRunRequest = Readonly<{
  runId: string;
}>;

/**
 * The decrypted push message the service worker shows: a title, an outcome
 * line and a same-origin path. It never carries answer text, prompts or
 * internal identifiers other than the chat id inside `url`.
 */
export type BrowserPushMessage = Readonly<{
  body: string;
  /** Coalesces repeated notices of one chat or of scheduled tasks. */
  tag: string;
  title: string;
  /** `/c/<chatId>`, `/scheduled` or, for administrators' budget alerts, `/admin?section=limits`. */
  url: string;
  v: 1;
}>;

export function decodeBrowserPushKeyResponse(value: unknown): BrowserPushKeyResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = (value as { applicationServerKey?: unknown }).applicationServerKey;
  return typeof key === "string" && /^[A-Za-z0-9_-]{80,100}$/u.test(key) ? { applicationServerKey: key } : null;
}
