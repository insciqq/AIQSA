import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { TelegramAdminState } from "../../lib/contracts/telegram";
import { runAccountMenuAction } from "./shell/page";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Opt-in linking check against the real Telegram Bot API (PRD §12): the
 * administrator API saves a real bot token and enables the bot, a user
 * connects from Settings, and the `/start <code>` Telegram would deliver is
 * fed from a real private chat id through the test-mode update route, so the
 * bot's confirmation and disconnect replies reach that chat. Runs only when
 * AIQSA_TELEGRAM_LIVE_TOKEN_FILE and AIQSA_TELEGRAM_LIVE_CHAT_ID_FILE name
 * readable files and the web server talks to https://api.telegram.org
 * (AIQSA_TELEGRAM_API_ORIGIN). Neither value is printed; traces stay off so
 * no artifact records the token.
 */

const tokenFile = process.env.AIQSA_TELEGRAM_LIVE_TOKEN_FILE?.trim();
const chatIdFile = process.env.AIQSA_TELEGRAM_LIVE_CHAT_ID_FILE?.trim();
const live = Boolean(tokenFile && chatIdFile);

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.use({ screenshot: "off", trace: "off", video: "off" });
test.skip(!live, "live Telegram check is opt-in");

const REPLY_TIMEOUT_MS = 30_000;
const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);

let adminSession: E2ESession;
let userSession: E2ESession;

function readSecretFile(file: string | undefined): string {
  return readFileSync(file!, "utf8").trim();
}

async function adminState(request: APIRequestContext): Promise<TelegramAdminState> {
  const response = await request.get("/api/admin/telegram");
  expect(response.status()).toBe(200);
  return (await response.json()) as TelegramAdminState;
}

async function adminCommand(request: APIRequestContext, data: Record<string, unknown>): Promise<TelegramAdminState> {
  const response = await request.patch("/api/admin/telegram", { data });
  // Only the status is asserted: a refusal body never reaches the report.
  expect(response.status()).toBe(200);
  return (await response.json()) as TelegramAdminState;
}

async function disableBot(request: APIRequestContext): Promise<void> {
  const state = await adminState(request);
  if (state.enabled) await adminCommand(request, { action: "disable", expectedVersion: state.version });
}

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

/** What Telegram delivers when the chat's owner presses Start on the deep link. */
async function injectStart(request: APIRequestContext, chatId: number, code: string): Promise<void> {
  const text = `/start ${code}`;
  const response = await request.post("/api/test/telegram/updates", {
    data: {
      update_id: Math.floor(Date.now() / 1_000),
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1_000),
        chat: { id: chatId, type: "private", first_name: "AIQSA live check" },
        from: { id: chatId, is_bot: false, first_name: "AIQSA live check" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: "/start".length }]
      }
    }
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ claimed: true, settled: true });
}

test.beforeAll(async ({ browser }) => {
  const [admin, user] = await Promise.all([people.admin("Telegram live admin"), people.user("Telegram live user")]);
  adminSession = await people.signIn(browser, admin!);
  userSession = await people.signIn(browser, user!);
  await disableBot(adminSession.page.request);
});

test.afterAll(async () => {
  try {
    // Stop polling the real bot so the next installation can take it over.
    if (adminSession) await disableBot(adminSession.page.request);
  } finally {
    await people.cleanup();
    await prisma.$disconnect();
  }
});

test("a real bot token enables the bot and a user links and disconnects from Settings", async () => {
  const token = readSecretFile(tokenFile);
  const chatId = Number(readSecretFile(chatIdFile));
  expect(Number.isSafeInteger(chatId) && chatId > 0).toBe(true);
  const request = adminSession.page.request;

  let state = await adminCommand(request, { action: "test_and_save", token, expectedVersion: (await adminState(request)).version });
  expect(state.tokenConfigured).toBe(true);
  const username = state.botUsername!;
  expect(username).toMatch(/^[A-Za-z][A-Za-z0-9_]{3,31}$/u);
  state = await adminCommand(request, { action: "enable", expectedVersion: state.version });
  expect(state.enabled).toBe(true);
  await expect.poll(async () => (await adminState(request)).health.lastSuccessAt, { timeout: REPLY_TIMEOUT_MS }).not.toBeNull();
  expect((await adminState(request)).health.lastFailureCode).toBeNull();

  const section = await openTelegramSettings(userSession.page);
  await section.getByTestId("settings-telegram-connect").click();
  const deepLink = section.getByTestId("settings-telegram-deep-link");
  await expect(deepLink).toBeVisible();
  const link = (await deepLink.textContent())?.trim() ?? "";
  expect(link).toMatch(new RegExp(`^https://t\\.me/${username}\\?start=[A-Za-z0-9_-]{43}$`, "u"));
  await injectStart(userSession.page.request, chatId, new URL(link).searchParams.get("start")!);

  // The confirmation went out through the real Bot API before the route settled.
  await expect(section.getByTestId("settings-telegram-state")).toHaveText(/^Connected/u, { timeout: REPLY_TIMEOUT_MS });
  expect((await adminState(request)).health.lastFailureCode).toBeNull();

  const settings = await openTelegramSettings(userSession.page);
  await settings.getByTestId("settings-telegram-disconnect").click();
  await settings.getByTestId("settings-telegram-disconnect-confirm").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(settings.getByTestId("settings-telegram-state")).toHaveText("Not connected");
  expect((await adminState(request)).health.lastFailureCode).toBeNull();
});
