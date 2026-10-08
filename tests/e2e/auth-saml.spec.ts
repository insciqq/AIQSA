import { randomUUID } from "node:crypto";
import { PrismaClient, type AuthSignInMethodSetting } from "@prisma/client";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import {
  createSamlTestIdp,
  encodeSamlTestResponse,
  samlAuthnRequestFromLocation,
  samlTestAssertion,
  samlTestResponse,
  signSamlTestAssertion
} from "../support/samlIdp";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// The SAML method row is an installation singleton: the spec snapshots it, configures a
// synthetic IdP (a key generated here, never a real IdP) on this disposable stand and puts the
// snapshot back. The IdP's sign-in URL is never contacted: the spec plays the IdP itself.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const idp = createSamlTestIdp({ entityId: `https://idp-${run}.example.test/realms/e2e` });
const SSO_URL = `https://idp-${run}.example.test/realms/e2e/protocol/saml`;
const domain = `saml-e2e-${run}.example.com`;
let samlSnapshot: AuthSignInMethodSetting | null = null;
let serviceProvider: { acsUrl: string; entityId: string } | null = null;

test.beforeAll(async () => {
  samlSnapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "saml" } });
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "saml" } });
});

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } } });
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "saml" } });
  if (samlSnapshot) {
    await prisma.authSignInMethodSetting.create({
      data: {
        ...samlSnapshot,
        activeConfig: samlSnapshot.activeConfig ?? undefined,
        draftConfig: samlSnapshot.draftConfig ?? undefined
      }
    });
  }
  await prisma.$disconnect();
});

async function openSamlCard(page: Page) {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=sign-in");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Sign-in");
  const card = page.getByTestId("admin-sign-in-section").getByTestId("admin-sign-in-card-saml");
  await expect(card).toBeVisible();
  return card;
}

/**
 * The IdP's answer to the AuthnRequest a start redirect carries. The start goes through the
 * context's request API, which shares its cookie jar: that context holds the binding cookie.
 */
async function idpResponse(request: APIRequestContext, input: { email: string; inResponseTo?: "omit"; next?: string }) {
  const sp = serviceProvider!;
  const start = await request.get(`/api/auth/saml/start?next=${encodeURIComponent(input.next ?? "/")}`, { maxRedirects: 0 });
  expect(start.status()).toBe(303);
  const location = new URL(start.headers().location!);
  expect(`${location.origin}${location.pathname}`).toBe(SSO_URL);
  const requestId = samlAuthnRequestFromLocation(location).id;
  const answered = input.inResponseTo === "omit" ? null : requestId;
  const assertion = signSamlTestAssertion(samlTestAssertion({
    acsUrl: sp.acsUrl,
    attributes: { displayName: `SAML person ${run}`, email: input.email, groups: ["staff"] },
    audience: sp.entityId,
    inResponseTo: answered,
    issuer: idp.entityId,
    nameId: `subject-${run}`
  }), { idp });
  return {
    RelayState: location.searchParams.get("RelayState")!,
    SAMLResponse: encodeSamlTestResponse(samlTestResponse({
      assertions: [assertion],
      destination: sp.acsUrl,
      inResponseTo: answered,
      issuer: idp.entityId
    }))
  };
}

/** Posts the response as an IdP page does: a cross-site, auto-submitted HTML form. */
async function postFromIdp(page: Page, fields: Record<string, string>) {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${value.replace(/[&"<>]/gu, "")}">`)
    .join("");
  await page.setContent(`<form method="post" action="${serviceProvider!.acsUrl}">${inputs}</form>`);
  await Promise.all([page.waitForURL((url) => url.href !== "about:blank"), page.locator("form").evaluate((form: HTMLFormElement) => form.submit())]);
}

async function hasSession(context: BrowserContext): Promise<boolean> {
  return (await context.cookies()).some((cookie) => cookie.name === "aiqsa_session");
}

test("an administrator configures SAML; only the browser that started a sign-in completes it, replays and unsolicited responses fail", async ({ browser, page }, testInfo) => {
  const card = await openSamlCard(page);
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Off");
  serviceProvider = {
    acsUrl: await card.getByLabel("ACS URL (Reply URL)").inputValue(),
    entityId: await card.getByLabel("SP entity ID (Audience)").inputValue()
  };
  expect(serviceProvider.acsUrl).toMatch(/\/saml\/acs$/u);
  const metadata = await page.request.get("/saml/metadata");
  expect(await metadata.text()).toContain(`Location="${serviceProvider.acsUrl}"`);

  await card.getByLabel("IdP entity ID").fill(idp.entityId);
  await card.getByLabel("IdP sign-in URL (HTTP-Redirect)").fill(SSO_URL);
  await card.getByLabel("IdP signing certificates").fill(idp.certificate);
  await card.getByLabel("Groups attribute (optional)").fill("groups");
  await card.getByLabel("Display name attribute (optional)").fill("displayName");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("The saved settings are not active yet.")).toBeVisible();
  await card.getByRole("button", { name: "Test" }).click();
  await expect(card.getByTestId("admin-sign-in-test")).toContainText("Test passed: Certificates and settings checked.");
  await card.getByRole("button", { name: "Activate" }).click();
  // SAML identities an earlier run left on this stand belong to another entity id.
  const status = card.getByTestId("admin-sign-in-status");
  const sourceChange = page.getByTestId("admin-confirm-sign-in-source-change");
  await expect(status.filter({ hasText: "Active (admin)" }).or(sourceChange)).toBeVisible();
  if (await sourceChange.isVisible()) await sourceChange.getByRole("button", { name: "Activate anyway" }).click();
  await expect(status).toHaveText("Active (admin)");
  await card.screenshot({ path: testInfo.outputPath("saml-card-active.png") });

  const anonymous = await browser.newContext();
  const login = await anonymous.newPage();
  await login.goto("/login");
  await expect(login.getByRole("link", { name: "Continue with SAML" })).toHaveAttribute("href", "/api/auth/saml/start?next=%2F");
  await login.screenshot({ path: testInfo.outputPath("saml-login-button.png") });

  // The ACS hands the browser to the completion step, which the start's Lax binding cookie reaches.
  const email = `person@${domain}`;
  const fields = await idpResponse(login.request, { email });
  await postFromIdp(login, fields);
  await expect(login.getByTestId("app-shell")).toBeVisible();
  const identity = await prisma.authIdentity.findFirstOrThrow({ where: { normalizedEmail: email, provider: "saml" } });
  expect(identity.source).toBe(idp.entityId);
  const samlSessions = () => prisma.authSession.count({ where: { signInMethod: "saml", userId: identity.userId } });
  await expect(samlSessions()).resolves.toBe(1);

  // Login CSRF: a valid response planted into a browser that did not start the sign-in.
  const attackerContext = await browser.newContext();
  const attacker = await attackerContext.newPage();
  const victimContext = await browser.newContext();
  const victim = await victimContext.newPage();
  await postFromIdp(victim, await idpResponse(attacker.request, { email }));
  await expect(victim).toHaveURL(/\/login\?saml=browser_mismatch&local=1$/u);
  await expect(victim.getByRole("alert")).toContainText("did not finish in the browser that started it");
  expect(await hasSession(victimContext)).toBe(false);
  await expect(samlSessions()).resolves.toBe(1);
  await victim.screenshot({ path: testInfo.outputPath("saml-login-browser-mismatch.png") });
  // Only the browser holding the start's cookie turns that response into a session.
  await attacker.goto("/api/auth/saml/complete");
  await expect(attacker.getByTestId("app-shell")).toBeVisible();
  await expect(samlSessions()).resolves.toBe(2);

  const replayContext = await browser.newContext();
  const replay = await replayContext.newPage();
  await postFromIdp(replay, fields);
  await expect(replay).toHaveURL(/\/login\?saml=failed&local=1$/u);
  await expect(replay.getByRole("alert")).toContainText("SAML sign-in could not be completed. Try again or contact the operator. (saml_failed)");
  await replay.screenshot({ path: testInfo.outputPath("saml-login-failed.png") });

  await postFromIdp(replay, await idpResponse(replay.request, { email, inResponseTo: "omit" }));
  await expect(replay).toHaveURL(/\/login\?saml=failed&local=1$/u);
  expect(await hasSession(replayContext)).toBe(false);
  await expect(samlSessions()).resolves.toBe(2);

  await page.reload();
  await expect(page.getByTestId("admin-sign-in-card-saml").getByTestId("admin-sign-in-health"))
    .toContainText("the response did not answer a sign-in AIQSA started");
  for (const context of [anonymous, attackerContext, victimContext, replayContext]) await context.close();
});

for (const viewport of [
  { height: 1180, name: "tablet portrait", width: 820 },
  { height: 820, name: "tablet landscape", width: 1180 },
  { height: 844, name: "phone portrait", width: 390 },
  { height: 390, name: "phone landscape", width: 844 }
] as const) {
  test(`the SAML card and button fit the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    const card = await openSamlCard(page);
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByLabel("IdP signing certificates")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`saml-card-${viewport.width}x${viewport.height}.png`) });

    const login = await page.context().browser()!.newContext({ viewport: { height: viewport.height, width: viewport.width } });
    const loginPage = await login.newPage();
    await loginPage.goto("/login");
    await expect(loginPage.getByRole("link", { name: "Continue with SAML" })).toBeVisible();
    await expectNoHorizontalOverflow(loginPage);
    await loginPage.screenshot({ path: testInfo.outputPath(`saml-login-${viewport.width}x${viewport.height}.png`) });
    await login.close();
  });
}
