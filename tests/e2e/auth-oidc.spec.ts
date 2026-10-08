import { randomUUID } from "node:crypto";
import { PrismaClient, type AuthSignInMethodSetting } from "@prisma/client";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { oidcSignInConfigSchema, type AuthSignInMethodConfig } from "../../lib/contracts/authSignInMethods";
import { encryptSignInSecrets } from "../../lib/server/auth/signInSettings/secrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// The OIDC method is an installation singleton: the spec snapshots its row, activates a
// configuration whose issuer never resolves (`.invalid`), and puts the snapshot back. The real
// provider round trip is covered by the fake-IdP unit tests and the real-IdP wave checks.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const LABEL = `Company SSO ${run}`;
const CLIENT_SECRET = `oidc-e2e-${run}-write-only`;

let snapshot: AuthSignInMethodSetting | null = null;

async function activate(overrides: Partial<AuthSignInMethodConfig<"oidc">> = {}) {
  const config = oidcSignInConfigSchema.parse({
    buttonLabel: LABEL,
    clientId: `aiqsa-e2e-${run}`,
    issuer: `https://oidc-${run}.invalid/realms/main`,
    ...overrides
  });
  const current = await prisma.authSignInMethodSetting.findUnique({ where: { method: "oidc" } });
  const version = (current?.activeVersion ?? 0) + 1;
  const generation = (current?.secretGenerationCounter ?? 0) + 1;
  const envelope = encryptSignInSecrets({ generation, key: getSecretEncryptionKey(), method: "oidc", secrets: { clientSecret: CLIENT_SECRET } });
  const data = {
    activatedAt: new Date(),
    activeConfig: config,
    activeSecretEnvelope: envelope,
    activeSecretGeneration: generation,
    activeVersion: version,
    draftConfig: config,
    draftSecretEnvelope: envelope,
    draftSecretGeneration: generation,
    draftVersion: version,
    enabled: true,
    // A new active version starts without the previous version's health, as activation does.
    healthActiveVersion: null,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    secretGenerationCounter: generation
  };
  await prisma.authSignInMethodSetting.upsert({ create: { method: "oidc", ...data }, update: data, where: { method: "oidc" } });
}

/** A signed-out page; the login page reads methods through a snapshot of about 5 s. */
async function anonymousPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test.beforeAll(async () => {
  snapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "oidc" } });
});

test.afterAll(async () => {
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "oidc" } });
  if (snapshot) {
    await prisma.authSignInMethodSetting.create({
      data: {
        ...snapshot,
        activeConfig: snapshot.activeConfig ?? undefined,
        draftConfig: snapshot.draftConfig ?? undefined
      }
    });
  }
  await prisma.$disconnect();
});

test("the login page offers the OIDC button and explains an unreachable provider", async ({ browser }) => {
  await activate();
  const page = await anonymousPage(browser);
  const button = page.getByRole("link", { name: `Continue with ${LABEL}` });
  await expect(async () => {
    await page.goto("/login?next=%2Fprojects");
    await expect(button).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(button).toHaveAttribute("href", "/api/auth/oauth/oidc?next=%2Fprojects");
  await expectNoHorizontalOverflow(page);

  await button.click();
  await expect(page).toHaveURL(/\/login\?oauth=failed&provider=oidc&next=%2Fprojects$/u);
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText(`${LABEL} sign-in could not be completed. Try again or use email and password. (oauth_failed)`);
  await page.context().close();
});

test("the login page explains the source_changed and email_missing outcomes", async ({ browser }) => {
  await activate();
  const page = await anonymousPage(browser);
  await expect(async () => {
    await page.goto("/login?oauth=source_changed&provider=oidc");
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText(LABEL, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("linked through a previous sign-in configuration. Ask an administrator to unlink it");
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("(oauth_source_changed)");

  await page.goto("/login?oauth=email_missing&provider=oidc");
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText(`${LABEL} did not share an email address for this account.`);
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("(oauth_email_missing)");
  await page.context().close();
});

test("auto-redirect sends /login to the provider, with ?local=1 and outcomes as the way back", async ({ browser }) => {
  await activate({ autoRedirect: true });
  const page = await anonymousPage(browser);

  // /login → the OIDC start → the provider is unreachable → the outcome stops the redirect.
  await expect(async () => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login\?oauth=failed&provider=oidc/u, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("(oauth_failed)");

  const redirect = await page.request.get("/login?next=%2Fprojects", { maxRedirects: 0 });
  expect([303, 307, 308]).toContain(redirect.status());
  expect(redirect.headers().location).toMatch(/\/api\/auth\/oauth\/oidc\?next=%2Fprojects$/u);

  await page.goto("/login?local=1");
  await expect(page).toHaveURL(/\/login\?local=1$/u);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `Continue with ${LABEL}` })).toBeVisible();

  await page.goto("/login?reason=session_expired");
  await expect(page).toHaveURL(/\/login\?reason=session_expired$/u);
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("(session_expired)");
  await page.context().close();
});

test("the admin card shows the URIs and provider notes, never the secret", async ({ page }) => {
  await activate();
  await signInWithLocalToken(page);
  await page.goto("/admin?section=sign-in");
  const card = page.getByTestId("admin-sign-in-card-oidc");
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Active (admin)");
  await expect(card.getByLabel("Redirect URI")).toHaveValue(/\/api\/auth\/oauth\/oidc\/callback$/u);
  await expect(card.getByLabel("Post-logout redirect URI")).toHaveValue(/\/login$/u);
  await expect(card.getByLabel("Issuer")).toHaveValue(`https://oidc-${run}.invalid/realms/main`);
  await card.getByText("Provider notes").click();
  await expect(card).toContainText("Group Membership mapper");
  await expect(card).toContainText("never common or organizations");
  expect(await page.content()).not.toContain(CLIENT_SECRET);
  expect(await (await page.request.get("/api/admin/sign-in")).text()).not.toContain(CLIENT_SECRET);
  await expectNoHorizontalOverflow(page);
});
