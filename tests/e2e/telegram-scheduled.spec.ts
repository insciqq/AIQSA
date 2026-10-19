import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Browser, type Page, type TestInfo } from "@playwright/test";
import { decodeCatalogResponse } from "../../lib/contracts/catalog";
import type { TelegramAdminState } from "../../lib/contracts/telegram";
import { telegramConnectedText } from "../../lib/server/telegram/copy";
import {
  createFakeTelegramBotApi, FAKE_TELEGRAM_TOKEN, type FakeTelegramBotApi, type FakeTelegramUser
} from "../support/fakeTelegramBotApi";
import { runAccountMenuAction } from "./shell/page";
import { createPeopleFixture, type E2ESession } from "./support/people";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";

/**
 * Scheduled task results in Telegram, end to end on a disposable stand: the
 * app's own runner settles a Run now with the fake model, the outbox records
 * the delivery and the sender posts it to the fake Bot API on the loopback
 * origin (`AIQSA_TELEGRAM_API_ORIGIN`, test mode only). A reply to the
 * delivered result goes through the chat bridge into the run's chat. The bot
 * state is one installation row, so the scenarios run in order. Retries,
 * ambiguous sends and the restart sweep are proven by the sender's unit tests.
 */

test.describe.configure({ mode: "serial", timeout: 180_000 });

const DELIVERY_TIMEOUT_MS = 90_000;
const FIRST_UPDATE_ID = Math.floor(Date.now() / 1_000) + 500_000;
const TELEGRAM_ID_BASE = 910_000_000_000 + (Date.now() % 100_000_000_000) * 10;
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet-portrait", width: 820, height: 1180, touch: true },
  { name: "tablet-landscape", width: 1180, height: 820, touch: true },
  { name: "phone-portrait", width: 390, height: 844, touch: true },
  { name: "phone-landscape", width: 844, height: 390, touch: true }
] as const;

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const port = telegramE2eApiPort();
const bot: FakeTelegramBotApi = createFakeTelegramBotApi({ firstUpdateId: FIRST_UPDATE_ID });
const taskIds: string[] = [];

let adminSession: E2ESession;
let session: E2ESession;
let tgUser: FakeTelegramUser;

/** Disables the bot and opens it to everyone, through the administrator API. */
async function resetTelegramControl(request: APIRequestContext): Promise<TelegramAdminState> {
  let state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
  if (state.enabled) {
    const disabled = await request.patch("/api/admin/telegram", { data: { action: "disable", expectedVersion: state.version } });
    expect(disabled.ok()).toBe(true);
    state = (await disabled.json()) as TelegramAdminState;
  }
  if (state.restricted) {
    const opened = await request.patch("/api/admin/telegram", {
      data: { action: "set_access", expectedVersion: state.version, groupIds: [], restricted: false }
    });
    expect(opened.ok()).toBe(true);
    state = (await opened.json()) as TelegramAdminState;
  }
  return state;
}

async function enableBot(request: APIRequestContext): Promise<void> {
  const reset = await resetTelegramControl(request);
  const saved = await request.patch("/api/admin/telegram", {
    data: { action: "test_and_save", expectedVersion: reset.version, token: FAKE_TELEGRAM_TOKEN }
  });
  expect(saved.ok(), `Test & Save (${saved.status()})`).toBe(true);
  const enabled = await request.patch("/api/admin/telegram", {
    data: { action: "enable", expectedVersion: ((await saved.json()) as TelegramAdminState).version }
  });
  expect(enabled.ok(), `Enable (${enabled.status()})`).toBe(true);
}

/** Plain messages the bot sent to the user after the call mark `since`. */
function textsSince(since: number): string[] {
  return bot.calls().slice(since)
    .filter((call) => call.method === "sendMessage" && call.status === 200 && call.params.chat_id === tgUser.id)
    .map((call) => String(call.params.text));
}

/** Rich messages the bot sent to the user after the call mark `since`, as JSON. */
function richSince(since: number): string[] {
  return bot.calls().slice(since)
    .filter((call) => call.method === "sendRichMessage" && call.status === 200 && call.params.chat_id === tgUser.id)
    .map((call) => JSON.stringify(call.params.rich_message));
}

/** Links the user's Telegram account through the deep link's `/start <code>`. */
async function linkTelegram(): Promise<void> {
  const created = await session.page.request.post("/api/me/telegram/link-code");
  expect(created.ok(), `link code (${created.status()})`).toBe(true);
  const code = new URL(((await created.json()) as { deepLink: string }).deepLink).searchParams.get("start")!;
  const since = bot.calls().length;
  bot.inject.command(tgUser, "start", code);
  await expect.poll(() => textsSince(since), { timeout: 15_000 }).toEqual([telegramConnectedText(session.user.displayName)]);
}

async function answerModel(page: Page): Promise<Readonly<{ modelId: string; provider: string }>> {
  const catalog = decodeCatalogResponse(await (await page.request.get("/api/me/catalog")).json());
  const model = catalog?.models[0];
  expect(model, "the stand lists an answer model").toBeTruthy();
  return { modelId: model!.modelId, provider: model!.provider };
}

async function createTask(title: string, telegramNotify: boolean, schedule: unknown = { kind: "daily", time: "09:00" }): Promise<string> {
  const created = await session.page.request.post("/api/me/scheduled-tasks", { data: {
    title, prompt: `Synthetic ${title} instructions.`, schedule, timeZone: "UTC", ...await answerModel(session.page),
    searchEnabled: false, emailNotify: false, telegramNotify, toolsEnabled: false, workspaceEnabled: false, memoryEnabled: false,
    chatMode: "new", kind: "standard", historyRetentionDays: 90, pinnedSkillIds: []
  } });
  expect(created.ok(), `task is created (${created.status()})`).toBe(true);
  const id = ((await created.json()) as { task: { id: string; telegramNotify: boolean } }).task.id;
  taskIds.push(id);
  return id;
}

async function occurrenceIds(taskId: string): Promise<string[]> {
  return (await prisma.scheduledTaskOccurrence.findMany({ select: { id: true }, where: { taskId } })).map((row) => row.id);
}

/** Run now, then the new occurrence once it settled. */
async function runNow(taskId: string) {
  const before = await occurrenceIds(taskId);
  expect((await session.page.request.post(`/api/me/scheduled-tasks/${taskId}/run`)).ok()).toBe(true);
  return settled(taskId, before);
}

/** The task's first occurrence not in `before`, once it settled. */
async function settled(taskId: string, before: readonly string[] = [], timeout = DELIVERY_TIMEOUT_MS) {
  const next = () => prisma.scheduledTaskOccurrence.findFirst({
    orderBy: { createdAt: "desc" }, where: { id: { notIn: [...before] }, taskId }
  });
  await expect.poll(async () => (await next())?.state ?? null, { intervals: [1_000], timeout })
    .toMatch(/^(COMPLETED|FAILED|SKIPPED)$/u);
  return (await next())!;
}

async function delivery(occurrenceId: string) {
  return prisma.telegramScheduledDelivery.findUnique({ where: { occurrenceId } });
}

async function deliveryState(occurrenceId: string): Promise<Readonly<{ code: string | null; state: string }> | null> {
  const row = await delivery(occurrenceId);
  return row && { code: row.lastFailureCode, state: row.state };
}

/** Studio › Scheduled › Edit for `title` in `page`, the editor dialog once open. */
async function openEditor(page: Page, title: string) {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 60_000 });
  await runAccountMenuAction(page, "Scheduled");
  const panel = page.getByTestId("scheduled-tasks-panel");
  await panel.getByRole("button", { name: `More actions for ${title}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit scheduled task", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function captureEditor(browser: Browser, info: TestInfo, title: string): Promise<void> {
  const storageState = await session.context.storageState();
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL, hasTouch: viewport.touch, storageState,
      viewport: { height: viewport.height, width: viewport.width }
    });
    try {
      const page = await context.newPage();
      const dialog = await openEditor(page, title);
      const toggle = dialog.getByRole("switch", { name: "Send results to Telegram", exact: true });
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toBeInViewport();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(toggle).toHaveAccessibleDescription("Telegram receives the result itself.");
      await expect(dialog.getByText("Telegram receives the result itself.", { exact: true })).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`telegram-toggle-${viewport.name}-off.png`) });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(toggle).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`telegram-toggle-${viewport.name}-on.png`) });
      // No horizontal page scroll at any size.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  }
}

test.beforeAll(async ({ browser }) => {
  // Two cold `next dev` sign-ins compile the login and chat pages first.
  test.setTimeout(180_000);
  await bot.start({ port });
  tgUser = bot.inject.addUser({ firstName: "Dana", id: TELEGRAM_ID_BASE + 1, username: `tg_dana_${people.suffix}` });
  const [admin, user] = await Promise.all([people.admin("Telegram scheduled admin"), people.user("Telegram scheduled Dana")]);
  adminSession = await people.signIn(browser, admin!);
  await enableBot(adminSession.page.request);
  session = await people.signIn(browser, user!);
  await linkTelegram();
});

test.afterAll(async () => {
  try {
    if (taskIds.length) await prisma.scheduledTask.deleteMany({ where: { id: { in: taskIds } } });
    if (adminSession) await resetTelegramControl(adminSession.page.request);
  } finally {
    await bot.close();
    await people.cleanup();
    await prisma.$disconnect();
  }
});

test("Run now sends the result to Telegram in one message with its heading, referenced to the run's chat", async () => {
  const taskId = await createTask("Telegram morning brief", true);
  const since = bot.calls().length;
  const occurrence = await runNow(taskId);
  expect(occurrence.state).toBe("COMPLETED");
  await expect.poll(() => richSince(since), { timeout: DELIVERY_TIMEOUT_MS }).toHaveLength(1);
  const [message] = richSince(since);
  expect(message).toContain("Telegram morning brief");
  expect(message).toContain("Scheduled task finished");
  expect(message).toContain("Fake answer: Synthetic Telegram morning brief instructions.");
  await expect.poll(() => deliveryState(occurrence.id), { timeout: 15_000 }).toEqual({ code: null, state: "sent" });
  const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: occurrence.runId! } });
  const sent = bot.botMessages(tgUser.id).at(-1)!;
  // The bot message names the run's chat and answer, so a reply continues that chat.
  expect(await prisma.telegramMessageRef.findFirst({ where: { telegramMessageId: BigInt(sent.message_id), userId: session.user.id } }))
    .toMatchObject({ chatId: occurrence.chatId, messageId: run.assistantMessageId });
  // One delivery per result: nothing more arrives.
  await session.page.waitForTimeout(3_000);
  expect(richSince(since)).toHaveLength(1);
});

test("a reply to the delivered result continues the task's chat", async () => {
  const occurrence = await prisma.scheduledTaskOccurrence.findFirstOrThrow({
    orderBy: { scheduledFor: "desc" }, where: { taskId: taskIds[0]!, state: "COMPLETED" }
  });
  const delivered = bot.botMessages(tgUser.id).filter((message) => JSON.stringify(message).includes("Telegram morning brief")).at(-1)!;
  const question = `Tell me more about point 2 (${people.suffix})`;
  const since = bot.calls().length;
  bot.inject.text(tgUser, question, { replyTo: delivered.message_id });
  await expect.poll(async () => {
    const messages = await prisma.message.findMany({ select: { content: true }, where: { chatId: occurrence.chatId!, role: "user" } });
    return messages.some((message) => JSON.stringify(message.content).includes(question));
  }, { timeout: DELIVERY_TIMEOUT_MS }).toBe(true);
  // The bridge answers the reply in Telegram; it must arrive here, not during the next case.
  await expect.poll(() => richSince(since).some((rich) => rich.includes(question)), { timeout: DELIVERY_TIMEOUT_MS }).toBe(true);
});

test("a task with Telegram delivery off sends nothing and records nothing", async () => {
  const taskId = await createTask("Telegram quiet brief", false);
  const since = bot.calls().length;
  const occurrence = await runNow(taskId);
  expect(occurrence.state).toBe("COMPLETED");
  await session.page.waitForTimeout(5_000);
  expect(await delivery(occurrence.id)).toBeNull();
  expect(richSince(since)).toEqual([]);
});

test("a scheduled run that pauses its task sends the heading and the reason only", async () => {
  const taskId = await createTask("Telegram pause check", true);
  // Due now with a model the owner no longer has: the run fails before any answer and pauses the
  // recurring task (a once task is already complete when it runs, so its failure pauses nothing).
  await prisma.scheduledTask.update({ where: { id: taskId }, data: {
    modelId: `telegram-e2e-gone-${people.suffix}`, nextRunAt: new Date(Math.floor(Date.now() / 60_000) * 60_000)
  } });
  const since = bot.calls().length;
  // A due task starts within the scheduler's dispatch spread (up to three minutes), not at once.
  test.setTimeout(420_000);
  const occurrence = await settled(taskId, [], 240_000);
  expect(occurrence).toMatchObject({ reasonCode: "model_unavailable", state: "FAILED", trigger: "schedule" });
  try {
    await expect.poll(() => textsSince(since), { timeout: DELIVERY_TIMEOUT_MS }).toHaveLength(1);
  } catch (error) {
    // The delivery row and the bot's calls name a missing notice in the report.
    const calls = bot.calls().slice(since).filter((call) => call.method !== "getUpdates").map((call) => `${call.method}:${call.status}`);
    throw new Error(`no paused notice; delivery ${JSON.stringify(await deliveryState(occurrence.id))}; bot calls ${calls.join(", ") || "none"}`,
      { cause: error });
  }
  const [text] = textsSince(since);
  expect(text).toMatch(/^Telegram pause check\nScheduled task paused\n\S/u);
  expect(text).not.toContain("Fake answer");
  expect(richSince(since)).toEqual([]);
  await expect.poll(() => deliveryState(occurrence.id), { timeout: 15_000 }).toEqual({ code: null, state: "sent" });
});

test("the editor offers Send results to Telegram with its hint at every size", async ({ browser }, info) => {
  await createTask("Telegram editor check", false);
  await captureEditor(browser, info, "Telegram editor check");
});

test("after Telegram is disconnected a result is skipped with its reason recorded, and the switch stays to turn off", async () => {
  const unlinked = await session.page.request.delete("/api/me/telegram");
  expect(unlinked.ok(), `disconnect (${unlinked.status()})`).toBe(true);
  const since = bot.calls().length;
  const occurrence = await runNow(taskIds[0]!);
  expect(occurrence.state).toBe("COMPLETED");
  await expect.poll(() => deliveryState(occurrence.id), { timeout: DELIVERY_TIMEOUT_MS })
    .toEqual({ code: "telegram_not_linked", state: "skipped" });
  expect(richSince(since)).toEqual([]);

  // The task still sends to Telegram: its editor keeps the switch so the owner can turn it off.
  const dialog = await openEditor(session.page, "Telegram morning brief");
  const toggle = dialog.getByRole("switch", { name: "Send results to Telegram", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskIds[0]! } })).telegramNotify).toBe(false);
  // A task that never sent to Telegram shows no switch without a link.
  const quiet = await openEditor(session.page, "Telegram quiet brief");
  await expect(quiet.getByRole("switch", { name: "Send results to Telegram", exact: true })).toHaveCount(0);
});
