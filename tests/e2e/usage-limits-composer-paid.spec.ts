/**
 * Opt-in, paid, bounded browser check of usage limits on a real model: the
 * composer with a codex-lb answer model (CODEX_LB_API_KEY, CODEX_LB_BASE_URL,
 * custom setup as in the budgets scenario) on a DISPOSABLE stand. Never a
 * default lane: it runs only with AIQSA_BUDGETS_PAID_E2E=DISPOSABLE.
 *
 * With a limit of one message per hour the first composer send completes,
 * the composer then warns at the limit, and the second send is refused with
 * the reason while the draft stays. A budget below the month's spend then
 * refuses the same draft with the budget reason. Exactly one turn is paid
 * for. Screenshots are taken at desktop and phone width.
 *
 * Oracles are HTTP status codes, refusal codes, the stand's database and the
 * visible reason, never the model's wording; the summary holds codes and
 * booleans only. The administrator's override, admissions and chat defaults
 * are restored afterwards; the codex-lb connection stays on the stand.
 */
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type Response } from "@playwright/test";
import { decodeUserUsageLimitStatusResponse } from "../../lib/contracts/usageLimits";
import { selectModel } from "./shell/composer";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { paidEnv, PAID_TURN_TIMEOUT_MS, pollUntil, setupCodexLbAnswerModel } from "./support/paidProviders";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_BUDGETS_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_BUDGETS_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.afterAll(() => prisma.$disconnect());

const MESSAGES_PATH = /^\/api\/chats\/([^/]+)\/messages$/u;
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];

function nextSend(page: Page): Promise<Response> {
  return page.waitForResponse((response) => MESSAGES_PATH.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST", { timeout: PAID_TURN_TIMEOUT_MS });
}

async function setOverride(page: Page, userId: string, limits: Readonly<{ budget: number | null; hour: number | null }>): Promise<void> {
  // Saves name the version they replace; a first save names none.
  const saved = await prisma.usageLimit.findUnique({ select: { version: true }, where: { userId } });
  const response = await page.request.put(`/api/admin/usage-limits/users/${userId}`, { data: {
    exempt: false, messagesPerDay: null, messagesPerHour: limits.hour, monthlyBudgetMicros: limits.budget,
    ...(saved ? { expectedVersion: saved.version } : {})
  } });
  expect(response.ok(), `the override is saved (${response.status()})`).toBe(true);
}

/** Desktop and phone captures of the current state; the phone layout must not overflow. */
async function captureBothWidths(page: Page, name: string, outputPath: (name: string) => string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.screenshot({ path: outputPath(`${name}-desktop.png`) });
  await page.setViewportSize(PHONE);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: outputPath(`${name}-phone.png`) });
  await page.setViewportSize(DESKTOP);
}

test("a real composer turn counts toward the message limit; the limit and a budget refuse the next send and keep the draft", async ({ page }, testInfo) => {
  test.setTimeout(1_800_000);
  await page.setViewportSize(DESKTOP);
  await authenticateWithLocalToken(page.request);
  const userId = (await (await page.request.get("/api/me")).json()).user.id as string;
  const restoreDefaults = await snapshotComposerDefaults(prisma, userId);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  try {
    await prisma.usageLimit.deleteMany({ where: { userId } });
    await prisma.usageMessageAdmission.deleteMany({ where: { userId } });
    const model = await setupCodexLbAnswerModel(page.request, { label: "Composer limits", nativeSearch: false });
    summary.answerModel = model.upstreamModelId;
    await setOverride(page, userId, { budget: null, hour: 1 });

    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await selectModel(page, model.connectionId, model.displayName);
    await expect(page.getByTestId("header-model-trigger")).toContainText(model.displayName);
    await turnComposerToolsOff(page);

    await composer.fill("Reply with exactly one word: ready.");
    const admitted = nextSend(page);
    await composer.press("Enter");
    const first = await admitted;
    chatId = MESSAGES_PATH.exec(new URL(first.url()).pathname)?.[1] ?? null;
    expect(first.ok(), `the first composer send is admitted (${first.status()})`).toBe(true);
    expect(chatId).not.toBeNull();
    const run = await pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
      const newest = await prisma.modelRun.findFirst({ where: { chatId: chatId! }, orderBy: { createdAt: "desc" } });
      return newest && !ACTIVE_RUN_STATUSES.includes(newest.status) ? newest : null;
    }, "composer_turn_timeout");
    expect(run.status, `the real turn completes (${run.status})`).toBe("complete");
    const answerRows = await prisma.usageEvent.findMany({ where: { modelRunId: run.id, purpose: "chat_answer" } });
    expect(answerRows.some((row) => row.providerModelId === model.modelId || row.modelId === model.modelId ||
      row.modelId === model.upstreamModelId), "the turn ran on the codex-lb model").toBe(true);
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('article[data-role="assistant"]').last()).not.toBeEmpty();
    expect(await prisma.usageMessageAdmission.count({ where: { userId } }), "the composer send is counted").toBe(1);
    summary.firstTurn = run.status;

    const notice = page.getByTestId("composer-usage-limit");
    await expect(notice).toHaveAttribute("data-tone", "critical", { timeout: 60_000 });
    await captureBothWidths(page, "01-limit-warning", (name) => testInfo.outputPath(name));

    const draft = "A second question after the limit.";
    await composer.fill(draft);
    const limited = nextSend(page);
    await composer.press("Enter");
    const rateResponse = await limited;
    expect(rateResponse.status()).toBe(429);
    expect(await rateResponse.json()).toMatchObject({ error: "message_rate_limited", usageLimit: { limit: 1, used: 1, window: "hour" } });
    await expect(page.getByText(/reached your limit of 1 message per hour/iu).first()).toBeVisible();
    await expect(composer).toHaveValue(draft);
    expect(await prisma.modelRun.count({ where: { chatId: chatId! } }), "a refused send creates no run").toBe(1);
    summary.rateRefusal = rateResponse.status();
    await captureBothWidths(page, "02-limit-refusal", (name) => testInfo.outputPath(name));

    // The real turn is personal spend; a budget below it refuses the same draft.
    const status = decodeUserUsageLimitStatusResponse(await (await page.request.get("/api/me/usage-limits")).json());
    const spent = status?.usageLimits.monthSpentMicros ?? 0;
    expect(spent, "the codex-lb turn has a catalog-priced cost").toBeGreaterThan(1);
    await setOverride(page, userId, { budget: Math.floor(spent / 2), hour: null });
    const refused = nextSend(page);
    await composer.press("Enter");
    const budgetResponse = await refused;
    expect(budgetResponse.status()).toBe(429);
    expect(await budgetResponse.json()).toMatchObject({ error: "usage_budget_exhausted", usageLimit: { scope: "user", window: "month" } });
    await expect(page.getByText(/Your monthly budget( of \$[\d.,]+)? is used up/u).first()).toBeVisible();
    await expect(composer).toHaveValue(draft);
    expect(await prisma.modelRun.count({ where: { chatId: chatId! } }), "a refused send creates no run").toBe(1);
    summary.budgetRefusal = budgetResponse.status();
    await captureBothWidths(page, "03-budget-refusal", (name) => testInfo.outputPath(name));
  } finally {
    await testInfo.attach("composer-limits-paid-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`composer_limits_paid_summary ${JSON.stringify(summary)}`);
    if (chatId) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 30_000 }).catch(() => undefined);
    await prisma.usageLimit.deleteMany({ where: { userId } });
    await prisma.usageMessageAdmission.deleteMany({ where: { userId } });
    await restoreDefaults();
  }
});
