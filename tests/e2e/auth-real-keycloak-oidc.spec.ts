import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import {
  addExternalNameInUi,
  adminSession,
  alert,
  attachEvidence,
  createGroup,
  deleteStandUsers,
  deleteSyntheticMcpServers,
  disableMethod,
  enabledMcpPreference,
  hasSessionCookie,
  keycloakAdmin,
  keycloakSignIn,
  keycloakUsers,
  loginPage,
  oidcSignIn,
  openSignInCard,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  reconfigureMethod,
  restoreKeycloakUsers,
  saveTestActivate,
  snapshotMethod,
  standContext,
  standEnv,
  syntheticMcpServer,
  type KeycloakUser,
  type SyntheticMcpServer
} from "./support/realIdp";

/**
 * Real-IdP scenario 1: Keycloak as the OIDC provider (auth-wave-e2e-docs Scope §2.1).
 *
 * Configure, Test and Activate through the card; allowed groups; the `/engineers` group sync
 * including a removal in Keycloak with its MCP side effects; a realm role as administrator
 * group (promote, demote, manual admin untouched, last-admin guard); an outsider refused; an
 * unverified email that links only with the trust switch; auto-redirect, `?local=1` and the
 * IdP logout. Stand: tests/auth-idp. The OIDC row is an installation singleton restored at the
 * end; Keycloak users get their template groups and roles back.
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the stand passwords typed into Keycloak's form.
// Traces would record IdP passwords; a failure screenshot shows at most a username.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const BUTTON = "Keycloak";
const GROUP_NAME = `Engineers ${run}`;
const emails = Object.values(keycloakUsers).map((user) => user.email);
const servers: SyntheticMcpServer[] = [];
let restoreOidc: (() => Promise<void>) | null = null;
let groupId = "";
let carolLocalId = "";

const password = (user: KeycloakUser) => standEnv(user.passwordEnv);

function signIn(browser: Browser, user: KeycloakUser) {
  return oidcSignIn(browser, { buttonLabel: BUTTON, password: password(user), username: user.username });
}

async function userByIdentity(email: string) {
  return prisma.user.findFirst({
    include: { authIdentities: { where: { provider: "oidc" } } },
    where: { authIdentities: { some: { normalizedEmail: email, provider: "oidc" } } }
  });
}

async function memberOfGroup(userId: string): Promise<boolean> {
  return (await prisma.userGroup.count({ where: { groupId, userId } })) === 1;
}

async function expectSignedIn(context: BrowserContext) {
  const page = context.pages()[0]!;
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(async () => {
  const snapshot = await snapshotMethod(prisma, "oidc");
  restoreOidc = snapshot.restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "oidc" } });
  await restoreKeycloakUsers();
  await deleteStandUsers(prisma, emails);
});

test.afterAll(async ({ browser }) => {
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "oidc").catch(() => undefined);
    await admin.context.close();
  } finally {
    await restoreKeycloakUsers();
    await restoreOidc?.();
    await deleteSyntheticMcpServers(prisma, servers);
    await deleteStandUsers(prisma, emails);
    if (carolLocalId) await prisma.user.deleteMany({ where: { id: carolLocalId } });
    if (groupId) await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});

test("an administrator configures Keycloak through the card: Test passes and Activate turns it on", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "oidc");
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Off");
  await card.getByLabel("Issuer").fill(standEnv("AIQSA_E2E_KEYCLOAK_ISSUER"));
  await card.getByLabel("Button label").fill(BUTTON);
  await card.getByLabel("Client ID").fill("aiqsa");
  await card.getByLabel("Client secret").fill(standEnv("AIQSA_E2E_OIDC_CLIENT_SECRET"));
  // Admitted: members of /engineers, and of /admins (the removal step moves alice there).
  await card.getByLabel("Allowed groups").fill("/engineers\n/admins");
  await expect(card.getByLabel("Sync groups")).toBeChecked();
  await saveTestActivate(page, card, { secretField: "Client secret", testPassed: "Test passed: Discovery, issuer, signing keys" });
  await page.screenshot({ path: testInfo.outputPath("oidc-card-active-desktop.png") });
  const secret = standEnv("AIQSA_E2E_OIDC_CLIENT_SECRET");
  const overviewHasSecret = (await (await page.request.get("/api/admin/sign-in")).text()).includes(secret);
  const pageHasSecret = (await page.content()).includes(secret);
  expect(overviewHasSecret).toBe(false);
  expect(pageHasSecret).toBe(false);

  groupId = await createGroup(context.request, GROUP_NAME);
  servers.push(await syntheticMcpServer(prisma, "engineers", groupId));
  await addExternalNameInUi(page, groupId, "OIDC", "/engineers");
  await page.screenshot({ path: testInfo.outputPath("oidc-group-external-name-desktop.png") });
  await attachEvidence(testInfo, "oidc-configured", { overviewHasSecret, pageHasSecret, status: "active_admin" });
  await context.close();
});

test("a member of an allowed group signs in and joins the mapped group; an outsider is refused", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const alice = await signIn(browser, keycloakUsers.alice);
  await expectSignedIn(alice.context);
  const aliceUser = await userByIdentity(keycloakUsers.alice.email);
  expect(aliceUser?.authIdentities[0]?.source).toBe(standEnv("AIQSA_E2E_KEYCLOAK_ISSUER"));
  expect(await memberOfGroup(aliceUser!.id)).toBe(true);
  const oidcSessions = await prisma.authSession.count({ where: { revokedAt: null, signInMethod: "oidc", userId: aliceUser!.id } });
  expect(oidcSessions).toBe(1);
  await alice.context.close();

  const bob = await signIn(browser, keycloakUsers.bob);
  await expect(bob.page).toHaveURL(/\/login\?oauth=not_allowed&provider=oidc/u, { timeout: 60_000 });
  await expect(alert(bob.page)).toBeVisible();
  await bob.page.screenshot({ path: testInfo.outputPath("oidc-login-not-allowed-desktop.png") });
  const bobSession = await hasSessionCookie(bob.context);
  const bobAccounts = await prisma.user.count({ where: { authIdentities: { some: { normalizedEmail: keycloakUsers.bob.email } } } });
  expect(bobSession).toBe(false);
  expect(bobAccounts).toBe(0);
  await bob.context.close();
  await attachEvidence(testInfo, "oidc-admission", { aliceMember: true, bobAccounts, bobSession, oidcSessions });
});

test("leaving the group in Keycloak removes the membership at the next sign-in, with the MCP side effects", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const aliceId = (await userByIdentity(keycloakUsers.alice.email))!.id;
  await enabledMcpPreference(prisma, servers[0]!, aliceId);
  const keycloak = keycloakAdmin();
  await keycloak.removeFromGroup("alice", "engineers");
  await keycloak.addToGroup("alice", "admins");
  try {
    const alice = await signIn(browser, keycloakUsers.alice);
    await expectSignedIn(alice.context);
    await alice.context.close();
    const member = await memberOfGroup(aliceId);
    const runtime = await prisma.mcpUserServer.findFirstOrThrow({
      select: { desiredRuntimeGenerationId: true, enabled: true },
      where: { serverId: servers[0]!.serverId, userId: aliceId }
    });
    expect(member).toBe(false);
    expect(runtime).toEqual({ desiredRuntimeGenerationId: null, enabled: false });

    // Back in /engineers in Keycloak: the next sign-in restores the membership.
    await keycloak.restoreUser("alice", { groups: keycloakUsers.alice.groups });
    const again = await signIn(browser, keycloakUsers.alice);
    await expectSignedIn(again.context);
    await again.context.close();
    const rejoined = await memberOfGroup(aliceId);
    expect(rejoined).toBe(true);
    await attachEvidence(testInfo, "oidc-group-sync", {
      memberAfterRemoval: member,
      mcpDesiredGenerationCleared: runtime.desiredRuntimeGenerationId === null,
      mcpEnabledAfterRemoval: runtime.enabled,
      rejoined
    });
  } finally {
    await keycloak.restoreUser("alice", { groups: keycloakUsers.alice.groups });
  }
});

test("an unverified email does not link to an existing local account; the trust switch links it", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const carolLocal = await prisma.user.create({
    data: { displayName: `Carol local ${run}`, email: keycloakUsers.carol.email, status: "active" }
  });
  carolLocalId = carolLocal.id;

  const refused = await signIn(browser, keycloakUsers.carol);
  await expect(refused.page).toHaveURL(/\/login\?oauth=account_conflict&provider=oidc/u, { timeout: 60_000 });
  await expect(alert(refused.page)).toBeVisible();
  await refused.page.screenshot({ path: testInfo.outputPath("oidc-login-account-conflict-desktop.png") });
  const linkedBefore = await prisma.authIdentity.count({ where: { provider: "oidc", userId: carolLocal.id } });
  expect(linkedBefore).toBe(0);
  await refused.context.close();

  const admin = await adminSession(browser);
  await reconfigureMethod(admin.context.request, "oidc", { trustUnverifiedEmail: true }, ["clientSecret"]);
  try {
    const trusted = await signIn(browser, keycloakUsers.carol);
    await expectSignedIn(trusted.context);
    await trusted.context.close();
    const identity = await prisma.authIdentity.findFirstOrThrow({
      select: { emailVerifiedAt: true, userId: true },
      where: { normalizedEmail: keycloakUsers.carol.email, provider: "oidc" }
    });
    expect(identity.userId).toBe(carolLocal.id);
    expect(identity.emailVerifiedAt).toBeNull();
    await attachEvidence(testInfo, "oidc-email-trust", {
      linkedToLocalAccount: identity.userId === carolLocal.id,
      linkedWithoutTrust: linkedBefore,
      refusedCode: "account_conflict"
    });
  } finally {
    await reconfigureMethod(admin.context.request, "oidc", { trustUnverifiedEmail: false }, ["clientSecret"]);
    await admin.context.close();
  }
});

test("a realm role in the admin groups promotes, its removal demotes, a manual admin stays, the last admin keeps the role", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  const admin = await adminSession(browser);
  const issuer = standEnv("AIQSA_E2E_KEYCLOAK_ISSUER");
  await reconfigureMethod(admin.context.request, "oidc", {
    adminGroups: ["aiqsa-admin"],
    allowedGroups: [],
    groupsClaimPath: "realm_access.roles",
    syncGroups: false
  }, ["clientSecret"]);
  const keycloak = keycloakAdmin();
  const demoted: string[] = [];
  try {
    const dave = await signIn(browser, keycloakUsers.dave);
    await expectSignedIn(dave.context);
    await dave.context.close();
    const daveUser = (await userByIdentity(keycloakUsers.dave.email))!;
    expect({ role: daveUser.role, roleManagedBy: daveUser.roleManagedBy }).toEqual({ role: "admin", roleManagedBy: `oidc:${issuer}` });

    // A manual administrator without the role keeps it.
    const aliceId = (await userByIdentity(keycloakUsers.alice.email))!.id;
    const promoted = await admin.context.request.post("/api/admin/action", { data: { action: "set_user_role", role: "admin", userId: aliceId } });
    expect(promoted.ok()).toBe(true);
    const alice = await signIn(browser, keycloakUsers.alice);
    await expectSignedIn(alice.context);
    await alice.context.close();
    const aliceAfter = await prisma.user.findUniqueOrThrow({ select: { role: true, roleManagedBy: true }, where: { id: aliceId } });
    expect(aliceAfter).toEqual({ role: "admin", roleManagedBy: null });

    // Last active administrator: with every other admin briefly demoted, removing the role keeps it.
    await keycloak.removeRealmRole("dave", "aiqsa-admin");
    const others = await prisma.user.findMany({ select: { id: true }, where: { id: { not: daveUser.id }, role: "admin", status: "active" } });
    demoted.push(...others.map((user) => user.id));
    await prisma.user.updateMany({ data: { role: "user" }, where: { id: { in: demoted } } });
    const kept = await signIn(browser, keycloakUsers.dave);
    await expectSignedIn(kept.context);
    await kept.context.close();
    const daveKept = await prisma.user.findUniqueOrThrow({ select: { role: true }, where: { id: daveUser.id } });
    const keptWarning = (await prisma.authIdentity.findFirstOrThrow({
      select: { lastSyncWarning: true },
      where: { provider: "oidc", userId: daveUser.id }
    })).lastSyncWarning;
    expect(daveKept.role).toBe("admin");
    expect(keptWarning).toBe("last_admin_kept");
    await prisma.user.updateMany({ data: { role: "admin" }, where: { id: { in: demoted.splice(0) } } });

    // The user page names the kept role.
    await admin.page.goto(`/admin?section=users&resource=${encodeURIComponent(daveUser.id)}`);
    const identityRow = admin.page.getByTestId("admin-user-page").getByTestId("admin-user-identity");
    await expect(identityRow.getByTestId("admin-user-identity-sync-warning")).toContainText("last active administrator");
    await admin.page.screenshot({ path: testInfo.outputPath("oidc-user-last-admin-kept-desktop.png") });

    // With other admins back, the next sign-in without the role demotes.
    const demotedSignIn = await signIn(browser, keycloakUsers.dave);
    await expectSignedIn(demotedSignIn.context);
    await demotedSignIn.context.close();
    const daveAfter = await prisma.user.findUniqueOrThrow({ select: { role: true, roleManagedBy: true }, where: { id: daveUser.id } });
    expect(daveAfter).toEqual({ role: "user", roleManagedBy: null });
    const aliceStill = await prisma.user.findUniqueOrThrow({ select: { role: true }, where: { id: aliceId } });
    expect(aliceStill.role).toBe("admin");
    await attachEvidence(testInfo, "oidc-admin-role", {
      demotedAfterRoleRemoval: daveAfter.role === "user",
      keptAsLastAdmin: daveKept.role === "admin",
      keptWarning: keptWarning ?? "none",
      manualAdminKept: aliceStill.role === "admin",
      promotedByRole: true
    });
  } finally {
    if (demoted.length) await prisma.user.updateMany({ data: { role: "admin" }, where: { id: { in: demoted } } });
    await keycloak.restoreUser("dave", { groups: keycloakUsers.dave.groups, roles: keycloakUsers.dave.roles });
    await admin.context.close();
  }
});

test("auto-redirect sends /login to Keycloak, ?local=1 stays, and signing out ends the Keycloak session", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const admin = await adminSession(browser);
  await reconfigureMethod(admin.context.request, "oidc", {
    adminGroups: [],
    autoRedirect: true,
    groupsClaimPath: "groups",
    idpLogout: true,
    syncGroups: true
  }, ["clientSecret"]);
  await admin.context.close();
  const keycloakOrigin = new URL(standEnv("AIQSA_E2E_KEYCLOAK_ISSUER")).origin;

  const local = await loginPage(browser, "/login?local=1");
  await expect(local.page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(local.page.getByRole("link", { name: `Continue with ${BUTTON}` })).toBeVisible();
  await local.page.screenshot({ path: testInfo.outputPath("oidc-login-local-desktop.png") });
  await local.context.close();

  const context = await standContext(browser);
  const page = await context.newPage();
  // The settings snapshot lives a few seconds; activation already dropped it.
  await page.goto("/login");
  await expect(page).toHaveURL((url) => url.origin === keycloakOrigin, { timeout: 60_000 });
  await keycloakSignIn(page, "alice", password(keycloakUsers.alice));
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const aliceId = (await userByIdentity(keycloakUsers.alice.email))!.id;
  // Earlier tests left other sessions of alice open in their own browsers: sign-out ends this one.
  const sessionsBefore = await prisma.authSession.count({ where: { revokedAt: null, signInMethod: "oidc", userId: aliceId } });

  // A click before hydration opens nothing: retry until the menu shows.

  const accountMenu = page.getByRole("menu", { name: "Account", exact: true });

  await expect(async () => {

    await page.getByRole("button", { name: "Account menu" }).first().click();

    await expect(accountMenu).toBeVisible({ timeout: 2_000 });

  }).toPass({ timeout: 30_000 });

  await accountMenu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL((url) => url.origin === keycloakOrigin && url.pathname.endsWith("/protocol/openid-connect/logout"), { timeout: 30_000 });
  // Without an id_token_hint Keycloak asks before it ends its session.
  await page.screenshot({ path: testInfo.outputPath("oidc-idp-logout-confirm-desktop.png") });
  await page.locator("#kc-logout").click();
  // Back at /login, which redirects again: Keycloak now asks for credentials.
  await expect(page.locator("#kc-form-login")).toBeVisible({ timeout: 60_000 });
  const activeSessions = await prisma.authSession.count({ where: { revokedAt: null, signInMethod: "oidc", userId: aliceId } });
  expect(sessionsBefore - activeSessions).toBe(1);
  expect((await context.cookies()).some((cookie) => cookie.name === "aiqsa_session")).toBe(false);
  await context.close();
  await attachEvidence(testInfo, "oidc-redirect-logout", {
    activeSessionsAfterLogout: activeSessions,
    autoRedirect: true,
    idpAsksForCredentialsAfterLogout: true
  });
});

for (const viewport of [
  { height: 1180, name: "tablet-portrait", width: 820 },
  { height: 820, name: "tablet-landscape", width: 1180 },
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const) {
  test(`the Keycloak sign-in screens fit the ${viewport.name} viewport`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const touch = viewport.width < 1024 ? { hasTouch: true, isMobile: viewport.width < 600 || viewport.height < 600 } : {};
    const login = await loginPage(browser, "/login?local=1", { ...touch, viewport: { height: viewport.height, width: viewport.width } });
    await expect(login.page.getByRole("link", { name: `Continue with ${BUTTON}` })).toBeVisible();
    await expectNoHorizontalOverflow(login.page);
    await login.page.screenshot({ path: testInfo.outputPath(`oidc-login-local-${viewport.name}.png`) });
    await login.context.close();

    const admin = await adminSession(browser, { ...touch, viewport: { height: viewport.height, width: viewport.width } });
    const card = await openSignInCard(admin.page, "oidc");
    await card.getByLabel("Issuer").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(admin.page);
    await admin.page.screenshot({ path: testInfo.outputPath(`oidc-card-${viewport.name}.png`) });
    await admin.page.goto(`/admin?section=groups&resource=${encodeURIComponent(groupId)}`);
    const names = admin.page.getByTestId("admin-group-external-names");
    await names.scrollIntoViewIfNeeded();
    await expect(names.getByTestId("admin-group-external-name").filter({ hasText: "/engineers" })).toBeVisible();
    await expectNoHorizontalOverflow(admin.page);
    await admin.page.screenshot({ path: testInfo.outputPath(`oidc-group-external-names-${viewport.name}.png`) });
    const aliceId = (await userByIdentity(keycloakUsers.alice.email))!.id;
    await admin.page.goto(`/admin?section=users&resource=${encodeURIComponent(aliceId)}`);
    const identity = admin.page.getByTestId("admin-user-identity").first();
    await identity.scrollIntoViewIfNeeded();
    await expect(admin.page.getByTestId("admin-user-managed-groups")).toContainText(GROUP_NAME);
    await expectNoHorizontalOverflow(admin.page);
    await admin.page.screenshot({ path: testInfo.outputPath(`oidc-user-markers-${viewport.name}.png`) });
    await admin.context.close();
  });
}
