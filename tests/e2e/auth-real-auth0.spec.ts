import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  addExternalName,
  adminSession,
  alert,
  attachEvidence,
  configureMethod,
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
  standEnv,
  standEnvPresent
} from "./support/realIdp";

/**
 * Auth0 as a cloud OIDC and SAML IdP (opt-in; needs a disposable Auth0 tenant).
 *
 * With AIQSA_E2E_AUTH0_DOMAIN and a Management API token in AIQSA_E2E_AUTH0_TOKEN, the spec
 * creates its own OIDC and SAML applications, a post-login Action that puts each user's
 * `app_metadata.aiqsa_groups` into the ID token's `groups` claim and the SAML `groups`
 * attribute, and synthetic database users, all named with this run's suffix; afterAll removes
 * them and restores the post-login bindings. The tenant's outbound calls need the stand's egress.
 * The token and the generated passwords are never printed, attached or asserted by value.
 */
test.skip(!realIdpEnabled || !standEnvPresent("AIQSA_E2E_AUTH0_DOMAIN", "AIQSA_E2E_AUTH0_TOKEN"), REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the generated passwords typed into Auth0's login form.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const OIDC_BUTTON = "Auth0";
const SAML_BUTTON = "Auth0 SAML";
const ENGINEERS = `engineers-${run}`;
const ADMINS = `admins-${run}`;
const DOMAIN = "auth0.aiqsa.test";

type Person = Readonly<{ email: string; groups: readonly string[]; name: string; password: string; verified: boolean }>;

const generatedPassword = () => `${randomBytes(15).toString("base64url")}Aa1!`;
const people = {
  ana: { email: `ana-${run}@${DOMAIN}`, groups: [ENGINEERS, ADMINS], name: `Ana ${run}`, password: generatedPassword(), verified: true },
  ben: { email: `ben-${run}@${DOMAIN}`, groups: [ENGINEERS], name: `Ben ${run}`, password: generatedPassword(), verified: true },
  cleo: { email: `cleo-${run}@${DOMAIN}`, groups: [], name: `Cleo ${run}`, password: generatedPassword(), verified: false },
  // SAML-only people: an account OIDC created first would test email linking, not SAML.
  dina: { email: `dina-${run}@${DOMAIN}`, groups: [ENGINEERS, ADMINS], name: `Dina ${run}`, password: generatedPassword(), verified: true },
  eli: { email: `eli-${run}@${DOMAIN}`, groups: [ENGINEERS], name: `Eli ${run}`, password: generatedPassword(), verified: true }
} satisfies Record<string, Person>;
const emails = Object.values(people).map((person) => person.email);

const created = {
  actionId: "",
  bindings: null as null | Array<{ ref: { type: "binding_id"; value: string } }>,
  clientIds: [] as string[],
  userIds: [] as string[]
};
let restoreOidc: (() => Promise<void>) | null = null;
let restoreSaml: (() => Promise<void>) | null = null;
let oidcClient = { id: "", secret: "" };
let samlClientId = "";
let groupId = "";
let cleoLocalId = "";

const auth0Origin = () => `https://${standEnv("AIQSA_E2E_AUTH0_DOMAIN")}`;
const issuer = () => `${auth0Origin()}/`;

/** The Management API; failures name only the method, path and status, never the token. */
async function auth0<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${auth0Origin()}/api/v2${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${standEnv("AIQSA_E2E_AUTH0_TOKEN")}`, "content-type": "application/json" },
    method
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { errorCode?: string; message?: string };
    const reason = `${detail.errorCode ?? ""} ${(detail.message ?? "").replace(/[^A-Za-z0-9 .,:_-]/gu, "").slice(0, 160)}`;
    throw new Error(`auth0 ${method} ${path.split("?")[0]} -> ${response.status} ${reason}`);
  }
  return response.status === 204 ? ({} as T) : await response.json() as T;
}

async function enableDatabaseConnection(clientIds: readonly string[]): Promise<void> {
  const [connection] = await auth0<Array<{ id: string }>>("GET", "/connections?strategy=auth0&name=Username-Password-Authentication");
  expect(connection, "the tenant's Username-Password-Authentication connection").toBeTruthy();
  try {
    await auth0("PATCH", `/connections/${connection!.id}/clients`, clientIds.map((clientId) => ({ client_id: clientId, status: true })));
  } catch {
    // Tenants without the per-client endpoint still take the connection's enabled_clients list.
    const current = await auth0<{ enabled_clients?: string[] }>("GET", `/connections/${connection!.id}?fields=enabled_clients`);
    await auth0("PATCH", `/connections/${connection!.id}`, { enabled_clients: [...new Set([...(current.enabled_clients ?? []), ...clientIds])] });
  }
}

async function createUser(person: Person): Promise<void> {
  const user = await auth0<{ user_id: string }>("POST", "/users", {
    app_metadata: { aiqsa_groups: person.groups },
    connection: "Username-Password-Authentication",
    email: person.email,
    email_verified: person.verified,
    name: person.name,
    password: person.password,
    verify_email: false
  });
  created.userIds.push(user.user_id);
}

/** A post-login Action scoped to this run's applications; deployed and bound after the existing bindings. */
async function bindGroupsAction(clientIds: readonly string[]): Promise<void> {
  const code = [
    `const CLIENTS = new Set(${JSON.stringify(clientIds)});`,
    "exports.onExecutePostLogin = async (event, api) => {",
    "  if (!CLIENTS.has(event.client.client_id)) return;",
    "  const groups = (event.user.app_metadata || {}).aiqsa_groups;",
    "  if (!Array.isArray(groups)) return;",
    "  api.idToken.setCustomClaim('groups', groups);",
    "  if (event.transaction && event.transaction.protocol === 'samlp') api.samlResponse.setAttribute('groups', groups);",
    "};"
  ].join("\n");
  const action = await auth0<{ id: string }>("POST", "/actions/actions", {
    code,
    name: `aiqsa-e2e-groups-${run}`,
    supported_triggers: [{ id: "post-login", version: "v3" }]
  });
  created.actionId = action.id;
  await expect.poll(async () => (await auth0<{ status: string }>("GET", `/actions/actions/${action.id}`)).status, { timeout: 120_000 }).toBe("built");
  await auth0("POST", `/actions/actions/${action.id}/deploy`);
  const current = await auth0<{ bindings: Array<{ id: string }> }>("GET", "/actions/triggers/post-login/bindings");
  created.bindings = current.bindings.map((binding) => ({ ref: { type: "binding_id" as const, value: binding.id } }));
  await auth0("PATCH", "/actions/triggers/post-login/bindings", {
    bindings: [...created.bindings, { display_name: `aiqsa-e2e-groups-${run}`, ref: { type: "action_id", value: action.id } }]
  });
}

/**
 * Auth0's Universal Login: email and password (on one page or two), then the consent Auth0
 * always asks for loopback redirect URIs. Waits until the browser leaves Auth0.
 */
async function auth0SignIn(page: Page, person: Person): Promise<void> {
  const username = page.locator('input[name="username"]');
  await expect(username).toBeVisible({ timeout: 60_000 });
  await username.fill(person.email);
  const password = page.locator('input[name="password"]');
  if (!(await password.isVisible())) {
    await page.locator('button[type="submit"][name="action"]').first().click();
    await expect(password).toBeVisible({ timeout: 30_000 });
  }
  await password.fill(person.password);
  await page.locator('button[type="submit"][name="action"]').first().click();
  const consent = page.locator('button[type="submit"][value="accept"]');
  const left = () => new URL(page.url()).origin !== auth0Origin();
  await expect.poll(async () => left() || await consent.isVisible(), { timeout: 60_000 }).toBe(true);
  if (!left()) await consent.click();
  await page.waitForURL((url) => url.origin !== auth0Origin(), { timeout: 60_000 }).catch(async (error: unknown) => {
    // Content-free: where the browser stopped and Auth0's own error text, reduced to words.
    const message = (await page.locator('[id*="error"], .ulp-input-error-message, [data-error-code]').allInnerTexts().catch(() => []))
      .join(" ").replace(/[^A-Za-z ]/gu, "").slice(0, 160);
    throw new Error(`auth0_login_not_left path=${new URL(page.url()).pathname} error=${message || "-"}`, { cause: error });
  });
}

async function signIn(browser: Browser, button: string, person: Person): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await loginPage(browser, "/login?local=1");
  await page.getByRole("link", { name: `Continue with ${button}` }).click();
  await auth0SignIn(page, person);
  return { context, page };
}

async function userBy(provider: "oidc" | "saml", email: string) {
  return prisma.user.findFirst({
    include: { authIdentities: { where: { provider } } },
    where: { authIdentities: { some: { normalizedEmail: email, provider } } }
  });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  restoreOidc = (await snapshotMethod(prisma, "oidc")).restore;
  restoreSaml = (await snapshotMethod(prisma, "saml")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: { in: ["oidc", "saml"] } } });
  await deleteStandUsers(prisma, emails);
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(240_000);
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "oidc").catch(() => undefined);
    await disableMethod(admin.context.request, "saml").catch(() => undefined);
    await admin.context.close();
  } finally {
    if (created.bindings) await auth0("PATCH", "/actions/triggers/post-login/bindings", { bindings: created.bindings }).catch(() => undefined);
    if (created.actionId) await auth0("DELETE", `/actions/actions/${created.actionId}?force=true`).catch(() => undefined);
    for (const userId of created.userIds) await auth0("DELETE", `/users/${encodeURIComponent(userId)}`).catch(() => undefined);
    for (const clientId of created.clientIds) await auth0("DELETE", `/clients/${clientId}`).catch(() => undefined);
    await restoreOidc?.();
    await restoreSaml?.();
    await deleteStandUsers(prisma, emails).catch(() => undefined);
    if (cleoLocalId) await prisma.user.deleteMany({ where: { id: cleoLocalId } }).catch(() => undefined);
    if (groupId) await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});

test("Auth0 applications, users and the groups Action are created; the OIDC configuration passes Test and activates", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const { context, page } = await adminSession(browser);
  // The redirect values the cards show are what Auth0 must allow.
  const oidcCard = await openSignInCard(page, "oidc");
  const redirectUri = await oidcCard.getByLabel("Redirect URI").inputValue();
  const postLogoutUri = await oidcCard.getByLabel("Post-logout redirect URI").inputValue();
  const samlCard = await openSignInCard(page, "saml");
  const acsUrl = await samlCard.getByLabel("ACS URL (Reply URL)").inputValue();
  const spEntityId = await samlCard.getByLabel("SP entity ID (Audience)").inputValue();

  const oidc = await auth0<{ client_id: string; client_secret: string }>("POST", "/clients", {
    allowed_logout_urls: [postLogoutUri],
    app_type: "regular_web",
    callbacks: [redirectUri],
    grant_types: ["authorization_code"],
    is_first_party: true,
    jwt_configuration: { alg: "RS256" },
    name: `AIQSA e2e OIDC ${run}`,
    oidc_conformant: true,
    token_endpoint_auth_method: "client_secret_basic"
  });
  created.clientIds.push(oidc.client_id);
  oidcClient = { id: oidc.client_id, secret: oidc.client_secret };
  const saml = await auth0<{ client_id: string }>("POST", "/clients", {
    addons: {
      samlp: {
        audience: spEntityId,
        destination: acsUrl,
        digestAlgorithm: "sha256",
        mappings: { email: "email", name: "displayName" },
        nameIdentifierFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        recipient: acsUrl,
        signatureAlgorithm: "rsa-sha256",
        signResponse: false
      }
    },
    app_type: "regular_web",
    callbacks: [acsUrl],
    is_first_party: true,
    name: `AIQSA e2e SAML ${run}`
  });
  created.clientIds.push(saml.client_id);
  samlClientId = saml.client_id;
  await enableDatabaseConnection(created.clientIds);
  for (const person of Object.values(people)) await createUser(person);
  await bindGroupsAction(created.clientIds);

  groupId = await createGroup(context.request, `Auth0 engineers ${run}`);
  await addExternalName(context.request, groupId, "oidc", ENGINEERS);
  await addExternalName(context.request, groupId, "saml", ENGINEERS);
  await configureMethod(context.request, "oidc", {
    adminGroups: [ADMINS],
    allowedGroups: [],
    autoCreateUsers: true,
    autoRedirect: false,
    buttonLabel: OIDC_BUTTON,
    clientId: oidcClient.id,
    groupsClaimPath: "groups",
    groupsFrom: "id_token_then_userinfo",
    idpLogout: false,
    issuer: issuer(),
    scopes: "openid email profile",
    syncGroups: true,
    trustUnverifiedEmail: false
  }, { clientSecret: { kind: "replace", value: oidcClient.secret } });
  await context.close();
  await attachEvidence(testInfo, "auth0-setup", { applications: created.clientIds.length, oidcActive: true, users: created.userIds.length });
});

test("ana signs in through Auth0 OIDC: the account is created, the mapped group joined and the admin group makes her admin", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const { context, page } = await signIn(browser, OIDC_BUTTON, people.ana);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("auth0-oidc-signed-in-desktop.png") });
  await context.close();
  const ana = await userBy("oidc", people.ana.email);
  expect(ana, "ana's OIDC identity").toBeTruthy();
  const sync = ana!.authIdentities[0]?.lastSyncWarning ?? "none";
  const member = (await prisma.userGroup.count({ where: { groupId, userId: ana!.id } })) === 1;
  expect(member, `groups sync=${sync}`).toBe(true);
  expect(ana!.role, `groups sync=${sync}`).toBe("admin");
  expect(ana!.roleManagedBy).toBe(`oidc:${issuer()}`);
  expect(ana!.authIdentities[0]!.emailVerifiedAt).not.toBeNull();

  const ben = await signIn(browser, OIDC_BUTTON, people.ben);
  await expect(ben.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await ben.context.close();
  const benUser = await userBy("oidc", people.ben.email);
  const benMember = (await prisma.userGroup.count({ where: { groupId, userId: benUser!.id } })) === 1;
  expect(benMember).toBe(true);
  expect(benUser!.role).toBe("user");
  await attachEvidence(testInfo, "auth0-oidc-sign-in", { anaAdmin: true, anaMember: member, benAdmin: false, benMember });
});

test("an unverified Auth0 email does not link to an existing local account", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const local = await prisma.user.create({ data: { displayName: `Cleo local ${run}`, email: people.cleo.email, status: "active" } });
  cleoLocalId = local.id;
  const { context, page } = await signIn(browser, OIDC_BUTTON, people.cleo);
  await expect(page).toHaveURL(/\/login\?oauth=account_conflict&provider=oidc/u, { timeout: 60_000 });
  await expect(alert(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("auth0-oidc-account-conflict-desktop.png") });
  await context.close();
  const linked = await prisma.authIdentity.count({ where: { provider: "oidc", userId: local.id } });
  expect(linked).toBe(0);
  await attachEvidence(testInfo, "auth0-oidc-email-link", { linked, refusedCode: "account_conflict" });
});

test("an administrator loads Auth0's SAML metadata into the card; SAML sign-ins sync the groups attribute and the admin group", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "saml");
  await card.getByLabel("Load from IdP metadata URL").fill(`${auth0Origin()}/samlp/metadata/${samlClientId}`);
  await card.getByTestId("admin-saml-metadata-import").getByRole("button", { name: "Load", exact: true }).click();
  await expect(card.getByTestId("admin-saml-metadata-message")).toHaveAttribute("role", "status", { timeout: 30_000 });
  await card.getByLabel("Email attribute").fill("email");
  await card.getByLabel("Display name attribute (optional)").fill("displayName");
  await card.getByLabel("Groups attribute (optional)").fill("groups");
  await card.getByLabel("Admin groups").fill(ADMINS);
  await card.getByLabel("Sync group memberships").check();
  await card.getByLabel("Button label").fill(SAML_BUTTON);
  await saveTestActivate(page, card);
  await page.screenshot({ path: testInfo.outputPath("auth0-saml-card-active-desktop.png") });
  await context.close();

  const eli = await signIn(browser, SAML_BUTTON, people.eli);
  await expect(eli.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await eli.context.close();
  const eliUser = await userBy("saml", people.eli.email);
  expect(eliUser, "eli's SAML identity").toBeTruthy();
  const sync = eliUser!.authIdentities[0]?.lastSyncWarning ?? "none";
  const member = (await prisma.userGroup.count({ where: { groupId, userId: eliUser!.id } })) === 1;
  expect(member, `groups sync=${sync}`).toBe(true);
  expect(eliUser!.role).toBe("user");

  const dina = await signIn(browser, SAML_BUTTON, people.dina);
  await expect(dina.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await dina.page.screenshot({ path: testInfo.outputPath("auth0-saml-signed-in-desktop.png") });
  await dina.context.close();
  const dinaUser = await userBy("saml", people.dina.email);
  const dinaSync = dinaUser!.authIdentities[0]?.lastSyncWarning ?? "none";
  expect(dinaUser!.role, `groups sync=${dinaSync}`).toBe("admin");
  expect(dinaUser!.roleManagedBy).toMatch(/^saml:/u);
  await attachEvidence(testInfo, "auth0-saml-sign-in", { dinaAdmin: true, eliMember: member, metadataLoaded: true });
});
