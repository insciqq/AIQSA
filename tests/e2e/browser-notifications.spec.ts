import { expect, test, type Locator, type Page } from "@playwright/test";
import { BROWSER_PUSH_SUBSCRIPTIONS_PATH } from "../../lib/contracts/browserPush";
import type { Catalog } from "../../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { captureState } from "./support/capture";
import {
  expectCenterUnobscured,
  expectNoHorizontalOverflow,
  expectTouchSafe,
  expectWithinViewport
} from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Mocked owner APIs and a stubbed browser push stack: no real push service is
// ever contacted. The browser clock and zone are fixed so every date is stable.
const now = new Date("2026-10-04T10:00:00.000Z");
const model = matrixCatalog.models[0]!;
const chatId = "notifications-thread-chat";
const touchSizes = [{ width: 390, height: 844 }, { width: 844, height: 390 }];
/** Any valid uncompressed P-256 point serves as the installation's VAPID key. */
const serverKey = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const deviceSubscription = {
  endpoint: "https://push.invalid/aiqsa-e2e-device",
  expirationTime: null,
  keys: { auth: "e2e-auth", p256dh: "e2e-p256dh" }
};
const dismissedKeyPrefix = "aiqsa.browserNotifications.bannerDismissed:";
const copy = {
  allowed: "This device shows a notification when an answer or a scheduled task finishes while AIQSA is in the background or closed.",
  banner: "Get notified when answers and scheduled tasks finish, even with AIQSA closed.",
  blocked: "Notifications are blocked for this site. Allow them in your browser’s site settings, then reload AIQSA.",
  off: "Get a notification when an answer or a scheduled task finishes while AIQSA is in the background or closed.",
  request: "Allow notifications in this browser to receive them on this device.",
  unsupported: "This browser does not support notifications."
};

test.use({ timezoneId: "Europe/London" });
test.setTimeout(240_000);

/** The account setting is on; the fixture serves it off unless a spec opts in. */
const notificationsCatalog: Catalog = {
  ...matrixCatalog,
  defaults: { ...matrixCatalog.defaults, browserNotificationsEnabled: true }
};

type StubPermission = "default" | "denied" | "granted" | "unsupported";
type PushStubLog = Readonly<{ registered: string[]; requested: number; subscribed: number; unsubscribed: number }>;

/**
 * Replaces the browser's notification permission and service worker with
 * in-page fakes before any app script runs. Headless Chromium has no push
 * service, and a real subscription would reach one; the fakes record what
 * the app asked for instead. `unsupported` leaves a browser without push.
 */
async function installPushStub(page: Page, initial: StubPermission) {
  await page.addInitScript(({ initial: start, subscription }) => {
    const log = { registered: [] as string[], requested: 0, subscribed: 0, unsubscribed: 0 };
    (window as unknown as { __pushStub: typeof log }).__pushStub = log;
    if (start === "unsupported") {
      Object.defineProperty(window, "Notification", { configurable: true, value: undefined, writable: true });
      return;
    }
    let permission = start as NotificationPermission;
    class FakeNotification {
      static get permission(): NotificationPermission {
        return permission;
      }

      static requestPermission(): Promise<NotificationPermission> {
        log.requested += 1;
        // The person accepts the browser prompt.
        permission = "granted";
        return Promise.resolve(permission);
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification, writable: true });
    type FakeSubscription = Readonly<{
      endpoint: string;
      options: Readonly<{ applicationServerKey: ArrayBuffer }>;
      toJSON(): typeof subscription;
      unsubscribe(): Promise<boolean>;
    }>;
    let current: FakeSubscription | null = null;
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        log.subscribed += 1;
        const key = options.applicationServerKey as Uint8Array;
        current = {
          endpoint: subscription.endpoint,
          options: { applicationServerKey: key.slice().buffer },
          toJSON: () => subscription,
          unsubscribe: async () => {
            log.unsubscribed += 1;
            current = null;
            return true;
          }
        };
        return current;
      }
    };
    const registration = { pushManager, scope: `${location.origin}/` };
    let registered = false;
    const container = {
      getRegistration: async () => registered ? registration : undefined,
      ready: Promise.resolve(registration),
      register: async (path: string) => {
        log.registered.push(path);
        registered = true;
        return registration;
      }
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, get: () => container });
    if (!("PushManager" in window)) {
      Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {}, writable: true });
    }
    // The suite's 127.0.0.1 origin is secure already; this keeps the stub independent of the stand's address.
    if (!window.isSecureContext) Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => true });
  }, { initial, subscription: deviceSubscription });
}

function pushStubLog(page: Page): Promise<PushStubLog> {
  return page.evaluate(() => {
    const log = (window as unknown as { __pushStub: PushStubLog }).__pushStub;
    return { registered: [...log.registered], requested: log.requested, subscribed: log.subscribed, unsubscribed: log.unsubscribed };
  });
}

async function installPushApi(page: Page) {
  const state = { deletes: [] as unknown[], keyReads: 0, posts: [] as unknown[] };
  await page.route(`**${BROWSER_PUSH_SUBSCRIPTIONS_PATH}`, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") {
      state.keyReads += 1;
      return route.fulfill({ json: { applicationServerKey: serverKey } });
    }
    if (method === "POST") {
      state.posts.push(request.postDataJSON());
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "DELETE") {
      state.deletes.push(request.postData() ? request.postDataJSON() : null);
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
  });
  return state;
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: "2026-10-04T09:00:00.000Z", status: "complete",
    citationMessageId: null, errorMessage: null, modelId: role === "assistant" ? model.modelId : null,
    modelRunId: null, provider: role === "assistant" ? model.provider : null };
}

function threadChat(): ChatDetailWire {
  const updatedAt = "2026-10-04T09:01:00.000Z";
  return {
    assistant: null, id: chatId, title: "Trip packing list", createdAt: "2026-10-04T09:00:00.000Z", updatedAt,
    activeLeafMessageId: "packing-answer", defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null,
    pinned: false, messageCount: 2, usageStats: null, contextStats: { approximateActiveBranchInputTokens: 200 },
    pageInfo: { activeLeafMessageId: "packing-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: [
      message("packing-question", "user", "Make a short packing list for a weekend hike.", null),
      message("packing-answer", "assistant", "Here is a short list:\n\n- Rain jacket\n- Water bottle\n- Map and snacks", "packing-question")
    ]
  };
}

async function prepare(page: Page, permission: StubPermission, theme: "dark" | "light" = "light") {
  const chats = [threadChat()];
  await page.clock.setFixedTime(now);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
  await installPushStub(page, permission);
  await installMatrixCatalogFixture(page, { chats, folders: [] }, { catalog: notificationsCatalog });
  // Registered after the fixture, so it sees each settings write first and then hands it to the fixture.
  const patches: unknown[] = [];
  await page.route("**/api/me/settings", async (route) => {
    if (route.request().method() === "PATCH") patches.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: chats.map((chat) => ({ activeRun: false, assistant: null, folderId: null, id: chat.id, title: chat.title,
      updatedAt: chat.updatedAt, scheduledTask: null })),
    folders: [], nextCursor: null
  } }));
  for (const chat of chats) {
    await page.route(`**/api/chats/${chat.id}`, (route) => route.fulfill({ json: { chat } }));
    await page.route(`**/api/chats/${chat.id}/branches`, (route) => route.fulfill({ json: { branchGraph: {
      activeLeafMessageId: chat.activeLeafMessageId, snapshotUpdatedAt: chat.updatedAt,
      nodes: chat.messages.map((item) => ({ id: item.id, parentMessageId: item.parentMessageId, preview: String(item.content),
        role: item.role, status: item.status }))
    } } }));
  }
  // A missed fixture must fail before it can dispatch a provider request.
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  const api = await installPushApi(page);
  await signInWithLocalToken(page, "/");
  await expect(messageBox(page)).toBeVisible({ timeout: 30_000 });
  return { api, patches };
}

function messageBox(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

function bannerOf(page: Page): Locator {
  return page.getByRole("region", { name: "Browser notifications", exact: true });
}

async function openNotificationSettings(page: Page): Promise<Locator> {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "General", exact: true }).click();
  const row = settings.getByTestId("settings-browser-notifications");
  await expect(row.getByRole("switch", { name: "Browser notifications", exact: true })).toBeEnabled();
  return row;
}

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByTestId("settings-v2")).toHaveCount(0);
}

async function dismissedKeys(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => Object.keys(window.localStorage).filter((key) => key.startsWith(prefix)), dismissedKeyPrefix);
}

/**
 * The banner sits above the composer without covering it, both stay on
 * screen, and the controls answer a tap at their centre.
 */
async function expectBannerClearOfComposer(page: Page) {
  const banner = bannerOf(page);
  const allow = banner.getByRole("button", { name: "Allow notifications", exact: true });
  const dismiss = banner.getByRole("button", { name: "Dismiss notifications banner", exact: true });
  await messageBox(page).scrollIntoViewIfNeeded();
  for (const control of [allow, dismiss, messageBox(page)]) await expectWithinViewport(page, control);
  const [bannerBox, composerBox] = await Promise.all([
    banner.boundingBox(),
    page.getByTestId("composer-v2-surface").boundingBox()
  ]);
  expect(bannerBox, "banner box").toBeTruthy();
  expect(composerBox, "composer box").toBeTruthy();
  expect(bannerBox!.y + bannerBox!.height, "banner ends above the composer").toBeLessThanOrEqual(composerBox!.y + 1);
  for (const control of [allow, dismiss, messageBox(page)]) await expectCenterUnobscured(control);
  await expectNoHorizontalOverflow(page);
}

test("the banner asks for permission only from its click, subscribes this device and goes away", async ({ page }, info) => {
  const { api, patches } = await prepare(page, "default");
  const banner = bannerOf(page);
  await expect(banner).toContainText(copy.banner);
  const allow = banner.getByRole("button", { name: "Allow notifications", exact: true });
  // Nothing asks, registers or subscribes before the click.
  expect(await pushStubLog(page)).toEqual({ registered: [], requested: 0, subscribed: 0, unsubscribed: 0 });
  expect(api).toEqual({ deletes: [], keyReads: 0, posts: [] });
  await captureState(page, info, "browser-notifications-banner", {
    anchor: banner,
    atEachSize: async () => {
      await expectWithinViewport(page, allow);
      await expectWithinViewport(page, banner.getByRole("button", { name: "Dismiss notifications banner", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });

  await allow.click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => api.posts).toEqual([deviceSubscription]);
  expect(api.keyReads).toBe(1);
  expect(api.deletes).toEqual([]);
  expect(await pushStubLog(page)).toEqual({ registered: ["/sw.js"], requested: 1, subscribed: 1, unsubscribed: 0 });
  // Allowing is a browser permission, not an account write.
  expect(patches).toEqual([]);

  const row = await openNotificationSettings(page);
  await expect(row.getByTestId("browser-notifications-status")).toHaveText(copy.allowed);
  await expect(row.getByRole("button", { name: "Allow notifications", exact: true })).toHaveCount(0);
  await captureState(page, info, "browser-notifications-settings-allowed", {
    anchor: row,
    atEachSize: async () => {
      await expectWithinViewport(page, row.getByRole("switch", { name: "Browser notifications", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await closeSettings(page);
  await expect(banner).toHaveCount(0);
});

test("a dismissed banner stays away after a reload for that account only", async ({ page }) => {
  await prepare(page, "default");
  const banner = bannerOf(page);
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Dismiss notifications banner", exact: true }).click();
  await expect(banner).toHaveCount(0);
  const keys = await dismissedKeys(page);
  expect(keys).toHaveLength(1);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), keys[0]!)).toBe("1");

  await page.reload();
  await expect(messageBox(page)).toBeVisible({ timeout: 30_000 });
  // The setting and the permission are loaded: Settings still offers the request, the banner does not.
  const row = await openNotificationSettings(page);
  await expect(row.getByTestId("browser-notifications-status")).toHaveText(copy.request);
  await expect(row.getByRole("button", { name: "Allow notifications", exact: true })).toBeVisible();
  await closeSettings(page);
  await expect(banner).toHaveCount(0);

  // The dismissal belongs to the account: one stored for another account does not hide it.
  await page.evaluate(({ key, prefix }) => {
    window.localStorage.removeItem(key);
    window.localStorage.setItem(`${prefix}another-account`, "1");
  }, { key: keys[0]!, prefix: dismissedKeyPrefix });
  await page.reload();
  await expect(messageBox(page)).toBeVisible({ timeout: 30_000 });
  await expect(banner).toBeVisible();
  expect((await pushStubLog(page)).requested).toBe(0);
});

test("the Settings row turns notifications off and on and keeps this device's subscription in step", async ({ page }, info) => {
  const { api, patches } = await prepare(page, "granted");
  // An allowed device binds itself to the account on load; no banner is offered.
  await expect.poll(() => api.posts).toEqual([deviceSubscription]);
  await expect(bannerOf(page)).toHaveCount(0);
  const row = await openNotificationSettings(page);
  const toggle = row.getByRole("switch", { name: "Browser notifications", exact: true });
  const status = row.getByTestId("browser-notifications-status");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(status).toHaveText(copy.allowed);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(status).toHaveText(copy.off);
  await expect.poll(() => patches).toEqual([{ browserNotificationsEnabled: false }]);
  // The browser drops its subscription; the server already removed the account's.
  await expect.poll(async () => (await pushStubLog(page)).unsubscribed).toBe(1);
  await captureState(page, info, "browser-notifications-settings-off", {
    anchor: row,
    atEachSize: async () => {
      await expectWithinViewport(page, toggle);
      await expectNoHorizontalOverflow(page);
    }
  });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(status).toHaveText(copy.allowed);
  await expect.poll(() => patches).toEqual([{ browserNotificationsEnabled: false }, { browserNotificationsEnabled: true }]);
  // Turning it back on subscribes this device again.
  await expect.poll(() => api.posts).toEqual([deviceSubscription, deviceSubscription]);
  expect(await pushStubLog(page)).toEqual({ registered: ["/sw.js", "/sw.js"], requested: 0, subscribed: 2, unsubscribed: 1 });
  expect(api.deletes).toEqual([]);
});

test("the Settings row explains a blocked permission without offering a prompt", async ({ page }, info) => {
  const { api, patches } = await prepare(page, "denied");
  const row = await openNotificationSettings(page);
  await expect(row.getByRole("switch", { name: "Browser notifications", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(row.getByTestId("browser-notifications-status")).toHaveText(copy.blocked);
  await expect(row.getByRole("button", { name: "Allow notifications", exact: true })).toHaveCount(0);
  await captureState(page, info, "browser-notifications-settings-blocked", {
    anchor: row,
    atEachSize: async () => {
      await expectWithinViewport(page, row.getByTestId("browser-notifications-status"));
      await expectNoHorizontalOverflow(page);
    }
  });
  await closeSettings(page);
  await expect(bannerOf(page)).toHaveCount(0);
  expect(await pushStubLog(page)).toEqual({ registered: [], requested: 0, subscribed: 0, unsubscribed: 0 });
  expect(api).toEqual({ deletes: [], keyReads: 0, posts: [] });
  expect(patches).toEqual([]);
});

test("the Settings row explains a browser without push and keeps the account setting", async ({ page }, info) => {
  const { api, patches } = await prepare(page, "unsupported");
  const row = await openNotificationSettings(page);
  const toggle = row.getByRole("switch", { name: "Browser notifications", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(row.getByTestId("browser-notifications-status")).toHaveText(copy.unsupported);
  await expect(row.getByRole("button", { name: "Allow notifications", exact: true })).toHaveCount(0);
  await captureState(page, info, "browser-notifications-settings-unsupported", {
    anchor: row,
    atEachSize: async () => {
      await expectWithinViewport(page, row.getByTestId("browser-notifications-status"));
      await expectNoHorizontalOverflow(page);
    }
  });
  // The account setting still follows other devices: it can be turned off here.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => patches).toEqual([{ browserNotificationsEnabled: false }]);
  await closeSettings(page);
  await expect(bannerOf(page)).toHaveCount(0);
  expect(api).toEqual({ deletes: [], keyReads: 0, posts: [] });
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true });
  test("the banner stays above the composer and touch-safe on phones, short landscape included", async ({ page }, info) => {
    await prepare(page, "default");
    const banner = bannerOf(page);
    // A blank chat: the banner joins the centred composer stack.
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await expect(banner).toBeVisible();
      for (const name of ["Allow notifications", "Dismiss notifications banner"]) {
        await expectTouchSafe(banner.getByRole("button", { name, exact: true }));
      }
      await expectBannerClearOfComposer(page);
      await page.screenshot({ path: info.outputPath(`browser-notifications-banner-blank-touch-${size.width}x${size.height}.png`) });
    }

    // A chat with answers: the banner joins the docked composer and leaves the transcript room.
    await page.goto(`/c/${chatId}`);
    await expect(page.getByTestId("conversation-thread").getByText("Rain jacket")).toBeVisible({ timeout: 30_000 });
    const dock = page.locator("[data-thread-composer-dock]");
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await expect(dock.getByRole("region", { name: "Browser notifications", exact: true })).toBeVisible();
      for (const name of ["Allow notifications", "Dismiss notifications banner"]) {
        await expectTouchSafe(banner.getByRole("button", { name, exact: true }));
      }
      await expectBannerClearOfComposer(page);
      const dockBox = await dock.boundingBox();
      expect(dockBox, "composer dock box").toBeTruthy();
      expect(dockBox!.y, "the dock leaves at least a third of the screen to the transcript")
        .toBeGreaterThanOrEqual(size.height / 3);
      await page.screenshot({ path: info.outputPath(`browser-notifications-banner-thread-touch-${size.width}x${size.height}.png`) });
    }
  });
});
