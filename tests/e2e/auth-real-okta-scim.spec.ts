import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  adminSession,
  attachEvidence,
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
import {
  assignPasswordOnlyPolicy,
  createOktaPeople,
  createOktaSamlApp,
  expectSignedIn,
  okta,
  OKTA_PREFIX,
  oktaSignIn,
  removeOkta,
  watchSamlResponse,
  type OktaPerson
} from "./support/okta";

/**
 * Okta SCIM provisioning into AIQSA (opt-in, interactive).
 *
 * Okta pushes over the internet, so the stand is reachable through a temporary public URL
 * (AIQSA_E2E_PUBLIC_URL). Okta's API cannot configure SCIM on a custom app, so an Okta
 * administrator does it by hand while the spec waits: the spec writes the SCIM base URL and a
 * token of this disposable stand to AIQSA_E2E_HANDOFF_FILE, then waits up to
 * AIQSA_E2E_OPERATOR_WAIT_MINUTES (default 45) for the app's provisioning features and for the
 * pushed group. Okta objects carry this run's suffix and are removed in afterAll.
 */
test.skip(
  !realIdpEnabled || !standEnvPresent("AIQSA_E2E_OKTA_ORG", "AIQSA_E2E_OKTA_TOKEN", "AIQSA_E2E_PUBLIC_URL", "AIQSA_E2E_HANDOFF_FILE"),
  REAL_IDP_SKIP_REASON
);
test.describe.configure({ mode: "serial" });
// Traces would record the generated passwords typed into Okta's sign-in widget.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const SAML_BUTTON = "Okta SAML";
const USERS = `${OKTA_PREFIX}users-${run}`;
const TEAM = `${OKTA_PREFIX}team-${run}`;
const DOMAIN = "okta.aiqsa.test";
const WAIT_MS = Number(process.env.AIQSA_E2E_OPERATOR_WAIT_MINUTES ?? "45") * 60_000;

const generatedPassword = () => `${randomBytes(15).toString("base64url")}Aa1!`;
const people = {
  pia: { email: `pia-${run}@${DOMAIN}`, groups: [USERS, TEAM], name: "Pia", password: generatedPassword() },
  quinn: { email: `quinn-${run}@${DOMAIN}`, groups: [USERS, TEAM], name: "Quinn", password: generatedPassword() }
} satisfies Record<string, OktaPerson>;

const created = { appId: "", groupIds: new Map<string, string>(), policyId: "", userIds: new Map<string, string>() };
let restoreSaml: (() => Promise<void>) | null = null;
let restoreScim: (() => Promise<void>) | null = null;
let tokenIdsBefore: string[] = [];
let userIdsBefore: string[] = [];
let groupIdsBefore: string[] = [];

async function poll<T>(probe: () => Promise<T | null>, code: string, timeout = 300_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(code);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function pushedUser(person: OktaPerson) {
  return prisma.user.findUnique({ where: { email: person.email } });
}

async function samlSignIn(browser: Browser, person: OktaPerson): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await loginPage(browser, "/login?local=1");
  const facts = watchSamlResponse(page);
  await page.getByRole("link", { exact: true, name: `Continue with ${SAML_BUTTON}` }).click();
  await oktaSignIn(page, person);
  await expectSignedIn(prisma, page, "saml", facts);
  return { context, page };
}

test.beforeAll(async () => {
  restoreSaml = (await snapshotMethod(prisma, "saml")).restore;
  restoreScim = (await snapshotMethod(prisma, "scim")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: { in: ["saml", "scim"] } } });
  tokenIdsBefore = (await prisma.authScimToken.findMany({ select: { id: true } })).map((row) => row.id);
  userIdsBefore = (await prisma.user.findMany({ select: { id: true } })).map((row) => row.id);
  groupIdsBefore = (await prisma.group.findMany({ select: { id: true } })).map((row) => row.id);
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000);
  try {
    // The app first, so deleting the users and groups pushes nothing more.
    if (created.appId) await removeOkta("apps", created.appId);
    for (const userId of created.userIds.values()) await removeOkta("users", userId);
    for (const id of created.groupIds.values()) await okta("DELETE", `/groups/${id}`).catch(() => undefined);
    if (created.policyId) await okta("DELETE", `/policies/${created.policyId}`).catch(() => undefined);
    const admin = await adminSession(browser);
    await disableMethod(admin.context.request, "scim").catch(() => undefined);
    await disableMethod(admin.context.request, "saml").catch(() => undefined);
    await admin.context.close();
  } finally {
    writeFileSync(standEnv("AIQSA_E2E_HANDOFF_FILE"), "", { mode: 0o600 });
    await restoreSaml?.();
    await restoreScim?.();
    await prisma.authScimToken.deleteMany({ where: { id: { notIn: tokenIdsBefore } } });
    const newUsers = (await prisma.user.findMany({ select: { id: true }, where: { id: { notIn: userIdsBefore } } })).map((row) => row.id);
    await prisma.userGroup.deleteMany({ where: { userId: { in: newUsers } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: newUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: newUsers } } });
    await prisma.group.deleteMany({ where: { id: { notIn: groupIdsBefore } } });
    await prisma.$disconnect();
  }
});

test("SAML from Okta's metadata, SCIM linked to SAML with a token; the operator receives the SCIM URL and token", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const { context, page } = await adminSession(browser);
  const samlCard = await openSignInCard(page, "saml");
  const acsUrl = await samlCard.getByLabel("ACS URL (Reply URL)").inputValue();
  const spEntityId = await samlCard.getByLabel("SP entity ID (Audience)").inputValue();

  const oktaPeople = await createOktaPeople([USERS, TEAM], Object.values(people), run);
  created.groupIds = oktaPeople.groupIds;
  created.userIds = oktaPeople.userIds;
  created.appId = await createOktaSamlApp(`AIQSA e2e SCIM ${run}`, acsUrl, spEntityId);
  created.policyId = await assignPasswordOnlyPolicy(`AIQSA e2e SCIM ${run}`, [created.appId]);

  const metadata = await okta<string>("GET", `/apps/${created.appId}/sso/saml/metadata`, undefined, "application/xml");
  await samlCard.getByText("Paste metadata XML instead").click();
  await samlCard.getByLabel("IdP metadata XML").fill(metadata);
  await samlCard.getByRole("button", { name: "Load pasted metadata" }).click();
  await expect(samlCard.getByTestId("admin-saml-metadata-message")).toHaveAttribute("role", "status", { timeout: 30_000 });
  await samlCard.getByLabel("Email attribute", { exact: true }).fill("email");
  await samlCard.getByLabel("Button label").fill(SAML_BUTTON);
  // SCIM owns the groups here; SAML only signs people in.
  await saveTestActivate(page, samlCard);

  const scimCard = await openSignInCard(page, "scim");
  await scimCard.getByLabel("Link SCIM users to sign-in method").selectOption("saml");
  await saveTestActivate(page, scimCard);
  await scimCard.getByRole("button", { name: "Generate token" }).click();
  const issued = scimCard.getByTestId("admin-scim-token-issued");
  const token = await issued.getByLabel("New SCIM token").inputValue();
  await issued.getByRole("button", { name: "Done" }).click();
  await context.close();
  // Through the public URL, as Okta will call it: proves the tunnel and compiles the SCIM routes.
  const reached = await poll(async () => {
    const response = await fetch(new URL("/scim/v2/ServiceProviderConfig", standEnv("AIQSA_E2E_PUBLIC_URL")), {
      headers: { authorization: `Bearer ${token}` }
    }).catch(() => null);
    return response?.status === 200 ? true : null;
  }, "scim_public_url_unreachable", 180_000);
  for (const resource of ["Users", "Groups"]) {
    await fetch(new URL(`/scim/v2/${resource}?count=1`, standEnv("AIQSA_E2E_PUBLIC_URL")), { headers: { authorization: `Bearer ${token}` } });
  }

  // This disposable stand's token goes to the Okta administrator; it dies with the stand.
  writeFileSync(standEnv("AIQSA_E2E_HANDOFF_FILE"), [
    `SCIM connector base URL: ${new URL("/scim/v2", standEnv("AIQSA_E2E_PUBLIC_URL")).toString()}`,
    `Authorization header: Bearer ${token}`,
    `Okta app: AIQSA e2e SCIM ${run}`,
    `Group to push: ${TEAM}`,
    ""
  ].join("\n"), { mode: 0o600 });
  await attachEvidence(testInfo, "okta-scim-setup", { publicUrlReached: reached, samlActive: true, scimActive: true, tokenShape: /^aiqsa_scim_[A-Za-z0-9_-]{43}$/u.test(token) });
});

test("the operator turns provisioning on; Okta pushes the assigned users and the pushed group", async ({}, testInfo) => {
  test.setTimeout(WAIT_MS + 600_000);
  const features = await poll(async () => {
    const app = await okta<{ features?: string[] }>("GET", `/apps/${created.appId}`);
    return app.features?.includes("PUSH_NEW_USERS") ? app.features : null;
  }, "okta_provisioning_not_enabled", WAIT_MS);
  // Assigned after provisioning is on, so Okta creates them in AIQSA.
  await okta("PUT", `/apps/${created.appId}/groups/${created.groupIds.get(USERS)!}`, {});
  const pushed = await poll(async () => {
    const users = await Promise.all(Object.values(people).map(pushedUser));
    return users.every((user) => user?.scimExternalId) ? users : null;
  }, "scim_users_not_pushed");
  const group = await poll(async () => {
    const row = await prisma.group.findFirst({ include: { users: true }, where: { name: TEAM } });
    return row?.scimExternalId && row.users.length === 2 ? row : null;
  }, "scim_group_not_pushed", WAIT_MS);
  expect(new Set(group.users.map((membership) => membership.userId))).toEqual(new Set(pushed.map((user) => user!.id)));
  await attachEvidence(testInfo, "okta-scim-push", {
    deactivationPush: features.includes("PUSH_USER_DEACTIVATION"),
    groupMembers: group.users.length,
    groupPushed: Boolean(group.scimExternalId),
    profilePush: features.includes("PUSH_PROFILE_UPDATES"),
    usersPushed: pushed.length
  });
});

test("a pushed user signs in through Okta SAML and links to the pushed account by email", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const before = await pushedUser(people.pia);
  const { context } = await samlSignIn(browser, people.pia);
  await context.close();
  const identity = await prisma.authIdentity.findFirstOrThrow({ select: { userId: true }, where: { normalizedEmail: people.pia.email, provider: "saml" } });
  expect(identity.userId).toBe(before!.id);
  const accounts = await prisma.user.count({ where: { email: people.pia.email } });
  expect(accounts).toBe(1);
  await attachEvidence(testInfo, "okta-scim-saml-link", { accounts, linkedToPushedAccount: true });
});

test("a profile update and a deactivation in Okta reach AIQSA; the deactivated user's session ends", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const quinnId = created.userIds.get(people.quinn.email)!;
  const renamed = `Quinn${run}`;
  await okta("POST", `/users/${quinnId}`, { profile: { firstName: renamed } });
  const updated = await poll(async () => {
    const row = await pushedUser(people.quinn);
    return row?.displayName.includes(renamed) ? row : null;
  }, "scim_profile_update_not_pushed");

  const { context, page } = await samlSignIn(browser, people.pia);
  const piaId = (await pushedUser(people.pia))!.id;
  await okta("POST", `/users/${created.userIds.get(people.pia.email)!}/lifecycle/deactivate`);
  await poll(async () => (await page.request.get("/api/me")).status() === 401 ? true : null, "scim_deactivation_not_applied");
  const pia = await prisma.user.findUniqueOrThrow({ select: { status: true }, where: { id: piaId } });
  expect(pia.status).toBe("disabled");
  await context.close();
  await attachEvidence(testInfo, "okta-scim-update-deactivate", { deactivated: true, profileUpdated: Boolean(updated) });
});
