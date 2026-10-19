import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { decodeChatDetailResponse, type ChatMessageWire } from "../../lib/contracts/chats";
import type { TelegramAdminState, TelegramCallbackKind, TelegramLinkCodeResponse } from "../../lib/contracts/telegram";
import type { ContentBlock } from "../../lib/domain/content";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { createTelegramTransport, type TelegramUploadFile } from "../../lib/server/telegram/transport";
import { runAccountMenuAction } from "./shell/page";
import { PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, paidEnv, setupCodexLbAnswerModel, waitForCatalogModel, type PaidAnswerModel } from "./support/paidProviders";
import { createPeopleFixture, type E2ESession } from "./support/people";

/**
 * Opt-in checks against the real Telegram Bot API (PRD §12).
 *
 * Linking: the administrator API saves a real bot token and enables the bot,
 * a user connects from Settings, and the `/start <code>` Telegram would
 * deliver is fed from a real private chat id through the test-mode update
 * route, so the bot's confirmation and disconnect replies reach that chat.
 * Runs only when AIQSA_TELEGRAM_LIVE_TOKEN_FILE and
 * AIQSA_TELEGRAM_LIVE_CHAT_ID_FILE name readable files and the web server
 * talks to https://api.telegram.org (AIQSA_TELEGRAM_API_ORIGIN).
 *
 * Paid scenarios (PRD §12.6), additionally gated on
 * AIQSA_TELEGRAM_LIVE_PAID=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL
 * on a disposable test-mode stand: a codex-lb answer model chosen through
 * `/model`, questions, continuation, `/new`, a reply, `/chats`, `/settings`,
 * a follow-up and `/stop` on a long answer, a photo and a PDF, and a
 * scheduled task delivered to Telegram, then Disconnect. Inbound updates are
 * injected on behalf of the operator's private chat; everything the bot
 * sends goes to the real Telegram, which the spec cannot read, so each
 * scenario is proven from server state (run links, message references,
 * button rows, chats, the poller's health). The photo and the PDF get real
 * `file_id`s by having the bot send them to that chat first; to press a menu
 * button in place, the spec learns the menu's message id by sending a probe
 * message right after it (private-chat message ids are sequential) and
 * deleting the probe. Roughly ten short paid turns plus one long answer that
 * `/stop` cuts off.
 *
 * Neither the token, the chat id nor the codex-lb key is printed; traces,
 * screenshots and videos stay off and assertions name only booleans, states
 * and status codes.
 */

const tokenFile = process.env.AIQSA_TELEGRAM_LIVE_TOKEN_FILE?.trim();
const chatIdFile = process.env.AIQSA_TELEGRAM_LIVE_CHAT_ID_FILE?.trim();
const live = Boolean(tokenFile && chatIdFile);
const paid = live && process.env.AIQSA_TELEGRAM_LIVE_PAID === "DISPOSABLE" && paidEnv("CODEX_LB_API_KEY") !== null &&
  paidEnv("CODEX_LB_BASE_URL") !== null;

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.use({ screenshot: "off", trace: "off", video: "off" });
test.skip(!live, "live Telegram check is opt-in");

const REPLY_TIMEOUT_MS = 30_000;
const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);

let adminSession: E2ESession;
let userSession: E2ESession;
/** Scheduled tasks the paid section created; removed so no later occurrence runs on the stand. */
const taskIds: string[] = [];
/** Injected update ids: far above the real bot's own, unique within the run. */
let nextUpdateId = Date.now();

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

async function disconnectFromSettings(page: Page): Promise<void> {
  const settings = await openTelegramSettings(page);
  await settings.getByTestId("settings-telegram-disconnect").click();
  await settings.getByTestId("settings-telegram-disconnect-confirm").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(settings.getByTestId("settings-telegram-state")).toHaveText("Not connected");
}

/** What Telegram delivers when the chat's owner presses Start on the deep link. */
async function injectStart(request: APIRequestContext, chatId: number, code: string): Promise<void> {
  const text = `/start ${code}`;
  const response = await request.post("/api/test/telegram/updates", {
    data: {
      update_id: nextUpdateId++,
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
  // Cold `next dev` sign-ins compile the login and chat pages first.
  test.setTimeout(180_000);
  const [admin, user] = await Promise.all([people.admin("Telegram live admin"), people.user("Telegram live user")]);
  adminSession = await people.signIn(browser, admin!);
  userSession = await people.signIn(browser, user!);
  await disableBot(adminSession.page.request);
});

test.afterAll(async () => {
  try {
    // Stop polling the real bot so the next installation can take it over.
    if (taskIds.length) await prisma.scheduledTask.deleteMany({ where: { id: { in: taskIds } } });
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

  await disconnectFromSettings(userSession.page);
  expect((await adminState(request)).health.lastFailureCode).toBeNull();
});

// ---------------------------------------------------------------------------
// Paid scenarios with a real chat model (PRD §4, §12.6)

test.describe("with a real chat model", () => {
  test.skip(!paid, "paid: requires AIQSA_TELEGRAM_LIVE_PAID=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL on a disposable test-mode stand");
  test.describe.configure({ timeout: PAID_SETUP_TIMEOUT_MS });

  const ACTIVE_RUN_STATUSES: readonly string[] = ["preparing", "queued", "streaming", "in_progress"];
  const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "telegram");
  const SENDER_NAME = "AIQSA live check";

  let token = "";
  let chatId = 0;
  let transport: ReturnType<typeof createTelegramTransport>;
  let model: PaidAnswerModel;
  let linkId = "";
  /** Inbound message ids: Telegram never assigned them, so replies to them go out without a quote. */
  let nextMessageId = 1_900_000_000;
  let firstChatId = "";
  let firstAnswerTelegramId = 0;
  let secondChatId = "";
  let searchOptionsBeforeToggle = 0;

  type Button = Readonly<{ id: string; kind: string; payload: Readonly<Record<string, unknown>> }>;

  const nowSeconds = () => Math.floor(Date.now() / 1_000);
  const operatorChat = () => ({ first_name: SENDER_NAME, id: chatId, type: "private" });
  const operatorUser = () => ({ first_name: SENDER_NAME, id: chatId, is_bot: false });

  async function expectHealthy(): Promise<void> {
    expect((await adminState(adminSession.page.request)).health.lastFailureCode).toBeNull();
  }

  /** Polls until `probe` yields a value. */
  async function eventually<T>(probe: () => Promise<T | null | undefined>, timeout = PAID_TURN_TIMEOUT_MS): Promise<T> {
    const box: { value?: T } = {};
    await expect.poll(async () => {
      const value = await probe();
      if (value === null || value === undefined) return false;
      box.value = value;
      return true;
    }, { intervals: [1_000], timeout }).toBe(true);
    return box.value!;
  }

  /** One update from the operator's private chat, as Telegram would deliver it; returns its `update_id` once handled. */
  async function inject(body: Readonly<Record<string, unknown>>): Promise<number> {
    const updateId = nextUpdateId++;
    const response = await userSession.page.request.post("/api/test/telegram/updates", { data: { update_id: updateId, ...body } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ claimed: true, settled: true });
    return updateId;
  }

  function message(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return { message: { chat: operatorChat(), date: nowSeconds(), from: operatorUser(), message_id: nextMessageId++, ...fields } };
  }

  function sendText(text: string, replyTo?: number): Promise<number> {
    return inject(message({
      text, ...(replyTo === undefined ? {} : { reply_to_message: { chat: operatorChat(), date: nowSeconds(), message_id: replyTo } })
    }));
  }

  function sendCommand(name: string): Promise<number> {
    return inject(message({ entities: [{ length: name.length + 1, offset: 0, type: "bot_command" }], text: `/${name}` }));
  }

  /** A press on the button stored as `callbackId`, on the bot message `menuMessageId`. */
  async function press(callbackId: string, menuMessageId: number): Promise<void> {
    await inject({ callback_query: {
      chat_instance: "aiqsa-live-check", data: `c:${callbackId}`, from: operatorUser(), id: `aiqsa-live-${nextUpdateId}`,
      message: { chat: operatorChat(), message_id: menuMessageId }
    } });
  }

  /** One direct Bot API call as the bot; a 429 is waited out, any other failure names only its kind and code. */
  async function botRequest(send: () => ReturnType<typeof transport.call>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await send();
      if (outcome.ok) return outcome.result;
      if (attempt < 2 && outcome.kind === "telegram" && outcome.errorCode === 429) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(outcome.retryAfter ?? 1, 30) * 1_000));
        continue;
      }
      throw new Error(`telegram_live_bot_call_failed:${outcome.kind}:${outcome.errorCode ?? outcome.status ?? "none"}`);
    }
  }

  function botCall(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    return botRequest(() => transport.call({ method, params, token }));
  }

  /** The bot sends a file to the operator's chat; Telegram's raw message, with the file ids it assigned. */
  async function botUpload(method: "sendDocument" | "sendPhoto", file: TelegramUploadFile, caption: string): Promise<Record<string, unknown>> {
    return await botRequest(() => transport.upload({
      fields: { caption, chat_id: String(chatId), disable_notification: "true" }, file, method, token
    })) as Record<string, unknown>;
  }

  /**
   * The id of the bot's newest message in the operator's chat. Private-chat
   * message ids are sequential and injected updates take none, so a probe
   * sent right after a menu has the menu's id plus one; it is deleted again.
   */
  async function lastBotMessageId(): Promise<number> {
    const probe = await botCall("sendMessage", {
      chat_id: chatId, disable_notification: true, text: "AIQSA live check: locating the menu."
    }) as { message_id: number };
    await botCall("deleteMessage", { chat_id: chatId, message_id: probe.message_id });
    return probe.message_id - 1;
  }

  async function currentLink() {
    return prisma.telegramLink.findUniqueOrThrow({ where: { userId: userSession.user.id } });
  }

  async function buttons(): Promise<Button[]> {
    const rows = await prisma.telegramCallback.findMany({ select: { id: true, kind: true, payload: true }, where: { linkId } });
    return rows.map((row) => ({ id: row.id, kind: row.kind, payload: (row.payload ?? {}) as Record<string, unknown> }));
  }

  async function buttonIds(): Promise<Set<string>> {
    return new Set((await buttons()).map((row) => row.id));
  }

  /** A button stored after `before` was taken: the keyboard a menu was just sent or redrawn with. */
  async function newButton(
    before: ReadonlySet<string>, kind: TelegramCallbackKind, match: (payload: Readonly<Record<string, unknown>>) => boolean = () => true
  ): Promise<Button | null> {
    return (await buttons()).find((row) => !before.has(row.id) && row.kind === kind && match(row.payload)) ?? null;
  }

  async function runIds(): Promise<Set<string>> {
    return new Set((await prisma.modelRun.findMany({ select: { id: true }, where: { userId: userSession.user.id } })).map((run) => run.id));
  }

  function newRun(before: ReadonlySet<string>): Promise<ModelRun> {
    return eventually(() => prisma.modelRun.findFirst({
      orderBy: { createdAt: "asc" }, where: { id: { notIn: [...before] }, userId: userSession.user.id }
    }));
  }

  function settledRun(runId: string): Promise<ModelRun> {
    return eventually(async () => {
      const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
      return ACTIVE_RUN_STATUSES.includes(run.status) ? null : run;
    });
  }

  async function expectDelivered(runId: string): Promise<void> {
    await expect.poll(async () => (await prisma.telegramRunLink.findUnique({ select: { deliveryState: true }, where: { runId } }))?.deliveryState ?? null,
      { intervals: [1_000], timeout: PAID_TURN_TIMEOUT_MS }).toBe("delivered");
  }

  /** The bot messages that carried the run's answer (and its ending), oldest first. */
  async function answerRefs(run: ModelRun) {
    expect(run.assistantMessageId).toBeTruthy();
    return prisma.telegramMessageRef.findMany({
      orderBy: { telegramMessageId: "asc" }, where: { chatId: run.chatId, linkId, messageId: run.assistantMessageId }
    });
  }

  /** Sends one update through `send`; its run completes and its answer is delivered to Telegram. */
  async function turn(send: () => Promise<number>): Promise<ModelRun> {
    const before = await runIds();
    await send();
    const run = await settledRun((await newRun(before)).id);
    expect(run.status).toBe("complete");
    expect(run.modelId).toBe(model.modelId);
    await expectDelivered(run.id);
    expect((await answerRefs(run)).length).toBeGreaterThan(0);
    await expectHealthy();
    return run;
  }

  async function chatMessages(chat: string): Promise<ChatMessageWire[]> {
    const response = await userSession.page.request.get(`/api/chats/${chat}`);
    expect(response.status()).toBe(200);
    const detail = decodeChatDetailResponse(await response.json());
    expect(detail).not.toBeNull();
    return detail!.messages;
  }

  function messageText(entry: ChatMessageWire): string {
    return textFromContentBlocks(entry.content as { blocks?: unknown[] });
  }

  /** The run's answer and the question it answered, as the web chat shows them. */
  async function runMessages(run: ModelRun): Promise<Readonly<{ answer: ChatMessageWire; question: ChatMessageWire }>> {
    const messages = await chatMessages(run.chatId);
    const answer = messages.find((entry) => entry.id === run.assistantMessageId);
    const question = messages.find((entry) => entry.id === answer?.parentMessageId);
    expect(answer && question && question.role === "user").toBeTruthy();
    return { answer: answer!, question: question! };
  }

  async function questionBlocks(run: ModelRun): Promise<ContentBlock[]> {
    return ((await runMessages(run)).question.content as { blocks: ContentBlock[] }).blocks;
  }

  function searchOptionIds(normalizedRequest: unknown): string[] {
    const plan = (normalizedRequest as { searchPlan?: { options?: Array<{ optionId: string }> } } | null)?.searchPlan;
    return (plan?.options ?? []).map((option) => option.optionId);
  }

  test.beforeAll(async () => {
    test.setTimeout(PAID_SETUP_TIMEOUT_MS * 2);
    token = readSecretFile(tokenFile);
    chatId = Number(readSecretFile(chatIdFile));
    expect(Number.isSafeInteger(chatId) && chatId > 0).toBe(true);
    transport = createTelegramTransport({ env: {} });
    const request = adminSession.page.request;
    let state = await adminState(request);
    if (!state.tokenConfigured) state = await adminCommand(request, { action: "test_and_save", expectedVersion: state.version, token });
    if (!state.enabled) await adminCommand(request, { action: "enable", expectedVersion: state.version });

    // Images reach the model only when it declares vision; PDFs are read as text.
    model = await setupCodexLbAnswerModel(request, { label: "Telegram live", nativeSearch: false, vision: true });
    await waitForCatalogModel(userSession.page.request, model.connectionId, (candidate) => candidate.modelId === model.modelId);

    const code = await userSession.page.request.post("/api/me/telegram/link-code");
    expect(code.ok()).toBe(true);
    const { deepLink } = (await code.json()) as TelegramLinkCodeResponse;
    await injectStart(userSession.page.request, chatId, new URL(deepLink).searchParams.get("start")!);
    linkId = (await currentLink()).id;
    await expectHealthy();
  });

  test("/model picks the codex-lb model for the next messages through its menu buttons", async () => {
    let seen = await buttonIds();
    await sendCommand("model");
    const menuId = await lastBotMessageId();
    let choice: Button | null = null;
    // The menu lists eight models a page: page on, in place, until the model shows.
    for (let page = 0; page < 20; page += 1) {
      const fresh = (await buttons()).filter((row) => !seen.has(row.id));
      choice = fresh.find((row) => row.kind === "select_model" && row.payload.modelId === model.modelId &&
        row.payload.provider === model.connectionId) ?? null;
      if (choice) break;
      const next = fresh.find((row) => row.kind === "model_page" && row.payload.page === page + 1);
      expect(next).toBeTruthy();
      seen = await buttonIds();
      await press(next!.id, menuId);
    }
    expect(choice).toBeTruthy();
    await press(choice!.id, menuId);
    await expect.poll(async () => {
      const link = await currentLink();
      return [link.selectedModelId, link.selectedProvider];
    }, { timeout: REPLY_TIMEOUT_MS }).toEqual([model.modelId, model.connectionId]);
    await expectHealthy();
  });

  test("a question becomes a new personal chat: a Thinking draft, then the delivered answer", async () => {
    const question = "In one short sentence: why is the sky blue?";
    const run = await turn(() => sendText(question));
    // The answer streamed into a draft of its own before the final message.
    const runLink = await prisma.telegramRunLink.findUniqueOrThrow({ where: { runId: run.id } });
    expect(runLink.draftId).not.toBe(0);
    expect(Number(runLink.telegramChatId) === chatId).toBe(true);
    expect((await currentLink()).currentChatId).toBe(run.chatId);

    const listed = (await (await userSession.page.request.get("/api/chats")).json()) as { chats: Array<{ id: string }> };
    expect(listed.chats.map((chat) => chat.id)).toContain(run.chatId);
    const messages = await chatMessages(run.chatId);
    expect(messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(messageText(messages[0]!)).toBe(question);
    expect(messageText(messages[1]!).trim().length).toBeGreaterThan(0);
    firstChatId = run.chatId;
    firstAnswerTelegramId = Number((await answerRefs(run))[0]!.telegramMessageId);
  });

  test("the next message continues the chat, /new starts another, and a reply to the first answer continues its chat", async () => {
    const continued = await turn(() => sendText("In one short sentence: and why are sunsets red?"));
    expect(continued.chatId).toBe(firstChatId);
    expect((await chatMessages(firstChatId)).filter((entry) => entry.role === "user")).toHaveLength(2);

    await sendCommand("new");
    await expect.poll(async () => (await currentLink()).currentChatId, { timeout: REPLY_TIMEOUT_MS }).toBeNull();
    const fresh = await turn(() => sendText("In one short sentence: what is a haiku?"));
    expect(fresh.chatId).not.toBe(firstChatId);
    secondChatId = fresh.chatId;

    const reply = "In one short sentence: is the sky on Mars blue too?";
    const replied = await turn(() => sendText(reply, firstAnswerTelegramId));
    expect(replied.chatId).toBe(firstChatId);
    expect((await currentLink()).currentChatId).toBe(firstChatId);
    expect(messageText((await runMessages(replied)).question)).toBe(reply);
  });

  test("/chats switches the current chat in place and the next message lands there", async () => {
    const before = await buttonIds();
    await sendCommand("chats");
    const menuId = await lastBotMessageId();
    const choice = await newButton(before, "select_chat", (payload) => payload.chatId === secondChatId);
    expect(choice).toBeTruthy();
    await press(choice!.id, menuId);
    await expect.poll(async () => (await currentLink()).currentChatId, { timeout: REPLY_TIMEOUT_MS }).toBe(secondChatId);
    // The menu itself became "Current chat: …": only an edit in place refers that message to the chosen chat.
    await expect.poll(() => prisma.telegramMessageRef.count({ where: { chatId: secondChatId, linkId, telegramMessageId: BigInt(menuId) } }),
      { timeout: REPLY_TIMEOUT_MS }).toBe(1);

    const run = await turn(() => sendText("In one short sentence: name a famous haiku poet."));
    expect(run.chatId).toBe(secondChatId);
    searchOptionsBeforeToggle = searchOptionIds(run.normalizedRequest).length;
  });

  test("Search off in /settings sends the next run without Search options", async () => {
    expect((await currentLink()).searchEnabled).toBe(true);
    const before = await buttonIds();
    await sendCommand("settings");
    const menuId = await lastBotMessageId();
    const toggle = await newButton(before, "toggle_search");
    expect(toggle).toBeTruthy();
    const redrawn = await buttonIds();
    await press(toggle!.id, menuId);
    await expect.poll(async () => (await currentLink()).searchEnabled, { timeout: REPLY_TIMEOUT_MS }).toBe(false);
    // The menu was redrawn with a fresh Search button.
    expect(await newButton(redrawn, "toggle_search")).toBeTruthy();

    const run = await turn(() => sendText("In one short sentence: what is the capital of France?"));
    expect(searchOptionIds(run.normalizedRequest)).toEqual([]);
    // With no Search source on the stand the run before the toggle had none either; the fake Bot API spec covers that side.
    test.info().annotations.push({ description: `${searchOptionsBeforeToggle} Search option(s) before the toggle`, type: "search" });
  });

  test("a message during a long answer joins it as a follow-up, and /stop delivers the partial answer and Stopped", async () => {
    const before = await runIds();
    await sendText("Write a detailed essay of about 2000 words on the history of bridge engineering, with a heading for every era.");
    const started = await newRun(before);
    await expect.poll(async () => ["streaming", "in_progress"].includes((await prisma.modelRun.findUniqueOrThrow({ where: { id: started.id } })).status),
      { intervals: [500], timeout: PAID_TURN_TIMEOUT_MS }).toBe(true);

    const followup = await sendText("Also add one sentence about Roman aqueducts.");
    await expect.poll(() => prisma.runFollowup.count({ where: { modelRunId: started.id, nonce: `tg-${followup}` } }),
      { intervals: [500], timeout: REPLY_TIMEOUT_MS * 2 }).toBe(1);

    await sendCommand("stop");
    const run = await settledRun(started.id);
    expect(run.status).toBe("cancelled");
    expect(run.chatId).toBe(secondChatId);
    await expectDelivered(run.id);
    // The follow-up started no run of its own.
    expect(await prisma.modelRun.count({ where: { id: { notIn: [...before] }, userId: userSession.user.id } })).toBe(1);
    // Whatever was written went out, then the Stopped notice, both referring to the answer.
    const partial = messageText((await runMessages(run)).answer).trim();
    expect((await answerRefs(run)).length).toBeGreaterThanOrEqual(partial ? 2 : 1);
    test.info().annotations.push({ description: partial ? "partial answer delivered" : "stopped before any text", type: "stop" });
    await expectHealthy();
  });

  test("a photo with a caption reaches the model as an image block plus the caption", async () => {
    const sent = await botUpload("sendPhoto", {
      contentType: "image/jpeg", data: readFileSync(path.join(FIXTURES, "photo.jpg")), field: "photo", filename: "aiqsa-live-photo.jpg"
    }, "AIQSA live check: photo fixture") as { photo?: unknown };
    expect(Array.isArray(sent.photo) && sent.photo.length > 0).toBe(true);
    const caption = "In one short sentence: what does this image show?";
    const run = await turn(() => inject(message({ caption, photo: sent.photo })));
    expect(await questionBlocks(run)).toEqual([{ text: caption, type: "text" }, expect.objectContaining({ type: "image" })]);
  });

  test("a PDF document becomes a file block under its own name", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Quarterly totals: 42");
    const fileName = "AIQSA live totals.pdf";
    const sent = await botUpload("sendDocument", {
      contentType: "application/pdf", data: Buffer.from(await pdf.save()), field: "document", filename: fileName
    }, "AIQSA live check: PDF fixture") as { document?: Record<string, unknown> };
    expect(typeof sent.document?.file_id).toBe("string");
    const caption = "In one short sentence: what total does this PDF state?";
    const run = await turn(() => inject(message({ caption, document: { ...sent.document, file_name: fileName, mime_type: "application/pdf" } })));
    expect(await questionBlocks(run)).toEqual([{ text: caption, type: "text" }, { attachmentId: expect.any(String), fileName, type: "file" }]);
  });

  test("Run now of a scheduled task with Telegram delivery sends its result, referred to the task's chat", async () => {
    const request = userSession.page.request;
    const created = await request.post("/api/me/scheduled-tasks", { data: {
      chatMode: "new", emailNotify: false, historyRetentionDays: 90, kind: "standard", memoryEnabled: false, modelId: model.modelId,
      pinnedSkillIds: [], prompt: "In one short sentence, greet the reader.", provider: model.connectionId,
      schedule: { kind: "daily", time: "09:00" }, searchEnabled: false, telegramNotify: true, timeZone: "UTC", title: "Telegram live brief",
      toolsEnabled: false, workspaceEnabled: false
    } });
    expect(created.ok()).toBe(true);
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;
    taskIds.push(taskId);
    expect((await request.post(`/api/me/scheduled-tasks/${taskId}/run`)).ok()).toBe(true);

    const occurrence = await eventually(async () => {
      const row = await prisma.scheduledTaskOccurrence.findFirst({ orderBy: { createdAt: "desc" }, where: { taskId } });
      return row && ["COMPLETED", "FAILED", "SKIPPED"].includes(row.state) ? row : null;
    });
    expect(occurrence.state).toBe("COMPLETED");
    await expect.poll(async () => (await prisma.telegramScheduledDelivery.findUnique({ where: { occurrenceId: occurrence.id } }))?.state ?? null,
      { intervals: [1_000], timeout: PAID_TURN_TIMEOUT_MS }).toBe("sent");
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: occurrence.runId! } });
    expect(run.modelId).toBe(model.modelId);
    expect(await prisma.telegramMessageRef.count({ where: { chatId: occurrence.chatId!, linkId, messageId: run.assistantMessageId } }))
      .toBeGreaterThan(0);
    await expectHealthy();
  });

  test("Disconnect from Settings ends the link", async () => {
    await disconnectFromSettings(userSession.page);
    expect(await prisma.telegramLink.count({ where: { userId: userSession.user.id } })).toBe(0);
    await expectHealthy();
  });
});
