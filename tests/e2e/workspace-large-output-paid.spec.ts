/**
 * Opt-in, paid, bounded check that large Workspace outputs checkpoint and
 * download intact through a real KVM Workspace on a DISPOSABLE stand, with a
 * real tool-capable model. Regression of v0.5.1: checkpoints of files over
 * 16 MiB failed with `workspace_capture_unavailable` when the runner's
 * keep-alive close cut an output stream's tail while the app drained slowly
 * into object storage (`lib/server/workspace/runnerServer.ts`,
 * `remoteRuntime.ts`, `selectedCapture.ts`).
 *
 * Never a default lane: it runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE,
 * AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL
 * (the Codex root ending in `/backend-api/codex`); AIQSA_FEATURES_CODEX_MODEL
 * picks the codex-lb model (default as `setupCodexLbAnswerModel`). The app
 * must use a real remote runner; the test refuses a sandbox identity the
 * deterministic runtime would have made. The stand's Workspace output limits
 * must admit the files (defaults: 256 MiB per file, 512 MiB per run).
 * The scenarios run serially and one failure skips the rest;
 * AIQSA_WLO_PAID_SERIAL=0 runs each on its own, and `--grep <scenario>` runs
 * one.
 *
 * Each scenario opens a fresh chat on the codex-lb model with MCP, Skills,
 * Search and Memory recall off (the Workspace joins every turn), and asks in
 * plain words for files of random bytes made with shell commands in the
 * answer's output folder, their sha256 printed, and the files saved as the
 * answer's downloads. Oracles are the database and HTTP, never the model's
 * wording: the run completes and its outputs are exported; no tool result of
 * the run carries a capture, export or stream failure code; a settled
 * checkpoint of the run holds each file at its exact size; and every
 * Workspace output of the run with that name downloads through the app's own
 * attachment route with exactly that many bytes and a sha256 equal to the
 * stored checksum and to one the guest printed (parsed from the stored
 * Workspace tool results). Expected paid calls (codex-lb only): setup once,
 * then about three to eight model requests per scenario.
 *
 * Nothing prints file content, prompts or answers: one sanitized JSON summary
 * per scenario (codes, booleans, counts, sizes, durations) is printed and
 * attached. Chats are removed afterwards and the account's chat defaults
 * restored; the codex-lb connection stays on the stand like the other paid
 * specs' connections.
 */
import { createHash } from "node:crypto";
import { PrismaClient, type ModelRun, type ModelRunStatus, type Prisma } from "@prisma/client";
import { expect, test, type Page, type Response as PageResponse, type TestInfo } from "@playwright/test";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { selectModel } from "./shell/composer";
import { safeCode, sha256Hex } from "./support/artifactFilesStand";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { authenticateWithLocalToken } from "./support/localAuth";
import { paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { disableMemoryRecall } from "./support/workspace";

const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));
const workspaceLive = process.env.AIQSA_WORKSPACE_LIVE_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.skip(!workspaceLive, "requires an explicitly disposable KVM Microsandbox topology (AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE)");
test.describe.configure({ mode: paidEnv("AIQSA_WLO_PAID_SERIAL") === "0" ? "default" : "serial" });

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const MIB = 1024 * 1024;
const WARMUP_TIMEOUT_MS = 300_000;
/** The stand stores at about 1.5–2 MB/s, so a turn that checkpoints 124 MiB spends minutes on storage alone. */
const TURN_TIMEOUT_MS = 25 * 60_000;
/** The end-of-run export streams the output folder through the same runner path. */
const EXPORT_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const SEND_READY_TIMEOUT_MS = 10 * 60_000;
const SCENARIO_TIMEOUT_MS = 60 * 60_000;
const ACTIVE_RUN_STATUSES: ModelRunStatus[] = ["preparing", "queued", "streaming", "in_progress"];
/** The failures this regression produced or that the fix introduced; none may appear in any tool result of a run. */
const FORBIDDEN_CODES = ["workspace_capture_unavailable", "workspace_output_export_failed", "workspace_output_stream_incomplete"] as const;
const WORKSPACE_TOOL = /^mcp_workspace_|sandbox_/u;

/** One codex-lb connection for the whole file. */
let answerModel: PaidAnswerModel | null = null;

type Stand = {
  readonly page: Page;
  readonly scenario: string;
  model: PaidAnswerModel | null;
  readonly chatIds: Set<string>;
  readonly summary: Record<string, unknown>;
  step: string;
};

type ExpectedFile = Readonly<{ name: string; bytes: number }>;

function failureCode(error: unknown): string {
  return error instanceof Error && /^wlo_[a-z0-9_]+$/u.test(error.message) ? error.message : "assertion_or_timeout";
}

/**
 * Runs one scenario as the local administrator: snapshots the account's chat
 * defaults, turns Memory recall off, prepares the codex-lb model, and always
 * prints the sanitized summary and removes the scenario's chats.
 */
async function withScenario(page: Page, testInfo: TestInfo, scenario: string, body: (stand: Stand) => Promise<void>): Promise<void> {
  const stand: Stand = { page, scenario, model: null, chatIds: new Set(), summary: { scenario }, step: "setup" };
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(db(), userId);
    await disableMemoryRecall(page);
    answerModel ??= await setupCodexLbAnswerModel(page.request, {
      label: "Large outputs", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
    });
    stand.model = answerModel;
    stand.summary.answerModel = answerModel.upstreamModelId;
    await body(stand);
    stand.summary.passed = true;
  } catch (error) {
    Object.assign(stand.summary, { passed: false, failedStep: stand.step, failure: failureCode(error) });
    throw error;
  } finally {
    await testInfo.attach(`${scenario}-summary.json`, { body: JSON.stringify(stand.summary, null, 2), contentType: "application/json" });
    console.log(`workspace_large_output_paid_summary ${JSON.stringify(stand.summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of stand.chatIds) {
      const active = await db().modelRun.findMany({ select: { id: true },
        where: { chatId, status: { in: ACTIVE_RUN_STATUSES } } }).catch(() => []);
      for (const run of active) await page.request.post(`/api/model-runs/${run.id}/cancel`).catch(() => undefined);
      await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    }
    await restoreDefaults?.().catch(() => undefined);
  }
}

/** A fresh chat on the codex-lb model: MCP, Skills, Search and Memory recall off; the Workspace joins every turn. */
async function startChat(stand: Stand): Promise<void> {
  stand.step = "start_chat";
  const { page } = stand;
  await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 60_000 });
  await selectModel(page, stand.model!.connectionId, stand.model!.displayName);
  await expect(page.getByTestId("header-model-trigger")).toContainText(stand.model!.displayName);
  await turnComposerToolsOff(page);
}

/**
 * Presses Enter once the composer can send and returns the admitted message
 * request. Only a Workspace still retiring the previous turn (409
 * workspace_busy) is retried, with the draft kept, as in workspace-live.spec.ts.
 */
async function admitTurn(stand: Stand, text: string): Promise<PageResponse> {
  const { page } = stand;
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message" });
  await composer.fill(text);
  for (let attempt = 0; ; attempt += 1) {
    const ready = await expect(send).toBeEnabled({ timeout: SEND_READY_TIMEOUT_MS }).then(() => true, () => false);
    if (!ready) throw new Error("wlo_send_blocked");
    const admitted = page.waitForResponse((value) => value.request().method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(value.url()).pathname), { timeout: 180_000 });
    await composer.press("Enter");
    const response = await admitted;
    if (response.ok()) return response;
    const code = safeCode((await response.json().catch(() => null) as { error?: unknown } | null)?.error);
    if (response.status() !== 409 || code !== "workspace_busy" || attempt >= 2) throw new Error(`wlo_admission_${response.status()}_${code}`);
    await expect(composer).toHaveValue(text);
    await page.waitForTimeout(15_000);
  }
}

type ToolCallRow = Readonly<{ id: string; toolName: string; state: string; result: Prisma.JsonValue | null;
  startedAt: Date | null; completedAt: Date | null }>;
type Turn = Readonly<{ run: ModelRun; calls: readonly ToolCallRow[] }>;

/** Tool names as product names only: Workspace tools by their sandbox verb, anything else as "other". */
function toolLabel(name: string): string {
  if (["checkpoint_outputs", "apply_patch"].includes(name)) return name;
  const workspace = /sandbox_[a-z_]+?(?=_[0-9a-f]{10}$|$)/u.exec(name)?.[0];
  return workspace ? `workspace:${workspace}` : "other";
}

/** Whether the sandbox identity is the one the deterministic runtime makes for the session's first guest. */
function deterministicSandboxId(session: Readonly<{ id: string; runtimeSandboxId: string | null; sandboxName: string }>): boolean {
  return session.runtimeSandboxId === createHash("sha256").update(["deterministic", session.id, session.sandboxName, "1"].join("\0"))
    .digest("hex");
}

/**
 * Sends one request from the composer and waits until its run settled, its
 * Workspace outputs are exported and the composer is free again.
 */
async function sendTurn(stand: Stand, text: string): Promise<Turn> {
  stand.step = "send";
  const { page } = stand;
  const openChatId = parseChatRoutePath(new URL(page.url()).pathname)?.chatId ?? null;
  const before = openChatId ? await db().modelRun.count({ where: { chatId: openChatId } }) : 0;
  const response = await admitTurn(stand, text);
  const chatId = new URL(response.url()).pathname.split("/")[3]!;
  stand.chatIds.add(chatId);
  stand.step = "run";
  const started = Date.now();
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const runs = await db().modelRun.findMany({ orderBy: { createdAt: "asc" }, where: { chatId } });
    const newest = runs.length > before ? runs.at(-1)! : null;
    return newest && !ACTIVE_RUN_STATUSES.includes(newest.status) ? newest : null;
  }, "wlo_run_timeout");
  const runMs = Date.now() - started;
  stand.step = "export";
  const exportStarted = Date.now();
  // As in artifact-files-paid.spec.ts: a run that did not complete exports nothing new, so only a live lease is awaited.
  const exportState = await pollUntil(EXPORT_TIMEOUT_MS, async () => {
    const binding = await db().workspaceRunBinding.findUnique({ where: { modelRunId: run.id }, select: { exportState: true,
      exportAttemptCount: true, exportLeaseExpiresAt: true,
      _count: { select: { selectedCaptures: true, toolCalls: true } }, workspaceSession: { select: { operationOwner: true } } } });
    if (!binding) return "none";
    if (run.status !== "complete") {
      if (binding.exportState === "EXPORTING" && binding.exportLeaseExpiresAt !== null && binding.exportLeaseExpiresAt > new Date()) return null;
      return binding.exportState === "PENDING" && binding.exportAttemptCount === 0 ? "not_exported" : binding.exportState;
    }
    if (binding.workspaceSession.operationOwner !== null) return null;
    if (binding.exportState === "COMPLETE" || binding.exportState === "FAILED") return binding.exportState;
    return binding._count.toolCalls === 0 && binding._count.selectedCaptures === 0 ? "unused" : null;
  }, "wlo_workspace_export_timeout");
  const binding = await db().workspaceRunBinding.findUnique({ where: { modelRunId: run.id }, select: { lastExportErrorCode: true,
    workspaceSession: { select: { id: true, runtimeSandboxId: true, sandboxName: true } } } });
  const calls = await db().modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { id: true, toolName: true, state: true, result: true, startedAt: true, completedAt: true }, where: { modelRunId: run.id } });
  const tools: Record<string, Record<string, number>> = {};
  for (const call of calls) {
    const counts = tools[toolLabel(call.toolName)] ??= {};
    counts[call.state] = (counts[call.state] ?? 0) + 1;
  }
  Object.assign(stand.summary, { runStatus: run.status, runErrorCode: safeCode((run.errorPayload as { code?: unknown } | null)?.code ?? null),
    runMs, exportWaitMs: Date.now() - exportStarted, workspaceExport: exportState,
    exportErrorCode: binding?.lastExportErrorCode ? safeCode(binding.lastExportErrorCode) : null, tools,
    forbiddenCodes: forbiddenCodesIn(calls) });
  if (run.status !== "complete") throw new Error(`wlo_run_${run.status}`);
  const session = binding?.workspaceSession ?? null;
  expect(session?.runtimeSandboxId ?? null, "the chat has a real sandbox").not.toBeNull();
  expect(deterministicSandboxId(session!), "the sandbox is not the deterministic runtime's").toBe(false);
  expect(exportState, "the run's outputs were exported").toBe("COMPLETE");
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return { run, calls };
}

// ------------------------------------------------------------- Evidence ---

/** Every string inside a persisted JSON value, in order; a string that is itself JSON (a tool's text block) is opened too. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
    if (/^\s*[[{]/u.test(value)) {
      try { stringsIn(JSON.parse(value) as unknown, into); } catch { /* plain text */ }
    }
  } else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringsIn(item, into);
  return into;
}

const baseName = (path: string): string => path.replace(/^["'`]+|["'`,;]+$/gu, "").split("/").at(-1) ?? "";

/**
 * The sha256 digests the guest printed per file name, from the run's stored
 * Workspace tool results (`sha256sum` lines, or the BSD `SHA256 (file) = …` form).
 */
function guestDigests(calls: readonly ToolCallRow[]): Map<string, Set<string>> {
  const digests = new Map<string, Set<string>>();
  const add = (path: string, digest: string) => {
    const name = baseName(path);
    if (name) (digests.get(name) ?? digests.set(name, new Set()).get(name)!).add(digest.toLowerCase());
  };
  for (const call of calls) {
    if (!WORKSPACE_TOOL.test(call.toolName)) continue;
    for (const text of stringsIn(call.result)) {
      for (const match of text.matchAll(/(?:^|[^0-9a-fA-F])([0-9a-fA-F]{64})[ \t]+\*?([^\s\\"']+)/gmu)) add(match[2]!, match[1]!);
      for (const match of text.matchAll(/SHA2?-?256 ?\(([^\s\\"')]+)\) ?= ?([0-9a-fA-F]{64})/gu)) add(match[1]!, match[2]!);
    }
  }
  return digests;
}

/** The forbidden failure codes any tool result of the run carries. */
function forbiddenCodesIn(calls: readonly ToolCallRow[]): string[] {
  const found = new Set<string>();
  for (const call of calls) {
    const text = JSON.stringify(call.result ?? null);
    for (const code of FORBIDDEN_CODES) if (text.includes(code)) found.add(code);
  }
  return [...found];
}

async function runCheckpoints(runId: string) {
  return db().workspaceOutputCheckpoint.findMany({ orderBy: { createdAt: "asc" }, where: { modelRunId: runId },
    select: { id: true, state: true, failureCode: true, toolCallId: true, files: { select: { relativePath: true,
      attachment: { select: { id: true, byteSize: true, checksum: true, origin: true, producerModelRunId: true, status: true } } } } } });
}

type DownloadEvidence = Readonly<{ source: "checkpoint" | "run_output" | "other"; status: number; bytes: number; ms: number;
  sizeMatches: boolean; storedMatches: boolean; guestMatches: boolean }>;
/** One file's evidence: names are the spec's synthetic ones; no digest or content. */
type FileEvidence = Readonly<{ name: string; expectedBytes: number; guestDigestsPrinted: number; checkpointBytes: readonly number[];
  checkpointReady: boolean; downloads: DownloadEvidence[] }>;

/**
 * Verifies a scenario's files: the run's checkpoints, its Workspace outputs
 * and their downloads through `/api/attachments/[id]/content`, the route the
 * answer's file links use (`components/app-shell/workspaceClient.ts`).
 */
async function verifyOutputs(stand: Stand, turn: Turn, files: readonly ExpectedFile[], options: Readonly<{ oneCheckpoint: boolean }>): Promise<void> {
  stand.step = "verify";
  const { run, calls } = turn;
  const forbidden = forbiddenCodesIn(calls);
  stand.summary.forbiddenCodes = forbidden;

  const checkpoints = await runCheckpoints(run.id);
  const checkpointCalls = calls.filter((call) => call.toolName === "checkpoint_outputs");
  stand.summary.checkpoints = checkpoints.map((checkpoint) => {
    const call = checkpointCalls.find((row) => row.id === checkpoint.toolCallId);
    return { state: checkpoint.state, failureCode: checkpoint.failureCode ? safeCode(checkpoint.failureCode) : null,
      files: checkpoint.files.length, bytes: checkpoint.files.reduce((sum, file) => sum + file.attachment.byteSize, 0),
      callMs: call?.startedAt && call.completedAt ? call.completedAt.getTime() - call.startedAt.getTime() : null };
  });

  const settled = checkpoints.filter((checkpoint) => checkpoint.state === "SETTLED");
  const together = settled.some((checkpoint) =>
    files.every((file) => checkpoint.files.some((row) => baseName(row.relativePath) === file.name)));
  stand.summary.savedTogether = together;

  const guest = guestDigests(calls);
  const outputs = await db().attachment.findMany({ orderBy: { createdAt: "asc" },
    where: { producerModelRunId: run.id, origin: "WORKSPACE_OUTPUT", fileName: { in: files.map((file) => file.name) } },
    select: { id: true, fileName: true, byteSize: true, checksum: true, workspaceCheckpointFile: { select: { checkpointId: true } },
      workspaceRunOutput: { select: { id: true } } } });

  // All evidence first, so a failure still leaves the whole summary; the assertions follow.
  stand.step = "download";
  const evidence: FileEvidence[] = [];
  stand.summary.files = evidence;
  for (const file of files) {
    const checkpointed = settled.flatMap((checkpoint) => checkpoint.files.filter((row) => baseName(row.relativePath) === file.name));
    const printed = guest.get(file.name) ?? new Set<string>();
    const downloads: DownloadEvidence[] = [];
    evidence.push({ name: file.name, expectedBytes: file.bytes, guestDigestsPrinted: printed.size,
      checkpointBytes: checkpointed.map((row) => row.attachment.byteSize),
      checkpointReady: checkpointed.every((row) => row.attachment.origin === "WORKSPACE_OUTPUT" &&
        row.attachment.producerModelRunId === run.id && row.attachment.status === "ready"), downloads });
    for (const output of outputs.filter((row) => row.fileName === file.name)) {
      const started = Date.now();
      const response = await stand.page.request.get(`/api/attachments/${encodeURIComponent(output.id)}/content`, { timeout: DOWNLOAD_TIMEOUT_MS });
      const body = response.ok() ? await response.body() : Buffer.alloc(0);
      const digest = sha256Hex(body);
      downloads.push({ source: output.workspaceCheckpointFile ? "checkpoint" : output.workspaceRunOutput ? "run_output" : "other",
        status: response.status(), bytes: body.length, ms: Date.now() - started, sizeMatches: body.length === file.bytes,
        storedMatches: output.byteSize === file.bytes && output.checksum === digest, guestMatches: printed.has(digest) });
    }
  }

  stand.step = "assert";
  expect(forbidden, "no tool result of the run carries a capture, export or stream failure").toEqual([]);
  for (const file of evidence) {
    expect(file.guestDigestsPrinted, `the guest printed the sha256 of ${file.name}`).toBeGreaterThan(0);
    expect(file.checkpointBytes.length, `a settled checkpoint of the run holds ${file.name}`).toBeGreaterThan(0);
    expect(file.checkpointBytes.every((bytes) => bytes === file.expectedBytes), `${file.name} is checkpointed at its exact size`).toBe(true);
    expect(file.checkpointReady, `${file.name} is a ready Workspace output of this run`).toBe(true);
    expect(file.downloads.some((download) => download.source === "checkpoint"), `${file.name} downloads from its checkpoint`).toBe(true);
    for (const download of file.downloads) {
      expect(download.status, `${file.name} downloads (${download.source})`).toBe(200);
      expect(download.sizeMatches, `${file.name} downloads with its exact size (${download.source})`).toBe(true);
      expect(download.storedMatches, `${file.name} downloads with its stored checksum (${download.source})`).toBe(true);
      expect(download.guestMatches, `${file.name} downloads with the sha256 the guest printed (${download.source})`).toBe(true);
    }
  }
  if (options.oneCheckpoint) expect(together, "one checkpoint holds every file").toBe(true);
}

// ------------------------------------------------------------ Scenarios ---

test("three-sizes: 20, 40 and 64 MiB outputs checkpoint and download intact", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  const files: ExpectedFile[] = [{ name: "wlo-20m.bin", bytes: 20 * MIB }, { name: "wlo-40m.bin", bytes: 40 * MIB },
    { name: "wlo-64m.bin", bytes: 64 * MIB }];
  await withScenario(page, testInfo, "three-sizes", async (stand) => {
    await startChat(stand);
    const turn = await sendTurn(stand, "В папке результатов этого ответа создай командами shell три файла из случайных байтов: " +
      "wlo-20m.bin ровно 20 MiB, wlo-40m.bin ровно 40 MiB и wlo-64m.bin ровно 64 MiB (например, head -c 20M /dev/urandom > wlo-20m.bin). " +
      "Выведи их sha256 командой sha256sum и сохрани все три файла как файлы ответа, чтобы я мог их скачать. Содержимое файлов не читай.");
    await verifyOutputs(stand, turn, files, { oneCheckpoint: false });
  });
});

test("two-in-one-call: two 30 MiB outputs saved together checkpoint and download intact", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  const files: ExpectedFile[] = [{ name: "wlo-a-30m.bin", bytes: 30 * MIB }, { name: "wlo-b-30m.bin", bytes: 30 * MIB }];
  await withScenario(page, testInfo, "two-in-one-call", async (stand) => {
    await startChat(stand);
    const turn = await sendTurn(stand, "В папке результатов этого ответа создай командами shell два файла из случайных байтов " +
      "по 30 MiB каждый: wlo-a-30m.bin и wlo-b-30m.bin (например, head -c 30M /dev/urandom > wlo-a-30m.bin). " +
      "Выведи их sha256 командой sha256sum и сохрани оба файла как файлы ответа одним сохранением, вместе, чтобы я мог их скачать. " +
      "Содержимое файлов не читай.");
    await verifyOutputs(stand, turn, files, { oneCheckpoint: true });
  });
});
