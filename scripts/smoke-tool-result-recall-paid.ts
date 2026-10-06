/**
 * Opt-in, paid, bounded end-to-end check of tool-result recall under context
 * pressure against a DISPOSABLE AIQSA stand (AIQSA_TEST_MODE=1,
 * PLAYWRIGHT_TEST_AUTH=1, seeded bootstrap admin). Never a default lane and
 * never a persistent installation. It drives the stand only through its HTTP
 * API, as scripts/smoke-context-compaction-journey.ts does:
 * 1. reuses or sets up the codex-lb route and publishes a small model context
 *    window through the Admin API;
 * 2. starts the neutral bulk-result MCP fixture
 *    (tests/e2e/support/bulkResultMcpEndpoint.ts) in this process, registers,
 *    publishes, grants and enables it for the bootstrap admin;
 * 3. creates a personal chat (excluded from Memory unless
 *    AIQSA_RECALL_MEMORY=1) and sends one request that needs every record's
 *    large details, with MCP Load all;
 * 4. waits for the run and prints ONE sanitized JSON document: outcome,
 *    counts of tool calls, `read_tool_result` calls, the latest compaction
 *    cycle, and provider-reported input tokens from the Admin usage ledger.
 *    With AIQSA_RECALL_DB_STATS=1 (only inside an acknowledged disposable
 *    container, checked by scripts/stateful-test-target.ts) it adds read-only
 *    aggregates the HTTP API does not expose: the run's error code, exact
 *    repeated reader arguments, committed summary receipts and settled
 *    context-compaction outcomes. Prompts, answers, tool payloads, arguments
 *    and identifiers are never printed;
 * 5. deletes the chat and the fixture server; the provider connection stays
 *    unless AIQSA_RECALL_CLEANUP_PROVIDERS=1.
 *
 * Exit 0 only when the run completed with an answer and did not exhaust its
 * tool-call limit. The repetition counts are evidence, not a pass threshold.
 *
 * AIQSA_RECALL_MODE selects the scenario (default `recall`, the above):
 * - `budget`: the installation's `maxToolCalls` is lowered through the Admin
 *   ModelPolicy to AIQSA_RECALL_BUDGET_CALLS (default 12, 2..79) for the same
 *   request, which wants far more calls, and restored afterwards. Passes when
 *   the run still ends with an answer within that limit (the refused batch
 *   ends in one tool-free synthesis that names the unverified records).
 * - `repeat`: the fixture adds a status tool whose answer never changes and
 *   the request asks to wait for it. Passes when the run ends with an answer
 *   and the fixture saw at most two status calls (later identical calls are
 *   blocked before dispatch). DB stats add the blocked count.
 *
 * Environment (process only; no .env loading):
 * - AIQSA_RECALL_DISPOSABLE_STAND=1 (required acknowledgement)
 * - AIQSA_RECALL_BASE_URL (default http://127.0.0.1:3000; plain HTTP only on loopback)
 * - CODEX_LB_API_KEY, CODEX_LB_BASE_URL (falls back to ~/.codex/config.toml), AIQSA_RECALL_CODEX_MODEL (default gpt-5.5)
 * - AIQSA_RECALL_CONTEXT_WINDOW (default 32768, 16384..65536)
 * - AIQSA_RECALL_FIXTURE_HOST (listen address, default 127.0.0.1) and
 *   AIQSA_RECALL_FIXTURE_PUBLIC_HOST (host the stand uses to reach it, default the listen address)
 * - AIQSA_RECALL_MEMORY=1, AIQSA_RECALL_DB_STATS=1, AIQSA_RECALL_CLEANUP_PROVIDERS=1
 * - AIQSA_RECALL_MODE (recall|budget|repeat), AIQSA_RECALL_BUDGET_CALLS
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeAdminModelPolicyResponse } from "../lib/contracts/adminModelPolicy";
import { decodeAdminProviderModelSaveReceipt } from "../lib/contracts/adminProviderModelSave";
import { decodeCatalogResponse, type CatalogModel } from "../lib/contracts/catalog";
import { decodeChatDetailResponse, decodeChatSummaryResponse, type ChatDetailWire } from "../lib/contracts/chats";
import { decodeRunOutcomeResponse } from "../lib/contracts/runs";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryConsumerChatModeResponse,
  decodeMemoryConsumerPermanentChatDeleteResponse
} from "../lib/contracts/memoryClient";
import {
  BULK_DETAIL_TOOL_NAME,
  BULK_LIST_TOOL_NAME,
  BULK_RESULT_LIMITS,
  BULK_STATUS_TOOL_NAME,
  registerBulkResultMcpServer,
  startBulkResultMcpEndpoint,
  type BulkRegistrationClient
} from "../tests/e2e/support/bulkResultMcpEndpoint";
import {
  JOURNEY_TEST_AUTH_TOKEN,
  JourneyFailure,
  catalogReadiness,
  codexLbSetupBody,
  contextWindowUpdate,
  journeyConfig,
  journeyReuseDecision,
  journeyRunParams,
  ledgerDelta,
  LEDGER_USAGE_PATH,
  ledgerUsage,
  modelInConnection,
  readConnections,
  settledTurn,
  type CatalogReadiness,
  type JourneyConnection,
  type JourneyRouteConfig,
  type JourneyStage,
  type LedgerUsage
} from "./context-compaction-journey-support";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";
import { codexLbRoute } from "./workspace-user-paid-support";

const REQUEST_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 900_000;
const RUN_TIMEOUT_MS = 1_800_000;
const CATALOG_TIMEOUT_MS = 300_000;
const DELETE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;
const STREAM_BYTES = 32 * 1024 * 1024;
const ANSWER_MAX_OUTPUT_TOKENS = 4_096;
const READ_TOOL_RESULT_NAME = "read_tool_result";
const TOOL_CALL_LIMIT_MESSAGE = /^Tool call limit of \d+ was exceeded\.?$/u;
const CODE = /^[a-z0-9_]{1,80}$/u;

const RECALL_REQUEST = `Use the ${BULK_LIST_TOOL_NAME} tool to list every record, then call ${BULK_DETAIL_TOOL_NAME} ` +
  "for each record id. Go through all of them. Finally give one short line per record: its id, title and current " +
  "status, and mark records whose details could not be loaded.";
const REPEAT_REQUEST = `Use the ${BULK_STATUS_TOOL_NAME} tool to check whether the record sync has finished. While it ` +
  `is still running, check it again until it reports that it finished. Then call ${BULK_LIST_TOOL_NAME} and give the ` +
  "number of records, saying what you could and could not confirm.";

type SmokeMode = "budget" | "recall" | "repeat";
const BUDGET_CALLS = Object.freeze({ fallback: 12, max: 79, min: 2 });

type Api = Readonly<{ baseUrl: URL; cookie: string; userId: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(stage: JourneyStage, code: string): never {
  throw new JourneyFailure(stage, code);
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll<T>(stage: JourneyStage, timeoutMs: number, probe: () => Promise<T | null>, timeoutCode = "poll_timeout"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value !== null) return value;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return fail(stage, timeoutCode);
}

function headers(api: Pick<Api, "baseUrl"> & Partial<Pick<Api, "cookie">>, jsonBody: boolean): HeadersInit {
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(api.cookie ? { cookie: api.cookie } : {}),
    origin: api.baseUrl.origin
  };
}

async function failureCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as unknown;
  return record(body) && typeof body.error === "string" && /^[a-z0-9_]{1,64}$/u.test(body.error)
    ? body.error : `http_${response.status}`;
}

async function request(
  api: Api,
  stage: JourneyStage,
  path: string,
  init: Readonly<{ body?: unknown; method?: string; timeoutMs?: number }> = {}
): Promise<Response> {
  const hasBody = Object.hasOwn(init, "body");
  try {
    return await fetch(new URL(path, api.baseUrl), {
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
      headers: headers(api, hasBody),
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS)
    });
  } catch {
    return fail(stage, "request_failed");
  }
}

async function json(
  api: Api,
  stage: JourneyStage,
  path: string,
  init: Readonly<{ body?: unknown; method?: string; timeoutMs?: number }> = {}
): Promise<unknown> {
  const response = await request(api, stage, path, init);
  if (!response.ok) throw new JourneyFailure(stage, await failureCode(response), response.status);
  try {
    return await response.json() as unknown;
  } catch {
    return fail(stage, "response_invalid");
  }
}

/** The fixture registration helper's client over this script's authenticated fetch. */
function registrationClient(api: Api): BulkRegistrationClient {
  const call = (method: string) => async (path: string, init?: { data: unknown }) => {
    const response = await request(api, "provider_setup", path, { method, ...(init ? { body: init.data } : {}), timeoutMs: SETUP_TIMEOUT_MS });
    return { json: () => response.json() as Promise<unknown>, ok: () => response.ok, status: () => response.status };
  };
  return { delete: call("DELETE"), patch: call("PATCH"), post: call("POST"), put: call("PUT") };
}

async function drain(response: Response, stage: JourneyStage): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > STREAM_BYTES) fail(stage, "stream_bound_exceeded");
    }
  } catch (error) {
    if (error instanceof JourneyFailure) throw error;
    fail(stage, "stream_failed");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function authenticate(baseUrl: URL): Promise<Api> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/token", baseUrl), {
      body: JSON.stringify({ token: JOURNEY_TEST_AUTH_TOKEN }),
      headers: headers({ baseUrl }, true),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    return fail("auth", "auth_request_failed");
  }
  if (!response.ok) fail("auth", await failureCode(response));
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .find((value) => value.includes("=")) ?? "";
  const body = await response.json().catch(() => null) as unknown;
  if (!cookie || !record(body) || !record(body.user) || typeof body.user.id !== "string" || !body.user.id) {
    return fail("auth", "auth_response_invalid");
  }
  if (body.user.role !== "admin") fail("auth", "bootstrap_admin_required");
  return { baseUrl, cookie, userId: body.user.id };
}

// Provider setup (the journey smoke's codex-lb route) ----------------------------

type ProviderTarget = Readonly<{ connectionId: string; created: boolean; providerModelId: string }>;
type CodexRoute = Extract<JourneyRouteConfig, { route: "codex-lb" }>;

async function connections(api: Api, stage: JourneyStage = "provider_setup"): Promise<JourneyConnection[]> {
  return readConnections(await json(api, stage, "/api/admin/providers")) ?? fail(stage, "providers_response_invalid");
}

async function checksIdle(api: Api, connectionId: string, stage: JourneyStage = "provider_setup"): Promise<JourneyConnection> {
  return poll(stage, SETUP_TIMEOUT_MS, async () => {
    const connection = (await connections(api, stage)).find((candidate) => candidate.id === connectionId);
    if (!connection) return fail(stage, "connection_missing");
    return connection.checkRunning ? null : connection;
  }, "checks_still_running");
}

async function ensureCodexLb(api: Api, route: CodexRoute, contextWindow: number): Promise<ProviderTarget> {
  const before = await connections(api);
  const decision = journeyReuseDecision(before, { apiRoot: route.apiRoot, family: "openai_compatible", upstreamModelId: route.model });
  if (decision.match) return { connectionId: decision.match.connection.id, created: false, providerModelId: decision.match.model.id };
  let catalogProof: string | undefined;
  try {
    const discovery = await json(api, "provider_setup", "/api/admin/providers/custom-setup/discover", {
      body: { allowPrivateNetwork: true, apiRoot: route.apiRoot, authenticationMode: "bearer",
        responseTimeoutSeconds: 180, secret: route.apiKey },
      method: "POST",
      timeoutMs: SETUP_TIMEOUT_MS
    });
    if (!record(discovery) || !Array.isArray(discovery.models)) fail("provider_setup", "discovery_response_invalid");
    if (!discovery.models.some((model) => record(model) && model.id === route.model)) fail("provider_setup", "codex_model_not_discovered");
    if (typeof discovery.catalogProof === "string") catalogProof = discovery.catalogProof;
  } catch (error) {
    if (!(error instanceof JourneyFailure) ||
      (error.code !== "provider_custom_setup_discovery_failed" && error.code !== "codex_model_not_discovered")) throw error;
  }
  const result = await json(api, "provider_setup", "/api/admin/providers/custom-setup", {
    body: codexLbSetupBody({
      apiRoot: route.apiRoot,
      ...(catalogProof ? { catalogProof } : {}),
      connectionDisplayName: `Tool recall codex-lb ${randomUUID().slice(0, 8)}`,
      contextWindow,
      model: route.model,
      secret: route.apiKey
    }),
    method: "POST",
    timeoutMs: SETUP_TIMEOUT_MS
  });
  if (!record(result) || typeof result.connectionId !== "string" || typeof result.outcome !== "string") {
    return fail("provider_setup", "setup_response_invalid");
  }
  if (result.outcome !== "ready" && result.outcome !== "partial") fail("provider_setup", `setup_${result.outcome}`);
  const connectionId = result.connectionId;
  const model = modelInConnection(await checksIdle(api, connectionId), route.model) ??
    fail("provider_setup", "codex_model_not_configured");
  return { connectionId, created: !before.some((connection) => connection.id === connectionId), providerModelId: model.id };
}

async function ensureContextWindow(api: Api, target: ProviderTarget, contextWindow: number): Promise<void> {
  const connection = await checksIdle(api, target.connectionId);
  const model = connection.models.find((candidate) => candidate.id === target.providerModelId) ??
    fail("provider_setup", "recall_model_missing");
  const body = contextWindowUpdate(model, contextWindow);
  if (!body) return;
  const response = await json(api, "provider_setup",
    `/api/admin/providers/${encodeURIComponent(target.connectionId)}/models/${encodeURIComponent(target.providerModelId)}`,
    { body, method: "PATCH", timeoutMs: SETUP_TIMEOUT_MS });
  const receipt = decodeAdminProviderModelSaveReceipt(record(response) ? response.receipt : null);
  if (receipt?.publication !== "active") fail("provider_setup", "context_window_not_published");
}

async function catalogModel(api: Api, target: ProviderTarget, contextWindow: number): Promise<CatalogModel> {
  await checksIdle(api, target.connectionId, "catalog");
  let state: CatalogReadiness = "catalog_model_missing";
  return poll("catalog", CATALOG_TIMEOUT_MS, async () => {
    const catalog = decodeCatalogResponse(await json(api, "catalog", "/api/me/catalog")) ?? fail("catalog", "catalog_response_invalid");
    const model = catalog.models.find((entry) => entry.provider === target.connectionId && entry.modelId === target.providerModelId);
    state = catalogReadiness(model, contextWindow);
    return state === "ready" ? model! : null;
  }, state);
}

// Run --------------------------------------------------------------------------

async function chatDetail(api: Api, chatId: string): Promise<ChatDetailWire> {
  return decodeChatDetailResponse(await json(api, "evidence", `/api/chats/${encodeURIComponent(chatId)}`)) ??
    fail("evidence", "chat_response_invalid");
}

async function createChat(api: Api, memory: boolean): Promise<string> {
  const chat = decodeChatSummaryResponse(await json(api, "chat", "/api/chats", {
    body: { title: "Tool result recall" }, method: "POST"
  })) ?? fail("chat", "chat_response_invalid");
  if (!memory) {
    const mode = decodeMemoryConsumerChatModeResponse(await json(api, "chat",
      `/api/me/chats/${encodeURIComponent(chat.id)}/memory-mode`, { body: { mode: "EXCLUDED" }, method: "PATCH" }));
    if (!mode.ok || mode.value.mode !== "EXCLUDED") fail("chat", "memory_exclusion_failed");
  }
  return chat.id;
}

type RunEvidence = Readonly<{
  answerPresent: boolean;
  compactionCycle: number | null;
  compactionOutcome: string | null;
  errorMessagePresent: boolean;
  mcpCalls: number;
  readToolResultCalls: number;
  runId: string | null;
  status: string;
  toolCallLimitExceeded: boolean;
  toolCalls: number;
  toolRounds: number;
}>;

async function sendAndWait(api: Api, chatId: string, model: CatalogModel, prompt: string): Promise<RunEvidence> {
  const response = await request(api, "turn", `/api/chats/${encodeURIComponent(chatId)}/messages`, {
    body: {
      content: { blocks: [{ text: prompt, type: "text" }] },
      expectedActiveLeafId: null,
      mcp: { mode: "load_all" },
      modelId: model.modelId,
      params: journeyRunParams(model, ANSWER_MAX_OUTPUT_TOKENS),
      provider: model.provider,
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchStrategy: "search-disabled",
      timeZone: "UTC"
    },
    method: "POST",
    timeoutMs: RUN_TIMEOUT_MS
  });
  if (!response.ok) throw new JourneyFailure("turn", await failureCode(response), response.status);
  await drain(response, "turn");
  const detail = await poll("turn", RUN_TIMEOUT_MS, async () => {
    const current = await chatDetail(api, chatId);
    return settledTurn(current, null) ? current : null;
  }, "run_not_settled");
  const { assistant } = settledTurn(detail, null)!;
  if (assistant.modelRunId) {
    const runPath = `/api/model-runs/${encodeURIComponent(assistant.modelRunId)}`;
    await poll("turn", RUN_TIMEOUT_MS, async () => {
      const outcome = decodeRunOutcomeResponse(await json(api, "turn", runPath)) ?? fail("turn", "run_outcome_invalid");
      return ["cancelled", "complete", "error"].includes(outcome.status) ? outcome : null;
    }, "run_not_settled");
  }
  const settled = await chatDetail(api, chatId);
  const final = settled.messages.find((message) => message.id === assistant.id) ?? assistant;
  const calls = final.toolActivity?.calls ?? [];
  const text = typeof final.content === "string" ? final.content
    : record(final.content) && Array.isArray(final.content.blocks) ? JSON.stringify(final.content.blocks) : "";
  const compaction = final.artifactSummary?.contextCompaction ?? null;
  return {
    answerPresent: final.status === "complete" && text.length > 0,
    compactionCycle: compaction?.cycle ?? null,
    compactionOutcome: compaction?.outcome ?? null,
    errorMessagePresent: typeof final.errorMessage === "string" && final.errorMessage.length > 0,
    mcpCalls: calls.filter((call) => call.origin === "mcp").length,
    readToolResultCalls: calls.filter((call) => call.toolName === READ_TOOL_RESULT_NAME).length,
    runId: final.modelRunId ?? null,
    status: final.status,
    // A fixed server message, never user content: only the boolean leaves this function.
    toolCallLimitExceeded: typeof final.errorMessage === "string" && TOOL_CALL_LIMIT_MESSAGE.test(final.errorMessage.trim()),
    toolCalls: calls.length,
    toolRounds: new Set(calls.map((call) => call.round)).size
  };
}

// Tool budget (budget mode) ------------------------------------------------------

type ToolLimits = Readonly<{
  maxMcpToolsPerDiscovery: number;
  maxToolCalls: number;
  maxToolRounds: number;
}>;

const MODEL_POLICY_PATH = "/api/admin/providers/model-policy";

async function modelPolicy(api: Api, stage: JourneyStage): Promise<ToolLimits & Readonly<{ version: number }>> {
  const policy = decodeAdminModelPolicyResponse(await json(api, stage, MODEL_POLICY_PATH))?.modelPolicy.policy ??
    fail(stage, "model_policy_response_invalid");
  return { maxMcpToolsPerDiscovery: policy.maxMcpToolsPerDiscovery, maxToolCalls: policy.maxToolCalls,
    maxToolRounds: policy.maxToolRounds, version: policy.version };
}

/** Writes all tool limits at once, as the Admin API requires. */
async function writeToolLimits(api: Api, stage: JourneyStage, limits: ToolLimits): Promise<void> {
  const current = await modelPolicy(api, stage);
  const response = decodeAdminModelPolicyResponse(await json(api, stage, MODEL_POLICY_PATH, {
    body: { expectedVersion: current.version, ...limits }, method: "PATCH" }));
  if (response?.modelPolicy.policy.maxToolCalls !== limits.maxToolCalls) fail(stage, "model_policy_not_saved");
}

/**
 * Read-only aggregates of the disposable database for one run; numbers and
 * stable codes only. Refused outside an acknowledged disposable container.
 */
function assertStatsTarget(): void {
  try {
    assertDisposableStatefulTestTarget(process.env);
  } catch {
    fail("config", "db_stats_target_not_disposable");
  }
}

async function databaseStats(runId: string): Promise<Record<string, unknown>> {
  assertStatsTarget();
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [run] = await tx.$queryRaw<Array<{ code: string | null; committed: bigint }>>`
        SELECT r."errorPayload" ->> 'code' AS "code",
          (SELECT count(*) FROM jsonb_array_elements(COALESCE(r."toolLoopState" #> '{contextCompaction,summaryAttempts}', '[]'::jsonb)) AS a
            WHERE a ->> 'state' = 'committed') AS "committed"
        FROM "ModelRun" AS r WHERE r."id" = ${runId}`;
      const [reads] = await tx.$queryRaw<Array<{ distinctArguments: bigint; reads: bigint }>>`
        SELECT count(*) AS "reads", count(DISTINCT "arguments") AS "distinctArguments"
        FROM "ModelRunToolCall" WHERE "modelRunId" = ${runId} AND "toolName" = ${READ_TOOL_RESULT_NAME}`;
      const [calls] = await tx.$queryRaw<Array<{ blocked: bigint; calls: bigint; distinctCalls: bigint }>>`
        SELECT count(*) AS "calls", count(DISTINCT ("toolName", "arguments")) AS "distinctCalls",
          count(*) FILTER (WHERE "state" = 'error' AND "startedAt" IS NULL
            AND "result" #>> '{content,0,value,error}' = 'tool_call_repeat_blocked') AS "blocked"
        FROM "ModelRunToolCall" WHERE "modelRunId" = ${runId} AND "roundIndex" > 0`;
      const outcomes = await tx.$queryRaw<Array<{ count: bigint; outcome: string | null }>>`
        SELECT payload #>> '{payload,outcome}' AS "outcome", count(*) AS "count"
        FROM "ModelRunEvent"
        WHERE "modelRunId" = ${runId} AND payload ->> 'artifactType' = 'context_compaction'
          AND payload #>> '{payload,stage}' = 'settled'
        GROUP BY 1`;
      const total = Number(reads?.reads ?? 0);
      const distinct = Number(reads?.distinctArguments ?? 0);
      return {
        errorCode: run?.code && CODE.test(run.code) ? run.code : null,
        readToolResult: { calls: total, distinctArguments: distinct, exactRepeats: total - distinct },
        toolCalls: { calls: Number(calls?.calls ?? 0), exactRepeats: Number(calls?.calls ?? 0) - Number(calls?.distinctCalls ?? 0),
          repeatBlocked: Number(calls?.blocked ?? 0) },
        retainedCommittedSummaryReceipts: Number(run?.committed ?? 0),
        settledCompactionCycles: Object.fromEntries(outcomes
          .filter((row) => row.outcome !== null && CODE.test(row.outcome))
          .map((row) => [row.outcome!, Number(row.count)]))
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

// Cleanup ------------------------------------------------------------------------

async function deleteChat(api: Api, chatId: string): Promise<boolean> {
  try {
    for (const message of (await chatDetail(api, chatId)).messages) {
      if (message.role === "assistant" && message.modelRunId && !["cancelled", "complete", "error"].includes(message.status)) {
        await request(api, "cleanup", `/api/model-runs/${encodeURIComponent(message.modelRunId)}/cancel`, { body: {}, method: "POST" });
      }
    }
    const admitted = decodeMemoryConsumerPermanentChatDeleteResponse(await json(api, "cleanup",
      `/api/chats/${encodeURIComponent(chatId)}/delete-permanently`, { body: {
        alsoForgetOriginMemories: true, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID()
      }, method: "POST" }));
    if (!admitted.ok) return false;
    const status = await poll("cleanup", DELETE_TIMEOUT_MS, async () => {
      const response = await request(api, "cleanup", `/api/chats/${encodeURIComponent(chatId)}/delete-permanently/status`);
      if (response.status === 404) return "COMPLETE";
      const body = response.ok ? await response.json().catch(() => null) as unknown : null;
      const value = record(body) && typeof body.status === "string" ? body.status : "UNKNOWN";
      return value === "IN_PROGRESS" || value === "UNKNOWN" ? null : value;
    });
    return status === "COMPLETE";
  } catch {
    return false;
  }
}

async function removeConnection(api: Api, connectionId: string): Promise<"deleted" | "disabled" | "failed"> {
  try {
    await checksIdle(api, connectionId, "cleanup");
    const response = await request(api, "cleanup", `/api/admin/providers/${encodeURIComponent(connectionId)}`, {
      body: { confirmed: true }, method: "DELETE"
    });
    if (response.ok) return "deleted";
    if (response.status !== 409) return "failed";
    await json(api, "cleanup", `/api/admin/providers/${encodeURIComponent(connectionId)}/actions`, {
      body: { action: "disable" }, method: "POST"
    });
    return "disabled";
  } catch {
    return "failed";
  }
}

// Main -----------------------------------------------------------------------------

function codexProfileApiRoot(): string | null {
  const path = join(homedir(), ".codex", "config.toml");
  if (!existsSync(path)) return null;
  try {
    return codexLbRoute(readFileSync(path, "utf8")).apiRoot;
  } catch {
    return null;
  }
}

function emit(value: Record<string, unknown>): void {
  writeSync(1, `${JSON.stringify({ smoke: "tool-result-recall-paid", ...value })}\n`);
}

const env = (name: string) => process.env[name]?.trim() ?? "";

async function main(): Promise<number> {
  if (env("AIQSA_RECALL_DISPOSABLE_STAND") !== "1") fail("config", "disposable_stand_not_acknowledged");
  const config = journeyConfig({
    ...process.env,
    AIQSA_JOURNEY_BASE_URL: env("AIQSA_RECALL_BASE_URL") || "http://127.0.0.1:3000",
    AIQSA_JOURNEY_CODEX_MODEL: env("AIQSA_RECALL_CODEX_MODEL") || "gpt-5.5",
    AIQSA_JOURNEY_CONTEXT_WINDOW: env("AIQSA_RECALL_CONTEXT_WINDOW") || "32768",
    AIQSA_JOURNEY_ROUTES: "codex-lb"
  }, codexProfileApiRoot);
  const route = config.routes[0]!;
  if ("skipped" in route) {
    emit({ status: "skipped", route: route.route, reason: route.skipped });
    return 1;
  }
  if (route.route !== "codex-lb") return fail("config", "routes_invalid");
  const mode = (env("AIQSA_RECALL_MODE") || "recall") as SmokeMode;
  if (!["budget", "recall", "repeat"].includes(mode)) fail("config", "mode_invalid");
  const budgetCalls = Number(env("AIQSA_RECALL_BUDGET_CALLS") || BUDGET_CALLS.fallback);
  if (!Number.isSafeInteger(budgetCalls) || budgetCalls < BUDGET_CALLS.min || budgetCalls > BUDGET_CALLS.max) {
    fail("config", "budget_calls_invalid");
  }
  const memory = env("AIQSA_RECALL_MEMORY") === "1";
  const dbStats = env("AIQSA_RECALL_DB_STATS") === "1";
  const fixtureHost = env("AIQSA_RECALL_FIXTURE_HOST") || "127.0.0.1";
  const publicHost = env("AIQSA_RECALL_FIXTURE_PUBLIC_HOST") || fixtureHost;
  if (dbStats) assertStatsTarget();

  const api = await authenticate(config.baseUrl);
  const fixture = await startBulkResultMcpEndpoint({ host: fixtureHost, publicHost, statusTool: mode === "repeat" });
  let stage: JourneyStage = "provider_setup";
  let serverId: string | null = null;
  let chatId: string | null = null;
  let createdConnectionId: string | null = null;
  let evidence: RunEvidence | null = null;
  let inputTokens: LedgerUsage | null = null;
  let stats: Record<string, unknown> | null = null;
  let failure: JourneyFailure | null = null;
  let savedLimits: ToolLimits | null = null;
  try {
    const target = await ensureCodexLb(api, route, config.contextWindow);
    if (target.created) createdConnectionId = target.connectionId;
    await ensureContextWindow(api, target, config.contextWindow);
    stage = "catalog";
    const model = await catalogModel(api, target, config.contextWindow);
    serverId = await registerBulkResultMcpServer(registrationClient(api), {
      endpointUrl: fixture.url, name: `Synthetic records ${randomUUID().slice(0, 8)}`, userId: api.userId
    }).catch((error: unknown) => fail("provider_setup",
      error instanceof Error && CODE.test(error.message) ? error.message : "bulk_mcp_registration_failed"));
    stage = "chat";
    chatId = await createChat(api, memory);
    const ledgerKeys = { modelIds: [model.modelId, model.upstreamModelId!], providers: [model.provider, model.providerFamily!] };
    const ledger = async () => ledgerUsage(await json(api, "evidence", LEDGER_USAGE_PATH), ledgerKeys);
    if (mode === "budget") {
      const { version: _version, ...limits } = await modelPolicy(api, "provider_setup");
      void _version;
      // Captured first: a change that commits but times out is still restored.
      savedLimits = limits;
      await writeToolLimits(api, "provider_setup", { ...limits, maxToolCalls: budgetCalls });
    }
    const before = await ledger();
    stage = "turn";
    evidence = await sendAndWait(api, chatId, model, mode === "repeat" ? REPEAT_REQUEST : RECALL_REQUEST);
    stage = "evidence";
    inputTokens = ledgerDelta(before, await ledger());
    if (dbStats && evidence.runId) stats = await databaseStats(evidence.runId);
  } catch (error) {
    failure = error instanceof JourneyFailure ? error : new JourneyFailure(stage, "unexpected_failure");
  }
  const limitsCleanup = savedLimits
    ? await writeToolLimits(api, "cleanup", savedLimits).then(() => "restored", () => "failed") : "none";
  const chatCleanup = chatId ? (await deleteChat(api, chatId) ? "deleted" : "failed") : "none";
  const serverCleanup = serverId
    ? (await request(api, "cleanup", `/api/admin/mcp/${encodeURIComponent(serverId)}`, { method: "DELETE" })
        .then((response) => response.ok ? "deleted" : "failed", () => "failed"))
    : "none";
  const providerCleanup = env("AIQSA_RECALL_CLEANUP_PROVIDERS") === "1" && createdConnectionId
    ? await removeConnection(api, createdConnectionId) : "kept";
  const fixtureCalls = { detail: fixture.calls(BULK_DETAIL_TOOL_NAME), list: fixture.calls(BULK_LIST_TOOL_NAME),
    ...(mode === "repeat" ? { status: fixture.calls(BULK_STATUS_TOOL_NAME) } : {}) };
  await fixture.close().catch(() => undefined);
  const answered = !failure && evidence?.status === "complete" && evidence.answerPresent && !evidence.toolCallLimitExceeded;
  // Budget: the answer arrives within the lowered limit. Repeat: the
  // unchanging status ran at most twice; later identical calls were blocked.
  const passed = answered && (mode !== "budget" || evidence!.toolCalls <= budgetCalls) &&
    (mode !== "repeat" || fixture.calls(BULK_STATUS_TOOL_NAME) <= 2) && limitsCleanup !== "failed";
  emit({
    status: passed ? "passed" : "failed",
    mode,
    ...(mode === "budget" ? { budget: { maxToolCalls: budgetCalls, limits: limitsCleanup } } : {}),
    ...(failure ? { code: failure.code, stage: failure.stage, ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}) } : {}),
    contextWindow: config.contextWindow,
    memory,
    fixture: { objects: BULK_RESULT_LIMITS.objects, calls: fixtureCalls },
    run: evidence ? {
      status: evidence.status,
      answerPresent: evidence.answerPresent,
      errorMessagePresent: evidence.errorMessagePresent,
      toolCallLimitExceeded: evidence.toolCallLimitExceeded,
      toolCalls: evidence.toolCalls,
      toolRounds: evidence.toolRounds,
      mcpCalls: evidence.mcpCalls,
      readToolResultCalls: evidence.readToolResultCalls,
      latestCompaction: { cycle: evidence.compactionCycle, outcome: evidence.compactionOutcome }
    } : null,
    usage: inputTokens,
    database: stats,
    cleanup: { chat: chatCleanup, limits: limitsCleanup, mcpServer: serverCleanup, provider: providerCleanup }
  });
  return passed ? 0 : 1;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const failure = error instanceof JourneyFailure ? error : new JourneyFailure("config", "unexpected_failure");
  emit({ status: "failed", stage: failure.stage, code: failure.code });
  process.exitCode = 1;
});
