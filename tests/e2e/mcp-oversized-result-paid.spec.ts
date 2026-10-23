/**
 * Opt-in, paid, bounded browser check that an MCP result over the per-call
 * result limit reaches a real codex-lb model truncated with a marker, as an
 * ordinary completed call, on a DISPOSABLE stand. Never a default lane: it
 * runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). AIQSA_FEATURES_FIXTURE_HOST /
 * AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place the synthetic MCP peer for a stand
 * that reaches it by another name.
 *
 * The stand's app must run with AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES
 * lowered (32768 recommended, at most 65536 so the cut result stays small
 * beside the codex-lb model's context window). Set it in the Playwright process
 * environment: Playwright's webServer passes that environment to `next dev`;
 * a reused server (PLAYWRIGHT_REUSE_SERVER=1) must already run with the same
 * value. That one value is the delivered result limit, and the client's
 * transport accepts twice it, so the synthetic result (one and a half times
 * the limit) arrives whole and is truncated instead of failing on the wire.
 *
 * The synthetic peer runs in the Playwright process: one read-only
 * installation server whose `read_mail_thread` returns a long plain-text
 * thread ending in a unique tail token. Oracles are the persisted run, tool
 * call and observation (status, truncation sizes, marker present, tail
 * absent, no session or call failure codes) and the peer's dispatch count,
 * never the model's wording. Prompts, answers and payloads are never printed;
 * the summary holds counts, codes and booleans only. The chat, server and
 * consent are removed afterwards and the account's chat defaults restored;
 * the codex-lb connection stays on the stand like the other paid specs'.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { selectModel } from "./shell/composer";
import { authenticateWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { activeChatId, disableMemoryRecall } from "./support/workspace";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));
const configuredLimit = Number(paidEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES") ?? Number.NaN);
const MAX_STAND_LIMIT = 65_536;
const limitLowered = Number.isSafeInteger(configuredLimit) && configuredLimit >= 4_096 && configuredLimit <= MAX_STAND_LIMIT;

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.skip(!limitLowered, `requires AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES between 4096 and ${MAX_STAND_LIMIT} on the stand`);
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 600_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const TOOL_NAME = "read_mail_thread";
const THREAD_ID = "THR-1024";
/** The client's marker opens with this stable English text. */
const MARKER_PREFIX = "[Result truncated: the MCP tool returned ";
/** Codes an oversized result used to cascade into; none may appear in the run. */
const CASCADE_CODES = ["mcp_session_closed", "mcp_call_failed", "mcp_call_result_too_large", "mcp_response_too_large"];

type Session = Readonly<{
  chatIds: Set<string>;
  defer(cleanup: () => Promise<unknown>): void;
  model: PaidAnswerModel;
  summary: Record<string, unknown>;
  userId: string;
}>;

/**
 * A signed-in administrator on the codex-lb model with Memory recall off;
 * owned chats and every deferred resource are removed afterwards and the
 * account's chat defaults and Memory recall restored.
 */
async function withSession(page: Page, testInfo: TestInfo, label: string, body: (session: Session) => Promise<void>) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const chatIds = new Set<string>();
  const cleanups: Array<() => Promise<unknown>> = [];
  const summary: Record<string, unknown> = { limit: configuredLimit };
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    const model = await setupCodexLbAnswerModel(page.request, {
      label: "MCP oversized result", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
    });
    summary.answerModel = model.upstreamModelId;
    await body({ chatIds, defer: (cleanup) => { cleanups.push(cleanup); }, model, summary, userId });
  } finally {
    await testInfo.attach(`${label}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`mcp_oversized_result_paid_summary ${JSON.stringify({ label, ...summary })}`);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) {
      await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    }
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    await restoreDefaults?.().catch(() => undefined);
  }
}

/** One and a half times the limit of plain-text thread, ending in a unique tail token. */
function oversizedThread(tail: string): string {
  const lines: string[] = [];
  let bytes = 0;
  for (let index = 1; bytes < configuredLimit * 1.5; index += 1) {
    const line = `Synthetic message ${index}: a routine status note about a fictional project, with nothing to act on.\n`;
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return `${lines.join("")}${tail}\n`;
}

async function startThreadEndpoint(thread: string): Promise<MutableMcpEndpoint> {
  const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
  const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
  const callTool = (name: string, args: Readonly<Record<string, unknown>>): CallToolResult =>
    name === TOOL_NAME && args.thread_id === THREAD_ID
      ? { content: [{ text: thread, type: "text" }] }
      : { content: [{ text: "Unknown synthetic tool or thread.", type: "text" }], isError: true };
  return startMutableMcpEndpoint([{
    annotations: { readOnlyHint: true },
    description: "Read one synthetic mail thread by its thread id and return its full plain-text body.",
    inputSchema: { additionalProperties: false, properties: { thread_id: { maxLength: 64, type: "string" } },
      required: ["thread_id"], type: "object" },
    name: TOOL_NAME
  }], { callTool, ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
}

/**
 * Publishes a synthetic installation server the signed-in administrator may
 * use and turns it on for them; its consent and the server are removed
 * afterwards.
 */
async function publishServer(page: Page, session: Session, endpoint: MutableMcpEndpoint, name: string): Promise<void> {
  const created = await page.request.post("/api/admin/mcp", { data: {
    activate: false,
    description: "Synthetic mail service for the paid oversized-result check",
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url }, transport: "streamable_http" },
    name,
    sharedValues: {}
  } });
  expect(created.status()).toBe(201);
  const server = (await created.json() as { server: AdminMcpServer }).server;
  session.defer(async () => {
    await page.request.delete(`/api/me/mcp-consents/${server.id}`).catch(() => undefined);
    await page.request.delete(`/api/admin/mcp/${server.id}`);
  });
  const checked = await page.request.post(`/api/admin/mcp/${server.id}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
  } });
  expect(checked.status()).toBe(200);
  expect((await page.request.put(`/api/admin/mcp/${server.id}/grants`, { data: {
    canUse: true, personalSlotKeys: [], userId: session.userId
  } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
}

/** A new personal chat on the codex-lb model with every tool off except MCP, which loads all tools. */
async function newChat(page: Page, model: PaidAnswerModel) {
  await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await selectModel(page, model.connectionId, model.displayName);
  await expect(page.getByTestId("header-model-trigger")).toContainText(model.displayName);
  await turnComposerToolsOff(page);
  const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
  await mcpMode.click();
  await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Load all/u }).click();
}

function runErrorCode(run: ModelRun): string | null {
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Sends one composer turn in a new chat and waits until its run settled; the run itself is returned unasserted. */
async function send(page: Page, session: Session, text: string): Promise<ModelRun> {
  const message = page.getByRole("textbox", { exact: true, name: "Message" });
  expect(parseChatRoutePath(new URL(page.url()).pathname)?.chatId ?? null, "the turn starts a new chat").toBeNull();
  await message.fill(text);
  await message.press("Enter");
  const chatId = await activeChatId(page);
  session.chatIds.add(chatId);
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const newest = await prisma.modelRun.findFirst({ orderBy: { createdAt: "desc" }, where: { chatId } });
    return newest && !ACTIVE_RUN_STATUSES.includes(newest.status) ? newest : null;
  }, "mcp_oversized_result_paid_run_timeout");
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return run;
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

type PersistedResult = Readonly<{
  content?: Array<{ text?: unknown; type?: unknown }>;
  rawPreview?: { deliveredBytes?: unknown; originalBytes?: unknown; truncated?: unknown };
  status?: unknown;
}>;

const prompt = `This is a test with one synthetic mail service. Call ${TOOL_NAME} exactly once with thread_id ${THREAD_ID} ` +
  "and do not call any other tool. Then reply in one short sentence saying whether the thread text you received was complete.";

test("an MCP result over the per-call limit reaches the model truncated as an ordinary completed call", async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000);
  await withSession(page, testInfo, "mcp-oversized-result", async (session) => {
    const tag = randomUUID().slice(0, 8);
    const tail = `TAIL-${tag}-NOT-DELIVERED`;
    const thread = oversizedThread(tail);
    const endpoint = await startThreadEndpoint(thread);
    session.defer(() => endpoint.close());
    await publishServer(page, session, endpoint, `Paid mail ${tag}`);
    session.summary.threadBytes = Buffer.byteLength(thread);

    await newChat(page, session.model);
    const run = await send(page, session, prompt);
    const calls = await prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
      where: { modelRunId: run.id, mcpRunBindingId: { not: null } } });
    const observations = await prisma.toolObservation.findMany({ select: { sourceTruncated: true, toolCallId: true },
      where: { modelRunId: run.id } });
    const call = calls[0];
    const result = (call?.result ?? null) as PersistedResult | null;
    const texts = (result?.content ?? []).flatMap((part) => typeof part.text === "string" ? [part.text] : []);
    const preview = result?.rawPreview;
    const originalBytes = typeof preview?.originalBytes === "number" ? preview.originalBytes : null;
    const deliveredBytes = typeof preview?.deliveredBytes === "number" ? preview.deliveredBytes : null;
    const serialized = JSON.stringify({ calls: calls.map((row) => row.result), error: run.errorPayload });
    // Recorded before the assertions, so a failing run still leaves its evidence.
    session.summary.run = {
      answered: (await answerText(run)).trim().length > 0,
      cascadeCodes: CASCADE_CODES.filter((code) => serialized.includes(code)),
      deliveredBytes,
      dispatches: endpoint.dispatches(TOOL_NAME),
      errorCode: runErrorCode(run),
      markerDelivered: texts.some((text) => text.startsWith(MARKER_PREFIX)),
      mcpCalls: calls.length,
      observationTruncated: observations.find((row) => row.toolCallId === call?.id)?.sourceTruncated ?? null,
      originalBytes,
      resultStatus: typeof result?.status === "string" ? result.status : null,
      state: call?.state ?? null,
      status: run.status,
      tailDelivered: serialized.includes(tail),
      truncated: preview?.truncated === true
    };
    expect(run.status, `the run completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(endpoint.dispatches(TOOL_NAME), "the tool was dispatched exactly once, never re-sent").toBe(1);
    expect(endpoint.dispatches(TOOL_NAME, { thread_id: THREAD_ID }), "with the requested thread").toBe(1);
    expect(calls, "one MCP tool call was persisted").toHaveLength(1);
    expect(call!.state, "the call settled as an ordinary completed call").toBe("complete");
    expect(result?.status, "its result is complete, not an error").toBe("complete");
    expect(preview?.truncated, "the result carries the truncation flag").toBe(true);
    expect(originalBytes, "the original size exceeds the limit").toBeGreaterThan(configuredLimit);
    expect(deliveredBytes, "the delivered size fits the limit").toBeLessThanOrEqual(configuredLimit);
    expect(texts.at(-1)?.startsWith(MARKER_PREFIX), "the delivered result ends with the truncation marker").toBe(true);
    expect(serialized.includes(tail), "the cut tail was not delivered").toBe(false);
    expect(CASCADE_CODES.filter((code) => serialized.includes(code)), "no session or call failure in the run").toEqual([]);
    if (observations.length > 0) {
      expect(observations.find((row) => row.toolCallId === call!.id)?.sourceTruncated, "the observation records the cut").toBe(true);
    }
    expect((await answerText(run)).trim().length, "the answer is present").toBeGreaterThan(0);
  });
});
