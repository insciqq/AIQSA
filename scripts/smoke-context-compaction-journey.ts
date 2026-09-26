/**
 * Opt-in, paid, bounded end-to-end check of the Russian-language context
 * compaction journey against a DISPOSABLE AIQSA stand: a running app with
 * AIQSA_TEST_MODE=1 and PLAYWRIGHT_TEST_AUTH=1 and a seeded bootstrap admin.
 * Never a default Vitest/Playwright lane; never point it at a persistent
 * installation. It uses only the stand's HTTP API (no browser, no database).
 *
 * For each requested route (`anthropic`: native Messages; `codex-lb`: custom
 * OpenAI-compatible Responses endpoint) it:
 * 1. configures the provider through the Admin API (quick setup, or discovery
 *    plus custom setup), reusing an existing deployment of the model, and
 *    publishes the journey window as the model's administrator-set
 *    `capabilities.contextWindow` so the 80 % compaction trigger is cheap;
 * 2. signs in with the stand's test bootstrap token (as
 *    tests/e2e/support/localAuth.ts does);
 * 3. creates a personal chat excluded from Memory and sends a bounded
 *    journey: a long Cyrillic brief, two corrections, a standing three-item
 *    list rule, fillers until the session estimate nears the trigger or a
 *    summary is bought, then one probe that needs the corrections and rule;
 * 4. after every turn reads the chat projection (session context status and
 *    the run's context-compaction status) and the Admin usage ledger
 *    (provider-reported input tokens);
 * 5. prints ONE sanitized JSON document (numbers, booleans, stable codes and
 *    model ids only; prompts and answers are never printed or persisted);
 * 6. deletes the journey chat; provider configuration stays unless
 *    AIQSA_JOURNEY_CLEANUP_PROVIDERS=1 (then a connection this run created is
 *    deleted, or disabled when run bindings still reference it).
 *
 * Exit 0 only when at least one route ran, every route that ran bought its
 * first summary between 0.6 and 0.95 of the estimated budget and its probe
 * answer carried both corrections as a three-item list, and no explicitly
 * requested route was skipped.
 *
 * Environment (read from the process only; no .env loading):
 * - AIQSA_JOURNEY_BASE_URL (default http://127.0.0.1:3000; plain HTTP only on loopback)
 * - AIQSA_JOURNEY_ROUTES (default anthropic,codex-lb)
 * - ANTHROPIC_API_KEY, AIQSA_JOURNEY_ANTHROPIC_MODEL (default claude-sonnet-5)
 * - CODEX_LB_API_KEY, CODEX_LB_BASE_URL (compatible endpoint root; falls back
 *   to the codex-lb route of ~/.codex/config.toml), AIQSA_JOURNEY_CODEX_MODEL (default gpt-5.5)
 * - AIQSA_JOURNEY_CONTEXT_WINDOW (default 32768, 16384..65536)
 * - AIQSA_JOURNEY_MAX_TURNS (default 12, 6..12)
 * - AIQSA_JOURNEY_CLEANUP_PROVIDERS=1
 * A route without its key is reported as {route, status: "skipped"}.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeAdminProviderModelSaveReceipt } from "../lib/contracts/adminProviderModelSave";
import { decodeCatalogResponse, type CatalogModel } from "../lib/contracts/catalog";
import { decodeChatDetailResponse, decodeChatSummaryResponse, type ChatDetailWire } from "../lib/contracts/chats";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryConsumerChatModeResponse,
  decodeMemoryConsumerPermanentChatDeleteResponse
} from "../lib/contracts/memoryClient";
import { sessionContextCapacity, type SessionContextStatus } from "../lib/contracts/sessionStatus";
import { calculateContextBudgetLimits } from "../lib/domain/contextBudget";
import { contextTokenEstimator } from "../lib/domain/tokenEstimate";
import {
  JOURNEY_CORRECTIONS,
  JOURNEY_LIMITS,
  JOURNEY_PROBE,
  JOURNEY_RULE,
  JOURNEY_TEST_AUTH_TOKEN,
  JourneyFailure,
  codexLbSetupBody,
  contextWindowUpdate,
  findJourneyModel,
  journeyBrief,
  journeyConfig,
  journeyExitCode,
  journeyFiller,
  journeyRound,
  journeyRunParams,
  journeyVerdict,
  ledgerInputTokens,
  messageText,
  nextFillerTokens,
  probeAnswerCarriesCorrections,
  quickSetupCandidate,
  readConnections,
  settledTurn,
  type JourneyConfig,
  type JourneyConnection,
  type JourneyRound,
  type JourneyRouteConfig,
  type JourneyStage,
  type JourneyTurnKind,
  type TokenEstimate
} from "./context-compaction-journey-support";
import { codexLbRoute } from "./workspace-user-paid-support";

const REQUEST_TIMEOUT_MS = 60_000;
/** Setup and model publication wait for real capability checks. */
const SETUP_TIMEOUT_MS = 900_000;
const TURN_TIMEOUT_MS = 660_000;
const CATALOG_TIMEOUT_MS = 300_000;
const DELETE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const STREAM_BYTES = 16 * 1024 * 1024;

type Api = Readonly<{ baseUrl: URL; cookie: string; userId: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(stage: JourneyStage, code: string): never {
  throw new JourneyFailure(stage, code);
}

function asFailure(error: unknown, stage: JourneyStage): JourneyFailure {
  return error instanceof JourneyFailure ? error : new JourneyFailure(stage, "unexpected_failure");
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll<T>(stage: JourneyStage, timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value !== null) return value;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return fail(stage, "poll_timeout");
}

function headers(api: Pick<Api, "baseUrl"> & Partial<Pick<Api, "cookie">>, jsonBody: boolean): HeadersInit {
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(api.cookie ? { cookie: api.cookie } : {}),
    origin: api.baseUrl.origin
  };
}

/** The server's own stable error code, else the HTTP status; never a body. */
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
  if (!response.ok) fail(stage, await failureCode(response));
  try {
    return await response.json() as unknown;
  } catch {
    return fail(stage, "response_invalid");
  }
}

/** Consumes a streamed answer without keeping any of it. */
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

// Provider setup -------------------------------------------------------------------

type ProviderTarget = Readonly<{ connectionId: string; created: boolean; providerModelId: string }>;

async function connections(api: Api, stage: JourneyStage = "provider_setup"): Promise<JourneyConnection[]> {
  return readConnections(await json(api, stage, "/api/admin/providers")) ?? fail(stage, "providers_response_invalid");
}

/** Waits until no capability check runs on the connection. */
async function checksIdle(api: Api, connectionId: string, stage: JourneyStage = "provider_setup"): Promise<JourneyConnection> {
  return poll(stage, SETUP_TIMEOUT_MS, async () => {
    const connection = (await connections(api, stage)).find((candidate) => candidate.id === connectionId);
    if (!connection) return fail(stage, "connection_missing");
    return connection.checkRunning ? null : connection;
  });
}

function setupOutcome(value: unknown): Readonly<{ connectionId: string; outcome: string }> {
  if (!record(value) || typeof value.outcome !== "string" || typeof value.connectionId !== "string") {
    return fail("provider_setup", "setup_response_invalid");
  }
  if (value.outcome !== "ready" && value.outcome !== "partial") fail("provider_setup", `setup_${value.outcome}`);
  return { connectionId: value.connectionId, outcome: value.outcome };
}

async function ensureAnthropic(api: Api, route: Extract<JourneyRouteConfig, { route: "anthropic" }>): Promise<ProviderTarget> {
  const before = await connections(api);
  const existing = findJourneyModel(before, { family: "anthropic", upstreamModelId: route.model });
  if (existing) return { connectionId: existing.connection.id, created: false, providerModelId: existing.model.id };
  const snapshot = await json(api, "provider_setup", "/api/admin/providers/quick-setup");
  const state = record(snapshot) && Array.isArray(snapshot.providers)
    ? snapshot.providers.find((entry) => record(entry) && entry.provider === "anthropic") : null;
  if (!record(state) || typeof state.stateToken !== "string") fail("provider_setup", "quick_setup_snapshot_invalid");
  const setup = (body: Record<string, unknown>) => json(api, "provider_setup", "/api/admin/providers/quick-setup", {
    body: { provider: "anthropic", secret: route.apiKey, ...body }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS
  });
  let result = await setup({ expectedState: state.stateToken });
  if (record(result) && result.outcome === "selection_required") {
    const selectedModel = quickSetupCandidate(result, route.model);
    if (!selectedModel || typeof result.expectedState !== "string") fail("provider_setup", "quick_setup_selection_invalid");
    result = await setup({ expectedState: result.expectedState, selectedModel });
  }
  const { connectionId } = setupOutcome(result);
  await checksIdle(api, connectionId);
  const configured = findJourneyModel((await connections(api)).filter((connection) => connection.id === connectionId), {
    family: "anthropic", upstreamModelId: route.model
  });
  if (!configured) fail("provider_setup", "anthropic_model_not_configured");
  return {
    connectionId,
    created: !before.some((connection) => connection.id === connectionId),
    providerModelId: configured.model.id
  };
}

async function ensureCodexLb(
  api: Api,
  route: Extract<JourneyRouteConfig, { route: "codex-lb" }>,
  contextWindow: number
): Promise<ProviderTarget> {
  const before = await connections(api);
  const target = { apiRoot: route.apiRoot, family: "openai_compatible" as const, upstreamModelId: route.model };
  const existing = findJourneyModel(before, target);
  if (existing) return { connectionId: existing.connection.id, created: false, providerModelId: existing.model.id };
  const discovery = await json(api, "provider_setup", "/api/admin/providers/custom-setup/discover", {
    body: { allowPrivateNetwork: true, apiRoot: route.apiRoot, authenticationMode: "bearer",
      responseTimeoutSeconds: 180, secret: route.apiKey },
    method: "POST",
    timeoutMs: SETUP_TIMEOUT_MS
  });
  if (!record(discovery) || !Array.isArray(discovery.models)) fail("provider_setup", "discovery_response_invalid");
  if (!discovery.models.some((model) => record(model) && model.id === route.model)) {
    fail("provider_setup", "codex_model_not_discovered");
  }
  const result = await json(api, "provider_setup", "/api/admin/providers/custom-setup", {
    body: codexLbSetupBody({
      apiRoot: route.apiRoot,
      ...(typeof discovery.catalogProof === "string" ? { catalogProof: discovery.catalogProof } : {}),
      contextWindow,
      model: route.model,
      secret: route.apiKey
    }),
    method: "POST",
    timeoutMs: SETUP_TIMEOUT_MS
  });
  const { connectionId } = setupOutcome(result);
  await checksIdle(api, connectionId);
  const configured = findJourneyModel((await connections(api)).filter((connection) => connection.id === connectionId), target);
  if (!configured) fail("provider_setup", "codex_model_not_configured");
  return {
    connectionId,
    created: !before.some((connection) => connection.id === connectionId),
    providerModelId: configured.model.id
  };
}

/** Publishes the journey window as the administrator-set context window. */
async function ensureContextWindow(api: Api, target: ProviderTarget, contextWindow: number): Promise<void> {
  const connection = await checksIdle(api, target.connectionId);
  const model = connection.models.find((candidate) => candidate.id === target.providerModelId) ??
    fail("provider_setup", "journey_model_missing");
  const body = contextWindowUpdate(model, contextWindow);
  if (!body) return;
  const response = await json(api, "provider_setup",
    `/api/admin/providers/${encodeURIComponent(target.connectionId)}/models/${encodeURIComponent(target.providerModelId)}`,
    { body, method: "PATCH", timeoutMs: SETUP_TIMEOUT_MS });
  const receipt = decodeAdminProviderModelSaveReceipt(record(response) ? response.receipt : null);
  if (receipt?.publication !== "active") fail("provider_setup", "context_window_not_published");
}

/** The catalog entry the composer would select, with the journey window applied. */
async function journeyCatalogModel(api: Api, target: ProviderTarget, contextWindow: number): Promise<CatalogModel> {
  await checksIdle(api, target.connectionId, "catalog");
  const model = await poll("catalog", CATALOG_TIMEOUT_MS, async () => {
    const catalog = decodeCatalogResponse(await json(api, "catalog", "/api/me/catalog")) ??
      fail("catalog", "catalog_response_invalid");
    return catalog.models.find((entry) => entry.provider === target.connectionId && entry.modelId === target.providerModelId) ?? null;
  });
  if (!model.providerFamily || !model.upstreamModelId) fail("catalog", "catalog_model_identity_missing");
  if (model.contextWindow !== contextWindow) fail("catalog", "context_window_override_not_applied");
  // Hybrid compaction is frozen only for tool-capable admissions.
  if (!model.capabilities.toolCalling) fail("catalog", "tool_calling_unavailable");
  return model;
}

// Journey ----------------------------------------------------------------------------

type RouteState = {
  chatId: string | null;
  contextWindow: number | null;
  createdConnectionId: string | null;
  probeAnswerCarriesCorrections: boolean;
  reused: boolean | null;
  rounds: JourneyRound[];
  stage: JourneyStage;
};

async function createJourneyChat(api: Api): Promise<Readonly<{ activeLeafMessageId: string | null; id: string }>> {
  const chat = decodeChatSummaryResponse(await json(api, "chat", "/api/chats", {
    body: { title: "Context compaction journey" }, method: "POST"
  })) ?? fail("chat", "chat_response_invalid");
  // The synthetic journey never becomes a Memory learning source.
  const mode = decodeMemoryConsumerChatModeResponse(await json(api, "chat",
    `/api/me/chats/${encodeURIComponent(chat.id)}/memory-mode`, { body: { mode: "EXCLUDED" }, method: "PATCH" }));
  if (!mode.ok || mode.value.mode !== "EXCLUDED") fail("chat", "memory_exclusion_failed");
  return chat;
}

async function sendMessage(
  api: Api,
  chatId: string,
  leafId: string | null,
  text: string,
  model: CatalogModel,
  params: Record<string, unknown>
): Promise<void> {
  const response = await request(api, "turn", `/api/chats/${encodeURIComponent(chatId)}/messages`, {
    body: {
      content: { blocks: [{ text, type: "text" }] },
      expectedActiveLeafId: leafId,
      mcp: { mode: "off" },
      modelId: model.modelId,
      params,
      provider: model.provider,
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchStrategy: "search-disabled",
      timeZone: "Europe/Moscow"
    },
    method: "POST",
    timeoutMs: TURN_TIMEOUT_MS
  });
  if (!response.ok) fail("turn", await failureCode(response));
  await drain(response, "turn");
}

async function chatDetail(api: Api, chatId: string): Promise<ChatDetailWire> {
  return decodeChatDetailResponse(await json(api, "evidence", `/api/chats/${encodeURIComponent(chatId)}`)) ??
    fail("evidence", "chat_response_invalid");
}

async function runJourney(api: Api, config: JourneyConfig, model: CatalogModel, chatId: string, state: RouteState): Promise<void> {
  const family = model.providerFamily!;
  let estimate: TokenEstimate = contextTokenEstimator({ modelId: model.upstreamModelId, provider: family });
  const initialBudget = calculateContextBudgetLimits({
    contextWindow: config.contextWindow, maxOutputTokens: JOURNEY_LIMITS.answerMaxOutputTokens, provider: family
  }).budgetTokens;
  const params = journeyRunParams(model, JOURNEY_LIMITS.answerMaxOutputTokens);
  const ledgerKeys = { modelIds: [model.modelId, model.upstreamModelId!], providers: [model.provider, family] };
  const ledger = async () => ledgerInputTokens(await json(api, "evidence", "/api/admin"), api.userId, ledgerKeys);
  let ledgerBefore = await ledger();
  let leafId: string | null = null;
  let requestBytes = 0;

  const turn = async (kind: JourneyTurnKind, text: string): Promise<Readonly<{ answer: string; session: SessionContextStatus }>> => {
    const number = state.rounds.length + 1;
    if (number > config.maxTurns) fail("turn", "turn_bound_exhausted");
    const bytes = Buffer.byteLength(text, "utf8");
    requestBytes += bytes;
    if (bytes > JOURNEY_LIMITS.maxMessageBytes || requestBytes > JOURNEY_LIMITS.maxRouteRequestBytes) {
      fail("turn", "request_bytes_bound");
    }
    await sendMessage(api, chatId, leafId, text, model, params);
    const previousLeafId = leafId;
    const detail = await poll("turn", TURN_TIMEOUT_MS, async () => {
      const current = await chatDetail(api, chatId);
      return settledTurn(current, previousLeafId) ? current : null;
    });
    const { assistant } = settledTurn(detail, previousLeafId)!;
    leafId = assistant.id;
    const answer = messageText(assistant);
    const session = detail.contextStats.sessionMessageId === assistant.id ? detail.contextStats.session ?? null : null;
    // The stand measures with the admitted route's own estimate family.
    if (session) estimate = contextTokenEstimator({ modelId: session.modelId, provider: session.provider });
    const ledgerAfter = await ledger();
    state.rounds.push(journeyRound({
      answerTokens: estimate(answer),
      compaction: assistant.artifactSummary?.contextCompaction ?? null,
      kind,
      reportedInputTokens: ledgerBefore !== null && ledgerAfter !== null ? ledgerAfter - ledgerBefore : null,
      session,
      toolCalls: assistant.toolActivity?.calls.length ?? 0,
      turn: number
    }));
    ledgerBefore = ledgerAfter;
    if (assistant.status !== "complete") fail("turn", "turn_not_complete");
    if (!session) fail("evidence", "session_status_missing");
    return { answer, session };
  };

  let last = await turn("brief", journeyBrief(Math.floor(initialBudget * JOURNEY_LIMITS.briefBudgetShare), estimate));
  for (const correction of JOURNEY_CORRECTIONS) last = await turn("correction", correction);
  last = await turn("rule", JOURNEY_RULE);
  for (let filler = 0; state.rounds.length < config.maxTurns - 1; filler += 1) {
    if (state.rounds.some((round) => round.summaryAtBudgetShare !== null)) break;
    const budgetTokens = sessionContextCapacity(last.session).budgetTokens ?? initialBudget;
    const tokens = nextFillerTokens({ approximateInputTokens: last.session.approximateInputTokens, budgetTokens });
    if (tokens === null) break;
    last = await turn("filler", journeyFiller(filler, tokens, estimate));
  }
  const probe = await turn("probe", JOURNEY_PROBE);
  // Checked in memory only; the answer text never leaves this function.
  state.probeAnswerCarriesCorrections = probeAnswerCarriesCorrections(probe.answer);
}

// Cleanup ----------------------------------------------------------------------------

async function deleteChat(api: Api, chatId: string): Promise<boolean> {
  try {
    // A turn abandoned by a failure may still run; Stop it before deletion.
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

/** Deletes a connection this run created, or disables it when references remain. */
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

// Route and report -------------------------------------------------------------------

type RouteResult = Record<string, unknown> & { status: "failed" | "passed" | "skipped" };

async function runRoute(api: Api, config: JourneyConfig, route: JourneyRouteConfig): Promise<RouteResult> {
  const state: RouteState = {
    chatId: null, contextWindow: null, createdConnectionId: null, probeAnswerCarriesCorrections: false,
    reused: null, rounds: [], stage: "provider_setup"
  };
  let failure: JourneyFailure | null = null;
  try {
    const target = route.route === "anthropic"
      ? await ensureAnthropic(api, route)
      : await ensureCodexLb(api, route, config.contextWindow);
    state.reused = !target.created;
    if (target.created) state.createdConnectionId = target.connectionId;
    await ensureContextWindow(api, target, config.contextWindow);
    state.stage = "catalog";
    const model = await journeyCatalogModel(api, target, config.contextWindow);
    state.contextWindow = model.contextWindow;
    state.stage = "chat";
    const chat = await createJourneyChat(api);
    state.chatId = chat.id;
    state.stage = "turn";
    await runJourney(api, config, model, chat.id, state);
  } catch (error) {
    failure = asFailure(error, state.stage);
  }
  const chatCleanup = state.chatId ? (await deleteChat(api, state.chatId) ? "deleted" : "failed") : "none";
  const providerCleanup = config.cleanupProviders && state.createdConnectionId
    ? await removeConnection(api, state.createdConnectionId) : "kept";
  const verdict = journeyVerdict(state.rounds, state.probeAnswerCarriesCorrections);
  const code = failure?.code ?? verdict.code;
  return {
    route: route.route,
    model: route.model,
    contextWindow: state.contextWindow,
    turns: state.rounds.length,
    rounds: state.rounds,
    firstSummaryAtBudgetShare: verdict.firstSummaryAtBudgetShare,
    compactionTriggered: verdict.compactionTriggered,
    probeAnswerCarriesCorrections: state.probeAnswerCarriesCorrections,
    providerReused: state.reused,
    cleanup: { chat: chatCleanup, provider: providerCleanup },
    status: code === null ? "passed" : "failed",
    ...(code === null ? {} : { code, stage: failure?.stage ?? "evidence" })
  };
}

/** The codex-lb root of the operator's Codex profile, when present. */
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
  process.stdout.write(`${JSON.stringify({ smoke: "context-compaction-journey", ...value })}\n`);
}

async function main(): Promise<number> {
  const config = journeyConfig(process.env, codexProfileApiRoot);
  const api = await authenticate(config.baseUrl);
  const routes: RouteResult[] = [];
  for (const route of config.routes) {
    routes.push("skipped" in route
      ? { route: route.route, status: "skipped", reason: route.skipped }
      : await runRoute(api, config, route));
  }
  const exitCode = journeyExitCode(routes, config.explicitRoutes);
  emit({ status: exitCode === 0 ? "passed" : "failed", contextWindow: config.contextWindow, maxTurns: config.maxTurns, routes });
  return exitCode;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const failure = asFailure(error, "config");
  emit({ status: "failed", stage: failure.stage, code: failure.code });
  process.exitCode = 1;
});
