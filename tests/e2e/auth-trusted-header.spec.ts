import { randomUUID } from "node:crypto";
import { PrismaClient, type AuthSignInMethodSetting } from "@prisma/client";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// The trusted-header method row is an installation singleton: the spec snapshots it, changes it
// on this disposable stand and puts the snapshot back. Which path runs depends on the stand's
// client identity mode, an environment setting the spec reads from the admin probe: outside
// trusted-proxy mode it proves the refusal; in it, the sign-in itself with a header the spec
// sets in place of the proxy. The real proxy in front belongs to the wave's E2E task.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const run = randomUUID().slice(0, 8);
const domain = `trusted-header-e2e-${run}.example.com`;
const FIRST = `first@${domain}`;
const SECOND = `second@${domain}`;
// In trusted-proxy mode the app identifies clients by the proxy's forwarded address.
const FORWARDED = { "X-Forwarded-For": "203.0.113.10" };

let snapshot: AuthSignInMethodSetting | null = null;

test.beforeAll(async () => {
  snapshot = await prisma.authSignInMethodSetting.findUnique({ where: { method: "trusted_header" } });
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "trusted_header" } });
});

test.afterAll(async () => {
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "trusted_header" } });
  if (snapshot) {
    await prisma.authSignInMethodSetting.create({
      data: { ...snapshot, activeConfig: snapshot.activeConfig ?? undefined, draftConfig: snapshot.draftConfig ?? undefined }
    });
  }
  await prisma.user.deleteMany({ where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  await prisma.$disconnect();
});

async function openCard(page: Page) {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=sign-in");
  const card = page.getByTestId("admin-sign-in-section").getByTestId("admin-sign-in-card-trusted_header");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("trusted-header-mode")).toHaveAttribute("data-mode", /.+/);
  return card;
}

async function proxiedPage(browser: Browser, email: string | null) {
  const context = await browser.newContext({
    extraHTTPHeaders: { ...FORWARDED, ...(email ? { "X-Auth-Request-Email": email, "X-Auth-Request-Groups": "staff" } : {}) }
  });
  return { context, page: await context.newPage() };
}

test("trusted-header sign-in follows the client identity mode", async ({ browser }) => {
  const admin = await browser.newContext({ extraHTTPHeaders: FORWARDED });
  const page = await admin.newPage();
  const card = await openCard(page);
  const mode = await card.getByTestId("trusted-header-mode").getAttribute("data-mode");

  await card.getByRole("button", { name: "oauth2-proxy" }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("The saved settings are not active yet.")).toBeVisible();
  await card.getByRole("button", { name: "Test" }).click();

  if (mode !== "trusted_proxy") {
    await expect(card.getByTestId("admin-sign-in-test")).toContainText("Test failed");
    await expect(card.getByRole("button", { name: "Activate" })).toBeDisabled();
    const overview = await (await page.request.get("/api/admin/sign-in")).json() as {
      methods: { active: { version: number }; draft: { version: number }; method: string }[];
    };
    const state = overview.methods.find((entry) => entry.method === "trusted_header")!;
    const activation = await page.request.post("/api/admin/sign-in/methods/trusted_header", {
      data: { action: "activate", expectedActiveVersion: state.active.version, expectedDraftVersion: state.draft.version }
    });
    expect(activation.status()).toBe(409);

    // A client sending the header itself signs no one in.
    const proxied = await proxiedPage(browser, FIRST);
    const response = await proxied.page.request.get("/api/auth/trusted-header?next=%2F", { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(new URL(response.headers().location!).searchParams.get("trusted_header")).toBe("unavailable");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    await proxied.page.goto("/login");
    await expect(proxied.page).toHaveURL(/\/login$/);
    await expect(proxied.page.getByTestId("trusted-header-sign-in")).toHaveCount(0);
    await expect(prisma.user.count({ where: { email: FIRST } })).resolves.toBe(0);
    await proxied.context.close();
    await admin.close();
    return;
  }

  await expect(card.getByTestId("admin-sign-in-test")).toContainText("Test passed");
  await card.getByRole("button", { name: "Activate" }).click();
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Active (admin)");

  // The login page sends a visitor without a session through the proxy's identity.
  const first = await proxiedPage(browser, FIRST);
  await first.page.goto("/login?next=%2F");
  await expect(first.page.getByTestId("app-shell")).toBeVisible();
  const firstUser = await prisma.user.findUniqueOrThrow({ where: { email: FIRST } });
  await expect(prisma.authSession.count({ where: { revokedAt: null, signInMethod: "trusted_header", userId: firstUser.id } }))
    .resolves.toBe(1);

  // ?local=1 keeps the other methods reachable.
  const local = await proxiedPage(browser, FIRST);
  await local.page.goto("/login?local=1");
  await expect(local.page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(local.page.getByRole("link", { name: "Continue with your proxy sign-in" })).toBeVisible();
  await expectNoHorizontalOverflow(local.page);
  await local.context.close();

  // Another identity in the same browser replaces the session.
  await first.context.setExtraHTTPHeaders({ ...FORWARDED, "X-Auth-Request-Email": SECOND });
  await first.page.goto("/api/auth/trusted-header?next=%2F");
  await expect(first.page.getByTestId("app-shell")).toBeVisible();
  await expect(prisma.authSession.findFirst({
    select: { revokedReason: true },
    where: { userId: firstUser.id }
  })).resolves.toEqual({ revokedReason: "trusted_header_replaced" });
  await expect(prisma.user.count({ where: { email: SECOND } })).resolves.toBe(1);
  await first.context.close();

  // No header, or an oversized one, signs no one in and says why.
  const missing = await proxiedPage(browser, null);
  await missing.page.goto("/login");
  await expect(missing.page).toHaveURL(/trusted_header=missing/);
  await expect(missing.page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("did not provide an identity");
  await missing.context.close();
  const oversized = await proxiedPage(browser, `${"a".repeat(320)}@${domain}`);
  await oversized.page.goto("/login");
  await expect(oversized.page).toHaveURL(/trusted_header=invalid/);
  await oversized.context.close();

  await card.getByRole("button", { name: "Disable" }).click();
  await page.getByTestId("admin-confirm-sign-in-disable").getByRole("button", { name: "Disable" }).click();
  await expect(card.getByTestId("admin-sign-in-status")).toHaveText("Off");
  await admin.close();
});

for (const viewport of [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1180, name: "tablet portrait", width: 820 },
  { height: 844, name: "phone portrait", width: 390 }
] as const) {
  test(`the trusted-header card fits the ${viewport.name} viewport`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: FORWARDED,
      viewport: { height: viewport.height, width: viewport.width }
    });
    const page = await context.newPage();
    const card = await openCard(page);
    await card.getByTestId("trusted-header-mode").scrollIntoViewIfNeeded();
    await expect(card.getByLabel("Email header")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`trusted-header-${viewport.width}x${viewport.height}.png`) });
    await context.close();
  });
}
