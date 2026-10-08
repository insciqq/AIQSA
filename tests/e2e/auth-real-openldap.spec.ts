import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { decodeBase32, totpCodeAt, totpStep } from "../../lib/server/auth/totp";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import {
  addExternalNameInUi,
  adminSession,
  attachEvidence,
  createGroup,
  deleteStandUsers,
  disableMethod,
  hasSessionCookie,
  loginPage,
  openSignInCard,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  saveTestActivate,
  snapshotMethod,
  standContext,
  standEnv
} from "./support/realIdp";

/**
 * Real-IdP scenario 3: OpenLDAP (memberof overlay) with TOTP (auth-wave-e2e-docs Scope §2.3).
 *
 * Sign-in by username and by email with one filter, groups from `memberOf`, an administrator
 * group, a user without an email, TOTP on an LDAP account (second step, a recovery code once, an
 * administrator reset), and the refusals that must never reach the directory as a bind: a blank
 * password and filter injection. `auth-ldap.spec.ts` keeps its own single-user directory check.
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the stand passwords typed into the login form.
test.use({ trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const GROUP_NAME = `Researchers ${run}`;
const USERS = {
  lena: { email: "lena@ldap.aiqsa.test", passwordEnv: "AIQSA_E2E_PW_LENA", username: "lena" },
  nomail: { email: null, passwordEnv: "AIQSA_E2E_PW_NOMAIL", username: "nomail" },
  oleg: { email: "oleg@ldap.aiqsa.test", passwordEnv: "AIQSA_E2E_PW_OLEG", username: "oleg" }
} as const;
const emails = [USERS.lena.email, USERS.oleg.email];
let restoreLdap: (() => Promise<void>) | null = null;
let groupId = "";

test.beforeAll(async () => {
  restoreLdap = (await snapshotMethod(prisma, "ldap")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "ldap" } });
  await deleteStandUsers(prisma, emails);
});

test.afterAll(async ({ browser }) => {
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "ldap").catch(() => undefined);
    await admin.context.close();
  } finally {
    await restoreLdap?.();
    await deleteStandUsers(prisma, emails);
    if (groupId) await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});

async function ldapIdentityUser(email: string) {
  return prisma.user.findFirst({ where: { authIdentities: { some: { normalizedEmail: email, provider: "ldap" } } } });
}

/** The login form of a fresh context with a directory name and password. */
async function directorySignIn(browser: Browser, identifier: string, password: string, options: BrowserContextOptions = {}) {
  const { context, page } = await loginPage(browser, "/login", options);
  const form = page.locator('form[data-hydrated="true"]');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByLabel("Username or email").fill(identifier);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  return { context, page };
}

function authenticator(secret: string) {
  const key = decodeBase32(secret.replace(/\s+/gu, ""));
  expect(key).not.toBeNull();
  let lastStep = -1;
  return async (): Promise<string> => {
    while (lastStep + 1 > totpStep(new Date()) + 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const step = Math.max(totpStep(new Date()), lastStep + 1);
    lastStep = step;
    return totpCodeAt(key!, step);
  };
}

async function secondStep(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "Two-factor verification" })).toBeVisible({ timeout: 30_000 });
  return page.getByTestId("second-factor-form");
}

test("an administrator connects OpenLDAP through the card; Test finds the sample entry with its group", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "ldap");
  await card.getByRole("button", { name: "OpenLDAP" }).click();
  await card.getByLabel("Server URL").fill(standEnv("AIQSA_E2E_LDAP_URL"));
  await card.getByLabel("Bind DN").fill(standEnv("AIQSA_E2E_LDAP_BIND_DN"));
  await card.getByLabel("Bind password").fill(standEnv("AIQSA_E2E_LDAP_BIND_PASSWORD"));
  await card.getByLabel("User search base").fill("ou=people,dc=aiqsa,dc=test");
  // One filter for both: a username or the directory email.
  await card.getByLabel("User search filter").fill("(|(uid={{username}})(mail={{username}}))");
  await card.getByLabel("Administrator groups").fill("ldap-admins");
  await card.getByLabel("Sync group memberships from the directory").check();
  await card.getByLabel("Sample sign-in name").fill("lena");
  await saveTestActivate(page, card, { secretField: "Bind password", testPassed: "Test passed: Found the sample entry without TLS. Id and email attributes present. 1 group value." });
  await page.screenshot({ path: testInfo.outputPath("openldap-card-active-desktop.png") });
  const bindPasswordInOverview = (await (await page.request.get("/api/admin/sign-in")).text()).includes(standEnv("AIQSA_E2E_LDAP_BIND_PASSWORD"));
  expect(bindPasswordInOverview).toBe(false);

  groupId = await createGroup(context.request, GROUP_NAME);
  await addExternalNameInUi(page, groupId, "LDAP", "researchers");
  await context.close();

  for (const [name, viewport] of [["desktop", { height: 900, width: 1440 }], ["phone-landscape", { height: 390, width: 844 }]] as const) {
    const login = await loginPage(browser, "/login", { hasTouch: name !== "desktop", viewport });
    await expect(login.page.getByLabel("Username or email")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(login.page);
    await login.page.screenshot({ path: testInfo.outputPath(`openldap-login-${name}.png`) });
    await login.context.close();
  }
  await attachEvidence(testInfo, "openldap-configured", { bindPasswordInOverview, groupValues: 1, transport: "plain" });
});

test("directory users sign in by username and by email, get memberOf groups and the administrator role", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const byUsername = await directorySignIn(browser, "lena", standEnv(USERS.lena.passwordEnv));
  await expect(byUsername.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await byUsername.context.close();
  const lena = (await ldapIdentityUser(USERS.lena.email))!;
  const lenaMember = (await prisma.userGroup.count({ where: { groupId, userId: lena.id } })) === 1;
  expect(lenaMember).toBe(true);
  expect(lena.role).toBe("user");

  const byEmail = await directorySignIn(browser, USERS.oleg.email, standEnv(USERS.oleg.passwordEnv));
  await expect(byEmail.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await byEmail.context.close();
  const oleg = (await ldapIdentityUser(USERS.oleg.email))!;
  expect({ role: oleg.role, roleManagedBy: oleg.roleManagedBy?.startsWith("ldap:") }).toEqual({ role: "admin", roleManagedBy: true });
  const olegMember = (await prisma.userGroup.count({ where: { groupId, userId: oleg.id } })) === 1;
  expect(olegMember).toBe(true);
  const sessions = await prisma.authSession.count({ where: { signInMethod: "ldap", userId: { in: [lena.id, oleg.id] } } });
  expect(sessions).toBe(2);

  // An entry without an email signs nobody in.
  const nomail = await directorySignIn(browser, "nomail", standEnv(USERS.nomail.passwordEnv));
  await expect(nomail.page.locator("[role=alert]:not(#__next-route-announcer__)")).toBeVisible({ timeout: 30_000 });
  const nomailSession = await hasSessionCookie(nomail.context);
  expect(nomailSession).toBe(false);
  await nomail.context.close();
  await attachEvidence(testInfo, "openldap-sign-in", { lenaMember, nomailSession, olegAdmin: true, olegMember, sessions });
});

test("a blank password and filter injection are refused without signing anyone in", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await standContext(browser);
  const password = standEnv(USERS.lena.passwordEnv);
  // Few attempts: failures count against the source's password-login budget (10 per 15 minutes)
  // that later specs of the same run share.
  const attempts = [
    { expected: [400, "credentials_required"], password: "   ", username: "lena" },
    { expected: [401, "unauthorized"], password, username: "*" },
    { expected: [401, "unauthorized"], password, username: "*)(|(uid=*" },
    { expected: [401, "unauthorized"], password: `${password}-wrong`, username: "lena" }
  ] as const;
  const codes: string[] = [];
  for (const attempt of attempts) {
    const response = await context.request.post("/api/auth/login", { data: { email: attempt.username, password: attempt.password } });
    const body = await response.json() as { error?: string };
    expect([response.status(), body.error]).toEqual([...attempt.expected]);
    expect(response.headers()["set-cookie"] ?? "").not.toContain("aiqsa_session=");
    codes.push(`${response.status()}:${body.error}`);
  }
  await context.close();
  await attachEvidence(testInfo, "openldap-refusals", { attempts: attempts.length, codes: codes.join(",") });
});

test("TOTP on a directory account: the next sign-in asks for a code, a recovery code works once, an administrator reset clears it", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const password = standEnv(USERS.lena.passwordEnv);
  const first = await directorySignIn(browser, "lena", password);
  await expect(first.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await runAccountMenuAction(first.page, "Settings");
  const settings = first.page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "Account", exact: true }).click();
  await settings.getByTestId("settings-two-factor").getByRole("button", { name: "Turn on…" }).click();
  const setup = settings.getByTestId("settings-two-factor-setup");
  const nextCode = authenticator(await setup.getByTestId("settings-two-factor-key").innerText());
  await setup.getByLabel("Code from the app").fill(await nextCode());
  await setup.getByRole("button", { name: "Turn on", exact: true }).click();
  const shown = settings.getByTestId("settings-two-factor-codes");
  await expect(shown.getByRole("listitem")).toHaveCount(10);
  const recoveryCodes = await shown.getByRole("listitem").allInnerTexts();
  await shown.getByRole("button", { name: "I saved them" }).click();
  await expect(settings.getByTestId("settings-two-factor")).toContainText("On.");
  await first.page.screenshot({ path: testInfo.outputPath("openldap-account-two-factor-on-desktop.png") });
  await first.context.close();

  // The directory password alone no longer signs in; on a phone the second step fits.
  const second = await directorySignIn(browser, "lena", password, { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });
  const form = await secondStep(second.page);
  const sessionBeforeCode = await hasSessionCookie(second.context);
  expect(sessionBeforeCode).toBe(false);
  await expectNoHorizontalOverflow(second.page);
  await second.page.screenshot({ path: testInfo.outputPath("openldap-second-step-phone-portrait.png") });
  await form.getByLabel("Authentication code").fill(await nextCode());
  await form.getByRole("button", { name: "Verify", exact: true }).tap();
  await expect(second.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await second.context.close();

  const recovery = await directorySignIn(browser, "lena", password);
  await secondStep(recovery.page);
  await recovery.page.getByRole("button", { name: "Use a recovery code" }).click();
  await recovery.page.getByTestId("second-factor-form").getByLabel("Recovery code").fill(recoveryCodes[0]!);
  await recovery.page.getByTestId("second-factor-form").getByRole("button", { name: "Verify", exact: true }).click();
  await expect(recovery.page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await recovery.context.close();

  const spent = await directorySignIn(browser, "lena", password);
  await secondStep(spent.page);
  await spent.page.getByRole("button", { name: "Use a recovery code" }).click();
  await spent.page.getByTestId("second-factor-form").getByLabel("Recovery code").fill(recoveryCodes[0]!);
  await spent.page.getByTestId("second-factor-form").getByRole("button", { name: "Verify", exact: true }).click();
  await expect(spent.page.getByRole("alert").filter({ hasText: "That recovery code is not valid or was already used." })).toBeVisible();
  const spentSession = await hasSessionCookie(spent.context);
  expect(spentSession).toBe(false);
  await spent.context.close();

  const lena = (await ldapIdentityUser(USERS.lena.email))!;
  const admin = await adminSession(browser);
  await admin.page.goto(`/admin?section=users&resource=${encodeURIComponent(lena.id)}`);
  const userPage = admin.page.getByTestId("admin-user-page");
  await expect(userPage.getByTestId("admin-user-identity")).toHaveAttribute("data-provider", "ldap");
  await userPage.getByTestId("admin-user-reset-two-factor").click();
  const dialog = admin.page.getByTestId("admin-confirm-reset-user-two-factor");
  await dialog.getByRole("button", { name: /reset two-factor/iu }).click();
  await expect(userPage.getByTestId("admin-user-reset-two-factor")).toHaveCount(0);
  await admin.page.screenshot({ path: testInfo.outputPath("openldap-user-after-reset-desktop.png") });
  await admin.context.close();
  const factors = await prisma.authTotpFactor.count({ where: { userId: lena.id } });
  expect(factors).toBe(0);

  const afterReset = await directorySignIn(browser, "lena", password);
  await expect(afterReset.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await afterReset.context.close();
  await attachEvidence(testInfo, "openldap-totp", {
    factorsAfterReset: factors,
    recoveryCodesShown: recoveryCodes.length,
    secondStepWithoutSession: !sessionBeforeCode,
    spentRecoveryCodeSession: spentSession
  });
});
