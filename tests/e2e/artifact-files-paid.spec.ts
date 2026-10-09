/**
 * Opt-in, paid, bounded browser checks of files turned into artifacts from
 * chat, with a real tool-capable model and a real KVM Workspace on a
 * DISPOSABLE stand (Workspace runner, docling/tika parsers). Never a default
 * lane: it runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE,
 * AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE, CODEX_LB_API_KEY and CODEX_LB_BASE_URL
 * (the Codex root ending in `/backend-api/codex`); AIQSA_FEATURES_CODEX_MODEL
 * picks the codex-lb model (default as `setupCodexLbAnswerModel`). The
 * `large-html` scenario also needs the operator's private large self-contained
 * page (AIQSA_AFC_LARGE_HTML, or the single `.html` file in
 * AIQSA_AFC_PRIVATE_DIR); it is read in place and uploaded to the
 * stand only, never copied, and skipped when absent. The scenarios run
 * serially and one failure skips the rest; AIQSA_AFC_PAID_SERIAL=0 runs each
 * on its own. Every scenario is its own test, so `--grep <scenario>` runs a
 * subset.
 *
 * Each scenario opens a fresh chat on the codex-lb model with Workspace on and
 * MCP, Skills, Search and Memory recall off, attaches synthetic files
 * (artifactFileFixtures.ts) through the composer's file input, and sends one
 * short request as a user would write it. Oracles are the persisted run, its
 * tool calls and Workspace outputs, the artifact version's manifest, blobs and
 * ZIP export, and the artifact as the chat panel shows it; never the model's
 * wording. Content checks compare in the test and assert booleans, so a
 * failure prints no file content, prompt or answer. One sanitized JSON summary
 * per scenario (codes, booleans, counts, sizes, durations) is printed and
 * attached. Chats and artifacts are removed afterwards, and the account's chat
 * defaults restored; the codex-lb connection stays on the stand like the other
 * paid specs' connections. `public-and-zip` uses no model.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { PrismaClient, type ModelRun, type ModelRunStatus, type Prisma } from "@prisma/client";
import { expect, test, type Page, type Response as PageResponse, type TestInfo } from "@playwright/test";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { selectModel } from "./shell/composer";
import {
  animatedGif,
  deckPptx,
  largeVideoWebm,
  multiModuleSiteZip,
  multiPageSiteZip,
  recordShortVideo,
  reportDocx,
  salesWorkbookXlsx,
  samplePdf,
  VIDEO_UPLOAD_LIMIT_BYTES,
  type FileFixture
} from "./support/artifactFileFixtures";
import {
  ARTIFACT_FRAME,
  artifactErrorBanner,
  artifactFrame,
  changedFraction,
  clipCapture,
  containsMarker,
  createArtifactFromUploads,
  exportedArtifactFiles,
  firstNonUniform,
  firstReachableButton,
  htmlVisibleText,
  isPdf,
  largestCanvas,
  largestCanvasBox,
  luminanceStdDev,
  NON_UNIFORM_STDDEV,
  pdfPageCount,
  publicContentPath,
  publishVersion,
  regionTotalsEvidence,
  removeArtifact,
  safeCode,
  sameFiles,
  sha256Hex,
  uploadAttachment,
  zipFiles,
  privateLargeHtmlPath,
  type Box
} from "./support/artifactFilesStand";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { authenticateWithLocalToken } from "./support/localAuth";
import { paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { disableMemoryRecall, lastAnswer, setWorkspaceEnabled } from "./support/workspace";

const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));
const workspaceLive = process.env.AIQSA_WORKSPACE_LIVE_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.skip(!workspaceLive, "requires an explicitly disposable KVM Microsandbox topology (AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE)");
test.describe.configure({ mode: paidEnv("AIQSA_AFC_PAID_SERIAL") === "0" ? "default" : "serial" });

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const WARMUP_TIMEOUT_MS = 300_000;
/** A Workspace turn (LibreOffice, ffmpeg, esbuild) may take several minutes. */
const TURN_TIMEOUT_MS = 25 * 60_000;
const SEND_READY_TIMEOUT_MS = 10 * 60_000;
const SCENARIO_TIMEOUT_MS = 45 * 60_000;
const ACTIVE_RUN_STATUSES: ModelRunStatus[] = ["preparing", "queued", "streaming", "in_progress"];
const ARTIFACT_TOOL = "create_artifact";
const MAX_REFERENCE_ARGUMENT_BYTES = 64 * 1024;

/** One codex-lb connection for the whole file. */
let answerModel: PaidAnswerModel | null = null;

type Stand = {
  readonly page: Page;
  readonly testInfo: TestInfo;
  readonly scenario: string;
  model: PaidAnswerModel | null;
  readonly chatIds: Set<string>;
  readonly artifactIds: Set<string>;
  readonly summary: Record<string, unknown>;
  shots: number;
  step: string;
};

function failureCode(error: unknown): string {
  return error instanceof Error && /^afc_[a-z0-9_]+$/u.test(error.message) ? error.message : "assertion_or_timeout";
}

/**
 * Runs one scenario as the local administrator: snapshots the account's chat
 * defaults, turns Memory recall off, prepares the codex-lb model, and always
 * prints the sanitized summary and removes the scenario's chats and artifacts.
 */
async function withScenario(page: Page, testInfo: TestInfo, scenario: string, body: (stand: Stand) => Promise<void>,
  options: Readonly<{ model?: boolean }> = {}): Promise<void> {
  const stand: Stand = { page, testInfo, scenario, model: null, chatIds: new Set(), artifactIds: new Set(),
    summary: { scenario }, shots: 0, step: "setup" };
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(db(), userId);
    await disableMemoryRecall(page);
    if (options.model !== false) {
      answerModel ??= await setupCodexLbAnswerModel(page.request, {
        label: "Artifact files", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
      });
      stand.model = answerModel;
      stand.summary.answerModel = answerModel.upstreamModelId;
    }
    await body(stand);
    stand.summary.passed = true;
  } catch (error) {
    Object.assign(stand.summary, { passed: false, failedStep: stand.step, failure: failureCode(error) });
    throw error;
  } finally {
    await testInfo.attach(`${scenario}-summary.json`, { body: JSON.stringify(stand.summary, null, 2), contentType: "application/json" });
    console.log(`artifact_files_paid_summary ${JSON.stringify(stand.summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    const owned = stand.chatIds.size ? await db().artifact.findMany({ select: { id: true },
      where: { sourceChatId: { in: [...stand.chatIds] } } }).catch(() => []) : [];
    for (const artifactId of new Set([...stand.artifactIds, ...owned.map((row) => row.id)])) {
      await removeArtifact(page.request, artifactId).catch(() => undefined);
    }
    for (const chatId of stand.chatIds) {
      const active = await db().modelRun.findMany({ select: { id: true },
        where: { chatId, status: { in: ACTIVE_RUN_STATUSES } } }).catch(() => []);
      for (const run of active) await page.request.post(`/api/model-runs/${run.id}/cancel`).catch(() => undefined);
      await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    }
    await restoreDefaults?.().catch(() => undefined);
  }
}

async function shot(stand: Stand, label: string): Promise<void> {
  stand.shots += 1;
  await stand.page.screenshot({ path: stand.testInfo.outputPath(`${stand.scenario}-${String(stand.shots).padStart(2, "0")}-${label}.png`) });
}

// ------------------------------------------------------------- Composer ---

/** A fresh chat on the codex-lb model: Workspace on; MCP, Skills, Search and Memory recall off. */
async function startChat(stand: Stand): Promise<void> {
  stand.step = "start_chat";
  const { page } = stand;
  await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 60_000 });
  await selectModel(page, stand.model!.connectionId, stand.model!.displayName);
  await expect(page.getByTestId("header-model-trigger")).toContainText(stand.model!.displayName);
  await turnComposerToolsOff(page);
  await setWorkspaceEnabled(page, true);
}

type ComposerFile = Readonly<{ fileName: string; mimeType: string; bytes?: Buffer; path?: string }>;

const composerFile = (fixture: FileFixture<unknown>): ComposerFile =>
  ({ fileName: fixture.fileName, mimeType: fixture.mimeType, bytes: fixture.bytes });

/**
 * Attaches through the composer's file input (a file on disk by its path, a
 * synthetic one by its bytes) and waits until each upload has settled into
 * the tray. Files over the chat upload limit take the Workspace upload path.
 */
async function attach(stand: Stand, files: readonly ComposerFile[]): Promise<void> {
  stand.step = "attach";
  const { page } = stand;
  const started = Date.now();
  const input = page.getByLabel("Attach files");
  if (files.every((file) => file.path)) await input.setInputFiles(files.map((file) => file.path!));
  else await input.setInputFiles(files.map((file) => ({ name: file.fileName, mimeType: file.mimeType, buffer: file.bytes! })));
  const tray = page.getByRole("region", { name: "Attachments" });
  const states = (stand.summary.attachmentStates ??= []) as string[];
  for (const file of files) {
    const chip = tray.getByRole("listitem").filter({ hasText: file.fileName }).last();
    await expect(chip, "the file enters the composer").toBeVisible({ timeout: 120_000 });
    // A Workspace upload's progress row gives way to the stored attachment; poll until one has settled.
    const state = async () => (await chip.getAttribute("data-attachment-status", { timeout: 5_000 }).catch(() => null)) ?? "missing";
    await expect.poll(state, { message: "the upload settles", timeout: SEND_READY_TIMEOUT_MS }).toMatch(/^(ready|processing|failed|rejected)$/u);
    const status = await state();
    states.push(status);
    expect(status, "the composer keeps the file").not.toBe("rejected");
  }
  stand.summary.uploadMs = Date.now() - started;
}

type ToolCallRow = Readonly<{ id: string; toolName: string; state: string; arguments: Prisma.JsonValue; result: Prisma.JsonValue | null }>;
type Turn = Readonly<{ chatId: string; run: ModelRun; calls: readonly ToolCallRow[]; runMs: number }>;

/** Tool names as product names only: Workspace tools by their sandbox verb, anything else as "other". */
function toolLabel(name: string): string {
  if ([ARTIFACT_TOOL, "read_artifact", "checkpoint_outputs"].includes(name)) return name;
  const workspace = /sandbox_[a-z_]+/u.exec(name)?.[0];
  return workspace ? `workspace:${workspace}` : "other";
}

/** The first stable artifact error code in a persisted tool result. */
function artifactErrorCode(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = artifactErrorCode(item);
      if (code) return code;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "error" && typeof item === "string" && /^artifact_[a-z0-9_]+$/u.test(item)) return item;
    const code = artifactErrorCode(item);
    if (code) return code;
  }
  return null;
}

const argumentBytes = (value: Prisma.JsonValue): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");

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
    if (!ready) {
      // The disabled button's title is the composer's own reason, a fixed UI sentence.
      stand.summary.sendBlockedReason = (await send.getAttribute("title").catch(() => null))?.slice(0, 160) ?? null;
      throw new Error("afc_send_blocked");
    }
    const admitted = page.waitForResponse((value) => value.request().method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(value.url()).pathname), { timeout: 180_000 });
    await composer.press("Enter");
    const response = await admitted;
    if (response.ok()) return response;
    const code = safeCode((await response.json().catch(() => null) as { error?: unknown } | null)?.error);
    if (response.status() !== 409 || code !== "workspace_busy" || attempt >= 2) throw new Error(`afc_admission_${response.status()}_${code}`);
    await expect(composer).toHaveValue(text);
    await page.waitForTimeout(15_000);
  }
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
  }, "afc_run_timeout");
  const runMs = Date.now() - started;
  // A run that used the guest exports its outputs; an unused binding only retires. Either way the session is free after.
  const exportState = await pollUntil(300_000, async () => {
    const binding = await db().workspaceRunBinding.findUnique({ where: { modelRunId: run.id }, select: { exportState: true,
      _count: { select: { selectedCaptures: true, toolCalls: true } }, workspaceSession: { select: { operationOwner: true } } } });
    if (!binding) return "none";
    if (binding.workspaceSession.operationOwner !== null) return null;
    if (binding.exportState === "COMPLETE" || binding.exportState === "FAILED") return binding.exportState;
    return binding._count.toolCalls === 0 && binding._count.selectedCaptures === 0 ? "unused" : null;
  }, "afc_workspace_export_timeout");
  const calls = await db().modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { arguments: true, id: true, result: true, state: true, toolName: true }, where: { modelRunId: run.id } });
  const tools: Record<string, Record<string, number>> = {};
  for (const call of calls) {
    const counts = tools[toolLabel(call.toolName)] ??= {};
    counts[call.state] = (counts[call.state] ?? 0) + 1;
  }
  const artifactCalls = calls.filter((call) => call.toolName === ARTIFACT_TOOL);
  const turns = (stand.summary.turns ??= []) as Record<string, unknown>[];
  turns.push({ runStatus: run.status, runErrorCode: safeCode((run.errorPayload as { code?: unknown } | null)?.code ?? null),
    runMs, workspaceExport: exportState, tools, artifactErrorCodes: artifactCalls.map((call) => artifactErrorCode(call.result)),
    artifactArgumentBytesMax: Math.max(0, ...artifactCalls.map((call) => argumentBytes(call.arguments))) });
  expect(run.status, "the run completes").toBe("complete");
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return { chatId, run, calls, runMs };
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await db().message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

// ------------------------------------------------------------ Artifacts ---

type ManifestFile = Readonly<{ path: string; mimeType: string; byteSize: number; group?: string }>;
type CallFile = Readonly<{ path?: unknown; mimeType?: unknown; asset_ref?: unknown; text?: unknown; unpack?: unknown }>;
type FileSource = "upload" | "workspace" | "inline" | "vendored" | "unlisted" | "other";

type Bundle = Readonly<{
  artifactId: string;
  versionId: string;
  versionNumber: number;
  title: string;
  entrypoint: string | null;
  manifest: readonly ManifestFile[];
  /** Stored blob checksum per path (referenced, produced, edited and vendored files). */
  blobs: ReadonlyMap<string, string>;
  /** The owner's ZIP export: source files, HTML re-serialized by the exporter. */
  files: ReadonlyMap<string, Buffer>;
  zip: Buffer;
  /** The `create_artifact` call that made this version. */
  callFiles: readonly CallFile[];
  callEdits: number;
  callArgumentBytes: number;
  uploads: ReadonlyMap<string, Readonly<{ checksum: string | null; mimeType: string }>>;
  outputs: ReadonlyMap<string, Readonly<{ checksum: string | null; mimeType: string; fileName: string; byteSize: number }>>;
}>;

async function runVersions(runId: string) {
  return db().artifactVersion.findMany({ orderBy: { createdAt: "asc" }, where: { sourceModelRunId: runId, status: "READY" },
    select: { id: true, artifactId: true, versionNumber: true, title: true, entrypoint: true, manifest: true, sourceToolCallId: true,
      artifact: { select: { sourceChatId: true } }, blobs: { select: { path: true, blob: { select: { sha256: true } } } } } });
}

type RunVersion = Awaited<ReturnType<typeof runVersions>>[number];

function manifestFiles(manifest: Prisma.JsonValue): ManifestFile[] {
  const files = (manifest as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? files.filter((file): file is ManifestFile => !!file && typeof file === "object" &&
    typeof (file as ManifestFile).path === "string" && typeof (file as ManifestFile).mimeType === "string") : [];
}

async function loadBundle(stand: Stand, version: RunVersion, turn: Turn): Promise<Bundle> {
  stand.step = "artifact_export";
  const { files, zip } = await exportedArtifactFiles(stand.page.request, version.artifactId, version.id);
  const call = version.sourceToolCallId
    ? await db().modelRunToolCall.findUnique({ select: { arguments: true }, where: { id: version.sourceToolCallId } }) : null;
  const args = (call?.arguments ?? {}) as { files?: unknown; edits?: unknown };
  const uploads = await db().attachment.findMany({ select: { id: true, checksum: true, mimeType: true },
    where: { chatId: turn.chatId, origin: "USER_UPLOAD" } });
  const outputs = await db().attachment.findMany({ select: { id: true, checksum: true, mimeType: true, fileName: true, byteSize: true },
    where: { producerModelRunId: turn.run.id, origin: "WORKSPACE_OUTPUT" } });
  return {
    artifactId: version.artifactId, versionId: version.id, versionNumber: version.versionNumber, title: version.title,
    entrypoint: version.entrypoint, manifest: manifestFiles(version.manifest),
    blobs: new Map(version.blobs.map((row) => [row.path, row.blob.sha256])), files, zip,
    callFiles: Array.isArray(args.files) ? args.files as CallFile[] : [], callEdits: Array.isArray(args.edits) ? args.edits.length : 0,
    callArgumentBytes: argumentBytes(call?.arguments ?? null),
    uploads: new Map(uploads.map((row) => [row.id, { checksum: row.checksum, mimeType: row.mimeType }])),
    outputs: new Map(outputs.map((row) => [row.id, { checksum: row.checksum, mimeType: row.mimeType, fileName: row.fileName, byteSize: row.byteSize }]))
  };
}

/** The run's last ready version: the artifact it leaves the user with. */
async function latestBundle(stand: Stand, turn: Turn): Promise<Bundle> {
  stand.step = "artifact";
  const versions = await runVersions(turn.run.id);
  stand.summary.versionsCreated = versions.length;
  expect(versions.length, "the run created an artifact version").toBeGreaterThan(0);
  const version = versions.at(-1)!;
  expect(version.artifact.sourceChatId === turn.chatId, "the artifact belongs to this chat").toBe(true);
  const bundle = await loadBundle(stand, version, turn);
  Object.assign(stand.summary, { bundleFiles: bundle.manifest.filter((file) => file.group !== "vendored").length,
    vendoredFiles: bundle.manifest.filter((file) => file.group === "vendored").length,
    bundleBytes: bundle.manifest.reduce((sum, file) => sum + (file.byteSize ?? 0), 0), workspaceOutputs: bundle.outputs.size,
    createArgumentBytes: bundle.callArgumentBytes, sources: sourceCounts(bundle) });
  return bundle;
}

/** Where a bundle file came from, by the creating call's reference to it. */
function sourceOf(bundle: Bundle, path: string): FileSource {
  if (bundle.manifest.find((file) => file.path === path)?.group === "vendored") return "vendored";
  const entry = bundle.callFiles.find((file) => file.path === path);
  if (!entry) return "unlisted";
  if (typeof entry.asset_ref === "string") {
    if (bundle.outputs.has(entry.asset_ref)) return "workspace";
    return bundle.uploads.has(entry.asset_ref) ? "upload" : "other";
  }
  return typeof entry.text === "string" ? "inline" : "other";
}

function sourceCounts(bundle: Bundle): Record<FileSource, number> {
  const counts: Record<FileSource, number> = { upload: 0, workspace: 0, inline: 0, vendored: 0, unlisted: 0, other: 0 };
  for (const file of bundle.manifest) counts[sourceOf(bundle, file.path)] += 1;
  return counts;
}

/** Whether the bundle holds `bytes` exactly: in its export (binary files) or as a stored blob (any file). */
function holdsBytes(bundle: Bundle, bytes: Buffer): Readonly<{ export: boolean; blob: boolean }> {
  const sha = sha256Hex(bytes);
  return { export: [...bundle.files.values()].some((file) => file.length === bytes.length && file.equals(bytes)),
    blob: [...bundle.blobs.values()].includes(sha) };
}

function forbiddenMarkersFound(bundle: Bundle, markers: readonly string[]): number {
  return markers.filter((marker) => [...bundle.files.values()].some((bytes) => containsMarker(bytes, marker))).length;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbookInBundle(bundle: Bundle, fixture: FileFixture<unknown>): boolean {
  const held = holdsBytes(bundle, fixture.bytes);
  return held.export || held.blob || bundle.manifest.some((file) => file.mimeType === XLSX_MIME || /\.xlsx$/iu.test(file.path));
}

// --------------------------------------------------------------- Viewer ---

/** Opens the version from its card in the answer and waits for the panel's frame; returns when the frame attached. */
async function openInChat(stand: Stand, bundle: Pick<Bundle, "title" | "versionNumber">): Promise<number> {
  stand.step = "viewer";
  const { page } = stand;
  const card = page.getByRole("button", { name: `Open artifact: ${bundle.title}`, exact: true }).last();
  await expect(card, "the answer shows the artifact card").toBeVisible({ timeout: 120_000 });
  await card.click();
  const panel = page.locator("[data-artifact-panel]");
  await expect(panel.getByRole("button", { name: `Version v${bundle.versionNumber}`, exact: true }),
    "the panel shows this version").toBeVisible({ timeout: 120_000 });
  const frame = panel.locator(ARTIFACT_FRAME);
  await frame.waitFor({ state: "attached", timeout: 300_000 });
  const attachedAt = Date.now();
  await expect(frame).toBeVisible({ timeout: 60_000 });
  return attachedAt;
}

async function closePanel(page: Page): Promise<void> {
  const close = page.locator("[data-artifact-panel]").getByRole("button", { name: "Close artifact", exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
}

/** No runtime-error, blocked-resource or load-failure banner after the page had time to run. */
async function expectNoArtifactError(stand: Stand, settleMs = 3_000): Promise<void> {
  await stand.page.waitForTimeout(settleMs);
  const banner = await artifactErrorBanner(stand.page).count();
  stand.summary.errorBanner = banner > 0;
  expect(banner, "the viewer shows no artifact error").toBe(0);
}

/** Opens the version, waits for its page to run and records a screenshot; the page must report no error. */
async function viewArtifact(stand: Stand, bundle: Bundle, label: string): Promise<void> {
  await openInChat(stand, bundle);
  await expectNoArtifactError(stand, 5_000);
  await shot(stand, label);
}

/** Content Security Policy messages the artifact's documents (srcdoc frames) and their blob: scripts log; the app's own are not counted. */
function watchCspConsole(page: Page): () => number {
  let count = 0;
  page.on("console", (message) => {
    const source = message.location().url;
    if ((source === "about:srcdoc" || source.startsWith("blob:")) && /Content[- ]Security[- ]Policy|Refused to /iu.test(message.text())) count += 1;
  });
  return () => count;
}

async function exitFullscreen(page: Page): Promise<void> {
  await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined).catch(() => undefined);
  await artifactFrame(page).locator("body").evaluate(() => {
    if (document.pointerLockElement) document.exitPointerLock();
    return document.fullscreenElement ? document.exitFullscreen() : undefined;
  }).catch(() => undefined);
}

/** Drags across the scene; falls back to holding the arrow keys. Returns which input changed the view. */
async function interactWithScene(page: Page, box: Box): Promise<"drag" | "keys" | "none"> {
  const before = await clipCapture(page, box);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.min(180, box.width / 3), y + Math.min(40, box.height / 6), { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(1_500);
  if (changedFraction(before, await clipCapture(page, box)) > 0.005) return "drag";
  const stillBefore = await clipCapture(page, box);
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1_200);
  await page.keyboard.up("ArrowRight");
  await page.waitForTimeout(800);
  return changedFraction(stillBefore, await clipCapture(page, box)) > 0.005 ? "keys" : "none";
}

/** The artifact's largest canvas, failing when the page has none. */
async function sceneBox(page: Page): Promise<Box> {
  const box = await largestCanvasBox(page);
  expect(box !== null && box.width > 0 && box.height > 0, "the artifact has a laid-out canvas").toBe(true);
  return box!;
}

// ------------------------------------------------------------ Office files ---

type ContentFile = Readonly<{ path: string; kind: "html" | "pdf"; workspace: boolean; text: string; pages: number }>;

/** HTML and PDF files of the bundle, with where they came from; text is compared here and never printed. */
function contentFiles(bundle: Bundle): ContentFile[] {
  const result: ContentFile[] = [];
  for (const file of bundle.manifest) {
    if (file.group === "vendored") continue;
    const bytes = bundle.files.get(file.path);
    if (!bytes) continue;
    const workspace = sourceOf(bundle, file.path) === "workspace";
    if (file.mimeType === "text/html") result.push({ path: file.path, kind: "html", workspace, text: htmlVisibleText(bytes.toString("utf8")), pages: 0 });
    else if (file.mimeType === "application/pdf" || isPdf(bytes)) result.push({ path: file.path, kind: "pdf", workspace, text: "", pages: pdfPageCount(bytes) });
  }
  return result;
}

const includesFolded = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

/**
 * A converted office document: some HTML made in the Workspace holds all
 * phrases (across its files), or a PDF made in the Workspace has the expected
 * page count. PDF text is glyph-encoded by LibreOffice, so its words are not
 * searched; the page count is the PDF oracle.
 */
function officeView(stand: Stand, bundle: Bundle, phrases: readonly string[], pdfPages: number): void {
  const files = contentFiles(bundle);
  const html = files.filter((file) => file.kind === "html" && file.workspace);
  const pdf = files.filter((file) => file.kind === "pdf" && file.workspace);
  const htmlText = html.map((file) => file.text).join("\n");
  const phrasesFound = phrases.filter((phrase) => includesFolded(htmlText, phrase)).length;
  const pdfMatches = pdf.some((file) => file.pages === pdfPages);
  Object.assign(stand.summary, { workspaceHtmlFiles: html.length, workspacePdfFiles: pdf.length, phrasesFound, phrases: phrases.length,
    pdfPages: pdf.map((file) => file.pages), contentFormat: phrasesFound === phrases.length ? "html" : pdfMatches ? "pdf" : null });
  expect(html.length + pdf.length, "the artifact shows an HTML or PDF made in the Workspace").toBeGreaterThan(0);
  expect(phrasesFound === phrases.length || pdfMatches, "the converted document carries the original content").toBe(true);
}

// ------------------------------------------------------------- Scenarios ---

/** The document without its `<title>` element and the whitespace around it. */
const withoutTitle = (html: string) => html.replace(/\s*<title\b[^>]*>[\s\S]*?<\/title\s*>\s*/iu, "");
const titleText = (html: string) => /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html)?.[1] ?? "";

test("large-html: the operator's page becomes an artifact unchanged, renders and rotates; a title edit is a new blob version", async ({ page }, testInfo) => {
  const path = privateLargeHtmlPath();
  test.skip(!path, "requires the operator's private large page (AIQSA_AFC_LARGE_HTML or AIQSA_AFC_PRIVATE_DIR)");
  test.setTimeout(75 * 60_000);
  await withScenario(page, testInfo, "large-html", async (stand) => {
    const bytes = readFileSync(path!);
    const fileSha = sha256Hex(bytes);
    stand.summary.fileBytes = bytes.length;
    const cspMessages = watchCspConsole(page);
    await startChat(stand);
    await attach(stand, [{ fileName: basename(path!), mimeType: "text/html", path: path! }]);
    const first = await sendTurn(stand, "Сделай из этого файла артефакт");

    stand.step = "original_version";
    const upload = await db().attachment.findFirst({ select: { checksum: true },
      where: { chatId: first.chatId, origin: "USER_UPLOAD", fileName: basename(path!) } });
    expect(upload?.checksum === fileSha, "the stored upload is the exact file").toBe(true);
    const versions = await runVersions(first.run.id);
    stand.summary.versionsCreated = versions.length;
    expect(versions.length, "the run created one artifact version").toBe(1);
    const original = versions[0]!;
    expect(original.artifact.sourceChatId === first.chatId, "the artifact belongs to this chat").toBe(true);
    const entry = original.entrypoint ?? "";
    expect(original.blobs.find((row) => row.path === entry)?.blob.sha256 === fileSha,
      "the entry page is stored as exactly the uploaded bytes").toBe(true);
    const bundle = await loadBundle(stand, original, first);
    Object.assign(stand.summary, { entrySource: sourceOf(bundle, entry), createArgumentBytes: bundle.callArgumentBytes, createEdits: bundle.callEdits });
    expect(sourceOf(bundle, entry), "the entry page is the uploaded file by reference").toBe("upload");
    expect(bundle.callArgumentBytes, "the file was referenced, not reprinted").toBeLessThan(MAX_REFERENCE_ARGUMENT_BYTES);
    const originalEntry = bundle.files.get(entry);
    expect(originalEntry !== undefined, "the export holds the entry page").toBe(true);

    stand.step = "scene";
    const attachedAt = await openInChat(stand, bundle);
    const firstFrame = await firstNonUniform(page, () => largestCanvasBox(page), attachedAt, 240_000);
    stand.summary.firstNonUniformMs = firstFrame?.ms ?? null;
    expect(firstFrame !== null, "the scene draws within four minutes of the frame attaching").toBe(true);
    const box = await sceneBox(page);
    stand.summary.canvas = { width: Math.round(box.width), height: Math.round(box.height) };
    const early = luminanceStdDev(await clipCapture(page, box));
    await page.waitForTimeout(4_000);
    const late = luminanceStdDev(await clipCapture(page, box));
    stand.summary.sceneStdDev = [Number(early.toFixed(1)), Number(late.toFixed(1))];
    expect(early > NON_UNIFORM_STDDEV && late > NON_UNIFORM_STDDEV, "both captures a few seconds apart show the scene").toBe(true);
    // The drawn scene canvas already has its context: this returns it, or null for the Canvas 2D fallback.
    stand.summary.webgl2 = await (await largestCanvas(page))?.canvas
      .evaluate((canvas) => Boolean((canvas as HTMLCanvasElement).getContext("webgl2"))).catch(() => null) ?? null;
    await expectNoArtifactError(stand, 1_000);
    await shot(stand, "scene");
    const interaction = await interactWithScene(page, box);
    await exitFullscreen(page);
    stand.summary.interaction = interaction;
    expect(interaction, "dragging the scene (or its arrow keys) changes the view").not.toBe("none");
    await shot(stand, "after-drag");
    const button = await firstReachableButton(page);
    stand.summary.frameButton = button !== null;
    if (button) {
      await button.click({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
      const linkDialog = page.getByRole("dialog", { name: "Open external link?" });
      if (await linkDialog.isVisible().catch(() => false)) await linkDialog.getByRole("button", { name: "Cancel" }).click();
      await exitFullscreen(page);
    }
    await expectNoArtifactError(stand, 1_500);
    stand.summary.cspConsoleMessages = cspMessages();
    expect(cspMessages(), "the page triggers no Content Security Policy violation").toBe(0);
    await closePanel(page);

    stand.step = "title_edit";
    const second = await sendTurn(stand, "Поменяй заголовок страницы (title) на «Large Page AIQSA»");
    const edited = (await runVersions(second.run.id)).at(-1);
    expect(edited !== undefined, "the edit created a new version").toBe(true);
    expect(edited!.artifactId === original.artifactId && edited!.versionNumber > original.versionNumber,
      "the new version belongs to the same artifact").toBe(true);
    const editedEntry = edited!.entrypoint ?? "";
    const editedBlob = edited!.blobs.find((row) => row.path === editedEntry)?.blob.sha256;
    stand.summary.editedEntryIsBlob = editedBlob !== undefined;
    expect(editedBlob !== undefined && editedBlob !== fileSha, "the edited entry page is stored as a new blob").toBe(true);
    const kept = await db().artifactVersionBlob.findUnique({ select: { blob: { select: { sha256: true } } },
      where: { versionId_path: { versionId: original.id, path: entry } } });
    expect(kept?.blob.sha256 === fileSha, "the original version keeps the uploaded bytes").toBe(true);
    const editedBundle = await loadBundle(stand, edited!, second);
    const editCalls = second.calls.filter((call) => call.toolName === ARTIFACT_TOOL);
    Object.assign(stand.summary, { editUsedEdits: editedBundle.callEdits > 0, editArgumentBytes: editedBundle.callArgumentBytes,
      editCalls: editCalls.length });
    expect(editCalls.every((call) => argumentBytes(call.arguments) < MAX_REFERENCE_ARGUMENT_BYTES),
      "the edit did not send the page text").toBe(true);
    const editedText = editedBundle.files.get(editedEntry)?.toString("utf8") ?? "";
    const originalText = originalEntry!.toString("utf8");
    const onlyTitleChanged = withoutTitle(editedText) === withoutTitle(originalText);
    const titleSet = titleText(editedText).includes("Large Page AIQSA");
    Object.assign(stand.summary, { onlyTitleChanged, titleSet });
    expect(onlyTitleChanged, "the edit changed only the <title>").toBe(true);
    expect(titleSet, "the new <title> is set").toBe(true);

    const editedAttachedAt = await openInChat(stand, editedBundle);
    const editedFrame = await firstNonUniform(page, () => largestCanvasBox(page), editedAttachedAt, 240_000);
    stand.summary.editedFirstNonUniformMs = editedFrame?.ms ?? null;
    expect(editedFrame !== null, "the edited version still draws the scene").toBe(true);
    await expectNoArtifactError(stand, 2_000);
    await shot(stand, "edited-scene");
  });
});

test("xlsx-dashboard: a revenue dashboard uses Workspace JSON with the file's totals and never the workbook", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "xlsx-dashboard", async (stand) => {
    const fixture = salesWorkbookXlsx();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Сделай из этого файла артефакт: дашборд выручки по регионам");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const workbook = workbookInBundle(bundle, fixture);
    const totals = regionTotalsEvidence(bundle.files, fixture.expected.revenueByRegion);
    const json = [...bundle.outputs.values()].filter((file) => file.mimeType === "application/json" || /\.json$/iu.test(file.fileName));
    const jsonInBundle = bundle.manifest.some((file) => sourceOf(bundle, file.path) === "workspace" &&
      (file.mimeType === "application/json" || /\.json$/iu.test(file.path)));
    const leaked = forbiddenMarkersFound(bundle, fixture.expected.forbiddenMarkers);
    Object.assign(stand.summary, { workbookInBundle: workbook, regionTotalsFound: totals.found, totalsSource: totals.source,
      workspaceJsonOutputs: json.length, workspaceJsonInBundle: jsonInBundle, forbiddenMarkersFound: leaked });
    expect(workbook, "the workbook itself is not in the artifact").toBe(false);
    expect(totals.found, "the artifact's data reproduces every region's revenue total").toBe(totals.regions);
    expect(json.length, "the run produced a JSON file in the Workspace").toBeGreaterThan(0);
    expect(leaked, "no hidden-sheet, comment or metadata marker reaches the artifact").toBe(0);
    const files = lastAnswer(page).getByRole("region", { name: "Generated files" });
    const listed = async () => {
      const text = (await files.allTextContents().catch(() => [] as string[])).join("\n");
      return json.some((file) => text.includes(file.fileName));
    };
    let visible = await expect.poll(listed, { timeout: 60_000 }).toBe(true).then(() => true, () => false);
    if (!visible) {
      await page.reload();
      visible = await expect.poll(listed, { timeout: 60_000 }).toBe(true).then(() => true, () => false);
    }
    stand.summary.jsonListedInAnswer = visible;
    expect(visible, "the JSON is listed among the answer's files").toBe(true);
    await viewArtifact(stand, bundle, "dashboard");
  });
});

/** Visible-sheet values as Calc's `#,##0.00` writes them in common locales. */
function revenueSpellings(revenue: number): string[] {
  const fixed = revenue.toFixed(2);
  const [whole, cents] = fixed.split(".") as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return [fixed, String(revenue), `${grouped}.${cents}`, `${grouped.replaceAll(",", " ")},${cents}`,
    `${grouped.replaceAll(",", ".")},${cents}`];
}

test("xlsx-view: the workbook as is shows its visible sheet from a Workspace conversion, without hidden parts", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "xlsx-view", async (stand) => {
    const fixture = salesWorkbookXlsx();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Покажи этот xlsx как есть — артефактом");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const files = contentFiles(bundle);
    const html = files.filter((file) => file.kind === "html" && file.workspace);
    const pdf = files.filter((file) => file.kind === "pdf" && file.workspace);
    const htmlText = html.map((file) => file.text).join("\n");
    const htmlShowsSheet = htmlText.includes("North") && fixture.expected.rows.some((row) =>
      revenueSpellings(row.revenue).some((spelling) => htmlText.includes(spelling)));
    // Calc prints only visible sheets: one page for the twelve rows, a second one for a leaked hidden sheet.
    const pdfShowsSheet = pdf.some((file) => file.pages === 1);
    const leaked = forbiddenMarkersFound(bundle, fixture.expected.forbiddenMarkers);
    const workbook = workbookInBundle(bundle, fixture);
    Object.assign(stand.summary, { workspaceHtmlFiles: html.length, workspacePdfFiles: pdf.length, pdfPages: pdf.map((file) => file.pages),
      contentFormat: htmlShowsSheet ? "html" : pdfShowsSheet ? "pdf" : null, valuesChecked: htmlShowsSheet,
      forbiddenMarkersFound: leaked, workbookInBundle: workbook });
    expect(html.length + pdf.length, "the artifact shows an HTML or PDF made in the Workspace").toBeGreaterThan(0);
    expect(htmlShowsSheet || pdfShowsSheet, "the conversion shows the visible sheet").toBe(true);
    expect(leaked, "no hidden-sheet, comment or metadata marker reaches the artifact").toBe(0);
    expect(workbook, "the workbook itself is not in the artifact").toBe(false);
    await viewArtifact(stand, bundle, "workbook");
  });
});

test("docx-view: the document is shown through an HTML or PDF made with LibreOffice in the Workspace", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "docx-view", async (stand) => {
    const fixture = reportDocx();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Покажи этот документ артефактом");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    officeView(stand, bundle, fixture.expected.phrases, 1);
    await viewArtifact(stand, bundle, "document");
  });
});

test("pptx-view: the deck is shown through an HTML or PDF made with LibreOffice in the Workspace", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "pptx-view", async (stand) => {
    const fixture = deckPptx();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Покажи эту презентацию артефактом");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    officeView(stand, bundle, fixture.expected.slideTitles, fixture.expected.slideCount);
    await viewArtifact(stand, bundle, "deck");
  });
});

test("pdf-view: a viewer embeds the PDF as uploaded and draws a page", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "pdf-view", async (stand) => {
    const fixture = samplePdf(2);
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Сделай просмотрщик этого PDF");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const held = holdsBytes(bundle, fixture.bytes);
    Object.assign(stand.summary, { pdfInExport: held.export, pdfBlob: held.blob });
    expect(held.export, "the artifact holds the PDF bytes as uploaded").toBe(true);
    const attachedAt = await openInChat(stand, bundle);
    const drawn = await firstNonUniform(page, () => largestCanvasBox(page), attachedAt, 30_000);
    stand.summary.firstPageMs = drawn?.ms ?? null;
    expect(drawn !== null, "a page canvas is drawn within 30 s").toBe(true);
    await expectNoArtifactError(stand, 2_000);
    await shot(stand, "pdf");
  });
});

test("gif: the animated GIF is embedded as uploaded and shown at its natural size", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "gif", async (stand) => {
    const fixture = animatedGif();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Покажи эту гифку на странице");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const held = holdsBytes(bundle, fixture.bytes);
    Object.assign(stand.summary, { gifInExport: held.export, gifBlob: held.blob });
    expect(held.export, "the artifact holds the GIF bytes as uploaded").toBe(true);
    await openInChat(stand, bundle);
    const body = artifactFrame(page).locator("body");
    const rendering = async () => body.evaluate((element, width) => {
      if (Array.from(element.ownerDocument.images).some((image) => image.complete && image.naturalWidth === width)) return "img";
      if (Array.from(element.ownerDocument.querySelectorAll("*")).some((node) =>
        /url\("?(?:data:image\/gif|blob:)/u.test(getComputedStyle(node).backgroundImage))) return "background";
      return Array.from(element.ownerDocument.querySelectorAll("canvas")).some((canvas) => canvas.width > 0 && canvas.height > 0)
        ? "canvas" : "none";
    }, fixture.expected.width).catch(() => "none");
    await expect.poll(rendering, { message: "the GIF is shown", timeout: 30_000 }).not.toBe("none");
    stand.summary.rendering = await rendering();
    await expectNoArtifactError(stand, 2_000);
    await shot(stand, "gif");
  });
});

/** The first `<video>` of the artifact: metadata loaded and no media error. */
async function videoState(page: Page): Promise<Readonly<{ ready: number; error: number | null }> | null> {
  return artifactFrame(page).locator("video").first().evaluate((video: HTMLVideoElement) =>
    ({ ready: video.readyState, error: video.error?.code ?? null }), undefined, { timeout: 5_000 }).catch(() => null);
}

async function expectVideoPlays(stand: Stand): Promise<void> {
  await expect.poll(async () => {
    const state = await videoState(stand.page);
    return state !== null && state.ready >= 1 && state.error === null;
  }, { message: "the video loads its metadata without an error", timeout: 60_000 }).toBe(true);
  stand.summary.video = await videoState(stand.page);
}

test("short-video: a short video is embedded as uploaded and loads in the page", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "short-video", async (stand) => {
    const recorder = await page.context().newPage();
    await recorder.goto("about:blank");
    const fixture = await recordShortVideo(recorder, 3);
    await recorder.close();
    stand.summary.videoBytes = fixture.bytes.length;
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Сделай страницу с этим видео");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const held = holdsBytes(bundle, fixture.bytes);
    Object.assign(stand.summary, { videoInExport: held.export, videoBlob: held.blob });
    expect(held.export, "the artifact holds the video bytes as uploaded").toBe(true);
    await openInChat(stand, bundle);
    await expectVideoPlays(stand);
    await expectNoArtifactError(stand, 1_000);
    await shot(stand, "video");
  });
});

test("large-video: a video over 24 MiB is compressed in the Workspace into the artifact, or its size is reported", async ({ page }, testInfo) => {
  test.setTimeout(60 * 60_000);
  await withScenario(page, testInfo, "large-video", async (stand) => {
    const recorder = await page.context().newPage();
    await recorder.goto("about:blank");
    const fixture = await largeVideoWebm(recorder);
    await recorder.close();
    // A file path keeps the large synthetic recording out of the protocol message.
    const path = testInfo.outputPath(fixture.fileName);
    writeFileSync(path, fixture.bytes);
    stand.summary.videoBytes = fixture.bytes.length;
    await startChat(stand);
    await attach(stand, [{ fileName: fixture.fileName, mimeType: fixture.mimeType, path }]);
    const turn = await sendTurn(stand, "Сделай страницу с этим видео");
    stand.step = "oracles";
    const versions = await runVersions(turn.run.id);
    stand.summary.versionsCreated = versions.length;
    if (versions.length === 0) {
      // A coarse signal only: the answer names the 24 MiB limit somewhere.
      const text = await answerText(turn.run);
      Object.assign(stand.summary, { outcome: "reported", answerNonEmpty: text.trim().length > 0, reported_limit: /24/u.test(text) });
      expect(text.trim().length > 0, "the answer explains why no artifact was made").toBe(true);
      return;
    }
    const bundle = await latestBundle(stand, turn);
    const videos = bundle.manifest.filter((file) => file.mimeType.startsWith("video/"));
    const produced = videos.filter((file) => sourceOf(bundle, file.path) === "workspace" ||
      [...bundle.outputs.values()].some((output) => output.checksum !== null && output.checksum === bundle.blobs.get(file.path)));
    Object.assign(stand.summary, { outcome: "compressed", bundleVideos: videos.length, producedVideos: produced.length,
      videoBytesInBundle: videos.map((file) => file.byteSize) });
    expect(produced.length, "the artifact's video was produced by the run").toBeGreaterThan(0);
    expect(produced.every((file) => file.byteSize <= VIDEO_UPLOAD_LIMIT_BYTES), "the compressed video fits 24 MiB").toBe(true);
    await openInChat(stand, bundle);
    await expectVideoPlays(stand);
    await expectNoArtifactError(stand, 1_000);
    await shot(stand, "video");
  });
});

/** Authored bundle paths in the order `readZipArchive` returns them. */
const authoredPaths = (files: readonly ManifestFile[]) =>
  files.filter((file) => file.group !== "vendored").map((file) => file.path).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

/** The site's pages, local data, a script-set image, and links between its pages, in one viewer frame. */
async function expectSiteNavigation(page: Page, expected: ReturnType<typeof multiPageSiteZip>["expected"]): Promise<void> {
  const frame = artifactFrame(page);
  await expect(frame.locator("h1"), "the entry page opens").toHaveText(expected.headings["index.html"], { timeout: 60_000 });
  await expect(frame.locator("#data-value"), "fetch('data.json') reads the local file").toHaveText(expected.dataValue, { timeout: 30_000 });
  await expect(frame.locator("#img-width"), "img.src from a script loads the local image").toHaveText(String(expected.imageWidth), { timeout: 30_000 });
  await frame.locator("#about-link").click();
  await expect(frame.locator("h1"), "a relative link opens another page").toHaveText(expected.headings["about.html"], { timeout: 60_000 });
}

test("zip-site: a website ZIP becomes a multi-page artifact at its root, with local data, images and links", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "zip-site", async (stand) => {
    const fixture = multiPageSiteZip();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Опубликуй этот сайт как артефакт");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const paths = authoredPaths(bundle.manifest);
    Object.assign(stand.summary, { unpackUsed: bundle.callFiles.some((file) => file.unpack === true), paths: paths.length,
      entryIsIndex: bundle.entrypoint === fixture.expected.entry });
    expect(paths, "the archive's files land at the root, junk skipped").toEqual(fixture.expected.paths);
    expect(bundle.entrypoint, "index.html is the entry page").toBe(fixture.expected.entry);
    await openInChat(stand, bundle);
    stand.step = "navigation";
    await expectSiteNavigation(page, fixture.expected);
    const frame = artifactFrame(page);
    await shot(stand, "about");
    // The fixture's pages link back to the entry; the viewer has no history control of its own.
    await frame.locator("#home-link").click();
    await expect(frame.locator("h1"), "the about page links back home").toHaveText(fixture.expected.headings["index.html"], { timeout: 60_000 });
    await frame.locator("#guide-link").click();
    await expect(frame.locator("h1"), "a root-relative link opens a nested page").toHaveText(fixture.expected.headings["docs/guide.html"], { timeout: 60_000 });
    await expectNoArtifactError(stand, 1_000);
    await shot(stand, "guide");
  });
});

test("module-site: a site of several ES modules is built in the Workspace and its page computes the result", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "module-site", async (stand) => {
    const fixture = multiModuleSiteZip();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Сделай из этого сайта артефакт");
    const codes = turn.calls.filter((call) => call.toolName === ARTIFACT_TOOL).map((call) => artifactErrorCode(call.result));
    stand.summary.firstAttemptModuleGraphUnsupported = codes[0] === "artifact_module_graph_unsupported";
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const scripts = [...bundle.outputs.values()].filter((file) => /javascript/iu.test(file.mimeType) || /\.m?js$/iu.test(file.fileName));
    const workspaceCommands = turn.calls.filter((call) => /sandbox_(shell|exec)/u.test(call.toolName)).length;
    const scriptSources = bundle.manifest.filter((file) => /\.m?js$/iu.test(file.path)).map((file) => sourceOf(bundle, file.path));
    // Recorded, not asserted: the model may reference the saved bundle by attachment id or write it into the call.
    Object.assign(stand.summary, { workspaceScripts: scripts.length, workspaceCommands,
      bundleReference: scriptSources.includes("workspace") ? "attachment" : scriptSources.includes("inline") ? "inline" : "page" });
    expect(workspaceCommands, "the run built the site with a Workspace command").toBeGreaterThan(0);
    await openInChat(stand, bundle);
    await expect(artifactFrame(page).locator(fixture.expected.resultSelector), "the bundled page computes the result")
      .toHaveText(fixture.expected.result, { timeout: 60_000 });
    await expectNoArtifactError(stand, 1_000);
    await shot(stand, "result");
  });
});

test("attach-original: on explicit request the dashboard also carries the original workbook", async ({ page }, testInfo) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS);
  await withScenario(page, testInfo, "attach-original", async (stand) => {
    const fixture = salesWorkbookXlsx();
    await startChat(stand);
    await attach(stand, [composerFile(fixture)]);
    const turn = await sendTurn(stand, "Сделай артефакт-дашборд по регионам и приложи исходный xlsx-файл");
    const bundle = await latestBundle(stand, turn);
    stand.step = "oracles";
    const held = holdsBytes(bundle, fixture.bytes);
    const entryMime = bundle.manifest.find((file) => file.path === bundle.entrypoint)?.mimeType ?? null;
    Object.assign(stand.summary, { workbookInExport: held.export, workbookBlob: held.blob, entryIsHtml: entryMime === "text/html",
      regionTotalsFound: regionTotalsEvidence(bundle.files, fixture.expected.revenueByRegion).found });
    expect(held.export, "the artifact holds the workbook exactly as uploaded").toBe(true);
    expect(entryMime, "the dashboard is an HTML page").toBe("text/html");
    await openInChat(stand, bundle);
    stand.summary.regionNamesShown = await artifactFrame(page).locator("body")
      .evaluate((body) => (body as HTMLElement).innerText.includes("North")).catch(() => false);
    await expectNoArtifactError(stand, 5_000);
    await shot(stand, "dashboard");
  });
});

test("public-and-zip: a site artifact opens anonymously, its public ZIP equals the owner's, and revocation answers 404", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(15 * 60_000);
  await withScenario(page, testInfo, "public-and-zip", async (stand) => {
    const fixture = multiPageSiteZip();
    stand.step = "create";
    const upload = await uploadAttachment(page.request, { fileName: fixture.fileName, mimeType: fixture.mimeType, bytes: fixture.bytes },
      { workspace: true });
    const created = await createArtifactFromUploads(page.request, { title: `Harborlight public check ${randomUUID().slice(0, 8)}`,
      entrypoint: fixture.expected.entry, files: [{ path: fixture.fileName, mimeType: fixture.mimeType, assetRef: upload.id, unpack: true }] });
    stand.artifactIds.add(created.artifactId);
    const version = await db().artifactVersion.findUniqueOrThrow({ select: { entrypoint: true, manifest: true }, where: { id: created.versionId } });
    expect(authoredPaths(manifestFiles(version.manifest)), "the archive's files land at the root").toEqual(fixture.expected.paths);
    expect(version.entrypoint).toBe(fixture.expected.entry);
    const owner = await exportedArtifactFiles(page.request, created.artifactId, created.versionId);
    expect([...owner.files.keys()].sort(), "the owner's export holds the site's files").toEqual(fixture.expected.paths);
    const archive = await zipFiles(fixture.bytes, { stripRoot: true });
    const unchanged = [...archive].filter(([path]) => !path.endsWith(".html")).every(([path, bytes]) => owner.files.get(path)?.equals(bytes) === true);
    stand.summary.nonHtmlBytesKept = unchanged;
    expect(unchanged, "data, script, style and image files keep the archive's bytes").toBe(true);

    stand.step = "public";
    const publication = await publishVersion(page.request, created.artifactId, created.versionId);
    const anonymous = await browser.newContext({ baseURL });
    try {
      const viewer = await anonymous.newPage();
      const opened = await viewer.goto(publication.publicPath);
      expect(opened?.status(), "the public page opens anonymously").toBe(200);
      await expectSiteNavigation(viewer, fixture.expected);
      await viewer.screenshot({ path: testInfo.outputPath("public-and-zip-01-public-about.png") });
      const content = publicContentPath(publication.publicPath);
      const publicZip = await anonymous.request.get(`${content}?download=zip`);
      expect(publicZip.status(), "the public ZIP is served").toBe(200);
      const publicBytes = await publicZip.body();
      const same = sameFiles(await zipFiles(publicBytes), owner.files);
      Object.assign(stand.summary, { publicZipSameFiles: same, publicZipSameBytes: publicBytes.equals(owner.zip) });
      expect(same, "the public ZIP holds the same paths and bytes as the owner's export").toBe(true);

      stand.step = "revoke";
      const revoked = await page.request.post(`/api/artifacts/publications/${publication.id}/revoke`, { data: { expectedRevision: publication.revision } });
      expect(revoked.status(), "the owner revokes the link").toBe(200);
      const after = [(await anonymous.request.get(publication.publicPath)).status(), (await anonymous.request.get(content)).status(),
        (await anonymous.request.get(`${content}?download=zip`)).status()];
      stand.summary.revokedStatuses = after;
      expect(after, "the revoked link, its content and its ZIP answer 404").toEqual([404, 404, 404]);
    } finally {
      await anonymous.close();
    }
  }, { model: false });
});
