/**
 * Opt-in, paid, bounded browser checks of the native agent engine
 * (`lib/server/engine/`) with a real Codex LB answer model on a DISPOSABLE
 * stand. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). AIQSA_FEATURES_FIXTURE_HOST /
 * AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place the synthetic MCP peer for a stand
 * that reaches it by another name. Each test first runs the disposable-target
 * guard (`scripts/stateful-test-target.ts`).
 *
 * Every test asserts `ModelRun.engine = 'native'`.
 *
 * Injected faults (`lib/server/engine/faults.ts`) are read from the app's
 * environment for every run, apply only with AIQSA_TEST_MODE=1 outside
 * production (the harness sets both), may be combined with commas, and each
 * `*_once` fault fires once per run, so every run on a faulted server is
 * faulted. The blocks below are therefore gated by the same
 * AIQSA_NATIVE_ENGINE_TEST_FAULTS value in the Playwright process, and the
 * file runs three times, each start resetting the disposable database
 * (the webServer command runs `prisma migrate reset`):
 *
 *   export AIQSA_FEATURES_PAID_E2E=DISPOSABLE   # plus the CODEX_LB_* pair
 *   # 1. Core scenarios: streaming, MCP write with approval, Stop then Continue.
 *   npx playwright test --project=chromium tests/e2e/native-engine-paid.spec.ts
 *   # 2. Transport faults: a synthetic 502 before the first request, then a stream drop after the first text.
 *   AIQSA_NATIVE_ENGINE_TEST_FAULTS=model_502_once,stream_drop_once npx playwright test --project=chromium tests/e2e/native-engine-paid.spec.ts
 *   # 3. Usage write failure.
 *   AIQSA_NATIVE_ENGINE_TEST_FAULTS=usage_write_fail npx playwright test --project=chromium tests/e2e/native-engine-paid.spec.ts
 *
 * Inside the disposable Compose stand, pass the same variables with `-e` to
 * `docker compose -f docker-compose.dev.yml run --rm -T app npx playwright test ...`.
 *
 * Expected paid calls (Codex LB only), per server start: custom setup
 * (discovery plus its model checks). Run 1: the streaming turn (one model
 * request), the MCP turn (one or two requests up to the tool call) and its
 * continuation (one), the stopped long answer (one, cut short) and the
 * Continue turn (one). Run 2: one turn of two physical requests (the 502 is
 * synthetic and sends nothing; the dropped stream is a real request). Run 3:
 * one turn of one request.
 *
 * Oracles are the browser's own run stream (event kinds, counts, times and
 * text lengths recorded by a content-free probe), the persisted runs,
 * transcript items, usage rows and approvals, the synthetic peer's received
 * calls, and planted tokens, never the model's wording otherwise. Prompts,
 * answers, payloads and identifiers are never printed; the attached summary
 * holds statuses, counts, durations and event kinds only. Chats, the MCP
 * server and its consent are removed afterwards and the account's chat
 * defaults restored; the codex-lb connection stays on the stand like the
 * other paid specs' connections.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import sharp from "sharp";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { createWriteApprovalFixture, startMutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { disableMemoryRecall, lastAnswer } from "./support/workspace";

const prisma = new PrismaClient();
const FAULTS_ENV = "AIQSA_NATIVE_ENGINE_TEST_FAULTS";
const faults = new Set((process.env[FAULTS_ENV] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const transportFaults = faults.has("model_502_once") || faults.has("stream_drop_once");

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 600_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };
/** The smallest jittered backoff after a first failed attempt (`MODEL_CALL_RETRY`: base 2 s, jitter 0.5–1). */
const MIN_FIRST_RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// A content-free probe of the browser's run streams

/** One SSE event as the probe records it: kinds, counts and times, never text. */
type SseRecord = Readonly<{
  artifactType?: string;
  at: number;
  code?: string;
  deltaChars?: number;
  reasoningHeading?: boolean;
  /** Kept in the page only to match a stream to its run; never reported. */
  runId?: string;
  status?: string;
  stream: number;
  type: string;
}>;

/**
 * Runs in the page before the app: tees every `text/event-stream` response
 * the app reads and records each event's kind, time and text length.
 */
function installRunStreamProbe(): void {
  const target = window as unknown as { __aiqsaRunStreamProbe?: SseRecord[] };
  if (target.__aiqsaRunStreamProbe) return;
  const records: SseRecord[] = [];
  target.__aiqsaRunStreamProbe = records;
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
    const inner = payload.payload && typeof payload.payload === "object" ? payload.payload as Record<string, unknown> : null;
    records.push({
      at: Date.now(),
      stream,
      type,
      ...(type === "token" && typeof payload.delta === "string" ? { deltaChars: payload.delta.length } : {}),
      ...(type === "artifact" && typeof payload.artifactType === "string" ? { artifactType: payload.artifactType } : {}),
      ...(type === "artifact" && payload.artifactType === "summary" && inner?.stage === "reasoning" ? { reasoningHeading: true } : {}),
      ...(type === "run_start" && typeof payload.runId === "string" ? { runId: payload.runId } : {}),
      ...(type === "done" && typeof payload.status === "string" ? { status: payload.status } : {}),
      ...(type === "error" && typeof payload.code === "string" ? { code: payload.code } : {})
    });
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

async function probeRecords(page: Page): Promise<SseRecord[]> {
  return page.evaluate(() => (window as unknown as { __aiqsaRunStreamProbe?: SseRecord[] }).__aiqsaRunStreamProbe ?? []);
}

type StreamFacts = Readonly<{
  answerCompleteAfterMs: number | null;
  charsAfterLastReset: number;
  doneStatus: string | null;
  errorCode: string | null;
  eventKinds: Record<string, number>;
  firstTokenAfterMs: number | null;
  reasoningHeadings: number;
  reasoningHeadingsBeforeAnswerComplete: number;
  resets: number;
  tokenSpanMs: number | null;
  tokens: number;
  tokensBeforeAnswerComplete: number;
}>;

/** The run's own stream, as the browser received it; waits until it ended. */
async function runStreamFacts(page: Page, runId: string): Promise<StreamFacts> {
  const events = await pollUntil(120_000, async () => {
    const records = await probeRecords(page);
    const stream = records.find((entry) => entry.type === "run_start" && entry.runId === runId)?.stream;
    if (stream === undefined) return null;
    const own = records.filter((entry) => entry.stream === stream);
    return own.some((entry) => entry.type === "done" || entry.type === "error") ? own : null;
  }, "native_run_stream_not_observed");
  const startedAt = events.find((entry) => entry.type === "run_start")!.at;
  const tokens = events.filter((entry) => entry.type === "token");
  const answerComplete = events.find((entry) => entry.type === "answer_complete") ?? null;
  const before = (entry: SseRecord) => answerComplete === null || events.indexOf(entry) < events.indexOf(answerComplete);
  const lastReset = events.map((entry) => entry.type).lastIndexOf("message_reset");
  const headings = events.filter((entry) => entry.reasoningHeading === true);
  const done = events.find((entry) => entry.type === "done") ?? null;
  const eventKinds: Record<string, number> = {};
  for (const entry of events) {
    const kind = entry.type === "artifact" ? `artifact:${entry.artifactType ?? "unknown"}${entry.reasoningHeading ? ":reasoning" : ""}` : entry.type;
    eventKinds[kind] = (eventKinds[kind] ?? 0) + 1;
  }
  return {
    answerCompleteAfterMs: answerComplete ? answerComplete.at - startedAt : null,
    charsAfterLastReset: events.slice(lastReset + 1).reduce((total, entry) => total + (entry.deltaChars ?? 0), 0),
    doneStatus: done?.status ?? null,
    errorCode: events.find((entry) => entry.type === "error")?.code ?? null,
    eventKinds,
    firstTokenAfterMs: tokens[0] ? tokens[0].at - startedAt : null,
    reasoningHeadings: headings.length,
    reasoningHeadingsBeforeAnswerComplete: headings.filter(before).length,
    resets: events.filter((entry) => entry.type === "message_reset").length,
    tokenSpanMs: tokens.length > 1 ? tokens.at(-1)!.at - tokens[0]!.at : null,
    tokens: tokens.length,
    tokensBeforeAnswerComplete: tokens.filter(before).length
  };
}

// ---------------------------------------------------------------------------
// Stand, chats and runs

type Stand = Readonly<{
  chatIds: Set<string>;
  model: PaidAnswerModel;
  summary: Record<string, unknown>;
  userId: string;
}>;

/** One codex-lb connection per server start. */
let answerModel: PaidAnswerModel | null = null;

/**
 * Signs in, installs the stream probe and runs `body` on the codex-lb model;
 * the chats it created are deleted and the account's chat defaults restored
 * afterwards, and the content-free summary is attached.
 */
async function withNativeStand(page: Page, testInfo: TestInfo, label: string, body: (stand: Stand) => Promise<void>): Promise<void> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(installRunStreamProbe);
  const chatIds = new Set<string>();
  const summary: Record<string, unknown> = { faults: [...faults].sort() };
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    answerModel ??= await setupCodexLbAnswerModel(page.request, {
      label: "Native engine", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
    });
    summary.answerModel = answerModel.upstreamModelId;
    await body({ chatIds, model: answerModel, summary, userId });
  } finally {
    await testInfo.attach(`${label}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`native_engine_paid_summary ${label} ${JSON.stringify(summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await restoreDefaults?.().catch(() => { summary.composerDefaultsRestore = "failed"; });
  }
}

/** A new chat outside Memory on the codex-lb model, with MCP, Skills and Search off. */
async function openChat(page: Page, stand: Stand, title: string): Promise<string> {
  const chatId = await newExcludedChat(page.request, `${title} ${randomUUID().slice(0, 8)}`);
  stand.chatIds.add(chatId);
  await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => selectModel(page, stand.model.connectionId, stand.model.displayName)).toPass({ timeout: 60_000 });
  await expect(page.getByTestId("header-model-trigger")).toContainText(stand.model.displayName);
  await turnComposerToolsOff(page);
  return chatId;
}

async function runIds(chatId: string): Promise<string[]> {
  return (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
}

async function sendComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { exact: true, name: "Message" });
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
}

/** The chat's first run not in `earlier`, once it is created. */
async function newRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  return pollUntil(120_000, async () => prisma.modelRun.findFirst({
    orderBy: { createdAt: "desc" }, where: { chatId, id: { notIn: [...earlier] } }
  }), "native_run_not_admitted");
}

/** Waits until the run settles; it must end `status` on the native engine. */
async function settledRun(runId: string, status: ModelRun["status"] = "complete"): Promise<ModelRun> {
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
    return ACTIVE_RUN_STATUSES.includes(current.status) ? null : current;
  }, "native_run_timeout");
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  expect(run.engine, "the run ran on the agent engine").toBe("native");
  expect(run.status, `the run ends ${status} (${typeof code === "string" ? code : run.status})`).toBe(status);
  return run;
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

async function transcriptKinds(runId: string): Promise<Record<string, number>> {
  const rows = await prisma.runTranscriptItem.findMany({ select: { kind: true }, where: { modelRunId: runId } });
  const kinds: Record<string, number> = {};
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;
  return kinds;
}

async function answerUsageRows(runId: string) {
  const rows = await prisma.usageEvent.findMany({ select: { costReported: true, totalTokens: true, usageCompleteness: true },
    where: { modelRunId: runId, purpose: "chat_answer" } });
  return { completeness: rows.map((row) => row.usageCompleteness), count: rows.length,
    withTokens: rows.filter((row) => row.totalTokens !== null).length };
}

/** Visible user turns of the chat: server-written turns (approval continuations) are not the user's. */
async function userTurns(chatId: string): Promise<number> {
  return prisma.message.count({ where: { chatId, role: "user", systemTurnKind: null } });
}

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop answer" });
}

async function waitAnswerSettled(page: Page): Promise<void> {
  await expect(stopButton(page)).toHaveCount(0, { timeout: 120_000 });
}

/** Samples the live answer while it runs: distinct rendered lengths and the live status line; one mid-stream shot. */
async function sampleLiveAnswer(page: Page, testInfo: TestInfo, shot: string | null) {
  await expect(stopButton(page)).toBeVisible({ timeout: 60_000 });
  const lengths = new Set<number>();
  let statusLineSeen = false;
  let captured = false;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline && await stopButton(page).isVisible().catch(() => false)) {
    const length = (await lastAnswer(page).textContent().catch(() => null))?.length ?? 0;
    if (length > 0) lengths.add(length);
    if (await page.getByTestId("run-status-line").first().isVisible().catch(() => false)) statusLineSeen = true;
    if (shot && !captured && lengths.size >= 3) {
      captured = true;
      await viewportShot(page, testInfo, `${shot}-desktop-1440x900`);
    }
    await page.waitForTimeout(250);
  }
  return { distinctLiveLengths: lengths.size, liveShot: captured, statusLineSeen };
}

async function viewportShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}.png`, { contentType: "image/png", path });
}

/** A desktop viewport shot of `focus` in the open page. */
async function desktopShot(page: Page, testInfo: TestInfo, focus: Locator, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await focus.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await viewportShot(page, testInfo, `${name}-desktop-1440x900`);
}

/** A phone viewport shot in a touch context of its own (isMobile and hasTouch cannot change on an open page). */
async function phoneShot(browser: Browser, baseURL: string, chatId: string, testInfo: TestInfo, name: string,
  focus: (page: Page) => Locator): Promise<void> {
  const context = await browser.newContext({ baseURL, deviceScaleFactor: 3, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    viewport: PHONE });
  try {
    await authenticateWithLocalToken(context.request);
    const phone = await context.newPage();
    await phone.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
    await expect(phone.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    const target = focus(phone);
    await expect(target).toBeVisible({ timeout: 60_000 });
    await target.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(phone);
    await viewportShot(phone, testInfo, `${name}-phone-390x844`);
  } finally {
    await context.close();
  }
}

const codeWord = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

// ---------------------------------------------------------------------------
// Run 1: core scenarios on a server without injected faults

test.describe("native engine on Codex LB", () => {
  test.skip(faults.size > 0, `core scenarios run on a server without ${FAULTS_ENV}`);

  test("a 50 MP photo the model would refuse is answered through a smaller copy", async ({ page }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withNativeStand(page, testInfo, "native-large-photo", async (stand) => {
      const chatId = await openChat(page, stand, "Native large photo");
      // Coarse synthetic noise: photo-like byte counts at the frame size a 50 MP phone camera writes.
      const raw = randomBytes(255 * 192 * 3);
      const photo = await sharp(raw, { raw: { channels: 3, height: 192, width: 255 } })
        .resize(8160, 6120, { kernel: "nearest" }).jpeg({ quality: 75 }).toBuffer();
      await page.getByLabel("Attach files").setInputFiles({ buffer: photo, mimeType: "image/jpeg", name: "photo.jpg" });
      const item = page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: "photo.jpg" });
      await expect(item).toHaveAttribute("data-attachment-status", "ready", { timeout: 180_000 });
      const earlier = await runIds(chatId);
      await sendComposer(page, "In one short sentence, is this image a photo of a person? Do not use any tool.");
      const run = await settledRun((await newRun(chatId, earlier)).id);
      stand.summary.largePhoto = { photoBytes: photo.length, status: run.status,
        code: (run.errorPayload as { code?: unknown } | null)?.code ?? null };
      expect(run.status, "the model answered instead of rejecting the image").toBe("complete");
      expect((await answerText(run)).trim().length).toBeGreaterThan(0);
    });
  });

  test("streams reasoning headings and answer text before the run completes, on the native engine", async ({ page, browser, baseURL },
    testInfo) => {
    test.setTimeout(30 * 60_000);
    await withNativeStand(page, testInfo, "native-streaming", async (stand) => {
      const chatId = await openChat(page, stand, "Native streaming");
      const earlier = await runIds(chatId);
      const startedAt = Date.now();
      await sendComposer(page, "Work this out carefully before answering: how many times does the digit 7 appear when all whole " +
        "numbers from 1 to 300 are written out? Explain your counting in a paragraph of about 150 words, then give the number " +
        "on its own final line. Do not use any tool.");
      const live = await sampleLiveAnswer(page, testInfo, "01-streaming-live");
      const run = await settledRun((await newRun(chatId, earlier)).id);
      await waitAnswerSettled(page);
      const stream = await runStreamFacts(page, run.id);
      const text = await answerText(run);
      const transcript = await transcriptKinds(run.id);
      const usage = await answerUsageRows(run.id);
      stand.summary.streaming = { durationMs: Date.now() - startedAt, live, run: { engine: run.engine, status: run.status },
        persistedChars: text.length, stream, transcript, usage };

      expect(stream.doneStatus, "the stream ends complete").toBe("complete");
      expect(stream.errorCode).toBeNull();
      expect(stream.reasoningHeadings, "live reasoning headings streamed").toBeGreaterThanOrEqual(1);
      expect(stream.reasoningHeadingsBeforeAnswerComplete, "the headings arrived before the answer completed")
        .toBe(stream.reasoningHeadings);
      expect(stream.tokens, "the answer text streamed in several pieces").toBeGreaterThanOrEqual(5);
      expect(stream.tokensBeforeAnswerComplete, "all text arrived before the answer completed").toBe(stream.tokens);
      expect(stream.tokenSpanMs ?? 0, "the text arrived over time, not in one burst").toBeGreaterThan(0);
      expect(live.distinctLiveLengths, "the live answer grew while it ran").toBeGreaterThanOrEqual(2);
      expect(text.trim().length, "the answer is persisted").toBeGreaterThan(0);
      expect(stream.charsAfterLastReset, "the streamed text is the persisted answer").toBe(text.length);
      expect(transcript.assistant_text ?? 0, "the run kept its answer as a transcript item").toBeGreaterThanOrEqual(1);
      expect(Object.values(transcript).reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(1);
      expect(usage.count, "the answer request has a provider-reported usage row").toBeGreaterThanOrEqual(1);

      await desktopShot(page, testInfo, lastAnswer(page), "02-streamed-answer");
      await phoneShot(browser, baseURL!, chatId, testInfo, "02-streamed-answer", (phone) => lastAnswer(phone));
    });
  });

  test("a data-changing MCP call waits for approval; Allow continues the same answer with the tool's result", async ({ page, browser,
    baseURL }, testInfo) => {
    test.setTimeout(45 * 60_000);
    await withNativeStand(page, testInfo, "native-mcp-approval", async (stand) => {
      const fixture = createWriteApprovalFixture();
      // The receipt exists only in the tool's result, so an answer that quotes it read that result.
      const receipt = codeWord("RCPT-");
      const recordId = codeWord("R-");
      const callTool = (name: string, args: Readonly<Record<string, unknown>>): CallToolResult =>
        name === "delete_record" && typeof args.id === "string"
          ? { content: [{ text: JSON.stringify({ deleted: args.id, receipt }), type: "text" }] }
          : fixture.callTool(name, args);
      const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
      const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
      const endpoint = await startMutableMcpEndpoint(fixture.tools, { callTool,
        ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
      const serverName = `Native approval records ${randomUUID().slice(0, 8)}`;
      let serverId: string | null = null;
      try {
        const created = await page.request.post("/api/admin/mcp", { data: {
          activate: false,
          description: "Synthetic records server for the native engine's write approval",
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
        // No earlier consent may skip the card this scenario expects.
        await page.request.delete(`/api/me/mcp-consents/${server.id}`).catch(() => undefined);

        const chatId = await openChat(page, stand, "Native MCP approval");
        const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
        await mcpMode.click();
        await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Load all/u }).click();
        await expect(mcpMode).toHaveAccessibleDescription(/^MCP: Load all/u);

        const earlier = await runIds(chatId);
        await sendComposer(page, "This is a test with a synthetic records server. Call the delete_record tool exactly once with " +
          `{"id": "${recordId}"}. Do not call any other tool. After it returns, reply in one short sentence that quotes the receipt ` +
          "code from the tool's result.");
        const first = await settledRun((await newRun(chatId, earlier)).id);
        await waitAnswerSettled(page);
        const card = page.getByRole("listitem", { name: `Approval for ${serverName} delete_record` }).first();
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(card).toHaveAttribute("data-state", "pending");
        expect(endpoint.dispatches("delete_record"), "nothing was deleted before the Allow").toBe(0);
        const pending = await prisma.mcpToolApproval.findMany({ select: { decision: true }, where: { chatId } });
        expect(pending.length, "the run recorded its approval request").toBeGreaterThanOrEqual(1);
        expect(pending.every((approval) => approval.decision === null)).toBe(true);
        const firstStream = await runStreamFacts(page, first.id);
        expect(firstStream.eventKinds["artifact:mcp_approval"] ?? 0, "the card arrived on the live stream").toBeGreaterThanOrEqual(1);
        await desktopShot(page, testInfo, card, "03-approval-card");
        await phoneShot(browser, baseURL!, chatId, testInfo, "03-approval-card",
          (phone) => phone.getByRole("listitem", { name: `Approval for ${serverName} delete_record` }).first());

        const turnsBefore = await userTurns(chatId);
        const beforeAllow = await runIds(chatId);
        await card.getByRole("button", { name: "Allow once" }).click();
        const continuation = await settledRun((await newRun(chatId, beforeAllow)).id);
        await waitAnswerSettled(page);
        await expect(card).toHaveAttribute("data-state", "allowed_once", { timeout: 60_000 });
        const continuationStream = await runStreamFacts(page, continuation.id);
        const continuationText = await answerText(continuation);
        const transcript = await transcriptKinds(continuation.id);
        stand.summary.mcpApproval = {
          continuation: { engine: continuation.engine, status: continuation.status, stream: continuationStream, transcript },
          dispatches: endpoint.dispatched().map((entry) => entry.name),
          first: { engine: first.engine, status: first.status, stream: firstStream, transcript: await transcriptKinds(first.id) },
          receiptQuoted: continuationText.includes(receipt),
          userTurnsAdded: await userTurns(chatId) - turnsBefore
        };

        expect(endpoint.dispatches("delete_record", { id: recordId }), "the approved call was sent once").toBe(1);
        expect(endpoint.dispatches("delete_record"), "the peer saw exactly one write call").toBe(1);
        expect(await userTurns(chatId), "the continuation added no user turn").toBe(turnsBefore);
        expect(await prisma.message.count({ where: { chatId, role: "user", systemTurnKind: "mcp_approval_continuation" } }),
          "the server wrote one continuation turn").toBe(1);
        expect(transcript.tool_result ?? 0, "the continuation carries the call's result").toBeGreaterThanOrEqual(1);
        expect(continuationStream.doneStatus).toBe("complete");
        expect(continuationText.includes(receipt), "the continued answer used the tool's result").toBe(true);
        await expect(lastAnswer(page)).toContainText(receipt, { timeout: 60_000 });

        await desktopShot(page, testInfo, lastAnswer(page), "04-approval-continued");
        await phoneShot(browser, baseURL!, chatId, testInfo, "04-approval-continued", (phone) => lastAnswer(phone));
      } finally {
        if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
        if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
        await endpoint.close();
      }
    });
  });

  test("Stop keeps the partial answer and Continue carries the work on", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withNativeStand(page, testInfo, "native-stop-continue", async (stand) => {
      const chatId = await openChat(page, stand, "Native stop continue");
      // Item tags the model writes itself; the user's "Continue" names none.
      const tag = codeWord("K");
      const tagged = (text: string) => [...text.matchAll(new RegExp(`${tag}-(\\d+)`, "gu"))].map((match) => Number(match[1]));
      const earlier = await runIds(chatId);
      await sendComposer(page, `Write a numbered list of 80 facts about lighthouses, one fact per line. Start every line with the tag ` +
        `${tag}-<number> (${tag}-1, ${tag}-2 and so on) and write two full sentences per fact. Do not use any tool.`);
      await expect(stopButton(page)).toBeEnabled({ timeout: 60_000 });
      await expect.poll(async () => Math.max(0, ...tagged(await lastAnswer(page).textContent() ?? "")),
        { intervals: [150], timeout: TURN_TIMEOUT_MS }).toBeGreaterThanOrEqual(3);
      await stopButton(page).click();
      const stopped = await settledRun((await newRun(chatId, earlier)).id, "cancelled");
      await waitAnswerSettled(page);
      const stoppedStream = await runStreamFacts(page, stopped.id);
      const partial = await answerText(stopped);
      const reached = Math.max(0, ...tagged(partial));
      expect(stoppedStream.doneStatus, "the stream ends cancelled").toBe("cancelled");
      expect(reached, "the stopped answer keeps its partial text").toBeGreaterThanOrEqual(1);
      expect(reached, "Stop cut the list short").toBeLessThan(80);

      const beforeContinue = await runIds(chatId);
      await sendComposer(page, "Continue");
      const continued = await settledRun((await newRun(chatId, beforeContinue)).id);
      await waitAnswerSettled(page);
      const continuedStream = await runStreamFacts(page, continued.id);
      const continuedTags = tagged(await answerText(continued));
      stand.summary.stopContinue = {
        continued: { engine: continued.engine, highestTag: Math.max(0, ...continuedTags), lowestTag: continuedTags.length
          ? Math.min(...continuedTags) : null, status: continued.status, stream: continuedStream, tags: continuedTags.length,
          transcript: await transcriptKinds(continued.id) },
        stopped: { engine: stopped.engine, highestTag: reached, persistedChars: partial.length, status: stopped.status,
          stream: stoppedStream, transcript: await transcriptKinds(stopped.id) }
      };
      expect(continuedStream.doneStatus).toBe("complete");
      expect(continuedTags.some((value) => value > reached), "the continuation carries the stopped list on").toBe(true);
      await expect(lastAnswer(page)).toContainText(`${tag}-${Math.max(...continuedTags)}`, { timeout: 60_000 });

      await desktopShot(page, testInfo, lastAnswer(page), "05-continued-answer");
      await phoneShot(browser, baseURL!, chatId, testInfo, "05-continued-answer", (phone) => lastAnswer(phone));
    });
  });
});

// ---------------------------------------------------------------------------
// Run 2: AIQSA_NATIVE_ENGINE_TEST_FAULTS=model_502_once,stream_drop_once

test.describe("native engine transport faults", () => {
  test.skip(!transportFaults || faults.has("usage_write_fail"),
    `requires ${FAULTS_ENV} with model_502_once and/or stream_drop_once, without usage_write_fail`);

  test("a provider 502 and a dropped stream recover without user action and the partial text is replaced", async ({ page }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withNativeStand(page, testInfo, "native-transport-faults", async (stand) => {
      const chatId = await openChat(page, stand, "Native transport faults");
      const word = codeWord("VX");
      const earlier = await runIds(chatId);
      const startedAt = Date.now();
      await sendComposer(page, `Begin your reply with the code word ${word}, then write three short sentences about rivers. ` +
        "Mention the code word only once. Do not use any tool.");
      // The failed attempt is named while the request is sent again, and the real answer replaces it.
      await expect(page.getByText("The provider isn’t responding, trying again…")).toBeVisible({ timeout: 60_000 });
      const run = await settledRun((await newRun(chatId, earlier)).id);
      await waitAnswerSettled(page);
      const stream = await runStreamFacts(page, run.id);
      const text = await answerText(run);
      const usage = await answerUsageRows(run.id);
      stand.summary.transport = { durationMs: Date.now() - startedAt, persistedChars: text.length,
        persistedCodeWordCount: occurrences(text, word), run: { engine: run.engine, status: run.status,
          totalTokensRecorded: run.totalTokens !== null }, stream, transcript: await transcriptKinds(run.id), usage };

      expect(stream.doneStatus, "the answer completed without user action").toBe("complete");
      expect(stream.errorCode).toBeNull();
      expect(text.includes(word), "the persisted answer is the full answer").toBe(true);
      expect(stream.charsAfterLastReset, "after the last reset the stream carries exactly the persisted answer").toBe(text.length);
      if (faults.has("stream_drop_once")) {
        expect(stream.resets, "the dropped attempt's text was withdrawn").toBeGreaterThanOrEqual(1);
      }
      if (faults.has("model_502_once")) {
        // The 502 precedes any text, so the first text waits at least the first jittered backoff.
        expect(stream.firstTokenAfterMs ?? 0, "the first text followed a retry backoff").toBeGreaterThanOrEqual(MIN_FIRST_RETRY_DELAY_MS);
      }
      // One row per physical request that reported usage: the synthetic 502 sends nothing, and a stream dropped
      // after its first text reports no usage unless the provider sent it before the drop (unknown stays unknown).
      expect(usage.count, "the completed request's usage is recorded").toBeGreaterThanOrEqual(1);
      expect(usage.withTokens, "every recorded row carries provider-reported tokens").toBe(usage.count);
      expect(run.totalTokens, "the run's totals come from those rows").not.toBeNull();
      await expect(lastAnswer(page)).toContainText(word, { timeout: 60_000 });
      expect(occurrences(await lastAnswer(page).innerText(), word), "the shown answer holds no duplicated partial text")
        .toBe(occurrences(text, word));
      await desktopShot(page, testInfo, lastAnswer(page), "06-transport-faults");
    });
  });
});

// ---------------------------------------------------------------------------
// Run 3: AIQSA_NATIVE_ENGINE_TEST_FAULTS=usage_write_fail

test.describe("native engine usage write failure", () => {
  test.skip(!faults.has("usage_write_fail") || transportFaults, `requires ${FAULTS_ENV}=usage_write_fail alone`);

  test("a failing usage write still shows the full answer and completes the run", async ({ page }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withNativeStand(page, testInfo, "native-usage-write-fail", async (stand) => {
      const chatId = await openChat(page, stand, "Native usage failure");
      const word = codeWord("UW");
      const earlier = await runIds(chatId);
      await sendComposer(page, `Begin your reply with the code word ${word}, then write three short sentences about forests. ` +
        "Mention the code word only once. Do not use any tool.");
      const run = await settledRun((await newRun(chatId, earlier)).id);
      await waitAnswerSettled(page);
      const stream = await runStreamFacts(page, run.id);
      const text = await answerText(run);
      const usage = await answerUsageRows(run.id);
      stand.summary.usageWriteFail = { persistedChars: text.length, run: { engine: run.engine, status: run.status,
        totalTokensRecorded: run.totalTokens !== null }, stream, transcript: await transcriptKinds(run.id), usage };

      expect(stream.answerCompleteAfterMs, "the answer was published").not.toBeNull();
      expect(stream.doneStatus, "the run completed").toBe("complete");
      expect(stream.errorCode).toBeNull();
      expect(text.includes(word), "the full answer is persisted").toBe(true);
      expect(stream.charsAfterLastReset, "the stream carried the whole answer").toBe(text.length);
      expect(usage.count, "the injected failure left no usage row").toBe(0);
      expect(run.totalTokens, "and no run totals").toBeNull();
      await expect(lastAnswer(page)).toContainText(word, { timeout: 60_000 });
      await desktopShot(page, testInfo, lastAnswer(page), "07-usage-write-fail");
    });
  });
});
