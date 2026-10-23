/**
 * Opt-in, paid, bounded scenario set for the native agent engine
 * (`lib/server/engine/`) on a real Codex LB answer model on a DISPOSABLE
 * stand, plus two simple coding tasks compared with a Codex Agent turn on the
 * old core (harness task, operator: simple scenarios, no elaborate benchmark).
 * The scenarios the other native paid specs already cover (streaming, MCP
 * write with approval, Stop then Continue in `native-engine-paid.spec.ts`;
 * XLSX → chart and `apply_patch` in `native-workspace-paid.spec.ts`; long
 * chat across compaction in `native-compaction-paid.spec.ts`) are not
 * repeated here. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). Each test first runs the disposable-target
 * guard (`scripts/stateful-test-target.ts`).
 *
 * Every scenario is its own test in its own chat, so a stand piece that is
 * missing skips only the scenarios that need it (with the reason), and a
 * failure does not stop the others (no serial mode, no retries: a retry
 * would pay again). What each scenario needs besides the Codex LB pair and
 * AIQSA_NATIVE_ENGINE_USERS='*' (or the operator's id or email) on the app:
 *
 *   0. Context window        nothing more: the shared codex-lb model is set
 *                            up with the template window, which setup
 *                            replaces with the gateway listing's window
 *                            (`lib/server/admin/providers/codexLbContextWindow.ts`);
 *                            the test reads the listing itself (a free
 *                            model-list read) and compares.
 *   1. Search with sources   codex-lb hosted web search first: a second
 *                            codex-lb connection is set up with
 *                            `nativeSearch`. When its hosted search check
 *                            does not pass (codex-lb rejects it), the model
 *                            offers no hosted source and, with
 *                            DEEPSEEK_API_KEY, the built-in DeepSeek Search
 *                            API source answers instead, set up as
 *                            `prod-1018-paid.spec.ts` scenario 7 does
 *                            (`support/deepSeekSearchApi.ts`); the answer
 *                            model stays the codex-lb one on the native
 *                            engine. Skips only when neither is available.
 *   2. Skill with a bundle   a real Workspace runner (below).
 *   3. Image generate + edit the codex-lb `gpt-image-2` model that custom
 *                            setup adds beside a Codex gateway's answer model
 *                            (`lib/server/admin/providers/setupModels.ts`),
 *                            with verified generation and editing; skips
 *                            otherwise.
 *   4. Plain question        nothing more.
 *   5a/5b. Coding tasks      a real Workspace runner, and Internet On in the
 *                            Workspace policy: the image ships no pytest
 *                            (`Dockerfile`), so the agent installs it. The
 *                            Codex Agent half also needs the Agent gateway:
 *                            AIQSA_AGENT_GATEWAY_URL on the app (the dev
 *                            Compose app sets it) and AIQSA_AGENT_APP_ORIGIN
 *                            on the runner, so `/api/workspace` reports
 *                            `agentAvailable` and the model's catalog entry
 *                            carries `agentAvailable`. Without them the
 *                            summary records `agent_unavailable` and only
 *                            the native half runs.
 *
 * The real runner is the one `native-workspace-paid.spec.ts` documents in its
 * header (AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0, AIQSA_WORKSPACE_RUNNER_URL,
 * AIQSA_WORKSPACE_RUNNER_TOKEN; the `workspace-runner` service of
 * `docker-compose.dev.yml`, profile `workspace-live`). The scenarios that
 * need it check the resolved runtime mode, the runner's health and the
 * installation's Workspace policy first.
 *
 *   docker compose -f docker-compose.dev.yml --profile workspace-live up -d --build
 *   docker compose -f docker-compose.dev.yml run --rm -T \
 *     -e AIQSA_FEATURES_PAID_E2E=DISPOSABLE -e AIQSA_NATIVE_ENGINE_USERS='*' \
 *     -e AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0 -e CODEX_LB_API_KEY -e CODEX_LB_BASE_URL \
 *     app npx playwright test --project=chromium tests/e2e/native-scenarios-paid.spec.ts
 *
 * Expected paid calls (Codex LB, plus DeepSeek only on the search fallback):
 * custom setup for the shared answer
 * connection once per worker (discovery plus its model checks, the image
 * model's included; a failed test restarts the worker, so the next test sets
 * up again), and once more for the search connection; one free model-list
 * read for the window check. Then: search one or two model requests with one
 * hosted search, or on the DeepSeek path one DeepSeek Search API request
 * (plus, only when no keyed DeepSeek connection or set-up source exists yet,
 * at most 8 probes of DeepSeek V4.1 Flash and one probe search on Save; no
 * DeepSeek model answers); Skill two to four (load_skill,
 * one or two Workspace commands, the answer); images two turns of two
 * requests each plus exactly two gpt-image-2 calls (low quality, 1024x1024),
 * and one image model check only when generation or editing is unverified;
 * plain question one request; each coding run about four to twelve requests
 * on the native engine and a similar number through the Codex Agent gateway.
 * About 40–70 requests in all.
 *
 * Oracles are the persisted runs, tool calls, usage rows, Search rows, stored
 * attachments and Agent bindings, the browser's own run streams (event kinds
 * and arrival times only, recorded by a content-free probe), the rendered
 * sources and images, the Workspace archive the product downloads (file
 * markers and pytest's own result line), a Skill script whose output depends
 * on a random salt the model never sees, and a few requested answer markers.
 * Prompts, answers and file contents are never printed; each test attaches a
 * content-free JSON summary (statuses, timings, counts, tool names and
 * provider-reported tokens). Chats (and their Workspaces), the Skill, the
 * image role and the personal image choice are restored or removed
 * afterwards; codex-lb connections stay on the stand like the other paid
 * specs' connections.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PrismaClient, type ModelRun, type Prisma } from "@prisma/client";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AdminImageModelCandidate, AdminSystemModelPolicyResponse } from "../../lib/contracts/adminSystemModelPolicy";
import { decodeCatalogResponse, type CatalogModel, type CatalogSearchStrategy } from "../../lib/contracts/catalog";
import { decodeThreadGeneratedImage, type ImageGenerationParameters } from "../../lib/contracts/imageGeneration";
import type { SkillImportResponse } from "../../lib/contracts/skills";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { CODEX_LB_TEMPLATE_CONTEXT_WINDOW } from "../../lib/server/admin/providers/codexLbContextWindow";
import { writeZip } from "../../lib/server/artifacts/zip";
import { getWorkspaceConfig, WorkspaceConfigError, type WorkspaceConfig } from "../../lib/server/workspace/config";
import { modelInConnection, readConnections, type JourneyConnection } from "../../scripts/context-compaction-journey-support";
import { chooseSearchStrategy, selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import {
  DEEPSEEK_SEARCH_API_COST_MICROS, DEEPSEEK_SEARCH_API_USAGE_MODEL, deepSeekConnection, deepSeekSearchApiSource
} from "./support/deepSeekSearchApi";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  newExcludedChat, paidEnv, PAID_SETUP_TIMEOUT_MS, pollUntil, setupCodexLbAnswerModel, waitForCatalogModel, type PaidAnswerModel
} from "./support/paidProviders";
import { disableMemoryRecall, lastAnswer } from "./support/workspace";

const prisma = new PrismaClient();

/** The app's Workspace configuration as the webServer would resolve it from this process's environment. */
function appWorkspaceConfig(): WorkspaceConfig | string {
  try {
    const config = getWorkspaceConfig({ ...process.env, AIQSA_TEST_MODE: "1",
      AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME?.trim() || "1" });
    return config.runtimeMode === "remote" ? config : config.runtimeMode;
  } catch (error) {
    return error instanceof WorkspaceConfigError ? error.code : "workspace_config_invalid";
  }
}

const workspaceConfig = appWorkspaceConfig();

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
// Scenarios are independent: a failure must not skip the rest, and a retry would pay again.
test.describe.configure({ retries: 0 });
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 900_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };
const FIRST_TOKEN_BOUND_MS = 10_000;
/** The cheapest gpt-image-2 request the codex-lb profile admits: low quality at the smallest standard square. */
const IMAGE_PARAMETERS: ImageGenerationParameters = { quality: "low", size: "1024x1024" };
const CODEX_IMAGE_MODEL = "gpt-image-2";

// ---------------------------------------------------------------------------
// A content-free probe of the browser's run streams: event kinds and arrival times only

type StreamRecord = Readonly<{ artifactType?: string; at: number; runId?: string; status?: string; stream: number; type: string }>;

/** Runs in the page before the app: tees every `text/event-stream` response and records each event's kind and arrival. */
function installStreamProbe(): void {
  const target = window as unknown as { __aiqsaScenarioProbe?: StreamRecord[] };
  if (target.__aiqsaScenarioProbe) return;
  const records: StreamRecord[] = [];
  target.__aiqsaScenarioProbe = records;
  let streams = 0;
  const original = window.fetch.bind(window);
  const record = (stream: number, block: string) => {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(data.join("\n"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      // A malformed event is recorded by its kind only.
    }
    records.push({ at: Date.now(), stream, type,
      ...(type === "artifact" && typeof payload.artifactType === "string" ? { artifactType: payload.artifactType } : {}),
      ...(type === "run_start" && typeof payload.runId === "string" ? { runId: payload.runId } : {}),
      ...(type === "done" && typeof payload.status === "string" ? { status: payload.status } : {}) });
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) return response;
    const [mine, theirs] = response.body.tee();
    streams += 1;
    const stream = streams;
    void (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          record(stream, buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
        }
        if (chunk.done) break;
      }
    })().catch(() => undefined);
    const teed = new Response(theirs, { headers: response.headers, status: response.status, statusText: response.statusText });
    Object.defineProperty(teed, "url", { value: response.url });
    return teed;
  };
}

/** The run's own stream records once it ended; null when the browser never saw it. */
async function streamRecords(page: Page, runId: string): Promise<StreamRecord[] | null> {
  return pollUntil(120_000, async () => {
    const records = await page.evaluate(() => (window as unknown as { __aiqsaScenarioProbe?: StreamRecord[] }).__aiqsaScenarioProbe ?? []);
    const stream = records.find((entry) => entry.type === "run_start" && entry.runId === runId)?.stream;
    if (stream === undefined) return null;
    const own = records.filter((entry) => entry.stream === stream);
    return own.some((entry) => entry.type === "done" || entry.type === "error") ? own : null;
  }, "native_scenario_run_stream_not_observed").catch(() => null);
}

/** Browser-clock milliseconds from the send to the first answer text and to the end of the stream. */
function streamTimings(records: readonly StreamRecord[] | null, sentAt: number) {
  if (!records) return { observed: false, toDoneMs: null, toFirstTokenMs: null, tokens: 0 };
  const since = (entry: StreamRecord | undefined) => entry ? entry.at - sentAt : null;
  const tokens = records.filter((entry) => entry.type === "token");
  return { doneStatus: records.find((entry) => entry.type === "done")?.status ?? null, observed: true,
    toDoneMs: since(records.find((entry) => entry.type === "done" || entry.type === "error")), toFirstTokenMs: since(tokens[0]),
    tokens: tokens.length };
}

// ---------------------------------------------------------------------------
// Stand, chats and runs

type Stand = Readonly<{
  chatIds: Set<string>;
  /** Removes what a test made beyond its chats, newest first. */
  cleanup: (() => Promise<unknown>)[];
  summary: Record<string, unknown>;
  userId: string;
}>;

/** One shared codex-lb connection per worker; the search scenario sets up its own. */
let answerModel: PaidAnswerModel | null = null;

/**
 * The shared codex-lb answer model. It declares the template window, which
 * setup treats as replaceable and fills from the gateway listing, so the
 * window check reads what setup does on its own; an explicit window would be
 * the administrator's and kept.
 */
async function sharedAnswerModel(page: Page, stand: Stand): Promise<PaidAnswerModel> {
  answerModel ??= await setupCodexLbAnswerModel(page.request, {
    contextWindow: CODEX_LB_TEMPLATE_CONTEXT_WINDOW, label: "Native scenarios", nativeSearch: false,
    preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
  });
  stand.summary.answerModel = answerModel.upstreamModelId;
  return answerModel;
}

const MEMORY_TOGGLES = { learnAutomatically: true, referenceChatHistory: true, useMemoryFacts: true } satisfies Prisma.UserMemorySettingsSelect;
type MemoryToggles = Prisma.UserMemorySettingsGetPayload<{ select: typeof MEMORY_TOGGLES }>;

/** A content-free failure code: a stable error code (Prisma's or the product's) or the error class, never the message. */
function failureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) return name;
  }
  return "unknown";
}

/**
 * Signs in, installs the stream probe and runs `body`; the chats it created
 * and everything in `cleanup` are removed and the account's chat defaults
 * restored afterwards, and the content-free summary is attached.
 */
async function withStand(page: Page, testInfo: TestInfo, label: string, body: (stand: Stand) => Promise<void>): Promise<void> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(installStreamProbe);
  const chatIds = new Set<string>();
  const cleanup: (() => Promise<unknown>)[] = [];
  const summary: Record<string, unknown> = { scenario: label };
  let restoreDefaults: (() => Promise<void>) | null = null;
  let memoryToggles: MemoryToggles | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    memoryToggles = await prisma.userMemorySettings.findUnique({ select: MEMORY_TOGGLES, where: { userId } });
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    await body({ chatIds, cleanup, summary, userId });
    summary.status = "passed";
  } catch (error) {
    // A runtime skip is not a failure of the scenario.
    summary.status = summary.status ?? "failed";
    throw error;
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    for (const step of cleanup.reverse()) await step().catch(() => { summary.cleanup = "failed"; });
    // Memory toggles go back through the product's own settings route first, as the user would switch them, so the
    // shared restore below finds them unchanged; it then restores the composer defaults.
    if (memoryToggles) {
      summary.memoryTogglesRestore = await page.request.patch("/api/me/memory/settings", { data: memoryToggles })
        .then((response) => response.status()).catch((error: unknown) => failureCode(error));
    }
    await restoreDefaults?.().catch((error: unknown) => { summary.composerDefaultsRestore = { code: failureCode(error), failed: true }; });
    await testInfo.attach(`${label}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`native_scenarios_paid_summary ${label} ${JSON.stringify(summary)}`);
  }
}

/** Skips the running scenario with `reason`, recording it in the summary first. */
function skipScenario(stand: Stand, reason: string): never {
  stand.summary.status = "skipped";
  stand.summary.skipReason = reason;
  test.skip(true, reason);
  throw new Error("unreachable");
}

/** A new chat outside Memory on `model`, with MCP, Search and Skills off unless Skills are asked for. */
async function openChat(page: Page, stand: Stand, model: PaidAnswerModel, title: string,
  skills: "auto" | "off" = "off"): Promise<string> {
  const chatId = await newExcludedChat(page.request, `${title} ${randomUUID().slice(0, 8)}`);
  stand.chatIds.add(chatId);
  await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => selectModel(page, model.connectionId, model.displayName)).toPass({ timeout: 60_000 });
  await expect(page.getByTestId("header-model-trigger")).toContainText(model.displayName);
  await turnComposerToolsOff(page);
  if (skills === "auto") {
    const mode = page.getByRole("button", { name: "Change Skills mode" });
    await mode.click();
    await page.getByRole("menu", { name: "Skills" }).getByRole("menuitemradio", { name: /^Auto/u }).click();
    await expect(mode).toHaveAttribute("data-skills-mode", "auto");
  }
  return chatId;
}

async function runIds(chatId: string): Promise<string[]> {
  return (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
}

/** Sends the composer's text; returns the browser-clock and test-clock times of the send. */
async function sendComposer(page: Page, text: string): Promise<Readonly<{ browserAt: number; nodeAt: number }>> {
  const composer = page.getByRole("textbox", { exact: true, name: "Message" });
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({ timeout: 120_000 });
  const browserAt = await page.evaluate(() => Date.now());
  const nodeAt = Date.now();
  await composer.press("Enter");
  return { browserAt, nodeAt };
}

async function newRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  return pollUntil(120_000, async () => prisma.modelRun.findFirst({
    orderBy: { createdAt: "desc" }, where: { chatId, id: { notIn: [...earlier] } }
  }), "native_scenario_run_not_admitted");
}

/** Waits until the run settles, whatever its engine and outcome; returns it with the test-clock time it was seen settled. */
async function settled(runId: string): Promise<Readonly<{ run: ModelRun; seenAt: number }>> {
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
    return ACTIVE_RUN_STATUSES.includes(current.status) ? null : current;
  }, "native_scenario_run_timeout");
  return { run, seenAt: Date.now() };
}

const errorCode = (run: ModelRun): string | null => {
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

/** The run completed on the native engine. */
function expectNativeComplete(run: ModelRun): void {
  expect(run.engine, "the run ran on the native engine (the stand's app needs AIQSA_NATIVE_ENGINE_USERS)").toBe("native");
  expect(run.status, `the run completes (${errorCode(run) ?? run.status})`).toBe("complete");
}

type Turn = Readonly<{ records: StreamRecord[] | null; run: ModelRun; sent: Readonly<{ browserAt: number; nodeAt: number }>; seenAt: number }>;

/** Sends a turn in the open chat and returns its settled native run and its own stream records. */
async function nativeTurn(page: Page, chatId: string, text: string): Promise<Turn> {
  const earlier = await runIds(chatId);
  const sent = await sendComposer(page, text);
  const { run, seenAt } = await settled((await newRun(chatId, earlier)).id);
  expectNativeComplete(run);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return { records: await streamRecords(page, run.id), run, seenAt, sent };
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

/** The run's tool calls by name and state, and those that ran in the Workspace. */
async function toolCalls(runId: string) {
  const rows = await prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { state: true, toolName: true, workspaceRunBindingId: true }, where: { modelRunId: runId } });
  const workspace = rows.filter((row) => row.workspaceRunBindingId !== null || /^mcp_workspace_|sandbox_/u.test(row.toolName));
  return { count: rows.length, names: rows.map((row) => `${row.toolName}:${row.state}`), rows, workspace };
}

/**
 * Provider-reported usage of the run, summed over its usage rows (one per
 * physical request that reported usage). Usage is written after the answer
 * and retried, so this waits a little for the first row; a field no row
 * reported stays null, never estimated.
 */
const USAGE_SELECT = { cachedInputTokens: true, inputTokens: true, outputTokens: true, purpose: true, reasoningTokens: true,
  totalTokens: true, webSearchCount: true } satisfies Prisma.UsageEventSelect;
type UsageRow = Prisma.UsageEventGetPayload<{ select: typeof USAGE_SELECT }>;
type UsageCount = "cachedInputTokens" | "inputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens" | "webSearchCount";

async function runUsage(runId: string) {
  const rows: UsageRow[] = await pollUntil(60_000, async () => {
    const found = await prisma.usageEvent.findMany({ select: USAGE_SELECT, where: { modelRunId: runId } });
    return found.length > 0 ? found : null;
  }, "native_scenario_usage_missing").catch(() => null) ?? [];
  const sum = (key: UsageCount) => rows.some((row) => row[key] !== null) ? rows.reduce((total, row) => total + (row[key] ?? 0), 0) : null;
  const purposes: Record<string, number> = {};
  for (const row of rows) purposes[row.purpose] = (purposes[row.purpose] ?? 0) + 1;
  return {
    cachedInputTokens: sum("cachedInputTokens"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), purposes,
    reasoningTokens: sum("reasoningTokens"), rows: rows.length, rowsWithoutTokens: rows.filter((row) => row.totalTokens === null).length,
    totalTokens: sum("totalTokens"), webSearchCount: sum("webSearchCount")
  };
}

/** Waits until the run's Workspace handoff is over (operation released, output export settled); null without a binding. */
async function settledWorkspace(runId: string) {
  return pollUntil(240_000, async () => {
    const binding = await prisma.workspaceRunBinding.findUnique({ select: { exportState: true, guestUsedAt: true,
      workspaceSession: { select: { operationOwner: true, state: true } } }, where: { modelRunId: runId } });
    if (!binding) return { binding: null };
    if (binding.workspaceSession.operationOwner !== null || !["COMPLETE", "FAILED"].includes(binding.exportState)) return null;
    return { binding };
  }, "native_scenario_workspace_handoff_timeout");
}

/** Regular files of a gzip tar archive by their path. */
function tarFiles(gzip: Buffer): Map<string, Buffer> {
  const archive = gunzipSync(gzip);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start: number, end: number) => Buffer.from(header.subarray(start, end)).toString("utf8").replace(/\0.*$/su, "");
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join("/").replace(/^\.\//u, "");
    const size = Number.parseInt(text(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + 512;
    if (type === "0" || type === "\0") files.set(name, Buffer.from(archive.subarray(dataOffset, dataOffset + size)));
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The chat's Workspace as the product's "Download workspace" action exports it. */
async function workspaceArchive(page: Page, chatId: string): Promise<Map<string, Buffer>> {
  const response = await pollUntil(300_000, async () => {
    const attempt = await page.request.post(`/api/chats/${chatId}/workspace/archive`, { timeout: 360_000 });
    return attempt.status() === 409 ? null : attempt;
  }, "native_scenario_archive_busy");
  expect(response.status(), "the Workspace archive is made").toBe(200);
  const file = (await response.json() as { file: { attachmentId: string } }).file;
  const content = await page.request.get(`/api/attachments/${encodeURIComponent(file.attachmentId)}/content`);
  expect(content.status(), "the Workspace archive downloads").toBe(200);
  return tarFiles(await content.body());
}

/** The archive's file whose path is `suffix` or ends with `/<suffix>`, as UTF-8 text. */
function archived(archive: ReadonlyMap<string, Buffer>, suffix: string): string | null {
  for (const [name, bytes] of archive) if (name === suffix || name.endsWith(`/${suffix}`)) return bytes.toString("utf8");
  return null;
}

/** The runner answers its own health check and the installation offers Workspace; skips without a real runner. */
async function requireRealRunner(stand: Stand): Promise<void> {
  if (typeof workspaceConfig === "string") {
    skipScenario(stand, `requires a real Workspace runner: the app's Workspace runtime resolves to ${workspaceConfig} ` +
      "(set AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0, AIQSA_WORKSPACE_RUNNER_URL and AIQSA_WORKSPACE_RUNNER_TOKEN)");
  }
  const config = workspaceConfig as WorkspaceConfig;
  const health = await fetch(new URL("health", `${config.runnerUrl!.toString().replace(/\/?$/u, "/")}`),
    { headers: { authorization: `Bearer ${config.runnerToken!}` }, signal: AbortSignal.timeout(30_000) });
  stand.summary.runnerHealth = health.status;
  expect(health.ok, "the Workspace runner is healthy").toBe(true);
  const policy = await prisma.workspacePolicy.findUnique({ select: { enabled: true, internetEnabled: true }, where: { id: "installation" } });
  stand.summary.workspacePolicy = { enabled: policy?.enabled ?? null, internetEnabled: policy?.internetEnabled ?? null };
  expect(policy?.enabled, "the installation's Workspace policy is enabled").toBe(true);
}

// ---------------------------------------------------------------------------
// Screenshots

async function viewportShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}.png`, { contentType: "image/png", path });
}

async function desktopShot(page: Page, testInfo: TestInfo, focus: Locator, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await focus.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await viewportShot(page, testInfo, `${name}-desktop-1440x900`);
}

/** A phone viewport shot in a touch context of its own; `prepare` may open what the shot shows. */
async function phoneShot(browser: Browser, baseURL: string, chatId: string, testInfo: TestInfo, name: string,
  focus: (page: Page) => Locator, prepare?: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL, deviceScaleFactor: 3, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    viewport: PHONE });
  try {
    await authenticateWithLocalToken(context.request);
    const phone = await context.newPage();
    await phone.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
    await expect(phone.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    await prepare?.(phone);
    const target = focus(phone);
    await expect(target).toBeVisible({ timeout: 60_000 });
    await target.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(phone);
    await viewportShot(phone, testInfo, `${name}-phone-390x844`);
  } finally {
    await context.close();
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const codeWord = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;

// ---------------------------------------------------------------------------
// Search: the codex-lb hosted web search source

async function catalogState(request: APIRequestContext) {
  return decodeCatalogResponse(await (await request.get("/api/me/catalog")).json());
}

type AdminIntegration = Readonly<{ archivedAt: string | null; configurationActive: boolean; enabled: boolean; id: string;
  sourceConnectionId: string }>;

/**
 * The model's hosted Search source in the user's catalog, after enabling the
 * connection's Search integrations that setup left disabled; null when none
 * appears (its hosted search check did not pass).
 */
async function hostedSearchSource(request: APIRequestContext, model: PaidAnswerModel): Promise<CatalogSearchStrategy | null> {
  const admin = await request.get("/api/admin/search");
  if (admin.ok()) {
    const integrations = (await admin.json() as { search: { integrations: AdminIntegration[] } }).search.integrations;
    for (const integration of integrations) {
      if (integration.sourceConnectionId !== model.connectionId || integration.archivedAt !== null || !integration.configurationActive ||
        integration.enabled) continue;
      await request.post(`/api/admin/search/${integration.id}/actions`, { data: { action: "enable" } }).catch(() => undefined);
    }
  }
  return pollUntil(90_000, async () => {
    const catalog = await catalogState(request);
    const entry: CatalogModel | undefined = catalog?.models.find((candidate) => candidate.provider === model.connectionId &&
      candidate.modelId === model.modelId);
    if (!catalog || !entry) return null;
    const offered = catalog.searchStrategies.filter((strategy) => entry.searchStrategyIds.includes(strategy.strategyId));
    return offered.find((strategy) => strategy.adapterKind === "answer_provider_hosted") ??
      offered.find((strategy) => strategy.strategyId.includes(model.connectionId)) ?? null;
  }, "native_scenario_hosted_search_missing").catch(() => null);
}

/** Search calls the run made, by evidence: provider-reported hosted searches, Search rows and kept search artifacts. */
async function searchCalls(runId: string, usage: Awaited<ReturnType<typeof runUsage>>) {
  const searchRuns = await prisma.searchRun.findMany({ select: { status: true }, where: { modelRunId: runId } });
  const events = await prisma.modelRunEvent.findMany({ select: { payload: true }, where: { eventType: "artifact", modelRunId: runId } });
  const searchArtifacts = events.filter((row) => (row.payload as { artifactType?: unknown } | null)?.artifactType === "search").length;
  return { hostedReported: usage.webSearchCount, searchArtifacts, searchRuns: searchRuns.length,
    searchRunStatuses: searchRuns.map((row) => row.status) };
}

// ---------------------------------------------------------------------------
// Images: the codex-lb gpt-image-2 model as the installation default

type ImageRole = Readonly<{
  imageProviderModelId: string | null;
  imageModels: ReadonlyArray<Readonly<{ providerModelId: string; parameters: ImageGenerationParameters }>>;
}>;

const chatImages = (page: Page) => page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]');

async function settledConnection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, "codex_lb_checks_timeout");
}

async function systemModelPolicy(request: APIRequestContext): Promise<AdminSystemModelPolicyResponse["systemModelPolicy"]> {
  const response = await request.get("/api/admin/providers/system-model-policy");
  expect(response.ok(), `the system model policy is readable (${response.status()})`).toBe(true);
  return (await response.json() as AdminSystemModelPolicyResponse).systemModelPolicy;
}

async function imageCandidate(request: APIRequestContext, providerModelId: string): Promise<AdminImageModelCandidate | null> {
  return (await systemModelPolicy(request)).imageCandidates?.find((candidate) => candidate.id === providerModelId) ?? null;
}

/** The codex-lb image deployment with verified generation and editing, rechecking only it when needed; null otherwise. */
async function codexImageModel(request: APIRequestContext, connectionId: string, summary: Record<string, unknown>): Promise<string | null> {
  const connection = await settledConnection(request, connectionId);
  const model = modelInConnection(connection, CODEX_IMAGE_MODEL);
  summary.imageModelOnConnection = model !== null;
  if (!model) return null;
  let candidate = await imageCandidate(request, model.id);
  summary.imageModelRecheck = !candidate?.generation || !candidate.editing;
  if ((!candidate?.generation || !candidate.editing) && connection.defaultCredentialId) {
    const started = await request.post(`/api/admin/providers/${encodeURIComponent(connectionId)}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS,
      data: { action: "check_models", credentialId: connection.defaultCredentialId, modelIds: [model.id] } });
    summary.imageModelRecheckStarted = started.status();
    if (started.ok()) {
      await settledConnection(request, connectionId);
      candidate = await imageCandidate(request, model.id);
    }
  }
  summary.imageModelVerified = { editing: candidate?.editing ?? false, generation: candidate?.generation ?? false };
  return candidate?.generation && candidate.editing ? model.id : null;
}

async function saveImageRole(request: APIRequestContext, role: ImageRole): Promise<void> {
  const { version } = (await systemModelPolicy(request)).policy;
  const response = await request.patch("/api/admin/providers/system-model-policy", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    expectedVersion: version, imageModels: role.imageModels, imageProviderModelId: role.imageProviderModelId
  } });
  expect(response.ok(), `the Image generation role is saved (${response.status()})`).toBe(true);
}

/** Publishes the model as the default with the cheapest parameters, keeping the other published models; returns the previous role. */
async function publishDefaultImageModel(request: APIRequestContext, providerModelId: string): Promise<ImageRole> {
  const { policy } = await systemModelPolicy(request);
  const previous: ImageRole = { imageModels: (policy.imageModels ?? []).map((model) => ({ parameters: model.parameters, providerModelId: model.id })),
    imageProviderModelId: policy.imageModel?.id ?? null };
  await saveImageRole(request, { imageModels: [
    ...previous.imageModels.filter((entry) => entry.providerModelId !== providerModelId), { parameters: IMAGE_PARAMETERS, providerModelId }
  ], imageProviderModelId: providerModelId });
  const published = (await systemModelPolicy(request)).policy;
  expect(published.imageModel?.id, "the codex-lb image model is the default").toBe(providerModelId);
  return previous;
}

/** The run's one stored generated image: content-free facts plus its id and sources. */
async function storedImage(request: APIRequestContext, chatId: string, runId: string, providerModelId: string) {
  const rows = await prisma.attachment.findMany({ where: { chatId, origin: "IMAGE_OUTPUT", producerModelRunId: runId } });
  expect(rows, "the run stored one generated image").toHaveLength(1);
  const row = rows[0]!;
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  const image = decodeThreadGeneratedImage(metadata.image);
  expect(image, "the stored image metadata decodes").not.toBeNull();
  expect(metadata.providerModelId, "the codex-lb image model produced it").toBe(providerModelId);
  const download = await request.get(`/api/attachments/${row.id}/content`, { timeout: 120_000 });
  expect(download.status(), "Download serves the original").toBe(200);
  const bytes = await download.body();
  const checksumMatches = createHash("sha256").update(bytes).digest("hex") === row.checksum;
  expect(checksumMatches, "the downloaded bytes match the stored checksum").toBe(true);
  return { facts: { byteSize: row.byteSize, checksumMatches, height: image!.height, mimeType: row.mimeType,
    sourceCount: image!.sourceAttachmentIds.length, width: image!.width }, id: row.id, sourceAttachmentIds: image!.sourceAttachmentIds };
}

// ---------------------------------------------------------------------------
// The Skill bundle

/** A personal Skill whose script prints a seal of its argument under a random salt only the bundle holds. */
function sealSkill(name: string, salt: string): Buffer {
  const folder = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  const skill = `---\nname: ${JSON.stringify(name)}\ndescription: Seal a phrase with the bundled seal script and report its SEAL line.\n---\n` +
    "# Seal a phrase\n\nThis Skill's folder holds `scripts/seal.py`. To seal a phrase, run it in the Workspace from this Skill's " +
    "folder (the Workspace path load_skill returns): `python3 scripts/seal.py \"<phrase>\"`. It prints one line `SEAL: <value>`. " +
    "Never compute the seal yourself: report the script's line exactly as printed.\n";
  const script = "import hashlib\nimport sys\n\n" +
    `SALT = ${JSON.stringify(salt)}\n\n` +
    "phrase = \" \".join(sys.argv[1:]).strip()\n" +
    "print(\"SEAL: \" + hashlib.sha256((SALT + phrase).encode(\"utf-8\")).hexdigest()[:12])\n";
  return writeZip([
    { bytes: Buffer.from(skill), path: `${folder}/SKILL.md` },
    { bytes: Buffer.from(script), executable: true, path: `${folder}/scripts/seal.py` }
  ]);
}

// ---------------------------------------------------------------------------
// The coding tasks

type CodingTask = Readonly<{
  attachments: ReadonlyArray<Readonly<{ name: string; text: string }>>;
  key: "bugfix" | "fizzbuzz";
  prompt: string;
  /** Content-free checks of the Workspace archive; success is all of them. */
  verify(archive: ReadonlyMap<string, Buffer>): Record<string, boolean>;
}>;

/** pytest's own summary line: how many passed, and whether anything failed or errored. */
function pytestResult(text: string | null) {
  if (text === null) return { failedOrError: null, passed: null };
  const passed = [...text.matchAll(/\b(\d+) passed\b/gu)].at(-1)?.[1];
  return { failedOrError: /\b\d+ (?:failed|errors?)\b/u.test(text), passed: passed === undefined ? null : Number(passed) };
}

const FIZZBUZZ_TASK: CodingTask = {
  attachments: [],
  key: "fizzbuzz",
  prompt: "In the Workspace, create the folder /workspace/project/fizz. In it, write fizzbuzz.py with a function fizzbuzz(n) that " +
    "returns a list of strings for the numbers 1 to n: \"Fizz\" for multiples of 3, \"Buzz\" for multiples of 5, \"FizzBuzz\" for " +
    "multiples of both, and the number itself otherwise. Write test_fizzbuzz.py next to it with pytest tests for that function. " +
    "If pytest is not installed, install it (for example into a virtual environment under /workspace/tmp). Then run exactly " +
    "`cd /workspace/project/fizz && python -m pytest -q > pytest_result.txt 2>&1` with the Python that has pytest, fix the code if a " +
    "test fails, and run it again until the tests pass. Finally tell me in one sentence whether the tests pass.",
  verify(archive) {
    const source = archived(archive, "fizz/fizzbuzz.py");
    const tests = archived(archive, "fizz/test_fizzbuzz.py");
    const result = pytestResult(archived(archive, "fizz/pytest_result.txt"));
    return {
      functionDefined: source !== null && /def\s+fizzbuzz\s*\(\s*n\b/u.test(source),
      pytestPassed: (result.passed ?? 0) >= 1 && result.failedOrError === false,
      testsWritten: tests !== null && /def\s+test_\w*\s*\(/u.test(tests) && tests.includes("fizzbuzz")
    };
  }
};

const BUGGY_STATS = "\"\"\"Small statistics helpers.\"\"\"\n\n\n" +
  "def median(values):\n" +
  "    \"\"\"Return the median of a non-empty list of numbers.\"\"\"\n" +
  "    if not values:\n" +
  "        raise ValueError(\"median() needs at least one value\")\n" +
  "    ordered = sorted(values)\n" +
  "    middle = len(ordered) // 2\n" +
  "    if len(ordered) % 2 == 0:\n" +
  "        return (ordered[middle - 1] + ordered[middle]) / 2\n" +
  "    return ordered[middle + 1]\n";
const STATS_TESTS = "import pytest\n\nfrom stats_utils import median\n\n\n" +
  "def test_odd_count():\n    assert median([7, 1, 3]) == 3\n\n\n" +
  "def test_even_count():\n    assert median([4, 1, 3, 2]) == 2.5\n\n\n" +
  "def test_single_value():\n    assert median([5]) == 5\n\n\n" +
  "def test_empty_raises():\n    with pytest.raises(ValueError):\n        median([])\n";
const normalizedLines = (text: string) => text.replace(/\r\n/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();

const BUGFIX_TASK: CodingTask = {
  attachments: [{ name: "stats_utils_py.txt", text: BUGGY_STATS }, { name: "test_stats_utils_py.txt", text: STATS_TESTS }],
  key: "bugfix",
  prompt: "The attached files stats_utils_py.txt and test_stats_utils_py.txt are Python sources. In the Workspace, create the folder " +
    "/workspace/project/bugfix and put their exact contents into /workspace/project/bugfix/stats_utils.py and " +
    "/workspace/project/bugfix/test_stats_utils.py. The tests fail because of a bug in stats_utils.py: fix that bug in " +
    "stats_utils.py only and do not change the test file. If pytest is not installed, install it (for example into a virtual " +
    "environment under /workspace/tmp). Then run exactly `cd /workspace/project/bugfix && python -m pytest -q > pytest_result.txt 2>&1` " +
    "with the Python that has pytest, until the tests pass. Finally tell me in one sentence what the bug was.",
  verify(archive) {
    const source = archived(archive, "bugfix/stats_utils.py");
    const tests = archived(archive, "bugfix/test_stats_utils.py");
    const result = pytestResult(archived(archive, "bugfix/pytest_result.txt"));
    return {
      bugRemoved: source !== null && /def\s+median\s*\(/u.test(source) && !source.includes("ordered[middle + 1]"),
      pytestPassed: result.passed === 4 && result.failedOrError === false,
      testsUnchanged: tests !== null && normalizedLines(tests) === normalizedLines(STATS_TESTS)
    };
  }
};

type Engine = "codex_agent" | "native";

/** Whether the chat's composer offers a Codex Agent turn on this model now, with the reason when not. */
async function codexAgentAvailability(page: Page, model: PaidAnswerModel): Promise<string | null> {
  const workspace = await page.request.get("/api/workspace");
  const agentReady = workspace.ok() && (await workspace.json() as { workspace?: { agentAvailable?: unknown } }).workspace?.agentAvailable === true;
  if (!agentReady) return "workspace_agent_not_ready";
  const entry = (await catalogState(page.request))?.models.find((candidate) => candidate.provider === model.connectionId &&
    candidate.modelId === model.modelId);
  if (entry?.agentAvailable !== true) return "model_agent_unavailable";
  const chip = page.getByRole("button", { exact: true, name: "Agent" });
  if (!await chip.isVisible().catch(() => false)) return "composer_agent_chip_missing";
  if (await chip.getAttribute("aria-disabled") === "true") return "composer_agent_chip_disabled";
  return null;
}

/**
 * One coding run in a chat of its own: the native engine, or a Codex Agent
 * turn on the old core. Outcomes are recorded, never thrown, so the other
 * engine still runs; the caller asserts the native half.
 */
async function codingRun(page: Page, stand: Stand, model: PaidAnswerModel, task: CodingTask, engine: Engine): Promise<Record<string, unknown>> {
  const outcome: Record<string, unknown> = { engine, task: task.key };
  try {
    const chatId = await openChat(page, stand, model, `Native coding ${task.key} ${engine}`);
    if (engine === "codex_agent") {
      const unavailable = await codexAgentAvailability(page, model);
      if (unavailable) return { ...outcome, status: "agent_unavailable", unavailableReason: unavailable };
      const chip = page.getByRole("button", { exact: true, name: "Agent" });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
    }
    for (const file of task.attachments) {
      await page.getByLabel("Attach files").setInputFiles({ buffer: Buffer.from(file.text), mimeType: "text/plain", name: file.name });
      const item = page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: file.name });
      await expect(item).toHaveAttribute("data-attachment-status", "ready", { timeout: 180_000 });
    }
    const earlier = await runIds(chatId);
    const sent = await sendComposer(page, task.prompt);
    const { run, seenAt } = await settled((await newRun(chatId, earlier)).id);
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
    const calls = await toolCalls(run.id);
    const agent = await prisma.agentRunBinding.findUnique({ select: { failureCode: true, modelCalls: true, toolCalls: true },
      where: { modelRunId: run.id } });
    Object.assign(outcome, {
      agentBinding: agent ? { failureCode: agent.failureCode, modelCalls: agent.modelCalls, toolCalls: agent.toolCalls } : null,
      errorCode: errorCode(run), runEngine: run.engine, status: run.status,
      timings: { serverToAnswerCompletedMs: run.answerCompletedAt ? run.answerCompletedAt.getTime() - run.createdAt.getTime() : null,
        wallMs: seenAt - sent.nodeAt },
      // The native engine keeps every call as a tool call row; a Codex Agent turn counts its calls on its binding.
      toolCalls: engine === "native" ? calls.count : agent?.toolCalls ?? calls.count,
      toolNames: calls.names, usage: await runUsage(run.id), workspaceCalls: calls.workspace.length
    });
    const handoff = await settledWorkspace(run.id).catch(() => null);
    outcome.exportState = handoff?.binding?.exportState ?? null;
    const checks = task.verify(await workspaceArchive(page, chatId));
    outcome.checks = checks;
    outcome.success = run.status === "complete" && Object.values(checks).every(Boolean) &&
      (engine === "native" ? run.engine === "native" : agent !== null);
  } catch (error) {
    outcome.success = false;
    outcome.failure = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message : "scenario_error";
  }
  return outcome;
}

async function codingComparison(page: Page, testInfo: TestInfo, task: CodingTask): Promise<void> {
  await withStand(page, testInfo, `native-coding-${task.key}`, async (stand) => {
    await requireRealRunner(stand);
    const model = await sharedAnswerModel(page, stand);
    const native = await codingRun(page, stand, model, task, "native");
    stand.summary.native = native;
    stand.summary.codexAgent = await codingRun(page, stand, model, task, "codex_agent");
    expect(native.runEngine, "the native half ran on the native engine").toBe("native");
    expect(native.status, `the native run completes (${String(native.errorCode ?? native.failure ?? native.status)})`).toBe("complete");
    const checks = (native.checks ?? null) as Record<string, boolean> | null;
    expect(checks, `the native run's Workspace was checked (${String(native.failure ?? "ok")})`).not.toBeNull();
    expect(checks, "the native run left passing tests and the asked files")
      .toEqual(Object.fromEntries(Object.keys(checks!).map((key) => [key, true])));
    expect(native.success, "the native run succeeded").toBe(true);
  });
}

// ---------------------------------------------------------------------------

/** A listed window as `lib/server/admin/providers/credentialTester.ts` reads it: `context_length` or `context_window`, never `max_context_window`. */
function listedWindow(entry: Record<string, unknown>): number | null {
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const capabilities = record(entry.capabilities);
  const metadata = record(entry.metadata);
  const value = [entry.contextWindow, entry.context_length, entry.context_window, capabilities.context_length, metadata.context_window]
    .find((candidate) => Number.isInteger(candidate) && Number(candidate) > 0 && Number(candidate) <= 10_000_000);
  return value === undefined ? null : Number(value);
}

/** The gateway's own model listing (`<CODEX_LB_BASE_URL>/models`, a free read) for one model: its window, or why there is none. */
async function gatewayListing(upstreamModelId: string): Promise<Readonly<{ listed: number | null; listing: string }>> {
  const response = await fetch(`${paidEnv("CODEX_LB_BASE_URL")!.replace(/\/+$/u, "")}/models`, {
    headers: { accept: "application/json", authorization: `Bearer ${paidEnv("CODEX_LB_API_KEY")!}` }, signal: AbortSignal.timeout(30_000)
  }).catch(() => null);
  if (!response?.ok) return { listed: null, listing: `unreadable_${response?.status ?? "network"}` };
  const data = (await response.json().catch(() => null) as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { listed: null, listing: "unreadable_shape" };
  const entry = (data as unknown[]).find((candidate) => candidate && typeof candidate === "object" &&
    (candidate as { id?: unknown }).id === upstreamModelId) as Record<string, unknown> | undefined;
  if (!entry) return { listed: null, listing: "model_not_listed" };
  const listed = listedWindow(entry);
  return { listed, listing: listed === null ? "listing_has_no_window" : "listed" };
}

test.describe("native engine scenario set on Codex LB", () => {
  test("0. the shared codex-lb model's context window is the gateway listing's", async ({ page }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withStand(page, testInfo, "codex-lb-context-window", async (stand) => {
      const model = await sharedAnswerModel(page, stand);
      const { listed, listing } = await gatewayListing(model.upstreamModelId);
      const storedWindow = async () => {
        const row = await prisma.providerModel.findUnique({ select: { activeConfig: true }, where: { id: model.modelId } });
        const capabilities = (row?.activeConfig as { capabilities?: { contextWindow?: unknown } } | null)?.capabilities;
        return typeof capabilities?.contextWindow === "number" ? capabilities.contextWindow : null;
      };
      // Setup's background checks fill the window; give them a little time after the model became selectable.
      const stored = listed === null ? await storedWindow()
        : await pollUntil(120_000, async () => await storedWindow() === listed ? listed : null, "codex_lb_window_not_listed")
          .catch(() => storedWindow());
      Object.assign(stand.summary, { listing, window: { listed, stored, templateDefault: CODEX_LB_TEMPLATE_CONTEXT_WINDOW } });
      if (listed !== null) expect(stored, "the stored window is the gateway listing's").toBe(listed);
      else expect(stored, `${listing}: the template default is kept`).toBe(CODEX_LB_TEMPLATE_CONTEXT_WINDOW);
    });
  });

  test("1. search with sources: codex-lb hosted web search, else the DeepSeek Search API, answers with a source shown", async ({ page,
    browser, baseURL }, testInfo) => {
    test.setTimeout(60 * 60_000);
    await withStand(page, testInfo, "native-search-sources", async (stand) => {
      // A connection of its own: declaring hosted search must not change the other scenarios' model.
      const model = await setupCodexLbAnswerModel(page.request, {
        label: "Native scenarios search", nativeSearch: true, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
      });
      stand.summary.answerModel = model.upstreamModelId;
      const hosted = await hostedSearchSource(page.request, model);
      stand.summary.hostedSource = hosted ? { adapterKind: hosted.adapterKind ?? null, kind: hosted.kind,
        modes: hosted.executionModes ?? null } : null;
      let path: "codex_lb_hosted" | "deepseek_search_api";
      let sourceName: string;
      if (hosted) {
        path = "codex_lb_hosted";
        sourceName = hosted.displayName;
      } else {
        const secret = paidEnv("DEEPSEEK_API_KEY");
        if (!secret) skipScenario(stand, "no web search source: codex-lb offers no hosted Search source and DEEPSEEK_API_KEY is not set");
        path = "deepseek_search_api";
        const deepSeekSummary: Record<string, unknown> = {};
        stand.summary.deepSeek = deepSeekSummary;
        const deepSeek = await deepSeekConnection(page.request, secret, "Native scenarios DeepSeek", deepSeekSummary);
        const source = await deepSeekSearchApiSource(page, prisma, deepSeek.id, deepSeekSummary);
        // The codex-lb answer model is offered the source once the catalog lists it for that model.
        await waitForCatalogModel(page.request, model.connectionId, (candidate) => candidate.modelId === model.modelId &&
          candidate.searchStrategyIds.includes(source.strategyId));
        const strategy = (await catalogState(page.request))?.searchStrategies.find((entry) => entry.strategyId === source.strategyId);
        sourceName = strategy?.displayName ?? source.displayName;
      }
      stand.summary.searchPath = path;

      const chatId = await openChat(page, stand, model, "Native search");
      await chooseSearchStrategy(page, escapeRegExp(sourceName));
      const turn = await nativeTurn(page, chatId, "Use web search exactly once, with a single query, to find the year the Eiffel " +
        "Tower opened to the public. Do not search again and do not use any other tool. Answer in one short sentence that " +
        "includes the year.");
      const usage = await runUsage(turn.run.id);
      const searches = await searchCalls(turn.run.id, usage);
      const text = await answerText(turn.run);
      const searchCount = Math.max(searches.hostedReported ?? 0, searches.searchRuns, searches.searchArtifacts);
      const webSearchRows = await prisma.usageEvent.findMany({ select: { estimatedCostMicros: true, modelId: true, operationCount: true,
        provider: true, webSearchCount: true }, where: { modelRunId: turn.run.id, purpose: "web_search" } });
      Object.assign(stand.summary, { answerHasYear: text.includes("1889"), calls: (await toolCalls(turn.run.id)).names, searches,
        oneSearchCall: searchCount === 1, status: turn.run.status, stream: streamTimings(turn.records, turn.sent.browserAt), usage,
        webSearchRows });

      expect(searchCount, "the answer searched the web").toBeGreaterThanOrEqual(1);
      if (path === "deepseek_search_api") {
        expect(webSearchRows, "exactly one billed web_search usage row").toHaveLength(1);
        // DeepSeek reports no cost: one result-bearing request at the published per-request price.
        expect(webSearchRows[0]).toMatchObject({ estimatedCostMicros: DEEPSEEK_SEARCH_API_COST_MICROS,
          modelId: DEEPSEEK_SEARCH_API_USAGE_MODEL, operationCount: 1, provider: "deepseek", webSearchCount: 1 });
      }
      expect(text.includes("1889"), "the answer states the year").toBe(true);
      await page.reload();
      const toggle = page.getByTestId("answer-sources-toggle").last();
      await expect(toggle, "the answer offers its sources").toBeVisible({ timeout: 60_000 });
      await toggle.click();
      const sources = page.getByTestId("answer-sources").last().getByRole("listitem");
      await expect.poll(async () => sources.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      stand.summary.sourcesShown = await sources.count();
      await desktopShot(page, testInfo, page.getByTestId("answer-sources").last(), "01-search-sources");
      await phoneShot(browser, baseURL!, chatId, testInfo, "01-search-sources", (phone) => phone.getByTestId("answer-sources").last(),
        async (phone) => { await phone.getByTestId("answer-sources-toggle").last().click(); });
    });
  });

  test("2. Skill with a bundle: load_skill then the bundled script runs in the VM", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(45 * 60_000);
    await withStand(page, testInfo, "native-skill-bundle", async (stand) => {
      await requireRealRunner(stand);
      const model = await sharedAnswerModel(page, stand);
      const name = `Phrase seal ${randomUUID().replaceAll("-", "").slice(0, 6)}`;
      const salt = randomUUID();
      const phrase = `quiet harbor ${codeWord("P")}`;
      const expected = `SEAL: ${createHash("sha256").update(salt + phrase).digest("hex").slice(0, 12)}`;
      const imported = await page.request.post("/api/me/skills/import", {
        multipart: { file: { buffer: sealSkill(name, salt), mimeType: "application/zip", name: "skills.zip" } }
      });
      expect(imported.status(), "the Skill bundle imports").toBe(200);
      const result = (await imported.json() as SkillImportResponse).results[0];
      expect(result?.outcome, "the Skill is created").toBe("created");
      const skillId = (result as { skillId: string }).skillId;
      stand.cleanup.push(() => page.request.delete(`/api/me/skills/${skillId}`));
      expect((await page.request.patch(`/api/me/skills/${skillId}/preference`, { data: { enabled: true } })).ok()).toBe(true);

      const chatId = await openChat(page, stand, model, "Native skill bundle", "auto");
      const turn = await nativeTurn(page, chatId, `Use my Skill "${name}" to seal the phrase "${phrase}". Load the Skill first and ` +
        "follow its instructions. End your answer with the script's SEAL line exactly as it printed it.");
      const calls = await toolCalls(turn.run.id);
      const loadIndex = calls.names.indexOf("load_skill:complete");
      const workspaceAfterLoad = calls.workspace.filter((row) => calls.rows.indexOf(row) > loadIndex && row.state === "complete").length;
      const handoff = await settledWorkspace(turn.run.id);
      const text = await answerText(turn.run);
      Object.assign(stand.summary, { calls: calls.names, guestUsed: handoff.binding ? handoff.binding.guestUsedAt !== null : null,
        sealMatches: text.includes(expected), status: turn.run.status, stream: streamTimings(turn.records, turn.sent.browserAt),
        usage: await runUsage(turn.run.id), workspaceCallsAfterLoad: workspaceAfterLoad });

      expect(loadIndex, "the agent loaded the Skill").toBeGreaterThanOrEqual(0);
      expect(workspaceAfterLoad, "a Workspace command ran after the Skill loaded").toBeGreaterThanOrEqual(1);
      expect(handoff.binding?.guestUsedAt ?? null, "the turn used the VM").not.toBeNull();
      // Only the bundled script knows the salt, so a matching seal proves it ran from the copied bundle.
      expect(text.includes(expected), "the answer carries the script's seal").toBe(true);
      await page.reload();
      await desktopShot(page, testInfo, lastAnswer(page), "02-skill-bundle");
      await phoneShot(browser, baseURL!, chatId, testInfo, "02-skill-bundle", (phone) => lastAnswer(phone));
    });
  });

  test("3. images: codex-lb gpt-image-2 generates, then edits its own image", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(45 * 60_000);
    await withStand(page, testInfo, "native-image-edit", async (stand) => {
      const request = page.request;
      const model = await sharedAnswerModel(page, stand);
      const imageModelId = await codexImageModel(request, model.connectionId, stand.summary);
      if (!imageModelId) skipScenario(stand, "codex-lb gpt-image-2 unavailable: not on the connection or without verified generation and editing");
      const previousRole = await publishDefaultImageModel(request, imageModelId);
      stand.cleanup.push(async () => {
        // A default of null admits no published models; such a legacy state is left as published here.
        if (previousRole.imageProviderModelId !== null || previousRole.imageModels.length === 0) await saveImageRole(request, previousRole);
        else stand.summary.imageRoleRestore = "skipped_legacy_publication";
      });
      const choice = await request.get("/api/me/image-models");
      expect(choice.ok()).toBe(true);
      const previousChoice = (await choice.json() as { imageModel: { selectedId: string | null } }).imageModel.selectedId;
      if (previousChoice !== null) {
        expect((await request.patch("/api/me/image-models", { data: { providerModelId: null } })).ok(),
          "the personal image choice is cleared").toBe(true);
        stand.cleanup.push(() => request.patch("/api/me/image-models", { data: { providerModelId: previousChoice } }));
      }

      const chatId = await openChat(page, stand, model, "Native images");
      const imageTurn = async (text: string, images: number, key: string) => {
        const turn = await nativeTurn(page, chatId, text);
        const calls = await toolCalls(turn.run.id);
        const binding = await prisma.providerRunBinding.findFirst({ select: { providerModelId: true },
          where: { bindingKey: "image", modelRunId: turn.run.id } });
        const imageUsage = await prisma.usageEvent.count({ where: { imageGeneration: true, modelRunId: turn.run.id } });
        stand.summary[key] = { calls: calls.names, imageBinding: binding?.providerModelId === imageModelId, imageUsageRows: imageUsage,
          status: turn.run.status, stream: streamTimings(turn.records, turn.sent.browserAt), usage: await runUsage(turn.run.id) };
        expect(calls.names.filter((entry) => entry.startsWith("generate_image:")), "the agent called the image tool once")
          .toEqual(["generate_image:complete"]);
        expect(binding?.providerModelId, "the run was admitted with the codex-lb image model").toBe(imageModelId);
        await expect(chatImages(page)).toHaveCount(images, { timeout: 120_000 });
        return turn;
      };

      const first = await imageTurn("Use the image generation tool exactly once, with empty image_ids and no parameters, to create a " +
        "new image: a small red paper boat on a calm blue pond. Do not call any other tool. Then reply with one short sentence.",
      1, "generateTurn");
      const generated = await storedImage(request, chatId, first.run.id, imageModelId);
      stand.summary.generated = generated.facts;
      expect(generated.sourceAttachmentIds, "a new image has no source").toEqual([]);

      const second = await imageTurn("Use the image generation tool exactly once to edit the previous image: put that image's " +
        "image_id in image_ids and pass no parameters. Make the boat yellow. Do not call any other tool. Then reply with one short " +
        "sentence.", 2, "editTurn");
      const edited = await storedImage(request, chatId, second.run.id, imageModelId);
      stand.summary.edited = { ...edited.facts, sourceIsGenerated: edited.sourceAttachmentIds.includes(generated.id) };
      expect(edited.id, "the edit is a second stored image").not.toBe(generated.id);
      expect(edited.sourceAttachmentIds, "the edit used the generated image as its source").toEqual([generated.id]);

      await page.reload();
      await expect(chatImages(page)).toHaveCount(2, { timeout: 60_000 });
      await desktopShot(page, testInfo, chatImages(page).last(), "03-image-edit");
      await phoneShot(browser, baseURL!, chatId, testInfo, "03-image-edit", (phone) => chatImages(phone).last());
    });
  });

  test("4. plain question: the first answer text arrives within 10 s", async ({ page }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withStand(page, testInfo, "native-plain-question", async (stand) => {
      const model = await sharedAnswerModel(page, stand);
      const chatId = await openChat(page, stand, model, "Native plain question");
      const turn = await nativeTurn(page, chatId, "What is the capital city of Australia? Answer in one short sentence. Do not use " +
        "any tool.");
      const stream = streamTimings(turn.records, turn.sent.browserAt);
      const text = await answerText(turn.run);
      Object.assign(stand.summary, { answerNamesCity: /canberra/iu.test(text), calls: (await toolCalls(turn.run.id)).names,
        server: { toAnswerCompletedMs: turn.run.answerCompletedAt ? turn.run.answerCompletedAt.getTime() - turn.run.createdAt.getTime() : null,
          toAnswerStartedMs: turn.run.answerStartedAt ? turn.run.answerStartedAt.getTime() - turn.run.createdAt.getTime() : null },
        status: turn.run.status, stream, usage: await runUsage(turn.run.id) });

      expect(stream.observed, "the browser saw the run's stream").toBe(true);
      expect(stream.toFirstTokenMs, "the answer text streamed").not.toBeNull();
      expect(stream.toFirstTokenMs!, "the first answer text arrived within 10 s of the send").toBeLessThan(FIRST_TOKEN_BOUND_MS);
      expect(/canberra/iu.test(text), "the answer names the capital").toBe(true);
    });
  });

  test("5a. coding: fizzbuzz with pytest tests, native engine and Codex Agent", async ({ page }, testInfo) => {
    test.setTimeout(90 * 60_000);
    await codingComparison(page, testInfo, FIZZBUZZ_TASK);
  });

  test("5b. coding: fix a planted bug so the provided test passes, native engine and Codex Agent", async ({ page }, testInfo) => {
    test.setTimeout(90 * 60_000);
    await codingComparison(page, testInfo, BUGFIX_TASK);
  });
});
