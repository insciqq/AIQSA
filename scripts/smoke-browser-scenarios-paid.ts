/**
 * Opt-in, paid browser-scenario measurement against a DISPOSABLE real-KVM
 * AIQSA stand. Never a default lane and never a persistent installation.
 *
 * Each selected scenario (`scripts/browser-scenarios-support.ts`) runs
 * AIQSA_BROWSER_SCENARIOS_RUNS times (default 2), interleaved, each in a new
 * chat with one Russian prompt. The harness waits for the terminal state (up
 * to the run's turn limit plus a margin), reads `browser-result.json` from the
 * turn's output files, checks it with the scenario's deterministic oracle and
 * prints ONE content-free JSON line per run, then one summary line per
 * scenario and a final line. Scenarios marked `not_available` are reported
 * without a run.
 *
 * Setup through the ordinary Admin and user APIs (as a real operator would):
 * the codex-lb route from ~/.codex/config.toml as a vision-capable chat model
 * (reused when an identical usable one exists), System Vision on the same
 * model, Workspace on with internet, Memory off for the user, and the public
 * saucedemo.com demo login as a Workspace env secret, saved only for the runs
 * of a scenario that expects it (S3). The harness signs in with
 * the password of the administrator the stand's bootstrap created. Workspace
 * limits are the stand's own; the effective bounds of every run are printed.
 * The exit code is 0 whenever the measurement completes, whatever the success
 * count: failed oracles are data, not a harness failure. Cleanup is not:
 * when a chat or a saved browser session cannot be removed and proven gone,
 * the measurement stops before the next run and exits 1.
 *
 * After each run the chat is deleted permanently (unless
 * AIQSA_BROWSER_SCENARIOS_KEEP_CHATS=1) and browser sessions the run saved are
 * removed, so every run starts from the same state.
 *
 * S5 also drives the chat page with Playwright while the run is live
 * (`scripts/browser-scenarios-handoff.ts`): it signs in through the live
 * browser handoff, so the harness host needs a Chromium for Playwright. Its
 * oracle also reads the run's `browser_handoff` calls and counts stored rows
 * that carry what the user typed; only counts are printed.
 *
 * Environment (process only; no .env loading):
 * - AIQSA_BROWSER_SCENARIOS_E2E=DISPOSABLE (required acknowledgement)
 * - AIQSA_BROWSER_SCENARIOS_COMPOSE_FILE: the stand's `docker compose config --format json`
 *   (published app and Postgres ports on 127.0.0.1, reachable from this host)
 * - CODEX_LB_API_KEY
 * - AIQSA_BROWSER_SCENARIOS_SELECT (default S1,S2,S3,S4,S5), AIQSA_BROWSER_SCENARIOS_RUNS (1..5, default 2)
 * - AIQSA_BROWSER_SCENARIOS_LABEL: tree or branch label echoed in the output
 * - AIQSA_BROWSER_SCENARIOS_MARGIN_SECONDS (60..3600, default 600)
 * - AIQSA_BROWSER_SCENARIOS_BROWSER_CHANNEL: optional installed browser for S5 (for example `chrome`)
 * - AIQSA_BROWSER_SCENARIOS_CHAT_ROUTE (`codex-lb`, default, or `openrouter`) with
 *   AIQSA_BROWSER_SCENARIOS_CHAT_MODEL (an OpenRouter model id) and OPENROUTER_API_KEY: runs on a
 *   text-only OpenRouter chat model added as an OpenAI-compatible Chat Completions connection;
 *   System Vision stays on the codex-lb model, so screenshots reach the model only through it
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client as PostgresClient } from "pg";
import { decodeCatalogResponse, type CatalogModel } from "../lib/contracts/catalog";
import { decodeChatSummaryResponse } from "../lib/contracts/chats";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryConsumerChatModeResponse,
  decodeMemoryConsumerPermanentChatDeleteResponse
} from "../lib/contracts/memoryClient";
import {
  BROWSER_RESULT_FILE, BROWSER_RESULT_MAX_BYTES, BROWSER_SCENARIOS, BrowserScenarioError, SAUCEDEMO_LOGIN_VALUES, SAUCEDEMO_SECRET,
  checkBrowserResult, cleanUpRun, parseBrowserResult, requireBrowserScenarioStand, runBounds, scenarioSummary, selectedScenarios,
  OPENROUTER_API_ROOT, chatRoute, openRouterTextModel, textChatCapabilities,
  toolCallStats, usageEvidence, type BrowserBlockedCode, type BrowserScenario, type BrowserScenarioId, type BrowserScenarioStand,
  type HandoffCallRow, type RunBounds, type RunRecord, type StandTarget, type ToolCallRow, type TypedValueLeaks, type UsageRow
} from "./browser-scenarios-support";
import {
  JOURNEY_LIMITS, discoveredContextWindow, journeyReuseDecision, modelInConnection, readConnections,
  type JourneyConnection
} from "./context-compaction-journey-support";
import { codexLbRoute } from "./workspace-user-paid-support";

const REQUEST_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 900_000;
const MODEL_DISPLAY_NAME = "Browser scenarios model";
const TERMINAL = new Set(["complete", "cancelled", "error"]);

let stage = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const fail = (code: string): never => { throw new BrowserScenarioError(code); };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const safeCode = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value) ? value : null;

type Api = Readonly<{ baseUrl: URL; cookie: string }>;
type CallInit = Readonly<{ body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number }>;

async function request(api: Pick<Api, "baseUrl"> & Partial<Pick<Api, "cookie">>, path: string, init: CallInit = {}) {
  const hasBody = Object.hasOwn(init, "body");
  try {
    return await fetch(new URL(path, api.baseUrl), {
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(api.cookie ? { cookie: api.cookie } : {}),
        origin: api.baseUrl.origin
      },
      method: init.method ?? "GET",
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS)
    });
  } catch {
    return fail("request_failed");
  }
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as unknown;
  return (record(body) && safeCode(body.error)) || `http_${response.status}`;
}

async function json(api: Api, path: string, init: CallInit = {}): Promise<unknown> {
  const response = await request(api, path, init);
  if (!response.ok) fail(await errorCode(response));
  return response.json().catch(() => fail("response_invalid"));
}

async function poll<T>(timeoutMs: number, probe: () => Promise<T | null>, code: string, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value !== null) return value;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return fail(code);
}

async function authenticate(target: StandTarget): Promise<Api> {
  const baseUrl = new URL(target.baseUrl);
  const response = await request({ baseUrl }, "/api/auth/login", { body: { ...target.admin }, method: "POST" });
  if (!response.ok) fail(`auth_${await errorCode(response)}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .find((value) => value.includes("=")) ?? "";
  const body = await response.json().catch(() => null) as unknown;
  if (!cookie || !record(body) || !record(body.user) || body.user.role !== "admin") fail("admin_session_required");
  return { baseUrl, cookie };
}

// Setup ------------------------------------------------------------------------------

async function connections(api: Api): Promise<JourneyConnection[]> {
  return readConnections(await json(api, "/api/admin/providers")) ?? fail("providers_response_invalid");
}

async function checksIdle(api: Api, connectionId: string): Promise<JourneyConnection> {
  return poll(SETUP_TIMEOUT_MS, async () => {
    const connection = (await connections(api)).find((candidate) => candidate.id === connectionId) ?? fail("connection_missing");
    return connection.checkRunning ? null : connection;
  }, "checks_still_running", 5_000);
}

async function ensureModel(api: Api, route: Readonly<{ apiRoot: string; model: string }>, secret: string) {
  let catalogProof: string | undefined;
  let contextWindow: number = JOURNEY_LIMITS.defaultContextWindow;
  const discovery = await request(api, "/api/admin/providers/custom-setup/discover", { body: {
    allowPrivateNetwork: true, apiRoot: route.apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (discovery.ok) {
    const value = await discovery.json().catch(() => null) as unknown;
    if (record(value) && Array.isArray(value.models) && value.models.some((model) => record(model) && model.id === route.model)) {
      if (typeof value.catalogProof === "string") catalogProof = value.catalogProof;
      contextWindow = discoveredContextWindow(value, route.model) ?? contextWindow;
    }
  }
  const decision = journeyReuseDecision(await connections(api), {
    apiRoot: route.apiRoot, family: "openai_compatible", upstreamModelId: route.model
  });
  const reusable = decision.match && decision.match.model.displayName === MODEL_DISPLAY_NAME ? decision.match : null;
  if (reusable) return { connectionId: reusable.connection.id, contextWindow, providerModelId: reusable.model.id, reused: true };
  const result = await json(api, "/api/admin/providers/custom-setup", { body: {
    allowPrivateNetwork: true, apiRoot: route.apiRoot, authenticationMode: "bearer",
    // A vision-capable chat model as an administrator would add it; setup proves each declared capability.
    capabilities: {
      contextWindow, defaultMaxOutputTokens: 16_384, streaming: true, toolCalling: true, parallelToolCalls: false,
      reasoning: true, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium",
      nativePdfInput: false, nativeImageGeneration: false, nativeSearch: false, pdf: true, vision: true
    },
    confirmPaidRequest: true, connectionDisplayName: `Browser scenarios codex-lb ${randomUUID().slice(0, 8)}`,
    modelDisplayName: MODEL_DISPLAY_NAME, protocol: "responses", responseTimeoutSeconds: 180, secret,
    ...(catalogProof ? { catalogProof, modelIds: [route.model] } : { modelId: route.model })
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (!record(result) || typeof result.connectionId !== "string" || (result.outcome !== "ready" && result.outcome !== "partial")) {
    fail(`setup_${record(result) ? safeCode(result.outcome) ?? "invalid" : "invalid"}`);
  }
  const connectionId = (result as { connectionId: string }).connectionId;
  const model = modelInConnection(await checksIdle(api, connectionId), route.model) ?? fail("model_not_configured");
  return { connectionId, contextWindow, providerModelId: model.id, reused: false };
}

const TEXT_MODEL_DISPLAY_NAME = "Browser scenarios text model";

/**
 * The text-only OpenRouter chat model, added as an OpenAI-compatible Chat
 * Completions connection: custom setup probes only this model, whereas the
 * OpenRouter family's first key would add and check every built-in OpenRouter
 * model. The public listing (no key) proves tool calling and text-only input.
 */
async function ensureTextModel(api: Api, model: string, secret: string) {
  let listing: unknown = null;
  try {
    const response = await fetch(`${OPENROUTER_API_ROOT}/models`, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    listing = response.ok ? await response.json() : null;
  } catch {
    fail("openrouter_listing_unavailable");
  }
  const listed = openRouterTextModel(listing, model);
  if ("code" in listed) return fail(listed.code);
  const decision = journeyReuseDecision(await connections(api), {
    apiRoot: OPENROUTER_API_ROOT, family: "openai_compatible", upstreamModelId: model
  });
  const reusable = decision.match && decision.match.model.displayName === TEXT_MODEL_DISPLAY_NAME ? decision.match : null;
  if (reusable) return { connectionId: reusable.connection.id, contextWindow: listed.contextWindow, providerModelId: reusable.model.id, reused: true };
  let catalogProof: string | undefined;
  const discovery = await request(api, "/api/admin/providers/custom-setup/discover", { body: {
    allowPrivateNetwork: false, apiRoot: OPENROUTER_API_ROOT, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (discovery.ok) {
    const value = await discovery.json().catch(() => null) as unknown;
    if (record(value) && Array.isArray(value.models) && value.models.some((entry) => record(entry) && entry.id === model) &&
      typeof value.catalogProof === "string") catalogProof = value.catalogProof;
  }
  const result = await json(api, "/api/admin/providers/custom-setup", { body: {
    allowPrivateNetwork: false, apiRoot: OPENROUTER_API_ROOT, authenticationMode: "bearer",
    capabilities: textChatCapabilities(listed.contextWindow),
    confirmPaidRequest: true, connectionDisplayName: `Browser scenarios OpenRouter ${randomUUID().slice(0, 8)}`,
    modelDisplayName: TEXT_MODEL_DISPLAY_NAME, protocol: "chat_completions", responseTimeoutSeconds: 180, secret,
    ...(catalogProof ? { catalogProof, modelIds: [model] } : { modelId: model })
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (!record(result) || typeof result.connectionId !== "string" || (result.outcome !== "ready" && result.outcome !== "partial")) {
    fail(`text_setup_${record(result) ? safeCode(result.outcome) ?? "invalid" : "invalid"}`);
  }
  const connectionId = (result as { connectionId: string }).connectionId;
  const added = modelInConnection(await checksIdle(api, connectionId), model) ?? fail("text_model_not_configured");
  return { connectionId, contextWindow: listed.contextWindow, providerModelId: added.id, reused: false };
}

async function ensureSystemVision(api: Api, providerModelId: string): Promise<void> {
  await json(api, "/api/admin/providers/system-model-policy", {
    body: { providerModelId, role: "vision" }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS
  });
  const current = await json(api, "/api/admin/providers/system-model-policy");
  const policy = record(current) && record(current.systemModelPolicy) && record(current.systemModelPolicy.policy)
    ? current.systemModelPolicy.policy : fail("system_policy_invalid");
  const updated = await json(api, "/api/admin/providers/system-model-policy", { body: {
    expectedVersion: policy.version, visionProviderModelId: providerModelId, visionReasoningEffort: "low"
  }, method: "PATCH" });
  const vision = record(updated) && record(updated.systemModelPolicy) && record(updated.systemModelPolicy.policy)
    ? updated.systemModelPolicy.policy.visionModel : null;
  if (!record(vision) || vision.available !== true) fail("system_vision_unavailable");
}

async function ensureWorkspaceInternet(api: Api): Promise<void> {
  const current = await json(api, "/api/admin/workspace");
  const workspace = record(current) && record(current.workspace) ? current.workspace : fail("workspace_policy_invalid");
  const version = workspace.version ?? (record(workspace.policy) ? workspace.policy.version : undefined);
  await json(api, "/api/admin/workspace", { body: { enabled: true, expectedVersion: version, internetEnabled: true }, method: "PATCH" });
}

type SecretSummary = Readonly<{ id: string; kind: string; name: string; versionId: string }>;

async function secrets(api: Api): Promise<SecretSummary[]> {
  const value = await json(api, "/api/me/workspace/secrets");
  if (!record(value) || !Array.isArray(value.secrets)) return fail("secrets_response_invalid");
  return value.secrets.filter((entry): entry is SecretSummary => record(entry) && typeof entry.id === "string" &&
    typeof entry.kind === "string" && typeof entry.name === "string" && typeof entry.versionId === "string");
}

/**
 * The Saucedemo secret is saved only for a scenario that expects it (S3):
 * S5 signs in through the user, so a saved login must not be there to use.
 */
async function syncSaucedemoSecret(api: Api, wanted: boolean): Promise<void> {
  const saved = (await secrets(api)).filter((secret) => secret.kind === "env" && secret.name === SAUCEDEMO_SECRET.name);
  if (wanted && saved.length === 0) {
    await json(api, "/api/me/workspace/secrets", { body: {
      action: "create", description: SAUCEDEMO_SECRET.description, name: SAUCEDEMO_SECRET.name,
      value: { entries: SAUCEDEMO_SECRET.entries.map((entry) => ({ ...entry })), kind: "env" }
    }, method: "POST" });
  }
  if (!wanted) {
    for (const secret of saved) {
      await json(api, "/api/me/workspace/secrets", {
        body: { action: "delete", expectedVersionId: secret.versionId, id: secret.id }, method: "POST"
      });
    }
    if ((await secrets(api)).some((secret) => secret.kind === "env" && secret.name === SAUCEDEMO_SECRET.name)) {
      fail("saucedemo_secret_cleanup_failed");
    }
  }
}

/**
 * Removes saved browser sessions, so every run starts signed out like the
 * first, and proves it by listing again. Throws when one is still there.
 */
async function removeBrowserSessions(api: Api): Promise<number> {
  let removed = 0;
  for (const secret of (await secrets(api)).filter((entry) => entry.kind === "browser_session")) {
    await json(api, "/api/me/workspace/secrets", {
      body: { action: "delete", expectedVersionId: secret.versionId, id: secret.id }, method: "POST"
    });
    removed += 1;
  }
  if ((await secrets(api)).some((entry) => entry.kind === "browser_session")) fail("browser_session_cleanup_failed");
  return removed;
}

// One run ----------------------------------------------------------------------------

type RunRow = { errorCode: string | null; id: string; status: string; toolBudgets: unknown; turnTimeoutSeconds: unknown };

async function latestRun(db: PostgresClient, chatId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(`SELECT "id", "status"::text AS "status", "errorPayload"->>'code' AS "errorCode",
      "normalizedRequest"->'toolBudgets' AS "toolBudgets",
      "normalizedRequest"->'workspace'->'turnTimeoutSeconds' AS "turnTimeoutSeconds"
    FROM "ModelRun" WHERE "chatId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [chatId]);
  return rows[0] ?? null;
}

async function deleteChat(api: Api, db: PostgresClient, chatId: string): Promise<boolean> {
  try {
    const run = await latestRun(db, chatId);
    if (run && !TERMINAL.has(run.status)) {
      await request(api, `/api/model-runs/${encodeURIComponent(run.id)}/cancel`, { body: {}, method: "POST" });
    }
    const admitted = decodeMemoryConsumerPermanentChatDeleteResponse(await json(api,
      `/api/chats/${encodeURIComponent(chatId)}/delete-permanently`, { body: {
        alsoForgetOriginMemories: true, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID()
      }, method: "POST" }));
    if (!admitted.ok) return false;
    await poll(300_000, async () => {
      const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text AS "count" FROM "Chat" WHERE "id" = $1`, [chatId]);
      return rows[0]?.count === "0" ? true : null;
    }, "chat_delete_timeout");
    return true;
  } catch {
    return false;
  }
}

/** The run's `browser_handoff` calls with their arguments and results, read only for the oracle. */
async function handoffCalls(db: PostgresClient, runId: string): Promise<HandoffCallRow[]> {
  const { rows } = await db.query<HandoffCallRow>(`SELECT "state"::text AS "state", "arguments", "result"
    FROM "ModelRunToolCall" WHERE "modelRunId" = $1 AND "toolName" = 'browser_handoff' ORDER BY "roundIndex", "ordinal"`, [runId]);
  return rows;
}

/**
 * Counts the run's stored rows that carry what the user typed into the live
 * view (`TypedValueLeaks`): the chat's messages and the run's tool calls,
 * transcript items and events. Only counts leave the database.
 */
async function typedValueLeaks(db: PostgresClient, chatId: string, runId: string, marker: string): Promise<TypedValueLeaks> {
  const { rows } = await db.query<TypedValueLeaks>(`WITH "fence" AS (
      SELECT min("startedAt") AS "at" FROM "ModelRunToolCall" WHERE "modelRunId" = $2 AND "toolName" = 'browser_handoff'
    ), "stored" AS (
      SELECT "content"::text AS "body", "updatedAt" AS "at", false AS "agentArguments" FROM "Message" WHERE "chatId" = $1
      UNION ALL SELECT coalesce("errorMessage", ''), "updatedAt", false FROM "Message" WHERE "chatId" = $1
      UNION ALL SELECT "arguments"::text, "updatedAt", true FROM "ModelRunToolCall" WHERE "modelRunId" = $2
      UNION ALL SELECT coalesce("result"::text, ''), "updatedAt", false FROM "ModelRunToolCall" WHERE "modelRunId" = $2
      UNION ALL SELECT "body"::text, "createdAt", false FROM "RunTranscriptItem" WHERE "modelRunId" = $2
      UNION ALL SELECT "payload"::text, "createdAt", false FROM "ModelRunEvent" WHERE "modelRunId" = $2
    ), "matched" AS (
      SELECT "body", "at", "agentArguments",
        EXISTS (SELECT 1 FROM unnest($4::text[]) AS "value" WHERE strpos("body", "value") > 0) AS "credential"
      FROM "stored"
    )
    SELECT count(*) FILTER (WHERE strpos("body", $3) > 0)::int AS "marker",
      count(*) FILTER (WHERE "credential" AND "agentArguments")::int AS "credentialsInToolArguments",
      count(*) FILTER (WHERE "credential" AND NOT "agentArguments" AND "at" >= (SELECT "at" FROM "fence"))::int AS "credentialsAfterHandoff"
    FROM "matched"`, [chatId, runId, marker, [...SAUCEDEMO_LOGIN_VALUES]]);
  return rows[0] ?? fail("leak_check_failed");
}

/** Reads and discards a streamed answer within a byte bound; nothing is kept. */
async function discard(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > 64 * 1024 * 1024) return;
    }
  } catch {
    // The harness aborts the stream once the run is terminal.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type RunContext = Readonly<{
  api: Api;
  db: PostgresClient;
  keepChats: boolean;
  marginSeconds: number;
  model: CatalogModel;
  standBounds: StandTarget["configuredBounds"];
}>;

async function runOnce(context: RunContext, scenario: BrowserScenario, run: number): Promise<RunRecord> {
  const { api, db } = context;
  const line: Record<string, unknown> = { scenario: scenario.id, run };
  let blocked: BrowserBlockedCode[] = [];
  let success = false;
  let rounds: number | null = null;
  let toolCalls: number | null = null;
  let wallSeconds: number | null = null;
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let chatId: string | null = null;
  // Typed only into the live view (S5); the run's leak check looks for it. Never printed.
  const marker = `zq${randomUUID().replaceAll("-", "")}`;
  const measured = await (async (): Promise<RunRecord> => { try {
    // A session saved late by the previous run's settlement must not sign this run in.
    stage = "pre_run_cleanup";
    line.sessionsRemovedBefore = await removeBrowserSessions(api);
    await syncSaucedemoSecret(api, scenario.secret === "saucedemo");
    stage = "chat";
    const chat = decodeChatSummaryResponse(await json(api, "/api/chats", {
      body: { title: `Browser scenario ${scenario.id} run ${run}` }, method: "POST"
    })) ?? fail("chat_response_invalid");
    chatId = chat.id;
    const mode = decodeMemoryConsumerChatModeResponse(await json(api,
      `/api/me/chats/${encodeURIComponent(chat.id)}/memory-mode`, { body: { mode: "EXCLUDED" }, method: "PATCH" }));
    if (!mode.ok || mode.value.mode !== "EXCLUDED") fail("memory_exclusion_failed");
    stage = "send";
    const stream = new AbortController();
    const started = Date.now();
    const response = await request(api, `/api/chats/${encodeURIComponent(chat.id)}/messages`, { body: {
      content: { blocks: [{ text: scenario.prompt, type: "text" }] },
      expectedActiveLeafId: chat.activeLeafMessageId,
      modelId: context.model.modelId,
      params: context.model.defaultParams,
      provider: context.model.provider,
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchStrategy: "search-disabled",
      timeZone: "Europe/Madrid",
      workspace: { enabled: true }
    }, method: "POST", signal: stream.signal });
    if (!response.ok) {
      Object.assign(line, { terminal: "admission_failed", failureCode: await errorCode(response) });
      return { blocked, costUsd, inputTokens, outputTokens, rounds, scenario: scenario.id, success, toolCalls, wallSeconds };
    }
    const drained = discard(response);
    stage = "wait";
    const admitted = await poll(120_000, () => latestRun(db, chat.id), "run_not_admitted");
    const bounds: RunBounds = runBounds({ toolBudgets: admitted.toolBudgets, workspace: { turnTimeoutSeconds: admitted.turnTimeoutSeconds } });
    line.bounds = bounds;
    const limitSeconds = typeof bounds.turnTimeoutSeconds === "number" ? bounds.turnTimeoutSeconds
      : typeof context.standBounds.turnTimeoutSeconds === "number" ? context.standBounds.turnTimeoutSeconds : 3_600;
    const interaction = new AbortController();
    const interacting = scenario.interaction?.({ baseUrl: api.baseUrl.origin, chatId: chat.id, cookie: api.cookie, marker,
      runId: admitted.id, signal: interaction.signal }).then((evidence) => { line.interaction = evidence; }, (error: unknown) => {
      line.interactionFailed = error instanceof BrowserScenarioError ? error.message : "browser_scenarios_interaction_failed";
    });
    let terminal: RunRow | null = null;
    try {
      terminal = await poll((limitSeconds + context.marginSeconds) * 1_000, async () => {
        const current = await latestRun(db, chat.id);
        return current && current.id === admitted.id && TERMINAL.has(current.status) ? current : null;
      }, "harness_timeout", 3_000);
    } catch (error) {
      if (!(error instanceof BrowserScenarioError)) throw error;
      await request(api, `/api/model-runs/${encodeURIComponent(admitted.id)}/cancel`, { body: {}, method: "POST" });
    }
    wallSeconds = Math.round((Date.now() - started) / 100) / 10;
    interaction.abort();
    stream.abort();
    await Promise.all([drained, interacting]);
    line.terminal = terminal?.status ?? "harness_timeout";
    line.failureCode = terminal ? safeCode(terminal.errorCode) : "harness_timeout";
    line.wallSeconds = wallSeconds;
    stage = "evidence";
    type Binding = { exportState: string; internetEnabled: boolean | null };
    const binding = await poll<Binding>(300_000, async () => {
      const { rows } = await db.query<Binding>(
        `SELECT "exportState"::text AS "exportState", "internetEnabled" FROM "WorkspaceRunBinding" WHERE "modelRunId" = $1`, [admitted.id]);
      const row = rows[0];
      if (!row) return { exportState: "none", internetEnabled: null };
      return row.exportState === "COMPLETE" || row.exportState === "FAILED" ? row : null;
    }, "export_timeout", 3_000).catch((): Binding => ({ exportState: "pending", internetEnabled: null }));
    Object.assign(line, { exportState: binding.exportState, internetEnabled: binding.internetEnabled });
    const { rows: calls } = await db.query<ToolCallRow>(`SELECT "toolName", "state"::text AS "state", "roundIndex"
      FROM "ModelRunToolCall" WHERE "modelRunId" = $1`, [admitted.id]);
    const stats = toolCallStats(calls);
    rounds = stats.rounds;
    toolCalls = stats.toolCalls;
    Object.assign(line, stats);
    // Usage is recorded after the answer: wait briefly for the answer's own receipt.
    const usageRows = await poll(120_000, async () => {
      const { rows } = await db.query<UsageRow & { purpose: string }>(`SELECT "purpose"::text AS "purpose", "costReported",
          "estimatedCostMicros", "inputTokens", "outputTokens" FROM "UsageEvent" WHERE "modelRunId" = $1`, [admitted.id]);
      return rows.some((row) => row.purpose === "chat_answer") ? rows : null;
    }, "usage_timeout", 3_000).catch(() => null);
    const usage = usageEvidence(usageRows ?? []);
    ({ costUsd, inputTokens, outputTokens } = usage);
    Object.assign(line, usage, { usageSettled: usageRows !== null });
    stage = "result";
    const { rows: outputs } = await db.query<{ attachmentId: string; byteSize: number; relativePath: string }>(
      `SELECT "attachmentId", "byteSize", "relativePath" FROM "WorkspaceRunOutput" WHERE "workspaceRunBindingId" = $1`, [admitted.id]);
    line.outputFiles = outputs.length;
    const output = outputs.find((entry) => entry.relativePath === BROWSER_RESULT_FILE) ??
      outputs.find((entry) => entry.relativePath.endsWith(`/${BROWSER_RESULT_FILE}`));
    let checks: string[];
    if (!output) checks = ["result_missing"];
    else if (output.byteSize > BROWSER_RESULT_MAX_BYTES) checks = ["result_too_large"];
    else {
      const content = await request(api, `/api/attachments/${encodeURIComponent(output.attachmentId)}/content`);
      const parsed = content.ok ? parseBrowserResult(new Uint8Array(await content.arrayBuffer())) : null;
      if (!parsed) checks = ["result_unreadable"];
      else if (!parsed.ok) checks = [parsed.code];
      else {
        blocked = [...parsed.blocked];
        line.resultStatus = ["completed", "partial", "blocked"].includes(String(parsed.value.status)) ? parsed.value.status : "other";
        const verdict = checkBrowserResult(scenario, parsed.value);
        checks = [...verdict.failed];
        line.oracleCounts = verdict.counts;
      }
    }
    if (scenario.runOracle) {
      stage = "run_evidence";
      const runVerdict = scenario.runOracle({
        handoffs: await handoffCalls(db, admitted.id),
        leaks: await typedValueLeaks(db, chat.id, admitted.id, marker).catch(() => null)
      });
      checks = [...checks, ...runVerdict.failed];
      line.runOracleCounts = runVerdict.counts;
    }
    line.checksFailed = checks;
    line.blocked = blocked;
    success = terminal?.status === "complete" && checks.length === 0;
    return { blocked, costUsd, inputTokens, outputTokens, rounds, scenario: scenario.id, success, toolCalls, wallSeconds };
  } catch (error) {
    line.harnessError = error instanceof BrowserScenarioError ? error.message : "browser_scenarios_run_failed";
    line.harnessStage = stage;
    return { blocked, costUsd, inputTokens, outputTokens, rounds, scenario: scenario.id, success: false, toolCalls, wallSeconds };
  } })();
  line.success = measured.success;
  const { cleaned, ...cleanup } = await cleanUpRun({
    deleteChat: (id) => deleteChat(api, db, id),
    removeBrowserSessions: () => removeBrowserSessions(api)
  }, chatId, context.keepChats);
  Object.assign(line, cleanup);
  emit(line);
  if (!cleaned) fail("cleanup_failed");
  return measured;
}

// Main -------------------------------------------------------------------------------

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(code);
}

async function main() {
  const composeFile = process.env.AIQSA_BROWSER_SCENARIOS_COMPOSE_FILE ?? fail("compose_required");
  const target = requireBrowserScenarioStand(process.env.AIQSA_BROWSER_SCENARIOS_E2E,
    JSON.parse(readFileSync(composeFile, "utf8")) as BrowserScenarioStand);
  const scenarios = selectedScenarios(process.env.AIQSA_BROWSER_SCENARIOS_SELECT);
  const runs = boundedInteger(process.env.AIQSA_BROWSER_SCENARIOS_RUNS, 2, 1, 5, "runs_invalid");
  const marginSeconds = boundedInteger(process.env.AIQSA_BROWSER_SCENARIOS_MARGIN_SECONDS, 600, 60, 3_600, "margin_invalid");
  const label = process.env.AIQSA_BROWSER_SCENARIOS_LABEL?.trim() || "unlabelled";
  if (!/^[A-Za-z0-9._/-]{1,80}$/u.test(label)) fail("label_invalid");
  const route = codexLbRoute(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"));
  const secret = process.env.CODEX_LB_API_KEY ?? fail("codex_lb_key_required");
  const chat = chatRoute(process.env);
  const db = new PostgresClient({ connectionString: target.databaseUrl });
  await db.connect();
  const started = Date.now();
  const records: RunRecord[] = [];
  try {
    stage = "preflight";
    const { rows } = await db.query<{ active: string; chats: string }>(`SELECT
      (SELECT count(*) FROM "ModelRun" WHERE "status"::text NOT IN ('complete', 'cancelled', 'error'))::text AS "active",
      (SELECT count(*) FROM "Chat")::text AS "chats"`);
    if (rows[0]?.active !== "0" || rows[0]?.chats !== "0") fail("stand_not_idle");
    const api = await authenticate(target);
    stage = "setup";
    await json(api, "/api/me/memory/settings", { body: {
      decayEnabled: false, learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false
    }, method: "PATCH" });
    await ensureWorkspaceInternet(api);
    const provider = await ensureModel(api, route, secret);
    // System Vision stays on the vision-capable codex-lb model whichever chat route runs.
    await ensureSystemVision(api, provider.providerModelId);
    const chatProvider = chat.route === "openrouter"
      ? await ensureTextModel(api, chat.model, process.env.OPENROUTER_API_KEY ?? fail("openrouter_key_required"))
      : provider;
    const model = await poll(SETUP_TIMEOUT_MS, async () => {
      const catalog = decodeCatalogResponse(await json(api, "/api/me/catalog")) ?? fail("catalog_response_invalid");
      const entry = catalog.models.find((candidate) =>
        candidate.provider === chatProvider.connectionId && candidate.modelId === chatProvider.providerModelId);
      return entry && entry.capabilities.toolCalling ? entry : null;
    }, "catalog_model_missing", 5_000);
    if (chat.route === "openrouter" && model.capabilities.imageInput) fail("text_model_has_image_input");
    emit({ stage: "ready", label, project: target.project, provider: "codex-lb", model: route.model,
      chatRoute: chat.route, chatModel: chat.route === "openrouter" ? chat.model : route.model, chatImageInput: model.capabilities.imageInput,
      contextWindow: chatProvider.contextWindow, reused: chatProvider.reused, systemVision: true, workspaceInternet: true,
      configuredBounds: target.configuredBounds, scenarios, runs });
    const context: RunContext = { api, db, keepChats: process.env.AIQSA_BROWSER_SCENARIOS_KEEP_CHATS === "1",
      marginSeconds, model, standBounds: target.configuredBounds };
    // Runs interleave scenarios, so one site is not hit back to back.
    for (let run = 1; run <= runs; run += 1) {
      for (const id of scenarios) {
        const scenario = BROWSER_SCENARIOS[id];
        if (scenario.availability !== "available") continue;
        records.push(await runOnce(context, scenario, run));
      }
    }
    const summary = scenarios.map((id: BrowserScenarioId) => BROWSER_SCENARIOS[id].availability === "available"
      ? scenarioSummary(id, records) : { scenario: id, status: "not_available" });
    for (const row of summary) emit({ stage: "summary", ...row });
    emit({ status: "finished", label, model: chat.route === "openrouter" ? chat.model : route.model, runs: records.length,
      successes: records.filter((entry) => entry.success).length, elapsedSeconds: Math.round((Date.now() - started) / 1000) });
  } finally {
    await db.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof BrowserScenarioError ? error.message : "browser_scenarios_check_failed";
  emit({ status: "failed", stage, code });
  process.exitCode = 1;
});
