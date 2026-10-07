import { PrismaClient, type UsagePurpose } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { decodeUserUsageLimitStatusResponse } from "../../lib/contracts/usageLimits";
import { authenticateWithLocalToken } from "./support/localAuth";
import { runAccountMenuAction } from "./shell/page";

/**
 * What a user with limits sees: the composer warning near and at a limit,
 * the Settings block, and refused sends that keep the draft. The signed-in
 * test account gets an override; synthetic spend is tagged by model id and
 * removed afterwards. The answer model is the stand's fake provider.
 */
const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });

const FIXTURE_MODEL = "usage-limits-e2e";
let userId = "";

async function signIn(page: Page, theme: "dark" | "light", baseURL: string): Promise<void> {
  await page.context().addCookies([{ name: "aiqsa.theme", url: baseURL, value: theme }]);
  await authenticateWithLocalToken(page.request);
  userId = (await (await page.request.get("/api/me")).json()).user.id as string;
}

async function setOverride(page: Page, limits: Readonly<{ budget: number | null; hour: number | null }>): Promise<void> {
  // Saves name the version they replace; a first save names none.
  const saved = await prisma.usageLimit.findUnique({ select: { version: true }, where: { userId } });
  const response = await page.request.put(`/api/admin/usage-limits/users/${userId}`, { data: {
    exempt: false, messagesPerDay: null, messagesPerHour: limits.hour, monthlyBudgetMicros: limits.budget,
    ...(saved ? { expectedVersion: saved.version } : {})
  } });
  expect(response.ok()).toBe(true);
}

/** Replaces the synthetic month spend; `purpose` picks personal (default) or system usage. */
async function setSpend(micros: number, purpose: UsagePurpose = "chat_answer"): Promise<void> {
  await prisma.usageEvent.deleteMany({ where: { modelId: FIXTURE_MODEL, userId } });
  if (micros > 0) {
    await prisma.usageEvent.create({ data: {
      estimatedCostMicros: micros, inputTokens: 1_000, modelId: FIXTURE_MODEL, outputTokens: 100, provider: "openai",
      purpose, totalTokens: 1_100, usageCompleteness: "COMPLETE", userId
    } });
  }
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 0.5;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      // Content inside a visually hidden clip or a local horizontal scroller cannot widen the page.
      .filter((element) => {
        if (element.closest(".sr-only") || element.getBoundingClientRect().right <= limit) return false;
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX !== "visible" && parent.getBoundingClientRect().right <= limit) return false;
        }
        return true;
      })
      .slice(0, 12)
      .map((element) => `${element.tagName.toLowerCase()}${element.dataset.testid ? `[${element.dataset.testid}]` : ""}` +
        ` .${String(element.className).slice(0, 80)} right=${Math.round(element.getBoundingClientRect().right)}`);
  });
  expect(overflowing, "elements beyond the viewport's right edge").toEqual([]);
}

test.afterAll(async () => {
  if (userId) {
    await prisma.usageEvent.deleteMany({ where: { modelId: FIXTURE_MODEL, userId } });
    await prisma.usageLimit.deleteMany({ where: { userId } });
    await prisma.usageMessageAdmission.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "phone-portrait", width: 390, height: 844 }
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`composer warning and Settings block ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await signIn(page, theme, testInfo.project.use.baseURL!);
      await setOverride(page, { budget: 1_000_000, hour: null });
      await setSpend(850_000);
      await page.goto("/");
      await expect(page.getByTestId("app-shell")).toBeVisible();
      const notice = page.getByTestId("composer-usage-limit");
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute("data-tone", "caution");
      await page.screenshot({ path: testInfo.outputPath("01-composer-caution.png") });

      await setSpend(1_050_000);
      await page.reload();
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute("data-tone", "critical");
      await page.screenshot({ path: testInfo.outputPath("02-composer-critical.png") });
      await expectNoPageOverflow(page);

      await runAccountMenuAction(page, "Settings");
      await page.getByTestId("settings-v2").getByRole("button", { name: "Account", exact: true }).click();
      const block = page.getByTestId("settings-usage-limits");
      await block.scrollIntoViewIfNeeded();
      await expect(block).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("03-settings.png") });
    });
  }
}

test("a reached budget refuses the send, explains the reset and keeps the draft", async ({ page }, testInfo) => {
  await signIn(page, "light", testInfo.project.use.baseURL!);
  await setOverride(page, { budget: 1_000_000, hour: null });
  await setSpend(1_050_000);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Summarise yesterday's notes, please.");
  const refused = page.waitForResponse((response) => /\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST");
  await composer.press("Enter");
  const response = await refused;
  expect(response.status()).toBe(429);
  expect(Number(response.headers()["retry-after"])).toBeGreaterThan(0);
  const body = await response.json() as { error: string; usageLimit: { window: string } };
  expect(body).toMatchObject({ error: "usage_budget_exhausted", usageLimit: { scope: "user", window: "month" } });
  await expect(page.getByText(/monthly (AI )?budget/i).first()).toBeVisible();
  await expect(composer).toHaveValue("Summarise yesterday's notes, please.");
  await page.screenshot({ path: testInfo.outputPath("budget-refusal.png") });
});

test("system usage above the budget neither warns nor refuses the user", async ({ page }, testInfo) => {
  await signIn(page, "light", testInfo.project.use.baseURL!);
  await prisma.usageMessageAdmission.deleteMany({ where: { userId } });
  await setOverride(page, { budget: 1_000_000, hour: null });
  // Memory work far beyond the personal budget: it fills only the shared cap.
  await setSpend(5_000_000, "memory_processing");
  const status = decodeUserUsageLimitStatusResponse(await (await page.request.get("/api/me/usage-limits")).json());
  expect(status?.usageLimits.monthSpentMicros).toBeLessThan(1_000_000);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("composer-usage-limit")).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("A question while Memory work is expensive.");
  const accepted = page.waitForResponse((response) => /\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST");
  await composer.press("Enter");
  // Usage limits are checked before preparation, so any outcome other than a
  // usage-limit refusal means the budget let the send through.
  const response = await accepted;
  const body = await response.text();
  await testInfo.attach("system-usage-send.json", { body: JSON.stringify({ body: body.slice(0, 400), status: response.status() }),
    contentType: "application/json" });
  expect(response.status(), body).not.toBe(429);
  expect(body).not.toMatch(/usage_budget_exhausted|installation_budget_exhausted|message_rate_limited/u);
  await expect(page.getByTestId("composer-usage-limit")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("system-usage-admitted.png") });
});

test("a message limit admits up to the limit, then refuses with the time it frees", async ({ page }, testInfo) => {
  await signIn(page, "light", testInfo.project.use.baseURL!);
  await setSpend(0);
  await prisma.usageMessageAdmission.deleteMany({ where: { userId } });
  await setOverride(page, { budget: null, hour: 1 });
  // One message admitted this hour. Real runs counting toward the limit are
  // covered by the stateful admission tests and the paid budgets scenario; the
  // stand's fake model cannot fit a composer turn with tools in its context.
  await prisma.usageMessageAdmission.create({ data: { createdAt: new Date(Date.now() - 60_000), userId } });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(page.getByTestId("composer-usage-limit")).toHaveAttribute("data-tone", "critical", { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("rate-after-first.png") });
  await composer.fill("Second question.");
  const refused = page.waitForResponse((response) => /\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST");
  await composer.press("Enter");
  const response = await refused;
  expect(response.status()).toBe(429);
  expect(await response.json()).toMatchObject({ error: "message_rate_limited", usageLimit: { limit: 1, used: 1, window: "hour" } });
  await expect(composer).toHaveValue("Second question.");
  await page.screenshot({ path: testInfo.outputPath("rate-refusal.png") });
});
