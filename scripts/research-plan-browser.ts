/**
 * The user of scenario T's acts (`scripts/smoke-subagents-paid.ts`), driven by Playwright through the real pages. `edit` and `start` work the card while a
 * real research plan's window is open: wait for it, optionally change a step, press the button. `push` is a device that subscribed and went elsewhere: a
 * Firefox, whose push service needs no vendor keys, on the home page, which never reports the run as shown, waits for the notification. Nothing typed comes
 * from a model and nothing read from the page leaves here: the evidence holds counts and booleans. The browser is closed on every path, including the harness's abort.
 */
import { chromium, firefox } from "@playwright/test";
import { browserChannel, sessionCookies } from "./browser-scenarios-handoff";
import type { InteractionEvidence, ScenarioInteraction } from "./browser-scenarios-support";

/** The card follows scoping, which may take its three minutes and a model's slow first response. */
const CARD_WAIT_MS = 8 * 60_000;
/** After the press the plan stands at once, or after one more model call when it was changed. */
const CARD_GONE_WAIT_MS = 4 * 60_000;
const STEP_ADDITION = " (только независимые источники и точные модели)";

export function planInBrowser(act: "edit" | "start"): ScenarioInteraction {
  return async ({ baseUrl, chatId, cookie, signal }): Promise<InteractionEvidence> => {
    const evidence: Record<string, boolean | string> = { cardGone: false, cardShown: false, clockShown: false, edited: false, failedAt: false, pressed: false };
    let stage = "launch";
    if (signal.aborted) return evidence;
    const channel = browserChannel();
    const browser = await chromium.launch({ headless: true, ...channel ? { channel } : {} });
    const close = () => { void browser.close().catch(() => undefined); };
    signal.addEventListener("abort", close, { once: true });
    try {
      stage = "open";
      const context = await browser.newContext({ baseURL: baseUrl, viewport: { height: 900, width: 1440 } });
      await context.addCookies(sessionCookies(cookie, baseUrl));
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(`/c/${encodeURIComponent(chatId)}`, { timeout: 90_000, waitUntil: "domcontentloaded" });
      stage = "card";
      const card = page.getByTestId("research-plan-card").last();
      await card.waitFor({ state: "visible", timeout: CARD_WAIT_MS });
      evidence.cardShown = true;
      stage = "act";
      evidence.clockShown = await card.getByTestId("research-plan-clock").isVisible();
      if (act === "edit") {
        await card.getByRole("button", { exact: true, name: "Edit" }).click();
        const step = card.getByLabel("Step 1", { exact: true });
        await step.fill(`${await step.inputValue()}${STEP_ADDITION}`);
        evidence.edited = true;
      }
      await card.getByRole("button", { exact: true, name: "Начать поиск" }).click();
      evidence.pressed = true;
      stage = "gone";
      await card.waitFor({ state: "hidden", timeout: CARD_GONE_WAIT_MS });
      evidence.cardGone = true;
      return evidence;
    } catch (error) {
      return { ...evidence, failedAt: `${stage}:${error instanceof Error ? error.name : "unknown"}` };
    } finally {
      signal.removeEventListener("abort", close);
      await browser.close().catch(() => undefined);
    }
  };
}

const PUSH_PREFS = { "dom.push.connection.enabled": true, "dom.push.enabled": true, "dom.push.serverURL": "wss://push.services.mozilla.com/", "dom.serviceWorkers.enabled": true,
  "permissions.default.desktop-notification": 1 };
const PUSH_POLL_MS = 5_000;

/** Subscribes as the app's client does, and reads what the worker has shown until `signal` ends. */
export const pushInBrowser: ScenarioInteraction = async ({ baseUrl, cookie, signal }): Promise<InteractionEvidence> => {
  const evidence: Record<string, boolean | number | string | null> = { notifications: 0, subscribed: null };
  if (signal.aborted) return evidence;
  const browser = await firefox.launch({ firefoxUserPrefs: PUSH_PREFS, headless: true });
  try {
    const context = await browser.newContext({ baseURL: baseUrl });
    await context.addCookies(sessionCookies(cookie, baseUrl));
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    evidence.subscribed = await page.evaluate(async () => {
      const path = "/api/me/push-subscriptions";
      const key = await (await fetch(path, { cache: "no-store" })).json() as { applicationServerKey: string };
      const raw = atob(key.applicationServerKey.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(key.applicationServerKey.length / 4) * 4, "="));
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const worker = await navigator.serviceWorker.ready;
      const subscription = await worker.pushManager.subscribe({ applicationServerKey: Uint8Array.from(raw, (character) => character.charCodeAt(0)), userVisibleOnly: true });
      const saved = await fetch(path, { body: JSON.stringify(subscription.toJSON()), headers: { "content-type": "application/json" }, method: "POST" });
      return saved.status;
    }).catch((error: unknown) => error instanceof Error ? error.message.slice(0, 80).replace(/[^\w .:-]+/gu, " ") : "subscribe_failed");
    while (!signal.aborted && evidence.notifications === 0) {
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, PUSH_POLL_MS); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
      evidence.notifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length).catch(() => evidence.notifications);
    }
    return evidence;
  } finally {
    await browser.close().catch(() => undefined);
  }
};
