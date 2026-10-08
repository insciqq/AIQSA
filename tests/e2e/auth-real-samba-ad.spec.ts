import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser } from "@playwright/test";
import {
  addExternalName,
  adminSession,
  attachEvidence,
  createGroup,
  deleteStandUsers,
  disableMethod,
  loginPage,
  openSignInCard,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  saveTestActivate,
  snapshotMethod,
  standEnv
} from "./support/realIdp";

/**
 * Real-IdP scenario 4: Samba AD DC over LDAPS (auth-wave-e2e-docs Scope §2.4).
 *
 * The Active Directory preset (`sAMAccountName`, `objectGUID`), a service account bound by UPN,
 * LDAPS verified against the stand's CA, groups from `memberOf` in first-CN form and an
 * administrator group. Without the CA the tester reports the TLS failure and nothing activates.
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the stand passwords typed into the forms.
// Traces would record IdP passwords; a failure screenshot shows at most a username.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const USERS = {
  anna: { email: "anna@ad.aiqsa.test", passwordEnv: "AIQSA_E2E_PW_ANNA", username: "anna" },
  ivan: { email: "ivan@ad.aiqsa.test", passwordEnv: "AIQSA_E2E_PW_IVAN", username: "ivan" }
} as const;
const emails = [USERS.anna.email, USERS.ivan.email];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
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

async function adSignIn(browser: Browser, user: (typeof USERS)[keyof typeof USERS]) {
  const { context, page } = await loginPage(browser);
  const form = page.locator('form[data-hydrated="true"]');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByLabel("Username or email").fill(user.username);
  await form.getByLabel("Password", { exact: true }).fill(standEnv(user.passwordEnv));
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await context.close();
  return prisma.user.findFirstOrThrow({
    include: { authIdentities: { where: { provider: "ldap" } } },
    where: { authIdentities: { some: { normalizedEmail: user.email, provider: "ldap" } } }
  });
}

test("without the CA the tester reports the TLS failure; with it the AD preset finds the entry over LDAPS", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "ldap");
  await card.getByRole("button", { name: "Active Directory" }).click();
  await expect(card.getByLabel("User search filter")).toHaveValue("(sAMAccountName={{username}})");
  await expect(card.getByLabel("Id attribute")).toHaveValue("objectGUID");
  await card.getByLabel("Server URL").fill(standEnv("AIQSA_E2E_AD_URL"));
  await expect(card.getByLabel("Verify the server certificate")).toBeChecked();
  await card.getByLabel("Bind DN").fill(standEnv("AIQSA_E2E_AD_BIND_DN"));
  await card.getByLabel("Bind password").fill(standEnv("AIQSA_E2E_AD_BIND_PASSWORD"));
  await card.getByLabel("User search base").fill("dc=aiqsa,dc=test");
  await card.getByLabel("Administrator groups").fill("ad-admins");
  await card.getByLabel("Sync group memberships from the directory").check();
  await card.getByLabel("Sample sign-in name").fill("anna");

  // No CA: the system roots do not trust the stand's self-signed DC certificate.
  await card.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await card.getByLabel("Bind password").inputValue()) === "", { timeout: 60_000 }).toBe(true);
  await card.getByRole("button", { name: "Test", exact: true }).click();
  await expect(card.getByTestId("admin-sign-in-test")).toContainText("Test failed: The TLS connection failed", { timeout: 60_000 });
  await expect(card.getByRole("button", { name: "Activate" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("ad-card-tls-failed-desktop.png") });

  await card.getByLabel("CA certificate (PEM)").fill(readFileSync(standEnv("AIQSA_E2E_AD_CA_FILE"), "utf8"));
  await saveTestActivate(page, card, { testPassed: "Test passed: Found the sample entry over LDAPS. Id and email attributes present." });
  await page.screenshot({ path: testInfo.outputPath("ad-card-active-desktop.png") });

  groupId = await createGroup(context.request, `AD engineers ${run}`);
  await addExternalName(context.request, groupId, "ldap", "ad-engineers");
  await context.close();
  await attachEvidence(testInfo, "ad-tls", { withCa: "entry_found_ldaps", withoutCa: "tls_failed" });
});

test("AD users sign in by sAMAccountName with objectGUID identities, memberOf groups and the administrator group", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const anna = await adSignIn(browser, USERS.anna);
  const annaGuid = GUID.test(anna.authIdentities[0]!.providerAccountId);
  expect(annaGuid).toBe(true);
  expect(anna.authIdentities[0]!.source).toBe("ldap://dc1.aiqsa.test/dc=aiqsa,dc=test");
  const annaMember = (await prisma.userGroup.count({ where: { groupId, userId: anna.id } })) === 1;
  expect(annaMember).toBe(true);
  expect(anna.role).toBe("user");

  const ivan = await adSignIn(browser, USERS.ivan);
  const ivanGuid = GUID.test(ivan.authIdentities[0]!.providerAccountId);
  expect(ivanGuid).toBe(true);
  expect(ivan.role).toBe("admin");
  expect(ivan.roleManagedBy?.startsWith("ldap:")).toBe(true);
  const ivanMember = (await prisma.userGroup.count({ where: { groupId, userId: ivan.id } })) === 1;
  expect(ivanMember).toBe(true);
  await attachEvidence(testInfo, "ad-sign-in", { annaGuid, annaMember, ivanAdmin: ivan.role === "admin", ivanGuid, ivanMember });
});
