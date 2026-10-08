import { PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import {
  addExternalName,
  adminSession,
  attachEvidence,
  createGroup,
  deleteStandUsers,
  disableMethod,
  keycloakAdmin,
  keycloakSignIn,
  keycloakUsers,
  loginPage,
  openSignInCard,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  saveTestActivate,
  snapshotMethod,
  standContext,
  standEnv,
  type KeycloakUser
} from "./support/realIdp";

/**
 * Real-IdP scenario 5: Keycloak as the SAML IdP (auth-wave-e2e-docs Scope §2.5).
 *
 * The card loads Keycloak's IdP descriptor; a sign-in maps the `groups` attribute and the admin
 * group; responses Keycloak really signed are captured from the browser's POST to `/saml/acs`
 * and then tampered with (an attribute edited, the assertion removed or duplicated) or replayed;
 * an IdP-initiated response from Keycloak's unsolicited SSO URL is refused. Keycloak's SAML
 * client gets its IdP-initiated name only for this spec.
 */
test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.describe.configure({ mode: "serial" });
// Traces would record the stand passwords typed into Keycloak's form.
// Traces would record IdP passwords; a failure screenshot shows at most a username.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const BUTTON = "Keycloak SAML";
const IDP_INITIATED_NAME = `aiqsa-e2e-${run}`;
const emails = [keycloakUsers.alice.email, keycloakUsers.dave.email];
const FAILED = /\/login\?saml=failed&local=1$/u;
let restoreSaml: (() => Promise<void>) | null = null;
let groupId = "";
let acsUrl = "";
let spEntityId = "";
/** Alice's first real response, kept for the replay. */
let captured: Record<string, string> | null = null;

type AcsPost = Record<string, string>;

test.beforeAll(async () => {
  restoreSaml = (await snapshotMethod(prisma, "saml")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "saml" } });
  await deleteStandUsers(prisma, emails);
});

test.afterAll(async ({ browser }) => {
  try {
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "saml").catch(() => undefined);
    await admin.context.close();
  } finally {
    await restoreSaml?.();
    await deleteStandUsers(prisma, emails);
    if (groupId) await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.$disconnect();
  }
});

/**
 * Starts a SAML sign-in from the login page and hands the IdP's POST to `/saml/acs` to `handle`:
 * `continue` lets it through, `abort` keeps it from AIQSA so the spec can post a variant.
 */
async function startSignIn(
  page: Page,
  user: KeycloakUser | null,
  handle: "abort" | "continue"
): Promise<AcsPost> {
  let resolve: (fields: AcsPost) => void = () => undefined;
  const posted = new Promise<AcsPost>((done) => {
    resolve = done;
  });
  await page.route("**/saml/acs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const fields = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
    resolve(fields);
    await (handle === "continue" ? route.continue() : route.abort());
  });
  try {
    await page.goto("/login?local=1");
    await page.getByRole("link", { name: `Continue with ${BUTTON}` }).click();
    // A context already signed in at Keycloak gets the response at once.
    const login = page.locator("#kc-form-login");
    const fields = await Promise.race([
      posted,
      login.waitFor({ timeout: 60_000 }).then(async () => {
        await keycloakSignIn(page, user!.username, standEnv(user!.passwordEnv));
        return posted;
      })
    ]);
    expect(typeof fields.SAMLResponse === "string" && fields.SAMLResponse.length > 0).toBe(true);
    return fields;
  } finally {
    await page.unroute("**/saml/acs");
  }
}

/** Posts fields to the ACS as an IdP page does: a cross-site, auto-submitted form. */
async function postToAcs(page: Page, fields: AcsPost) {
  await page.setContent(`<form method="post" action="${acsUrl}"></form>`);
  await page.locator("form").evaluate((form: HTMLFormElement, entries: [string, string][]) => {
    for (const [name, value] of entries) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
  }, Object.entries(fields));
  await Promise.all([page.waitForURL((url) => url.href !== "about:blank"), page.locator("form").evaluate((form: HTMLFormElement) => form.submit())]);
}

const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");
const encode = (xml: string) => Buffer.from(xml, "utf8").toString("base64");
const ASSERTION = /<((?:[A-Za-z_][\w.-]*:)?Assertion)[\s>][\s\S]*?<\/\1>/u;

/** The response variants an attacker on the wire could post; each must be refused. */
function tamperings(response: string): Array<{ name: string; xml: string }> {
  const xml = decode(response);
  const assertion = ASSERTION.exec(xml)?.[0];
  expect(Boolean(assertion), "the response carries an assertion").toBe(true);
  const emailValue = /<((?:[A-Za-z_][\w.-]*:)?AttributeValue)\b[^>]*>alice@idp\.aiqsa\.test<\/\1>/u;
  expect(emailValue.test(xml), "the assertion carries alice's email attribute").toBe(true);
  return [
    { name: "attribute_edited", xml: xml.replace(emailValue, (match) => match.replace("alice@", "mallory@")) },
    { name: "assertion_removed", xml: xml.replace(assertion!, "") },
    { name: "assertion_duplicated", xml: xml.replace(assertion!, `${assertion!}${assertion!}`) }
  ];
}

async function samlSessions(email: string): Promise<number> {
  return prisma.authSession.count({
    where: { signInMethod: "saml", user: { authIdentities: { some: { normalizedEmail: email, provider: "saml" } } } }
  });
}

async function noSession(context: BrowserContext): Promise<boolean> {
  return !(await context.cookies()).some((cookie) => cookie.name === "aiqsa_session");
}

test("an administrator loads Keycloak's descriptor into the card; Test passes and Activate turns SAML on", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const { context, page } = await adminSession(browser);
  const card = await openSignInCard(page, "saml");
  acsUrl = await card.getByLabel("ACS URL (Reply URL)").inputValue();
  spEntityId = await card.getByLabel("SP entity ID (Audience)").inputValue();
  expect(acsUrl).toMatch(/\/saml\/acs$/u);
  const descriptor = standEnv("AIQSA_E2E_KEYCLOAK_SAML_DESCRIPTOR");
  await card.getByLabel("Load from IdP metadata URL").fill(descriptor);
  await card.getByTestId("admin-saml-metadata-import").getByRole("button", { name: "Load", exact: true }).click();
  await expect(card.getByTestId("admin-saml-metadata-message")).toHaveAttribute("role", "status", { timeout: 30_000 });
  await expect(card.getByLabel("IdP entity ID")).toHaveValue(standEnv("AIQSA_E2E_KEYCLOAK_ISSUER"));
  await expect(card.getByLabel("IdP sign-in URL (HTTP-Redirect)")).toHaveValue(`${standEnv("AIQSA_E2E_KEYCLOAK_ISSUER")}/protocol/saml`);
  await card.getByLabel("Display name attribute (optional)").fill("displayName");
  await card.getByLabel("Groups attribute (optional)").fill("groups");
  await card.getByLabel("Admin groups").fill("admins");
  await card.getByLabel("Sync group memberships").check();
  await card.getByLabel("Button label").fill(BUTTON);
  await saveTestActivate(page, card);
  await page.screenshot({ path: testInfo.outputPath("saml-card-keycloak-active-desktop.png") });

  groupId = await createGroup(context.request, `SAML engineers ${run}`);
  await addExternalName(context.request, groupId, "saml", "engineers");
  await context.close();
  await attachEvidence(testInfo, "saml-configured", { metadataLoaded: true, spEntityIdIsMetadataUrl: spEntityId.endsWith("/saml/metadata") });
});

test("alice and dave sign in through Keycloak SAML with the groups attribute and the admin group", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const context = await standContext(browser);
  const page = await context.newPage();
  captured = await startSignIn(page, keycloakUsers.alice, "continue");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await context.close();
  const alice = await prisma.user.findFirstOrThrow({
    include: { authIdentities: { where: { provider: "saml" } } },
    where: { authIdentities: { some: { normalizedEmail: keycloakUsers.alice.email, provider: "saml" } } }
  });
  expect(alice.authIdentities[0]!.source).toBe(standEnv("AIQSA_E2E_KEYCLOAK_ISSUER"));
  const aliceMember = (await prisma.userGroup.count({ where: { groupId, userId: alice.id } })) === 1;
  expect(aliceMember).toBe(true);
  expect(alice.role).toBe("user");

  const daveContext = await standContext(browser);
  const davePage = await daveContext.newPage();
  const daveResponse = decode((await startSignIn(davePage, keycloakUsers.dave, "continue")).SAMLResponse!);
  await expect(davePage.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await daveContext.close();
  const dave = await prisma.user.findFirstOrThrow({
    where: { authIdentities: { some: { normalizedEmail: keycloakUsers.dave.email, provider: "saml" } } }
  });
  const daveSync = await prisma.authIdentity.findFirst({ select: { lastSyncWarning: true }, where: { provider: "saml", userId: dave.id } });
  const samlSetting = await prisma.authSignInMethodSetting.findUnique({ select: { activeConfig: true }, where: { method: "saml" } });
  const adminGroupCount = ((samlSetting?.activeConfig as { adminGroups?: unknown[] } | null)?.adminGroups ?? []).length;
  // Content-free facts about Keycloak's real response: attribute names and whether "admins" is a value.
  const attributeNames = [...daveResponse.matchAll(/<(?:[\w.-]+:)?Attribute\b[^>]*\bName="([A-Za-z]+)"/gu)].map((match) => match[1]).join(",");
  const adminsValue = /<(?:[\w.-]+:)?AttributeValue\b[^>]*>admins<\//u.test(daveResponse);
  expect(dave.role, `sync=${daveSync?.lastSyncWarning ?? "none"} adminGroups=${adminGroupCount} attributes=${attributeNames} adminsValue=${adminsValue}`).toBe("admin");
  expect(dave.roleManagedBy).toBe(`saml:${standEnv("AIQSA_E2E_KEYCLOAK_ISSUER")}`);
  await attachEvidence(testInfo, "saml-sign-in", { aliceMember, aliceSessions: await samlSessions(keycloakUsers.alice.email), daveAdmin: true });
});

test("a replayed response, tampered responses and an IdP-initiated response sign nobody in", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const before = await samlSessions(keycloakUsers.alice.email);
  const outcomes: Record<string, boolean> = {};

  // The response alice's browser already used, posted again from another browser.
  const replayContext = await standContext(browser);
  const replay = await replayContext.newPage();
  await postToAcs(replay, captured!);
  await expect(replay).toHaveURL(FAILED, { timeout: 30_000 });
  outcomes.replayed = await noSession(replayContext);
  await replay.screenshot({ path: testInfo.outputPath("saml-login-failed-desktop.png") });
  await replayContext.close();

  // One browser holds alice's Keycloak session; each variant answers a sign-in it started.
  const context = await standContext(browser);
  const page = await context.newPage();
  for (const [index, variant] of ["attribute_edited", "assertion_removed", "assertion_duplicated"].entries()) {
    const fields = await startSignIn(page, keycloakUsers.alice, "abort");
    const tampered = tamperings(fields.SAMLResponse!)[index]!;
    expect(tampered.name).toBe(variant);
    await postToAcs(page, { ...fields, SAMLResponse: encode(tampered.xml) });
    await expect(page).toHaveURL(FAILED, { timeout: 30_000 });
    outcomes[variant] = await noSession(context);
  }

  // IdP-initiated SSO: Keycloak posts an unsolicited response for the client.
  const keycloak = keycloakAdmin();
  const client = await keycloak.client(spEntityId);
  const attributes = { ...(client.attributes as Record<string, string> | undefined) };
  await keycloak.updateClient({ ...client, attributes: { ...attributes, saml_idp_initiated_sso_url_name: IDP_INITIATED_NAME } });
  try {
    await page.goto(`${standEnv("AIQSA_E2E_KEYCLOAK_ISSUER")}/protocol/saml/clients/${IDP_INITIATED_NAME}`);
    await expect(page).toHaveURL(FAILED, { timeout: 60_000 });
    outcomes.idp_initiated = await noSession(context);
  } finally {
    await keycloak.updateClient({ ...client, attributes });
  }
  await context.close();

  for (const [name, refused] of Object.entries(outcomes)) expect(refused, name).toBe(true);
  const after = await samlSessions(keycloakUsers.alice.email);
  expect(after).toBe(before);
  await attachEvidence(testInfo, "saml-refusals", { ...outcomes, sessionsAdded: after - before });
});

for (const viewport of [
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 1180, name: "tablet-portrait", width: 820 }
] as const) {
  test(`the SAML button fits the ${viewport.name} viewport`, async ({ browser }, testInfo) => {
    const login = await loginPage(browser, "/login", { hasTouch: true, viewport: { height: viewport.height, width: viewport.width } });
    await expect(login.page.getByRole("link", { name: `Continue with ${BUTTON}` })).toBeVisible();
    await expectNoHorizontalOverflow(login.page);
    await login.page.screenshot({ path: testInfo.outputPath(`saml-keycloak-login-${viewport.name}.png`) });
    await login.context.close();
  });
}
