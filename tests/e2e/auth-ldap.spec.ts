import { readFileSync } from "node:fs";
import { PrismaClient, type AuthSignInMethodSetting, type AuthSignInPolicy } from "@prisma/client";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { decodeBase32, totpCodeAt, totpStep } from "../../lib/server/auth/totp";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * LDAP sign-in on the shared login form.
 *
 * The admin card test runs everywhere: it only fills the card and saves nothing. The
 * directory test needs a real disposable directory and runs only with
 * AIQSA_AUTH_IDP_E2E=DISPOSABLE plus the AIQSA_E2E_LDAP_* stand variables below; it
 * configures LDAP through the admin card, signs a directory user in by username, refuses a
 * wrong password, turns TOTP on and proves the second step, then restores the LDAP row and
 * the switches it changed.
 *
 * - AIQSA_E2E_LDAP_URL: ldaps://… or ldap://… as the app reaches the directory
 * - AIQSA_E2E_LDAP_BASE: user search base
 * - AIQSA_E2E_LDAP_FILTER: user search filter with {{username}} (default `(uid={{username}})`)
 * - AIQSA_E2E_LDAP_PRESET: `openldap` (default) or `active_directory`
 * - AIQSA_E2E_LDAP_BIND_DN / AIQSA_E2E_LDAP_BIND_PASSWORD: service account (optional)
 * - AIQSA_E2E_LDAP_CA_FILE: PEM file of the directory's CA (optional)
 * - AIQSA_E2E_LDAP_USERNAME / AIQSA_E2E_LDAP_PASSWORD / AIQSA_E2E_LDAP_EMAIL: a test user
 */
test.describe.configure({ mode: "serial" });

const stand = {
  base: process.env.AIQSA_E2E_LDAP_BASE ?? "",
  bindDn: process.env.AIQSA_E2E_LDAP_BIND_DN ?? "",
  bindPassword: process.env.AIQSA_E2E_LDAP_BIND_PASSWORD ?? "",
  caFile: process.env.AIQSA_E2E_LDAP_CA_FILE ?? "",
  email: (process.env.AIQSA_E2E_LDAP_EMAIL ?? "").toLowerCase(),
  filter: process.env.AIQSA_E2E_LDAP_FILTER ?? "(uid={{username}})",
  password: process.env.AIQSA_E2E_LDAP_PASSWORD ?? "",
  preset: process.env.AIQSA_E2E_LDAP_PRESET === "active_directory" ? "Active Directory" : "OpenLDAP",
  url: process.env.AIQSA_E2E_LDAP_URL ?? "",
  username: process.env.AIQSA_E2E_LDAP_USERNAME ?? ""
};
const directoryEnabled = process.env.AIQSA_AUTH_IDP_E2E === "DISPOSABLE" &&
  Boolean(stand.url && stand.base && stand.username && stand.password && stand.email);
const POLICY_ID = "installation";

const prisma = new PrismaClient();
let ldapSnapshot: AuthSignInMethodSetting | null = null;
let policySnapshot: AuthSignInPolicy | null = null;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function openLdapCard(page: Page): Promise<Locator> {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=sign-in");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Sign-in");
  const card = page.getByTestId("admin-sign-in-section").getByTestId("admin-sign-in-card-ldap");
  await expect(card).toBeVisible();
  return card;
}

test("the LDAP card offers AD and OpenLDAP presets, warns about unverified TLS and fits every viewport", async ({ browser }, info) => {
  for (const [name, options] of [
    ["phone", { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } }],
    ["tablet", { hasTouch: true, viewport: { height: 1024, width: 768 } }],
    ["desktop", { viewport: { height: 900, width: 1440 } }]
  ] as const) {
    const context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce", ...options });
    const page = await context.newPage();
    const card = await openLdapCard(page);

    await card.getByRole("button", { name: "Active Directory" }).click();
    await expect(card.getByLabel("User search filter")).toHaveValue("(sAMAccountName={{username}})");
    await expect(card.getByLabel("Id attribute")).toHaveValue("objectGUID");
    await card.getByRole("button", { name: "OpenLDAP" }).click();
    await expect(card.getByLabel("User search filter")).toHaveValue("(uid={{username}})");
    await expect(card.getByLabel("Id attribute")).toHaveValue("entryUUID");
    await expect(card.getByText(/memberof overlay/u)).toBeVisible();
    await expect(card.getByLabel("Link accounts by directory email")).toBeChecked();
    await card.getByLabel("Verify the server certificate").uncheck();
    await expect(card.getByTestId("admin-sign-in-ldap-tls-warning")).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`ldap-card-${name}.png`) });
    await card.getByTestId("admin-sign-in-ldap-tls-warning").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`ldap-card-tls-warning-${name}.png`) });
    await context.close();
  }
});

function authenticator(secret: string) {
  const key = decodeBase32(secret.replace(/\s+/gu, ""));
  expect(key).not.toBeNull();
  let lastStep = -1;
  return async (): Promise<string> => {
    while (lastStep + 1 > totpStep(new Date()) + 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const step = Math.max(totpStep(new Date()), lastStep + 1);
    lastStep = step;
    return totpCodeAt(key!, step);
  };
}

async function directorySignIn(browser: Browser, password: string) {
  const context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/login");
  const form = page.locator('form[data-hydrated="true"]');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByLabel("Username or email").fill(stand.username);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  return { context, page };
}

test.describe("with a disposable directory", () => {
  test.skip(!directoryEnabled, "needs AIQSA_AUTH_IDP_E2E=DISPOSABLE and the AIQSA_E2E_LDAP_* stand variables");

  test.beforeAll(async () => {
    ldapSnapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "ldap" } });
    policySnapshot = await prisma.authSignInPolicy.findUnique({ where: { id: POLICY_ID } });
    await prisma.authSignInMethodSetting.deleteMany({ where: { method: "ldap" } });
  });

  test.afterAll(async () => {
    await prisma.authSignInMethodSetting.deleteMany({ where: { method: "ldap" } });
    if (ldapSnapshot) {
      await prisma.authSignInMethodSetting.create({
        data: {
          ...ldapSnapshot,
          activeConfig: ldapSnapshot.activeConfig ?? undefined,
          draftConfig: ldapSnapshot.draftConfig ?? undefined
        }
      });
    }
    await prisma.authSignInPolicy.deleteMany({ where: { id: POLICY_ID } });
    if (policySnapshot) await prisma.authSignInPolicy.create({ data: policySnapshot });
    // The directory user's AIQSA account exists only for this run.
    await prisma.user.deleteMany({ where: { authIdentities: { some: { normalizedEmail: stand.email, provider: "ldap" } } } });
  });

  test("a directory user signs in by username, a wrong password is refused, and TOTP adds the second step", async ({ browser, page }, info) => {
    test.setTimeout(240_000);
    const card = await openLdapCard(page);
    await card.getByRole("button", { name: stand.preset }).click();
    await card.getByLabel("Server URL").fill(stand.url);
    if (stand.caFile) await card.getByLabel("CA certificate (PEM)").fill(readFileSync(stand.caFile, "utf8"));
    if (stand.bindDn) {
      await card.getByLabel("Bind DN").fill(stand.bindDn);
      await card.getByLabel("Bind password").fill(stand.bindPassword);
    }
    await card.getByLabel("User search base").fill(stand.base);
    await card.getByLabel("User search filter").fill(stand.filter);
    await card.getByLabel("Sample sign-in name").fill(stand.username);
    await card.getByRole("button", { name: "Save" }).click();
    // Polled as a boolean: a failing value assertion would print the secret. The first save also
    // waits for the route to compile on a fresh dev server.
    await expect.poll(async () => (await card.getByLabel("Bind password").inputValue()) === "", { timeout: 60_000 }).toBe(true);
    await card.getByRole("button", { name: "Test" }).click();
    await expect(card.getByTestId("admin-sign-in-test")).toContainText("Test passed: Found the sample entry");
    await page.screenshot({ path: info.outputPath("ldap-card-test-passed.png") });
    await card.getByRole("button", { name: "Activate" }).click();
    await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Active (admin)");
    if (stand.bindPassword) {
      expect(await (await page.request.get("/api/admin/sign-in")).text()).not.toContain(stand.bindPassword);
    }

    // A wrong password and an unknown name answer the same.
    const wrong = await directorySignIn(browser, `${stand.password}-wrong`);
    await expect(wrong.page.getByRole("alert").filter({ hasText: "(unauthorized)" })).toBeVisible({ timeout: 30_000 });
    await wrong.page.screenshot({ path: info.outputPath("ldap-login-refused.png") });
    await wrong.context.close();

    const signedIn = await directorySignIn(browser, stand.password);
    await expect(signedIn.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await expect(prisma.authSession.findFirst({
      orderBy: { createdAt: "desc" },
      select: { signInMethod: true },
      where: { user: { authIdentities: { some: { normalizedEmail: stand.email, provider: "ldap" } } } }
    })).resolves.toEqual({ signInMethod: "ldap" });

    // TOTP from Account settings, then the next directory sign-in asks for a code.
    await runAccountMenuAction(signedIn.page, "Settings");
    const settings = signedIn.page.getByTestId("settings-v2");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    await settings.getByTestId("settings-two-factor").getByRole("button", { name: "Turn on…" }).click();
    const setup = settings.getByTestId("settings-two-factor-setup");
    const nextCode = authenticator(await setup.getByTestId("settings-two-factor-key").innerText());
    await setup.getByLabel("Code from the app").fill(await nextCode());
    await setup.getByRole("button", { name: "Turn on", exact: true }).click();
    await settings.getByTestId("settings-two-factor-codes").getByRole("button", { name: "I saved them" }).click();
    await signedIn.context.close();

    const second = await directorySignIn(browser, stand.password);
    await expect(second.page.getByRole("heading", { level: 1, name: "Two-factor verification" })).toBeVisible({ timeout: 30_000 });
    expect((await second.context.cookies()).some((cookie) => cookie.name === "aiqsa_session")).toBe(false);
    await second.page.screenshot({ path: info.outputPath("ldap-second-step.png") });
    await second.page.getByTestId("second-factor-form").getByLabel("Authentication code").fill(await nextCode());
    await second.page.getByTestId("second-factor-form").getByRole("button", { name: "Verify", exact: true }).click();
    await expect(second.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await second.context.close();
  });

  test("with password sign-in off the login form stays for the directory", async ({ browser }, info) => {
    await prisma.authSignInPolicy.upsert({
      create: { id: POLICY_ID, passwordLoginEnabled: false, registrationEnabled: true },
      update: { passwordLoginEnabled: false, version: { increment: 1 } },
      where: { id: POLICY_ID }
    });
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    // The settings snapshot is cached for a few seconds; the page reflects the switch soon after.
    await expect.poll(async () => {
      await page.goto("/login");
      return page.getByLabel("Username or email").count();
    }, { timeout: 15_000 }).toBe(1);
    await expect(page.getByTestId("password-sign-in-off")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset password" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("ldap-login-password-off.png") });
    await context.close();
  });
});
