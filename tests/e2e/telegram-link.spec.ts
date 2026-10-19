import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { TelegramAdminState } from "../../lib/contracts/telegram";
import { TELEGRAM_BOT_COMMANDS, TELEGRAM_COPY, telegramConnectedText, telegramReasonText } from "../../lib/server/telegram/copy";
import {
  createFakeTelegramBotApi, FAKE_TELEGRAM_BOT, FAKE_TELEGRAM_TOKEN, type FakeTelegramBotApi, type FakeTelegramUser
} from "../support/fakeTelegramBotApi";
import { runAccountMenuAction } from "./shell/page";
import { createPeopleFixture, type E2EGroup, type E2ESession, type E2EUser } from "./support/people";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";

/**
 * Telegram Connect linking end to end against the fake Bot API on the
 * loopback origin the web server is started with (`AIQSA_TELEGRAM_API_ORIGIN`,
 * test mode only). Inbound updates go through the fake's `getUpdates` queue,
 * so the real poller, dispatcher and linking path handle them; every scenario
 * checks the browser and the Bot API calls the server made. The bot state is
 * one installation row, so the scenarios run in order: the administrator
 * enables the bot first and the last one replaces its token.
 */

test.describe.configure({ mode: "serial", timeout: 120_000 });

const REPLY_TIMEOUT_MS = 15_000;
const SECOND_BOT_TOKEN = "100000002:AAFakeTelegramSecondBotTokenForTests_00";
const SECOND_BOT_USERNAME = "aiqsa_second_test_bot";
const ACCESS_OFF_TEXT = telegramReasonText("telegram_access_off")!;
const LINK_CODE_INVALID_TEXT = telegramReasonText("telegram_link_code_invalid")!;
// A stand that keeps its database between runs has stored the poll offset and
// the in-memory stranger-reply memory: ids from the clock stay ahead of both.
const FIRST_UPDATE_ID = Math.floor(Date.now() / 1_000);
const TELEGRAM_ID_BASE = 900_000_000_000 + (Date.now() % 100_000_000_000) * 10;

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const port = telegramE2eApiPort();

let bot: FakeTelegramBotApi = createFakeTelegramBotApi({ firstUpdateId: FIRST_UPDATE_ID });
let adminSession: E2ESession;
let aliceSession: E2ESession;
let bobSession: E2ESession;
let carolSession: E2ESession;
let pilot: E2EGroup;
let tgAlice: FakeTelegramUser;
let tgMallory: FakeTelegramUser;
let tgBob: FakeTelegramUser;
let tgCarol: FakeTelegramUser;

function telegramUser(api: FakeTelegramBotApi, offset: number, firstName: string): FakeTelegramUser {
  return api.inject.addUser({ firstName, id: TELEGRAM_ID_BASE + offset, username: `tg_${firstName.toLowerCase()}_${people.suffix}` });
}

/** Plain messages the bot sent to `chatId` after the call mark `since`. */
function repliesSince(api: FakeTelegramBotApi, since: number, chatId: number): string[] {
  return api.calls().slice(since)
    .filter((call) => call.method === "sendMessage" && call.status === 200 && call.params.chat_id === chatId)
    .map((call) => String(call.params.text));
}

async function expectReplies(api: FakeTelegramBotApi, since: number, chatId: number, texts: readonly string[]): Promise<void> {
  await expect.poll(() => repliesSince(api, since, chatId), { timeout: REPLY_TIMEOUT_MS }).toEqual(texts);
}

function methodsSince(api: FakeTelegramBotApi, since: number, method: string): number {
  return api.calls().slice(since).filter((call) => call.method === method && call.status === 200).length;
}

/** Disables the bot and opens it to everyone, through the administrator API. */
async function resetTelegramControl(request: APIRequestContext): Promise<void> {
  const read = await request.get("/api/admin/telegram");
  expect(read.ok()).toBe(true);
  let state = (await read.json()) as TelegramAdminState;
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
  }
}

/** Settings → Connections → Telegram, freshly loaded: the block reads the link state when it opens. */
async function openTelegramSettings(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Connections", exact: true }).click();
  const section = settings.getByTestId("settings-telegram");
  await expect(section.getByTestId("settings-telegram-state")).not.toHaveText(/^Loading Telegram/u);
  return section;
}

function connectedState(tgUser: FakeTelegramUser): RegExp {
  return new RegExp(`^Connected as @${tgUser.username} since `, "u");
}

/**
 * Connect Telegram in Settings, then the `/start <code>` Telegram sends when
 * the user presses Start on the deep link. Returns the code.
 */
async function connectFromSettings(
  session: E2ESession, tgUser: FakeTelegramUser, options: Readonly<{ reconnect?: boolean }> = {}
): Promise<string> {
  const section = await openTelegramSettings(session.page);
  const connect = section.getByTestId("settings-telegram-connect");
  await expect(connect).toHaveText(options.reconnect ? "Reconnect" : "Connect Telegram");
  await connect.click();
  const deepLink = section.getByTestId("settings-telegram-deep-link");
  await expect(deepLink).toBeVisible();
  const link = (await deepLink.textContent())?.trim() ?? "";
  expect(link).toMatch(new RegExp(`^https://t\\.me/${bot.bot.username}\\?start=[A-Za-z0-9_-]{43}$`, "u"));
  await expect(section.getByTestId("settings-telegram-open")).toHaveAttribute("href", link);
  const code = new URL(link).searchParams.get("start")!;

  const since = bot.calls().length;
  bot.inject.command(tgUser, "start", code);
  await expectReplies(bot, since, tgUser.id, [telegramConnectedText(session.user.displayName)]);
  // The open link step asks the server every 3 s until Telegram confirmed.
  await expect(section.getByTestId("settings-telegram-state")).toHaveText(connectedState(tgUser), { timeout: REPLY_TIMEOUT_MS });
  await expect(section.getByTestId("settings-telegram-link")).toHaveCount(0);
  return code;
}

async function openAdminTelegram(page: Page): Promise<Locator> {
  await page.goto("/admin?section=telegram");
  const section = page.getByTestId("admin-telegram-section");
  await expect(section.getByTestId("telegram-bot-state")).toBeVisible({ timeout: 30_000 });
  return section;
}

/** The user's admin page once its Telegram panel has loaded. */
async function openAdminUser(page: Page, user: E2EUser): Promise<Readonly<{ panel: Locator; userPage: Locator }>> {
  await page.goto(`/admin?section=users&resource=${encodeURIComponent(user.id)}`);
  const userPage = page.getByTestId("admin-user-page");
  const panel = userPage.getByTestId("admin-user-telegram");
  await expect(panel.getByTestId("admin-user-telegram-account").or(panel.getByTestId("admin-user-telegram-empty")))
    .toBeVisible({ timeout: 30_000 });
  return { panel, userPage };
}

/** The link state the administrator route reports for `user`. */
async function adminUserLinkState(page: Page, user: E2EUser): Promise<string> {
  const response = await page.request.get(`/api/admin/telegram/users/${encodeURIComponent(user.id)}`);
  return response.ok() ? ((await response.json()) as { state: string }).state : `http_${response.status()}`;
}

async function testAndSave(section: Locator, token: string, username: string): Promise<void> {
  const field = section.getByLabel("Bot token", { exact: true });
  await field.fill(token);
  await section.getByTestId("telegram-test-and-save").click();
  const result = section.getByTestId("telegram-test-result");
  await expect(result).toContainText("Bot found. The token is saved.");
  await expect(result).toContainText(`Connected to @${username}.`);
  await expect(section.getByTestId("telegram-bot-username")).toHaveText(`@${username}`);
  // Write-only: the field clears and the token is nowhere in the page or the state route.
  await expect(field).toHaveValue("");
  const secret = token.split(":")[1]!;
  expect(await section.page().content()).not.toContain(secret);
  const state = await section.page().request.get("/api/admin/telegram");
  expect(await state.text()).not.toContain(secret);
}

test.beforeAll(async ({ browser }) => {
  await bot.start({ port });
  tgAlice = telegramUser(bot, 1, "Alice");
  tgMallory = telegramUser(bot, 2, "Mallory");
  tgBob = telegramUser(bot, 3, "Bob");
  tgCarol = telegramUser(bot, 4, "Carol");
  pilot = await people.group("Telegram pilot");
  const [admin, alice, bob, carol] = await Promise.all([
    people.admin("Telegram admin"), people.user("Telegram Alice"), people.user("Telegram Bob"), people.user("Telegram Carol")
  ]);
  adminSession = await people.signIn(browser, admin!);
  // Every run starts from a disabled bot open to everyone.
  await resetTelegramControl(adminSession.page.request);
  aliceSession = await people.signIn(browser, alice!);
  bobSession = await people.signIn(browser, bob!);
  carolSession = await people.signIn(browser, carol!);
});

test.afterAll(async () => {
  try {
    if (adminSession) await resetTelegramControl(adminSession.page.request);
  } finally {
    await bot.close();
    await people.cleanup();
    await prisma.$disconnect();
  }
});

test("an administrator saves the bot token and enables the bot", async () => {
  const section = await openAdminTelegram(adminSession.page);
  await expect(section.getByTestId("telegram-enable")).toBeVisible();
  await testAndSave(section, FAKE_TELEGRAM_TOKEN, FAKE_TELEGRAM_BOT.username);

  await section.getByTestId("telegram-enable").click();
  await expect(section.getByTestId("telegram-bot-status")).toHaveText("On");
  await expect(section.getByTestId("telegram-bot-health")).toContainText("Polling");
  await expect(section.getByTestId("telegram-disable")).toBeVisible();

  // Test & Save asked Telegram for the bot; Enable took it over for long polling and listed the commands.
  expect(bot.calls().filter((call) => call.method !== "getUpdates").map((call) => [call.method, call.status]))
    .toEqual([["getMe", 200], ["deleteWebhook", 200], ["setMyCommands", 200]]);
  expect(bot.commands()).toEqual(TELEGRAM_BOT_COMMANDS);
});

test("a user links Telegram from Settings and the link code works once", async () => {
  const code = await connectFromSettings(aliceSession, tgAlice);

  // The same code from another Telegram account is refused; the first link stays.
  const since = bot.calls().length;
  bot.inject.command(tgMallory, "start", code);
  await expectReplies(bot, since, tgMallory.id, [LINK_CODE_INVALID_TEXT]);
  const section = await openTelegramSettings(aliceSession.page);
  await expect(section.getByTestId("settings-telegram-state")).toHaveText(connectedState(tgAlice));
});

test("Disconnect in Settings unlinks and the bot treats the account as a stranger", async () => {
  const section = await openTelegramSettings(aliceSession.page);
  const since = bot.calls().length;
  await section.getByTestId("settings-telegram-disconnect").click();
  await section.getByTestId("settings-telegram-disconnect-confirm").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(section.getByTestId("settings-telegram-state")).toHaveText("Not connected");
  await expect(section.getByText("Telegram disconnected. The bot no longer answers for your account.")).toBeVisible();
  await expect(section.getByTestId("settings-telegram-connect")).toHaveText("Connect Telegram");
  await expectReplies(bot, since, tgAlice.id, [TELEGRAM_COPY.disconnected]);

  const next = bot.calls().length;
  bot.inject.command(tgAlice, "help");
  await expectReplies(bot, next, tgAlice.id, [TELEGRAM_COPY.notLinked]);
});

test("/unlink in the bot asks first and its button unlinks", async () => {
  await connectFromSettings(aliceSession, tgAlice);

  const since = bot.calls().length;
  bot.inject.command(tgAlice, "unlink");
  await expectReplies(bot, since, tgAlice.id, [TELEGRAM_COPY.unlinkQuestion]);
  const question = bot.botMessages(tgAlice.id).filter((message) => message.text === TELEGRAM_COPY.unlinkQuestion).at(-1)!;
  const markup = question.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string; text: string }>> };
  const button = markup.inline_keyboard[0]?.[0];
  expect(button?.text).toBe(TELEGRAM_COPY.unlinkConfirm);
  expect(button?.callback_data).toBeTruthy();

  bot.inject.callback(tgAlice, question.message_id, button!.callback_data!);
  await expect.poll(() => bot.botMessages(tgAlice.id).find((message) => message.message_id === question.message_id)?.text,
    { timeout: REPLY_TIMEOUT_MS }).toBe(TELEGRAM_COPY.disconnected);
  await expect.poll(() => methodsSince(bot, since, "answerCallbackQuery"), { timeout: REPLY_TIMEOUT_MS }).toBe(1);
  expect(methodsSince(bot, since, "editMessageText")).toBe(1);

  const section = await openTelegramSettings(aliceSession.page);
  await expect(section.getByTestId("settings-telegram-state")).toHaveText("Not connected");
});

test("an administrator unlinks Telegram on the user's page", async () => {
  await connectFromSettings(aliceSession, tgAlice);
  const { panel } = await openAdminUser(adminSession.page, aliceSession.user);
  await expect(panel.getByTestId("admin-user-telegram-account")).toContainText(`@${tgAlice.username}`);
  await expect(panel.getByTestId("admin-user-telegram-status")).toContainText(/^Connected · since /u);

  const since = bot.calls().length;
  await panel.getByRole("button", { name: "Unlink", exact: true }).click();
  await panel.getByTestId("admin-user-telegram-unlink-confirm").getByRole("button", { name: "Unlink Telegram", exact: true }).click();
  await expect(panel.getByTestId("admin-user-telegram-empty")).toHaveText("No Telegram account connected.");
  await expect(panel.getByText("Telegram unlinked. The bot no longer answers for this account.")).toBeVisible();
  await expectReplies(bot, since, tgAlice.id, [TELEGRAM_COPY.disconnected]);

  const section = await openTelegramSettings(aliceSession.page);
  await expect(section.getByTestId("settings-telegram-state")).toHaveText("Not connected");
});

test("Revoke sessions ends the Telegram link", async ({ browser }) => {
  await connectFromSettings(bobSession, tgBob);
  const admin = adminSession.page;
  const { panel, userPage } = await openAdminUser(admin, bobSession.user);
  await expect(panel.getByTestId("admin-user-telegram-account")).toContainText(`@${tgBob.username}`);

  await userPage.getByRole("button", { name: "Revoke sessions", exact: true }).click();
  await admin.getByTestId("admin-confirm-revoke-user-sessions").getByRole("button", { name: /confirm revoke sessions/iu }).click();
  await expect.poll(() => adminUserLinkState(admin, bobSession.user), { timeout: REPLY_TIMEOUT_MS }).toBe("not_linked");
  const reloaded = await openAdminUser(admin, bobSession.user);
  await expect(reloaded.panel.getByTestId("admin-user-telegram-empty")).toBeVisible();

  // The session that made the link is gone, and the bot no longer knows the account.
  const revoked = bobSession.page;
  await expect.poll(async () => {
    await revoked.goto("/");
    return new URL(revoked.url()).pathname;
  }, { timeout: REPLY_TIMEOUT_MS }).toBe("/login");
  const since = bot.calls().length;
  bot.inject.command(tgBob, "help");
  await expectReplies(bot, since, tgBob.id, [TELEGRAM_COPY.notLinked]);

  bobSession = await people.signIn(browser, bobSession.user);
  const section = await openTelegramSettings(bobSession.page);
  await expect(section.getByTestId("settings-telegram-state")).toHaveText("Not connected");
});

test("selected groups turn Telegram off for a non-member and a membership restores it without relinking", async () => {
  await connectFromSettings(carolSession, tgCarol);

  const admin = adminSession.page;
  const access = (await openAdminTelegram(admin)).getByTestId("telegram-access-form");
  await access.getByRole("radio", { name: /^Selected groups/u }).check();
  await access.getByRole("checkbox", { name: pilot.name, exact: true }).check();
  await access.getByTestId("telegram-save-access").click();
  await expect(access.getByText("Access is checked on every message and before every delivery.")).toBeVisible();
  await expect(access.getByTestId("telegram-save-access")).toBeDisabled();

  // Carol is not in the pilot group: the bot names the reason and her link is kept.
  let since = bot.calls().length;
  bot.inject.command(tgCarol, "help");
  await expectReplies(bot, since, tgCarol.id, [ACCESS_OFF_TEXT]);
  let section = await openTelegramSettings(carolSession.page);
  await expect(section.getByTestId("settings-telegram-state")).toHaveText(`Access off for @${tgCarol.username}`);
  await expect(section.getByTestId("settings-telegram-status")).toContainText("Your link is kept and works again when access returns.");
  await expect(section.getByTestId("settings-telegram-connect")).toHaveCount(0);
  await expect(section.getByTestId("settings-telegram-disconnect")).toBeVisible();
  const { panel, userPage } = await openAdminUser(admin, carolSession.user);
  await expect(panel.getByTestId("admin-user-telegram-status")).toContainText("Telegram access is off for this user");

  // Joining the group gives access back to the same link.
  const groups = userPage.getByTestId("admin-user-groups");
  await groups.getByRole("checkbox", { name: pilot.name, exact: true }).check();
  await groups.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => adminUserLinkState(admin, carolSession.user), { timeout: REPLY_TIMEOUT_MS }).toBe("linked");
  since = bot.calls().length;
  bot.inject.command(tgCarol, "help");
  await expectReplies(bot, since, tgCarol.id, [TELEGRAM_COPY.help]);
  section = await openTelegramSettings(carolSession.page);
  await expect(section.getByTestId("settings-telegram-state")).toHaveText(connectedState(tgCarol));
});

test("a token for another bot asks linked users to reconnect", async () => {
  // The new bot answers on the same loopback origin, so the stand's configuration stays as it is.
  await bot.close();
  bot = createFakeTelegramBotApi({ firstUpdateId: FIRST_UPDATE_ID, token: SECOND_BOT_TOKEN, username: SECOND_BOT_USERNAME });
  await bot.start({ port });
  const tgCarolOnSecondBot = bot.inject.addUser({ firstName: tgCarol.first_name, id: tgCarol.id, username: tgCarol.username });

  const section = await openAdminTelegram(adminSession.page);
  await expect(section.getByTestId("telegram-disable")).toBeVisible();
  await testAndSave(section, SECOND_BOT_TOKEN, SECOND_BOT_USERNAME);
  await expect(section.getByTestId("telegram-disable")).toBeVisible();
  // The bot is on, so the new one is taken over at once.
  expect(bot.calls().filter((call) => call.method !== "getUpdates").map((call) => [call.method, call.status]))
    .toEqual([["getMe", 200], ["deleteWebhook", 200], ["setMyCommands", 200]]);

  const settings = await openTelegramSettings(carolSession.page);
  await expect(settings.getByTestId("settings-telegram-state")).toHaveText("Reconnect needed");
  await expect(settings.getByTestId("settings-telegram-status"))
    .toContainText("This AIQSA now uses a different Telegram bot. Reconnect to keep chatting from Telegram.");
  const { panel } = await openAdminUser(adminSession.page, carolSession.user);
  await expect(panel.getByTestId("admin-user-telegram-status")).toContainText("Connected to a previous bot");

  await connectFromSettings(carolSession, tgCarolOnSecondBot, { reconnect: true });
});
