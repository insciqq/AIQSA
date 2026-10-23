/**
 * Opt-in, paid, bounded browser check of the native engine's compaction
 * (`lib/server/engine/runContext.ts`) with a real Codex LB answer model on a
 * DISPOSABLE stand. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). The stand's app must put the test user on the
 * native engine (AIQSA_NATIVE_ENGINE_USERS='*' or the operator's id or email),
 * as in `native-engine-paid.spec.ts`; every run asserts `ModelRun.engine`.
 *
 * The model gets a small context window (AIQSA_FEATURES_COMPACTION_WINDOW,
 * default 60,000 tokens, 4,096 of them reserved for output) so a cheap chat
 * crosses the background threshold (72 % of the usable window): three turns
 * plant facts (a constraint, a correction, an error code inside a pasted
 * log), then turns paste about 3,000 tokens of synthetic CI log each until
 * the chat holds a compaction item. No turn waits after its answer: every
 * run ends right after its answer is published, while a compaction still
 * running goes on detached and the run that started it records its item when
 * it finishes. Turns sent meanwhile join that compaction rather than
 * compacting the same span again (only the starting run records compaction
 * calls), and no stream shows a running compaction (only a foreground one
 * shows). The quiet marker shows on the starting run's answer after a reload,
 * on desktop and phone. The next turn starts compacted (a smaller reported
 * input than the starting turn's) and recalls the planted facts, the
 * correction in force. Every route compacts with a summary by default
 * (`COMPACTION_LIFECYCLE.native`), so the item is a summary.
 *
 *   export AIQSA_FEATURES_PAID_E2E=DISPOSABLE AIQSA_NATIVE_ENGINE_USERS='*'   # plus the CODEX_LB_* pair
 *   npx playwright test --project=chromium tests/e2e/native-compaction-paid.spec.ts
 *
 * Inside the disposable Compose stand, pass the same variables with `-e` to
 * `docker compose -f docker-compose.dev.yml run --rm -T app npx playwright test ...`.
 *
 * Expected paid calls (Codex LB only): custom setup (discovery plus its model
 * checks); 3 planting turns and about 6–14 filler turns of one request each
 * (more when the stand's instructions and tools are small); one compaction of
 * one to three summary calls; one recall turn of one request.
 *
 * Oracles are the browser's own run streams (event kinds and compaction
 * states recorded by a content-free probe), the persisted runs, transcript
 * items and usage rows, and planted random tokens in the recall answer. The
 * attached summary holds statuses, counts, token figures and event kinds
 * only, never prompts, answers or planted values. The chat is removed
 * afterwards and the account's chat defaults restored.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, waitForCatalogModel } from "./support/paidProviders";
import { disableMemoryRecall } from "./support/workspace";

const prisma = new PrismaClient();

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 600_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };
const CONTEXT_WINDOW = Number(paidEnv("AIQSA_FEATURES_COMPACTION_WINDOW") ?? 60_000);
/** `codexLbSetupBody` declares 4,096 default output tokens: the reserve every request keeps. */
const OUTPUT_RESERVE = 4_096;
const USABLE = CONTEXT_WINDOW - OUTPUT_RESERVE;
/** Filler turns before the test gives up waiting for a compaction. */
const MAX_FILLER_TURNS = 24;
/** The background threshold's share of the usable window (`COMPACTION_THRESHOLDS.background`). */
const BACKGROUND_SHARE = 0.72;
/** A run ends this soon after its answer: bookkeeping only, never a compaction (whose calls take a minute or more). */
const ANSWER_TO_DONE_MS = 20_000;
/** How long a detached compaction may take to be recorded (its summary calls took up to two minutes on the evaluation). */
const COMPACTION_TIMEOUT_MS = 240_000;
/** How long a compaction's quiet marker and usage may take to be recorded once its item is. */
const MARKER_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// A content-free probe of the browser's run streams

type SseRecord = Readonly<{
  /** When the browser received it (`Date.now()`). */
  at: number;
  artifactType?: string;
  /** A compaction status's state (`running` only while an answer waits for it). */
  compactionState?: string;
  runId?: string;
  status?: string;
  stream: number;
  type: string;
}>;

/** Runs in the page before the app: tees every `text/event-stream` response and records event kinds only. */
function installRunStreamProbe(): void {
  const target = window as unknown as { __aiqsaCompactionProbe?: SseRecord[] };
  if (target.__aiqsaCompactionProbe) return;
  const records: SseRecord[] = [];
  target.__aiqsaCompactionProbe = records;
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
      ...(type === "artifact" && typeof payload.artifactType === "string" ? { artifactType: payload.artifactType } : {}),
      ...(type === "artifact" && payload.artifactType === "context_compaction" && typeof inner?.state === "string"
        ? { compactionState: inner.state } : {}),
      ...(type === "run_start" && typeof payload.runId === "string" ? { runId: payload.runId } : {}),
      ...(type === "done" && typeof payload.status === "string" ? { status: payload.status } : {})
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

type StreamFacts = Readonly<{
  /** The compaction marker's position relative to the answer's publication; null without a marker in the stream. */
  compactionAfterAnswer: boolean | null;
  compactionStates: readonly string[];
  doneStatus: string | null;
  eventKinds: Record<string, number>;
  /** How long the run's stream went on after its answer was published. */
  answerToDoneMs: number | null;
}>;

/** The run's own stream as the browser received it, once it ended. */
async function runStreamFacts(page: Page, runId: string): Promise<StreamFacts> {
  const events = await pollUntil(120_000, async () => {
    const records = await page.evaluate(() => (window as unknown as { __aiqsaCompactionProbe?: SseRecord[] }).__aiqsaCompactionProbe ?? []);
    const stream = records.find((entry) => entry.type === "run_start" && entry.runId === runId)?.stream;
    if (stream === undefined) return null;
    const own = records.filter((entry) => entry.stream === stream);
    return own.some((entry) => entry.type === "done" || entry.type === "error") ? own : null;
  }, "native_run_stream_not_observed");
  const eventKinds: Record<string, number> = {};
  for (const entry of events) {
    const kind = entry.type === "artifact" ? `artifact:${entry.artifactType ?? "unknown"}` : entry.type;
    eventKinds[kind] = (eventKinds[kind] ?? 0) + 1;
  }
  const answer = events.findIndex((entry) => entry.type === "answer_complete");
  const marker = events.findIndex((entry) => entry.artifactType === "context_compaction");
  const done = events.find((entry) => entry.type === "done");
  return {
    answerToDoneMs: answer < 0 || !done ? null : done.at - events[answer]!.at,
    compactionAfterAnswer: marker < 0 || answer < 0 ? null : marker > answer,
    compactionStates: events.flatMap((entry) => entry.compactionState ? [entry.compactionState] : []),
    doneStatus: done?.status ?? null,
    eventKinds
  };
}

// ---------------------------------------------------------------------------
// Chat, runs and records

async function runIds(chatId: string): Promise<string[]> {
  return (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
}

async function newRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  return pollUntil(120_000, async () => prisma.modelRun.findFirst({
    orderBy: { createdAt: "desc" }, where: { chatId, id: { notIn: [...earlier] } }
  }), "native_run_not_admitted");
}

/** Waits until the run settles; it must complete on the native engine. */
async function settledRun(runId: string): Promise<ModelRun> {
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

/**
 * The compaction items the chat keeps on record, each in the transcript of the run that started it: which path made
 * it, and whether it keeps a tail.
 */
async function chatCompactions(chatId: string) {
  const rows = await prisma.runTranscriptItem.findMany({ orderBy: { createdAt: "asc" }, select: { body: true, modelRunId: true },
    where: { chatId, kind: "compaction" } });
  return rows.map((row) => {
    const body = (row.body ?? {}) as Record<string, unknown>;
    return { keepsTail: typeof body.keepFromId === "string", path: body.native ? "native" : "summary", retained: typeof body.retained === "string",
      runId: row.modelRunId };
  });
}

/** The chat's compaction items once one is recorded, or none after `timeoutMs`. */
async function recordedCompactions(chatId: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof chatCompactions>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await chatCompactions(chatId);
    if (found.length > 0 || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** The largest provider-reported input of a run's requests (its answer request carries the whole context). */
async function largestInput(runId: string): Promise<number | null> {
  const rows = await prisma.usageEvent.findMany({ select: { inputTokens: true }, where: { modelRunId: runId, purpose: "chat_answer" } });
  const counts = rows.flatMap((row) => typeof row.inputTokens === "number" ? [row.inputTokens] : []);
  return counts.length > 0 ? Math.max(...counts) : null;
}

/**
 * Model calls each run recorded beyond its one answer request (tools are off, so every turn is one request): the
 * compaction calls, recorded by the run that started the compaction, when they finished.
 */
async function extraModelCalls(runIds: readonly string[]): Promise<Record<string, number>> {
  // A failed attempt without reported usage is no call to count.
  const rows = await prisma.usageEvent.groupBy({ _count: { _all: true }, by: ["modelRunId"],
    where: { inputTokens: { not: null }, modelRunId: { in: [...runIds] }, purpose: "chat_answer" } });
  return Object.fromEntries(rows.flatMap((row) => row.modelRunId && row._count._all > 1 ? [[row.modelRunId, row._count._all - 1]] : []));
}

/** The compaction statuses a run has on record, in order (a detached compaction's is recorded after its run). */
async function recordedCompactionStates(runId: string): Promise<string[]> {
  const rows = await prisma.modelRunEvent.findMany({ orderBy: { sequence: "asc" }, select: { payload: true },
    where: { eventType: "artifact", modelRunId: runId, payload: { equals: "context_compaction", path: ["artifactType"] } } });
  return rows.flatMap((row) => {
    const inner = (row.payload as { payload?: { state?: unknown } } | null)?.payload;
    return typeof inner?.state === "string" ? [inner.state] : [];
  });
}

async function sendComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { exact: true, name: "Message" });
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
}

/** Sends one turn and waits for its run to complete and the page to settle. */
async function turn(page: Page, chatId: string, text: string): Promise<ModelRun> {
  const earlier = await runIds(chatId);
  await sendComposer(page, text);
  const run = await settledRun((await newRun(chatId, earlier)).id);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return run;
}

async function viewportShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}.png`, { contentType: "image/png", path });
}

/** The answer's process disclosure and its expanded Context section. */
function compactionMarker(answer: Locator) {
  return { disclosure: answer.getByTestId("tool-activity-disclosure"), section: answer.getByTestId("context-compaction-status") };
}

/** One answer of the thread, by its message id. */
function answerById(page: Page, assistantMessageId: string): Locator {
  return page.locator(`article[data-role="assistant"][data-message-id="${assistantMessageId}"]`);
}

/** A phone viewport shot of one answer with its marker open, in a touch context of its own. */
async function phoneShot(browser: Browser, baseURL: string, chatId: string, assistantMessageId: string, testInfo: TestInfo,
  name: string): Promise<void> {
  const context = await browser.newContext({ baseURL, deviceScaleFactor: 3, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    viewport: PHONE });
  try {
    await authenticateWithLocalToken(context.request);
    const phone = await context.newPage();
    await phone.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
    await expect(phone.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    const answer = answerById(phone, assistantMessageId);
    await answer.scrollIntoViewIfNeeded();
    const marker = compactionMarker(answer);
    await expect(marker.disclosure).toContainText("Context compacted", { timeout: 60_000 });
    if (!await marker.section.isVisible()) await marker.disclosure.locator("summary").tap();
    await expect(marker.section).toHaveAttribute("data-state", "complete");
    await marker.section.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(phone);
    await viewportShot(phone, testInfo, `${name}-phone-390x844`);
  } finally {
    await context.close();
  }
}

const codeWord = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;

/** About 3,000 tokens of synthetic CI log lines; nothing in them is asked about later. */
function fillerLog(batch: number): string {
  const lines: string[] = [];
  for (let line = 0; line < 120; line += 1) {
    const step = (batch * 131 + line * 17) % 997;
    lines.push(`2026-04-${String(1 + (line % 28)).padStart(2, "0")}T${String(line % 24).padStart(2, "0")}:${String(step % 60)
      .padStart(2, "0")}:07Z INFO job=ci-${batch}-${line} stage=${["lint", "test", "build", "package"][line % 4]} ` +
      `shard=${step % 16} duration_ms=${step * 37} cache=${line % 3 === 0 ? "miss" : "hit"} status=passed`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

test("a long chat compacts in the background without the user waiting, and later answers recall what came before", async ({
  page, browser, baseURL
}, testInfo) => {
  test.setTimeout(60 * 60_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(installRunStreamProbe);
  const summary: Record<string, unknown> = { contextWindow: CONTEXT_WINDOW };
  let chatId: string | null = null;
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    const model = await setupCodexLbAnswerModel(page.request, { contextWindow: CONTEXT_WINDOW, label: "Native compaction",
      nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL") });
    summary.answerModel = model.upstreamModelId;
    const catalog = await waitForCatalogModel(page.request, model.connectionId, (candidate) => candidate.modelId === model.modelId);
    expect(catalog.contextWindow, "the model keeps the small window this check needs").toBe(CONTEXT_WINDOW);

    chatId = await newExcludedChat(page.request, `Native compaction ${randomUUID().slice(0, 8)}`);
    await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
    await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
    await expect(async () => selectModel(page, model.connectionId, model.displayName)).toPass({ timeout: 60_000 });
    await turnComposerToolsOff(page);

    // Planted facts, a correction and an error code, all before the compaction's cut.
    const codename = codeWord("PRJ-");
    const budget = String(10_000 + Math.floor(Math.random() * 80_000));
    const oldRegion = `eu-west-${2 + Math.floor(Math.random() * 6)}`;
    const region = `ap-south-${2 + Math.floor(Math.random() * 6)}`;
    const errorCode = codeWord("ERR_BUILD_");
    const first = await turn(page, chatId, `This is a long working session. Facts to keep for later: the project codename is ${codename} ` +
      `and the budget cap is ${budget} EUR. The deploy region is ${oldRegion}. Reply only with: Noted.`);
    const baseInput = await largestInput(first.id);
    summary.baseInputTokens = baseInput;
    // The compacted context keeps the instructions and tools whole: they must leave the window room to compact into.
    expect(baseInput ?? 0, "the stand's instructions and tools leave room for the planned window").toBeLessThan(USABLE * 0.35);
    await turn(page, chatId, `Correction: the deploy region is not ${oldRegion} but ${region}. Reply only with: Noted.`);
    await turn(page, chatId, `Here is the failed build log:\n${fillerLog(0)}\n2026-04-29T10:00:00Z ERROR job=ci-0-final ` +
      `stage=build failed: ${errorCode} linker could not resolve symbol\nReply only with: Noted.`);

    // Long turns until the chat holds a compaction item. The compaction goes on detached from the run that starts it:
    // once a turn crossed the background threshold, one more turn comes while it runs and must join it rather than
    // compact the same span again, then the check waits for the item to be recorded.
    const fillers: Record<string, unknown>[] = [];
    const fillerRuns: string[] = [];
    let compactions: Awaited<ReturnType<typeof chatCompactions>> = [];
    let joinerSent = false;
    for (let batch = 1; batch <= MAX_FILLER_TURNS && compactions.length === 0; batch += 1) {
      const run = await turn(page, chatId, `CI log batch ${batch} for the record (nothing to analyse):\n${fillerLog(batch)}\n` +
        `Reply only with: Noted batch ${batch}.`);
      fillerRuns.push(run.id);
      const stream = await runStreamFacts(page, run.id);
      const inputTokens = await largestInput(run.id);
      compactions = await chatCompactions(chatId);
      fillers.push({ answerToDoneMs: stream.answerToDoneMs, batch, compactionStates: stream.compactionStates, compactions: compactions.length,
        inputTokens });
      // No turn of this chat waits for a compaction: a running status shows only for a foreground one, and the run ends
      // right after its answer.
      expect(stream.compactionStates, `batch ${batch} never waited for a compaction`).not.toContain("running");
      expect(stream.doneStatus).toBe("complete");
      expect(stream.answerToDoneMs ?? Number.POSITIVE_INFINITY, `batch ${batch} ended right after its answer`)
        .toBeLessThan(ANSWER_TO_DONE_MS);
      // A compaction finishing before its run ended can reach the stream, only after the answer.
      if (stream.compactionAfterAnswer !== null) expect(stream.compactionAfterAnswer).toBe(true);
      if (compactions.length > 0 || (inputTokens ?? 0) < USABLE * BACKGROUND_SHARE) continue;
      if (!joinerSent) {
        joinerSent = true;
        continue;
      }
      compactions = await recordedCompactions(chatId, COMPACTION_TIMEOUT_MS);
    }
    summary.fillers = fillers;
    expect(compactions, "one compaction item, a summary kept on record with its tail and retained text").toEqual([
      expect.objectContaining({ keepsTail: true, path: "summary", retained: true })]);
    const starting = await prisma.modelRun.findUniqueOrThrow({ where: { id: compactions[0]!.runId } });
    // Only the run that started the compaction made compaction calls: the turns that came meanwhile joined it.
    await pollUntil(MARKER_TIMEOUT_MS, async () => (await extraModelCalls([starting.id]))[starting.id] ? true : null,
      "compaction_usage_not_recorded");
    const extra = await extraModelCalls(fillerRuns);
    const item = await prisma.runTranscriptItem.findFirstOrThrow({ select: { createdAt: true }, where: { chatId, kind: "compaction" } });
    summary.starting = { batch: fillerRuns.indexOf(starting.id) + 1, extraModelCalls: extra, inputTokens: await largestInput(starting.id),
      // Positive when the item was recorded after the answer, as a detached compaction's is.
      itemAfterAnswerMs: starting.answerCompletedAt ? item.createdAt.getTime() - starting.answerCompletedAt.getTime() : null,
      stream: await runStreamFacts(page, starting.id) };
    expect(Object.keys(extra), "only the starting run called the model to compact").toEqual([starting.id]);
    const states = await pollUntil(MARKER_TIMEOUT_MS, async () => {
      const recorded = await recordedCompactionStates(starting.id);
      return recorded.includes("complete") ? recorded : null;
    }, "compaction_marker_not_recorded");
    expect(states, "the starting answer's marker settled without a running state").toEqual(["complete"]);

    // The quiet marker in the starting answer's process disclosure as a later visit reads it (a detached compaction's is
    // recorded after its run's stream ended), desktop and phone; the chat's own page stays as it is for the next turn.
    const viewer = await page.context().newPage();
    try {
      await viewer.setViewportSize(DESKTOP);
      await viewer.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
      await expect(viewer.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
      const startingAnswer = answerById(viewer, starting.assistantMessageId!);
      await startingAnswer.scrollIntoViewIfNeeded();
      const marker = compactionMarker(startingAnswer);
      await expect(marker.disclosure).toContainText("Context compacted", { timeout: 60_000 });
      await marker.disclosure.locator("summary").click();
      await expect(marker.section).toHaveAttribute("data-state", "complete");
      await marker.section.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(viewer);
      await viewportShot(viewer, testInfo, "01-context-compacted-desktop-1440x900");
    } finally {
      await viewer.close();
    }
    await phoneShot(browser, baseURL!, chatId, starting.assistantMessageId!, testInfo, "01-context-compacted");

    // The next turn starts compacted and recalls what came before the cut, the correction in force.
    const recall = await turn(page, chatId, "Answer from earlier in this chat, without guessing: the project codename, the budget cap " +
      "in EUR, the deploy region in force now, and the error code that failed the build. Reply with four short lines.");
    const text = await answerText(recall);
    const recalled = { budget: text.includes(budget), codename: text.includes(codename), errorCode: text.includes(errorCode),
      region: text.includes(region) };
    const startingInput = await largestInput(starting.id);
    const recallInput = await largestInput(recall.id);
    summary.recall = { compactions: (await chatCompactions(chatId)).length, inputTokens: recallInput, recalled,
      stream: await runStreamFacts(page, recall.id) };
    expect(recallInput ?? Number.POSITIVE_INFINITY, "the next turn started from the compacted context").toBeLessThan(startingInput ?? 0);
    expect(recalled, "the facts from before the compaction are recalled, the region as corrected")
      .toEqual({ budget: true, codename: true, errorCode: true, region: true });
  } finally {
    await testInfo.attach("native-compaction-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`native_compaction_paid_summary ${JSON.stringify(summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    if (chatId) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await restoreDefaults?.().catch(() => { summary.composerDefaultsRestore = "failed"; });
  }
});
