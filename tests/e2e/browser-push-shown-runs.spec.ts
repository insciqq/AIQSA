import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { BROWSER_PUSH_SHOWN_RUNS_PATH } from "../../lib/contracts/browserPush";
import { hashPassword } from "../../lib/server/auth/password";
import { sendAndExpect } from "./support/workspace";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

type ShownRunWindow = Window & { __setPageHidden(hidden: boolean): void };

/**
 * A granted push stack whose subscription the real server stores, on a page
 * that behaves like an installed iPhone web app: touch-first and reporting no
 * focus, with a visibility the test switches. The endpoint never resolves, so
 * a push the server sends shows up as a failed delivery on the subscription.
 */
async function installInstalledPhoneApp(page: Page, subscription: unknown) {
  await page.addInitScript(({ subscription: device }) => {
    class GrantedNotification {
      static readonly permission: NotificationPermission = "granted";
      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve("granted");
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: GrantedNotification, writable: true });
    type Subscription = Readonly<{ options: Readonly<{ applicationServerKey: ArrayBuffer }>; toJSON(): unknown; unsubscribe(): Promise<boolean> }>;
    let current: Subscription | null = null;
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        current = {
          options: { applicationServerKey: (options.applicationServerKey as Uint8Array).slice().buffer },
          toJSON: () => device,
          unsubscribe: async () => { current = null; return true; }
        };
        return current;
      }
    };
    const registration = { pushManager, scope: `${location.origin}/` };
    const container = { getRegistration: async () => registration, ready: Promise.resolve(registration), register: async () => registration };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, get: () => container });
    if (!("PushManager" in window)) {
      Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {}, writable: true });
    }
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.hasFocus = () => false;
    (window as unknown as ShownRunWindow).__setPageHidden = (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  }, { subscription });
}

function setPageHidden(page: Page, hidden: boolean) {
  return page.evaluate((value) => (window as unknown as ShownRunWindow).__setPageHidden(value), hidden);
}

test("an answer completed on screen skips this device's push; one completed while hidden is pushed", async ({ browser }) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const id = randomUUID();
  const email = `push@shown-${id}.example.test`;
  const password = `Push-fixture-${id}!`;
  const fakeModel = await prisma.providerModel.findFirstOrThrow({ where: { templateKey: "fake:fake-qsa" } });
  const user = await prisma.user.create({ data: {
    displayName: "Push fixture", email, role: "user", status: "active",
    authIdentities: { create: { emailVerifiedAt: new Date(), normalizedEmail: email,
      passwordHash: await hashPassword(password), provider: "password", providerAccountId: email } },
    accessGrants: { create: { enabled: true, providerModelId: fakeModel.id } },
    // Tools off: their definitions alone outgrow the fake model's 8k window (context_too_large).
    settings: { create: { browserNotificationsEnabled: true, defaultProviderModelId: fakeModel.id, defaultMcpMode: "off",
      defaultSearchPlan: { mode: "all_selected", optionIds: [] }, defaultSkillsMode: "off", defaultWorkspaceEnabled: false } }
  } });
  await prisma.userMemorySettings.update({ where: { userId: user.id }, data: {
    learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false } });
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const endpoint = `https://push.invalid/aiqsa-e2e-${id}`;
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:3000", hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  const reports: Array<{ runId: unknown; status: number }> = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() === "POST" && new URL(request.url()).pathname === BROWSER_PUSH_SHOWN_RUNS_PATH) {
      reports.push({ runId: (request.postDataJSON() as { runId?: unknown }).runId, status: response.status() });
    }
  });
  const subscription = () => prisma.browserPushSubscription.findUnique({ where: { endpoint } });
  const latestRunId = async () => (await prisma.modelRun.findFirstOrThrow({
    where: { userId: user.id }, orderBy: { createdAt: "desc" }, select: { id: true }
  })).id;
  const claimed = (runId: string) => prisma.browserPushDelivery.findUnique({ where: { runId } });
  try {
    await installInstalledPhoneApp(page, {
      endpoint, expirationTime: null,
      keys: { auth: randomBytes(16).toString("base64url"), p256dh: ecdh.getPublicKey().toString("base64url") }
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => [document.hasFocus(), window.matchMedia("(pointer: coarse)").matches])).toEqual([false, true]);
    await expect.poll(async () => (await subscription())?.userId ?? null, { timeout: 30_000 }).toBe(user.id);

    // Answer finishes while the person watches: the page reports it, and the
    // server, after its grace, claims the run without posting to this device.
    await sendAndExpect(page, "Push shown fixture", "Fake answer: Push shown fixture");
    const shownRunId = await latestRunId();
    await expect.poll(() => reports, { timeout: 15_000 }).toEqual([{ runId: shownRunId, status: 204 }]);
    await expect.poll(async () => Boolean(await claimed(shownRunId)), { timeout: 30_000 }).toBe(true);

    // Answer finishes while the app is in the background: no report, so the
    // push goes to this device (and fails at the unresolvable endpoint).
    await setPageHidden(page, true);
    await sendAndExpect(page, "Push hidden fixture", "Fake answer: Push hidden fixture");
    const hiddenRunId = await latestRunId();
    expect(hiddenRunId).not.toBe(shownRunId);
    await expect.poll(async () => Boolean(await claimed(hiddenRunId)), { timeout: 30_000 }).toBe(true);
    // Deliveries run in order, so one failure means the shown run sent nothing.
    await expect.poll(async () => (await subscription())?.failureCount, { timeout: 90_000 }).toBe(1);
    await setPageHidden(page, false);
    await page.waitForTimeout(2_000);
    expect(reports).toEqual([{ runId: shownRunId, status: 204 }]);
  } finally {
    await context.close().catch(() => undefined);
    // Only this test's account: its runs, chats, sessions and subscription cascade with it.
    await prisma.$transaction(async (tx) => {
      await tx.providerRunBinding.deleteMany({ where: { modelRun: { userId: user.id } } });
      await tx.modelRun.deleteMany({ where: { userId: user.id } });
      await tx.workspaceSession.deleteMany({ where: { chat: { userId: user.id } } });
      await tx.user.deleteMany({ where: { id: user.id } });
    });
  }
});
