/**
 * Opt-in, paid, bounded checks that the native agent engine
 * (`lib/server/engine/`) serves the runs its rollout moves to it, with a real
 * Codex LB answer model on a DISPOSABLE stand: an Assistant chat under the
 * Assistant's own instructions, a scheduled monitoring check that reports its
 * verdict (twice, so the second check reads the first result from its flat
 * context), a Telegram message whose MCP write asks with buttons and, after
 * Allow once, continues the same chat, and MCP in Auto: web chats whose
 * composer is in Auto load the synthetic records server's tools with
 * `find_tools` (a read answered from its result; a write that asks first and,
 * after Allow once, reaches the peer exactly once), and a scheduled
 * occurrence with tools on that runs the write under its standing authority,
 * without approval. Each test sets up and removes its own resources, so a
 * failed one does not skip the others. Never a default lane: it runs
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
 * checks), again in the next test after a failed one restarts the worker;
 * the Assistant turn (one request); two monitoring checks (two or three
 * requests each: the verdict call, then the answer); the Telegram write turn
 * (one or two requests up to the call) and its continuation (one); the Auto
 * read turn (three: `find_tools`, the read, the answer); the Auto write turn
 * (two up to the approval) and its continuation (one: the server loads the
 * tool and sends the approved call, then the model answers); the scheduled
 * write occurrence (three).
 *
 * Oracles are persisted runs, occurrences, approvals, tool calls, discovery
 * epochs and MCP bindings, the synthetic peer's received calls, what reached
 * the fake Bot API and planted tokens, never the model's wording otherwise.
 * Prompts, answers and identifiers are never printed; the attached summary
 * holds statuses, counts and kinds only. Everything the spec creates
 * (Assistant, chats, tasks, MCP servers and consents, the bot and the link)
 * is removed afterwards and the account's chat defaults restored; the
 * codex-lb connection stays on the stand like the other paid specs'
 * connections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AssistantDetailResponse } from "../../lib/contracts/assistants";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import type { TelegramAdminCommand, TelegramAdminState, TelegramLinkCodeResponse } from "../../lib/contracts/telegram";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { TELEGRAM_COPY, telegramConnectedText } from "../../lib/server/telegram/copy";
import { createFakeTelegramBotApi, type FakeTelegramMessage, type FakeTelegramUser } from "../support/fakeTelegramBotApi";
import { selectModel } from "./shell/composer";
import { createAssistantFixture, e2eAssistantAvatar, e2eAssistantRows } from "./support/assistants";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { createWriteApprovalFixture, startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { telegramE2eApiPort } from "./support/telegramApiOrigin";
import { disableMemoryRecall, lastAnswer } from "./support/workspace";

const prisma = new PrismaClient();

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
// In declaration order on one worker, but not serial: every test sets up and removes its own resources, so a failed
// one must not skip the rest (a failure restarts the worker, which sets the codex-lb connection up again).
test.describe.configure({ mode: "default" });
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
// The synthetic records server

type RecordsServer = Readonly<{ endpoint: MutableMcpEndpoint; remove(): Promise<void>; serverName: string }>;

/**
 * The synthetic records peer (`createWriteApprovalFixture`: `read_record`
 * annotated read-only, `delete_record` destructive), installed by the
 * administrator, granted to and enabled for the operator, with no earlier
 * consent that could skip an approval card. A planted code exists only in a
 * tool's result: `read_record` returns `code`, `delete_record` its
 * `receipt`. `remove` deletes the consent and the server and closes the
 * peer; a failed install removes what it created.
 */
async function installRecordsServer(page: Page, userId: string,
  planted: Readonly<{ code?: string; receipt?: string }>): Promise<RecordsServer> {
  const fixture = createWriteApprovalFixture();
  const callTool = (name: string, args: Readonly<Record<string, unknown>>): CallToolResult => {
    const id = typeof args.id === "string" ? args.id : null;
    if (id && name === "delete_record" && planted.receipt) {
      return { content: [{ text: JSON.stringify({ deleted: id, receipt: planted.receipt }), type: "text" }] };
    }
    if (id && name === "read_record" && planted.code) {
      return { content: [{ text: JSON.stringify({ code: planted.code, id, state: "open" }), type: "text" }] };
    }
    return fixture.callTool(name, args);
  };
  const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
  const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
  const endpoint = await startMutableMcpEndpoint(fixture.tools, { callTool, ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
  const serverName = `Rollout records ${randomUUID().slice(0, 8)}`;
  let serverId: string | null = null;
  const remove = async () => {
    if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    await endpoint.close();
  };
  try {
    const created = await page.request.post("/api/admin/mcp", { data: {
      activate: false,
      description: "Synthetic records server for the native engine rollout",
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
      canUse: true, personalSlotKeys: [], userId
    } })).ok()).toBe(true);
    expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
    await page.request.delete(`/api/me/mcp-consents/${server.id}`).catch(() => undefined);
    return { endpoint, remove, serverName };
  } catch (error) {
    await remove().catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Web chats and MCP calls in Auto

/**
 * A new chat outside Memory on the codex-lb model, with the composer's MCP
 * chip in Auto, picked through the chip itself; Skills, Search and Memory
 * recall are off. The chat is tracked in `chatIds` as soon as it exists.
 */
async function openAutoChat(page: Page, stand: Stand, title: string, chatIds: Set<string>): Promise<string> {
  const chatId = await newExcludedChat(page.request, `${title} ${randomUUID().slice(0, 8)}`);
  chatIds.add(chatId);
  await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => selectModel(page, stand.model.connectionId, stand.model.displayName)).toPass({ timeout: 60_000 });
  await expect(page.getByTestId("header-model-trigger")).toContainText(stand.model.displayName);
  await turnComposerToolsOff(page);
  const mcp = page.getByRole("button", { name: "Change MCP mode" });
  await mcp.click();
  await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Auto/u }).click();
  await expect(mcp).toHaveAttribute("data-mcp-mode", "auto");
  await expect(mcp).toHaveAccessibleDescription(/^MCP: Auto/u);
  return chatId;
}

async function sendComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { exact: true, name: "Message" });
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
}

async function runIds(chatId: string): Promise<string[]> {
  return (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
}

/** The chat's first run not in `earlier`, once it is created. */
async function newRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  return pollUntil(120_000, async () => prisma.modelRun.findFirst({
    orderBy: { createdAt: "desc" }, where: { chatId, id: { notIn: [...earlier] } }
  }), "native_run_not_admitted");
}

async function waitAnswerSettled(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
}

type ToolCallFacts = Readonly<{ mcpRunBindingId: string | null; providerCallId: string; roundIndex: number; state: string;
  toolName: string }>;

/** The run's tool calls in order, with what tells a loaded MCP call apart: its binding, its round and its provider call. */
async function toolCallFacts(runId: string): Promise<ToolCallFacts[]> {
  return prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { mcpRunBindingId: true, providerCallId: true, roundIndex: true, state: true, toolName: true }, where: { modelRunId: runId } });
}

/** A call of the synthetic records server's `tool`; a run names MCP tools `mcp_<namespace>_<tool>_<hash>` (`namespacedMcpToolName`). */
function recordsCall(call: Pick<ToolCallFacts, "toolName">, tool: "delete_record" | "read_record"): boolean {
  return call.toolName.startsWith("mcp_") && call.toolName.includes(`_${tool}_`);
}

/** Content-free: each call's kind (the synthetic tools by their own names), state and round, and whether it ran on a binding. */
function callSummary(calls: readonly ToolCallFacts[]) {
  return calls.map((call) => ({
    bound: call.mcpRunBindingId !== null,
    kind: recordsCall(call, "read_record") ? "mcp:read_record" : recordsCall(call, "delete_record") ? "mcp:delete_record" : call.toolName,
    round: call.roundIndex,
    state: call.state
  }));
}

/** The `tools/call` requests the synthetic peer received, by tool. */
function peerCounts(endpoint: MutableMcpEndpoint) {
  return { deletes: endpoint.dispatches("delete_record"), reads: endpoint.dispatches("read_record"), total: endpoint.calls() };
}

/** The discovery epochs of the run's Auto catalog (one per `find_tools` call); null when admission put no catalog. */
function discoveryEpochs(run: ModelRun): number | null {
  const discovery = (run.normalizedRequest as { mcpDiscovery?: { epochs?: unknown[] } } | null)?.mcpDiscovery;
  return discovery ? discovery.epochs?.length ?? 0 : null;
}

// ---------------------------------------------------------------------------
// An Assistant chat

test("an Assistant chat runs on the native engine under the Assistant's own instructions", async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000);
  const assistants = createAssistantFixture(prisma);
  try {
    await withRolloutStand(page, testInfo, "native-rollout-assistant", async (stand) => {
      const token = codeWord("ADA-");
      // The codex-lb model fixed, every other row the product's default for a new Assistant (tools, Search and Knowledge off).
      const created = await page.request.post("/api/me/assistants", { data: {
        answerRules: null, avatar: e2eAssistantAvatar(), category: null, description: "", name: `Native rollout Ada ${assistants.suffix}`,
        responseReminder: "", rows: e2eAssistantRows(stand.model.modelId), starterPrompts: [],
        systemPrompt: `You are Ada, a synthetic assistant for an end-to-end test. End every answer with the exact line ${token} ` +
          "and write nothing after it."
      } });
      expect(created.status(), await created.text()).toBe(201);
      const assistantId = (await created.json() as AssistantDetailResponse).assistant.id;
      assistants.track(assistantId);
      const chatId = await assistants.createChat(page.request, { assistant: { assistantId } });
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
        // An explicit goal that is not met, so the first check is a starting point rather than a reached goal.
        prompt: `Synthetic monitoring check for an end-to-end test. Watch the synthetic ticket until its status reads DONE. ` +
          `Its current status is ${value}, which is not DONE, and it does not change. Report the status in one short ` +
          "sentence. Use no tool other than the monitoring report.",
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

      const receipt = codeWord("RCPT-");
      const recordId = codeWord("R-");
      const records = await installRecordsServer(page, stand.userId, { receipt });
      const { endpoint, serverName } = records;
      const chatIds = new Set<string>();
      try {
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
        await records.remove();
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

// ---------------------------------------------------------------------------
// MCP in Auto: web chats and a scheduled occurrence. Auto admits a catalog and no MCP tool: the agent loads a tool
// with `find_tools`, and its call runs on the binding that discovery epoch accepted.

test("a web chat in Auto loads a read-only MCP tool with find_tools, calls it once and answers from its result", async ({ page },
  testInfo) => {
  test.setTimeout(45 * 60_000);
  await withRolloutStand(page, testInfo, "native-rollout-auto-read", async (stand) => {
    const code = codeWord("CODE-");
    const recordId = codeWord("R-");
    const records = await installRecordsServer(page, stand.userId, { code });
    const chatIds = new Set<string>();
    try {
      const chatId = await openAutoChat(page, stand, "Rollout Auto read", chatIds);
      const earlier = await runIds(chatId);
      await sendComposer(page, `This is a test with a synthetic records server named "${records.serverName}". Its read_record tool ` +
        `is not loaded yet: find it with find_tools, then call it exactly once with {"id": "${recordId}"}. Do not call any other ` +
        "tool. Then reply in one short sentence that quotes the code from the tool's result.");
      const run = await settledNativeRun((await newRun(chatId, earlier)).id);
      await waitAnswerSettled(page);
      const calls = await toolCallFacts(run.id);
      const finds = calls.filter((call) => call.toolName === "find_tools");
      const reads = calls.filter((call) => recordsCall(call, "read_record"));
      const text = await answerText(run);
      stand.summary.autoRead = {
        bindings: await prisma.mcpRunBinding.count({ where: { modelRunId: run.id } }), calls: callSummary(calls),
        codeQuoted: text.includes(code), discoveryEpochs: discoveryEpochs(run), engine: run.engine,
        peer: peerCounts(records.endpoint), status: run.status
      };

      expect(discoveryEpochs(run), "admission put the Auto catalog and find_tools loaded from it").toBeGreaterThanOrEqual(1);
      expect(finds.length, "the run loaded the tool with find_tools").toBeGreaterThanOrEqual(1);
      expect(reads.map((call) => call.state), "then called the MCP tool once, and the call completed").toEqual(["complete"]);
      expect(reads[0]!.roundIndex, "after find_tools loaded it").toBeGreaterThan(finds[0]!.roundIndex);
      expect(reads[0]!.mcpRunBindingId, "on the binding its discovery epoch accepted").not.toBeNull();
      expect(records.endpoint.calls(), "the peer received exactly one call").toBe(1);
      expect(records.endpoint.dispatches("read_record", { id: recordId }), "for the requested record").toBe(1);
      expect(text.includes(code), "the answer quotes the code from the tool's result").toBe(true);
      await expect(lastAnswer(page)).toContainText(code, { timeout: 60_000 });
      await desktopShot(page, testInfo, chatId, "03-auto-read-answer");
    } finally {
      for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
      await records.remove().catch(() => undefined);
    }
  });
});

test("a web chat in Auto asks before a data-changing MCP call, and Allow once sends exactly one write and continues the chat", async ({ page },
  testInfo) => {
  test.setTimeout(45 * 60_000);
  await withRolloutStand(page, testInfo, "native-rollout-auto-write", async (stand) => {
    const receipt = codeWord("RCPT-");
    const recordId = codeWord("R-");
    const records = await installRecordsServer(page, stand.userId, { receipt });
    const chatIds = new Set<string>();
    try {
      const chatId = await openAutoChat(page, stand, "Rollout Auto write", chatIds);
      const earlier = await runIds(chatId);
      await sendComposer(page, `This is a test with a synthetic records server named "${records.serverName}". Its delete_record ` +
        `tool is not loaded yet: find it with find_tools, then call it exactly once with {"id": "${recordId}"}. Do not call any ` +
        "other tool. After it returns, reply in one short sentence that quotes the receipt code from the tool's result.");
      const first = await settledNativeRun((await newRun(chatId, earlier)).id);
      await waitAnswerSettled(page);
      const card = page.getByRole("listitem", { name: `Approval for ${records.serverName} delete_record` }).first();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card).toHaveAttribute("data-state", "pending");
      const firstCalls = await toolCallFacts(first.id);
      const asked = firstCalls.find((call) => recordsCall(call, "delete_record"));
      const pending = await prisma.mcpToolApproval.count({ where: { chatId, decision: null } });
      const writesBeforeAllow = records.endpoint.dispatches("delete_record");

      const beforeAllow = await runIds(chatId);
      await card.getByRole("button", { name: "Allow once" }).click();
      const continued = await settledNativeRun((await newRun(chatId, beforeAllow)).id);
      await waitAnswerSettled(page);
      await expect(card).toHaveAttribute("data-state", "allowed_once", { timeout: 60_000 });
      const continuedCalls = await toolCallFacts(continued.id);
      const write = continuedCalls.find((call) => recordsCall(call, "delete_record") && call.state === "complete");
      const refind = continuedCalls.findIndex((call) => call.toolName === "find_tools");
      // Direct: the continuation sent the approved call itself, once the server had loaded its tool from the run's catalog
      // (Auto admits none). Re-found would mean the model loaded the tool and made the call again.
      const sent = !write ? "not_sent" : write.providerCallId === asked?.providerCallId ? "direct"
        : refind >= 0 && refind < continuedCalls.indexOf(write) ? "re-found" : "other";
      const text = await answerText(continued);
      const continuationTurns = await prisma.message.count({ where: { chatId, role: "user", systemTurnKind: "mcp_approval_continuation" } });
      stand.summary.autoWrite = {
        continuation: { calls: callSummary(continuedCalls), discoveryEpochs: discoveryEpochs(continued), engine: continued.engine,
          // A write the Allow did not cover (other arguments) would have asked again.
          pendingApprovals: await prisma.mcpToolApproval.count({ where: { chatId, decision: null } }), status: continued.status },
        continuationTurns,
        first: { calls: callSummary(firstCalls), discoveryEpochs: discoveryEpochs(first), engine: first.engine, pendingApprovals: pending,
          status: first.status, writesBeforeAllow },
        peer: peerCounts(records.endpoint),
        receiptQuoted: text.includes(receipt),
        sent
      };

      expect(discoveryEpochs(first), "the first run loaded the write from its Auto catalog with find_tools").toBeGreaterThanOrEqual(1);
      expect(asked?.mcpRunBindingId ?? null, "the write it asked for waited on the binding its epoch accepted").not.toBeNull();
      expect(writesBeforeAllow, "nothing was deleted before the Allow").toBe(0);
      expect(pending, "the run recorded its approval request").toBe(1);
      expect(records.endpoint.dispatches("delete_record", { id: recordId }), "the allowed write was sent once").toBe(1);
      expect(records.endpoint.dispatches("delete_record"), "the peer saw exactly one write").toBe(1);
      expect(write, "the continuation's write completed").toBeTruthy();
      expect(discoveryEpochs(continued), "the server loaded the approved tool through a discovery epoch").toBeGreaterThanOrEqual(1);
      expect(sent, "the continuation sent the approved call itself").toBe("direct");
      expect(continuationTurns, "the Allow continued the chat with the server's turn").toBe(1);
      expect(text.includes(receipt), "the continued answer used the tool's result").toBe(true);
      await expect(lastAnswer(page)).toContainText(receipt, { timeout: 60_000 });
      await desktopShot(page, testInfo, chatId, "04-auto-write-continued");
    } finally {
      for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
      await records.remove().catch(() => undefined);
    }
  });
});

test("a scheduled occurrence with tools on finds an MCP write in Auto and runs it once under its standing authority", async ({ page },
  testInfo) => {
  test.setTimeout(45 * 60_000);
  await withRolloutStand(page, testInfo, "native-rollout-scheduled-write", async (stand) => {
    const receipt = codeWord("RCPT-");
    const recordId = codeWord("R-");
    const records = await installRecordsServer(page, stand.userId, { receipt });
    let taskId: string | null = null;
    const chatIds = new Set<string>();
    try {
      // Tools on: the owner's MCP servers in Auto, by design (never Load all), with no per-run approval.
      const created = await page.request.post("/api/me/scheduled-tasks", { data: {
        chatMode: "same", emailNotify: false, historyRetentionDays: 90, kind: "standard", memoryEnabled: false,
        modelId: stand.model.modelId, pinnedSkillIds: [],
        prompt: `Synthetic scheduled task for an end-to-end test with a synthetic records server named "${records.serverName}". ` +
          `Its delete_record tool is not loaded yet: find it with find_tools, then call it exactly once with {"id": "${recordId}"}. ` +
          "Do not call any other tool. After it returns, reply in one short sentence that quotes the receipt code from the tool's " +
          "result.",
        provider: stand.model.connectionId, schedule: { kind: "daily", time: "03:00" }, searchEnabled: false, telegramNotify: false,
        timeZone: "UTC", title: `Native rollout write ${randomUUID().slice(0, 8)}`, toolsEnabled: true, workspaceEnabled: false
      } });
      expect(created.status(), await created.text()).toBe(201);
      taskId = ((await created.json()) as { task: { id: string } }).task.id;
      expect((await page.request.post(`/api/me/scheduled-tasks/${taskId}/run`)).ok()).toBe(true);
      const occurrence = await pollUntil(TURN_TIMEOUT_MS, async () => {
        const current = await prisma.scheduledTaskOccurrence.findFirst({ orderBy: { createdAt: "desc" }, where: { taskId: taskId! } });
        return current && ["COMPLETED", "FAILED", "SKIPPED"].includes(current.state) ? current : null;
      }, "scheduled_occurrence_timeout");
      const admitted = occurrence.runId
        ? await prisma.modelRun.findUnique({ select: { chatId: true }, where: { id: occurrence.runId } }) : null;
      if (admitted) chatIds.add(admitted.chatId);
      stand.summary.scheduledWrite = { occurrence: occurrence.state, reasonCode: occurrence.reasonCode };
      expect(occurrence.state, `the occurrence settles (${occurrence.reasonCode ?? "no reason"})`).toBe("COMPLETED");

      const run = await settledNativeRun(occurrence.runId!);
      const calls = await toolCallFacts(run.id);
      const writes = calls.filter((call) => recordsCall(call, "delete_record"));
      const approvals = await prisma.mcpToolApproval.count({ where: { chatId: run.chatId } });
      const text = await answerText(run);
      stand.summary.scheduledWrite = {
        approvals, calls: callSummary(calls), discoveryEpochs: discoveryEpochs(run), engine: run.engine, occurrence: occurrence.state,
        peer: peerCounts(records.endpoint), receiptQuoted: text.includes(receipt), status: run.status
      };

      expect(discoveryEpochs(run), "tools on admitted the Auto catalog and find_tools loaded the write from it")
        .toBeGreaterThanOrEqual(1);
      expect(approvals, "standing authority: no approval was asked").toBe(0);
      expect(writes.map((call) => call.state), "the write ran once and completed").toEqual(["complete"]);
      expect(writes[0]!.mcpRunBindingId, "on the binding its discovery epoch accepted").not.toBeNull();
      expect(records.endpoint.dispatches("delete_record", { id: recordId }), "the peer received the write once").toBe(1);
      expect(records.endpoint.dispatches("delete_record"), "and no other write").toBe(1);
      expect(calls.filter((call) => call.toolName.startsWith("manage_") || call.toolName === "create_scheduled_task"),
        "a scheduled run changes nothing of its owner's own").toEqual([]);
      expect(text.includes(receipt), "the result quotes the receipt from the tool's result").toBe(true);
      await desktopShot(page, testInfo, run.chatId, "05-scheduled-write");
    } finally {
      if (taskId) await page.request.delete(`/api/me/scheduled-tasks/${taskId}`).catch(() => undefined);
      for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
      await records.remove().catch(() => undefined);
    }
  });
});
