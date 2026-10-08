import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { SESSION_COOKIE_NAME } from "../../lib/server/auth/constants";
import { hashToken } from "../../lib/server/auth/token";
import {
  adminSession,
  attachEvidence,
  configureMethod,
  deleteSyntheticMcpServers,
  disableMethod,
  loginPage,
  openSignInCard,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  saveTestActivate,
  snapshotMethod,
  standContext,
  standEnv,
  standMode,
  syntheticMcpServer,
  type SyntheticMcpServer
} from "./support/realIdp";

/**
 * Real-IdP scenario 2: Authentik as OIDC provider and real SCIM client (auth-wave-e2e-docs
 * Scope §2.2).
 *
 * AIQSA issues the SCIM token on its card; the spec creates, through Authentik's API, a SCIM
 * provider pointed at AIQSA (through the stand's router: Authentik is on the LAN, not on AIQSA's
 * network), an OAuth2 provider and an application with the SCIM provider as backchannel, then
 * users and a group that Authentik pushes. Oracles are AIQSA's database (polled, no fixed
 * sleeps) and its HTTP answers. Everything created in Authentik is deleted at the end; the stand
 * keeps no state between spec files except Authentik's own defaults.
 *
 * Runs in direct mode only: Authentik's SCIM requests reach AIQSA without the forwarded address
 * that trusted-proxy mode requires.
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.skip(standMode === "trusted", "Authentik's SCIM pushes bypass the header proxy; run this spec on the direct stand");
test.describe.configure({ mode: "serial" });
// Traces would record the generated Authentik passwords typed into its login form.
// Traces would record IdP passwords; a failure screenshot shows at most a username.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const SLUG = `aiqsa-e2e-${run}`;
const TEAM = `ak-team-${run}`;
const CLIENT_ID = `aiqsa-e2e-${run}`;
const CLIENT_SECRET = randomBytes(32).toString("base64url");
const SYNC_TIMEOUT_MS = 180_000;
const people = {
  alex: { email: `alex-${run}@authentik.aiqsa.test`, password: `${randomBytes(18).toString("base64url")}Aa1`, username: `ak-alex-${run}` },
  bea: { email: `bea-${run}@authentik.aiqsa.test`, password: `${randomBytes(18).toString("base64url")}Aa1`, username: `ak-bea-${run}` }
} as const;
type Person = (typeof people)[keyof typeof people];

const created = {
  application: false,
  groupPk: "",
  oauthPk: 0,
  scimPk: 0,
  userPks: new Map<string, number>()
};
const servers: SyntheticMcpServer[] = [];
let restoreScim: (() => Promise<void>) | null = null;
let restoreOidc: (() => Promise<void>) | null = null;
let tokenIdsBefore: string[] = [];
let userIdsBefore: string[] = [];
let groupIdsBefore: string[] = [];
let scimToken = "";
let preCreatedGroupId = "";
const projectIds: string[] = [];

// Authentik's API (2026.8): admin bootstrap token, JSON, DRF pagination.

const authentikUrl = () => standEnv("AIQSA_E2E_AUTHENTIK_URL").replace(/\/+$/u, "");

async function authentik(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${authentikUrl()}/api/v3${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${standEnv("AIQSA_E2E_AUTHENTIK_TOKEN")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    method
  });
  // Only the method, the first path segment and the status: response bodies can echo input.
  if (!response.ok) throw new Error(`authentik_api:${method}:${path.split("?")[0]!.split("/").slice(1, 3).join("/")}:${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

type Page<T> = { results: T[] };

/** The single object of a list endpoint whose `field` equals `value`, filtered locally. */
async function findOne<T extends Record<string, unknown>>(path: string, field: string, value: string): Promise<T> {
  const separator = path.includes("?") ? "&" : "?";
  const listed = await authentik("GET", `${path}${separator}page_size=500`) as Page<T>;
  const matches = listed.results.filter((entry) => entry[field] === value);
  if (matches.length !== 1) throw new Error(`authentik_lookup:${path.split("?")[0]!.split("/").slice(1, 3).join("/")}:${matches.length}`);
  return matches[0]!;
}

async function nudgeSync(model: "group" | "user", id: string | number) {
  // Authentik pushes on object changes by itself; this asks its worker for one object now.
  await authentik("POST", `/providers/scim/${created.scimPk}/sync/object/`, {
    sync_object_id: String(id),
    sync_object_model: model === "user" ? "authentik.core.models.User" : "authentik.core.models.Group"
  }).catch(() => undefined);
}

async function poll<T>(probe: () => Promise<T | null | undefined | false>, code: string, timeoutMs = SYNC_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(code);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function pushedUser(person: Person) {
  return prisma.user.findUnique({ where: { email: person.email } });
}

/** Authentik's login flow: identification, then password, then the implicit consent. */
async function authentikSignIn(browser: Browser, person: Person): Promise<{ context: BrowserContext; page: import("@playwright/test").Page }> {
  const { context, page } = await loginPage(browser, "/login?local=1");
  await page.getByRole("link", { name: "Continue with Authentik" }).click();
  const uid = page.locator('input[name="uidField"]');
  await expect(uid).toBeVisible({ timeout: 60_000 }).catch(async (error: unknown) => {
    // Content-free: where the browser ended up, the outcome code, and the method's health code.
    const url = new URL(page.url());
    const health = await prisma.authSignInMethodSetting.findUnique({ select: { lastFailureCode: true }, where: { method: "oidc" } });
    throw new Error(
      `authentik_login_not_reached host=${url.host} path=${url.pathname} oauth=${url.searchParams.get("oauth") ?? "-"} ` +
        `health=${health?.lastFailureCode ?? "-"}`,
      { cause: error }
    );
  });
  await uid.fill(person.username);
  const password = page.locator('input[name="password"]');
  // Some flows ask for the password on the identification page, others on the next stage.
  if (!(await password.isVisible())) {
    await uid.press("Enter");
    await expect(password).toBeVisible({ timeout: 30_000 });
  }
  await password.fill(person.password);
  await password.press("Enter");
  await page.waitForURL((url) => url.origin !== new URL(authentikUrl()).origin, { timeout: 60_000 });
  return { context, page };
}

test.beforeAll(async () => {
  restoreScim = (await snapshotMethod(prisma, "scim")).restore;
  restoreOidc = (await snapshotMethod(prisma, "oidc")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: { in: ["oidc", "scim"] } } });
  tokenIdsBefore = (await prisma.authScimToken.findMany({ select: { id: true } })).map((row) => row.id);
  userIdsBefore = (await prisma.user.findMany({ select: { id: true } })).map((row) => row.id);
  groupIdsBefore = (await prisma.group.findMany({ select: { id: true } })).map((row) => row.id);
});

test.afterAll(async ({ browser }) => {
  try {
    // Providers first, so deleting the users and the group pushes nothing more.
    if (created.application) await authentik("DELETE", `/core/applications/${SLUG}/`).catch(() => undefined);
    if (created.oauthPk) await authentik("DELETE", `/providers/oauth2/${created.oauthPk}/`).catch(() => undefined);
    if (created.scimPk) await authentik("DELETE", `/providers/scim/${created.scimPk}/`).catch(() => undefined);
    for (const pk of created.userPks.values()) await authentik("DELETE", `/core/users/${pk}/`).catch(() => undefined);
    if (created.groupPk) await authentik("DELETE", `/core/groups/${created.groupPk}/`).catch(() => undefined);
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "oidc").catch(() => undefined);
    await disableMethod(admin.context.request, "scim").catch(() => undefined);
    await admin.context.close();
  } finally {
    await restoreOidc?.();
    await restoreScim?.();
    await prisma.authScimToken.deleteMany({ where: { id: { notIn: tokenIdsBefore } } });
    await prisma.projectGrant.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await deleteSyntheticMcpServers(prisma, servers);
    // What SCIM pushed or the spec created on this stand: users and groups that were not here before.
    const newUsers = (await prisma.user.findMany({ select: { id: true }, where: { id: { notIn: userIdsBefore } } })).map((row) => row.id);
    await prisma.userGroup.deleteMany({ where: { userId: { in: newUsers } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: newUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: newUsers } } });
    await prisma.group.deleteMany({ where: { id: { notIn: groupIdsBefore } } });
    await prisma.$disconnect();
  }
});

test("an administrator turns SCIM on, links SCIM users to OIDC and issues a token shown once", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "scim");
  await card.getByLabel("Link SCIM users to sign-in method").selectOption("oidc");
  await saveTestActivate(page, card);
  await card.getByRole("button", { name: "Generate token" }).click();
  const issued = card.getByTestId("admin-scim-token-issued");
  scimToken = await issued.getByLabel("New SCIM token").inputValue();
  const tokenShape = /^aiqsa_scim_[A-Za-z0-9_-]{43}$/u.test(scimToken);
  expect(tokenShape).toBe(true);
  await issued.getByRole("button", { name: "Done" }).click();
  await page.screenshot({ path: testInfo.outputPath("scim-card-token-desktop.png") });
  const tokenInPage = (await page.content()).includes(scimToken);
  expect(tokenInPage).toBe(false);

  // A group the operator already has, with a grant: Authentik's group of the same name links to it.
  const group = await prisma.group.create({ data: { name: TEAM } });
  preCreatedGroupId = group.id;
  servers.push(await syntheticMcpServer(prisma, "authentik_team", group.id));
  await context.close();
  await attachEvidence(testInfo, "scim-token", { tokenInPage, tokenShape });
});

test("Authentik's SCIM provider pushes users and a group; the pre-created group keeps its grant", async ({ browser }, testInfo) => {
  test.setTimeout(420_000);
  const flows = "/flows/instances/";
  const authorizationFlow = await findOne<{ pk: string; slug: string }>(flows, "slug", "default-provider-authorization-implicit-consent");
  const invalidationFlow = await findOne<{ pk: string; slug: string }>(flows, "slug", "default-provider-invalidation-flow");
  const scopes = await Promise.all(["openid", "email", "profile"].map((scope) =>
    findOne<{ managed: string; pk: string }>("/propertymappings/provider/scope/", "managed", `goauthentik.io/providers/oauth2/scope-${scope}`)));
  const scimUserMapping = await findOne<{ managed: string; pk: string }>("/propertymappings/provider/scim/", "managed", "goauthentik.io/providers/scim/user");
  const scimGroupMapping = await findOne<{ managed: string; pk: string }>("/propertymappings/provider/scim/", "managed", "goauthentik.io/providers/scim/group");
  const signingKey = await findOne<{ name: string; pk: string }>("/crypto/certificatekeypairs/", "name", "authentik Self-signed Certificate");

  // The group first and empty: it filters which users the provider pushes.
  created.groupPk = (await authentik("POST", "/core/groups/", { is_superuser: false, name: TEAM }) as { pk: string }).pk;
  created.scimPk = (await authentik("POST", "/providers/scim/", {
    auth_mode: "token",
    exclude_users_service_account: true,
    filter_group: created.groupPk,
    name: `AIQSA SCIM ${run}`,
    property_mappings: [scimUserMapping.pk],
    property_mappings_group: [scimGroupMapping.pk],
    token: scimToken,
    url: standEnv("AIQSA_E2E_SCIM_BASE_FROM_IDP")
  }) as { pk: number }).pk;
  created.oauthPk = (await authentik("POST", "/providers/oauth2/", {
    authorization_flow: authorizationFlow.pk,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    client_type: "confidential",
    include_claims_in_id_token: true,
    invalidation_flow: invalidationFlow.pk,
    name: `AIQSA OIDC ${run}`,
    property_mappings: scopes.map((scope) => scope.pk),
    redirect_uris: [{ matching_mode: "strict", url: "http://127.0.0.1:3000/api/auth/oauth/oidc/callback" }],
    // Without a key Authentik signs ID tokens with HS256, which AIQSA refuses.
    signing_key: signingKey.pk,
    sub_mode: "hashed_user_id"
  }) as { pk: number }).pk;
  await authentik("POST", "/core/applications/", {
    backchannel_providers: [created.scimPk],
    name: `AIQSA ${run}`,
    policy_engine_mode: "any",
    provider: created.oauthPk,
    slug: SLUG
  });
  created.application = true;

  for (const person of Object.values(people)) {
    const user = await authentik("POST", "/core/users/", {
      email: person.email,
      is_active: true,
      name: person.username,
      type: "internal",
      username: person.username
    }) as { pk: number };
    created.userPks.set(person.username, user.pk);
    await authentik("POST", `/core/users/${user.pk}/set_password/`, { password: person.password });
    await authentik("POST", `/core/groups/${created.groupPk}/add_user/`, { pk: user.pk });
    await nudgeSync("user", user.pk);
  }
  await nudgeSync("group", created.groupPk);

  const pushed = await poll(async () => {
    const users = await Promise.all(Object.values(people).map(pushedUser));
    return users.every((user) => user?.scimExternalId) ? users : null;
  }, "scim_users_not_pushed");
  const linkedGroup = await poll(async () => {
    const group = await prisma.group.findUnique({ include: { users: true }, where: { id: preCreatedGroupId } });
    return group?.scimExternalId && group.users.length === 2 ? group : null;
  }, "scim_group_not_linked");
  const grantsKept = await prisma.mcpGrant.count({ where: { groupId: preCreatedGroupId } });
  expect(grantsKept).toBe(1);
  const duplicateGroups = await prisma.group.count({ where: { name: TEAM } });
  expect(duplicateGroups).toBe(1);
  expect(new Set(linkedGroup.users.map((membership) => membership.userId))).toEqual(new Set(pushed.map((user) => user!.id)));
  await attachEvidence(testInfo, "scim-push", {
    duplicateGroups,
    grantsKept,
    groupLinked: Boolean(linkedGroup.scimExternalId),
    groupMembers: linkedGroup.users.length,
    usersPushed: pushed.length
  });
});

test("a pushed user signs in through Authentik OIDC and links by email although Authentik does not verify it", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const admin = await adminSession(browser);
  await configureMethod(admin.context.request, "oidc", {
    adminGroups: [],
    allowedGroups: [],
    autoCreateUsers: false,
    autoRedirect: false,
    buttonLabel: "Authentik",
    clientId: CLIENT_ID,
    groupsClaimPath: "groups",
    groupsFrom: "id_token_then_userinfo",
    idpLogout: false,
    issuer: `${authentikUrl()}/application/o/${SLUG}/`,
    scopes: "openid email profile",
    syncGroups: true,
    trustUnverifiedEmail: false
  }, { clientSecret: { kind: "replace", value: CLIENT_SECRET } });
  await admin.context.close();

  const { context, page } = await authentikSignIn(browser, people.alex);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await context.close();
  const alex = (await pushedUser(people.alex))!;
  const identity = await prisma.authIdentity.findFirstOrThrow({
    select: { emailVerifiedAt: true, source: true },
    where: { provider: "oidc", userId: alex.id }
  });
  expect(identity.emailVerifiedAt).toBeNull();
  expect(identity.source).toBe(`${authentikUrl()}/application/o/${SLUG}/`);
  await attachEvidence(testInfo, "scim-oidc-link", { emailVerified: false, linkedToPushedAccount: true });
});

test("deactivation in Authentik revokes sessions at once; a sole Project Owner waits for an ownership transfer; reactivation", async ({ browser }, testInfo) => {
  test.setTimeout(480_000);
  // Alex: a live OIDC session in a browser.
  const alexSession = await authentikSignIn(browser, people.alex);
  await expect(alexSession.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const alex = (await pushedUser(people.alex))!;
  await authentik("PATCH", `/core/users/${created.userPks.get(people.alex.username)}/`, { is_active: false });
  await nudgeSync("user", created.userPks.get(people.alex.username)!);
  await poll(async () => (await alexSession.page.request.get("/api/me")).status() === 401, "scim_deactivation_not_applied");
  const alexDisabled = await prisma.user.findUniqueOrThrow({ select: { status: true }, where: { id: alex.id } });
  expect(alexDisabled.status).toBe("disabled");
  await alexSession.context.close();

  // Bea alone owns a Project: AIQSA answers 409, revokes her session and marks the deactivation pending.
  const bea = (await pushedUser(people.bea))!;
  const project = await prisma.project.create({
    data: { createdByDisplayName: "Authentik owner", createdByUserId: bea.id, grants: { create: [{ role: "OWNER", userId: bea.id }] }, name: `Owned by ${run}` }
  });
  projectIds.push(project.id);
  const sessionToken = randomUUID();
  await prisma.authSession.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), signInMethod: "oidc", tokenHash: hashToken(sessionToken), userId: bea.id } });
  const beaBrowser = await standContext(browser);
  await beaBrowser.addCookies([{ domain: "127.0.0.1", name: SESSION_COOKIE_NAME, path: "/", value: sessionToken }]);
  expect((await beaBrowser.request.get("/api/me")).status()).toBe(200);
  const admin = await adminSession(browser);
  await authentik("PATCH", `/core/users/${created.userPks.get(people.bea.username)}/`, { is_active: false });
  await nudgeSync("user", created.userPks.get(people.bea.username)!);
  const pending = await poll(async () => {
    const row = await prisma.user.findUniqueOrThrow({ select: { scimDeactivatedAt: true, status: true }, where: { id: bea.id } });
    return row.scimDeactivatedAt ? row : null;
  }, "scim_pending_not_marked");
  expect(pending.status).toBe("active");
  const beaSessionAfter = (await beaBrowser.request.get("/api/me")).status();
  await beaBrowser.close();
  expect(beaSessionAfter).toBe(401);
  await admin.page.goto(`/admin?section=users&resource=${encodeURIComponent(bea.id)}`);
  await expect(admin.page.getByTestId("admin-user-scim-pending")).toContainText("SCIM deactivation pending: 1 Project needs a new Owner");
  await admin.page.screenshot({ path: testInfo.outputPath("scim-authentik-pending-desktop.png") });

  // After the transfer, Authentik's retry disables her.
  const successor = await prisma.user.create({ data: { displayName: `Successor ${run}`, email: `successor-${run}@local.aiqsa.test`, status: "active" } });
  await prisma.projectGrant.create({ data: { projectId: project.id, role: "OWNER", userId: successor.id } });
  await authentik("PATCH", `/core/users/${created.userPks.get(people.bea.username)}/`, { name: `${people.bea.username} retry` });
  await nudgeSync("user", created.userPks.get(people.bea.username)!);
  await poll(async () => (await prisma.user.findUniqueOrThrow({ select: { status: true }, where: { id: bea.id } })).status === "disabled", "scim_retry_not_applied");
  await admin.page.reload();
  await expect(admin.page.getByTestId("admin-user-scim-pending")).toHaveCount(0);

  // Reactivation in Authentik re-enables the account SCIM disabled.
  await authentik("PATCH", `/core/users/${created.userPks.get(people.alex.username)}/`, { is_active: true });
  await nudgeSync("user", created.userPks.get(people.alex.username)!);
  const reactivated = await poll(async () => {
    const row = await prisma.user.findUniqueOrThrow({ select: { scimDeactivatedAt: true, status: true }, where: { id: alex.id } });
    return row.status === "active" && row.scimDeactivatedAt === null ? row : null;
  }, "scim_reactivation_not_applied");
  const again = await authentikSignIn(browser, people.alex);
  await expect(again.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await again.context.close();
  await admin.context.close();
  await attachEvidence(testInfo, "scim-lifecycle", {
    alexDisabled: alexDisabled.status === "disabled",
    beaPendingStatus: pending.status,
    beaSessionAfterPending: beaSessionAfter,
    reactivated: reactivated.status === "active",
    retryDisabled: true
  });
});
