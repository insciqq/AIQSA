/**
 * Opt-in, paid, bounded qualification of the prod-1018 sweep on a DISPOSABLE
 * stand. Never a default lane: it runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE, and each case
 * skips with a reason when its own keys or stand facilities are absent:
 *
 * Paid requests per case are bounded as noted ("probe" = one capability
 * probe request; each probe retries at most a few times on transient
 * failures). The shared codex-lb connection's one-time setup (custom setup
 * with its own model check) is paid once per file, on codex-lb only.
 *
 * 1. codex-lb answer (CODEX_LB_API_KEY, CODEX_LB_BASE_URL — the Codex root
 *    ending in `/backend-api/codex`; AIQSA_FEATURES_CODEX_MODEL picks the
 *    model): one short ordinary answer completes with provider usage.
 *    Bound: 1 answer request.
 * 2. MCP oversized call isolation (codex keys + the stand's app running with
 *    AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES lowered to 4096..65536, as
 *    mcp-oversized-result-paid.spec.ts needs): in one run, the over-bound
 *    `tools/call` fails with `mcp_call_result_too_large` and the hint, and
 *    the following call on the same server succeeds over the same session.
 *    AIQSA_FEATURES_FIXTURE_HOST / AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place
 *    the synthetic peer. The deterministic two-turn version is
 *    mcp-oversized-call-isolation.spec.ts. Bound: one answer of about three
 *    model rounds, codex-lb only.
 * 3. OpenRouter DeepSeek V4.1 Flash 1017 (OPENROUTER_API_KEY): never Quick
 *    Setup (which adds and probes every OpenRouter candidate). A new
 *    connection is made through the ordinary admin connection API with only
 *    the 1017 model (`oneModelConnection`); the model's first capability
 *    check, started by its catalog addition and awaited by its run id, is the
 *    admin model Check and must verify tools and structured output; then one
 *    short answer. Bound on OpenRouter: free model-list reads, at most 8
 *    probes of the 1017 model (model access, structured output, tool calling,
 *    forced tool call, parallel tool calls, vision, PDF, streaming) and 1
 *    answer request.
 * 4. Built-in DeepSeek Search API (DEEPSEEK_API_KEY + codex keys) on the
 *    fresh stand: Admin Search lists it as a built-in source needing setup;
 *    DeepSeek Quick Setup with the key enables it without "Add source"; one
 *    codex-lb answer with only that source leaves exactly one billed
 *    `web_search` row. Admin Search is captured before and after on
 *    desktop, tablet and phone. Bound on DeepSeek: Quick Setup's checks of
 *    its 2 candidates, its hosted Search check, 1 probe search of the API
 *    and 1 search in the answer; on codex-lb about 2 answer rounds.
 * 5. DeepSeek Search API (DEEPSEEK_API_KEY + codex keys): a keyed native
 *    DeepSeek connection with an enabled model is reused (no probe), else
 *    one is made the same way with only DeepSeek V4.1 Flash (at most 8
 *    probes of that model, no Quick Setup), whose setup adds the source after
 *    one probe search; a source the connection lacks is added through Admin
 *    Search "Add source" with at most one request per answer and enabled;
 *    one codex-lb answer with only that source shows cited sources and
 *    leaves exactly one billed `web_search` row. Bound on DeepSeek: at most
 *    8 model probes (new connection only), 1 probe search in setup or on
 *    Save and 1 search in the answer; on codex-lb about 2 answer rounds.
 * 6. DeepSeek Search API unbilled paths (DEEPSEEK_API_KEY): straight through
 *    the product adapter, one query whose site cannot exist answers as an
 *    unbilled no-results result, and one request with an unknown key is the
 *    free `provider_auth_rejected` (HTTP 401). Bound: 2 requests, none billed
 *    unless DeepSeek unexpectedly finds results for the first.
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
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { mcpOversizedResponseMessage, mcpToolFailureMessage } from "../../lib/contracts/mcpToolFailure";
import type { AdminSearchCatalog, AdminSearchIntegration } from "../../lib/contracts/adminSearch";
import type { ContentBlock } from "../../lib/domain/content";
import type { ValidatedSearchQuery } from "../../lib/domain/search";
import { createDeepSeekSearchApiAdapter, createFetchDeepSeekSearchApiClient, DEEPSEEK_SEARCH_API_STRATEGY_ID } from "../../lib/server/providers/deepSeekSearchApi";
import { ProviderSearchExecutionError } from "../../lib/server/providers/types";
import { providerModelTemplateId } from "../../lib/domain/providerTemplates";
import {
  journeyRunParams, modelInConnection, readConnections, type JourneyConnection, type JourneyProviderModel
} from "../../scripts/context-compaction-journey-support";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { authenticateWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import {
  newExcludedChat, paidEnv, pollUntil, PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, quickSetupConnection, setupCodexLbAnswerModel,
  waitForCatalogModel,
  type PaidAnswerModel
} from "./support/paidProviders";

const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));
const mcpLimit = Number(paidEnv("AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES") ?? Number.NaN);
const mcpLimitLowered = Number.isSafeInteger(mcpLimit) && mcpLimit >= 4_096 && mcpLimit <= 65_536;

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.describe.configure({ mode: "serial" });

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const WARMUP_TIMEOUT_MS = 300_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const FLASH_1017 = "deepseek/deepseek-v4.1-flash-1017";
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
  blocks: readonly ContentBlock[];
  mcp?: "load_all" | "off";
  params?: Record<string, unknown>;
  searchOptionIds?: readonly string[];
  timeoutMs?: number;
  workspace?: boolean;
}>;

/**
 * One API turn as the composer would send it, then the settled run (unasserted).
 * Skills are off; MCP, Search and Workspace only as asked.
 */
async function apiTurn(request: APIRequestContext, chatId: string, model: PaidAnswerModel, input: TurnInput): Promise<ModelRun> {
  const before = await db().modelRun.count({ where: { chatId } });
  const chat = await db().chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
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

/** A provider connection once its checks settled. */
async function connection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, "prod_1018_checks_timeout");
}

// -------------------------------------------- 2. MCP oversized isolation ---

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
  "Then, whatever read_thread returned (also if it failed or told you to request less data), call read_message exactly once with id M-1. Do not call any other tool and do not call any tool twice. " +
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

// ------------------------------- Manual one-model provider connection ---

type RawCheckRun = Readonly<{
  id?: unknown; results?: Array<{ checks?: Record<string, unknown>; providerModelId?: unknown; state?: unknown }>; state?: unknown;
  setup?: { search?: unknown; searchResults?: Array<{ name?: unknown; status?: unknown }>; state?: unknown };
}>;
type RawCheck = Readonly<{
  credentialVersionId?: unknown; evidence?: { capabilitySetup?: { checks?: Record<string, unknown> } }; modelVersion?: unknown;
  providerModelId?: unknown; status?: unknown;
}>;
type RawConnection = Readonly<{ activeChecks?: RawCheck[]; checkRun?: RawCheckRun | null; displayName?: unknown; id?: unknown }>;

function rawConnections(body: unknown): RawConnection[] {
  const connections = (body as { connections?: unknown } | null)?.connections;
  return Array.isArray(connections) ? connections as RawConnection[] : [];
}

async function rawConnection(request: APIRequestContext, connectionId: string): Promise<RawConnection | null> {
  return rawConnections(await (await request.get("/api/admin/providers")).json()).find((entry) => entry.id === connectionId) ?? null;
}

async function adminOk(response: APIResponse, step: string): Promise<unknown> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  expect(response.ok(), `${step} (${response.status()} ${typeof body?.error === "string" ? body.error : ""})`).toBe(true);
  return body;
}

/** Waits for exactly the check run `runId` of the connection to leave `running`; returns it. */
async function settledCheckRun(request: APIRequestContext, connectionId: string, runId: string): Promise<RawCheckRun> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const response = await request.get(`/api/admin/providers/${connectionId}/actions?run=${encodeURIComponent(runId)}`);
    const run = response.ok() ? (await response.json() as { run?: RawCheckRun }).run ?? null : null;
    return run && run.state !== "running" ? run : null;
  }, "prod_1018_check_run_timeout");
}

const PROVIDER_ROOTS = { deepseek: "https://api.deepseek.com", openrouter: "https://openrouter.ai/api/v1" } as const;

/**
 * A new connection of `family` with the key and exactly one catalog answer model, through the
 * ordinary admin connection API, never Quick Setup (which would add and probe every candidate):
 * the connection is published with a keyless placeholder model (no provider call), the
 * placeholder is removed, the key is added (its test is a free model-list read; with no models
 * nothing is probed), the connection is enabled, and `add_catalog_models` adds the one model and
 * starts its first capability check, the only paid probe set. Returns the connection, the
 * model and that exact check run once it settled.
 */
async function oneModelConnection(request: APIRequestContext, input: Readonly<{
  family: keyof typeof PROVIDER_ROOTS; label: string; secret: string; templateKey: string; upstreamModelId: string;
}>): Promise<{ connection: JourneyConnection; model: JourneyProviderModel; run: RawCheckRun }> {
  const displayName = `${input.label} ${randomUUID().slice(0, 8)}`;
  const before = new Set(rawConnections(await (await request.get("/api/admin/providers")).json()).map((entry) => entry.id));
  const created = rawConnections(await adminOk(await request.post("/api/admin/providers", { data: {
    configuration: { allowPrivateNetwork: false, apiRoot: PROVIDER_ROOTS[input.family], authenticationMode: "bearer", responseTimeoutSeconds: 300 },
    displayName, family: input.family, unassignedPolicy: "use_default"
  } }), "the connection draft is created")).find((entry) => !before.has(entry.id) && entry.displayName === displayName);
  expect(created, "the new connection is listed").toBeTruthy();
  const connectionId = String(created!.id);

  const placeholder = await adminOk(await request.post(`/api/admin/providers/${connectionId}/models`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    activate: true, displayName: "Placeholder",
    configuration: { adapterKind: input.family === "openrouter" ? "openrouter_chat_completions" : "deepseek_responses_native",
      answerSelectable: true, modelClass: "answer", upstreamModelId: "aiqsa/placeholder", defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      ...(input.family === "openrouter" ? { openRouterRouting: { mode: "automatic", providers: [] } } : {}) }
  } }), "the keyless placeholder publishes the connection") as { receipt?: { checks?: unknown; modelId?: unknown } };
  // No key yet, so publishing checked nothing.
  expect(placeholder.receipt?.checks, "the placeholder was not probed").toBe("skipped");
  const placeholderId = String(placeholder.receipt?.modelId);
  await adminOk(await request.patch(`/api/admin/providers/${connectionId}/models/${placeholderId}`, { data: { action: "disable" } }),
    "the placeholder is disabled");
  await adminOk(await request.delete(`/api/admin/providers/${connectionId}/models/${placeholderId}`, { data: { confirmed: true } }),
    "the placeholder is deleted");

  await adminOk(await request.post(`/api/admin/providers/${connectionId}/credentials`, { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { activate: true, label: "Paid check key", secret: input.secret } }), "the key is tested and added");
  await adminOk(await request.post(`/api/admin/providers/${connectionId}/actions`, { data: { action: "enable" } }), "the connection is enabled");
  const keyed = await connection(request, connectionId);
  expect(keyed.models, "the connection has no model before the catalog addition").toHaveLength(0);
  expect(keyed.defaultCredentialVersionId, "the key is the connection's default").not.toBeNull();

  const added = await adminOk(await request.post(`/api/admin/providers/${connectionId}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    action: "add_catalog_models", credentialId: keyed.defaultCredentialId, expectedConnectionVersion: keyed.activeVersion,
    expectedCredentialVersionId: keyed.defaultCredentialVersionId, modelIds: [providerModelTemplateId(input.templateKey)]
  } }), "the catalog model is added") as { connections?: unknown; unavailableModelIds?: unknown };
  expect(added.unavailableModelIds, "the key's catalog lists the model").toEqual([]);
  const runId = rawConnections(added).find((entry) => entry.id === connectionId)?.checkRun?.id;
  expect(typeof runId, "the addition started the model's check run").toBe("string");
  const run = await settledCheckRun(request, connectionId, String(runId));
  const settled = await connection(request, connectionId);
  const model = modelInConnection(settled, input.upstreamModelId);
  expect(model, "the model is on the connection").toBeTruthy();
  expect(settled.models, "the connection holds exactly that one model").toHaveLength(1);
  return { connection: settled, model: model!, run };
}

// ------------------------------------------ 3. OpenRouter Flash 1017 ---

test("OpenRouter DeepSeek V4.1 Flash 1017: the model Check verifies tools and structured output, and it answers", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENROUTER_API_KEY");
  test.skip(!secret, "paid: OPENROUTER_API_KEY is not set");
  test.setTimeout(45 * 60_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  try {
    // The one model's first check is the admin model Check here: a separate check_models would probe it twice.
    const { connection: openRouter, model: row, run } = await oneModelConnection(request, { family: "openrouter",
      label: "Prod 1018 OpenRouter", secret: secret!, templateKey: `openrouter:${FLASH_1017}`, upstreamModelId: FLASH_1017 });
    const result = run.results?.find((entry) => entry.providerModelId === row.id);
    const raw = await rawConnection(request, openRouter.id);
    const check = raw?.activeChecks?.find((entry) => entry.providerModelId === row.id &&
      entry.credentialVersionId === openRouter.defaultCredentialVersionId && entry.modelVersion === row.activeVersion);
    const checks = check?.evidence?.capabilitySetup?.checks ?? {};
    Object.assign(summary, { runState: run.state, runResults: run.results?.length ?? 0, resultState: result?.state ?? null,
      runToolCalling: result?.checks?.toolCalling ?? null, runStructuredOutput: result?.checks?.structuredOutput ?? null,
      checkStatus: check?.status ?? null, toolCalling: checks.toolCalling ?? null, structuredOutput: checks.structuredOutput ?? null,
      modelEnabled: row.enabled });
    expect(run.state, "the model's check run completed").toBe("completed");
    expect(run.results ?? [], "the run checked only that model").toHaveLength(1);
    expect(result?.state, "the check saved the model").toBe("saved");
    expect(check?.status, "the 1017 deployment's check is available").toBe("available");
    expect(checks.toolCalling, "tool calling verified").toBe("verified");
    expect(checks.structuredOutput, "structured output verified").toBe("verified");

    const catalog = await waitForCatalogModel(request, openRouter.id, (candidate) => candidate.modelId === row.id);
    expect(catalog.capabilities.toolCalling, "the catalog offers tool calling").toBe(true);
    const model: PaidAnswerModel = { connectionId: openRouter.id, displayName: catalog.displayName, modelId: catalog.modelId,
      params: journeyRunParams(catalog, 256), upstreamModelId: FLASH_1017 };
    chatId = await newExcludedChat(request, `Prod 1018 Flash 1017 ${randomUUID().slice(0, 8)}`);
    const turn = await apiTurn(request, chatId, model, { blocks: [{ text: "Reply with one short sentence that names a colour.", type: "text" }] });
    const usage = await answerUsage(turn.id);
    Object.assign(summary, { turn: { status: turn.status, code: runErrorCode(turn), usage } });
    expect(turn.status, `the 1017 answer completes (${runErrorCode(turn) ?? turn.status})`).toBe("complete");
    expect(usage.outputTokens, "the 1017 answer produced output").toBeGreaterThan(0);
  } finally {
    if (chatId) await deleteOwnedChatPermanently(request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await report(testInfo, "prod_1018_openrouter_flash_1017_summary", summary);
  }
});

// ------------------------------------- 4. DeepSeek Search API built in ---

const BUILT_IN_SEARCH_API = "deepseek-search-api";

function builtInSearchApi(catalog: AdminSearchCatalog): AdminSearchIntegration | null {
  return catalog.integrations.find((source) => source.strategyId === BUILT_IN_SEARCH_API) ?? null;
}

/** Admin → Search with the built-in row in view, as viewport shots on desktop, tablet and phone. */
async function adminSearchShots(page: Page, testInfo: TestInfo, stage: string, sourceId: string): Promise<string[]> {
  const statuses: string[] = [];
  for (const [name, viewport] of [["desktop", { height: 900, width: 1440 }], ["tablet", { height: 1024, width: 768 }],
    ["phone", { height: 844, width: 390 }]] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/admin?section=search", { timeout: WARMUP_TIMEOUT_MS });
    const row = page.getByTestId(`search-source-row-${sourceId}`);
    await expect(row, "Admin Search lists the built-in DeepSeek Search API").toBeVisible({ timeout: 60_000 });
    await row.scrollIntoViewIfNeeded();
    statuses.push(`${name}:${await row.getAttribute("data-search-status")}`);
    await page.screenshot({ path: testInfo.outputPath(`admin-search-${stage}-${name}.png`) });
  }
  await page.setViewportSize({ height: 900, width: 1440 });
  return statuses;
}

test("DeepSeek Search API built in: setup with the key enables it without Add source, one billed search", async ({ page }, testInfo) => {
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
    const fresh = builtInSearchApi(await searchCatalog(request));
    Object.assign(summary, { before: fresh && { enabled: fresh.enabled, readiness: fresh.readiness, system: fresh.system,
      configurable: fresh.configurable } });
    expect(fresh, "a fresh install lists the built-in source").toBeTruthy();
    expect(fresh).toMatchObject({ displayName: "DeepSeek Search API", kind: "deepseek_search_api", ready: false,
      readiness: "setup_required", system: true });
    summary.beforeShots = await adminSearchShots(page, testInfo, "before", fresh!.id);

    const connectionId = await quickSetupConnection(request, "deepseek", secret!, /flash/iu);
    summary.templateConnection = connectionId === fresh!.sourceConnectionId;
    expect(summary.templateConnection, "Quick Setup keyed the source's DeepSeek connection").toBe(true);
    const source = await pollUntil(120_000, async () => {
      const current = builtInSearchApi(await searchCatalog(request));
      return current?.ready && current.configurationActive ? current : null;
    }, "built_in_search_api_not_ready");
    Object.assign(summary, { after: { enabled: source.enabled, readiness: source.readiness, system: source.system,
      check: source.draftTestEvidence && { method: source.draftTestEvidence.method, sources: source.draftTestEvidence.normalizedSourceCount },
      maxSearchCallsPerAnswer: source.configuration?.maxSearchCallsPerAnswer ?? null },
    apiSourcesOnConnection: await db().searchOption.count({ where: { kind: "deepseek_search_api", sourceConnectionId: connectionId } }) });
    expect(source.enabled, "setup enabled the source").toBe(true);
    expect(source.draftTestEvidence?.method, "setup published it after a live check").toBe("provider_search");
    expect(summary.apiSourcesOnConnection, "exactly one DeepSeek Search API source on the connection").toBe(1);
    // DeepSeek's hosted Search is retired (operator decision 2026-10-24): setup checks only the Search API, and
    // the untouched installation default takes it.
    const setup = (await rawConnection(request, connectionId))?.checkRun?.setup;
    const hosted = (await searchCatalog(request)).integrations.find((entry) => entry.strategyId === "deepseek-native-web-search");
    const plan = await db().searchPolicy.findUniqueOrThrow({ select: { defaultPlan: true }, where: { id: "installation" } });
    Object.assign(summary, { setup: setup && { search: setup.search, state: setup.state, searchResults: setup.searchResults },
      hostedListed: Boolean(hosted && !hosted.archivedAt), defaultPlan: plan.defaultPlan });
    expect(setup, "setup checked the DeepSeek Search API").toMatchObject({ search: "ready", state: "completed", searchResults: [
      { name: "DeepSeek Search API", status: "ready" }] });
    expect(summary.hostedListed, "no hosted DeepSeek Search is offered").toBe(false);
    expect(plan.defaultPlan).toMatchObject({ optionIds: [BUILT_IN_SEARCH_API] });
    summary.afterShots = await adminSearchShots(page, testInfo, "after", source.id);

    const codex = await codexAnswerModel(request);
    summary.answerModel = codex.upstreamModelId;
    const catalog = await waitForCatalogModel(request, codex.connectionId, (candidate) => candidate.modelId === codex.modelId &&
      candidate.searchStrategyIds.includes(BUILT_IN_SEARCH_API));
    const model: PaidAnswerModel = { ...codex, params: journeyRunParams(catalog, 512) };
    chatId = await newExcludedChat(request, `Prod 1018 built-in DeepSeek Search ${randomUUID().slice(0, 8)}`);
    const run = await apiTurn(request, chatId, model, { searchOptionIds: [BUILT_IN_SEARCH_API],
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
    summary.citedSources = await answer.getByTestId("answer-sources").getByRole("link").count();
    expect(summary.citedSources, "at least one cited source link").not.toBe(0);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    if (chatId) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    await report(testInfo, "prod_1018_built_in_deepseek_search_api_summary", summary);
  }
});

// ---------------------------------------------- 5. DeepSeek Search API ---

async function searchCatalog(request: APIRequestContext): Promise<AdminSearchCatalog> {
  const response = await request.get("/api/admin/search");
  expect(response.ok()).toBe(true);
  return (await response.json() as { search: AdminSearchCatalog }).search;
}

/** The connection's set-up API source; a built-in that setup has not completed does not count. */
function searchApiSource(catalog: AdminSearchCatalog, connectionId: string): AdminSearchIntegration | null {
  return catalog.integrations.find((source) => source.kind === "deepseek_search_api" && source.sourceConnectionId === connectionId &&
    source.archivedAt === null && source.ready) ?? null;
}

/** Adds the source through Admin → Search → Add source (Save runs one probe search) and enables it; a set-up one is reused. */
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
    // The select's accessible name also carries its selected option, so it is found by its label.
    const searchModel = sheet.locator("label").filter({ has: page.locator("span", { hasText: /^Search model$/u }) }).locator("select");
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

/**
 * A keyed, enabled native DeepSeek connection with an enabled answer model: an existing one
 * (such as this spec's own from an earlier run) is reused without any probe; otherwise a new
 * one gets only DeepSeek V4.1 Flash, whose first check is the only paid probe set.
 */
async function deepSeekConnection(request: APIRequestContext, secret: string, summary: Record<string, unknown>): Promise<JourneyConnection> {
  const existing = readConnections(await (await request.get("/api/admin/providers")).json())
    ?.find((candidate) => candidate.family === "deepseek" && candidate.enabled && candidate.active &&
      candidate.defaultCredentialVersionId !== null && !candidate.checkRunning &&
      candidate.models.some((model) => model.enabled && model.activeConfig !== null)) ?? null;
  summary.deepSeekReused = Boolean(existing);
  if (existing) return existing;
  const { connection: created, run } = await oneModelConnection(request, { family: "deepseek", label: "Prod 1018 DeepSeek", secret,
    templateKey: "deepseek:deepseek-flash", upstreamModelId: "deepseek-flash" });
  Object.assign(summary, { deepSeekCheckRun: run.state, deepSeekCheckResults: run.results?.map((entry) => entry.state) ?? [] });
  expect(run.results ?? [], "the run checked only DeepSeek V4.1 Flash").toHaveLength(1);
  return created;
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
    const deepSeek = await deepSeekConnection(request, secret!, summary);
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

// ------------------------------- 6. DeepSeek Search API: unbilled real paths ---

/** One real request straight through the product adapter and client: the shapes DeepSeek really answers. */
function directSearchApiRequest(apiKey: string, query: string) {
  const adapter = createDeepSeekSearchApiAdapter({
    client: createFetchDeepSeekSearchApiClient({ apiKey, defaultTimeoutMs: 30_000 }),
    maxAttempts: 1,
    rateLimitKey: "prod-1018-direct"
  });
  return adapter.search({
    correlationId: "prod-1018-direct",
    query: query as ValidatedSearchQuery,
    searchPolicy: { maxResults: 3, modelId: DEEPSEEK_SEARCH_API_MODEL, provider: "deepseek", strategyId: DEEPSEEK_SEARCH_API_STRATEGY_ID },
    strategyId: "prod-1018-direct"
  }, { timeoutMs: 30_000 });
}

test("DeepSeek Search API: a query without matches is an unbilled no-results answer, and a rejected key maps to auth", async ({}, testInfo) => {
  const secret = paidEnv("DEEPSEEK_API_KEY");
  test.skip(!secret, "paid: DEEPSEEK_API_KEY is not set");
  test.setTimeout(5 * 60_000);
  const summary: Record<string, unknown> = {};
  try {
    // One request whose site cannot exist; DeepSeek bills only answers with results.
    const empty = await directSearchApiRequest(secret!, `"${randomUUID()}" site:${randomUUID().slice(0, 8)}.invalid`);
    Object.assign(summary, { noResults: empty.noResults === true, sources: empty.sources.length, costUsd: empty.costUsd,
      webSearchCount: empty.usage?.webSearchCount ?? 0 });
    expect(empty.noResults, "a query without matches is a no-results answer").toBe(true);
    expect(empty.sources).toHaveLength(0);
    expect(empty.costUsd, "an empty answer is not billed").toBe(0);

    // One request with a key DeepSeek does not know: refused before any search, free.
    const refused = await directSearchApiRequest(`sk-${randomUUID().replaceAll("-", "")}`, "DeepSeek V4")
      .then(() => null, (error: unknown) => error);
    const failure = refused instanceof ProviderSearchExecutionError ? refused : null;
    Object.assign(summary, { refusedCode: failure?.code ?? (refused === null ? "none" : "unexpected"),
      refusedHttpStatus: (refused as { httpStatus?: number } | null)?.httpStatus ?? null, refusedCostUsd: failure?.costUsd ?? null });
    expect(failure, "a rejected key is a typed Search failure").not.toBeNull();
    expect(failure!.code).toBe("provider_auth_rejected");
    expect(summary.refusedHttpStatus).toBe(401);
    expect(failure!.costUsd, "a rejected request costs nothing").toBe(0);
  } finally {
    await report(testInfo, "prod_1018_deepseek_search_api_unbilled_summary", summary);
  }
});
