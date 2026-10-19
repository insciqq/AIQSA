import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { decodeChatDetailResponse, type ChatMessageWire } from "../../lib/contracts/chats";
import type { TelegramAdminCommand, TelegramAdminState, TelegramLinkCodeResponse } from "../../lib/contracts/telegram";
import type { ContentBlock } from "../../lib/domain/content";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import {
  TELEGRAM_COPY, TELEGRAM_MEDIA_COPY, telegramConnectedText, telegramReasonText, telegramUnsupportedFileText, telegramVoiceTranscriptText
} from "../../lib/server/telegram/copy";
import { telegramAttachmentTypeNames } from "../../lib/server/telegram/media/plan";
import { createFakeTelegramBotApi, type FakeTelegramCall, type FakeTelegramUser } from "../support/fakeTelegramBotApi";
import { createPeopleFixture, type E2ESession } from "./support/people";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";

/**
 * Voice messages, photos, albums and documents from Telegram end to end: the
 * fake Bot API on the loopback origin the web server reads in test mode
 * (inbound through its `getUpdates` queue, files through `getFile`), a local
 * stub Speech to text server behind the administrator's role (as the
 * dictation spec installs it), the product's own upload route checks and the
 * fake LLM. Every scenario checks what reached Telegram and what the web
 * chat holds. The spec owns its own bot identity, so its update ids,
 * receipts and poll offset never meet the other Telegram specs'.
 */

test.describe.configure({ mode: "serial", timeout: 120_000 });

const REPLY_TIMEOUT_MS = 30_000;
const MEDIA_BOT_TOKEN = "100000004:AAFakeTelegramMediaBotTokenForTests_000";
const MEDIA_BOT_USERNAME = "aiqsa_media_test_bot";
const FIRST_UPDATE_ID = Math.floor(Date.now() / 1_000);
const TELEGRAM_ID_BASE = 960_000_000_000 + (Date.now() % 10_000_000_000) * 10;
const STT_MODEL = "telegram-e2e-whisper-1";
const STT_KEY = "telegram-e2e-stt-key";
const TRANSCRIPT = "spoken words from telegram";

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const port = telegramE2eApiPort();
const bot = createFakeTelegramBotApi({ firstUpdateId: FIRST_UPDATE_ID, token: MEDIA_BOT_TOKEN, username: MEDIA_BOT_USERNAME });

let adminSession: E2ESession;
let aliceSession: E2ESession;
let tgAlice: FakeTelegramUser;
let speech: Awaited<ReturnType<typeof installSpeechToTextFixture>> | null = null;

function callsSince(since: number, method: string, chatId: number): FakeTelegramCall[] {
  return bot.calls().slice(since).filter((call) => call.method === method && call.status === 200 && call.params.chat_id === chatId);
}

function textsSince(since: number): string[] {
  return callsSince(since, "sendMessage", tgAlice.id).map((call) => String(call.params.text));
}

async function expectText(since: number, text: string): Promise<void> {
  await expect.poll(() => textsSince(since), { timeout: REPLY_TIMEOUT_MS }).toContain(text);
}

function isTranscriptQuote(call: FakeTelegramCall): boolean {
  const blocks = (call.params.rich_message as { blocks?: Array<{ type: string }> } | undefined)?.blocks ?? [];
  return blocks.length === 1 && blocks[0]!.type === "blockquote";
}

/** The transcript quotes the bot sent since `since`. */
function quotesSince(since: number): FakeTelegramCall[] {
  return callsSince(since, "sendRichMessage", tgAlice.id).filter(isTranscriptQuote);
}

async function nextAnswer(since: number, timeout = REPLY_TIMEOUT_MS): Promise<FakeTelegramCall> {
  const answers = () => callsSince(since, "sendRichMessage", tgAlice.id).filter((call) => !isTranscriptQuote(call));
  try {
    await expect.poll(() => answers().length, { timeout }).toBeGreaterThan(0);
  } catch (error) {
    const seen = bot.calls().slice(since).filter((call) => call.method !== "getUpdates")
      .map((call) => `${call.method}:${call.status}${call.method === "sendMessage" ? ` ${JSON.stringify(String(call.params.text).slice(0, 160))}` : ""}`)
      .join(", ") || "nothing";
    throw new Error(`no rich answer within ${timeout} ms; the bot sent: ${seen}`, { cause: error });
  }
  return answers()[0]!;
}

/** `/new`: the next request starts its own chat, so earlier images do not fill the fake model's context. */
async function startNewChat(): Promise<void> {
  const since = bot.calls().length;
  bot.inject.command(tgAlice, "new");
  await expectText(since, TELEGRAM_COPY.newChat);
}

async function currentChatId(): Promise<string> {
  const link = await prisma.telegramLink.findUniqueOrThrow({ select: { currentChatId: true }, where: { userId: aliceSession.user.id } });
  expect(link.currentChatId).toBeTruthy();
  return link.currentChatId!;
}

async function chatMessages(page: Page, chatId: string): Promise<ChatMessageWire[]> {
  const detail = decodeChatDetailResponse(await (await page.request.get(`/api/chats/${chatId}`)).json());
  expect(detail).not.toBeNull();
  return detail!.messages;
}

/** The content blocks of the newest user message of the link's current chat. */
async function lastQuestion(): Promise<ContentBlock[]> {
  const messages = await chatMessages(aliceSession.page, await currentChatId());
  const question = messages.filter((message) => message.role === "user").at(-1);
  expect(question).toBeTruthy();
  return (question!.content as { blocks: ContentBlock[] }).blocks;
}

async function runCount(): Promise<number> {
  return prisma.modelRun.count({ where: { userId: aliceSession.user.id } });
}

async function admin(request: APIRequestContext, command: TelegramAdminCommand): Promise<TelegramAdminState> {
  const response = await request.patch("/api/admin/telegram", { data: command });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TelegramAdminState;
}

/** This spec's bot, switched on and open to everyone. */
async function enableMediaBot(request: APIRequestContext): Promise<void> {
  let state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
  if (state.enabled) state = await admin(request, { action: "disable", expectedVersion: state.version });
  if (state.restricted) state = await admin(request, { action: "set_access", expectedVersion: state.version, groupIds: [], restricted: false });
  state = await admin(request, { action: "test_and_save", expectedVersion: state.version, token: MEDIA_BOT_TOKEN });
  await admin(request, { action: "enable", expectedVersion: state.version });
}

/**
 * A stub OpenAI-compatible transcription server behind a provider connection,
 * as the dictation spec installs it; `configure` assigns the Speech to text
 * role as a passing administrator Test leaves it, `unassign` clears it. The
 * installation's previous role comes back on cleanup.
 */
async function installSpeechToTextFixture() {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const calls: Array<Readonly<{ authorized: boolean; ogg: boolean }>> = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const authorized = request.headers.authorization === `Bearer ${STT_KEY}`;
      if (request.method === "POST" && request.url === "/audio/transcriptions") {
        calls.push({ authorized, ogg: body.includes(Buffer.from("OggS")) });
        send(authorized ? { text: ` ${TRANSCRIPT} `, usage: { seconds: 1, cost: 0.0001 } } : {}, authorized ? 200 : 401);
        return;
      }
      send({}, 404);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID();
  const startedAt = new Date();
  const prior = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" }, select: {
    speechToTextConfiguredAt: true, speechToTextConnectionId: true, speechToTextCredentialVersionId: true, speechToTextModelId: true } });
  const unassigned = { speechToTextConfiguredAt: null, speechToTextConnectionId: null, speechToTextCredentialVersionId: null,
    speechToTextModelId: null };

  async function cleanup() {
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: prior });
    await prisma.usageEvent.deleteMany({ where: { modelId: STT_MODEL, createdAt: { gte: startedAt } } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  try {
    const config = { apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, authenticationMode: "bearer",
      allowPrivateNetwork: true, responseTimeoutMs: 30_000 };
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Telegram speech fixture", family: "openai_compatible",
      enabled: true, draftConfig: config, activeConfig: config, activeVersion: 1, activatedAt: new Date() } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(),
      testedAt: new Date(), testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({ credentialId,
        valueId: credentialVersionId, key: getSecretEncryptionKey(), secret: STT_KEY }) } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    calls, cleanup, startedAt,
    async configure() {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { speechToTextConfiguredAt: new Date(),
        speechToTextConnectionId: connectionId, speechToTextCredentialVersionId: credentialVersionId, speechToTextModelId: STT_MODEL } });
    },
    async unassign() {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: unassigned });
    }
  };
}

async function samplePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage().drawText("Quarterly totals: 42");
  return Buffer.from(await document.save());
}

test.beforeAll(async ({ browser }) => {
  // Two cold `next dev` sign-ins compile the login and chat pages first.
  test.setTimeout(180_000);
  await bot.start({ port });
  tgAlice = bot.inject.addUser({ firstName: "Alice", id: TELEGRAM_ID_BASE + 1, username: `tg_media_alice_${people.suffix}` });
  const [adminUser, alice] = await Promise.all([people.admin("Telegram media admin"), people.user("Telegram media Alice")]);
  adminSession = await people.signIn(browser, adminUser!);
  aliceSession = await people.signIn(browser, alice!);
  speech = await installSpeechToTextFixture();
  await enableMediaBot(adminSession.page.request);

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
      if (state.enabled) await admin(request, { action: "disable", expectedVersion: state.version });
    }
  } finally {
    try {
      await speech?.cleanup();
      await people.cleanup();
    } finally {
      await bot.close();
      await prisma.$disconnect();
    }
  }
});

test("a voice note becomes the transcript quote and a run with that text, accounted as Speech to text", async () => {
  await speech!.configure();
  const since = bot.calls().length;
  const voice = bot.inject.voice(tgAlice, { duration: 180 });
  // The first Telegram run compiles the run pipeline under `next dev`.
  const answer = await nextAnswer(since, 120_000);

  const [quote] = quotesSince(since);
  expect(quote, "transcript quote").toBeTruthy();
  expect(quote!.params.rich_message).toEqual({
    blocks: [{ blocks: [{ text: telegramVoiceTranscriptText(TRANSCRIPT), type: "paragraph" }], type: "blockquote" }],
    skip_entity_detection: true
  });
  expect(quote!.params.reply_parameters).toMatchObject({ message_id: (voice.message as { message_id: number }).message_id });
  expect(bot.calls().slice(since).indexOf(quote!)).toBeLessThan(bot.calls().slice(since).indexOf(answer));
  expect(speech!.calls.at(-1)).toEqual({ authorized: true, ogg: true });
  expect(await lastQuestion()).toEqual([{ text: TRANSCRIPT, type: "text" }]);
  expect(await prisma.usageEvent.count({
    where: { createdAt: { gte: speech!.startedAt }, modelId: STT_MODEL, purpose: "speech_to_text", userId: aliceSession.user.id }
  })).toBe(1);
});

test("an over-long or oversized voice note is refused before it is downloaded", async () => {
  const since = bot.calls().length;
  const runs = await runCount();
  bot.inject.voice(tgAlice, { duration: 601 });
  await expectText(since, telegramReasonText("telegram_voice_too_long")!);
  bot.inject.voice(tgAlice, { declaredSize: 10 * 1024 * 1024 + 1, duration: 30 });
  await expectText(since, TELEGRAM_MEDIA_COPY.voiceTooLarge);
  expect(bot.calls().slice(since).filter((call) => call.method === "getFile")).toHaveLength(0);
  expect(await runCount()).toBe(runs);
});

test("without a Speech to text role a voice note says voice messages are not set up", async () => {
  await speech!.unassign();
  try {
    const since = bot.calls().length;
    const transcriptions = speech!.calls.length;
    bot.inject.voice(tgAlice, { duration: 5 });
    await expectText(since, "Voice messages are not set up on this AIQSA.");
    expect(bot.calls().slice(since).filter((call) => call.method === "getFile")).toHaveLength(0);
    expect(speech!.calls).toHaveLength(transcriptions);
  } finally {
    await speech!.configure();
  }
});

test("a photo with a caption reaches the model as an image block plus the caption", async () => {
  const since = bot.calls().length;
  bot.inject.photo(tgAlice, { caption: "What is on the diagram?" });
  await nextAnswer(since);

  const blocks = await lastQuestion();
  expect(blocks).toEqual([{ text: "What is on the diagram?", type: "text" }, expect.objectContaining({ type: "image" })]);
  const image = blocks[1] as Extract<ContentBlock, { type: "image" }>;
  expect(await prisma.attachment.findUniqueOrThrow({ select: { fileName: true, kind: true, status: true, userId: true }, where: { id: image.attachmentId } }))
    .toEqual({ fileName: expect.stringMatching(/^photo-.+\.jpg$/u), kind: "image", status: "ready", userId: aliceSession.user.id });
});

test("an album of three photos becomes one run with three images", async () => {
  await startNewChat();
  const runs = await runCount();
  const since = bot.calls().length;
  bot.inject.album(tgAlice, 3, { caption: "Compare these three" });
  await nextAnswer(since);
  // Nothing else follows: the album was one request.
  await expect.poll(runCount, { timeout: 5_000 }).toBe(runs + 1);

  const blocks = await lastQuestion();
  expect(blocks[0]).toEqual({ text: "Compare these three", type: "text" });
  expect(blocks.slice(1).map((block) => block.type)).toEqual(["image", "image", "image"]);
});

test("a PDF document becomes a file attachment under its own name", async () => {
  await startNewChat();
  const since = bot.calls().length;
  bot.inject.document(tgAlice, { bytes: await samplePdf(), caption: "Check the totals", fileName: "Q3 report.pdf", mimeType: "application/pdf" });
  await nextAnswer(since);

  const blocks = await lastQuestion();
  expect(blocks).toEqual([
    { text: "Check the totals", type: "text" },
    { attachmentId: expect.any(String), fileName: "Q3 report.pdf", type: "file" }
  ]);
  const file = blocks[1] as Extract<ContentBlock, { type: "file" }>;
  expect(await prisma.attachment.findUniqueOrThrow({ select: { kind: true, mimeType: true }, where: { id: file.attachmentId } }))
    .toEqual({ kind: "pdf", mimeType: "application/pdf" });
});

test("a forbidden type and a 25 MB file are refused before download, a renamed binary by the upload's own checks", async () => {
  const runs = await runCount();
  const unsupported = telegramUnsupportedFileText(telegramAttachmentTypeNames(), true);
  let since = bot.calls().length;
  bot.inject.document(tgAlice, { bytes: Buffer.from("MZ synthetic"), fileName: "setup.exe", mimeType: "application/x-msdownload" });
  await expectText(since, unsupported);
  bot.inject.document(tgAlice, { bytes: Buffer.alloc(25_000_000), fileName: "big.pdf", mimeType: "application/pdf" });
  await expectText(since, telegramReasonText("telegram_file_too_large")!);
  expect(bot.calls().slice(since).filter((call) => call.method === "getFile")).toHaveLength(0);

  since = bot.calls().length;
  bot.inject.document(tgAlice, { bytes: randomBytes(64), fileName: "renamed.pdf", mimeType: "application/pdf" });
  await expectText(since, unsupported);
  // This one was downloaded and offered to the upload, which looked at its bytes.
  expect(bot.calls().slice(since).filter((call) => call.method === "getFile")).toHaveLength(1);
  expect(await prisma.attachment.count({ where: { fileName: "renamed.pdf", userId: aliceSession.user.id } })).toBe(0);

  since = bot.calls().length;
  bot.inject.sticker(tgAlice);
  await expectText(since, telegramReasonText("telegram_unsupported_message")!);
  expect(await runCount()).toBe(runs);
});
