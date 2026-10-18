/**
 * Browser checks and screenshots of the prod-1018 sweep's user-visible
 * changes on any disposable stand, without providers or paid calls:
 *
 * - The login page's refused-password message names the external sign-in
 *   buttons the page offers (Google here), and stays the plain message on a
 *   password-only page. Google is configured through the admin API with a
 *   synthetic client (its test checks formats only) and the installation's
 *   Google row and sign-in switches are put back afterwards.
 * - The Users page's "Refused sign-ins" block shows synthetic journal rows
 *   (seeded through Prisma: an email nobody has an account with, an email of
 *   an existing account, a password refusal of an account, no verified email,
 *   the daily overflow) with plain-language reasons, and Invite opens the
 *   existing Invite sheet with that email.
 * - Admin Search "Add source" offers the DeepSeek Search API on a seeded
 *   DeepSeek connection with a stored key and an enabled model; nothing is
 *   saved, so DeepSeek is never called.
 *
 * Screenshots are viewport shots (never element shots taller than the
 * viewport) at desktop 1440×900, tablet 834×1194 and 1194×834, phone 390×844
 * and 844×390 in the light theme, plus desktop dark, written to the test
 * output directory for review. Synthetic data only; every seeded row is
 * removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import { captureState, type CaptureSize } from "./support/capture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { createPeopleFixture, type PeopleFixture } from "./support/people";
import { configureMethod, disableMethod, signInMethodState, snapshotMethod, snapshotPolicy } from "./support/realIdp";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority } from "../support/providerExecutionAuthority";

test.describe.configure({ mode: "serial" });

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const LIGHT_SIZES: readonly CaptureSize[] = [
  { height: 900, width: 1440 },
  { height: 1194, width: 834 },
  { height: 834, width: 1194 },
  { height: 844, width: 390 },
  { height: 390, width: 844 }
];
const DESKTOP: readonly CaptureSize[] = [{ height: 900, width: 1440 }];

/** Light at every size, then dark at desktop; each size also asserts no page-wide horizontal overflow. */
async function shots(page: Page, testInfo: TestInfo, name: string, anchor: Locator): Promise<void> {
  const atEachSize = async () => {
    await expect(anchor).toBeVisible();
    await expectNoHorizontalOverflow(page);
  };
  await captureState(page, testInfo, name, { anchor, atEachSize, sizes: LIGHT_SIZES, themes: ["light"] });
  await captureState(page, testInfo, name, { anchor, atEachSize, sizes: DESKTOP, themes: ["dark"] });
}

// ------------------------------------------------------------------ Login ---

const UNAUTHORIZED = "The credentials were not accepted.";

/** The hint the login page adds for its own "Continue with …" buttons (AuthLogin.tsx). */
function expectedHint(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return `If you usually sign in with ${labels[0]}, use the ${labels[0]} button below.`;
  return `If you usually sign in with ${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}, use that button below.`;
}

/** Opens /login signed out and submits a wrong password for an existing account; returns the alert and the offered methods. */
async function refusedPasswordSignIn(browser: Browser, email: string) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3000", viewport: { height: 900, width: 1440 } });
  const page = await context.newPage();
  await page.goto("/login");
  const form = page.locator('form[data-hydrated="true"]');
  await expect(form).toBeVisible({ timeout: 60_000 });
  const links = page.getByRole("link", { name: /^Continue with / });
  const labels = (await links.allTextContents()).map((text) => text.replace(/^.*?Continue with\s*/su, "").trim());
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password", { exact: true }).fill(`Wrong-${randomUUID()}`);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  const alert = page.locator("#login-feedback[role=alert]");
  await expect(alert).toContainText("(unauthorized)", { timeout: 30_000 });
  return { alert, context, labels, page };
}

test.describe("login refusal hint", () => {
  let people: PeopleFixture | null = null;
  let restoreGoogle: (() => Promise<void>) | null = null;
  let restorePolicy: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    restoreGoogle = (await snapshotMethod(db(), "google")).restore;
    restorePolicy = (await snapshotPolicy(db())).restore;
    // Password sign-in on, as a deployment with Google beside it has it.
    await db().authSignInPolicy.upsert({
      create: { id: "installation", passwordLoginEnabled: true, registrationEnabled: false },
      update: { passwordLoginEnabled: true, version: { increment: 1 } },
      where: { id: "installation" }
    });
    people = createPeopleFixture(db());
  });

  test.afterAll(async () => {
    await people?.cleanup().catch(() => undefined);
    await restoreGoogle?.().catch(() => undefined);
    await restorePolicy?.().catch(() => undefined);
  });

  test("a password-only page refuses a wrong password with the plain message", async ({ browser, request }, testInfo) => {
    test.setTimeout(300_000);
    await authenticateWithLocalToken(request);
    await disableMethod(request, "google");
    const user = await people!.user("Login baseline");
    const { alert, context, labels, page } = await refusedPasswordSignIn(browser, user.email);
    try {
      // An environment-configured Google or Yandex client cannot be switched off from here.
      test.skip(labels.length > 0, "the stand offers an environment-configured external sign-in method");
      await expect(alert).toHaveText(`${UNAUTHORIZED} (unauthorized)`);
      await expect(alert).not.toContainText("If you usually sign in");
      await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await shots(page, testInfo, "login-password-only-refused", alert);
    } finally {
      await context.close();
    }
  });

  test("with Google offered, a wrong password names the Google button", async ({ browser, request }, testInfo) => {
    test.setTimeout(300_000);
    await authenticateWithLocalToken(request);
    const run = randomUUID().slice(0, 8);
    // The Google test checks formats only; nothing reaches Google.
    await configureMethod(request, "google", { clientId: `${run}-e2e.apps.googleusercontent.com` },
      { clientSecret: { kind: "replace", value: `GOCSPX-e2e-${run}-write-only` } });
    expect((await signInMethodState(request, "google")).status).toBe("active_admin");
    const user = await people!.user("Login hint");
    const { alert, context, labels, page } = await refusedPasswordSignIn(browser, user.email);
    try {
      expect(labels, "the page offers Google").toContain("Google");
      await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
      await expect(alert).toHaveText(`${UNAUTHORIZED} ${expectedHint(labels)} (unauthorized)`);
      await expect(alert).toContainText("Google");
      await shots(page, testInfo, "login-google-hint-refused", alert);
    } finally {
      await context.close();
    }
  });
});

// ------------------------------------------------------- Refused sign-ins ---

type SeededRefusal = Readonly<{ id: string }>;

test("the Users page lists refused sign-ins in plain words, and Invite opens the Invite sheet with the email", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const people = createPeopleFixture(db());
  const seeded: SeededRefusal[] = [];
  const suffix = randomUUID().slice(0, 8);
  const refusedEmail = `refused-${suffix}@example.com`;
  try {
    const known = await people.user("Refused known");
    const passwordAccount = await people.user("Refused password");
    const now = Date.now();
    const day = new Date(new Date(now).toISOString().slice(0, 10));
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    const rows = [
      { attempts: 2, code: "not_allowed", email: refusedEmail, method: "google", subjectKey: `email:${refusedEmail}`, userId: null },
      { attempts: 1, code: "account_pending", email: known.email, method: "yandex", subjectKey: `email:${known.email}`, userId: null },
      { attempts: 4, code: "invalid_credentials", email: null, method: "password", subjectKey: `user:${passwordAccount.id}`,
        userId: passwordAccount.id },
      { attempts: 3, code: "email_missing", email: null, method: "oidc", subjectKey: "no_verified_email", userId: null },
      { attempts: 13, code: "not_allowed", email: null, method: "google", subjectKey: "overflow", userId: null }
    ] as const;
    for (const [index, row] of rows.entries()) {
      seeded.push(await db().signInRefusal.create({ select: { id: true }, data: {
        ...row, day, firstSeenAt: at(30 + index), lastSeenAt: at(index + 1)
      } }));
    }

    await authenticateWithLocalToken(page.request);
    await page.goto("/admin?section=users", { timeout: 120_000 });
    await expect(page.getByTestId("admin-section-users")).toBeVisible({ timeout: 60_000 });
    const block = page.getByTestId("admin-sign-in-refusals");
    await expect(block.getByRole("heading", { name: /^Refused sign-ins · \d+$/u })).toBeVisible({ timeout: 30_000 });
    const more = block.getByRole("button", { name: /^Show \d+ more$/u });
    if (await more.isVisible().catch(() => false)) await more.click();
    const refusal = (text: string) => block.getByTestId("admin-sign-in-refusal").filter({ hasText: text });

    const invitable = refusal(refusedEmail);
    await expect(invitable).toHaveAttribute("data-subject", "email");
    await expect(invitable).toContainText("Google · Not allowed to sign in · 2 attempts");
    await expect(invitable.getByRole("button", { name: `Invite ${refusedEmail}` })).toBeEnabled();
    await expect(invitable.getByRole("link", { name: /^Open user/u })).toHaveCount(0);

    const existing = refusal(known.displayName);
    await expect(existing).toHaveAttribute("data-subject", "email");
    await expect(existing).toContainText(`${known.email} · Yandex · Account awaits approval · 1 attempt`);
    await expect(existing.getByRole("link", { name: `Open user ${known.displayName}` })).toBeVisible();
    await expect(existing.getByRole("button", { name: /^Invite /u })).toHaveCount(0);

    const password = refusal(passwordAccount.displayName);
    await expect(password).toHaveAttribute("data-subject", "account");
    await expect(password).toContainText(`${passwordAccount.email} · Password · Wrong password · 4 attempts`);
    await expect(password.getByRole("link", { name: `Open user ${passwordAccount.displayName}` })).toBeVisible();

    const unverified = refusal("OIDC · The provider sent no email · 3 attempts");
    await expect(unverified).toHaveAttribute("data-subject", "no_verified_email");
    await expect(unverified).toContainText("No verified email");
    await expect(unverified.getByRole("button")).toHaveCount(0);
    await expect(unverified.getByRole("link")).toHaveCount(0);

    const overflow = refusal("Google · Not allowed to sign in · 13 attempts");
    await expect(overflow).toHaveAttribute("data-subject", "overflow");
    await expect(overflow).toContainText("More attempts (daily limit reached)");
    await expect(overflow.getByRole("button")).toHaveCount(0);

    await expect(block).toContainText("Kept for 30 days.");
    await shots(page, testInfo, "admin-refused-sign-ins", invitable);

    await invitable.getByRole("button", { name: `Invite ${refusedEmail}` }).click();
    const sheet = page.getByRole("dialog", { name: "Invite" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel("Email", { exact: true })).toHaveValue(refusedEmail);
    await expect(sheet.getByRole("button", { name: "Create invite" })).toBeEnabled();
    await shots(page, testInfo, "admin-refused-sign-ins-invite-sheet", sheet.getByLabel("Email", { exact: true }));
    // A prefilled email is not an edit: Cancel closes without a discard question, and nothing was invited.
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
    expect(await db().authInvite.count({ where: { normalizedEmail: refusedEmail } })).toBe(0);

    await password.getByRole("link", { name: `Open user ${passwordAccount.displayName}` }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]resource=${passwordAccount.id}(?:&|$)`, "u"));
  } finally {
    await db().signInRefusal.deleteMany({ where: { id: { in: seeded.map((row) => row.id) } } }).catch(() => undefined);
    await people.cleanup().catch(() => undefined);
  }
});

// ------------------------------------------------------- Search source ---

test("Admin Search Add source offers the DeepSeek Search API on a DeepSeek connection", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const suffix = randomUUID().slice(0, 8);
  // A DeepSeek-family connection with a stored (synthetic) key on an unresolvable host and one
  // enabled DeepSeek answer model; nothing is saved, so no request leaves the stand.
  const authority = await createTestProviderExecutionAuthority(db(), "e2e-deepseek-search-api");
  const connectionName = `E2E DeepSeek ${suffix}`;
  const modelName = `E2E DeepSeek model ${suffix}`;
  const configuration = {
    adapterKind: "deepseek_responses_native",
    answerSelectable: true,
    capabilities: { contextWindow: 65_536, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false,
      streaming: true, toolCalling: true, vision: false },
    defaultParams: {},
    modelClass: "answer",
    upstreamModelId: `e2e-deepseek-${suffix}`
  };
  try {
    await db().providerConnection.update({ data: { displayName: connectionName, family: "deepseek" }, where: { id: authority.connectionId } });
    await db().providerModel.update({ data: {
      activeConfig: configuration, capabilities: configuration.capabilities, displayName: modelName, draftConfig: configuration,
      modelId: configuration.upstreamModelId, provider: "deepseek"
    }, where: { id: authority.providerModelId } });

    await authenticateWithLocalToken(page.request);
    await page.goto("/admin?section=search", { timeout: 120_000 });
    const add = page.getByTestId("search-add");
    await expect(add).toBeEnabled({ timeout: 60_000 });
    await add.click();
    const sheet = page.getByRole("dialog", { name: "Add source" });
    await expect(sheet).toBeVisible();
    const optionLabel = `${connectionName} Search API · key via ${modelName}`;
    // The select's accessible name also carries its selected option, so it is found by its label.
    const searchModel = sheet.locator("label").filter({ has: page.locator("span", { hasText: /^Search model$/u }) }).locator("select");
    // Synthetic names only: which Search model choices the admin catalog offers, for a failed lookup.
    const offered = (await (await page.request.get("/api/admin/search")).json() as { search?: { providerModels?: Array<{
      connectionDisplayName: string; displayName: string; enabled: boolean; searchKind: string }> } }).search?.providerModels ?? [];
    testInfo.annotations.push({ description: JSON.stringify(offered.map((model) => ({ connection: model.connectionDisplayName,
      enabled: model.enabled, kind: model.searchKind, model: model.displayName }))), type: "search-models-offered" });
    console.log(`search-models-offered ${JSON.stringify(offered.map((model) => [model.searchKind, model.enabled, model.connectionDisplayName === connectionName]))}`);
    // The option names the connection's key source; its model part follows the catalog's model name.
    const option = searchModel.locator("option", { hasText: `${connectionName} Search API · key via ` });
    await expect(option, `the offered choice (${optionLabel})`).toHaveCount(1);
    await searchModel.selectOption({ label: (await option.textContent())!.trim() });
    await expect(sheet).toContainText("Searches with the DeepSeek Search API using this connection's key; the model itself is never called.");
    await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue(`${connectionName} Search API`);
    await sheet.getByText("Advanced Search execution", { exact: true }).click();
    const maxRequests = sheet.getByLabel("Maximum requests to this source per answer");
    await maxRequests.fill("1");
    await expect(maxRequests).toHaveValue("1");
    await expect(sheet.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(sheet).toContainText("Runs one small check first (paid request).");
    await shots(page, testInfo, "admin-search-add-deepseek-search-api", searchModel);
    // Not saved: Save would run a real DeepSeek search.
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = page.getByRole("button", { name: /^Discard/u }).first();
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await expect(sheet).toHaveCount(0);
    expect(await db().searchOption.count({ where: { kind: "deepseek_search_api", displayName: `${connectionName} Search API` } })).toBe(0);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await deleteTestProviderExecutionAuthority(db(), authority).catch(() => undefined);
  }
});
