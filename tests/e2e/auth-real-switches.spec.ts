import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { createPeopleFixture } from "./support/people";
import {
  adminSession,
  attachEvidence,
  configureMethod,
  deleteStandUsers,
  disableMethod,
  FORWARDED,
  keycloakClientSecret,
  keycloakOidcConfig,
  keycloakUsers,
  loginPage,
  oidcSignIn,
  openSignInSection,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  restoreKeycloakUsers,
  signInOverview,
  snapshotMethod,
  snapshotPolicy,
  standContext,
  standEnv
} from "./support/realIdp";

/**
 * Real-IdP scenario 7: switches and fallback (auth-wave-e2e-docs Scope §2.7) with a real
 * external administrator. An administrator signed in with a password cannot turn passwords off
 * (lockout guard); one signed in through Keycloak can; then every password route is refused on
 * the server, that administrator cannot disable the method they signed in with, and the
 * bootstrap token still signs in.
 *
 * Covered elsewhere and not repeated here: the Google environment fallback ("Active
 * (environment)", an admin configuration overriding it, disabling falling back) in
 * `auth-sign-in-settings.spec.ts` and `auth-yandex-switch.spec.ts`; password sign-in with TOTP
 * and a password reset that keeps it (scenario 8) in `auth-totp.spec.ts`.
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the stand passwords typed into Keycloak's form.
// Traces would record IdP passwords; a failure screenshot shows at most a username.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
let restoreOidc: (() => Promise<void>) | null = null;
let restorePolicy: (() => Promise<void>) | null = null;

test.beforeAll(async ({ browser }) => {
  restoreOidc = (await snapshotMethod(prisma, "oidc")).restore;
  restorePolicy = (await snapshotPolicy(prisma)).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "oidc" } });
  await restoreKeycloakUsers();
  await deleteStandUsers(prisma, [keycloakUsers.dave.email]);
  const admin = await adminSession(browser);
  await configureMethod(admin.context.request, "oidc", keycloakOidcConfig({ adminGroups: ["/admins"] }), keycloakClientSecret());
  await admin.context.close();
});

test.afterAll(async ({ browser }) => {
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "oidc").catch(() => undefined);
    await admin.context.close();
  } finally {
    await restorePolicy?.();
    await restoreOidc?.();
    await people.cleanup();
    await deleteStandUsers(prisma, [keycloakUsers.dave.email]);
    await prisma.$disconnect();
  }
});

test("passwords go off only from an external sign-in; then the server refuses them and the bootstrap token still works", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  // A password-signed-in administrator: the lockout guard keeps passwords on.
  const passwordAdmin = await people.admin("switch-admin");
  const passwordSession = await people.signIn(browser, passwordAdmin, { extraHTTPHeaders: { ...FORWARDED } });
  const ownSection = await openSignInSection(passwordSession.page);
  const ownPolicy = ownSection.getByTestId("admin-sign-in-policy");
  const ownSwitch = ownPolicy.getByRole("switch", { name: "Password sign-in" });
  await expect(ownPolicy).toContainText("You signed in with a password");
  await ownSwitch.click();
  await passwordSession.page.getByTestId("admin-confirm-password-sign-in-off").getByRole("button", { name: "Turn off" }).click();
  await expect(ownPolicy.getByTestId("admin-sign-in-policy-message")).toContainText("Password sign-in stays on");
  await expect(ownSwitch).toHaveAttribute("aria-checked", "true");
  await passwordSession.page.screenshot({ path: testInfo.outputPath("switches-lockout-password-admin-desktop.png") });

  // Dave is an administrator through Keycloak's /admins group and turns passwords off.
  const dave = await oidcSignIn(browser, {
    buttonLabel: "Keycloak",
    password: standEnv(keycloakUsers.dave.passwordEnv),
    username: keycloakUsers.dave.username
  });
  await expect(dave.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const section = await openSignInSection(dave.page);
  const policy = section.getByTestId("admin-sign-in-policy");
  const passwordSwitch = policy.getByRole("switch", { name: "Password sign-in" });
  await passwordSwitch.click();
  await dave.page.getByTestId("admin-confirm-password-sign-in-off").getByRole("button", { name: "Turn off" }).click();
  await expect(passwordSwitch).toHaveAttribute("aria-checked", "false");
  await dave.page.screenshot({ path: testInfo.outputPath("switches-password-off-desktop.png") });
  try {
    const stored = await prisma.authSignInPolicy.findUniqueOrThrow({ select: { passwordLoginEnabled: true }, where: { id: "installation" } });
    expect(stored.passwordLoginEnabled).toBe(false);

    // The server refuses the password; the login page offers Keycloak only.
    const login = await loginPage(browser);
    const refused = await login.context.request.post("/api/auth/login", { data: { email: passwordAdmin.email, password: passwordAdmin.password } });
    const refusal = [refused.status(), (await refused.json() as { error?: string }).error];
    expect(refusal).toEqual([403, "password_login_disabled"]);
    await expect.poll(async () => {
      await login.page.goto("/login");
      return login.page.getByTestId("password-sign-in-off").count();
    }, { timeout: 15_000 }).toBe(1);
    await expect(login.page.getByRole("link", { name: "Continue with Keycloak" })).toBeVisible();
    await login.page.screenshot({ path: testInfo.outputPath("switches-login-password-off-desktop.png") });

    // The external administrator cannot disable the method they signed in with.
    const oidc = (await signInOverview(dave.context.request)).methods.find((method) => method.method === "oidc")!;
    const disable = await dave.context.request.post("/api/admin/sign-in/methods/oidc", {
      data: { action: "disable", expectedActiveVersion: oidc.active.version }
    });
    const disableRefusal = [disable.status(), (await disable.json() as { error?: string }).error];
    expect(disableRefusal).toEqual([409, "password_login_lockout_risk"]);

    // Break-glass: the bootstrap token.
    const bootstrap = await standContext(browser);
    const token = await bootstrap.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
    expect(token.ok()).toBe(true);
    await bootstrap.close();
    await login.context.close();
    await attachEvidence(testInfo, "switches", {
      bootstrapTokenStatus: token.status(),
      disableOwnMethodRefusal: `${disableRefusal[0]}:${disableRefusal[1]}`,
      lockoutForPasswordAdmin: true,
      passwordLoginRefusal: `${refusal[0]}:${refusal[1]}`
    });
  } finally {
    await passwordSwitch.click();
    await expect(passwordSwitch).toHaveAttribute("aria-checked", "true");
    await dave.context.close();
  }
});
