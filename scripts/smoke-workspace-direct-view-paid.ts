/**
 * Opt-in, paid check of direct view (`view_workspace_image`, operator
 * decision 2026-10-26) against a DISPOSABLE AIQSA stand with a real KVM
 * Workspace. Never a default lane and never a persistent installation. It
 * drives the stand through its HTTP API as its initial administrator and
 * reads content-free facts from the stand's own database:
 * 1. turns the Workspace on (internet off) and Memory off for the admin;
 * 2. sets up the codex-lb Responses route with `vision: true`, so its setup
 *    runs the real image-input probe, and requires the verified evidence the
 *    System Vision candidates show; assigns System Vision to that route;
 * 3. sets up a text-only chat model: an OpenRouter model through OpenRouter's
 *    OpenAI-compatible Chat endpoint. Setup runs every probe and enables
 *    what passes, so its image input must stay unverified: a listing that
 *    says text only is not enough, since OpenRouter sends an image to
 *    whichever of the model's endpoints reads one (DeepSeek V4 Flash passed
 *    the probe that way), and a model with no image-reading endpoint, such
 *    as gpt-oss, is needed. For the same reason no codex-lb model can serve;
 * 4. in a chat with the vision model, has the agent run a fixed program that
 *    draws a random code into a PNG of the turn's output directory and writes
 *    only the code's SHA-256 beside it, then read the code from the image;
 *    passes when the run viewed it with `view_workspace_image`, the answer's
 *    code hashes to the written hash, and the transcript keeps the image by
 *    reference only. A second turn has it look again;
 * 5. in a chat with the text-only model, the same program: passes when the
 *    run was admitted without direct view, never called it, analyzed the
 *    image through `analyze_image` (System Vision) and answered the code.
 *
 * Prints one JSON line per stage and a final summary: codes, counts,
 * booleans and durations only. Codes, prompts, answers, keys and identifiers
 * are never printed. Exit 0 only when every check passed.
 *
 * Environment (process only; no .env loading):
 * - AIQSA_DIRECT_VIEW_DISPOSABLE_STAND=1 (required acknowledgement)
 * - AIQSA_DIRECT_VIEW_BASE_URL (loopback http, the stand's app)
 * - AIQSA_DIRECT_VIEW_DATABASE_URL (the stand's PostgreSQL on loopback; read-only queries)
 * - AIQSA_DIRECT_VIEW_ADMIN_EMAIL, AIQSA_DIRECT_VIEW_ADMIN_PASSWORD (the stand's initial administrator)
 * - CODEX_LB_API_KEY, CODEX_LB_BASE_URL (the OpenAI-compatible root), AIQSA_DIRECT_VIEW_CODEX_MODEL
 * - OPENROUTER_API_KEY and AIQSA_DIRECT_VIEW_TEXT_MODEL (see 3.)
 */
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { decodeCatalogResponse, type CatalogModel } from "../lib/contracts/catalog";
import { decodeChatDetailResponse, decodeChatSummaryResponse, type ChatDetailWire, type ChatMessageWire } from "../lib/contracts/chats";
import { decodeRunOutcomeResponse } from "../lib/contracts/runs";
import { decodeMemoryConsumerChatModeResponse } from "../lib/contracts/memoryClient";
import {
  journeyRunParams,
  messageText,
  modelInConnection,
  readConnections,
  settledTurn,
  type JourneyConnection
} from "./context-compaction-journey-support";

const REQUEST_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 900_000;
const RUN_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 3_000;
const STREAM_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 4_096;
const CODE_ALPHABET = "ACDEFHJKLMNPRTUVWXY34679";

/** Draws a random code no text output carries; only its hash is written beside the image. */
const PROGRAM = String.raw`import hashlib, os, secrets, sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
code = "".join(secrets.choice("${CODE_ALPHABET}") for _ in range(6))
image = Image.new("RGB", (960, 320), "white")
font = None
for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
             "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf"):
    if os.path.exists(path):
        font = ImageFont.truetype(path, 150)
        break
if font is None:
    try:
        font = ImageFont.load_default(size=150)
    except TypeError:
        font = None
if font is None:
    small = Image.new("RGB", (64, 16), "white")
    ImageDraw.Draw(small).text((4, 2), code, fill="black")
    image = small.resize((960, 240), Image.NEAREST)
else:
    ImageDraw.Draw(image).text((60, 70), code, fill="black", font=font)
image.save(os.path.join(out, "code.png"))
with open(os.path.join(out, "code.sha256"), "w") as handle:
    handle.write(hashlib.sha256(code.encode()).hexdigest() + "\n")
`;

const TASK = "Please do this in the Workspace. Save the Python program below as /workspace/project/make_code.py and run it with " +
  "this turn's output directory as its only argument. It draws a random code into code.png in that directory and writes only " +
  "a SHA-256 hash of the code to code.sha256; it prints nothing. Do not change the program, do not print, decode or OCR the " +
  "code with any program, and do not read code.sha256.";
const VIEW_PROMPT = `${TASK} Then look at code.png yourself and reply with exactly one line: CODE: followed by the six ` +
  `characters you see.\n\n\`\`\`python\n${PROGRAM}\`\`\``;
const ANALYZE_PROMPT = `${TASK} Then find out which code the image shows and reply with exactly one line: CODE: followed by ` +
  `the six characters.\n\n\`\`\`python\n${PROGRAM}\`\`\``;
const AGAIN_PROMPT = "Look at the code.png image from your previous answer once more (it is among this chat's Workspace files) " +
  "and reply with exactly one line: CODE: followed by the six characters you see now.";

type Stage = "auth" | "config" | "evidence" | "provider_setup" | "turn" | "vision" | "workspace";

class CheckFailure extends Error {
  constructor(readonly stage: Stage, readonly code: string) {
    super(code);
    this.name = "CheckFailure";
  }
}

const fail = (stage: Stage, code: string): never => { throw new CheckFailure(stage, code); };
const emit = (value: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Api = Readonly<{ baseUrl: URL; cookie: string }>;

async function poll<T>(stage: Stage, timeoutMs: number, probe: () => Promise<T | null>, timeoutCode = "poll_timeout"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value !== null) return value;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return fail(stage, timeoutCode);
}

async function failureCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as unknown;
  return record(body) && typeof body.error === "string" && /^[a-z0-9_]{1,64}$/u.test(body.error) ? body.error : `http_${response.status}`;
}

async function request(api: Pick<Api, "baseUrl"> & Partial<Pick<Api, "cookie">>, stage: Stage, path: string,
  init: Readonly<{ body?: unknown; method?: string; timeoutMs?: number }> = {}): Promise<Response> {
  const hasBody = Object.hasOwn(init, "body");
  try {
    return await fetch(new URL(path, api.baseUrl), {
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
      headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(api.cookie ? { cookie: api.cookie } : {}),
        origin: api.baseUrl.origin },
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS)
    });
  } catch {
    return fail(stage, "request_failed");
  }
}

async function json(api: Api, stage: Stage, path: string, init: Readonly<{ body?: unknown; method?: string; timeoutMs?: number }> = {}) {
  const response = await request(api, stage, path, init);
  if (!response.ok) fail(stage, await failureCode(response));
  return await response.json().catch(() => fail(stage, "response_invalid")) as unknown;
}

function config() {
  const env = process.env;
  if (env.AIQSA_DIRECT_VIEW_DISPOSABLE_STAND !== "1") fail("config", "disposable_stand_acknowledgement_required");
  const baseUrl = new URL(env.AIQSA_DIRECT_VIEW_BASE_URL ?? "");
  if (baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(baseUrl.hostname)) fail("config", "loopback_base_url_required");
  const database = new URL(env.AIQSA_DIRECT_VIEW_DATABASE_URL ?? "");
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1") fail("config", "loopback_database_required");
  const required = (name: string) => env[name]?.trim() || fail("config", `${name.toLowerCase()}_required`);
  const codexRoot = new URL(required("CODEX_LB_BASE_URL"));
  if (codexRoot.protocol !== "https:") fail("config", "codex_lb_https_required");
  return {
    adminEmail: required("AIQSA_DIRECT_VIEW_ADMIN_EMAIL"), adminPassword: required("AIQSA_DIRECT_VIEW_ADMIN_PASSWORD"), baseUrl,
    codex: { apiKey: required("CODEX_LB_API_KEY"), apiRoot: codexRoot.toString().replace(/\/$/u, ""),
      model: required("AIQSA_DIRECT_VIEW_CODEX_MODEL") },
    databaseUrl: database.toString(),
    textOnly: { apiKey: required("OPENROUTER_API_KEY"), model: required("AIQSA_DIRECT_VIEW_TEXT_MODEL") }
  };
}

async function signIn(baseUrl: URL, email: string, password: string): Promise<Api> {
  const response = await request({ baseUrl }, "auth", "/api/auth/login", { body: { email, password }, method: "POST" });
  if (!response.ok) fail("auth", await failureCode(response));
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .filter((value) => value.includes("=")).join("; ");
  if (!cookie) fail("auth", "session_cookie_missing");
  return { baseUrl, cookie };
}

async function connections(api: Api): Promise<JourneyConnection[]> {
  return readConnections(await json(api, "provider_setup", "/api/admin/providers")) ?? fail("provider_setup", "providers_response_invalid");
}

type Target = Readonly<{ connectionId: string; providerModelId: string }>;

/** One custom-setup connection with exactly the declared capabilities; setup runs every probe they call for. */
async function setUp(api: Api, input: Readonly<{ apiRoot: string; contextWindow: number; label: string; model: string;
  protocol: "chat_completions" | "responses"; privateNetwork: boolean; secret: string; vision: boolean }>): Promise<Target> {
  const started = Date.now();
  const result = await json(api, "provider_setup", "/api/admin/providers/custom-setup", { body: {
    allowPrivateNetwork: input.privateNetwork, apiRoot: input.apiRoot, authenticationMode: "bearer",
    // Reasoning controls only on the Responses route; a Chat model keeps its own default.
    capabilities: { contextWindow: input.contextWindow, defaultMaxOutputTokens: MAX_OUTPUT_TOKENS, streaming: true, toolCalling: true,
      parallelToolCalls: false, ...(input.protocol === "responses"
        ? { reasoning: true, reasoningEfforts: ["low"], defaultReasoningEffort: "low" } : { reasoning: false }),
      nativePdfInput: false, nativeImageGeneration: false, nativeSearch: false, pdf: false, vision: input.vision },
    confirmPaidRequest: true, connectionDisplayName: `Direct view ${input.label} ${randomUUID().slice(0, 8)}`,
    modelDisplayName: `Direct view ${input.label}`, modelId: input.model, protocol: input.protocol, responseTimeoutSeconds: 180,
    secret: input.secret
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (!record(result) || typeof result.connectionId !== "string" || !["ready", "partial"].includes(String(result.outcome))) {
    return fail("provider_setup", record(result) && typeof result.outcome === "string" ? `setup_${result.outcome}` : "setup_response_invalid");
  }
  const connectionId = result.connectionId;
  const connection = await poll("provider_setup", SETUP_TIMEOUT_MS, async () => {
    const current = (await connections(api)).find((candidate) => candidate.id === connectionId);
    if (!current) return fail("provider_setup", "connection_missing");
    return current.checkRunning ? null : current;
  }, "checks_still_running");
  const model = modelInConnection(connection, input.model) ?? fail("provider_setup", "model_not_configured");
  emit({ stage: "provider_ready", label: input.label, outcome: result.outcome, setupSeconds: Math.round((Date.now() - started) / 1000) });
  return { connectionId, providerModelId: model.id };
}

async function catalogModel(api: Api, target: Target): Promise<CatalogModel> {
  return poll("provider_setup", SETUP_TIMEOUT_MS, async () => {
    const catalog = decodeCatalogResponse(await json(api, "provider_setup", "/api/me/catalog")) ?? fail("provider_setup", "catalog_invalid");
    const model = catalog.models.find((entry) => entry.provider === target.connectionId && entry.modelId === target.providerModelId);
    return model?.capabilities.toolCalling ? model : null;
  }, "catalog_model_missing");
}

/** The System Vision candidate's verified image input, which admission requires for direct view too. */
async function visionVerified(api: Api, target: Target): Promise<Readonly<{ verified: boolean; version: number }>> {
  const value = await json(api, "vision", "/api/admin/providers/system-model-policy");
  const policy = record(value) && record(value.systemModelPolicy) ? value.systemModelPolicy : null;
  const version = record(policy) && record(policy.policy) && typeof policy.policy.version === "number" ? policy.policy.version : null;
  // Vision candidates are the document candidates with verified image input (`components/admin/roles/rolesView.ts`).
  const candidates = record(policy) && Array.isArray(policy.documentCandidates) ? policy.documentCandidates : [];
  const candidate = candidates.find((entry) => record(entry) && entry.id === target.providerModelId);
  if (version === null) return fail("vision", "system_model_policy_invalid");
  return { verified: record(candidate) && candidate.visionInput === "verified", version };
}

async function chatDetail(api: Api, chatId: string): Promise<ChatDetailWire> {
  return decodeChatDetailResponse(await json(api, "evidence", `/api/chats/${encodeURIComponent(chatId)}`)) ?? fail("evidence", "chat_invalid");
}

async function createChat(api: Api, title: string): Promise<string> {
  const chat = decodeChatSummaryResponse(await json(api, "turn", "/api/chats", { body: { title }, method: "POST" })) ??
    fail("turn", "chat_invalid");
  const mode = decodeMemoryConsumerChatModeResponse(await json(api, "turn", `/api/me/chats/${encodeURIComponent(chat.id)}/memory-mode`,
    { body: { mode: "EXCLUDED" }, method: "PATCH" }));
  if (!mode.ok || mode.value.mode !== "EXCLUDED") fail("turn", "memory_exclusion_failed");
  return chat.id;
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > STREAM_BYTES) fail("turn", "stream_bound_exceeded");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Sends one message with the Workspace on after `leafId` and returns its settled answer. */
async function sendTurn(api: Api, chatId: string, leafId: string | null, model: CatalogModel, prompt: string,
  expectFiles: boolean): Promise<ChatMessageWire> {
  const params = journeyRunParams(model, MAX_OUTPUT_TOKENS);
  // A model without reasoning controls keeps its provider's default rather than an explicit effort.
  if (!model.parameterControls.reasoningEffort.supported) delete params.reasoning;
  const response = await request(api, "turn", `/api/chats/${encodeURIComponent(chatId)}/messages`, { body: {
    content: { blocks: [{ text: prompt, type: "text" }] }, expectedActiveLeafId: leafId, mcp: { mode: "off" }, modelId: model.modelId,
    params, provider: model.provider, searchPlan: { mode: "all_selected", optionIds: [] },
    searchStrategy: "search-disabled", timeZone: "UTC", workspace: { enabled: true }
  }, method: "POST", timeoutMs: RUN_TIMEOUT_MS });
  if (!response.ok) fail("turn", await failureCode(response));
  await drain(response);
  const detail = await poll("turn", RUN_TIMEOUT_MS, async () => {
    const current = await chatDetail(api, chatId);
    return settledTurn(current, leafId) ? current : null;
  }, "run_not_settled");
  const { assistant } = settledTurn(detail, leafId)!;
  if (assistant.modelRunId) {
    await poll("turn", RUN_TIMEOUT_MS, async () => {
      const outcome = decodeRunOutcomeResponse(await json(api, "turn", `/api/model-runs/${encodeURIComponent(assistant.modelRunId!)}`)) ??
        fail("turn", "run_outcome_invalid");
      return ["cancelled", "complete", "error"].includes(outcome.status) ? outcome : null;
    }, "run_not_settled");
  }
  // The answer's generated files are exported after the answer: wait for them where the turn makes them.
  return poll("turn", 300_000, async () => {
    const message = (await chatDetail(api, chatId)).messages.find((entry) => entry.id === assistant.id) ?? null;
    if (!message || message.status !== "complete" || !expectFiles) return message;
    return message.artifactSummary?.generatedFiles?.some((file) => file.fileName === "code.sha256") ? message : null;
  }, "generated_files_missing");
}

/** The hash the program wrote, from the answer's exported file. */
async function writtenHash(api: Api, message: ChatMessageWire): Promise<string | null> {
  const file = message.artifactSummary?.generatedFiles?.find((entry) => entry.fileName === "code.sha256");
  if (!file) return null;
  const response = await request(api, "evidence", `/api/attachments/${encodeURIComponent(file.attachmentId)}/content`);
  if (!response.ok) return null;
  const text = (await response.text()).trim();
  return /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

/** Whether the answer's code hashes to the written one; the code itself never leaves this function. */
function answerMatches(message: ChatMessageWire, hash: string | null): boolean {
  const code = /CODE:\s*([A-Z0-9]{6})\b/u.exec(messageText(message).toUpperCase())?.[1];
  return Boolean(code && hash && sha256(code) === hash);
}

/** Content-free facts of one run from the stand's database. */
async function runFacts(db: PrismaClient, runId: string) {
  const run = await db.modelRun.findUnique({ select: { normalizedRequest: true, status: true }, where: { id: runId } });
  const calls = await db.modelRunToolCall.groupBy({ by: ["toolName", "state"], _count: { _all: true }, where: { modelRunId: runId } });
  const count = (name: string, state?: string) => calls.filter((entry) => entry.toolName === name && (!state || entry.state === state))
    .reduce((total, entry) => total + entry._count._all, 0);
  const items = await db.runTranscriptItem.findMany({ select: { body: true, kind: true }, where: { modelRunId: runId } });
  const results = items.filter((item) => item.kind === "tool_result");
  const imageResults = results.filter((item) => record(item.body) && Object.hasOwn(item.body, "image"));
  const request = record(run?.normalizedRequest) ? run.normalizedRequest : {};
  return {
    analyzeCalls: count("analyze_image"), analyzeComplete: count("analyze_image", "complete"),
    // The transcript keeps references: no stored item is anywhere near a preview's size.
    largestTranscriptItemBytes: Math.max(0, ...items.map((item) => Buffer.byteLength(JSON.stringify(item.body)))),
    status: run?.status ?? null, toolCalls: calls.reduce((total, entry) => total + entry._count._all, 0),
    transcriptImageResults: imageResults.length, viewCalls: count("view_workspace_image"),
    viewComplete: count("view_workspace_image", "complete"), workspaceImageView: request.workspaceImageView === true
  };
}

async function scenario(api: Api, db: PrismaClient, input: Readonly<{ model: CatalogModel; name: string; prompts: readonly string[] }>) {
  const chatId = await createChat(api, `Direct view ${input.name}`);
  let leafId: string | null = null;
  const turns = [];
  for (const [index, prompt] of input.prompts.entries()) {
    const started = Date.now();
    const message = await sendTurn(api, chatId, leafId, input.model, prompt, index === 0);
    const hash = await writtenHash(api, index === 0 ? message : (await chatDetail(api, chatId)).messages
      .find((entry) => entry.artifactSummary?.generatedFiles?.some((file) => file.fileName === "code.sha256")) ?? message);
    const facts = message.modelRunId ? await runFacts(db, message.modelRunId) : null;
    // The next message is admitted only once the Workspace settled this turn (its export and its operation); a turn
    // that did not complete is reported as it ended, without waiting for an export.
    if (message.modelRunId && message.status === "complete") {
      await poll("turn", 300_000, async () => (await db.workspaceRunBinding.findUnique({ select: { exportState: true },
        where: { modelRunId: message.modelRunId! } }))?.exportState === "COMPLETE" ? true : null, "workspace_export_not_settled");
    }
    await poll("turn", 300_000, async () => (await db.workspaceSession.findUnique({ select: { operationOwner: true },
      where: { chatId } }))?.operationOwner === null ? true : null, "workspace_not_settled");
    const turn = { answerMatches: answerMatches(message, hash), hashWritten: hash !== null, seconds: Math.round((Date.now() - started) / 1000),
      status: message.status, turn: index + 1, ...facts };
    emit({ stage: "turn", scenario: input.name, ...turn });
    turns.push(turn);
    leafId = message.id;
  }
  return turns;
}

async function main() {
  const settings = config();
  const db = new PrismaClient({ datasources: { db: { url: settings.databaseUrl } } });
  const started = Date.now();
  try {
    const api = await signIn(settings.baseUrl, settings.adminEmail, settings.adminPassword);
    const workspace = await json(api, "workspace", "/api/admin/workspace");
    const workspaceVersion = record(workspace) && record(workspace.workspace)
      ? workspace.workspace.version ?? (record(workspace.workspace.policy) ? workspace.workspace.policy.version : undefined) : undefined;
    await json(api, "workspace", "/api/admin/workspace", { body: { enabled: true, expectedVersion: workspaceVersion, internetEnabled: false },
      method: "PATCH" });
    await json(api, "workspace", "/api/me/memory/settings", { body: { decayEnabled: false, learnAutomatically: false,
      referenceChatHistory: false, useMemoryFacts: false }, method: "PATCH" });

    const vision = await setUp(api, { apiRoot: settings.codex.apiRoot, contextWindow: 272_000, label: "vision", model: settings.codex.model,
      protocol: "responses", privateNetwork: true, secret: settings.codex.apiKey, vision: true });
    const evidence = await visionVerified(api, vision);
    emit({ stage: "vision_evidence", verified: evidence.verified });
    if (!evidence.verified) fail("vision", "vision_input_not_verified");
    await json(api, "vision", "/api/admin/providers/system-model-policy", { body: { expectedVersion: evidence.version,
      visionProviderModelId: vision.providerModelId, visionReasoningEffort: "low" }, method: "PATCH" });
    const textOnly = await setUp(api, { apiRoot: "https://openrouter.ai/api/v1", contextWindow: 128_000, label: "text-only openrouter",
      model: settings.textOnly.model, protocol: "chat_completions", privateNetwork: false, secret: settings.textOnly.apiKey, vision: false });
    const textOnlyReadsImages = (await visionVerified(api, textOnly)).verified;
    emit({ stage: "text_only_route", visionVerified: textOnlyReadsImages });
    // Setup enables every capability its probes verify, so a model that read the probe image is no text-only model.
    if (textOnlyReadsImages) fail("vision", "text_only_model_reads_images");

    const direct = await scenario(api, db, { model: await catalogModel(api, vision), name: "vision", prompts: [VIEW_PROMPT, AGAIN_PROMPT] });
    const indirect = await scenario(api, db, { model: await catalogModel(api, textOnly), name: "text-only", prompts: [ANALYZE_PROMPT] });
    const passed = direct.every((turn) => turn.status === "complete" && turn.answerMatches && turn.workspaceImageView &&
      (turn.viewComplete ?? 0) >= 1 && turn.transcriptImageResults === turn.viewComplete && (turn.largestTranscriptItemBytes ?? 0) < 65_536) &&
      indirect.every((turn) => turn.status === "complete" && turn.answerMatches && !turn.workspaceImageView && turn.viewCalls === 0 &&
        (turn.analyzeComplete ?? 0) >= 1);
    emit({ status: passed ? "passed" : "failed", elapsedSeconds: Math.round((Date.now() - started) / 1000) });
    if (!passed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  emit(error instanceof CheckFailure ? { code: error.code, stage: error.stage, status: "failed" }
    : { code: "direct_view_check_failed", status: "failed" });
  process.exitCode = 1;
});
