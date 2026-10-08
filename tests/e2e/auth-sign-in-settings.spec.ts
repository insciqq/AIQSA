import { randomUUID } from "node:crypto";
import { PrismaClient, type AuthSignInMethodSetting, type AuthSignInPolicy } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Sign-in settings are installation singletons: the spec snapshots the Google row and the
// switches, changes them on this disposable stand and puts the snapshot back.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const GOOGLE_CLIENT = `${run}-e2e.apps.googleusercontent.com`;
const GOOGLE_SECRET = `GOCSPX-e2e-${run}-write-only`;
const POLICY_ID = "installation";

let googleSnapshot: AuthSignInMethodSetting | null = null;
let policySnapshot: AuthSignInPolicy | null = null;

test.beforeAll(async () => {
  googleSnapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "google" } });
  policySnapshot = await prisma.authSignInPolicy.findUnique({ where: { id: POLICY_ID } });
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "google" } });
  await prisma.authSignInPolicy.deleteMany({ where: { id: POLICY_ID } });
});

test.afterAll(async () => {
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "google" } });
  await prisma.authSignInPolicy.deleteMany({ where: { id: POLICY_ID } });
  if (googleSnapshot) {
    await prisma.authSignInMethodSetting.create({
      data: {
        ...googleSnapshot,
        activeConfig: googleSnapshot.activeConfig ?? undefined,
        draftConfig: googleSnapshot.draftConfig ?? undefined
      }
    });
  }
  if (policySnapshot) await prisma.authSignInPolicy.create({ data: policySnapshot });
  await prisma.$disconnect();
});

async function setPolicy(input: { passwordLoginEnabled: boolean; registrationEnabled: boolean }) {
  await prisma.authSignInPolicy.upsert({
    create: { id: POLICY_ID, ...input },
    update: { ...input, version: { increment: 1 } },
    where: { id: POLICY_ID }
  });
}

async function openSignIn(page: Page) {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=sign-in");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Sign-in");
  const section = page.getByTestId("admin-sign-in-section");
  await expect(section.getByTestId("admin-sign-in-card-google")).toBeVisible();
  return section;
}

test("admin configures Google with draft, test and activate, and the login page offers it", async ({ browser, page }) => {
  const section = await openSignIn(page);
  const google = section.getByTestId("admin-sign-in-card-google");
  const environmentGoogle = await google.getByTestId("admin-sign-in-environment").isVisible();
  await expect(google.getByTestId("admin-sign-in-status")).toHaveText(environmentGoogle ? "Active (environment)" : "Off");
  await expect(google.getByLabel("Authorized redirect URI")).toHaveValue(/\/api\/auth\/oauth\/google\/callback$/);

  await google.getByLabel("Client ID").fill(GOOGLE_CLIENT);
  await google.getByLabel("Client secret").fill(GOOGLE_SECRET);
  await expect(google.getByRole("button", { name: "Activate" })).toBeDisabled();
  await google.getByRole("button", { name: "Save" }).click();
  await expect(google.getByLabel("Client secret")).toHaveValue("");
  await expect(google.getByText(/Stored\. Leave blank to keep it/)).toBeVisible();
  await google.getByRole("button", { name: "Test" }).click();
  await expect(google.getByTestId("admin-sign-in-test")).toContainText("Test passed");
  await google.getByRole("button", { name: "Activate" }).click();
  await expect(google.getByTestId("admin-sign-in-status")).toHaveText("Active (admin)");

  // Secrets are write-only: never in the admin API or the rendered page.
  const overview = await page.request.get("/api/admin/sign-in");
  expect(await overview.text()).not.toContain(GOOGLE_SECRET);
  expect(await page.content()).not.toContain(GOOGLE_SECRET);

  const anonymous = await browser.newContext();
  const login = await anonymous.newPage();
  await login.goto("/login");
  await expect(login.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  const start = await login.request.get("/api/auth/oauth/google?next=%2F", { maxRedirects: 0 });
  expect(start.status()).toBe(303);
  const authorization = new URL(start.headers().location!);
  expect(authorization.searchParams.get("client_id")).toBe(GOOGLE_CLIENT);
  expect(authorization.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/oauth\/google\/callback$/);

  await google.getByRole("button", { name: "Disable" }).click();
  await page.getByTestId("admin-confirm-sign-in-disable").getByRole("button", { name: "Disable" }).click();
  await expect(google.getByTestId("admin-sign-in-status")).toHaveText(environmentGoogle ? "Active (environment)" : "Off");
  await login.goto("/login");
  await expect(login.getByRole("link", { name: "Continue with Google" })).toHaveCount(environmentGoogle ? 1 : 0);
  await anonymous.close();
});

test("the lockout guard keeps password sign-in on for a bootstrap session and names the break-glass path", async ({ page }) => {
  const section = await openSignIn(page);
  const policy = section.getByTestId("admin-sign-in-policy");
  const passwordSwitch = policy.getByRole("switch", { name: "Password sign-in" });

  await expect(policy).toContainText("You signed in with the bootstrap token");
  await passwordSwitch.click();
  await page.getByTestId("admin-confirm-password-sign-in-off").getByRole("button", { name: "Turn off" }).click();
  await expect(policy.getByTestId("admin-sign-in-policy-message")).toContainText("AIQSA_BOOTSTRAP_AUTH_TOKEN");
  await expect(passwordSwitch).toHaveAttribute("aria-checked", "true");
  await expect(prisma.authSignInPolicy.findUnique({ where: { id: POLICY_ID } })).resolves.toBeNull();
});

test("with password sign-in off the forms are hidden and every password route is refused, the bootstrap token still works", async ({ browser }) => {
  await setPolicy({ passwordLoginEnabled: false, registrationEnabled: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page.getByTestId("password-sign-in-off")).toContainText("Password sign-in is turned off");
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset password" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);

    for (const [path, body] of [
      ["/api/auth/login", { email: "operator@aiqsa.local", password: "password" }],
      ["/api/auth/register", { email: `register-${run}@example.com` }],
      ["/api/auth/invite/accept", { password: "a new password", token: "invite-token" }],
      ["/api/auth/password-reset/request", { email: "operator@aiqsa.local" }],
      ["/api/auth/password-reset/complete", { password: "a new password", token: "reset-token" }]
    ] as const) {
      const response = await page.request.post(path, { data: body });
      expect(response.status(), path).toBe(403);
      expect(await response.json(), path).toEqual({ error: "password_login_disabled" });
    }

    const bootstrap = await page.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
    expect(bootstrap.ok()).toBe(true);
    await context.close();
  } finally {
    await setPolicy({ passwordLoginEnabled: true, registrationEnabled: true });
  }
});

test("with access requests off the request form is hidden and registration is refused", async ({ browser }) => {
  await setPolicy({ passwordLoginEnabled: true, registrationEnabled: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
    const response = await page.request.post("/api/auth/register", { data: { email: `register-${run}@example.com` } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "registration_disabled" });
    await context.close();
  } finally {
    await setPolicy({ passwordLoginEnabled: true, registrationEnabled: true });
  }
});

test("external group names manage memberships: markers, refusal and identity unlinking", async ({ page }) => {
  const domain = `sign-in-e2e-${run}.example.com`;
  const group = await prisma.group.create({ data: { name: `IdP team ${run}` } });
  const user = await prisma.user.create({
    data: { displayName: `Directory person ${run}`, email: `person@${domain}`, groups: { create: [{ groupId: group.id }] }, status: "active" }
  });
  await prisma.authIdentity.create({
    data: {
      emailVerifiedAt: new Date(),
      lastSyncWarning: "groups_claim_missing",
      lastSyncedAt: new Date(),
      normalizedEmail: `person@${domain}`,
      provider: "oidc",
      providerAccountId: `subject-${run}`,
      source: `https://idp-${run}.example.test/realms/main`,
      userId: user.id
    }
  });
  try {
    await signInWithLocalToken(page);
    await page.goto(`/admin?section=groups&resource=${group.id}`);
    const groupPage = page.getByTestId("admin-group-page");
    const names = groupPage.getByTestId("admin-group-external-names");
    await expect(names).toContainText("Entra ID sends group object IDs");
    const oidc = names.getByTestId("admin-group-external-source").filter({ hasText: "OIDC" });
    await oidc.getByLabel("Add an external name for OIDC").fill("/idp-team");
    await oidc.getByRole("button", { name: "Add" }).click();
    await expect(oidc.getByTestId("admin-group-external-name")).toHaveText("/idp-team");
    await expect(groupPage.getByTestId("admin-group-member").filter({ hasText: user.displayName })).toContainText("Managed by OIDC");

    const refused = await page.request.post("/api/admin/action", {
      data: { action: "set_user_groups", expectedGroupIds: [group.id], groupIds: [], userId: user.id }
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toEqual({ error: "group_membership_managed" });

    await page.goto(`/admin?section=users&resource=${user.id}`);
    const userPage = page.getByTestId("admin-user-page");
    await expect(userPage.getByTestId("admin-user-managed-groups")).toContainText(`IdP team ${run}`);
    const identity = userPage.getByTestId("admin-user-identity");
    await expect(identity.getByTestId("admin-user-identity-sync-warning")).toContainText("carried no groups");
    await identity.getByRole("button", { name: "Unlink identity" }).click();
    await identity.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(identity.getByTestId("admin-user-identity-unlink-confirm")).toContainText("only way to sign in");
    await identity.getByRole("button", { name: "Unlink anyway" }).click();
    await expect(userPage.getByTestId("admin-user-identity")).toHaveCount(0);
    await expect(prisma.authIdentity.count({ where: { userId: user.id } })).resolves.toBe(0);
  } finally {
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: group.id } });
  }
});

for (const viewport of [
  { height: 1180, name: "tablet portrait", width: 820 },
  { height: 820, name: "tablet landscape", width: 1180 },
  { height: 844, name: "phone portrait", width: 390 },
  { height: 390, name: "phone landscape", width: 844 }
] as const) {
  test(`the Sign-in section fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    const section = await openSignIn(page);
    const google = section.getByTestId("admin-sign-in-card-google");
    await google.scrollIntoViewIfNeeded();
    await expect(google.getByLabel("Client ID")).toBeVisible();
    await expect(google.getByRole("button", { name: "Save" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`sign-in-${viewport.width}x${viewport.height}.png`) });

    const login = await page.context().browser()!.newContext({ viewport: { height: viewport.height, width: viewport.width } });
    const loginPage = await login.newPage();
    await loginPage.goto("/login");
    await expect(loginPage.getByTestId("auth-workspace")).toBeVisible();
    await expectNoHorizontalOverflow(loginPage);
    await login.close();
  });
}
