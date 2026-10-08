import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { decodeBase32, totpCodeAt, totpStep } from "../../lib/server/auth/totp";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { createPeopleFixture, type E2EUser } from "./support/people";
import { submitPasswordSignIn } from "./support/workspace";

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);

test.afterAll(async () => {
  await people.cleanup();
  await prisma.$disconnect();
});

/**
 * The spec plays the authenticator app: it computes codes from the key the settings page
 * shows. Each step's code is accepted once, so it uses a step after the last one it used:
 * the server accepts one step ahead, and beyond that it waits for the clock.
 */
function authenticator(secret: string) {
  const key = decodeBase32(secret.replace(/\s+/gu, ""));
  expect(key).not.toBeNull();
  let lastStep = -1;

  return {
    async next(): Promise<string> {
      while (lastStep + 1 > totpStep(new Date()) + 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const step = Math.max(totpStep(new Date()), lastStep + 1);
      lastStep = step;
      return totpCodeAt(key!, step);
    },
    reuse(): string {
      return totpCodeAt(key!, lastStep);
    }
  };
}

async function openAccountSettings(page: Page) {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "Account", exact: true }).click();
  return settings;
}

/** Signs in with the password in a fresh context and stops at the second step. */
async function passwordStep(browser: Browser, user: E2EUser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce", ...options });
  const page = await context.newPage();
  await page.goto("/login");
  await submitPasswordSignIn(page, user);
  await expect(page.getByRole("heading", { level: 1, name: "Two-factor verification" })).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

async function submitSecondFactor(page: Page, value: string, kind: "recovery" | "totp" = "totp") {
  const form = page.getByTestId("second-factor-form");
  const field = form.getByLabel(kind === "totp" ? "Authentication code" : "Recovery code");
  await field.fill(value);
  await form.getByRole("button", { name: "Verify", exact: true }).click();
}

test("password sign-in with TOTP: enrolment, codes, replay, recovery codes and an administrator reset", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const user = await people.user("totp");
  const admin = await people.admin("totp-admin");

  // Enrolment from Account settings: QR code and key, a confirming code, codes shown once.
  const { page } = await people.signIn(browser, user);
  const settings = await openAccountSettings(page);
  const row = settings.getByTestId("settings-two-factor");
  await expect(row).toContainText("Off.");
  await row.getByRole("button", { name: "Turn on…" }).click();
  const setup = settings.getByTestId("settings-two-factor-setup");
  await expect(setup.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const app = authenticator(await setup.getByTestId("settings-two-factor-key").innerText());
  await page.screenshot({ path: info.outputPath("totp-setup-desktop.png") });
  await setup.getByLabel("Code from the app").fill(await app.next());
  await setup.getByRole("button", { name: "Turn on", exact: true }).click();
  const shown = settings.getByTestId("settings-two-factor-codes");
  await expect(shown.getByRole("listitem")).toHaveCount(10);
  const recoveryCodes = await shown.getByRole("listitem").allInnerTexts();
  await page.screenshot({ path: info.outputPath("totp-recovery-codes-desktop.png") });
  await shown.getByRole("button", { name: "I saved them" }).click();
  await expect(row).toContainText("On.");
  await expect(row).toContainText("10 of 10 recovery codes left.");
  // Turning off needs a current code.
  await row.getByRole("button", { name: "Turn off…" }).click();
  const proof = settings.getByTestId("settings-two-factor-proof");
  await proof.getByLabel("Current code from your authenticator app").fill("not-a-code");
  await proof.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(proof.getByRole("alert")).toContainText("(invalid_code)");
  await proof.getByRole("button", { name: "Cancel" }).click();

  // The password alone no longer signs in: the second step asks for a code.
  const second = await passwordStep(browser, user);
  const code = second.page.getByLabel("Authentication code");
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  expect((await second.context.cookies()).some((cookie) => cookie.name === "aiqsa_session")).toBe(false);
  await submitSecondFactor(second.page, "000000");
  await expect(second.page.getByRole("alert")).toContainText("(invalid_code)");
  await submitSecondFactor(second.page, await app.next());
  await expect(second.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await second.context.close();

  // The same code is refused a second time.
  const replay = await passwordStep(browser, user);
  await submitSecondFactor(replay.page, app.reuse());
  await expect(replay.page.getByRole("alert")).toContainText("(invalid_code)");

  // A recovery code works once.
  await replay.page.getByRole("button", { name: "Use a recovery code" }).click();
  await submitSecondFactor(replay.page, recoveryCodes[0]!, "recovery");
  await expect(replay.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await replay.context.close();
  const spent = await passwordStep(browser, user);
  await spent.page.getByRole("button", { name: "Use a recovery code" }).click();
  await submitSecondFactor(spent.page, recoveryCodes[0]!, "recovery");
  await expect(spent.page.getByRole("alert")).toContainText("That recovery code is not valid or was already used.");
  await spent.context.close();

  // An administrator reset removes the factor and signs the user out everywhere.
  const adminSession = await people.signIn(browser, admin);
  await adminSession.page.goto(`/admin?section=users&resource=${encodeURIComponent(user.id)}`);
  const userPage = adminSession.page.getByTestId("admin-user-page");
  await userPage.getByTestId("admin-user-reset-two-factor").click();
  const dialog = adminSession.page.getByTestId("admin-confirm-reset-user-two-factor");
  await expect(dialog).toBeVisible();
  await adminSession.page.screenshot({ path: info.outputPath("totp-admin-reset-confirm.png") });
  await dialog.getByRole("button", { name: /reset two-factor/iu }).click();
  await expect(userPage.getByTestId("admin-user-reset-two-factor")).toHaveCount(0);
  await expect.poll(async () => (await page.request.get("/api/me")).status(), { timeout: 15_000 }).toBe(401);

  const afterReset = await browser.newContext({ locale: "en-US" });
  const plainPage = await afterReset.newPage();
  await plainPage.goto("/login");
  await submitPasswordSignIn(plainPage, user);
  await expect(plainPage.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await afterReset.close();
});

test("the second step fits and works on phone, tablet and desktop, by keyboard and touch", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const user = await people.user("totp-layout");
  const { page } = await people.signIn(browser, user);
  const settings = await openAccountSettings(page);
  await settings.getByTestId("settings-two-factor").getByRole("button", { name: "Turn on…" }).click();
  const setup = settings.getByTestId("settings-two-factor-setup");
  const app = authenticator(await setup.getByTestId("settings-two-factor-key").innerText());
  await setup.getByLabel("Code from the app").fill(await app.next());
  await setup.getByRole("button", { name: "Turn on", exact: true }).click();
  await settings.getByTestId("settings-two-factor-codes").getByRole("button", { name: "I saved them" }).click();

  for (const [name, options] of [
    ["phone-portrait", { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } }],
    ["phone-landscape", { hasTouch: true, isMobile: true, viewport: { height: 390, width: 844 } }],
    ["tablet", { hasTouch: true, viewport: { height: 1024, width: 768 } }],
    ["desktop", { viewport: { height: 900, width: 1440 } }]
  ] as const) {
    const step = await passwordStep(browser, user, options);
    await expectNoHorizontalOverflow(step.page);
    await step.page.screenshot({ path: info.outputPath(`totp-second-step-${name}.png`) });
    const field = step.page.getByLabel("Authentication code");
    await expect(field).toBeFocused();
    if (options.viewport.width >= 1024) {
      // Keyboard only: type the code and submit with Enter.
      await step.page.keyboard.type(await app.next());
      await step.page.keyboard.press("Enter");
    } else {
      await field.tap();
      await field.fill(await app.next());
      await step.page.getByRole("button", { name: "Verify", exact: true }).tap();
    }
    await expect(step.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await step.context.close();
  }
});
