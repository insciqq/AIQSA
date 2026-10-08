import { randomUUID } from "node:crypto";
import { PrismaClient, type AuthSignInMethodSetting } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SESSION_COOKIE_NAME } from "../../lib/server/auth/constants";
import { hashToken } from "../../lib/server/auth/token";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// SCIM is an installation singleton: the spec snapshots its sign-in setting and the existing
// tokens, configures SCIM on this disposable stand and puts the snapshot back.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const domain = `scim-e2e-${run}.example.com`;
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

let scimSnapshot: AuthSignInMethodSetting | null = null;
let existingTokenIds: string[] = [];
let token = "";
let api: APIRequestContext | null = null;

test.beforeAll(async ({ playwright }) => {
  scimSnapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "scim" } });
  existingTokenIds = (await prisma.authScimToken.findMany({ select: { id: true } })).map((row) => row.id);
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "scim" } });
  api = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
});

test.afterAll(async () => {
  await api?.dispose();
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "scim" } });
  if (scimSnapshot) {
    await prisma.authSignInMethodSetting.create({
      data: {
        ...scimSnapshot,
        activeConfig: scimSnapshot.activeConfig ?? undefined,
        draftConfig: scimSnapshot.draftConfig ?? undefined
      }
    });
  }
  await prisma.authScimToken.deleteMany({ where: { id: { notIn: existingTokenIds } } });
  await prisma.project.deleteMany({ where: { name: { contains: run } } });
  await prisma.authSession.deleteMany({ where: { user: { email: { endsWith: `@${domain}` } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  await prisma.group.deleteMany({ where: { name: { contains: run } } });
  await prisma.$disconnect();
});

function scim(method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT", path: string, body?: unknown, bearer = token) {
  return api!.fetch(`/scim/v2/${path}`, {
    data: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/scim+json" })
    },
    method
  });
}

async function openScimCard(page: Page) {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=sign-in");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Sign-in");
  const card = page.getByTestId("admin-sign-in-card-scim");
  await expect(card).toBeVisible();
  return card;
}

test("an administrator activates SCIM and issues a token shown once", async ({ page }) => {
  const card = await openScimCard(page);
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Off");
  await expect(card.getByLabel("SCIM base URL")).toHaveValue(/\/scim\/v2$/);

  await card.getByLabel("Link SCIM users to sign-in method").selectOption("oidc");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByRole("button", { name: "Activate" }).click();
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Active (admin)");

  await card.getByRole("button", { name: "Generate token" }).click();
  const issued = card.getByTestId("admin-scim-token-issued");
  token = await issued.getByLabel("New SCIM token").inputValue();
  expect(token).toMatch(/^aiqsa_scim_[A-Za-z0-9_-]{43}$/u);
  await issued.getByRole("button", { name: "Done" }).click();
  await expect(card.getByTestId("admin-scim-token")).toContainText(`${token.slice(0, 15)}…`);
  // The token never comes back: not in the page, not in the admin API, only its hash is stored.
  expect(await page.content()).not.toContain(token);
  expect(await (await page.request.get("/api/admin/sign-in/scim/tokens")).text()).not.toContain(token);
  await expect(prisma.authScimToken.count({ where: { tokenHash: hashToken(token) } })).resolves.toBe(1);
});

test("refuses missing, unknown and malformed tokens with the same 401 and bounds bodies", async () => {
  const expected = { detail: "Authentication failed.", schemas: [SCIM_ERROR], status: "401" };
  for (const bearer of ["", `aiqsa_scim_${"A".repeat(43)}`, "not-a-scim-token"]) {
    const response = await scim("GET", "Users", undefined, bearer);
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual(expected);
  }
  const tooLarge = await scim("POST", "Users", { padding: "x".repeat(300 * 1_024), userName: `big@${domain}` });
  expect(tooLarge.status()).toBe(413);
  expect((await scim("GET", "ServiceProviderConfig")).ok()).toBe(true);
});

test("provisions users and groups in Entra ID, Okta and Authentik shapes", async () => {
  const created = await scim("POST", "Users", {
    active: true,
    emails: [{ primary: true, type: "work", value: `ada@${domain}` }],
    externalId: `entra-${run}`,
    name: { familyName: "Lovelace", givenName: "Ada" },
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: `ada@${domain}`
  });
  expect(created.status()).toBe(201);
  const ada = await created.json();
  expect(ada).toMatchObject({ active: true, displayName: "Ada Lovelace", externalId: `entra-${run}`, userName: `ada@${domain}` });

  const found = await scim("GET", `Users?filter=${encodeURIComponent(`userName eq "ADA@${domain}"`)}&startIndex=1&count=10`);
  expect(await found.json()).toMatchObject({ Resources: [{ id: ada.id }], totalResults: 1 });
  expect((await scim("POST", "Users", { externalId: `other-${run}`, userName: `ada@${domain}` })).status()).toBe(409);

  const katherine = await (await scim("POST", "Users", {
    active: true,
    displayName: "Katherine Johnson",
    emails: [{ primary: true, type: "other", value: `katherine@${domain}` }],
    externalId: `authentik-${run}`,
    userName: "kjohnson"
  })).json();
  expect(katherine).toMatchObject({ userName: `katherine@${domain}` });

  const group = await scim("POST", "Groups", {
    displayName: `Compilers ${run}`,
    members: [{ display: `ada@${domain}`, value: ada.id }],
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"]
  });
  expect(group.status()).toBe(201);
  const groupId = (await group.json()).id as string;
  expect((await scim("PATCH", `Groups/${groupId}`, {
    Operations: [{ op: "Add", path: "members", value: [{ $ref: null, value: katherine.id }] }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  })).status()).toBe(204);
  expect((await scim("PATCH", `Groups/${groupId}`, {
    Operations: [{ op: "remove", path: `members[value eq "${ada.id}"]` }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  })).status()).toBe(204);
  expect(await (await scim("GET", `Groups/${groupId}`)).json()).toMatchObject({ members: [{ value: katherine.id }] });
  expect((await scim("GET", `Users/${katherine.id}`)).ok()).toBe(true);
});

test("deactivating a sole Project Owner revokes access at once and waits for an ownership transfer", async ({ page }, testInfo) => {
  const owner = await (await scim("POST", "Users", { externalId: `owner-${run}`, userName: `owner@${domain}` })).json();
  const successor = await prisma.user.create({ data: { displayName: `Successor ${run}`, email: `successor@${domain}`, status: "active" } });
  const project = await prisma.project.create({
    data: {
      createdByDisplayName: "SCIM owner",
      createdByUserId: owner.id,
      grants: { create: [{ role: "OWNER", userId: owner.id }] },
      name: `Owned by a leaver ${run}`
    }
  });
  const sessionToken = randomUUID();
  await prisma.authSession.create({
    data: { expiresAt: new Date(Date.now() + 86_400_000), tokenHash: hashToken(sessionToken), userId: owner.id }
  });
  const asOwner = { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } };
  expect((await api!.get("/api/me", asOwner)).status()).toBe(200);

  const pending = await scim("PATCH", `Users/${owner.id}`, {
    Operations: [{ op: "Replace", path: "active", value: "False" }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  });
  expect(pending.status()).toBe(409);
  expect(await pending.json()).toEqual({
    detail: "Transfer Project ownership first; the account's access is already revoked.",
    schemas: [SCIM_ERROR],
    status: "409"
  });
  expect((await api!.get("/api/me", asOwner)).status()).toBe(401);

  await signInWithLocalToken(page);
  await page.goto("/admin?section=users");
  const row = page.getByTestId("admin-user-row").filter({ hasText: `owner@${domain}` });
  await expect(row.getByTestId("admin-user-scim-pending-tag")).toHaveText("SCIM deactivation pending: 1 Project needs a new Owner");
  await page.goto(`/admin?section=users&resource=${owner.id}`);
  const marker = page.getByTestId("admin-user-scim-pending");
  await expect(marker).toContainText("SCIM deactivation pending: 1 Project needs a new Owner");
  await page.screenshot({ path: testInfo.outputPath("scim-pending-desktop.png") });

  await prisma.projectGrant.create({ data: { projectId: project.id, role: "OWNER", userId: successor.id } });
  const retried = await scim("DELETE", `Users/${owner.id}`);
  expect(retried.status()).toBe(204);
  expect(await (await scim("GET", `Users/${owner.id}`)).json()).toMatchObject({ active: false });
  await page.reload();
  await expect(page.getByTestId("admin-user-scim-pending")).toHaveCount(0);
});

for (const viewport of [
  { height: 1180, name: "tablet portrait", width: 820 },
  { height: 844, name: "phone portrait", width: 390 },
  { height: 390, name: "phone landscape", width: 844 }
] as const) {
  test(`the SCIM card fits the ${viewport.name} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    const card = await openScimCard(page);
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("button", { name: "Generate token" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    // Viewport shots: an element shot taller than the viewport drops touch emulation.
    await page.screenshot({ path: testInfo.outputPath(`scim-card-${viewport.width}x${viewport.height}.png`) });
  });
}

test("a revoked token stops working at once", async ({ page }) => {
  const card = await openScimCard(page);
  const row = card.getByTestId("admin-scim-token").filter({ hasText: token.slice(0, 15) });
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Revoke token" }).click();
  await expect(row).toHaveAttribute("data-revoked", "true");

  const refused = await scim("GET", "Users");
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toMatchObject({ status: "401" });
});
