/**
 * Opt-in, paid, bounded browser check of the native agent engine
 * (`lib/server/engine/`) working in a REAL KVM Workspace with a real Codex LB
 * answer model on a DISPOSABLE stand: a chart built from an uploaded
 * workbook, a follow-up edit made with `apply_patch`, and a turn that needs
 * no code and so never starts the VM. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). The test first runs the disposable-target
 * guard (`scripts/stateful-test-target.ts`).
 *
 * The app must use a real remote runner (`getWorkspaceConfig` in
 * `lib/server/workspace/config.ts` resolves `runtimeMode: "remote"`), and the
 * test skips with the resolved mode otherwise. Playwright's webServer starts
 * `next dev` with the Playwright process environment merged under
 * `playwright.config.ts`'s own `env`, which defaults
 * AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME to 1 and passes the runner pair
 * through, so export for `playwright test`:
 *
 *   AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0
 *   AIQSA_WORKSPACE_RUNNER_URL=http://workspace-runner:4310     # http(s), no credentials, query or hash
 *   AIQSA_WORKSPACE_RUNNER_TOKEN=<32..1024 chars, no spaces>     # the runner's own token, set on both sides
 *   AIQSA_NATIVE_ENGINE_USERS='*'                               # or the operator's id or email
 *
 * Every other AIQSA_WORKSPACE_* setting is optional and validated by
 * `getWorkspaceConfig` (defaults: 2 CPUs, 4096 MiB, 10240 MiB disk, 1800 s
 * turn and idle TTL, 320 calls, 128 KiB tool output, image
 * `aiqsa-workspace:0.1.35`, MCP 0.6.16, which must stay equal to
 * WORKSPACE_MCP_VERSION). A stand that bounds the guest (as the paid
 * Workspace smoke does with 1 CPU / 1024 MiB) needs the same values on the app
 * and the runner. A reused server (PLAYWRIGHT_REUSE_SERVER=1) must already
 * run with these values; the test also refuses a sandbox identity the
 * deterministic runtime would have made.
 *
 * The runner container is the `workspace-runner` service of
 * `docker-compose.dev.yml` (profile `workspace-live`, Dockerfile target
 * `workspace-runner`): `/dev/kvm` passed through with the host's kvm group
 * (AIQSA_KVM_GID), read-only root, all capabilities dropped,
 * no-new-privileges, the `workspace_runtime_dev_data` volume on
 * `/var/lib/microsandbox`, networks `workspace-control` (internal, shared
 * with the app) and `workspace-egress`, and this environment:
 *
 *   AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0
 *   AIQSA_WORKSPACE_RUNNER_TOKEN=<the same token as the app>
 *   AIQSA_WORKSPACE_IMAGE / _MCP_VERSION / _CPUS / _MEMORY_MIB / _DISK_MIB /
 *   _IDLE_TTL_SECONDS / _RETENTION_SECONDS / _TURN_TIMEOUT_SECONDS /
 *   _SYNC_TOOL_TIMEOUT_SECONDS / _TOOL_OUTPUT_MAX_BYTES / _MAX_TOOL_CALLS /
 *   _MAX_TOOL_ROUNDS / _OUTPUT_FILE_MAX_BYTES / _OUTPUT_MAX_FILES /
 *   _OUTPUT_TOTAL_MAX_BYTES                     # equal to the app's values
 *   AIQSA_AGENT_APP_ORIGIN=http://app:3000      # the runner gateway's app origin
 *   AIQSA_MCP_REQUEST_MAX_BYTES=8388608
 *
 * Its health check is `GET /health` on port 4310 with `Authorization: Bearer
 * <token>`, which this test also calls before the first turn. The
 * `workspace-maintenance` service (same profile) is optional for this test.
 * The installation's Workspace policy must be enabled (the seed enables it);
 * the guest needs no internet (pandas, openpyxl and matplotlib are in the
 * image).
 *
 *   docker compose -f docker-compose.dev.yml --profile workspace-live up -d --build
 *   docker compose -f docker-compose.dev.yml run --rm -T \
 *     -e AIQSA_FEATURES_PAID_E2E=DISPOSABLE -e AIQSA_NATIVE_ENGINE_USERS='*' \
 *     -e AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0 -e CODEX_LB_API_KEY -e CODEX_LB_BASE_URL \
 *     app npx playwright test --project=chromium tests/e2e/native-workspace-paid.spec.ts
 *
 * (The dev app service already carries the runner URL and token.)
 *
 * Expected paid calls (Codex LB only): custom setup once (discovery plus its
 * model checks); the chart turn about three to eight model requests (look at
 * the workbook, write and run the script, maybe fix it, answer); the patch
 * turn two or three (maybe a read, the patch, the answer); the recall turn
 * one. About 8–15 requests in all.
 *
 * Oracles are the persisted runs, tool calls, Workspace activity entries,
 * run bindings, outputs and session rows, the browser's own run stream (event
 * kinds and arrival times only, recorded by a content-free probe), the PNG's
 * own bytes, the Workspace archive the product downloads, and a synthetic
 * workbook whose best month is chosen at random, never the model's wording
 * beyond one requested `BEST_MONTH:` line. Prompts, answers and file contents
 * are never printed; the attached summary holds statuses, tool names and
 * states, counts, durations and sizes only. The chat (and with it its
 * Workspace) is deleted permanently afterwards and the account's chat
 * defaults restored; the codex-lb connection stays on the stand like the
 * other paid specs' connections.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import { utils as spreadsheetUtils, write as writeWorkbook } from "xlsx";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { workspaceActivitySnapshot } from "../../lib/server/runs/workspaceActivityPersistence";
import { getWorkspaceConfig, WorkspaceConfigError, type WorkspaceConfig } from "../../lib/server/workspace/config";
import { selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { disableMemoryRecall, lastActivity, lastAnswer, openLastActivity } from "./support/workspace";

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
test.skip(typeof workspaceConfig === "string", `requires a real Workspace runner: the app's Workspace runtime resolves to ${
  typeof workspaceConfig === "string" ? workspaceConfig : "remote"} (set AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0, ` +
  "AIQSA_WORKSPACE_RUNNER_URL and AIQSA_WORKSPACE_RUNNER_TOKEN)");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 900_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };
const SCRIPT_PATH = "/workspace/project/margin_chart.py";
const SCRIPT_NAME = "margin_chart.py";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December"] as const;

// ---------------------------------------------------------------------------
// The synthetic workbook

/**
 * Twelve months of revenue and cost. One month, chosen at random, has by far
 * the best margin both in money and in percent (64 000 and 40 % against at
 * most about 30 400 and 26 % elsewhere), so either reading names it.
 */
function marginWorkbook(): Readonly<{ bestMonth: string; bytes: Buffer }> {
  const best = randomInt(MONTHS.length);
  const rows = MONTHS.map((month, index) => {
    if (index === best) return [month, 160_000, 96_000] as const;
    const revenue = 90_000 + 3_000 * index;
    return [month, revenue, Math.round(revenue * (0.74 + (index % 3) * 0.02))] as const;
  });
  const sheet = spreadsheetUtils.aoa_to_sheet([["Month", "Revenue", "Cost"], ...rows.map((row) => [...row])]);
  const book = spreadsheetUtils.book_new();
  spreadsheetUtils.book_append_sheet(book, sheet, "Monthly");
  return { bestMonth: MONTHS[best]!, bytes: writeWorkbook(book, { bookType: "xlsx", type: "buffer" }) as Buffer };
}

/** The month on the answer's last `BEST_MONTH:` line, lower-cased; null without one. */
function statedBestMonth(text: string): string | null {
  const matches = [...text.matchAll(/BEST_MONTH:\s*[*_`]*\s*([A-Za-z]+)/gu)];
  return matches.at(-1)?.[1]?.toLowerCase() ?? null;
}

function namesMonth(stated: string | null, month: string): boolean {
  return stated !== null && (stated === month.toLowerCase() || stated === month.slice(0, 3).toLowerCase());
}

// ---------------------------------------------------------------------------
// A content-free probe of the browser's run streams: event kinds and arrival times only

type StreamRecord = Readonly<{
  activityKind?: string; activityPhase?: string; artifactType?: string; at: number; runId?: string; stream: number; type: string;
}>;

/** Runs in the page before the app: tees every `text/event-stream` response and records each event's kind and arrival. */
function installStreamProbe(): void {
  const target = window as unknown as { __aiqsaWorkspaceProbe?: StreamRecord[] };
  if (target.__aiqsaWorkspaceProbe) return;
  const records: StreamRecord[] = [];
  target.__aiqsaWorkspaceProbe = records;
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
    const entry = type === "artifact" && payload.artifactType === "workspace_activity" && payload.payload &&
      typeof payload.payload === "object" ? payload.payload as Record<string, unknown> : null;
    records.push({ at: Date.now(), stream, type,
      ...(type === "artifact" && typeof payload.artifactType === "string" ? { artifactType: payload.artifactType } : {}),
      ...(entry && typeof entry.kind === "string" ? { activityKind: entry.kind } : {}),
      ...(entry && typeof entry.phase === "string" ? { activityPhase: entry.phase } : {}),
      ...(type === "run_start" && typeof payload.runId === "string" ? { runId: payload.runId } : {}) });
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

/** The run's own stream records once it ended. */
async function streamRecords(page: Page, runId: string): Promise<StreamRecord[]> {
  return pollUntil(120_000, async () => {
    const records = await page.evaluate(() => (window as unknown as { __aiqsaWorkspaceProbe?: StreamRecord[] }).__aiqsaWorkspaceProbe ?? []);
    const stream = records.find((entry) => entry.type === "run_start" && entry.runId === runId)?.stream;
    if (stream === undefined) return null;
    const own = records.filter((entry) => entry.stream === stream);
    return own.some((entry) => entry.type === "done" || entry.type === "error") ? own : null;
  }, "native_workspace_run_stream_not_observed");
}

/** Browser-clock milliseconds from the send to the first Workspace activity, the first VM start and the end of the stream. */
function liveTimings(records: readonly StreamRecord[], sentAt: number) {
  const since = (entry: StreamRecord | undefined) => entry ? entry.at - sentAt : null;
  return {
    toDoneMs: since(records.find((entry) => entry.type === "done" || entry.type === "error")),
    toFirstWorkspaceActivityMs: since(records.find((entry) => entry.artifactType === "workspace_activity")),
    toVmStartMs: since(records.find((entry) => entry.activityKind === "workspace_start"))
  };
}

// ---------------------------------------------------------------------------
// Runs, tool calls and Workspace records

async function runIds(chatId: string): Promise<string[]> {
  return (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
}

/** Sends the composer's text and returns the browser-clock time of the send. */
async function sendComposer(page: Page, text: string): Promise<number> {
  const composer = page.getByRole("textbox", { exact: true, name: "Message" });
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({ timeout: 120_000 });
  const sentAt = await page.evaluate(() => Date.now());
  await composer.press("Enter");
  return sentAt;
}

async function newRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  return pollUntil(120_000, async () => prisma.modelRun.findFirst({
    orderBy: { createdAt: "desc" }, where: { chatId, id: { notIn: [...earlier] } }
  }), "native_workspace_run_not_admitted");
}

/** Waits until the run settles; it must complete on the native engine. */
async function settledRun(runId: string): Promise<ModelRun> {
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
    return ACTIVE_RUN_STATUSES.includes(current.status) ? null : current;
  }, "native_workspace_run_timeout");
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  expect(run.engine, "the run ran on the native engine (the stand's app needs AIQSA_NATIVE_ENGINE_USERS)").toBe("native");
  expect(run.status, `the run completes (${typeof code === "string" ? code : run.status})`).toBe("complete");
  return run;
}

type Turn = Readonly<{ records: StreamRecord[]; run: ModelRun; sentAt: number }>;

/** Sends a turn in the open chat and returns its settled run and its own stream records. */
async function turn(page: Page, chatId: string, text: string): Promise<Turn> {
  const earlier = await runIds(chatId);
  const sentAt = await sendComposer(page, text);
  const run = await settledRun((await newRun(chatId, earlier)).id);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return { records: await streamRecords(page, run.id), run, sentAt };
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

/** The run's tool calls by name and state, and those that ran in the Workspace. */
async function toolCalls(runId: string) {
  const rows = await prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { createdAt: true, startedAt: true, state: true, toolName: true, workspaceRunBindingId: true }, where: { modelRunId: runId } });
  const workspace = rows.filter((row) => row.workspaceRunBindingId !== null || /^mcp_workspace_|sandbox_/u.test(row.toolName));
  return { names: rows.map((row) => `${row.toolName}:${row.state}`), rows, workspace };
}

type ActivityEntry = Readonly<{
  changes?: readonly Readonly<{ action: string; displayPath: string }>[]; durationMs?: number; id: string; kind: string; phase: string;
  startedAt?: string;
}>;

/**
 * The run's kept Workspace activity entries, each in its latest saved state,
 * as a reload reads them: every update leaves a value-free
 * `workspace_activity_receipt`, and the entries themselves live in the run's
 * one `workspace_activity_snapshot` row (sequence -1). Only runs from before
 * snapshots kept `artifact` rows of them.
 */
async function workspaceActivity(runId: string): Promise<ActivityEntry[]> {
  const row = await prisma.modelRunEvent.findUnique({ select: { payload: true },
    where: { modelRunId_sequence: { modelRunId: runId, sequence: -1 } } });
  return [...(workspaceActivitySnapshot(row?.payload)?.entries ?? [])] as ActivityEntry[];
}

const vmStarts = (entries: readonly ActivityEntry[]) => entries.filter((entry) => entry.kind === "workspace_start");

/**
 * Waits until the run's Workspace handoff is over (the chat's Workspace
 * operation released and, with `exported`, its output export settled), so the
 * next send or the archive is not refused as busy. Returns the binding's
 * facts, or a null binding when the run has none.
 */
async function settledWorkspace(runId: string, exported = true) {
  return pollUntil(180_000, async () => {
    const binding = await prisma.workspaceRunBinding.findUnique({ select: { exportState: true, guestUsedAt: true,
      workspaceSession: { select: { id: true, operationOwner: true, runtimeSandboxId: true, sandboxName: true, state: true } } },
    where: { modelRunId: runId } });
    if (!binding) return { binding: null };
    if (binding.workspaceSession.operationOwner !== null || exported && !["COMPLETE", "FAILED"].includes(binding.exportState)) return null;
    return { binding };
  }, "native_workspace_handoff_timeout");
}

/** Whether the sandbox identity is the one the deterministic runtime makes for the session's first guest. */
function deterministicSandboxId(session: Readonly<{ id: string; runtimeSandboxId: string | null; sandboxName: string }>): boolean {
  return session.runtimeSandboxId === createHash("sha256").update(["deterministic", session.id, session.sandboxName, "1"].join("\0"))
    .digest("hex");
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
    if (attempt.status() === 409) return null;
    return attempt;
  }, "native_workspace_archive_busy");
  expect(response.status(), "the Workspace archive is made").toBe(200);
  const file = (await response.json() as { file: { attachmentId: string } }).file;
  const content = await page.request.get(`/api/attachments/${encodeURIComponent(file.attachmentId)}/content`);
  expect(content.status(), "the Workspace archive downloads").toBe(200);
  return tarFiles(await content.body());
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

const generatedFiles = (page: Page) => lastAnswer(page).getByRole("region", { name: "Generated files" });

// ---------------------------------------------------------------------------

/** One codex-lb connection per server start. */
let answerModel: PaidAnswerModel | null = null;

test.describe("native engine in a real Workspace VM on Codex LB", () => {
  test("charts an uploaded workbook, patches its script and answers a recall turn without the VM", async ({ page, browser, baseURL },
    testInfo) => {
    test.setTimeout(75 * 60_000);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
    const config = workspaceConfig as WorkspaceConfig;
    const summary: Record<string, unknown> = { runtimeMode: config.runtimeMode };
    let chatId: string | null = null;
    let restoreDefaults: (() => Promise<void>) | null = null;
    await page.setViewportSize(DESKTOP);
    await page.addInitScript(installStreamProbe);
    try {
      // The runner answers its own health check, and the installation offers Workspace.
      const health = await fetch(new URL("health", `${config.runnerUrl!.toString().replace(/\/?$/u, "/")}`),
        { headers: { authorization: `Bearer ${config.runnerToken!}` }, signal: AbortSignal.timeout(30_000) });
      summary.runnerHealth = health.status;
      expect(health.ok, "the Workspace runner is healthy").toBe(true);
      const policy = await prisma.workspacePolicy.findUnique({ select: { enabled: true }, where: { id: "installation" } });
      expect(policy?.enabled, "the installation's Workspace policy is enabled").toBe(true);

      await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
      await authenticateWithLocalToken(page.request);
      const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
      restoreDefaults = await snapshotComposerDefaults(prisma, userId);
      await keepAccountMcpDefault(page);
      await disableMemoryRecall(page);
      answerModel ??= await setupCodexLbAnswerModel(page.request, {
        label: "Native workspace", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
      });
      summary.answerModel = answerModel.upstreamModelId;

      chatId = await newExcludedChat(page.request, `Native workspace ${randomUUID().slice(0, 8)}`);
      await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
      await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
      const model = answerModel;
      await expect(async () => selectModel(page, model.connectionId, model.displayName)).toPass({ timeout: 60_000 });
      await expect(page.getByTestId("header-model-trigger")).toContainText(model.displayName);
      await turnComposerToolsOff(page);
      expect(await prisma.workspaceSession.findUnique({ select: { id: true }, where: { chatId } }), "no Workspace before the first turn")
        .toBeNull();

      // 1. The chart: the VM starts at the first Workspace call of this turn.
      const workbook = marginWorkbook();
      const workbookName = `margins-${randomUUID().slice(0, 6)}.xlsx`;
      await page.getByLabel("Attach files").setInputFiles({ buffer: workbook.bytes, mimeType: XLSX_MIME, name: workbookName });
      const attachment = page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: workbookName });
      await expect(attachment).toHaveAttribute("data-attachment-status", "ready", { timeout: 180_000 });
      const chart = await turn(page, chatId, "The attached workbook has one row per month with revenue and cost. In the Workspace, " +
        `write a Python script ${SCRIPT_PATH} that reads the workbook, computes each month's margin (revenue minus cost) and saves a ` +
        "bar chart of the monthly margin as margin_chart.png in this turn's output folder, titled \"Monthly margin\". Run it so the PNG " +
        "is attached to your answer. Then tell me which month had the best margin, and end your answer with one line exactly in the " +
        "form BEST_MONTH: <full month name>.");
      const chartCalls = await toolCalls(chart.run.id);
      const chartActivity = await workspaceActivity(chart.run.id);
      const chartStarts = vmStarts(chartActivity);
      const chartHandoff = await settledWorkspace(chart.run.id);
      const outputs = await prisma.workspaceRunOutput.findMany({ orderBy: { createdAt: "asc" },
        select: { attachment: { select: { byteSize: true, checksum: true, fileName: true, id: true, mimeType: true } }, relativePath: true },
        where: { workspaceRunBindingId: chart.run.id } });
      const pngs = outputs.filter((output) => /\.png$/iu.test(output.relativePath));
      const png = pngs.find((output) => output.attachment.fileName === "margin_chart.png") ?? pngs[0];
      const chartStated = statedBestMonth(await answerText(chart.run));
      const firstWorkspaceCall = chartCalls.workspace[0];
      const vmStart = chartStarts[0];
      const vmStartedAt = vmStart?.startedAt ? Date.parse(vmStart.startedAt) : null;
      summary.chart = {
        bestMonthMatches: namesMonth(chartStated, workbook.bestMonth), calls: chartCalls.names, exportState: chartHandoff.binding?.exportState,
        live: liveTimings(chart.records, chart.sentAt), outputs: outputs.length, pngOutputs: pngs.length,
        server: {
          toAnswerCompletedMs: chart.run.answerCompletedAt ? chart.run.answerCompletedAt.getTime() - chart.run.createdAt.getTime() : null,
          toFirstWorkspaceCallMs: firstWorkspaceCall ? firstWorkspaceCall.createdAt.getTime() - chart.run.createdAt.getTime() : null,
          toVmStartMs: vmStartedAt !== null ? vmStartedAt - chart.run.createdAt.getTime() : null,
          vmStartDurationMs: vmStart?.durationMs ?? null
        },
        sessionState: chartHandoff.binding?.workspaceSession.state, status: chart.run.status,
        vmStarts: chartStarts.map((entry) => entry.phase)
      };

      expect(chartCalls.workspace.some((row) => row.state === "complete"), "at least one Workspace call completed").toBe(true);
      expect(chartStarts.length, "the VM started in this turn").toBeGreaterThanOrEqual(1);
      expect(chartStarts[0]?.phase, "the VM start succeeded").toBe("succeeded");
      expect(vmStartedAt, "the VM start has its time").not.toBeNull();
      // Not before the first Workspace call was recorded (app and database clocks, two seconds apart at most).
      expect(vmStartedAt!, "the VM started at the first Workspace call, not at admission")
        .toBeGreaterThanOrEqual(firstWorkspaceCall!.createdAt.getTime() - 2_000);
      const session = chartHandoff.binding?.workspaceSession;
      expect(session?.runtimeSandboxId ?? null, "the chat has a real sandbox").not.toBeNull();
      expect(deterministicSandboxId(session!), "the sandbox is not the deterministic runtime's").toBe(false);
      expect(chartHandoff.binding?.exportState, "the turn's outputs were exported").toBe("COMPLETE");
      expect(png, "a PNG is among the turn's outputs").toBeDefined();
      expect(png!.attachment.mimeType).toBe("image/png");
      expect(chartStated, "the answer states the best month on its BEST_MONTH line").not.toBeNull();
      expect(namesMonth(chartStated, workbook.bestMonth), "the stated best month is the workbook's").toBe(true);

      // The PNG is attached to the answer, downloads whole and decodes.
      await page.reload();
      const files = generatedFiles(page);
      await expect(files).toContainText(png!.attachment.fileName, { timeout: 60_000 });
      const download = files.getByRole("listitem").filter({ hasText: png!.attachment.fileName }).getByRole("link", { name: "Download" });
      const href = await download.getAttribute("href");
      expect(href, "the card downloads the exported PNG").toBe(`/api/attachments/${encodeURIComponent(png!.attachment.id)}/content`);
      const pngResponse = await page.request.get(href!);
      expect(pngResponse.status()).toBe(200);
      const pngBytes = await pngResponse.body();
      const pngMeta = await sharp(pngBytes).metadata();
      summary.chart = { ...summary.chart as object, png: { bytes: pngBytes.byteLength, format: pngMeta.format, height: pngMeta.height,
        width: pngMeta.width } };
      expect(pngBytes.byteLength).toBe(png!.attachment.byteSize);
      expect(createHash("sha256").update(pngBytes).digest("hex")).toBe(png!.attachment.checksum);
      expect(pngBytes.subarray(0, 8).equals(PNG_SIGNATURE), "the file is a PNG").toBe(true);
      expect(pngMeta.format).toBe("png");
      expect(pngMeta.width ?? 0, "a sane chart width").toBeGreaterThanOrEqual(200);
      expect(pngMeta.width ?? 0).toBeLessThanOrEqual(10_000);
      expect(pngMeta.height ?? 0, "a sane chart height").toBeGreaterThanOrEqual(150);
      expect(pngMeta.height ?? 0).toBeLessThanOrEqual(10_000);
      await desktopShot(page, testInfo, files, "01-chart-answer");
      await phoneShot(browser, baseURL!, chatId, testInfo, "01-chart-answer", (phone) => generatedFiles(phone));

      // 2. The patch: apply_patch changes the script the first turn wrote.
      const tag = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
      const patchTitle = `Monthly margin ${tag}`;
      const patch = await turn(page, chatId, `Fix the title in the script you wrote: use the apply_patch tool to change the chart title in ` +
        `${SCRIPT_PATH} to "${patchTitle}". Only edit the file; there is no need to run it.`);
      const patchCalls = await toolCalls(patch.run.id);
      const patchActivity = await workspaceActivity(patch.run.id);
      const patchHandoff = await settledWorkspace(patch.run.id);
      const fileChanges = patchActivity.filter((entry) => entry.kind === "file_change");
      summary.patch = { calls: patchCalls.names, exportState: patchHandoff.binding?.exportState, fileChanges: fileChanges.map((entry) => ({
        changedScript: entry.changes?.some((change) => change.displayPath.endsWith(SCRIPT_NAME)) ?? false, phase: entry.phase })),
      live: liveTimings(patch.records, patch.sentAt), status: patch.run.status, vmStarts: vmStarts(patchActivity).map((entry) => entry.phase) };

      expect(patchCalls.names, "the agent edited the script with apply_patch").toContain("apply_patch:complete");
      expect(fileChanges.some((entry) => entry.phase === "succeeded" &&
        entry.changes?.some((change) => change.displayPath.endsWith(SCRIPT_NAME))), "the answer keeps the script's change").toBe(true);
      await page.reload();
      const patchFold = await openLastActivity(page);
      await expect(patchFold).toContainText(new RegExp(`Edited \\S*${SCRIPT_NAME.replace(".", "\\.")}`, "u"), { timeout: 60_000 });
      await desktopShot(page, testInfo, patchFold, "02-patch-answer");
      await phoneShot(browser, baseURL!, chatId, testInfo, "02-patch-answer", (phone) => lastActivity(phone),
        async (phone) => { await openLastActivity(phone); });

      // 3. Recall: no code, no Workspace call, no VM start.
      const sessionBefore = await prisma.workspaceSession.findUniqueOrThrow({ select: { runtimeSandboxId: true, state: true, version: true },
        where: { chatId } });
      const recall = await turn(page, chatId, "What was the best month again? Answer from what we already found, without running " +
        "anything, and end with one line exactly in the form BEST_MONTH: <full month name>.");
      const recallCalls = await toolCalls(recall.run.id);
      const recallActivity = await workspaceActivity(recall.run.id);
      const recallHandoff = await settledWorkspace(recall.run.id, false);
      const sessionAfter = await prisma.workspaceSession.findUniqueOrThrow({ select: { runtimeSandboxId: true, state: true, version: true },
        where: { chatId } });
      const recallStated = statedBestMonth(await answerText(recall.run));
      summary.recall = { bestMonthMatches: namesMonth(recallStated, workbook.bestMonth), calls: recallCalls.names,
        guestUsed: recallHandoff.binding ? recallHandoff.binding.guestUsedAt !== null : null, live: liveTimings(recall.records, recall.sentAt),
        sessionState: { after: sessionAfter.state, before: sessionBefore.state }, status: recall.run.status,
        vmStarts: vmStarts(recallActivity).length, workspaceActivity: recallActivity.length,
        workspaceActivityLive: recall.records.filter((entry) => entry.artifactType === "workspace_activity").length };

      expect(recallCalls.workspace, "no Workspace call").toHaveLength(0);
      expect(vmStarts(recallActivity), "no VM start was kept").toHaveLength(0);
      expect(recall.records.some((entry) => entry.activityKind === "workspace_start"), "no VM start was streamed").toBe(false);
      expect(recallHandoff.binding?.guestUsedAt ?? null, "the turn never used the guest").toBeNull();
      expect(sessionAfter.runtimeSandboxId, "the chat keeps its sandbox").toBe(sessionBefore.runtimeSandboxId);
      // The session version counts operation claims (every run claims and retires one), not recreations; the
      // unchanged sandbox above is the recreation check.
      if (sessionBefore.state === "STOPPED") expect(sessionAfter.state, "a stopped VM stays stopped").toBe("STOPPED");
      expect(namesMonth(recallStated, workbook.bestMonth), "the recalled best month is the workbook's").toBe(true);

      // The script on the Workspace disk carries the patched title.
      const archive = await workspaceArchive(page, chatId);
      const scripts = [...archive.entries()].filter(([name]) => name === SCRIPT_NAME || name.endsWith(`/${SCRIPT_NAME}`));
      summary.archive = { files: archive.size, scripts: scripts.length,
        scriptHasPatchedTitle: scripts.some(([, bytes]) => bytes.toString("utf8").includes(patchTitle)) };
      expect(scripts.length, "the archive holds the script").toBeGreaterThanOrEqual(1);
      expect(scripts.some(([, bytes]) => bytes.toString("utf8").includes(patchTitle)), "the script carries the patched title").toBe(true);
    } finally {
      await page.goto("about:blank").catch(() => undefined);
      if (chatId) {
        // Permanent deletion also removes the chat's Workspace and its guest.
        const owned = chatId;
        await deleteOwnedChatPermanently(page.request, owned, { timeout: 60_000 }).catch(() => undefined);
        summary.cleanup = { chatDeleted: await pollUntil(180_000, async () => await prisma.chat.count({ where: { id: owned } }) === 0
          ? true : null, "native_workspace_chat_not_deleted").catch(() => false) };
      }
      await restoreDefaults?.().catch(() => { summary.composerDefaultsRestore = "failed"; });
      await testInfo.attach("native-workspace-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
      console.log(`native_workspace_paid_summary ${JSON.stringify(summary)}`);
    }
  });
});
