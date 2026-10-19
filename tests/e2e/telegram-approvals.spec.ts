import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import type { TelegramAdminCommand, TelegramAdminState, TelegramLinkCodeResponse } from "../../lib/contracts/telegram";
import {
  TELEGRAM_APPROVAL_COPY, TELEGRAM_COPY, telegramAlwaysAllowedText, telegramAlwaysAllowLabel, telegramConnectedText
} from "../../lib/server/telegram/copy";
import { createFakeTelegramBotApi, type FakeTelegramCall, type FakeTelegramMessage, type FakeTelegramUser } from "../support/fakeTelegramBotApi";
import { createWriteApprovalFixture, startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { createPeopleFixture, type E2ESession } from "./support/people";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";
import { prepareWorkspaceFakeContext } from "./support/workspaceFixture";

/**
 * MCP approvals as Telegram buttons, and the Workspace status with its files,
 * end to end on a disposable stand in test mode: the fake Bot API on the
 * loopback origin the web server reads (`AIQSA_TELEGRAM_API_ORIGIN`), inbound
 * updates through its `getUpdates` queue (the real poller, dispatcher and chat
 * bridge handle them), the fake LLM's scripted MCP call
 * (`[AIQSA_MCP_E2E:<tool>:<id>]`) against the synthetic records server, and
 * the deterministic Workspace runtime. The oracles are the endpoint's received
 * calls, the persisted approval rows and what reached Telegram, never model
 * wording. The spec owns its bot identity. Agent runs need a real Codex
 * provider: the Agent wording, the 5 s edit pacing and the 30 s wait for a
 * settling run are unit-tested in lib/server/telegram/{agentStatus,approvals}.test.ts.
 */

test.describe.configure({ mode: "serial", timeout: 180_000 });

const REPLY_TIMEOUT_MS = 60_000;
const APPROVAL_BOT_TOKEN = "100000006:AAFakeTelegramApprovalBotTokenForTests_00";
const APPROVAL_BOT_USERNAME = "aiqsa_approval_test_bot";
const FIRST_UPDATE_ID = Math.floor(Date.now() / 1_000) + 900_000;
const TELEGRAM_ID_BASE = 930_000_000_000 + (Date.now() % 10_000_000_000) * 10;
const APPROVAL_KINDS = ["approval_allow_once", "approval_allow_server", "approval_deny"] as const;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "in_progress", "streaming"] as const;

const prisma = new PrismaClient();
const people = createPeopleFixture(prisma);
const port = telegramE2eApiPort();
const bot = createFakeTelegramBotApi({ firstUpdateId: FIRST_UPDATE_ID, token: APPROVAL_BOT_TOKEN, username: APPROVAL_BOT_USERNAME });
const records = createWriteApprovalFixture();

let adminSession: E2ESession;
let aliceSession: E2ESession;
let tgAlice: FakeTelegramUser;
let tgStranger: FakeTelegramUser;
let endpoint: MutableMcpEndpoint | null = null;
let serverId: string | null = null;
let serverName = "";
let restoreFakeContext: (() => Promise<void>) | null = null;
let workspacePolicy: { enabled: boolean } | null = null;

function callsSince(since: number, method: string): FakeTelegramCall[] {
  return bot.calls().slice(since).filter((call) => call.method === method && call.status === 200 && call.params.chat_id === tgAlice.id);
}

function textsSince(since: number): string[] {
  return callsSince(since, "sendMessage").map((call) => String(call.params.text));
}

function shown(message: FakeTelegramMessage | undefined): string {
  return JSON.stringify(message?.rich_message ?? message?.text ?? "");
}

function botMessage(messageId: number): FakeTelegramMessage | undefined {
  return bot.botMessages(tgAlice.id).find((message) => message.message_id === messageId);
}

function approvalMessages(): FakeTelegramMessage[] {
  return bot.botMessages(tgAlice.id).filter((message) => shown(message).includes(`${serverName} · delete_record`));
}

function buttonRows(message: FakeTelegramMessage | undefined): Array<Array<{ callback_data?: string; text: string; url?: string }>> {
  return (message?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string; text: string; url?: string }>> } | undefined)
    ?.inline_keyboard ?? [];
}

/** Presses a button of a bot message as Alice (or another Telegram user): the press's callback data and query id. */
function press(message: FakeTelegramMessage, text: string, from: FakeTelegramUser = tgAlice): Readonly<{ data: string; queryId: string }> {
  const data = buttonRows(message).flat().find((button) => button.text === text)?.callback_data;
  expect(data, `button ${text}`).toBeTruthy();
  const update = bot.inject.callback(from, message.message_id, data!);
  return { data: data!, queryId: (update.callback_query as { id: string }).id };
}

async function expectAnswer(since: number, text: string, timeout = REPLY_TIMEOUT_MS): Promise<void> {
  try {
    await expect.poll(() => callsSince(since, "sendRichMessage").some((call) => JSON.stringify(call.params.rich_message).includes(text)),
      { timeout }).toBe(true);
  } catch (error) {
    // Name what the bot did instead, so a missing answer is diagnosable from the report.
    const seen = bot.calls().slice(since).filter((call) => call.method !== "getUpdates")
      .map((call) => `${call.method}:${call.status}${call.method === "sendMessage" ? ` ${JSON.stringify(String(call.params.text).slice(0, 160))}` : ""}`)
      .join(", ") || "nothing";
    throw new Error(`no answer with ${JSON.stringify(text)} within ${timeout} ms; the bot sent: ${seen}`, { cause: error });
  }
}

/** Sends a scripted delete in the current chat and waits for its approval message and its answer. */
async function askToDelete(id: string, timeout = REPLY_TIMEOUT_MS): Promise<FakeTelegramMessage> {
  const before = approvalMessages().length;
  const since = bot.calls().length;
  bot.inject.text(tgAlice, `Delete record ${id} [AIQSA_MCP_E2E:delete_record:${id}]`);
  await expectAnswer(since, "MCP call finished: mcp_approval_required.", timeout);
  await expect.poll(() => approvalMessages().length, { timeout: REPLY_TIMEOUT_MS }).toBe(before + 1);
  return approvalMessages().at(-1)!;
}

async function newChat(): Promise<void> {
  const since = bot.calls().length;
  bot.inject.command(tgAlice, "new");
  await expect.poll(() => textsSince(since), { timeout: REPLY_TIMEOUT_MS }).toContain(TELEGRAM_COPY.newChat);
}

async function currentChatId(): Promise<string> {
  const link = await prisma.telegramLink.findUniqueOrThrow({ select: { currentChatId: true }, where: { userId: aliceSession.user.id } });
  expect(link.currentChatId).toBeTruthy();
  return link.currentChatId!;
}

async function latestApproval(chatId: string) {
  return prisma.mcpToolApproval.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { chatId, toolTitle: "delete_record" } });
}

async function latestRun() {
  return prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "desc" }, select: { id: true, status: true }, where: { userId: aliceSession.user.id } });
}

/** The status message a run started after `before` recorded on its Telegram link, once it was sent. */
async function statusMessage(since: number, before: string): Promise<FakeTelegramMessage> {
  const recorded = async () => {
    // The message waits in the merge window first: until its run exists the newest run is the previous one.
    const run = await latestRun();
    if (run.id === before) return null;
    const link = await prisma.telegramRunLink.findUnique({ select: { statusMessageId: true }, where: { runId: run.id } });
    return link?.statusMessageId === null || link?.statusMessageId === undefined ? null : Number(link.statusMessageId);
  };
  await expect.poll(recorded, { timeout: 120_000 }).not.toBeNull();
  const status = botMessage((await recorded())!);
  expect(status, "the status message").toBeTruthy();
  // It went out as one plain message with Stop, working.
  expect(callsSince(since, "sendMessage").filter((call) => String(call.params.text).startsWith("Working in Workspace · "))).toHaveLength(1);
  return status!;
}

async function admin(request: APIRequestContext, command: TelegramAdminCommand): Promise<TelegramAdminState> {
  const response = await request.patch("/api/admin/telegram", { data: command });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TelegramAdminState;
}

/** This spec's bot, switched on and open to everyone. */
async function enableApprovalBot(request: APIRequestContext): Promise<void> {
  let state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
  if (state.enabled) state = await admin(request, { action: "disable", expectedVersion: state.version });
  if (state.restricted) state = await admin(request, { action: "set_access", expectedVersion: state.version, groupIds: [], restricted: false });
  state = await admin(request, { action: "test_and_save", expectedVersion: state.version, token: APPROVAL_BOT_TOKEN });
  await admin(request, { action: "enable", expectedVersion: state.version });
}

/** A published synthetic records server Alice may use: `read_record` read-only, `delete_record` destructive. */
async function createRecordsServer(request: APIRequestContext, userId: string, url: string): Promise<void> {
  serverName = `Approval records ${randomUUID().slice(0, 8)}`;
  const created = await request.post("/api/admin/mcp", { data: {
    activate: false,
    description: "Synthetic records server for Telegram approvals",
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 10_000, startupTimeoutMs: 10_000 }, slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url }, transport: "streamable_http" },
    name: serverName,
    sharedValues: {}
  } });
  expect(created.status(), await created.text()).toBe(201);
  const server = (await created.json() as { server: AdminMcpServer }).server;
  serverId = server.id;
  const checked = await request.post(`/api/admin/mcp/${server.id}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
  } });
  expect(checked.status(), await checked.text()).toBe(200);
  expect((await request.put(`/api/admin/mcp/${server.id}/grants`, { data: { canUse: true, personalSlotKeys: [], userId } })).ok()).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  // Two cold `next dev` sign-ins compile the login and chat pages first.
  test.setTimeout(180_000);
  await bot.start({ port });
  tgAlice = bot.inject.addUser({ firstName: "Alice", id: TELEGRAM_ID_BASE + 1, username: `tg_appr_alice_${people.suffix}` });
  tgStranger = bot.inject.addUser({ firstName: "Mallory", id: TELEGRAM_ID_BASE + 2 });
  const [adminUser, alice] = await Promise.all([people.admin("Telegram approvals admin"), people.user("Telegram approvals Alice")]);
  adminSession = await people.signIn(browser, adminUser!);
  aliceSession = await people.signIn(browser, alice!);
  // Load-all MCP tools beside the Workspace tool surface need the larger fake context the Workspace specs use.
  restoreFakeContext = await prepareWorkspaceFakeContext(prisma);
  workspacePolicy = await prisma.workspacePolicy.findUniqueOrThrow({ select: { enabled: true }, where: { id: "installation" } });
  await prisma.workspacePolicy.update({ data: { enabled: true }, where: { id: "installation" } });
  await enableApprovalBot(adminSession.page.request);

  endpoint = await startMutableMcpEndpoint(records.tools, { callTool: records.callTool });
  await createRecordsServer(adminSession.page.request, aliceSession.user.id, endpoint.url);
  const request = aliceSession.page.request;
  expect((await request.patch(`/api/me/mcp/${serverId}`, { data: { enabled: true } })).ok()).toBe(true);
  // The scripted call needs the tools listed up front: Load all is this synthetic account's default, as Telegram sends it.
  expect((await request.patch("/api/me/settings", { data: { defaultMcpMode: "load_all" } })).ok()).toBe(true);

  const code = await request.post("/api/me/telegram/link-code");
  expect(code.ok(), await code.text()).toBe(true);
  const { deepLink } = (await code.json()) as TelegramLinkCodeResponse;
  const since = bot.calls().length;
  bot.inject.command(tgAlice, "start", new URL(deepLink).searchParams.get("start")!);
  await expect.poll(() => textsSince(since), { timeout: REPLY_TIMEOUT_MS }).toContain(telegramConnectedText(aliceSession.user.displayName));
});

test.afterAll(async () => {
  // Cleanup may wait for a stopped Workspace session to be released.
  test.setTimeout(180_000);
  try {
    if (aliceSession) {
      // Nothing of Alice's may still run when her account is removed.
      const active = await prisma.modelRun.findMany({
        select: { id: true }, where: { status: { in: [...ACTIVE_RUN_STATUSES] }, userId: aliceSession.user.id }
      });
      for (const run of active) await aliceSession.page.request.post(`/api/model-runs/${run.id}/cancel`).catch(() => undefined);
    }
    if (adminSession) {
      const request = adminSession.page.request;
      const state = (await (await request.get("/api/admin/telegram")).json()) as TelegramAdminState;
      if (state.enabled) await admin(request, { action: "disable", expectedVersion: state.version });
      if (serverId) await request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    }
  } finally {
    try {
      if (workspacePolicy) await prisma.workspacePolicy.update({ data: workspacePolicy, where: { id: "installation" } }).catch(() => undefined);
      await restoreFakeContext?.();
      // Workspace sessions restrict their chat's deletion, so the runs and sessions go first (as the Workspace specs do).
      if (aliceSession) {
        const userId = aliceSession.user.id;
        // A stopped run's Workspace session is released shortly after the run settles: retry until it is.
        await expect.poll(() => prisma.$transaction(async (tx) => {
          await tx.providerRunBinding.deleteMany({ where: { modelRun: { userId } } });
          await tx.modelRun.deleteMany({ where: { userId } });
          await tx.workspaceSession.deleteMany({ where: { chat: { userId } } });
        }).then(() => "removed", (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : "failed")),
        { intervals: [2_000], timeout: 60_000 }).toBe("removed");
      }
      await people.cleanup();
    } finally {
      await endpoint?.close();
      await bot.close();
      await prisma.$disconnect();
    }
  }
});

test("a write tool asks in Telegram and sends nothing; Deny records the decision and starts nothing", async () => {
  // The first Telegram message compiles the run pipeline under `next dev`.
  const approval = await askToDelete("r-1", 120_000);
  expect(records.deleted()).toEqual([]);
  expect(endpoint!.dispatches("delete_record")).toBe(0);
  const blocks = (approval.rich_message as { blocks: Array<{ text?: unknown; type: string }> }).blocks;
  expect(blocks[0]).toEqual({ text: { text: `${serverName} · delete_record`, type: "bold" }, type: "paragraph" });
  expect(blocks[1]).toEqual({ text: TELEGRAM_APPROVAL_COPY.pendingModel, type: "paragraph" });
  // The request the model prepared, redacted and bounded as the web shows it.
  const request = blocks.find((block) => block.type === "pre");
  expect(String(request?.text)).toContain("\"id\": \"r-1\"");
  expect(String(request?.text).length).toBeLessThanOrEqual(1_500);
  expect(buttonRows(approval).map((row) => row.map((button) => button.text))).toEqual([
    [TELEGRAM_COPY.allowOnce, TELEGRAM_COPY.deny], [telegramAlwaysAllowLabel(serverName)]
  ]);
  const chatId = await currentChatId();
  const pending = await latestApproval(chatId);
  expect(pending).toMatchObject({ decision: null, source: "model" });

  const runs = await prisma.modelRun.count({ where: { chatId } });
  const pressed = press(approval, TELEGRAM_COPY.deny);
  await expect.poll(() => shown(botMessage(approval.message_id)), { timeout: REPLY_TIMEOUT_MS }).toContain(TELEGRAM_COPY.denied);
  expect(botMessage(approval.message_id)?.reply_markup).toBeUndefined();
  // The press is answered at once and without a pop-up; the message shows the outcome.
  expect(bot.callbackAnswer(pressed.queryId)).toMatchObject({ answered: true, text: undefined });
  // Decided with the button's own id as nonce.
  expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: pending.id } }))
    .toMatchObject({ decision: "deny", decisionNonce: pressed.data.slice(2) });
  // No continuation turn and no run: give a wrongly started one time to appear.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await prisma.modelRun.count({ where: { chatId } })).toBe(runs);
  expect(endpoint!.dispatches("delete_record")).toBe(0);
});

test("Allow once continues from the chat's leaf with exactly the approved call, once, never showing the server's turn", async () => {
  const approval = await askToDelete("r-2");
  const chatId = await currentChatId();
  const since = bot.calls().length;
  const pressed = press(approval, TELEGRAM_COPY.allowOnce);
  await expect.poll(() => shown(botMessage(approval.message_id)), { timeout: REPLY_TIMEOUT_MS }).toContain(TELEGRAM_COPY.allowedOnce);
  expect(botMessage(approval.message_id)?.reply_markup).toBeUndefined();
  await expectAnswer(since, "MCP call finished: done.");
  expect(endpoint!.dispatches("delete_record", { id: "r-2" })).toBe(1);
  expect(endpoint!.dispatches("delete_record")).toBe(1);
  expect(records.deleted()).toEqual(["r-2"]);

  const decided = await latestApproval(chatId);
  expect(decided).toMatchObject({ decision: "allow_once", decisionNonce: pressed.data.slice(2) });
  expect(decided.consumedAt).not.toBeNull();
  const continuation = await prisma.message.findFirstOrThrow({
    orderBy: { createdAt: "desc" }, where: { chatId, role: "user", systemTurnKind: "mcp_approval_continuation" }
  });
  expect(continuation.content).toEqual({ blocks: [{
    text: `The user approved \`delete_record\` on \`${serverName}\`. Continue the task.`, type: "text"
  }] });
  // The continuation turn is the server's, never shown in Telegram as Alice's message.
  for (const call of bot.calls().slice(since)) expect(JSON.stringify(call.params)).not.toContain("The user approved");

  // The same button again: used up, nothing decided or sent twice.
  const again = bot.inject.callback(tgAlice, approval.message_id, pressed.data);
  await expect.poll(() => bot.callbackAnswer((again.callback_query as { id: string }).id)?.answered).toBe(true);
  expect(bot.callbackAnswer((again.callback_query as { id: string }).id)?.text).toBe(TELEGRAM_COPY.buttonExpired);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(endpoint!.dispatches("delete_record")).toBe(1);
});

test("Always allow records the server's consent: the next call in a new chat runs without asking", async () => {
  await newChat();
  const approval = await askToDelete("r-3");
  const since = bot.calls().length;
  press(approval, telegramAlwaysAllowLabel(serverName));
  await expect.poll(() => shown(botMessage(approval.message_id)), { timeout: REPLY_TIMEOUT_MS })
    .toContain(telegramAlwaysAllowedText(serverName));
  await expectAnswer(since, "MCP call finished: done.");
  expect(endpoint!.dispatches("delete_record", { id: "r-3" })).toBe(1);
  expect(await prisma.mcpToolConsent.count({ where: { serverId: serverId!, userId: aliceSession.user.id } })).toBe(1);

  await newChat();
  const approvals = approvalMessages().length;
  const next = bot.calls().length;
  bot.inject.text(tgAlice, "Delete record r-4 [AIQSA_MCP_E2E:delete_record:r-4]");
  await expectAnswer(next, "MCP call finished: done.");
  expect(endpoint!.dispatches("delete_record", { id: "r-4" })).toBe(1);
  expect(approvalMessages()).toHaveLength(approvals);

  // Revoked again: the scenarios after this one ask.
  expect((await aliceSession.page.request.delete(`/api/me/mcp-consents/${serverId}`)).ok()).toBe(true);
});

test("a forged button and another Telegram account's press do nothing", async () => {
  const approval = await askToDelete("r-5");
  const pending = await latestApproval(await currentChatId());

  const forged = bot.inject.callback(tgAlice, approval.message_id, `c:${"A".repeat(22)}`);
  const forgedId = (forged.callback_query as { id: string }).id;
  await expect.poll(() => bot.callbackAnswer(forgedId)?.answered, { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  expect(bot.callbackAnswer(forgedId)?.text).toBe(TELEGRAM_COPY.buttonExpired);

  const stolen = press(approval, TELEGRAM_COPY.allowOnce, tgStranger);
  await expect.poll(() => bot.callbackAnswer(stolen.queryId)?.answered, { timeout: REPLY_TIMEOUT_MS }).toBe(true);
  expect(bot.callbackAnswer(stolen.queryId)?.text).toBe(TELEGRAM_COPY.buttonExpired);

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ decision: null });
  expect(buttonRows(botMessage(approval.message_id))).toHaveLength(2);
  expect(endpoint!.dispatches("delete_record", { id: "r-5" })).toBe(0);
});

test("a decision made in AIQSA first is shown as it is, and Telegram starts nothing", async () => {
  const approval = approvalMessages().at(-1)!;
  const chatId = await currentChatId();
  const pending = await latestApproval(chatId);
  expect(pending.decision).toBeNull();
  const decided = await aliceSession.page.request.post(`/api/model-runs/${pending.modelRunId}/mcp-approvals/${pending.id}`, {
    data: { decision: "deny", nonce: `web-${randomUUID()}` }
  });
  expect(decided.ok(), await decided.text()).toBe(true);
  const runs = await prisma.modelRun.count({ where: { chatId } });

  press(approval, TELEGRAM_COPY.allowOnce);
  await expect.poll(() => shown(botMessage(approval.message_id)), { timeout: REPLY_TIMEOUT_MS }).toContain(TELEGRAM_COPY.denied);
  expect(botMessage(approval.message_id)?.reply_markup).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ decision: "deny" });
  expect(await prisma.modelRun.count({ where: { chatId } })).toBe(runs);
  expect(endpoint!.dispatches("delete_record", { id: "r-5" })).toBe(0);
});

test("a button pressed after the approval window says the approval expired and decides nothing", async () => {
  const approval = await askToDelete("r-6");
  const pending = await latestApproval(await currentChatId());
  // The buttons decide for as long as an Allow once lasts (15 minutes): move this message's window into the past.
  const rows = await prisma.telegramCallback.findMany({
    select: { id: true, payload: true }, where: { kind: { in: [...APPROVAL_KINDS] }, link: { userId: aliceSession.user.id } }
  });
  for (const row of rows.filter((entry) => (entry.payload as Prisma.JsonObject).approvalId === pending.id)) {
    await prisma.telegramCallback.update({
      data: { payload: { ...(row.payload as Prisma.JsonObject), until: Date.now() - 1_000 } }, where: { id: row.id }
    });
  }

  press(approval, TELEGRAM_COPY.allowOnce);
  await expect.poll(() => shown(botMessage(approval.message_id)), { timeout: REPLY_TIMEOUT_MS }).toContain(TELEGRAM_COPY.approvalExpired);
  expect(botMessage(approval.message_id)?.reply_markup).toBeUndefined();
  expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ decision: null });
  expect(endpoint!.dispatches("delete_record", { id: "r-6" })).toBe(0);
});

test("a Workspace run keeps one status message with Stop, ends it as finished and sends its file as a document", async () => {
  test.setTimeout(300_000);
  await prisma.telegramLink.update({ data: { workspaceEnabled: true }, where: { userId: aliceSession.user.id } });
  await newChat();
  const before = await latestRun().then((run) => run.id, () => "");
  const since = bot.calls().length;
  bot.inject.text(tgAlice, "[AIQSA_WORKSPACE_E2E:activity_probe]");
  const status = await statusMessage(since, before);
  const sent = callsSince(since, "sendMessage").find((call) => String(call.params.text).startsWith("Working in Workspace · "))!;
  expect(buttonRows({ reply_markup: sent.params.reply_markup } as FakeTelegramMessage).map((row) => row.map((button) => button.text)))
    .toEqual([[TELEGRAM_COPY.stop]]);

  await expectAnswer(since, "Workspace activity probe finished.", 180_000);
  await expect.poll(() => botMessage(status.message_id)?.text, { timeout: REPLY_TIMEOUT_MS }).toMatch(/^Finished in \d+ min$/u);
  expect(botMessage(status.message_id)?.reply_markup).toBeUndefined();
  // Edited in place, never resent: still the one status message of the run.
  expect(callsSince(since, "sendMessage").filter((call) => String(call.params.text).startsWith("Working in Workspace"))).toHaveLength(1);

  // The report the run wrote reaches Telegram once its export finished.
  await expect.poll(() => callsSince(since, "sendDocument").map((call) => call.file?.filename), { timeout: 150_000 }).toContain("report.md");
});

test("Stop on the status message stops the Workspace run and the status says Stopped", async () => {
  test.setTimeout(300_000);
  await newChat();
  const before = await latestRun().then((run) => run.id, () => "");
  const since = bot.calls().length;
  bot.inject.text(tgAlice, "[AIQSA_WORKSPACE_E2E:long_command]");
  const status = await statusMessage(since, before);
  press(status, TELEGRAM_COPY.stop);
  await expect.poll(() => botMessage(status.message_id)?.text, { timeout: 120_000 }).toBe(TELEGRAM_COPY.stopped);
  expect(botMessage(status.message_id)?.reply_markup).toBeUndefined();
  await expect.poll(async () => (await latestRun()).status, { timeout: REPLY_TIMEOUT_MS }).toBe("cancelled");
  await expect.poll(() => textsSince(since), { timeout: REPLY_TIMEOUT_MS }).toContain(TELEGRAM_COPY.stopped);
  await prisma.telegramLink.update({ data: { workspaceEnabled: false }, where: { userId: aliceSession.user.id } });
});
