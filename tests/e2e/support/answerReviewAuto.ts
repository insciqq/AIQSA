import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Automatic answer review through the real UI, shared by the fake-provider
 * stand (answer-review-auto.spec.ts, answer-review-screens.spec.ts) and the
 * paid scenario (answer-review-auto-paid.spec.ts): the chat's choice in the
 * model picker and a push stack whose deliveries are counted on the server.
 */

export function modelPicker(page: Page): Locator {
  return page.getByRole("dialog", { name: "Choose model" });
}

export function answerReviewSettingsDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Answer review", exact: true });
}

/** The composer's chips by name: turning review on adds none. */
export function composerChips(page: Page): Promise<string[]> {
  return page.getByTestId("composer-v2").locator(".v2-composer-indicator")
    .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("aria-label") ?? chip.textContent?.trim() ?? ""));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Opens the chat's automatic review settings from the model picker's "Answer review" row. */
export async function openAnswerReviewSettings(page: Page): Promise<Locator> {
  await page.getByTestId("header-model-trigger").click();
  const row = modelPicker(page).getByTestId("composer-v2-model-answer-review");
  await expect(row).toBeEnabled();
  await row.click();
  await expect(modelPicker(page)).toHaveCount(0);
  const dialog = answerReviewSettingsDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Turns the chat's automatic review on with `reviewer` (by its exact display
 * name) as the only reviewer, or off, from the model picker's row, and saves.
 */
export async function chooseAnswerReview(page: Page, input: Readonly<{
  enabled: boolean;
  reviewer: string;
  rounds?: 1 | 2 | 3;
}>): Promise<void> {
  const dialog = await openAnswerReviewSettings(page);
  const toggle = dialog.getByRole("switch", { name: /Review answers automatically/u });
  if (await toggle.getAttribute("aria-checked") !== String(input.enabled)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(input.enabled));
  if (input.enabled) {
    // Only the chosen reviewer: the installation may offer other tool-calling models.
    // Every box by position, so unchecking one never shifts the others.
    for (const box of await dialog.getByRole("checkbox").all()) {
      const name = (await box.locator("xpath=following-sibling::span[1]").innerText()).trim();
      if (name !== input.reviewer && await box.isChecked()) await box.uncheck();
    }
    await dialog.getByRole("checkbox", { exact: true, name: input.reviewer }).check();
    const rounds = input.rounds ?? 3;
    const label = rounds === 1 ? "1 round" : `Up to ${rounds}`;
    await dialog.locator("label.v2-answer-review-round", { hasText: label }).click();
    await expect(dialog.getByRole("radio", { name: label })).toBeChecked();
    await expect(dialog.getByTestId("answer-review-cost-hint")).toContainText(`Up to ${rounds * 2} extra answers per question`);
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  const glyph = page.getByTestId("header-model-review");
  if (input.enabled) await expect(glyph).toHaveAttribute("data-state", "on");
  else await expect(glyph).toHaveCount(0);
}

/** A push endpoint that never resolves: each delivery attempt counts as one failure on its subscription. */
export function unresolvablePushEndpoint(label: string): string {
  return `https://push.invalid/aiqsa-${label}-${randomUUID()}`;
}

/** A granted push stack whose subscription the real server stores; its endpoint never resolves. */
export async function grantPush(page: Page, endpoint: string): Promise<void> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const device = { endpoint, expirationTime: null,
    keys: { auth: randomBytes(16).toString("base64url"), p256dh: ecdh.getPublicKey().toString("base64url") } };
  await page.addInitScript(({ subscription }) => {
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
          toJSON: () => subscription,
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
  }, { subscription: device });
}
