import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { decodeChatDetailResponse, type ChatMessageWire } from "../../lib/contracts/chats";
import type { TelegramAdminCommand, TelegramAdminState, TelegramLinkCodeResponse } from "../../lib/contracts/telegram";
import { decodeAdminUsageLimitsResponse } from "../../lib/contracts/usageLimits";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import {
  TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY, TELEGRAM_RUN_REFUSAL_COPY, telegramAssistantSelectedText, telegramConnectedText,
  telegramCurrentChatText, telegramModelLabel, telegramReasonText
} from "../../lib/server/telegram/copy";
import { renderTelegramAnswer } from "../../lib/server/telegram/render";
import { createFakeTelegramBotApi, type FakeTelegramCall, type FakeTelegramUser } from "../support/fakeTelegramBotApi";
import { createAssistantFixture } from "./support/assistants";
import { createPeopleFixture, type E2EGroup, type E2ESession } from "./support/people";
import { createCatalogOnlyAnswerModel, createCatalogOnlySearchSource, type CatalogOnlyAnswerModel, type CatalogOnlySearchSource } from "./support/syntheticCatalog";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";
import { prepareWorkspaceFakeContext } from "./support/workspaceFixture";

/**
 * Telegram messages as ordinary AIQSA chats, end to end: the fake Bot API on
 * the loopback origin the web server reads in test mode, inbound updates
 * through its `getUpdates` queue (the real poller, dispatcher and chat
 * bridge handle them) and the fake LLM. Every scenario checks what reached
 * Telegram and what the web shows. The spec owns its own bot identity, so its
 * update ids, receipts and poll offset never meet the linking spec's. A
 * restart during a run is covered by the bridge's recovery tests.
 */

test.describe.configure({ mode: "serial", timeout: 120_000 });

const REPLY_TIMEOUT_MS = 30_000;
const CHAT_BOT_TOKEN = "100000003:AAFakeTelegramChatBotTokenForTests_0000";
const CHAT_BOT_USERNAME = "aiqsa_chat_test_bot";
const FIRST_UPDATE_ID = Math.floor(Date.now() / 1_000);
const TELEGRAM_ID_BASE = 950_000_000_000 + (Date.now() % 10_000_000_000) * 10;
const HTTPS_INSTALLATION = (process.env.AIQSA_E2E_APP_BASE_URL?.trim() ?? "").startsWith("https://");
/** Four Telegram-sized parts the merge window joins into one long question: the fake answer streams for many seconds. */
const LONG_PARTS = Array.from({ length: 4 }, (_, index) => `Part ${index + 1}. ${"synthetic ".repeat(390).trim()}`);

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
const port = telegramE2eApiPort();
const bot = createFakeTelegramBotApi({ firstUpdateId: FIRST_UPDATE_ID, token: CHAT_BOT_TOKEN, username: CHAT_BOT_USERNAME });

let adminSession: E2ESession;
let aliceSession: E2ESession;
let tgAlice: FakeTelegramUser;
let pilot: E2EGroup;
let restoreFakeContext: (() => Promise<void>) | null = null;
let secondModel: CatalogOnlyAnswerModel | null = null;
let searchSource: CatalogOnlySearchSource | null = null;

function callsSince(since: number, method: string, chatId: number): FakeTelegramCall[] {
  return bot.calls().slice(since).filter((call) => call.method === method && call.status === 200 && call.params.chat_id === chatId);
}

function textsSince(since: number, chatId: number): string[] {
  return callsSince(since, "sendMessage", chatId).map((call) => String(call.params.text));
}

async function expectText(since: number, text: string | RegExp): Promise<string> {
  await expect.poll(() => textsSince(since, tgAlice.id).some((sent) => typeof text === "string" ? sent === text : text.test(sent)),
    { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  return textsSince(since, tgAlice.id).find((sent) => typeof text === "string" ? sent === text : text.test(sent))!;
}

async function nextAnswer(since: number, timeout = REPLY_TIMEOUT_MS): Promise<FakeTelegramCall> {
  try {
    await expect.poll(() => callsSince(since, "sendRichMessage", tgAlice.id).length, { timeout }).toBeGreaterThan(0);
  } catch (error) {
    // Name what the bot did instead, so a missing answer is diagnosable from the report.
    const seen = bot.calls().slice(since).filter((call) => call.method !== "getUpdates")
      .map((call) => `${call.method}:${call.status}${call.method === "sendMessage" ? ` ${JSON.stringify(String(call.params.text).slice(0, 160))}` : ""}`)
      .join(", ") || "nothing";
    throw new Error(`no rich answer within ${timeout} ms; the bot sent: ${seen}`, { cause: error });
  }
  return callsSince(since, "sendRichMessage", tgAlice.id)[0]!;
}

async function currentChatId(): Promise<string | null> {
  return (await prisma.telegramLink.findUniqueOrThrow({ select: { currentChatId: true }, where: { userId: aliceSession.user.id } })).currentChatId;
}

async function chatMessages(page: Page, chatId: string): Promise<ChatMessageWire[]> {
  const detail = decodeChatDetailResponse(await (await page.request.get(`/api/chats/${chatId}`)).json());
  expect(detail).not.toBeNull();
  return detail!.messages;
}

function messageText(message: ChatMessageWire): string {
  return textFromContentBlocks(message.content as { blocks?: unknown[] });
}

async function latestRun() {
  return prisma.modelRun.findFirstOrThrow({
    orderBy: { createdAt: "desc" }, select: { chatId: true, id: true, modelId: true, normalizedRequest: true, status: true },
    where: { userId: aliceSession.user.id }
  });
}

function searchOptionIds(normalizedRequest: unknown): string[] {
  const plan = (normalizedRequest as { searchPlan?: { options?: Array<{ optionId: string }> } } | null)?.searchPlan;
  return (plan?.options ?? []).map((option) => option.optionId);
}

/** The newest bot message carrying `text`, and the callback data of its button labelled `button`. */
function menuButton(text: string, button: string | RegExp): Readonly<{ messageId: number; data: string }> {
  const menu = bot.botMessages(tgAlice.id).filter((message) => message.text === text).at(-1);
  expect(menu, text).toBeTruthy();
  const buttons = (menu!.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string; text: string }>> }).inline_keyboard.flat();
  const found = buttons.find((entry) => typeof button === "string" ? entry.text === button : button.test(entry.text));
  expect(found?.callback_data, String(button)).toBeTruthy();
  return { data: found!.callback_data!, messageId: menu!.message_id };
}

function botMessage(messageId: number) {
  return bot.botMessages(tgAlice.id).find((message) => message.message_id === messageId);
}

async function admin(request: APIRequestContext, command: TelegramAdminCommand): Promise<TelegramAdminState> {
  const response = await request.patch("/api/admin/telegram", { data: command });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TelegramAdminState;
}

/** This spec's bot, switched on and open to everyone. */
async function enableChatBot(request: APIRequestContext): Promise<void> {
  let state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
  if (state.enabled) state = await admin(request, { action: "disable", expectedVersion: state.version });
  if (state.restricted) state = await admin(request, { action: "set_access", expectedVersion: state.version, groupIds: [], restricted: false });
  state = await admin(request, { action: "test_and_save", expectedVersion: state.version, token: CHAT_BOT_TOKEN });
  await admin(request, { action: "enable", expectedVersion: state.version });
}

async function setAccess(request: APIRequestContext, groupIds: readonly string[]): Promise<void> {
  const state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
  await admin(request, { action: "set_access", expectedVersion: state.version, groupIds: [...groupIds], restricted: groupIds.length > 0 });
}

async function startLongAnswer(): Promise<Readonly<{ since: number; draftId: number }>> {
  const since = bot.calls().length;
  for (const part of LONG_PARTS) bot.inject.text(tgAlice, part);
  await expect.poll(() => callsSince(since, "sendRichMessageDraft", tgAlice.id).length, { timeout: REPLY_TIMEOUT_MS }).toBeGreaterThan(0);
  return { draftId: callsSince(since, "sendMessageDraft", tgAlice.id)[0]!.params.draft_id as number, since };
}

test.beforeAll(async ({ browser }) => {
  // Two cold `next dev` sign-ins compile the login and chat pages first.
  test.setTimeout(180_000);
  await bot.start({ port });
  tgAlice = bot.inject.addUser({ firstName: "Alice", id: TELEGRAM_ID_BASE + 1, username: `tg_chat_alice_${people.suffix}` });
  pilot = await people.group("Telegram chat pilot");
  const [adminUser, alice] = await Promise.all([people.admin("Telegram chat admin"), people.user("Telegram chat Alice")]);
  adminSession = await people.signIn(browser, adminUser!);
  aliceSession = await people.signIn(browser, alice!);
  // Long questions keep a fake answer running; they need the larger fake context the Workspace specs use.
  restoreFakeContext = await prepareWorkspaceFakeContext(prisma);
  await enableChatBot(adminSession.page.request);

  const code = await aliceSession.page.request.post("/api/me/telegram/link-code");
  expect(code.ok(), await code.text()).toBe(true);
  const { deepLink } = (await code.json()) as TelegramLinkCodeResponse;
  const since = bot.calls().length;
  bot.inject.command(tgAlice, "start", new URL(deepLink).searchParams.get("start")!);
  await expectText(since, telegramConnectedText(aliceSession.user.displayName));
});

test.afterAll(async () => {
  try {
    if (adminSession) {
      const request = adminSession.page.request;
      const state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
      if (state.restricted) await setAccess(request, []);
      const current = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
      if (current.enabled) await admin(request, { action: "disable", expectedVersion: current.version });
    }
  } finally {
    try {
      await restoreFakeContext?.();
      await assistants.cleanup();
      await people.cleanup();
      // Catalog fixtures go once no chat uses them.
      await secondModel?.cleanup();
      await searchSource?.cleanup();
    } finally {
      await bot.close();
      await prisma.$disconnect();
    }
  }
});

test("a text message becomes a new personal chat: a Thinking… draft, paced drafts and the rendered answer", async () => {
  const question = `Compare apples and pears. ${"Explain every detail. ".repeat(40).trim()}`;
  const since = bot.calls().length;
  const startedAt = Date.now();
  bot.inject.text(tgAlice, question);
  // The first Telegram message compiles the run pipeline under `next dev`.
  const answer = await nextAnswer(since, 120_000);
  const elapsed = Date.now() - startedAt;

  const chatId = (await currentChatId())!;
  expect(chatId).toBeTruthy();
  const listed = (await (await aliceSession.page.request.get("/api/chats")).json()) as { chats: Array<{ id: string }> };
  expect(listed.chats.map((chat) => chat.id)).toContain(chatId);
  const messages = await chatMessages(aliceSession.page, chatId);
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(messageText(messages[0]!)).toBe(question);
  const answerText = messageText(messages[1]!);
  expect(answerText).toContain("Fake answer:");

  // The final message is the renderer's output for the persisted answer, with Open in AIQSA on https.
  expect(answer.params.rich_message).toEqual(renderTelegramAnswer(answerText).messages[0]);
  expect(answer.params.reply_markup).toEqual(HTTPS_INSTALLATION
    ? { inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: expect.stringMatching(new RegExp(`/c/${chatId}$`, "u")) }]] }
    : undefined);

  // Thinking… first, then the answer so far, one draft id with Telegram's own Stop, at most one draft per 1.1 s.
  const drafts = [...callsSince(since, "sendMessageDraft", tgAlice.id), ...callsSince(since, "sendRichMessageDraft", tgAlice.id)];
  expect(callsSince(since, "sendMessageDraft", tgAlice.id)[0]!.params).toMatchObject({ can_stop: true, keep_on_stop: false, text: "" });
  expect(new Set(drafts.map((call) => call.params.draft_id)).size).toBe(1);
  for (const draft of drafts) expect(draft.params).toMatchObject({ can_stop: true, keep_on_stop: false });
  expect(drafts.length).toBeLessThanOrEqual(2 + Math.ceil(elapsed / 1_100));
  const run = await latestRun();
  expect(await prisma.telegramRunLink.findUnique({ select: { deliveryState: true }, where: { runId: run.id } }))
    .toEqual({ deliveryState: "delivered" });
});

test("the next message continues the chat, /new starts another, and a reply to an older answer continues its chat", async () => {
  const chatA = (await currentChatId())!;
  const firstAnswer = bot.botMessages(tgAlice.id).filter((message) => message.kind === "rich").at(-1)!;
  let since = bot.calls().length;
  bot.inject.text(tgAlice, "Second question about pears");
  await nextAnswer(since);
  expect(await currentChatId()).toBe(chatA);
  const continued = await chatMessages(aliceSession.page, chatA);
  expect(continued.filter((message) => message.role === "user")).toHaveLength(2);
  expect(messageText(continued.at(-1)!)).toContain("Context memory:");

  since = bot.calls().length;
  bot.inject.command(tgAlice, "new");
  await expectText(since, TELEGRAM_COPY.newChat);
  since = bot.calls().length;
  bot.inject.text(tgAlice, "A fresh topic");
  await nextAnswer(since);
  const chatB = (await currentChatId())!;
  expect(chatB).not.toBe(chatA);

  since = bot.calls().length;
  bot.inject.text(tgAlice, "Back to apples", { replyTo: firstAnswer.message_id });
  await nextAnswer(since);
  expect(await currentChatId()).toBe(chatA);
  const replied = await chatMessages(aliceSession.page, chatA);
  expect(replied.filter((message) => message.role === "user").map(messageText).at(-1)).toBe("Back to apples");
});

test("/chats switches to a chat started in the web and continues it", async () => {
  const title = `Web trip plan ${people.suffix}`;
  const created = await aliceSession.page.request.post("/api/chats", { data: { title } });
  expect(created.status()).toBe(201);
  const webChatId = ((await created.json()) as { chat: { id: string } }).chat.id;

  let since = bot.calls().length;
  bot.inject.command(tgAlice, "chats");
  await expect.poll(() => bot.botMessages(tgAlice.id).some((message) => message.text === TELEGRAM_BRIDGE_COPY.chatsTitle),
    { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  const choice = menuButton(TELEGRAM_BRIDGE_COPY.chatsTitle, title);
  bot.inject.callback(tgAlice, choice.messageId, choice.data);
  await expect.poll(() => botMessage(choice.messageId)?.text, { timeout: REPLY_TIMEOUT_MS }).toBe(telegramCurrentChatText(title));
  expect(await currentChatId()).toBe(webChatId);

  since = bot.calls().length;
  bot.inject.text(tgAlice, "Which hotels near the station?");
  await nextAnswer(since);
  const messages = await chatMessages(aliceSession.page, webChatId);
  expect(messages.map(messageText)[0]).toBe("Which hotels near the station?");
});

test("/assistant starts the next chat with the chosen assistant", async () => {
  const helper = await assistants.create(aliceSession.page.request, { name: "Telegram helper" });
  let since = bot.calls().length;
  bot.inject.command(tgAlice, "assistant");
  await expect.poll(() => bot.botMessages(tgAlice.id).some((message) => message.text === TELEGRAM_BRIDGE_COPY.assistantsTitle),
    { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  const choice = menuButton(TELEGRAM_BRIDGE_COPY.assistantsTitle, helper.name);
  bot.inject.callback(tgAlice, choice.messageId, choice.data);
  await expect.poll(() => botMessage(choice.messageId)?.text, { timeout: REPLY_TIMEOUT_MS }).toBe(telegramAssistantSelectedText(helper.name));

  since = bot.calls().length;
  bot.inject.text(tgAlice, "Plan a weekend trip");
  await nextAnswer(since);
  const chatId = (await currentChatId())!;
  expect(await prisma.chat.findUniqueOrThrow({ select: { assistantId: true }, where: { id: chatId } })).toEqual({ assistantId: helper.id });
  expect(await prisma.telegramLink.findUniqueOrThrow({ select: { pendingAssistantId: true }, where: { userId: aliceSession.user.id } }))
    .toEqual({ pendingAssistantId: null });
  bot.inject.command(tgAlice, "new");
  await expectText(since, TELEGRAM_COPY.newChat);
});

test("/model changes the model of the next run", async () => {
  secondModel = await createCatalogOnlyAnswerModel(prisma, "telegram-chat");
  bot.inject.command(tgAlice, "model");
  await expect.poll(() => bot.botMessages(tgAlice.id).some((message) => message.text === TELEGRAM_BRIDGE_COPY.modelsTitle),
    { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  // The list pages by eight: page on until the model shows.
  const labelsOf = (messageId: number) => ((botMessage(messageId)?.reply_markup ?? { inline_keyboard: [] }) as {
    inline_keyboard: Array<Array<{ text: string }>>;
  }).inline_keyboard.flat().map((button) => button.text).join("|");
  for (let page = 0; page < 10; page += 1) {
    const menu = bot.botMessages(tgAlice.id).filter((message) => message.text === TELEGRAM_BRIDGE_COPY.modelsTitle).at(-1)!;
    const labels = labelsOf(menu.message_id);
    if (labels.split("|").includes(secondModel.displayName)) break;
    const more = menuButton(TELEGRAM_BRIDGE_COPY.modelsTitle, TELEGRAM_BRIDGE_COPY.nextPage);
    bot.inject.callback(tgAlice, more.messageId, more.data);
    await expect.poll(() => labelsOf(more.messageId), { timeout: REPLY_TIMEOUT_MS }).not.toBe(labels);
  }
  const choice = menuButton(TELEGRAM_BRIDGE_COPY.modelsTitle, secondModel.displayName);
  bot.inject.callback(tgAlice, choice.messageId, choice.data);
  await expect.poll(() => botMessage(choice.messageId)?.text, { timeout: REPLY_TIMEOUT_MS }).toBe(telegramModelLabel(secondModel.displayName));

  const before = await latestRun();
  const asked = bot.calls().length;
  bot.inject.text(tgAlice, "Which model answers this?");
  // The synthetic model has no reachable provider: the message is refused (or, admitted, fails) for that
  // model with a visible reason, and the default model never answers it.
  await expect.poll(() => textsSince(asked, tgAlice.id).length, { timeout: REPLY_TIMEOUT_MS }).toBeGreaterThan(0);
  const latest = await latestRun();
  if (latest.id !== before.id) expect(latest.modelId).toBe(secondModel.providerModelId);
  expect(callsSince(asked, "sendRichMessage", tgAlice.id)).toEqual([]);
  // Back to the default model, in a chat that does not carry the synthetic one.
  await prisma.telegramLink.update({ data: { selectedModelId: null, selectedProvider: null }, where: { userId: aliceSession.user.id } });
  const next = bot.calls().length;
  bot.inject.command(tgAlice, "new");
  await expectText(next, TELEGRAM_COPY.newChat);
});

test("Search off in /settings sends no Search options", async () => {
  searchSource = await createCatalogOnlySearchSource(prisma, "telegram-chat");
  let since = bot.calls().length;
  bot.inject.text(tgAlice, "Search the web for apples");
  await nextAnswer(since);
  expect(searchOptionIds((await latestRun()).normalizedRequest).length).toBeGreaterThan(0);

  since = bot.calls().length;
  bot.inject.command(tgAlice, "settings");
  await expect.poll(() => bot.botMessages(tgAlice.id).some((message) => message.text === TELEGRAM_BRIDGE_COPY.settingsTitle),
    { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  const toggle = menuButton(TELEGRAM_BRIDGE_COPY.settingsTitle, "Search: on");
  bot.inject.callback(tgAlice, toggle.messageId, toggle.data);
  await expect.poll(() => (botMessage(toggle.messageId)!.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard
    .flat().map((button) => button.text), { timeout: REPLY_TIMEOUT_MS }).toContain("Search: off");

  since = bot.calls().length;
  bot.inject.text(tgAlice, "No search this time");
  await nextAnswer(since);
  expect(searchOptionIds((await latestRun()).normalizedRequest)).toEqual([]);
  await prisma.telegramLink.update({ data: { searchEnabled: true }, where: { userId: aliceSession.user.id } });
});

test("Stop from the draft and /stop cancel the answer", async () => {
  const first = await startLongAnswer();
  bot.inject.stopGeneration(tgAlice, first.draftId);
  await expectText(first.since, TELEGRAM_COPY.stopped);
  expect((await latestRun()).status).toBe("cancelled");

  const second = await startLongAnswer();
  bot.inject.command(tgAlice, "stop");
  await expectText(second.since, TELEGRAM_COPY.stopped);
  expect((await latestRun()).status).toBe("cancelled");

  const since = bot.calls().length;
  bot.inject.command(tgAlice, "stop");
  await expectText(since, TELEGRAM_BRIDGE_COPY.nothingRunning);
});

test("a message sent during a run is added to it as a follow-up", async () => {
  const { since } = await startLongAnswer();
  const run = await latestRun();
  const followup = bot.inject.text(tgAlice, "Also mention pears.");
  await expectText(since, TELEGRAM_COPY.followupAdded);
  await expect.poll(() => prisma.runFollowup.count({ where: { modelRunId: run.id, nonce: `tg-${followup.update_id}` } }),
    { timeout: REPLY_TIMEOUT_MS }).toBe(1);
  const stopFrom = bot.calls().length;
  bot.inject.command(tgAlice, "stop");
  await expectText(stopFrom, TELEGRAM_COPY.stopped);
});

test("a reply already running from the web blocks a Telegram message with its own text", async () => {
  const page = aliceSession.page;
  const title = `Busy web chat ${people.suffix}`;
  const created = await page.request.post("/api/chats", { data: { title } });
  expect(created.status()).toBe(201);
  const chatId = ((await created.json()) as { chat: { id: string } }).chat.id;
  const model = await prisma.providerModel.findUniqueOrThrow({ select: { connectionId: true, id: true }, where: { templateKey: "fake:fake-qsa" } });
  const body = {
    admissionId: randomUUID(), content: { blocks: [{ text: `Explain this synthetic example. ${"synthetic ".repeat(1_800)}`, type: "text" }] },
    expectedActiveLeafId: null, modelId: model.id, provider: model.connectionId, searchPlan: { mode: "all_selected", optionIds: [] },
    workspace: { enabled: false }
  };
  // The browser starts the answer and keeps its stream open while Telegram asks.
  const status = await page.evaluate(async ([target, payload]) => {
    const response = await fetch(`/api/chats/${target}/messages`, {
      body: JSON.stringify(payload), headers: { "content-type": "application/json" }, method: "POST"
    });
    void response.body?.getReader().read();
    return response.status;
  }, [chatId, body] as const);
  expect(status).toBe(200);
  try {
    let since = bot.calls().length;
    bot.inject.command(tgAlice, "chats");
    await expect.poll(() => bot.botMessages(tgAlice.id).filter((message) => message.text === TELEGRAM_BRIDGE_COPY.chatsTitle).length,
      { timeout: REPLY_TIMEOUT_MS }).toBeGreaterThan(1);
    const choice = menuButton(TELEGRAM_BRIDGE_COPY.chatsTitle, title);
    bot.inject.callback(tgAlice, choice.messageId, choice.data);
    await expect.poll(() => botMessage(choice.messageId)?.text, { timeout: REPLY_TIMEOUT_MS }).toBe(telegramCurrentChatText(title));
    since = bot.calls().length;
    bot.inject.text(tgAlice, "Is it done yet?");
    await expectText(since, TELEGRAM_RUN_REFUSAL_COPY.replyRunning);
  } finally {
    const run = await prisma.modelRun.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true }, where: { chatId } });
    if (run) await page.request.post(`/api/model-runs/${run.id}/cancel`);
  }
});

test("a usage limit shows its text with the time sending works again", async () => {
  const request = adminSession.page.request;
  const usage = decodeAdminUsageLimitsResponse(await (await request.get("/api/admin/usage-limits")).json());
  const sent = usage!.limits.users.find((row) => row.userId === aliceSession.user.id)!.messagesLastHour;
  expect(sent).toBeGreaterThan(0);
  const override = await request.put(`/api/admin/usage-limits/users/${aliceSession.user.id}`, {
    data: { exempt: false, messagesPerDay: null, messagesPerHour: sent, monthlyBudgetMicros: null }
  });
  expect(override.ok(), await override.text()).toBe(true);
  const version = decodeAdminUsageLimitsResponse(await override.json())!.limits.users
    .find((row) => row.userId === aliceSession.user.id)!.override!.version;
  try {
    const since = bot.calls().length;
    const runs = await prisma.modelRun.count({ where: { userId: aliceSession.user.id } });
    bot.inject.text(tgAlice, "One more question");
    await expectText(since, /^You've reached your limit of \d+ messages? per hour\. You can send again (in a minute|in \d+ min)\.$/u);
    expect(await prisma.modelRun.count({ where: { userId: aliceSession.user.id } })).toBe(runs);
  } finally {
    const removed = await request.delete(`/api/admin/usage-limits/users/${aliceSession.user.id}?expectedVersion=${version}`);
    expect(removed.ok(), await removed.text()).toBe(true);
  }
});

test("access turned off between messages refuses the next one and keeps the link and its chat", async () => {
  const chatId = await currentChatId();
  await setAccess(adminSession.page.request, [pilot.id]);
  try {
    const since = bot.calls().length;
    const runs = await prisma.modelRun.count({ where: { userId: aliceSession.user.id } });
    bot.inject.text(tgAlice, "Am I still connected?");
    await expectText(since, telegramReasonText("telegram_access_off")!);
    expect(await prisma.modelRun.count({ where: { userId: aliceSession.user.id } })).toBe(runs);
  } finally {
    await setAccess(adminSession.page.request, []);
  }
  const since = bot.calls().length;
  bot.inject.text(tgAlice, "Access is back");
  await nextAnswer(since);
  expect(await currentChatId()).toBe(chatId);
});
