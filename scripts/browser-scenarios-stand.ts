/**
 * The stand side of the paid scenario harnesses (`scripts/smoke-browser-scenarios-paid.ts`,
 * `scripts/smoke-subagents-paid.ts`): HTTP calls as a signed-in user, the
 * administrator setup through the ordinary Admin and user APIs, read-only
 * `pg` evidence that both share, chat creation and permanent deletion with
 * proof, saved browser sessions and the Saucedemo secret, and the result file
 * a main-agent answer exports. Nothing here prints; callers emit only
 * content-free evidence.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client as PostgresClient, types as pgTypes, type CustomTypesConfig } from "pg";
import { decodeCatalogResponse, type CatalogModel } from "../lib/contracts/catalog";
import { decodeChatSummaryResponse } from "../lib/contracts/chats";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryConsumerChatModeResponse,
  decodeMemoryConsumerPermanentChatDeleteResponse
} from "../lib/contracts/memoryClient";
import { SUBAGENT_API_PATHS } from "../lib/contracts/subagentViews";
import {
  BROWSER_RESULT_FILE, BROWSER_RESULT_MAX_BYTES, BrowserScenarioError, OPENROUTER_API_ROOT, SAUCEDEMO_LOGIN_VALUES, SAUCEDEMO_SECRET,
  openRouterTextModel, parseBrowserResult, textChatCapabilities, type BrowserBlockedCode, type BrowserResult, type ChatRoute,
  type HandoffCallRow, type StandTarget, type TypedValueLeaks
} from "./browser-scenarios-support";
import {
  JOURNEY_LIMITS, discoveredContextWindow, journeyReuseDecision, modelInConnection, readConnections,
  type JourneyConnection
} from "./context-compaction-journey-support";

export const REQUEST_TIMEOUT_MS = 60_000;
export const SETUP_TIMEOUT_MS = 900_000;
export const MODEL_DISPLAY_NAME = "Browser scenarios model";
export const TEXT_MODEL_DISPLAY_NAME = "Browser scenarios text model";
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["complete", "cancelled", "error"]);

const fail = (code: string): never => { throw new BrowserScenarioError(code); };
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const safeCode = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value) ? value : null;

// The stand's database ------------------------------------------------------------

/** PostgreSQL's `timestamp without time zone`, which Prisma's `DateTime` columns are. */
export const TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u;

/**
 * A `timestamp without time zone` as Prisma writes it: UTC. node-pg would
 * read it in the harness host's local zone, which shifts every stored time
 * against `Date.now()` by the host's offset (3 h on a `Europe/Istanbul` host).
 * Anything else (`infinity`, BC dates) keeps node-pg's own parser.
 */
export function parseUtcTimestamp(value: string): Date {
  if (!TIMESTAMP_TEXT.test(value)) return pgTypes.getTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE_OID, "text")(value) as Date;
  return new Date(`${value.replace(" ", "T")}Z`);
}

/** The harnesses' type parsers: node-pg's own, with stored timestamps read as UTC. Per client, never global. */
export const STAND_DATABASE_TYPES: CustomTypesConfig = {
  getTypeParser: ((id: number, format?: "binary" | "text") => Number(id) === TIMESTAMP_WITHOUT_TIME_ZONE_OID && format !== "binary"
    ? parseUtcTimestamp : pgTypes.getTypeParser(id, format)) as CustomTypesConfig["getTypeParser"]
};

/** The read-only evidence connection both harnesses use. */
export function standDatabase(connectionString: string): PostgresClient {
  return new PostgresClient({ connectionString, types: STAND_DATABASE_TYPES });
}

export type Api = Readonly<{ baseUrl: URL; cookie: string }>;
export type CallInit = Readonly<{ body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number }>;

export async function request(api: Pick<Api, "baseUrl"> & Partial<Pick<Api, "cookie">>, path: string, init: CallInit = {}) {
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

export async function errorCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as unknown;
  return (isRecord(body) && safeCode(body.error)) || `http_${response.status}`;
}

export async function json(api: Api, path: string, init: CallInit = {}): Promise<unknown> {
  const response = await request(api, path, init);
  if (!response.ok) fail(await errorCode(response));
  return response.json().catch(() => fail("response_invalid"));
}

export async function poll<T>(timeoutMs: number, probe: () => Promise<T | null>, code: string, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value !== null) return value;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return fail(code);
}

export async function authenticate(target: StandTarget): Promise<Api> {
  const baseUrl = new URL(target.baseUrl);
  const response = await request({ baseUrl }, "/api/auth/login", { body: { ...target.admin }, method: "POST" });
  if (!response.ok) fail(`auth_${await errorCode(response)}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .find((value) => value.includes("=")) ?? "";
  const body = await response.json().catch(() => null) as unknown;
  if (!cookie || !isRecord(body) || !isRecord(body.user) || body.user.role !== "admin") fail("admin_session_required");
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

export type StandModel = Readonly<{ connectionId: string; contextWindow: number; providerModelId: string; reused: boolean }>;

/**
 * A vision-capable codex-lb chat model under `displayName`, reused when an
 * identical usable one exists, otherwise added as an administrator would.
 */
export async function ensureModel(api: Api, route: Readonly<{ apiRoot: string; model: string }>, secret: string,
  displayName: string = MODEL_DISPLAY_NAME): Promise<StandModel> {
  let catalogProof: string | undefined;
  let contextWindow: number = JOURNEY_LIMITS.defaultContextWindow;
  const discovery = await request(api, "/api/admin/providers/custom-setup/discover", { body: {
    allowPrivateNetwork: true, apiRoot: route.apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (discovery.ok) {
    const value = await discovery.json().catch(() => null) as unknown;
    if (isRecord(value) && Array.isArray(value.models) && value.models.some((model) => isRecord(model) && model.id === route.model)) {
      if (typeof value.catalogProof === "string") catalogProof = value.catalogProof;
      contextWindow = discoveredContextWindow(value, route.model) ?? contextWindow;
    }
  }
  const decision = journeyReuseDecision(await connections(api), {
    apiRoot: route.apiRoot, family: "openai_compatible", upstreamModelId: route.model
  });
  const reusable = decision.match && decision.match.model.displayName === displayName ? decision.match : null;
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
    modelDisplayName: displayName, protocol: "responses", responseTimeoutSeconds: 180, secret,
    ...(catalogProof ? { catalogProof, modelIds: [route.model] } : { modelId: route.model })
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (!isRecord(result) || typeof result.connectionId !== "string" || (result.outcome !== "ready" && result.outcome !== "partial")) {
    fail(`setup_${isRecord(result) ? safeCode(result.outcome) ?? "invalid" : "invalid"}`);
  }
  const connectionId = (result as { connectionId: string }).connectionId;
  const model = modelInConnection(await checksIdle(api, connectionId), route.model) ?? fail("model_not_configured");
  return { connectionId, contextWindow, providerModelId: model.id, reused: false };
}

/**
 * The text-only OpenRouter chat model, added as an OpenAI-compatible Chat
 * Completions connection: custom setup probes only this model, whereas the
 * OpenRouter family's first key would add and check every built-in OpenRouter
 * model. The public listing (no key) proves tool calling and text-only input.
 */
export async function ensureTextModel(api: Api, model: string, secret: string): Promise<StandModel> {
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
    if (isRecord(value) && Array.isArray(value.models) && value.models.some((entry) => isRecord(entry) && entry.id === model) &&
      typeof value.catalogProof === "string") catalogProof = value.catalogProof;
  }
  const result = await json(api, "/api/admin/providers/custom-setup", { body: {
    allowPrivateNetwork: false, apiRoot: OPENROUTER_API_ROOT, authenticationMode: "bearer",
    capabilities: textChatCapabilities(listed.contextWindow),
    confirmPaidRequest: true, connectionDisplayName: `Browser scenarios OpenRouter ${randomUUID().slice(0, 8)}`,
    modelDisplayName: TEXT_MODEL_DISPLAY_NAME, protocol: "chat_completions", responseTimeoutSeconds: 180, secret,
    ...(catalogProof ? { catalogProof, modelIds: [model] } : { modelId: model })
  }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS });
  if (!isRecord(result) || typeof result.connectionId !== "string" || (result.outcome !== "ready" && result.outcome !== "partial")) {
    fail(`text_setup_${isRecord(result) ? safeCode(result.outcome) ?? "invalid" : "invalid"}`);
  }
  const connectionId = (result as { connectionId: string }).connectionId;
  const added = modelInConnection(await checksIdle(api, connectionId), model) ?? fail("text_model_not_configured");
  return { connectionId, contextWindow: listed.contextWindow, providerModelId: added.id, reused: false };
}

export async function ensureSystemVision(api: Api, providerModelId: string): Promise<void> {
  await json(api, "/api/admin/providers/system-model-policy", {
    body: { providerModelId, role: "vision" }, method: "POST", timeoutMs: SETUP_TIMEOUT_MS
  });
  const current = await json(api, "/api/admin/providers/system-model-policy");
  const policy = isRecord(current) && isRecord(current.systemModelPolicy) && isRecord(current.systemModelPolicy.policy)
    ? current.systemModelPolicy.policy : fail("system_policy_invalid");
  const updated = await json(api, "/api/admin/providers/system-model-policy", { body: {
    expectedVersion: policy.version, visionProviderModelId: providerModelId, visionReasoningEffort: "low"
  }, method: "PATCH" });
  const vision = isRecord(updated) && isRecord(updated.systemModelPolicy) && isRecord(updated.systemModelPolicy.policy)
    ? updated.systemModelPolicy.policy.visionModel : null;
  if (!isRecord(vision) || vision.available !== true) fail("system_vision_unavailable");
}

export async function ensureWorkspaceInternet(api: Api): Promise<void> {
  const current = await json(api, "/api/admin/workspace");
  const workspace = isRecord(current) && isRecord(current.workspace) ? current.workspace : fail("workspace_policy_invalid");
  const version = workspace.version ?? (isRecord(workspace.policy) ? workspace.policy.version : undefined);
  await json(api, "/api/admin/workspace", { body: { enabled: true, expectedVersion: version, internetEnabled: true }, method: "PATCH" });
}

/** The user's catalog entry of a configured model, once it offers tool calling. */
export async function catalogModel(api: Api, model: Pick<StandModel, "connectionId" | "providerModelId">): Promise<CatalogModel> {
  return poll(SETUP_TIMEOUT_MS, async () => {
    const catalog = decodeCatalogResponse(await json(api, "/api/me/catalog")) ?? fail("catalog_response_invalid");
    const entry = catalog.models.find((candidate) =>
      candidate.provider === model.connectionId && candidate.modelId === model.providerModelId);
    return entry && entry.capabilities.toolCalling ? entry : null;
  }, "catalog_model_missing", 5_000);
}

/** Refuses a stand that has chats or active runs: every measurement starts from the same empty state. */
export async function requireIdleStand(db: PostgresClient): Promise<void> {
  const { rows } = await db.query<{ active: string; chats: string }>(`SELECT
    (SELECT count(*) FROM "ModelRun" WHERE "status"::text NOT IN ('complete', 'cancelled', 'error'))::text AS "active",
    (SELECT count(*) FROM "Chat")::text AS "chats"`);
  if (rows[0]?.active !== "0" || rows[0]?.chats !== "0") fail("stand_not_idle");
}

export type StandSetup = Readonly<{ chatProvider: StandModel; model: CatalogModel; provider: StandModel }>;

/**
 * Memory off for the user, Workspace on with internet, the codex-lb model,
 * System Vision on it, and the chat model the runs use (codex-lb, or the
 * text-only OpenRouter route) as the user's catalog offers it.
 */
export async function setUpStand(api: Api, input: Readonly<{
  chat: ChatRoute; openRouterKey?: string; route: Readonly<{ apiRoot: string; model: string }>; secret: string;
}>): Promise<StandSetup> {
  await json(api, "/api/me/memory/settings", { body: {
    decayEnabled: false, learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false
  }, method: "PATCH" });
  await ensureWorkspaceInternet(api);
  const provider = await ensureModel(api, input.route, input.secret);
  // System Vision stays on the vision-capable codex-lb model whichever chat route runs.
  await ensureSystemVision(api, provider.providerModelId);
  const chatProvider = input.chat.route === "openrouter"
    ? await ensureTextModel(api, input.chat.model, input.openRouterKey ?? fail("openrouter_key_required"))
    : provider;
  return { chatProvider, model: await catalogModel(api, chatProvider), provider };
}

// Secrets and saved browser sessions ------------------------------------------------

type SecretSummary = Readonly<{ id: string; kind: string; name: string; versionId: string }>;

async function secrets(api: Api): Promise<SecretSummary[]> {
  const value = await json(api, "/api/me/workspace/secrets");
  if (!isRecord(value) || !Array.isArray(value.secrets)) return fail("secrets_response_invalid");
  return value.secrets.filter((entry): entry is SecretSummary => isRecord(entry) && typeof entry.id === "string" &&
    typeof entry.kind === "string" && typeof entry.name === "string" && typeof entry.versionId === "string");
}

/**
 * The Saucedemo secret is saved only for a scenario that expects it (S3):
 * S5 signs in through the user, so a saved login must not be there to use.
 */
export async function syncSaucedemoSecret(api: Api, wanted: boolean): Promise<void> {
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
export async function removeBrowserSessions(api: Api): Promise<number> {
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

// Chats and runs ---------------------------------------------------------------------

export type RunRow = { errorCode: string | null; id: string; status: string; toolBudgets: unknown; turnTimeoutSeconds: unknown };

/** The chat's latest main-agent run (background sub-agent runs are the sub-agents' own). */
export async function latestRun(db: PostgresClient, chatId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(`SELECT "id", "status"::text AS "status", "errorPayload"->>'code' AS "errorCode",
      "normalizedRequest"->'toolBudgets' AS "toolBudgets",
      "normalizedRequest"->'workspace'->'turnTimeoutSeconds' AS "turnTimeoutSeconds"
    FROM "ModelRun" WHERE "chatId" = $1 AND "subagentTurnId" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, [chatId]);
  return rows[0] ?? null;
}

/** A Memory-excluded chat of the signed-in user. */
export async function createScenarioChat(api: Api, title: string): Promise<Readonly<{ activeLeafMessageId: string | null; id: string }>> {
  const chat = decodeChatSummaryResponse(await json(api, "/api/chats", { body: { title }, method: "POST" })) ??
    fail("chat_response_invalid");
  const mode = decodeMemoryConsumerChatModeResponse(await json(api,
    `/api/me/chats/${encodeURIComponent(chat.id)}/memory-mode`, { body: { mode: "EXCLUDED" }, method: "PATCH" }));
  if (!mode.ok || mode.value.mode !== "EXCLUDED") fail("memory_exclusion_failed");
  return { activeLeafMessageId: chat.activeLeafMessageId, id: chat.id };
}

/** The run controls of an ordinary send or regeneration on `model`, Workspace on, Search off. */
export function runControls(model: CatalogModel) {
  return {
    modelId: model.modelId,
    params: model.defaultParams,
    provider: model.provider,
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchStrategy: "search-disabled",
    timeZone: "Europe/Madrid",
    workspace: { enabled: true }
  };
}

/**
 * Deletes the chat permanently and resolves true only once it is proven
 * gone: its sub-agents are stopped and its active main-agent runs cancelled
 * first, so nothing it runs outlives the measurement.
 */
export async function deleteChat(api: Api, db: PostgresClient, chatId: string): Promise<boolean> {
  try {
    await request(api, SUBAGENT_API_PATHS.stopAll(chatId), { body: {}, method: "POST" }).catch(() => undefined);
    const { rows: active } = await db.query<{ id: string }>(`SELECT "id" FROM "ModelRun"
      WHERE "chatId" = $1 AND "subagentTurnId" IS NULL AND "status"::text NOT IN ('complete', 'cancelled', 'error')`, [chatId]);
    for (const run of active) {
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

/** Reads and discards a streamed answer within a byte bound; nothing is kept. */
export async function discard(response: Response): Promise<void> {
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

// Handoff evidence -------------------------------------------------------------------

/**
 * The runs' `browser_handoff` calls with their arguments and results, read
 * only for the oracle; `subagentsOnly` keeps the calls sub-agents made.
 */
export async function handoffCalls(db: PostgresClient, runIds: readonly string[], subagentsOnly = false): Promise<HandoffCallRow[]> {
  const { rows } = await db.query<HandoffCallRow>(`SELECT "state"::text AS "state", "arguments", "result"
    FROM "ModelRunToolCall" WHERE "modelRunId" = ANY($1::text[]) AND "toolName" = 'browser_handoff'
      AND ($2::boolean = false OR "subagentThreadId" IS NOT NULL)
    ORDER BY "createdAt", "roundIndex", "ordinal"`, [[...runIds], subagentsOnly]);
  return rows;
}

/**
 * Counts the stored rows of the chat and the given runs that carry what the
 * user typed into the live view (`TypedValueLeaks`): the chat's messages and
 * the runs' tool calls, transcript items and events. Only counts leave the
 * database.
 */
export async function typedValueLeaks(db: PostgresClient, chatId: string, runIds: readonly string[], marker: string): Promise<TypedValueLeaks> {
  const { rows } = await db.query<TypedValueLeaks>(`WITH "fence" AS (
      SELECT min("startedAt") AS "at" FROM "ModelRunToolCall" WHERE "modelRunId" = ANY($2::text[]) AND "toolName" = 'browser_handoff'
    ), "stored" AS (
      SELECT "content"::text AS "body", "updatedAt" AS "at", false AS "agentArguments" FROM "Message" WHERE "chatId" = $1
      UNION ALL SELECT coalesce("errorMessage", ''), "updatedAt", false FROM "Message" WHERE "chatId" = $1
      UNION ALL SELECT "arguments"::text, "updatedAt", true FROM "ModelRunToolCall" WHERE "modelRunId" = ANY($2::text[])
      UNION ALL SELECT coalesce("result"::text, ''), "updatedAt", false FROM "ModelRunToolCall" WHERE "modelRunId" = ANY($2::text[])
      UNION ALL SELECT "body"::text, "createdAt", false FROM "RunTranscriptItem" WHERE "modelRunId" = ANY($2::text[])
      UNION ALL SELECT "payload"::text, "createdAt", false FROM "ModelRunEvent" WHERE "modelRunId" = ANY($2::text[])
    ), "matched" AS (
      SELECT "body", "at", "agentArguments",
        EXISTS (SELECT 1 FROM unnest($4::text[]) AS "value" WHERE strpos("body", "value") > 0) AS "credential"
      FROM "stored"
    )
    SELECT count(*) FILTER (WHERE strpos("body", $3) > 0)::int AS "marker",
      count(*) FILTER (WHERE "credential" AND "agentArguments")::int AS "credentialsInToolArguments",
      count(*) FILTER (WHERE "credential" AND NOT "agentArguments" AND "at" >= (SELECT "at" FROM "fence"))::int AS "credentialsAfterHandoff"
    FROM "matched"`, [chatId, [...runIds], marker, [...SAUCEDEMO_LOGIN_VALUES]]);
  return rows[0] ?? fail("leak_check_failed");
}

// Result file ------------------------------------------------------------------------

export type RunExport = Readonly<{ exportState: string; internetEnabled: boolean | null }>;

/** Waits for the run's Workspace export to settle; `none` without a binding, `pending` when it did not settle in time. */
export async function awaitExport(db: PostgresClient, runId: string, timeoutMs = 300_000): Promise<RunExport> {
  return poll<RunExport>(timeoutMs, async () => {
    const { rows } = await db.query<RunExport>(
      `SELECT "exportState"::text AS "exportState", "internetEnabled" FROM "WorkspaceRunBinding" WHERE "modelRunId" = $1`, [runId]);
    const row = rows[0];
    if (!row) return { exportState: "none", internetEnabled: null };
    return row.exportState === "COMPLETE" || row.exportState === "FAILED" ? row : null;
  }, "export_timeout", 3_000).catch((): RunExport => ({ exportState: "pending", internetEnabled: null }));
}

export type ResultRead = Readonly<{ outputFiles: number }> & (
  | Readonly<{ blocked: readonly BrowserBlockedCode[]; ok: true; value: BrowserResult }>
  | Readonly<{ code: string; ok: false }>
);

/**
 * `browser-result.json` from the exported outputs of the given main-agent
 * runs, newest first: the first run that exported one wins. Only main-agent
 * runs export downloads, so a background sub-agent's result reaches the file
 * through the answer that received it.
 */
export async function readResultFile(api: Api, db: PostgresClient, runIdsNewestFirst: readonly string[]): Promise<ResultRead> {
  let outputFiles = 0;
  let found: { attachmentId: string; byteSize: number } | null = null;
  for (const runId of runIdsNewestFirst) {
    const { rows: outputs } = await db.query<{ attachmentId: string; byteSize: number; relativePath: string }>(
      `SELECT "attachmentId", "byteSize", "relativePath" FROM "WorkspaceRunOutput" WHERE "workspaceRunBindingId" = $1`, [runId]);
    outputFiles += outputs.length;
    const output = outputs.find((entry) => entry.relativePath === BROWSER_RESULT_FILE) ??
      outputs.find((entry) => entry.relativePath.endsWith(`/${BROWSER_RESULT_FILE}`));
    if (output && !found) found = output;
  }
  if (!found) return { code: "result_missing", ok: false, outputFiles };
  if (found.byteSize > BROWSER_RESULT_MAX_BYTES) return { code: "result_too_large", ok: false, outputFiles };
  const content = await request(api, `/api/attachments/${encodeURIComponent(found.attachmentId)}/content`);
  const parsed = content.ok ? parseBrowserResult(new Uint8Array(await content.arrayBuffer())) : null;
  if (!parsed) return { code: "result_unreadable", ok: false, outputFiles };
  if (!parsed.ok) return { code: parsed.code, ok: false, outputFiles };
  return { blocked: parsed.blocked, ok: true, outputFiles, value: parsed.value };
}
