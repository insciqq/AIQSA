import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import {
  adminSession,
  alert,
  attachEvidence,
  createGroup,
  addExternalName,
  disableMethod,
  hasSessionCookie,
  openSignInCard,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  saveTestActivate,
  snapshotMethod,
  standContext,
  standEnv,
  standMode
} from "./support/realIdp";

// No IdP passwords here; a failure screenshot shows the page state.
test.use({ screenshot: "only-on-failure" });

/**
 * Real-IdP scenario 6: the trusted header behind the stand's injecting proxy (auth-wave-e2e-docs
 * Scope §2.6). The proxy (nginx, tests/auth-idp/header-proxy.conf) overwrites the identity
 * headers on every request with the identity of its stand-in login, the `aiqsa_stand_user` and
 * `aiqsa_stand_groups` cookies, and drops whatever the client sent.
 *
 * The stand runs twice. `AIQSA_E2E_STAND_MODE=trusted` (AIQSA_TRUST_PROXY_HEADERS=true,
 * AIQSA_TRUSTED_PROXY_COUNT=1): sign-in through the proxy is automatic, groups come from the
 * header, a forged header is overwritten, another identity replaces the session and signing out
 * lands on `/login?local=1`. `direct`: the method cannot be activated and the same proxied
 * request signs nobody in.
 *
 * The stand's AIQSA_APP_BASE_URL is the app's own address, so AIQSA's redirects after sign-in
 * leave the proxy; the contexts therefore also carry the forwarded address trusted mode needs
 * (in a real installation the base URL is the proxy's).
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const run = randomSuffix();
const DOMAIN = "proxy.aiqsa.test";
const STAFF = `staff-${run}`;
const ADMINS = `admins-${run}`;
const TARA = `tara-${run}`;
const UMA = `uma-${run}`;
const MALLORY = `mallory-${run}`;
let restoreMethod: (() => Promise<void>) | null = null;
let groupId = "";

const proxyUrl = () => standEnv("AIQSA_E2E_HEADER_PROXY_URL").replace(/\/+$/u, "");
const emailOf = (user: string) => `${user}@${DOMAIN}`;

/** A browser "signed in at the proxy" as `user` with `groups`, through the stand-in cookies. */
async function proxyBrowser(browser: Browser, user: string | null, groups: string | null, extraHTTPHeaders: Record<string, string> = {}) {
  const context = await standContext(browser, { extraHTTPHeaders });
  const host = new URL(proxyUrl()).hostname;
  await context.addCookies([
    ...(user ? [{ domain: host, name: "aiqsa_stand_user", path: "/", value: user }] : []),
    ...(groups ? [{ domain: host, name: "aiqsa_stand_groups", path: "/", value: groups }] : [])
  ]);
  return { context, page: await context.newPage() };
}

async function setStandIdentity(context: import("@playwright/test").BrowserContext, user: string, groups: string) {
  const host = new URL(proxyUrl()).hostname;
  await context.addCookies([
    { domain: host, name: "aiqsa_stand_user", path: "/", value: user },
    { domain: host, name: "aiqsa_stand_groups", path: "/", value: groups }
  ]);
}

test.beforeAll(async () => {
  restoreMethod = (await snapshotMethod(prisma, "trusted_header")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "trusted_header" } });
});

test.afterAll(async ({ browser }) => {
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "trusted_header").catch(() => undefined);
    await admin.context.close();
  } finally {
    await restoreMethod?.();
    const emails = [TARA, UMA, MALLORY].map(emailOf);
    const users = await prisma.user.findMany({
      select: { id: true },
      where: { OR: [{ email: { in: emails } }, { authIdentities: { some: { normalizedEmail: { in: emails } } } }] }
    });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    if (groupId) await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});

test("the administrator configures the oauth2-proxy headers; the card shows the stand's client identity mode", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "trusted_header");
  await expect(card.getByTestId("trusted-header-mode")).toHaveAttribute("data-mode", standMode === "trusted" ? "trusted_proxy" : /^(?!trusted_proxy).+/u);
  await card.getByRole("button", { name: "oauth2-proxy" }).click();
  await card.getByLabel("Name header").fill("X-Auth-Request-User");
  await card.getByLabel("Administrator groups").fill(ADMINS);
  await card.getByLabel("Sync groups with external names").check();
  groupId = await createGroup(context.request, `Proxy staff ${run}`);
  await addExternalName(context.request, groupId, "trusted_header", STAFF);

  if (standMode !== "trusted") {
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText("The saved settings are not active yet.")).toBeVisible({ timeout: 60_000 });
    await card.getByRole("button", { name: "Test", exact: true }).click();
    await expect(card.getByTestId("admin-sign-in-test")).toContainText("Test failed");
    await expect(card.getByRole("button", { name: "Activate" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("trusted-header-card-direct-desktop.png") });
    await context.close();
    await attachEvidence(testInfo, "trusted-header-card", { activatable: false, mode: "direct" });
    return;
  }

  await saveTestActivate(page, card);
  await page.screenshot({ path: testInfo.outputPath("trusted-header-card-active-desktop.png") });
  await context.close();

  // The card's probe, read through the proxy with the stand-in identity, sees the injected header.
  const probe = await adminSession(browser);
  await setStandIdentity(probe.context, TARA, STAFF);
  await probe.page.goto(`${proxyUrl()}/admin?section=sign-in`);
  const proxied = probe.page.getByTestId("admin-sign-in-card-trusted_header");
  await proxied.getByRole("button", { name: "Check this request" }).click();
  await expect(proxied.getByTestId("trusted-header-probe")).toContainText(`@${DOMAIN}`);
  await probe.page.screenshot({ path: testInfo.outputPath("trusted-header-probe-through-proxy-desktop.png") });
  await probe.context.close();
  await attachEvidence(testInfo, "trusted-header-card", { activatable: true, mode: "trusted_proxy", probeSeesHeader: true });
});

test("behind the proxy the browser signs in automatically with header groups; a forged header is overwritten", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  if (standMode !== "trusted") {
    // Without trusted-proxy mode the proxied identity signs nobody in.
    const { context, page } = await proxyBrowser(browser, TARA, STAFF);
    const response = await page.request.get(`${proxyUrl()}/api/auth/trusted-header?next=%2F`, { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(new URL(response.headers().location!).searchParams.get("trusted_header")).toBe("unavailable");
    await page.goto(`${proxyUrl()}/login`);
    await expect(page.getByTestId("trusted-header-sign-in")).toHaveCount(0);
    const session = await hasSessionCookie(context);
    const accounts = await prisma.user.count({ where: { authIdentities: { some: { normalizedEmail: emailOf(TARA) } } } });
    expect(session).toBe(false);
    expect(accounts).toBe(0);
    await context.close();
    await attachEvidence(testInfo, "trusted-header-direct", { accounts, outcome: "unavailable", session });
    return;
  }

  // The client sends its own identity header too; the proxy replaces it with the stand-in identity.
  const { context, page } = await proxyBrowser(browser, TARA, STAFF, { "X-Auth-Request-Email": emailOf(MALLORY) });
  await page.goto(`${proxyUrl()}/login?next=%2F`);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const tara = await prisma.user.findFirstOrThrow({
    where: { authIdentities: { some: { normalizedEmail: emailOf(TARA), provider: "trusted_header" } } }
  });
  const taraSessions = await prisma.authSession.count({ where: { revokedAt: null, signInMethod: "trusted_header", userId: tara.id } });
  const taraMember = (await prisma.userGroup.count({ where: { groupId, userId: tara.id } })) === 1;
  const malloryAccounts = await prisma.user.count({ where: { authIdentities: { some: { normalizedEmail: emailOf(MALLORY) } } } });
  expect(taraSessions).toBe(1);
  expect(taraMember).toBe(true);
  expect(malloryAccounts).toBe(0);
  expect(tara.role).toBe("user");
  await page.screenshot({ path: testInfo.outputPath("trusted-header-signed-in-desktop.png") });

  // Another identity at the proxy replaces the session; its groups make it an administrator.
  // An open app page would see its requests refused for the old session and sign in again on its
  // own, racing the explicit navigation below; leave it first.
  await page.goto("about:blank");
  await setStandIdentity(context, UMA, `${STAFF},${ADMINS}`);
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": "203.0.113.20" });
  await page.goto(`${proxyUrl()}/api/auth/trusted-header?next=%2F`);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const replaced = await prisma.authSession.findFirst({ select: { revokedReason: true }, where: { userId: tara.id } });
  expect(replaced?.revokedReason).toBe("trusted_header_replaced");
  const uma = await prisma.user.findFirstOrThrow({
    where: { authIdentities: { some: { normalizedEmail: emailOf(UMA), provider: "trusted_header" } } }
  });
  expect(uma.role).toBe("admin");

  // Signing out keeps the login page on screen instead of signing straight back in.
  // A click before hydration opens nothing: retry until the menu shows.
  const accountMenu = page.getByRole("menu", { name: "Account", exact: true });
  await expect(async () => {
    await page.getByRole("button", { name: "Account menu" }).first().click();
    await expect(accountMenu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await accountMenu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?local=1$/u, { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Continue with your proxy sign-in" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("trusted-header-signed-out-desktop.png") });
  const umaSessions = await prisma.authSession.count({ where: { revokedAt: null, userId: uma.id } });
  expect(umaSessions).toBe(0);
  await context.close();

  // Without the stand-in login the proxy sends no identity: the login page says so.
  const anonymous = await proxyBrowser(browser, null, null);
  await anonymous.page.goto(`${proxyUrl()}/login`);
  await expect(anonymous.page).toHaveURL(/trusted_header=missing/u, { timeout: 30_000 });
  await expect(alert(anonymous.page)).toContainText("did not provide an identity");
  await anonymous.context.close();
  await attachEvidence(testInfo, "trusted-header-proxy", {
    forgedHeaderAccounts: malloryAccounts,
    replacedReason: "trusted_header_replaced",
    sessionsAfterSignOut: umaSessions,
    taraMember,
    taraSessions,
    umaAdmin: uma.role === "admin"
  });
});
