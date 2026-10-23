/**
 * Opt-in, paid, bounded checks that the native agent engine
 * (`lib/server/engine/`) serves the runs its rollout moves to it, with a real
 * Codex LB answer model on a DISPOSABLE stand: an Assistant chat under the
 * Assistant's own instructions, a scheduled monitoring check that reports its
 * verdict (twice, so the second check reads the first result from its flat
 * context), and a Telegram message whose MCP write asks with buttons and,
 * after Allow once, continues the same chat. Never a default lane: it runs
 * only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the model (default as
 * `setupCodexLbAnswerModel`). AIQSA_FEATURES_FIXTURE_HOST /
 * AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place the synthetic MCP peer for a stand
 * that reaches it by another name. Each test first runs the disposable-target
 * guard (`scripts/stateful-test-target.ts`).
 *
 * The stand's app must put the operator on the native engine:
 * AIQSA_NATIVE_ENGINE_USERS=* (or the operator's id or email); every test
 * asserts `ModelRun.engine = 'native'`, so a stand without it fails visibly
 * instead of proving the old core. Telegram uses the loopback fake Bot API
 * that `playwright.config.ts` gives the web server it starts
 * (AIQSA_TELEGRAM_API_ORIGIN, test mode only); a reused server
 * (PLAYWRIGHT_REUSE_SERVER=1) must run with it too, else the Telegram test is
 * skipped with that reason.
 *
 *   export AIQSA_FEATURES_PAID_E2E=DISPOSABLE AIQSA_NATIVE_ENGINE_USERS='*'   # plus the CODEX_LB_* pair
 *   npx playwright test --project=chromium tests/e2e/native-rollout-paid.spec.ts
 *
 * Inside the disposable Compose stand, pass the same variables with `-e` to
 * `docker compose -f docker-compose.dev.yml run --rm -T app npx playwright test ...`.
 *
 * Expected paid calls (Codex LB only): custom setup (discovery plus its model
 * checks); the Assistant turn (one request); two monitoring checks (two or
 * three requests each: the verdict call, then the answer); the Telegram
 * write turn (one or two requests up to the call) and its continuation (one).
 *
 * Oracles are persisted runs, occurrences, approvals and tool calls, the
 * synthetic peer's received calls, what reached the fake Bot API and planted
 * tokens, never the model's wording otherwise. Prompts, answers and
 * identifiers are never printed; the attached summary holds statuses, counts
 * and kinds only. Everything the spec creates (Assistant, chats, task, MCP
 * server and consent, the bot and the link) is removed afterwards and the
 * account's chat defaults restored; the codex-lb connection stays on the
 * stand like the other paid specs' connections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import type { TelegramAdminCommand, TelegramAdminState, TelegramLinkCodeResponse } from "../../lib/contracts/telegram";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { TELEGRAM_COPY, telegramConnectedText } from "../../lib/server/telegram/copy";
import { createFakeTelegramBotApi, type FakeTelegramMessage, type FakeTelegramUser } from "../support/fakeTelegramBotApi";
import { createAssistantFixture } from "./support/assistants";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { createWriteApprovalFixture, startMutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { snapshotComposerDefaults } from "./support/composerToolsOff";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";
import { disableMemoryRecall, lastAnswer } from "./support/workspace";

const prisma = new PrismaClient();

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 600_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const DESKTOP = { height: 900, width: 1440 };
const MONITORING_VERDICTS = ["update", "no_update", "goal_reached"];
const ROLLOUT_BOT_TOKEN = "100000009:AAFakeTelegramRolloutTokenForTests_0000";
const ROLLOUT_BOT_USERNAME = "aiqsa_rollout_test_bot";

const codeWord = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;

// ---------------------------------------------------------------------------
// Stand

type Stand = Readonly<{ model: PaidAnswerModel; summary: Record<string, unknown>; userId: string }>;

/** One codex-lb connection per server start. */
let answerModel: PaidAnswerModel | null = null;

/**
 * Signs in as the operator and runs `body` on the codex-lb model; the
 * account's chat defaults and Memory toggles are restored afterwards and the
 * content-free summary is attached.
 */
async function withRolloutStand(page: Page, testInfo: TestInfo, label: string, body: (stand: Stand) => Promise<void>): Promise<void> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  await page.setViewportSize(DESKTOP);
  const summary: Record<string, unknown> = {};
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    await disableMemoryRecall(page);
    answerModel ??= await setupCodexLbAnswerModel(page.request, {
      label: "Native rollout", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
    });
    summary.answerModel = answerModel.upstreamModelId;
    await body({ model: answerModel, summary, userId });
  } finally {
    await testInfo.attach(`${label}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`native_rollout_paid_summary ${label} ${JSON.stringify(summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    await restoreDefaults?.().catch(() => { summary.composerDefaultsRestore = "failed"; });
  }
}

/** Waits until the run settles; it must end `complete` on the native engine. */
async function settledNativeRun(runId: string): Promise<ModelRun> {
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
    return ACTIVE_RUN_STATUSES.includes(current.status) ? null : current;
  }, "native_run_timeout");
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  expect(run.engine, "the run ran on the native engine (the stand's app needs AIQSA_NATIVE_ENGINE_USERS)").toBe("native");
  expect(run.status, `the run completes (${typeof code === "string" ? code : run.status})`).toBe("complete");
  return run;
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

async function toolCalls(runId: string): Promise<Array<Readonly<{ state: string; toolName: string }>>> {
  return prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }], select: { state: true, toolName: true },
    where: { modelRunId: runId } });
}

async function desktopShot(page: Page, testInfo: TestInfo, chatId: string, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
  const answer = lastAnswer(page);
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await answer.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  const path = testInfo.outputPath(`${name}-desktop-1440x900.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}-desktop-1440x900.png`, { contentType: "image/png", path });
}

// ---------------------------------------------------------------------------
// An Assistant chat

test("an Assistant chat runs on the native engine under the Assistant's own instructions", async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000);
  const assistants = createAssistantFixture(prisma);
  try {
    await withRolloutStand(page, testInfo, "native-rollout-assistant", async (stand) => {
      const token = codeWord("ADA-");
      const assistant = await assistants.create(page.request, {
        name: "Native rollout Ada",
        rows: { model: { policy: "fixed", value: { mode: "model", modelId: stand.model.modelId } } },
        systemPrompt: `You are Ada, a synthetic assistant for an end-to-end test. End every answer with the exact line ${token} ` +
          "and write nothing after it."
      });
      const chatId = await assistants.createChat(page.request, { assistant: { assistantId: assistant.id } });
      const response = await page.request.post(`/api/chats/${chatId}/messages`, { timeout: TURN_TIMEOUT_MS, data: {
        content: { blocks: [{ text: "Name one primary colour in a single short sentence.", type: "text" }] }, expectedActiveLeafId: null,
        timeZone: "UTC", workspace: { enabled: false }
      } });
      expect(response.ok(), `the Assistant turn is accepted (${response.status()})`).toBe(true);
      await response.body();
      const admitted = await prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { chatId } });
      const run = await settledNativeRun(admitted.id);
      const text = await answerText(run);
      const system = ((run.normalizedRequest as { prompt?: { system?: unknown } } | null)?.prompt?.system ?? "") as string;
      const calls = await toolCalls(run.id);
      stand.summary.assistant = { engine: run.engine, persistedChars: text.length, status: run.status, tokenQuoted: text.includes(token),
        toolCalls: calls.length };

      expect(run.modelId, "the Assistant's fixed model answered").toBe(stand.model.upstreamModelId);
      expect(system, "admission froze the Assistant's instructions").toContain(token);
      expect(text.trim().endsWith(token), "the answer follows the Assistant's instruction").toBe(true);
      expect(calls.filter((call) => call.toolName.startsWith("manage_")), "an Assistant chat takes no self-service tool").toEqual([]);
      await desktopShot(page, testInfo, chatId, "01-assistant-answer");
    });
  } finally {
    await assistants.cleanup().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// A scheduled monitoring check

test("a scheduled monitoring check runs on the native engine and reports its verdict, then compares with its result", async ({ page },
  testInfo) => {
  test.setTimeout(45 * 60_000);
  await withRolloutStand(page, testInfo, "native-rollout-monitoring", async (stand) => {
    const value = codeWord("STATUS-");
    let taskId: string | null = null;
    const chatIds = new Set<string>();
    try {
      const created = await page.request.post("/api/me/scheduled-tasks", { data: {
        chatMode: "same", emailNotify: false, historyRetentionDays: 90, kind: "monitoring", memoryEnabled: false,
        modelId: stand.model.modelId, pinnedSkillIds: [],
        prompt: `Synthetic monitoring check for an end-to-end test. The watched status is fixed: ${value}. Report the watched ` +
          "status in one short sentence. Use no tool other than the monitoring report.",
        provider: stand.model.connectionId, schedule: { kind: "daily", time: "03:00" }, searchEnabled: false, telegramNotify: false,
        timeZone: "UTC", title: `Native rollout check ${randomUUID().slice(0, 8)}`, toolsEnabled: false, workspaceEnabled: false
      } });
      expect(created.status(), await created.text()).toBe(201);
      taskId = ((await created.json()) as { task: { id: string } }).task.id;

      /** Run now, then the new occurrence once it settled, with its run. */
      const runNow = async () => {
        const before = (await prisma.scheduledTaskOccurrence.findMany({ select: { id: true }, where: { taskId: taskId! } }))
          .map((row) => row.id);
        expect((await page.request.post(`/api/me/scheduled-tasks/${taskId}/run`)).ok()).toBe(true);
        const occurrence = await pollUntil(TURN_TIMEOUT_MS, async () => {
          const current = await prisma.scheduledTaskOccurrence.findFirst({ orderBy: { createdAt: "desc" },
            where: { id: { notIn: before }, taskId: taskId! } });
          return current && ["COMPLETED", "FAILED", "SKIPPED"].includes(current.state) ? current : null;
        }, "scheduled_occurrence_timeout");
        expect(occurrence.state, `the check settles (${occurrence.reasonCode ?? "no reason"})`).toBe("COMPLETED");
        const run = await settledNativeRun(occurrence.runId!);
        chatIds.add(run.chatId);
        return { occurrence, run };
      };

      const first = await runNow();
      const firstCalls = await toolCalls(first.run.id);
      const second = await runNow();
      const secondCalls = await toolCalls(second.run.id);
      const context = ((second.run.normalizedRequest as { context?: { messages?: Array<{ id: string }> } } | null)?.context?.messages ?? [])
        .map((message) => message.id);
      stand.summary.monitoring = {
        first: { engine: first.run.engine, outcome: first.run.scheduledOutcome, toolCalls: firstCalls.map((call) => call.toolName),
          verdict: first.occurrence.verdict },
        second: { contextMessages: context.length, engine: second.run.engine, outcome: second.run.scheduledOutcome,
          sameChat: second.run.chatId === first.run.chatId, toolCalls: secondCalls.map((call) => call.toolName),
          verdict: second.occurrence.verdict }
      };

      // The first check reports through its reserved tool and becomes the baseline.
      expect(MONITORING_VERDICTS.includes(first.occurrence.verdict ?? ""), "the first check recorded its verdict").toBe(true);
      expect(first.run.scheduledOutcome).toBe("baseline");
      expect(firstCalls).toContainEqual({ state: "complete", toolName: "report_monitoring_result" });
      // The second check continues the same chat from its flat context: the previous result and the prompt.
      expect(second.run.chatId, "a same-chat task continues its chat").toBe(first.run.chatId);
      expect(context, "the flat context holds the previous result and the prompt only")
        .toEqual([first.run.userMessageId, first.run.assistantMessageId, "current-user-message"]);
      expect(MONITORING_VERDICTS.includes(second.occurrence.verdict ?? ""), "the second check recorded its verdict").toBe(true);
      expect(MONITORING_VERDICTS.includes(second.run.scheduledOutcome ?? ""), "the second check compared with the first result")
        .toBe(true);
      expect(secondCalls).toContainEqual({ state: "complete", toolName: "report_monitoring_result" });
      expect(secondCalls.filter((call) => call.toolName.startsWith("manage_") || call.toolName === "create_scheduled_task"),
        "a scheduled run changes nothing of its owner's own").toEqual([]);
    } finally {
      if (taskId) await page.request.delete(`/api/me/scheduled-tasks/${taskId}`).catch(() => undefined);
      for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// A Telegram message with an approval button

test("a Telegram write asks with buttons on the native engine, and Allow once continues the same chat", async ({ page }, testInfo) => {
  test.setTimeout(45 * 60_000);
  const bot = createFakeTelegramBotApi({ firstUpdateId: Math.floor(Date.now() / 1_000) + 1_700_000, token: ROLLOUT_BOT_TOKEN,
    username: ROLLOUT_BOT_USERNAME });
  await bot.start({ port: telegramE2eApiPort() });
  const tgUser: FakeTelegramUser = bot.inject.addUser({ firstName: "Rollout", id: 980_000_000_000 + (Date.now() % 10_000_000_000) * 10 });
  const shown = (message: FakeTelegramMessage | undefined) => JSON.stringify(message?.rich_message ?? message?.text ?? "");
  const admin = async (command: TelegramAdminCommand): Promise<TelegramAdminState | null> => {
    const response = await page.request.patch("/api/admin/telegram", { data: command });
    return response.ok() ? (await response.json()) as TelegramAdminState : null;
  };
  try {
    await withRolloutStand(page, testInfo, "native-rollout-telegram", async (stand) => {
      // This spec's bot against the loopback fake, open to everyone.
      let state = (await (await page.request.get("/api/admin/telegram")).json()) as TelegramAdminState;
      if (state.enabled) state = (await admin({ action: "disable", expectedVersion: state.version }))!;
      if (state.restricted) state = (await admin({ action: "set_access", expectedVersion: state.version, groupIds: [], restricted: false }))!;
      const saved = await admin({ action: "test_and_save", expectedVersion: state.version, token: ROLLOUT_BOT_TOKEN });
      test.skip(saved === null, "the stand's app does not reach the loopback Telegram fake (AIQSA_TELEGRAM_API_ORIGIN in test mode)");
      expect(await admin({ action: "enable", expectedVersion: saved!.version })).not.toBeNull();

      const fixture = createWriteApprovalFixture();
      const receipt = codeWord("RCPT-");
      const recordId = codeWord("R-");
      const callTool = (name: string, args: Readonly<Record<string, unknown>>): CallToolResult =>
        name === "delete_record" && typeof args.id === "string"
          ? { content: [{ text: JSON.stringify({ deleted: args.id, receipt }), type: "text" }] }
          : fixture.callTool(name, args);
      const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
      const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
      const endpoint = await startMutableMcpEndpoint(fixture.tools, { callTool, ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
      const serverName = `Rollout records ${randomUUID().slice(0, 8)}`;
      let serverId: string | null = null;
      const chatIds = new Set<string>();
      try {
        const created = await page.request.post("/api/admin/mcp", { data: {
          activate: false,
          description: "Synthetic records server for the native engine's Telegram approval",
          draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
            source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url }, transport: "streamable_http" },
          name: serverName,
          sharedValues: {}
        } });
        expect(created.status()).toBe(201);
        const server = (await created.json() as { server: AdminMcpServer }).server;
        serverId = server.id;
        expect((await page.request.post(`/api/admin/mcp/${server.id}/test`, { data: {
          expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
        } })).status()).toBe(200);
        expect((await page.request.put(`/api/admin/mcp/${server.id}/grants`, { data: {
          canUse: true, personalSlotKeys: [], userId: stand.userId
        } })).ok()).toBe(true);
        expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
        await page.request.delete(`/api/me/mcp-consents/${server.id}`).catch(() => undefined);
        // Telegram sends the account's defaults: the codex-lb model, every MCP tool listed up front, no Skills or Search.
        expect((await page.request.patch("/api/me/settings", { data: { defaultMcpMode: "load_all", defaultSkillsMode: "off",
          defaultWorkspaceEnabled: false } })).ok()).toBe(true);
        await prisma.userSettings.update({ data: { defaultProviderModelId: stand.model.modelId }, where: { userId: stand.userId } });

        await page.request.delete("/api/me/telegram").catch(() => undefined);
        const code = await page.request.post("/api/me/telegram/link-code");
        expect(code.ok(), await code.text()).toBe(true);
        const { deepLink } = (await code.json()) as TelegramLinkCodeResponse;
        const linkedAt = bot.calls().length;
        bot.inject.command(tgUser, "start", new URL(deepLink).searchParams.get("start")!);
        const me = ((await (await page.request.get("/api/me")).json()) as { user: { displayName: string } }).user;
        await expect.poll(() => bot.calls().slice(linkedAt).some((call) => call.method === "sendMessage" &&
          call.params.text === telegramConnectedText(me.displayName)), { timeout: 60_000 }).toBe(true);
        await prisma.telegramLink.update({ data: { searchEnabled: false }, where: { userId: stand.userId } });

        const approvals = () => bot.botMessages(tgUser.id).filter((message) => shown(message).includes(`${serverName} · delete_record`));
        bot.inject.text(tgUser, "This is a test with a synthetic records server. Call the delete_record tool exactly once with " +
          `{"id": "${recordId}"}. Do not call any other tool. After it returns, reply in one short sentence that quotes the receipt ` +
          "code from the tool's result.");
        await expect.poll(() => approvals().length, { timeout: TURN_TIMEOUT_MS }).toBe(1);
        const approval = approvals()[0]!;
        const link = await prisma.telegramLink.findUniqueOrThrow({ select: { currentChatId: true }, where: { userId: stand.userId } });
        const chatId = link.currentChatId!;
        chatIds.add(chatId);
        const first = await settledNativeRun((await prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "asc" }, where: { chatId } })).id);
        expect(endpoint.dispatches("delete_record"), "nothing was deleted before the Allow").toBe(0);
        expect(await prisma.mcpToolApproval.count({ where: { chatId, decision: null } }), "the run recorded its approval request").toBe(1);

        const keyboard = (approval.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string; text: string }>> } | undefined)
          ?.inline_keyboard ?? [];
        const allow = keyboard.flat().find((button) => button.text === TELEGRAM_COPY.allowOnce)?.callback_data;
        expect(allow, "the approval message offers Allow once").toBeTruthy();
        bot.inject.callback(tgUser, approval.message_id, allow!);
        const continuation = await pollUntil(TURN_TIMEOUT_MS, async () => prisma.modelRun.findFirst({
          orderBy: { createdAt: "desc" }, where: { chatId, id: { not: first.id } } }), "telegram_continuation_not_admitted");
        const continued = await settledNativeRun(continuation.id);
        await expect.poll(() => bot.botMessages(tgUser.id).some((message) => message.kind === "rich" && shown(message).includes(receipt)),
          { timeout: 120_000 }).toBe(true);
        const continuationTurns = await prisma.message.count({ where: { chatId, role: "user", systemTurnKind: "mcp_approval_continuation" } });
        stand.summary.telegram = {
          continuation: { engine: continued.engine, status: continued.status, toolCalls: (await toolCalls(continued.id)).map((call) => call.toolName) },
          continuationTurns,
          dispatches: endpoint.dispatched().map((entry) => entry.name),
          first: { engine: first.engine, status: first.status },
          receiptDelivered: true
        };

        expect(endpoint.dispatches("delete_record", { id: recordId }), "the approved call was sent once").toBe(1);
        expect(endpoint.dispatches("delete_record"), "the peer saw exactly one write call").toBe(1);
        expect(continuationTurns, "the Allow continued the chat with the server's turn").toBe(1);
        expect((await answerText(continued)).includes(receipt), "the continued answer used the tool's result").toBe(true);
        expect(shown(bot.botMessages(tgUser.id).find((message) => message.message_id === approval.message_id)))
          .toContain(TELEGRAM_COPY.allowedOnce);
        await desktopShot(page, testInfo, chatId, "02-telegram-chat");
      } finally {
        if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
        if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
        await endpoint.close();
        await page.request.delete("/api/me/telegram").catch(() => undefined);
        for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
      }
    });
  } finally {
    const current = await page.request.get("/api/admin/telegram").then((response) => response.json() as Promise<TelegramAdminState>)
      .catch(() => null);
    if (current?.enabled) await admin({ action: "disable", expectedVersion: current.version }).catch(() => undefined);
    await bot.close();
  }
});
