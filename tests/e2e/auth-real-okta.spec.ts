import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  addExternalName,
  adminSession,
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
  reconfigureMethod,
  saveTestActivate,
  snapshotMethod,
  standContext,
  standEnv,
  standEnvPresent
} from "./support/realIdp";
import {
  assignPasswordOnlyPolicy,
  createOktaPeople,
  createOktaSamlApp,
  expectSignedIn,
  okta,
  OKTA_HIDDEN,
  OKTA_PREFIX,
  oktaOrigin,
  oktaSignIn,
  removeOkta,
  watchSamlResponse,
  type OktaPerson
} from "./support/okta";

/**
 * Okta (Workforce Identity, Integrator Free Plan) as a cloud OIDC and SAML IdP (opt-in).
 *
 * With AIQSA_E2E_OKTA_ORG (`https://integrator-….okta.com`) and an API token in
 * AIQSA_E2E_OKTA_TOKEN, the spec creates, with this run's suffix: groups and four synthetic
 * users (the free plan allows ten active users), an OIDC and a SAML application assigned to the
 * users' group, a password-only app sign-in policy (new apps otherwise get "Any two factors"),
 * an access policy and a `groups` claim on the `default` authorization server (it ships
 * without policies). afterAll removes all of it. The token and passwords are never printed.
 */
test.skip(!realIdpEnabled || !standEnvPresent("AIQSA_E2E_OKTA_ORG", "AIQSA_E2E_OKTA_TOKEN"), REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the generated passwords typed into Okta's sign-in widget.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const OIDC_BUTTON = "Okta";
const SAML_BUTTON = "Okta SAML";
const USERS = `${OKTA_PREFIX}users-${run}`;
const ENGINEERS = `${OKTA_PREFIX}engineers-${run}`;
const ADMINS = `${OKTA_PREFIX}admins-${run}`;
const DOMAIN = "okta.aiqsa.test";

const generatedPassword = () => `${randomBytes(15).toString("base64url")}Aa1!`;
const people = {
  ana: { email: `ana-${run}@${DOMAIN}`, groups: [USERS, ENGINEERS, ADMINS], name: "Ana", password: generatedPassword() },
  ben: { email: `ben-${run}@${DOMAIN}`, groups: [USERS, ENGINEERS], name: "Ben", password: generatedPassword() },
  // SAML-only people: an account OIDC created first would test email linking, not SAML.
  dina: { email: `dina-${run}@${DOMAIN}`, groups: [USERS, ENGINEERS, ADMINS], name: "Dina", password: generatedPassword() },
  eli: { email: `eli-${run}@${DOMAIN}`, groups: [USERS, ENGINEERS], name: "Eli", password: generatedPassword() }
} satisfies Record<string, OktaPerson>;
const emails = Object.values(people).map((person) => person.email);

const created = {
  appIds: [] as string[],
  asClaimId: "",
  asPolicyId: "",
  groupIds: new Map<string, string>(),
  policyId: "",
  userIds: [] as string[]
};
let restoreOidc: (() => Promise<void>) | null = null;
let restoreSaml: (() => Promise<void>) | null = null;
let samlAppId = "";
let groupId = "";

const issuer = () => `${oktaOrigin()}/oauth2/default`;

async function signIn(browser: Browser, button: string, person: OktaPerson): Promise<{ context: BrowserContext; facts: () => string; page: Page }> {
  const { context, page } = await loginPage(browser, "/login?local=1");
  const facts = watchSamlResponse(page);
  await page.getByRole("link", { exact: true, name: `Continue with ${button}` }).click();
  await oktaSignIn(page, person);
  return { context, facts, page };
}



async function userBy(provider: "oidc" | "saml", email: string) {
  return prisma.user.findFirst({
    include: { authIdentities: { where: { provider } } },
    where: { authIdentities: { some: { normalizedEmail: email, provider } } }
  });
}

test.beforeAll(async () => {
  restoreOidc = (await snapshotMethod(prisma, "oidc")).restore;
  restoreSaml = (await snapshotMethod(prisma, "saml")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: { in: ["oidc", "saml"] } } });
  await deleteStandUsers(prisma, emails);
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000);
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "oidc").catch(() => undefined);
    await disableMethod(admin.context.request, "saml").catch(() => undefined);
    await admin.context.close();
  } finally {
    for (const appId of created.appIds) await removeOkta("apps", appId);
    for (const userId of created.userIds) await removeOkta("users", userId);
    for (const id of created.groupIds.values()) await okta("DELETE", `/groups/${id}`).catch(() => undefined);
    if (created.policyId) await okta("DELETE", `/policies/${created.policyId}`).catch(() => undefined);
    if (created.asPolicyId) await okta("DELETE", `/authorizationServers/default/policies/${created.asPolicyId}`).catch(() => undefined);
    if (created.asClaimId) await okta("DELETE", `/authorizationServers/default/claims/${created.asClaimId}`).catch(() => undefined);
    await restoreOidc?.();
    await restoreSaml?.();
    await deleteStandUsers(prisma, emails).catch(() => undefined);
    if (groupId) await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});

test("Okta groups, users, applications and policies are created; the OIDC configuration passes Test and activates", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const { context, page } = await adminSession(browser);
  const oidcCard = await openSignInCard(page, "oidc");
  const redirectUri = await oidcCard.getByLabel("Redirect URI", { exact: true }).inputValue();
  const postLogoutUri = await oidcCard.getByLabel("Post-logout redirect URI", { exact: true }).inputValue();
  const samlCard = await openSignInCard(page, "saml");
  const acsUrl = await samlCard.getByLabel("ACS URL (Reply URL)").inputValue();
  const spEntityId = await samlCard.getByLabel("SP entity ID (Audience)").inputValue();

  const oktaPeople = await createOktaPeople([USERS, ENGINEERS, ADMINS], Object.values(people), run);
  created.groupIds = oktaPeople.groupIds;
  created.userIds.push(...oktaPeople.userIds.values());

  const oidc = await okta<{ credentials: { oauthClient: { client_id: string; client_secret: string } }; id: string }>("POST", "/apps", {
    credentials: { oauthClient: { autoKeyRotation: true, token_endpoint_auth_method: "client_secret_basic" } },
    label: `AIQSA e2e OIDC ${run}`,
    name: "oidc_client",
    visibility: OKTA_HIDDEN,
    settings: {
      oauthClient: {
        application_type: "web",
        consent_method: "TRUSTED",
        grant_types: ["authorization_code"],
        post_logout_redirect_uris: [postLogoutUri],
        redirect_uris: [redirectUri],
        response_types: ["code"]
      }
    },
    signOnMode: "OPENID_CONNECT"
  });
  created.appIds.push(oidc.id);
  const samlId = await createOktaSamlApp(`AIQSA e2e SAML ${run}`, acsUrl, spEntityId);
  created.appIds.push(samlId);
  samlAppId = samlId;
  for (const appId of created.appIds) await okta("PUT", `/apps/${appId}/groups/${created.groupIds.get(USERS)!}`, {});

  created.policyId = await assignPasswordOnlyPolicy(`AIQSA e2e ${run}`, created.appIds);

  // The default authorization server ships without an access policy and without a groups claim.
  const asPolicy = await okta<{ id: string }>("POST", "/authorizationServers/default/policies", {
    conditions: { clients: { include: [oidc.credentials.oauthClient.client_id] } },
    description: "AIQSA e2e",
    name: `AIQSA e2e ${run}`,
    priority: 1,
    status: "ACTIVE",
    type: "OAUTH_AUTHORIZATION_POLICY"
  });
  created.asPolicyId = asPolicy.id;
  await okta("POST", `/authorizationServers/default/policies/${asPolicy.id}/rules`, {
    actions: { token: { accessTokenLifetimeMinutes: 60, refreshTokenLifetimeMinutes: 0, refreshTokenWindowMinutes: 10_080 } },
    conditions: { grantTypes: { include: ["authorization_code"] }, people: { groups: { include: ["EVERYONE"] } }, scopes: { include: ["*"] } },
    name: "Authorization code",
    priority: 1,
    type: "RESOURCE_ACCESS"
  });
  const claim = await okta<{ id: string }>("POST", "/authorizationServers/default/claims", {
    alwaysIncludeInToken: true,
    claimType: "IDENTITY",
    conditions: { scopes: [] },
    group_filter_type: "REGEX",
    name: "groups",
    status: "ACTIVE",
    value: `${OKTA_PREFIX}.*`,
    valueType: "GROUPS"
  });
  created.asClaimId = claim.id;

  groupId = await createGroup(context.request, `Okta engineers ${run}`);
  await addExternalName(context.request, groupId, "oidc", ENGINEERS);
  await addExternalName(context.request, groupId, "saml", ENGINEERS);
  await configureMethod(context.request, "oidc", {
    adminGroups: [ADMINS],
    allowedGroups: [],
    autoCreateUsers: true,
    autoRedirect: false,
    buttonLabel: OIDC_BUTTON,
    clientId: oidc.credentials.oauthClient.client_id,
    groupsClaimPath: "groups",
    groupsFrom: "id_token_then_userinfo",
    idpLogout: false,
    issuer: issuer(),
    scopes: "openid email profile",
    syncGroups: true,
    trustUnverifiedEmail: false
  }, { clientSecret: { kind: "replace", value: oidc.credentials.oauthClient.client_secret } });
  await context.close();
  await attachEvidence(testInfo, "okta-setup", { applications: created.appIds.length, oidcActive: true, users: created.userIds.length });
});

test("ana signs in through Okta OIDC: the account is created, the mapped group joined and the admin group makes her admin", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const { context, page } = await signIn(browser, OIDC_BUTTON, people.ana);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("okta-oidc-signed-in-desktop.png") });
  await context.close();
  const ana = await userBy("oidc", people.ana.email);
  expect(ana, "ana's OIDC identity").toBeTruthy();
  const sync = ana!.authIdentities[0]?.lastSyncWarning ?? "none";
  const member = (await prisma.userGroup.count({ where: { groupId, userId: ana!.id } })) === 1;
  expect(member, `groups sync=${sync}`).toBe(true);
  expect(ana!.role, `groups sync=${sync}`).toBe("admin");
  expect(ana!.roleManagedBy).toBe(`oidc:${issuer()}`);
  const emailVerified = ana!.authIdentities[0]!.emailVerifiedAt !== null;

  const ben = await signIn(browser, OIDC_BUTTON, people.ben);
  await expect(ben.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await ben.context.close();
  const benUser = await userBy("oidc", people.ben.email);
  const benMember = (await prisma.userGroup.count({ where: { groupId, userId: benUser!.id } })) === 1;
  expect(benMember).toBe(true);
  expect(benUser!.role).toBe("user");
  await attachEvidence(testInfo, "okta-oidc-sign-in", { anaAdmin: true, anaMember: member, benAdmin: false, benMember, emailVerified });
});

test("an administrator pastes Okta's SAML metadata into the card; SAML sign-ins sync the groups attribute and the admin group", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const metadata = await okta<string>("GET", `/apps/${samlAppId}/sso/saml/metadata`, undefined, "application/xml");
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "saml");
  await card.getByText("Paste metadata XML instead").click();
  await card.getByLabel("IdP metadata XML").fill(metadata);
  await card.getByRole("button", { name: "Load pasted metadata" }).click();
  await expect(card.getByTestId("admin-saml-metadata-message")).toHaveAttribute("role", "status", { timeout: 30_000 });
  await card.getByLabel("Email attribute", { exact: true }).fill("email");
  await card.getByLabel("Groups attribute (optional)").fill("groups");
  await card.getByLabel("Admin groups").fill(ADMINS);
  await card.getByLabel("Sync group memberships").check();
  await card.getByLabel("Button label").fill(SAML_BUTTON);
  await saveTestActivate(page, card);
  await page.screenshot({ path: testInfo.outputPath("okta-saml-card-active-desktop.png") });
  await context.close();

  const eli = await signIn(browser, SAML_BUTTON, people.eli);
  await expectSignedIn(prisma, eli.page, "saml", eli.facts);
  await eli.context.close();
  const eliUser = await userBy("saml", people.eli.email);
  expect(eliUser, "eli's SAML identity").toBeTruthy();
  const sync = eliUser!.authIdentities[0]?.lastSyncWarning ?? "none";
  const member = (await prisma.userGroup.count({ where: { groupId, userId: eliUser!.id } })) === 1;
  expect(member, `groups sync=${sync}`).toBe(true);
  expect(eliUser!.role).toBe("user");

  const dina = await signIn(browser, SAML_BUTTON, people.dina);
  await expectSignedIn(prisma, dina.page, "saml", dina.facts);
  await dina.page.screenshot({ path: testInfo.outputPath("okta-saml-signed-in-desktop.png") });
  await dina.context.close();
  const dinaUser = await userBy("saml", people.dina.email);
  const dinaSync = dinaUser!.authIdentities[0]?.lastSyncWarning ?? "none";
  expect(dinaUser!.role, `groups sync=${dinaSync}`).toBe("admin");
  expect(dinaUser!.roleManagedBy).toMatch(/^saml:/u);
  await attachEvidence(testInfo, "okta-saml-sign-in", { dinaAdmin: true, eliMember: member, metadataPasted: true });
});

test("auto-redirect sends /login to Okta, ?local=1 stays, and signing out ends the Okta session", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const discovery = await (await fetch(`${issuer()}/.well-known/openid-configuration`)).json() as { end_session_endpoint?: string };
  const endSessionAdvertised = typeof discovery.end_session_endpoint === "string";
  expect(endSessionAdvertised, "Okta advertises RP-initiated logout").toBe(true);
  const admin = await adminSession(browser);
  await reconfigureMethod(admin.context.request, "oidc", { autoRedirect: true, idpLogout: true }, ["clientSecret"]);
  await admin.context.close();

  const local = await loginPage(browser, "/login?local=1");
  await expect(local.page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(local.page.getByRole("link", { exact: true, name: `Continue with ${OIDC_BUTTON}` })).toBeVisible();
  await local.context.close();

  const context = await standContext(browser);
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page).toHaveURL((url) => url.origin === oktaOrigin(), { timeout: 60_000 });
  await oktaSignIn(page, people.ana);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const anaId = (await userBy("oidc", people.ana.email))!.id;
  const sessionsBefore = await prisma.authSession.count({ where: { revokedAt: null, signInMethod: "oidc", userId: anaId } });

  // A click before hydration opens nothing: retry until the menu shows.
  const accountMenu = page.getByRole("menu", { name: "Account", exact: true });
  await expect(async () => {
    await page.getByRole("button", { name: "Account menu" }).first().click();
    await expect(accountMenu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await accountMenu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  // The IdP logout ends at /login, which redirects to Okta again; Okta asks for the identifier
  // once its session is gone. Where the browser stops otherwise is the finding.
  const identifier = page.locator('input[name="identifier"]');
  await expect(identifier).toBeVisible({ timeout: 60_000 }).catch(async (error: unknown) => {
    const url = new URL(page.url());
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/[^A-Za-z ]/gu, " ").replace(/\s+/gu, " ").slice(0, 200);
    throw new Error(`okta_logout_not_ended host=${url.host} path=${url.pathname} text=${text}`, { cause: error });
  });
  await page.screenshot({ path: testInfo.outputPath("okta-after-logout-desktop.png") });
  const activeSessions = await prisma.authSession.count({ where: { revokedAt: null, signInMethod: "oidc", userId: anaId } });
  expect(sessionsBefore - activeSessions).toBe(1);
  expect((await context.cookies()).some((cookie) => cookie.name === "aiqsa_session")).toBe(false);
  await context.close();
  await attachEvidence(testInfo, "okta-redirect-logout", { autoRedirect: true, endSessionAdvertised, idpAsksForIdentifierAfterLogout: true });
});
