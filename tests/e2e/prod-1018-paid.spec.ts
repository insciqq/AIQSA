/**
 * Opt-in, paid, bounded qualification of the prod-1018 sweep on a DISPOSABLE
 * stand (real KVM Workspace runner for the Agent cases). Never a default
 * lane: it runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE, and each case
 * skips with a reason when its own keys or stand facilities are absent:
 *
 * 1. codex-lb answer (CODEX_LB_API_KEY, CODEX_LB_BASE_URL — the Codex root
 *    ending in `/backend-api/codex`; AIQSA_FEATURES_CODEX_MODEL picks the
 *    model): one short ordinary answer completes with provider usage.
 * 2. codex-lb Agent run in Workspace (+ AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE):
 *    a trivial task writes one file to the run's output and completes.
 * 3. Agent/Workspace Vision (same keys): the model links the attached PNG
 *    with a symlink, `analyze_image` on the link fails with
 *    `workspace_capture_source_invalid` and its copy hint, and the analysis of
 *    the `cp` copy succeeds through the installation Vision Model (a second
 *    codex-lb deployment with image input; the previous assignment is
 *    restored).
 * 4. MCP oversized call isolation (codex keys + the stand's app running with
 *    AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES lowered to 4096..65536, as
 *    mcp-oversized-result-paid.spec.ts needs): in one run, the over-bound
 *    `tools/call` fails with `mcp_call_result_too_large` and the hint, and
 *    the following call on the same server succeeds over the same session.
 *    AIQSA_FEATURES_FIXTURE_HOST / AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place
 *    the synthetic peer. The deterministic two-turn version is
 *    mcp-oversized-call-isolation.spec.ts.
 * 5. OpenRouter DeepSeek V4.1 Flash 1017 (OPENROUTER_API_KEY): an enabled
 *    OpenRouter connection is reused, else Quick Setup runs with candidate
 *    `p11-r17`; the admin model Check of the 1017 deployment verifies tools
 *    and structured output, and one short answer completes on it.
 * 6. DeepSeek Search API (DEEPSEEK_API_KEY + codex keys): a native DeepSeek
 *    connection (reused, else Quick Setup), the source added through Admin
 *    Search "Add source" with at most one request per answer (Save runs one
 *    probe search) and enabled; one codex-lb answer with only that source
 *    shows cited sources and leaves exactly one billed `web_search` row.
 *
 * Oracles are persisted state (runs, tool calls, Vision attempts, usage
 * rows, Workspace outputs, admin check evidence) and the synthetic MCP
 * peer's counters, never the model's wording. Prompts, answers, payloads and
 * keys are never printed; each case attaches and prints one summary of model
 * ids, counts, states and stable codes. Chats, MCP servers and consents are
 * removed afterwards; connections and Search sources stay on the stand like
 * the other paid specs' connections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun, type ModelRunToolCall } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import sharp from "sharp";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { mcpOversizedResponseMessage, mcpToolFailureMessage } from "../../lib/contracts/mcpToolFailure";
import type { AdminSearchCatalog, AdminSearchIntegration } from "../../lib/contracts/adminSearch";
import type { AdminSystemModelPolicyResponse } from "../../lib/contracts/adminSystemModelPolicy";
import type { CatalogModel } from "../../lib/contracts/catalog";
import type { ContentBlock } from "../../lib/domain/content";
import { providerModelTemplateId } from "../../lib/domain/providerTemplates";
import { agentMaxOutputTokensLimit } from "../../lib/domain/runParams";
import { ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION } from "../../lib/server/admin/providers/quickSetupPolicy";
import {
  codexLbSetupBody, journeyRunParams, modelInConnection, readConnections, type JourneyConnection
} from "../../scripts/context-compaction-journey-support";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { authenticateWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import {
  newExcludedChat, paidEnv, pollUntil, PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, setupCodexLbAnswerModel, waitForCatalogModel,
  type PaidAnswerModel
} from "./support/paidProviders";
import { disableMemoryRecall } from "./support/workspace";
import { cleanupWorkspaceFixtureChat } from "./support/workspaceFixture";

const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));
const workspaceLive = process.env.AIQSA_WORKSPACE_LIVE_E2E === "DISPOSABLE";
const mcpLimit = Number(paidEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES") ?? Number.NaN);
const mcpLimitLowered = Number.isSafeInteger(mcpLimit) && mcpLimit >= 4_096 && mcpLimit <= 65_536;

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.describe.configure({ mode: "serial" });

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const WARMUP_TIMEOUT_MS = 300_000;
/** An Agent turn boots a guest and runs Codex; several minutes is ordinary. */
const AGENT_TURN_TIMEOUT_MS = 20 * 60_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const FLASH_1017 = "deepseek/deepseek-v4.1-flash-1017";
const FLASH_1017_CANDIDATE = "p11-r17";
const DEEPSEEK_SEARCH_API_MODEL = "deepseek-search-api";
const DEEPSEEK_SEARCH_API_COST_MICROS = 750;

/** One codex-lb answer connection for the whole file. */
let codexModel: PaidAnswerModel | null = null;

async function codexAnswerModel(request: APIRequestContext): Promise<PaidAnswerModel> {
  codexModel ??= await setupCodexLbAnswerModel(request, {
    label: "Prod 1018", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
  });
  return codexModel;
}

async function report(testInfo: TestInfo, name: string, summary: Record<string, unknown>) {
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`${name} ${JSON.stringify(summary)}`);
}

function runErrorCode(run: ModelRun | null): string | null {
  const code = (run?.errorPayload as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

type TurnInput = Readonly<{
  agent?: boolean;
  blocks: readonly ContentBlock[];
  mcp?: "load_all" | "off";
  params?: Record<string, unknown>;
  searchOptionIds?: readonly string[];
  timeoutMs?: number;
  workspace?: boolean;
}>;

/**
 * One API turn as the composer would send it, then the settled run (unasserted).
 * Skills are off; MCP, Search, Workspace and Agent only as asked.
 */
async function apiTurn(request: APIRequestContext, chatId: string, model: PaidAnswerModel, input: TurnInput): Promise<ModelRun> {
  const before = await db().modelRun.count({ where: { chatId } });
  const chat = await db().chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
    ...(input.agent ? { agentEnabled: true } : {}),
    content: { blocks: input.blocks }, expectedActiveLeafId: chat.activeLeafMessageId, mcp: { mode: input.mcp ?? "off" },
    modelId: model.modelId, params: input.params ?? model.params, provider: model.connectionId,
    searchPlan: { mode: "all_selected", optionIds: [...(input.searchOptionIds ?? [])] }, skills: { mode: "off" }, timeZone: "UTC",
    workspace: { enabled: input.workspace ?? false }
  } });
  const accepted = response.ok();
  const code = accepted ? null : (await response.json().catch(() => null) as { error?: unknown } | null)?.error;
  expect(accepted, `the paid turn is accepted (${response.status()} ${typeof code === "string" ? code : ""})`).toBe(true);
  await response.body();
  return pollUntil(input.timeoutMs ?? PAID_TURN_TIMEOUT_MS, async () => {
    const runs = await db().modelRun.findMany({ orderBy: { createdAt: "asc" }, where: { chatId } });
    const newest = runs.length > before ? runs.at(-1)! : null;
    return newest && !ACTIVE_RUN_STATUSES.includes(newest.status) ? newest : null;
  }, "prod_1018_turn_timeout");
}

async function answerUsage(runId: string) {
  const rows = await db().usageEvent.findMany({ where: { modelRunId: runId, purpose: "chat_answer" } });
  return { rows: rows.length, inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0) };
}

async function catalogModelOf(request: APIRequestContext, model: PaidAnswerModel): Promise<CatalogModel> {
  return waitForCatalogModel(request, model.connectionId, (candidate) => candidate.modelId === model.modelId);
}

test.beforeEach(async ({ request }) => { await authenticateWithLocalToken(request); });

// --------------------------------------------------------- 1. codex-lb ---

test("codex-lb: a short ordinary answer completes with provider usage", async ({ request }, testInfo) => {
  test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
  test.setTimeout(1_200_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  try {
    const model = await codexAnswerModel(request);
    summary.model = model.upstreamModelId;
    chatId = await newExcludedChat(request, `Prod 1018 codex ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(request, chatId, model, { blocks: [{ text: "Reply with one short sentence that names a colour.", type: "text" }] });
    const usage = await answerUsage(run.id);
    Object.assign(summary, { status: run.status, code: runErrorCode(run), usage });
    expect(run.status, `the answer completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(usage.inputTokens, "provider-reported input usage").toBeGreaterThan(0);
    expect(usage.outputTokens, "provider-reported output usage").toBeGreaterThan(0);
  } finally {
    if (chatId) await deleteOwnedChatPermanently(request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await report(testInfo, "prod_1018_codex_answer_summary", summary);
  }
});

// ------------------------------------------------------ Agent prerequisites ---

/** The Workspace and model facts an Agent turn needs, asserted with stable reasons. */
async function agentParams(request: APIRequestContext, model: PaidAnswerModel): Promise<Record<string, unknown>> {
  const workspace = (await (await request.get("/api/workspace")).json() as {
    workspace?: { agentAvailable?: boolean; available?: boolean; internetEnabled?: boolean | null };
  }).workspace;
  expect(workspace?.available, "workspace_unavailable").toBe(true);
  expect(workspace?.agentAvailable, "agent_runtime_unavailable").toBe(true);
  expect(workspace?.internetEnabled, "agent_internet_required").toBe(true);
  const catalog = await catalogModelOf(request, model);
  expect(catalog.agentAvailable, "agent_model_unavailable").toBe(true);
  // Within the Agent output cap, with room for a few tool rounds.
  return journeyRunParams(catalog, Math.min(4_096, agentMaxOutputTokensLimit(catalog.contextWindow)));
}

/** Retires the chat's Workspace (cancelling owned work) and deletes the chat. */
async function cleanupAgentChat(page: Page, chatId: string): Promise<void> {
  if (await db().workspaceSession.count({ where: { chatId } }).catch(() => 0) > 0) {
    await cleanupWorkspaceFixtureChat(db(), page, chatId).catch(() => undefined);
  }
  await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
}

/** Workspace outputs the run exported; export follows the run, so this waits for `accept`. */
async function runOutputs(runId: string, accept: (names: readonly string[]) => boolean, timeoutMs = 300_000) {
  return pollUntil(timeoutMs, async () => {
    const rows = await db().attachment.findMany({ select: { byteSize: true, fileName: true },
      where: { origin: "WORKSPACE_OUTPUT", producerModelRunId: runId } });
    return accept(rows.map((row) => row.fileName)) ? rows : null;
  }, "prod_1018_workspace_output_timeout");
}

// ------------------------------------------------------- 2. Agent run ---

test("codex-lb Agent run in Workspace writes a file and completes", async ({ page }, testInfo) => {
  test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
  test.skip(!workspaceLive, "requires an explicitly disposable KVM Microsandbox topology (AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE)");
  test.setTimeout(45 * 60_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  const fileName = "prod-1018-agent.txt";
  try {
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    await disableMemoryRecall(page);
    const model = await codexAnswerModel(page.request);
    summary.model = model.upstreamModelId;
    const params = await agentParams(page.request, model);
    chatId = await newExcludedChat(page.request, `Prod 1018 Agent ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(page.request, chatId, model, { agent: true, params, timeoutMs: AGENT_TURN_TIMEOUT_MS, workspace: true,
      blocks: [{ type: "text", text: `With one shell command, write the single line PROD-1018 to a file named ${fileName} in your ` +
        "current output directory. Do not run anything else. Then reply with exactly: AGENT-DONE" }] });
    Object.assign(summary, { status: run.status, code: runErrorCode(run),
      frozenAgent: Boolean((run.normalizedRequest as { agent?: unknown } | null)?.agent) });
    expect(run.status, `the Agent run completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(summary.frozenAgent, "the run was an Agent run").toBe(true);
    const outputs = await runOutputs(run.id, (names) => names.includes(fileName));
    const output = outputs.find((row) => row.fileName === fileName)!;
    summary.outputs = outputs.length;
    summary.outputBytes = output.byteSize;
    expect(output.byteSize, "the written file is not empty").toBeGreaterThan(0);
  } finally {
    if (chatId) await cleanupAgentChat(page, chatId);
    await report(testInfo, "prod_1018_agent_summary", summary);
  }
});

// ------------------------------------------------ 3. Agent Vision capture ---

async function connection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, "prod_1018_checks_timeout");
}

/** A second codex-lb deployment of `upstream` that declares image input (as the compaction/Vision paid spec makes it). */
async function codexVisionModel(request: APIRequestContext, upstream: string): Promise<string> {
  const apiRoot = paidEnv("CODEX_LB_BASE_URL")!.replace(/\/+$/u, "");
  const secret = paidEnv("CODEX_LB_API_KEY")!;
  const discovered = await request.post("/api/admin/providers/custom-setup/discover", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { allowPrivateNetwork: true, apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret } });
  const discovery = discovered.ok() ? await discovered.json() as { catalogProof?: unknown; models?: Array<{ id?: unknown }> } : null;
  const listed = new Set((discovery?.models ?? []).map((model) => model.id));
  const catalogProof = typeof discovery?.catalogProof === "string" && listed.has(upstream) ? discovery.catalogProof : undefined;
  const tag = randomUUID().slice(0, 8);
  const body = codexLbSetupBody({ apiRoot, ...(catalogProof ? { catalogProof } : {}), contextWindow: 65_536, model: upstream, secret,
    connectionDisplayName: `Prod 1018 Vision ${tag}` });
  const setup = await request.post("/api/admin/providers/custom-setup", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    ...body, capabilities: { ...body.capabilities as Record<string, unknown>, vision: true }, modelDisplayName: `Prod 1018 Vision model ${tag}`
  } });
  expect(setup.ok(), `codex-lb Vision setup is accepted (${setup.status()})`).toBe(true);
  const outcome = await setup.json() as { connectionId?: unknown; outcome?: unknown };
  expect(["ready", "partial"]).toContain(outcome.outcome);
  const model = modelInConnection(await connection(request, String(outcome.connectionId)), upstream);
  expect(model, "the Vision deployment is on its connection").toBeTruthy();
  return model!.id;
}

type VisionAssignment = Readonly<{ providerModelId: string | null; reasoningEffort: string | null }>;

async function systemModelPolicy(request: APIRequestContext): Promise<AdminSystemModelPolicyResponse["systemModelPolicy"]> {
  const response = await request.get("/api/admin/providers/system-model-policy");
  expect(response.ok(), `the system model policy is readable (${response.status()})`).toBe(true);
  return (await response.json() as AdminSystemModelPolicyResponse).systemModelPolicy;
}

async function assignVision(request: APIRequestContext, assignment: VisionAssignment): Promise<void> {
  const { version } = (await systemModelPolicy(request)).policy;
  const response = await request.patch("/api/admin/providers/system-model-policy", { data: {
    expectedVersion: version, visionProviderModelId: assignment.providerModelId, visionReasoningEffort: assignment.reasoningEffort
  } });
  expect(response.ok(), `the Vision Model assignment is saved (${response.status()})`).toBe(true);
}

type ToolValue = Readonly<{ error?: unknown; hint?: unknown }>;

/** The JSON part of a persisted tool result, as the Vision tool writes it. */
function toolValue(call: Pick<ModelRunToolCall, "result">): ToolValue | null {
  const content = (call.result as { content?: Array<{ type?: unknown; value?: unknown }> } | null)?.content ?? [];
  const value = content.find((part) => part.type === "json")?.value;
  return value && typeof value === "object" ? value as ToolValue : null;
}

const SYMLINK_PROMPT = "This is a test of image analysis in the Workspace. Run exactly these steps: " +
  "1) With one shell command, create a symbolic link named linked-image.png in your current output directory that points to " +
  "the attached image file in /workspace/inbox/messages (use ln -s). " +
  "2) Call analyze_image once on the absolute path of linked-image.png, asking which colour fills the image. " +
  "3) If that call fails, follow the hint in its error exactly: copy the image with cp into your current output directory as " +
  "copied-image.png and call analyze_image once on the copy's absolute path. " +
  "Do not run anything else and do not call analyze_image more than twice. Then answer in one short sentence.";

test("Agent Vision: a symlinked image gets the capture refusal with its copy hint, and the copy is analyzed", async ({ page }, testInfo) => {
  test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
  test.skip(!workspaceLive, "requires an explicitly disposable KVM Microsandbox topology (AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE)");
  test.setTimeout(60 * 60_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  let previous: VisionAssignment | null = null;
  try {
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    await disableMemoryRecall(page);
    const request = page.request;
    const model = await codexAnswerModel(request);
    summary.model = model.upstreamModelId;
    const params = await agentParams(request, model);

    // Agent images go through the installation Vision Model only.
    const visionModelId = await codexVisionModel(request, model.upstreamModelId);
    const verified = await request.post("/api/admin/providers/system-model-policy", { timeout: PAID_SETUP_TIMEOUT_MS,
      data: { role: "vision", providerModelId: visionModelId } });
    expect(verified.ok(), `the Vision deployment verifies image input (${verified.status()})`).toBe(true);
    const catalog = await systemModelPolicy(request);
    previous = { providerModelId: catalog.policy.visionModel?.id ?? null,
      reasoningEffort: catalog.policy.visionModel ? catalog.policy.visionReasoningEffort ?? null : null };
    const candidate = [...catalog.verificationCandidates, ...catalog.candidates].find((entry) => entry.id === visionModelId);
    await assignVision(request, { providerModelId: visionModelId,
      reasoningEffort: candidate?.reasoningEfforts[0] ?? candidate?.defaultReasoningEffort ?? null });

    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#e8590c" } }).png().toBuffer();
    const upload = await request.post("/api/uploads", { timeout: PAID_TURN_TIMEOUT_MS,
      multipart: { file: { name: "orange-square.png", mimeType: "image/png", buffer: png } } });
    expect(upload.ok(), `the PNG upload is accepted (${upload.status()})`).toBe(true);
    const attachmentId = (await upload.json() as { attachment: { id: string } }).attachment.id;
    chatId = await newExcludedChat(request, `Prod 1018 Vision ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(request, chatId, model, { agent: true, params, timeoutMs: AGENT_TURN_TIMEOUT_MS, workspace: true,
      blocks: [{ attachmentId, type: "image" }, { text: SYMLINK_PROMPT, type: "text" }] });
    const calls = await db().modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
      select: { id: true, result: true, state: true }, where: { modelRunId: run.id, toolName: "analyze_image" } });
    const attempts = await db().visionAnalysisAttempt.findMany({ where: { modelRunId: run.id } });
    const receipts = await db().usageEvent.findMany({ where: { visionAnalysisAttemptId: { in: attempts.map((attempt) => attempt.toolCallId) } } });
    const refusal = calls.findIndex((call) => toolValue(call)?.error === "workspace_capture_source_invalid");
    const refusalHint = refusal >= 0 ? toolValue(calls[refusal]!)?.hint : null;
    const later = calls.slice(refusal + 1).find((call) => call.state === "complete");
    const laterAttempt = later ? attempts.find((attempt) => attempt.toolCallId === later.id) : undefined;
    const laterReceipt = laterAttempt ? receipts.find((receipt) => receipt.visionAnalysisAttemptId === laterAttempt.toolCallId) : undefined;
    // Recorded before the assertions, so a failing run still leaves its evidence.
    Object.assign(summary, {
      status: run.status, code: runErrorCode(run),
      analyzeCalls: calls.map((call) => ({ state: call.state, error: typeof toolValue(call)?.error === "string" ? toolValue(call)!.error : null })),
      refusalHasCopyHint: typeof refusalHint === "string" && refusalHint.includes("Copy it with `cp` into /workspace/output"),
      visionAttempts: attempts.map((attempt) => ({ state: attempt.state, failureCode: attempt.failureCode })),
      laterUsage: laterReceipt ? { inputTokens: laterReceipt.inputTokens, outputTokens: laterReceipt.outputTokens } : null
    });
    expect(run.status, `the Agent run completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(refusal, "one analyze_image on the symlink failed with workspace_capture_source_invalid").toBeGreaterThanOrEqual(0);
    expect(calls[refusal]!.state).toBe("error");
    expect(summary.refusalHasCopyHint, "the refusal carries the copy hint").toBe(true);
    // The refusal is before dispatch: no Vision request was bought for it.
    expect(attempts.some((attempt) => attempt.toolCallId === calls[refusal]!.id), "the refusal dispatched nothing").toBe(false);
    expect(later, "a later analyze_image (on the copy) succeeded").toBeTruthy();
    expect(laterAttempt?.state, "its Vision attempt settled").toBe("settled");
    expect(laterAttempt?.failureCode ?? null, "its Vision attempt succeeded").toBeNull();
    expect(laterReceipt?.inputTokens ?? 0, "the Vision request carries provider-reported input usage").toBeGreaterThan(0);
    expect(laterReceipt?.outputTokens ?? 0, "the Vision request carries provider-reported output usage").toBeGreaterThan(0);
    expect(calls.length, "the model kept to a few analyze_image calls").toBeLessThanOrEqual(4);
  } finally {
    if (chatId) await cleanupAgentChat(page, chatId);
    if (previous) await assignVision(page.request, previous).catch(() => { summary.visionRestore = "failed"; });
    await report(testInfo, "prod_1018_agent_vision_summary", summary);
  }
});

// -------------------------------------------- 4. MCP oversized isolation ---

const MCP_BIG_TOOL = "read_thread";
const MCP_SMALL_TOOL = "read_message";
const MCP_HINT_TAIL = (() => {
  const message = mcpOversizedResponseMessage();
  return message.slice(message.indexOf("Request less data"));
})();

type McpDispatch = Readonly<{ initializedSessions: number; name: string }>;

/** A synthetic mail peer: the thread is four times the delivered limit (over the transport bound), a message is small. */
async function startMailEndpoint(): Promise<{ dispatches: McpDispatch[]; endpoint: MutableMcpEndpoint }> {
  const dispatches: McpDispatch[] = [];
  const line = "Synthetic message: a routine status note about a fictional project, with nothing to act on.\n";
  const thread = line.repeat(Math.ceil((mcpLimit * 4) / Buffer.byteLength(line)));
  let endpoint: MutableMcpEndpoint | null = null;
  const idSchema = { additionalProperties: false, properties: { id: { maxLength: 64, type: "string" } }, required: ["id"],
    type: "object" as const };
  const callTool = (name: string): CallToolResult => {
    dispatches.push({ initializedSessions: endpoint?.counts.initialize ?? -1, name });
    if (name === MCP_BIG_TOOL) return { content: [{ text: thread, type: "text" }] };
    if (name === MCP_SMALL_TOOL) return { content: [{ text: "Synthetic message M-1: the status note is unchanged.", type: "text" }] };
    return { content: [{ text: "Unknown synthetic tool.", type: "text" }], isError: true };
  };
  const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
  const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
  endpoint = await startMutableMcpEndpoint([
    { annotations: { readOnlyHint: true }, description: "Read one synthetic mail thread with every message in full.",
      inputSchema: idSchema, name: MCP_BIG_TOOL },
    { annotations: { readOnlyHint: true }, description: "Read one synthetic mail message by its id.", inputSchema: idSchema,
      name: MCP_SMALL_TOOL }
  ], { callTool, ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
  return { dispatches, endpoint };
}

async function publishMcpServer(request: APIRequestContext, endpoint: MutableMcpEndpoint, name: string, userId: string): Promise<string> {
  const created = await request.post("/api/admin/mcp", { data: {
    activate: false,
    description: "Synthetic mail service for the paid oversized call isolation check",
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url }, transport: "streamable_http" },
    name,
    sharedValues: {}
  } });
  expect(created.status()).toBe(201);
  const server = (await created.json() as { server: AdminMcpServer }).server;
  const checked = await request.post(`/api/admin/mcp/${server.id}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
  } });
  expect(checked.status()).toBe(200);
  expect((await request.put(`/api/admin/mcp/${server.id}/grants`, { data: { canUse: true, personalSlotKeys: [], userId } })).ok()).toBe(true);
  expect((await request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
  return server.id;
}

const MCP_PROMPT = "This is a test with one synthetic mail service. First call read_thread exactly once with id T-1. " +
  "If that call fails, call read_message exactly once with id M-1 instead. Do not call any other tool and do not call any tool twice. " +
  "Then reply in one short sentence saying which call returned text.";

test("MCP: an over-bound tools/call fails alone with its hint while the next call on the server succeeds in the same run", async ({ request }, testInfo) => {
  test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
  test.skip(!mcpLimitLowered, "requires AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES between 4096 and 65536 on the stand");
  test.setTimeout(30 * 60_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const summary: Record<string, unknown> = { limit: mcpLimit };
  const { dispatches, endpoint } = await startMailEndpoint();
  let chatId: string | null = null;
  let serverId: string | null = null;
  try {
    const userId = ((await (await request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    await request.patch("/api/me/memory/settings", {
      data: { learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false } }).catch(() => undefined);
    serverId = await publishMcpServer(request, endpoint, `Prod 1018 mail ${randomUUID().slice(0, 8)}`, userId);
    const model = await codexAnswerModel(request);
    summary.model = model.upstreamModelId;
    chatId = await newExcludedChat(request, `Prod 1018 MCP ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(request, chatId, model, { mcp: "load_all", blocks: [{ text: MCP_PROMPT, type: "text" }] });
    const calls = await db().modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
      select: { result: true, state: true, toolName: true }, where: { modelRunId: run.id, mcpRunBindingId: { not: null } } });
    const big = calls.find((call) => call.toolName.includes(MCP_BIG_TOOL));
    const small = calls.find((call) => call.toolName.includes(MCP_SMALL_TOOL));
    const bigText = ((big?.result as { content?: Array<{ text?: unknown }> } | null)?.content ?? [])
      .flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n");
    const serialized = JSON.stringify({ calls: calls.map((call) => call.result), error: run.errorPayload });
    Object.assign(summary, {
      status: run.status, code: runErrorCode(run), mcpCalls: calls.map((call) => ({ state: call.state,
        tool: call.toolName.includes(MCP_BIG_TOOL) ? "big" : call.toolName.includes(MCP_SMALL_TOOL) ? "small" : "other" })),
      dispatches: dispatches.map((entry) => entry.name === MCP_BIG_TOOL ? "big" : "small"),
      sessionsAtDispatch: dispatches.map((entry) => entry.initializedSessions),
      bigHint: bigText.includes(MCP_HINT_TAIL), bigCode: serialized.includes("mcp_call_result_too_large"),
      sessionClosed: serialized.includes("mcp_session_closed"), openSessions: endpoint.openSessions()
    });
    expect(run.status, `the run completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(dispatches.map((entry) => entry.name), "each tool was sent once, the oversized one first").toEqual([MCP_BIG_TOOL, MCP_SMALL_TOOL]);
    expect(big?.state, "the over-bound call failed").toBe("error");
    expect(bigText).toContain(mcpToolFailureMessage("mcp_call_result_too_large"));
    expect(summary.bigHint, "the failure tells the model to request less data").toBe(true);
    expect(summary.bigCode, "the failure keeps its stable code").toBe(true);
    expect(small?.state, "the following call on the same server succeeded").toBe("complete");
    expect(summary.sessionClosed, "no session failure followed").toBe(false);
    expect(dispatches[1]!.initializedSessions, "the following call reused the session (no re-initialize)").toBe(dispatches[0]!.initializedSessions);
    expect(endpoint.openSessions(), "the session was not closed").toBeGreaterThan(0);
  } finally {
    if (chatId) await deleteOwnedChatPermanently(request, chatId, { timeout: 60_000 }).catch(() => undefined);
    if (serverId) await request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    await endpoint.close();
    await report(testInfo, "prod_1018_mcp_isolation_summary", summary);
  }
});

// ------------------------------------------ 5. OpenRouter Flash 1017 ---

type RawCheck = Readonly<{
  credentialVersionId?: unknown; evidence?: { capabilitySetup?: { checks?: Record<string, unknown> } }; modelVersion?: unknown;
  providerModelId?: unknown; status?: unknown;
}>;

async function rawConnection(request: APIRequestContext, connectionId: string): Promise<{ activeChecks?: RawCheck[] } | null> {
  const body = await (await request.get("/api/admin/providers")).json() as { connections?: Array<{ activeChecks?: RawCheck[]; id?: unknown }> };
  return body.connections?.find((entry) => entry.id === connectionId) ?? null;
}

/** An enabled, keyed, idle connection of `family`, or null. */
async function existingConnection(request: APIRequestContext, family: string): Promise<JourneyConnection | null> {
  return readConnections(await (await request.get("/api/admin/providers")).json())
    ?.find((candidate) => candidate.family === family && candidate.enabled && candidate.active &&
      candidate.defaultCredentialVersionId !== null && !candidate.checkRunning) ?? null;
}

async function quickSetup(request: APIRequestContext, provider: "deepseek" | "openrouter", secret: string,
  selectedModel?: Readonly<{ candidateId: string; policyVersion: number }>) {
  const snapshot = await (await request.get("/api/admin/providers/quick-setup")).json() as { providers: Array<{ provider: string; stateToken: string }> };
  const state = snapshot.providers.find((entry) => entry.provider === provider)?.stateToken;
  expect(state, `the stand offers ${provider} Quick Setup`).toBeTruthy();
  const response = await request.post("/api/admin/providers/quick-setup", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { expectedState: state, provider, secret, ...(selectedModel ? { selectedModel } : {}) } });
  const result = await response.json().catch(() => ({})) as { connectionId?: unknown; error?: unknown; model?: { displayName?: unknown }; outcome?: unknown };
  expect(response.ok(), `${provider} Quick Setup is accepted (${response.status()} ${typeof result.error === "string" ? result.error : ""})`).toBe(true);
  expect(["ready", "partial"], `${provider} Quick Setup outcome`).toContain(result.outcome);
  return { connection: await connection(request, String(result.connectionId)), model: result.model?.displayName ?? null, outcome: result.outcome };
}

test("OpenRouter DeepSeek V4.1 Flash 1017: the model Check verifies tools and structured output, and it answers", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENROUTER_API_KEY");
  test.skip(!secret, "paid: OPENROUTER_API_KEY is not set");
  test.setTimeout(45 * 60_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  try {
    let openRouter = await existingConnection(request, "openrouter");
    summary.reused = Boolean(openRouter);
    if (!openRouter) {
      const setup = await quickSetup(request, "openrouter", secret!,
        { candidateId: FLASH_1017_CANDIDATE, policyVersion: ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION });
      Object.assign(summary, { outcome: setup.outcome, chosen: setup.model });
      expect(setup.model, "Quick Setup chose the 1017 candidate").toBe("DeepSeek V4.1 Flash");
      openRouter = setup.connection;
    }
    let row = modelInConnection(openRouter, FLASH_1017);
    if (!row) {
      // A connection set up before the 1017 template: add it from the catalog (its check starts by itself).
      const added = await request.post(`/api/admin/providers/${openRouter.id}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
        action: "add_catalog_models", credentialId: openRouter.defaultCredentialId, expectedConnectionVersion: openRouter.activeVersion,
        expectedCredentialVersionId: openRouter.defaultCredentialVersionId,
        modelIds: [providerModelTemplateId(`openrouter:${FLASH_1017}`)]
      } });
      expect(added.ok(), `the 1017 model is added (${added.status()})`).toBe(true);
      summary.added = true;
      openRouter = await connection(request, openRouter.id);
      row = modelInConnection(openRouter, FLASH_1017);
    }
    expect(row, "the 1017 deployment is on the OpenRouter connection").toBeTruthy();
    // The admin model Check: the bounded capability probe of this one deployment.
    const checked = await request.post(`/api/admin/providers/${openRouter.id}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS,
      data: { action: "check_models", credentialId: openRouter.defaultCredentialId, modelIds: [row!.id] } });
    expect(checked.ok(), `the model Check starts (${checked.status()})`).toBe(true);
    openRouter = await connection(request, openRouter.id);
    row = modelInConnection(openRouter, FLASH_1017)!;
    const raw = await rawConnection(request, openRouter.id);
    const check = raw?.activeChecks?.find((entry) => entry.providerModelId === row!.id &&
      entry.credentialVersionId === openRouter!.defaultCredentialVersionId && entry.modelVersion === row!.activeVersion);
    const checks = check?.evidence?.capabilitySetup?.checks ?? {};
    Object.assign(summary, { checkStatus: check?.status ?? null, toolCalling: checks.toolCalling ?? null,
      structuredOutput: checks.structuredOutput ?? null, modelEnabled: row.enabled });
    expect(check?.status, "the 1017 deployment's check is available").toBe("available");
    expect(checks.toolCalling, "tool calling verified").toBe("verified");
    expect(checks.structuredOutput, "structured output verified").toBe("verified");

    const catalog = await waitForCatalogModel(request, openRouter.id, (candidate) => candidate.modelId === row!.id);
    expect(catalog.capabilities.toolCalling, "the catalog offers tool calling").toBe(true);
    const model: PaidAnswerModel = { connectionId: openRouter.id, displayName: catalog.displayName, modelId: catalog.modelId,
      params: journeyRunParams(catalog, 256), upstreamModelId: FLASH_1017 };
    chatId = await newExcludedChat(request, `Prod 1018 Flash 1017 ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(request, chatId, model, { blocks: [{ text: "Reply with one short sentence that names a colour.", type: "text" }] });
    const usage = await answerUsage(run.id);
    Object.assign(summary, { turn: { status: run.status, code: runErrorCode(run), usage } });
    expect(run.status, `the 1017 answer completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(usage.outputTokens, "the 1017 answer produced output").toBeGreaterThan(0);
  } finally {
    if (chatId) await deleteOwnedChatPermanently(request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await report(testInfo, "prod_1018_openrouter_flash_1017_summary", summary);
  }
});

// ---------------------------------------------- 6. DeepSeek Search API ---

async function searchCatalog(request: APIRequestContext): Promise<AdminSearchCatalog> {
  const response = await request.get("/api/admin/search");
  expect(response.ok()).toBe(true);
  return (await response.json() as { search: AdminSearchCatalog }).search;
}

function searchApiSource(catalog: AdminSearchCatalog, connectionId: string): AdminSearchIntegration | null {
  return catalog.integrations.find((source) => source.kind === "deepseek_search_api" && source.sourceConnectionId === connectionId &&
    source.archivedAt === null) ?? null;
}

/** Adds the source through Admin → Search → Add source (Save runs one probe search) and enables it; an existing one is reused. */
async function deepSeekSearchApiSource(page: Page, connectionId: string, summary: Record<string, unknown>): Promise<AdminSearchIntegration> {
  const existing = searchApiSource(await searchCatalog(page.request), connectionId);
  summary.sourceReused = Boolean(existing);
  if (!existing) {
    const { displayName: connectionName } = await db().providerConnection.findUniqueOrThrow({ select: { displayName: true },
      where: { id: connectionId } });
    await page.goto("/admin?section=search", { timeout: WARMUP_TIMEOUT_MS });
    const add = page.getByTestId("search-add");
    await expect(add).toBeEnabled({ timeout: 60_000 });
    await add.click();
    const sheet = page.getByRole("dialog", { name: "Add source" });
    const searchModel = sheet.getByLabel("Search model");
    const option = searchModel.locator("option").filter({ hasText: `${connectionName} Search API · key via ` }).first();
    await expect(option).toBeAttached();
    await searchModel.selectOption({ label: (await option.textContent())!.trim() });
    await sheet.getByText("Advanced Search execution", { exact: true }).click();
    await sheet.getByLabel("Maximum requests to this source per answer").fill("1");
    await page.screenshot({ path: test.info().outputPath("deepseek-search-api-add-source.png") });
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sheet, "Save passed its probe search and closed the sheet").toHaveCount(0, { timeout: 180_000 });
  }
  let source = await pollUntil(60_000, async () => searchApiSource(await searchCatalog(page.request), connectionId), "deepseek_search_api_source_missing");
  if (!source.enabled) {
    const enabledResponse = await page.request.post(`/api/admin/search/${source.id}/actions`, { data: { action: "enable" } });
    expect(enabledResponse.ok(), `the DeepSeek Search API source is enabled (${enabledResponse.status()})`).toBe(true);
    source = searchApiSource(await searchCatalog(page.request), connectionId)!;
  }
  expect(source.enabled, "the DeepSeek Search API source is enabled").toBe(true);
  return source;
}

const ONE_SEARCH_PROMPT = "Call the search tool exactly once with the query 'DeepSeek V4 release date', then answer in one " +
  "sentence citing the source. Do not search again.";

test("DeepSeek Search API: one search through the new source, cited sources, one billed web_search row", async ({ page }, testInfo) => {
  const secret = paidEnv("DEEPSEEK_API_KEY");
  test.skip(!secret, "paid: DEEPSEEK_API_KEY is not set");
  test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL for the answer model");
  test.setTimeout(45 * 60_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  try {
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const request = page.request;
    const deepSeek = await existingConnection(request, "deepseek") ?? (await quickSetup(request, "deepseek", secret!)).connection;
    summary.deepSeekModels = deepSeek.models.filter((model) => model.enabled).length;
    expect(summary.deepSeekModels, "the DeepSeek connection has an enabled model").not.toBe(0);
    const source = await deepSeekSearchApiSource(page, deepSeek.id, summary);
    summary.maxSearchCallsPerAnswer = source.configuration?.maxSearchCallsPerAnswer ?? null;
    if (!summary.sourceReused) expect(summary.maxSearchCallsPerAnswer, "the source allows one request per answer").toBe(1);

    const codex = await codexAnswerModel(request);
    summary.answerModel = codex.upstreamModelId;
    const catalog = await waitForCatalogModel(request, codex.connectionId, (candidate) => candidate.modelId === codex.modelId &&
      candidate.searchStrategyIds.includes(source.strategyId));
    const model: PaidAnswerModel = { ...codex, params: journeyRunParams(catalog, 512) };
    chatId = await newExcludedChat(request, `Prod 1018 DeepSeek Search ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(request, chatId, model, { searchOptionIds: [source.strategyId],
      blocks: [{ text: ONE_SEARCH_PROMPT, type: "text" }] });
    const rows = await db().usageEvent.findMany({ where: { modelRunId: run.id, purpose: "web_search" } });
    Object.assign(summary, { status: run.status, code: runErrorCode(run), webSearchRows: rows.map((row) => ({
      provider: row.provider, modelId: row.modelId, operationCount: row.operationCount, webSearchCount: row.webSearchCount,
      estimatedCostMicros: row.estimatedCostMicros })) });
    expect(run.status, `the answer completes (${runErrorCode(run) ?? run.status})`).toBe("complete");
    expect(rows, "exactly one web_search usage row").toHaveLength(1);
    expect(rows[0]).toMatchObject({ estimatedCostMicros: DEEPSEEK_SEARCH_API_COST_MICROS, modelId: DEEPSEEK_SEARCH_API_MODEL,
      operationCount: 1, provider: "deepseek", webSearchCount: 1 });

    await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
    const answer = page.locator('article[data-role="assistant"]').last();
    const toggle = answer.getByTestId("answer-sources-toggle");
    await expect(toggle, "the answer shows its sources").toBeVisible({ timeout: 60_000 });
    await toggle.click();
    const links = answer.getByTestId("answer-sources").getByRole("link");
    summary.citedSources = await links.count();
    expect(summary.citedSources, "at least one cited source link").not.toBe(0);
    await page.screenshot({ path: testInfo.outputPath("deepseek-search-api-answer-sources.png") });
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    if (chatId) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await report(testInfo, "prod_1018_deepseek_search_api_summary", summary);
  }
});
