/**
 * Opt-in, paid Search scenarios against a DISPOSABLE real-KVM AIQSA stand (queue search-v2: one installation engine
 * for every model, in-answer search, the engine for sub-agents and researchers). Never a default lane and never a
 * persistent installation. It drives the product as a user and an administrator would, through its own HTTP APIs:
 * Admin › Search (`GET`/`PATCH /api/admin/search`), Quick Setup and custom setup, and ordinary sends with
 * `searchEnabled: true`. Evidence comes from read-only `pg` queries; plans, results and answers are matched inside SQL
 * and only codes, booleans, counts and latency leave it. Keys, prompts, answers, URLs and source text are never printed.
 *
 * Scenarios, selected with AIQSA_SEARCH_SELECT (default A,B,C,D; E only when named), one chat each (C one per engine):
 * - A: the GPT answer model on codex-lb with verified hosted search, `inAnswerSearch` on: it searched inside its own
 *   answer. Oracles: the frozen plan binds the hosted search `in_answer`, the run made no `web_search` call, the main
 *   transcript recorded hosted search sources, the answer holds a link. Paid: 1-2 codex-lb requests, about 1 minute.
 * - B: the same with `inAnswerSearch` switched off through the Admin PATCH (restored at the end): one `web_search` call
 *   through the engine Admin resolved, completed with at least one source, and a link. Paid: 2-3 codex-lb requests plus
 *   one search on the resolved engine (the OpenAI client engine on codex-lb when it is the default), about 1-2 minutes.
 * - C: DeepSeek V4 Flash on a direct DeepSeek connection (AIQSA_SEARCH_DEEPSEEK_MODEL) with the engine set by the Admin
 *   PATCH in turn to each step of AIQSA_SEARCH_C_ENGINES (default all): `automatic` (engine and backup cleared; the
 *   default order picks, `openai_client` expected while the codex-lb source is ready), `openrouter_perplexity`,
 *   `deepseek` (the DeepSeek Search API) and `gemini` (Gemini Google Search). Each step: the frozen plan's engine is the
 *   one Admin resolved, of the step's kind (by protocol, never by URL), a `web_search` call through it completed with at
 *   least one source, and the answer holds a link. A step whose source the stand cannot set up is `not_configured` with
 *   its reason, never a failure. Engine and backup are restored, version-checked, after C and again at the end. Paid per
 *   step: 2-3 DeepSeek requests plus one search, about 1-2 minutes.
 * - D: under the GPT parent with `inAnswerSearch` on, a foreground sub-agent `s-searcher` on the DeepSeek model is asked
 *   to search: the sub-agent's thread made a `web_search` call through the engine that completed with a source (the
 *   parent's in-answer search is not passed down, `subagentSearchPlan`), and the parent made none. Paid: 2-3 codex-lb
 *   and 2-3 DeepSeek requests plus one search, about 2-3 minutes.
 * - E (only when named): a small Deep research run (`deepResearch: true`, the `+` menu's choice) on the GPT parent with
 *   `inAnswerSearch` on, no plan edit: research starts after its plan window, and its researchers' `web_search` calls
 *   complete through the engine with sources. Paid: tens of codex-lb requests and a few to tens of searches, about
 *   15-60 minutes (the wait is bounded at 120 minutes, then the run is cancelled).
 * Telegram is not covered: its only update hook (`/api/test/telegram/updates`) exists in test mode, which the stand
 * guard refuses, and a real bot needs a token and a linked Telegram account (as in `scripts/smoke-subagents-paid.ts`).
 *
 * Setup, before anything else is paid for: the stand must be idle (no chats, no active runs). The GPT model is added
 * through custom setup on codex-lb with native search declared (`ensureModel`; setup proves it and creates the
 * connection's web_search source with its hosted and client routes), or reused under its display name. DeepSeek, when
 * C or D runs and the stand has no DeepSeek connection, comes through Quick Setup with DEEPSEEK_API_KEY, which checks
 * DeepSeek's own models and its Search API. Two engines are only reused unless the operator approves a sweep:
 * - OpenRouter web search with Perplexity must already be on the stand with DeepSeek V4.1 Flash as its technical
 *   model; a source on any other OpenRouter model is `not_configured` (`openrouter_technical_model_other`) and never
 *   called. The app has no route that adds an OpenRouter connection without its built-in model sweep: the first key,
 *   through Quick Setup or the manual Add provider and key routes, adds and checks every built-in OpenRouter model, chat
 *   models included (`activateCredentialSecret`, `providerSetupModels` in `lib/server/admin/providers/`), and custom
 *   setup's OpenAI-compatible connection cannot carry OpenRouter's web search (`compatibleTechnicalAdapter`). So the
 *   harness adds OpenRouter only with AIQSA_SEARCH_OPENROUTER_SETUP=approved and OPENROUTER_API_KEY, the operator's
 *   explicit approval of that sweep; otherwise the step is `not_configured` (`openrouter_setup_not_approved`).
 * - Gemini Google Search is reused when a ready source exists; Gemini's first key likewise checks every built-in Gemini
 *   model (image generation included), so Quick Setup runs only with AIQSA_SEARCH_GEMINI_SETUP=approved and GEMINI_API_KEY.
 * Everything set up stays on the stand like the other harnesses' setup; the Search policy is restored.
 *
 * Output: a `ready` line, one JSON line per scenario (C's engine steps nested in its line) and a final line. The exit
 * code is 0 whenever the measurement completes (a failed oracle is data), 1 when a chat cannot be deleted and proven
 * gone or the Search policy cannot be restored.
 *
 * Environment (process only; no .env loading; keys are never printed):
 * - AIQSA_SEARCH_E2E=DISPOSABLE (required acknowledgement)
 * - AIQSA_SEARCH_COMPOSE_FILE: the stand's `docker compose config --format json`; the stand guard
 *   (`requireBrowserScenarioStand`) requires the app on 127.0.0.1:<port> (AIQSA_APP_BASE_URL) and PostgreSQL on
 *   127.0.0.1:<port>, the forwards of the stand's ports to this host
 * - CODEX_LB_ROOT (https, without /v1, for example https://codex-lb.psaux.info) and CODEX_LB_API_KEY
 * - AIQSA_SEARCH_GPT_MODEL (default gpt-6.2-sol), AIQSA_SEARCH_DEEPSEEK_MODEL (default deepseek-flash, the model DeepSeek Quick Setup adds)
 * - DEEPSEEK_API_KEY (C and D, unless the stand already has a DeepSeek connection)
 * - OPENROUTER_API_KEY with AIQSA_SEARCH_OPENROUTER_SETUP=approved; GEMINI_API_KEY with AIQSA_SEARCH_GEMINI_SETUP=approved
 * - AIQSA_SEARCH_SELECT, AIQSA_SEARCH_C_ENGINES, AIQSA_SEARCH_LABEL, AIQSA_SEARCH_KEEP_CHATS=1
 */
import { readFileSync } from "node:fs";
import type { Client as PostgresClient } from "pg";
import type { CatalogModel } from "../lib/contracts/catalog";
import { DEEP_RESEARCH_SEND_FIELD } from "../lib/contracts/research";
import { BrowserScenarioError, requireBrowserScenarioStand, type BrowserScenarioStand } from "./browser-scenarios-support";
import {
  SETUP_TIMEOUT_MS, TERMINAL_RUN_STATES, authenticate, catalogModel, createScenarioChat, deleteChat, discard, ensureFamilyConnection,
  ensureModel, ensureSearchSource, errorCode, json, poll, request, requireIdleStand, runControls, safeCode, standDatabase, type Api
} from "./browser-scenarios-stand";
import { modelInConnection, readConnections, type JourneyConnection } from "./context-compaction-journey-support";
import {
  DEFAULT_ENGINE_ORDER_LABELS, OPENROUTER_ALLOWED_SEARCH_MODELS, SEARCH_PROMPTS, codexLbApiRoot, decodeAdminSearch, decodeSearchEvidence,
  engineLabel, engineSourceFor, evidenceLine, expectedDefaultEngine, modelIdSetting, oracleClientEngine, oracleInAnswer, oracleResearch,
  oracleSubagent, selectedEngineSteps, selectedSearchScenarios, type AdminSearchCatalog, type AdminSearchPolicy, type EngineStep,
  type SearchRunEvidence, type SearchScenarioId
} from "./search-scenarios-support";

const GPT_DISPLAY_NAME = "Search scenarios GPT model";
/** A–D wait this long for their run; E (Deep research) its own bound. */
const TURN_WAIT_MS = 20 * 60_000;
const RESEARCH_WAIT_MS = 120 * 60_000;

let stage = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const fail = (code: string): never => { throw new BrowserScenarioError(code); };
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;
const harnessCode = (error: unknown) => error instanceof BrowserScenarioError ? error.message : "search_scenarios_step_failed";

/** A support function's refusal as its own stable code (they throw plain errors), never its text. */
function stable<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof BrowserScenarioError) throw error;
    return fail(error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message) ? error.message : "option_invalid");
  }
}

type DeepSeekSetup = Readonly<{ model: CatalogModel; providerModelId: string; upstreamModelId: string }>;
type Context = Readonly<{
  api: Api;
  db: PostgresClient;
  /** The DeepSeek answer model, or why the stand has none. */
  deepseek: DeepSeekSetup | Readonly<{ code: string }>;
  engines: readonly EngineStep[];
  gpt: CatalogModel;
  keepChats: boolean;
}>;
type Scenario = { chats: string[]; line: Record<string, unknown>; streams: { abort: AbortController; drained: Promise<void> }[] };

// Admin › Search -------------------------------------------------------------------------

async function readSearch(api: Api): Promise<AdminSearchCatalog> {
  return decodeAdminSearch(await json(api, "/api/admin/search")) ?? fail("search_catalog_invalid");
}

type PolicyPatch = Partial<Pick<AdminSearchPolicy, "backupOptionId" | "engineOptionId" | "inAnswerSearch">>;

/** The Control Center's save of the installation's Search, version-checked; the server's answer must hold exactly the patch. */
async function setPolicy(api: Api, patch: PolicyPatch): Promise<AdminSearchCatalog> {
  const current = await readSearch(api);
  const updated = decodeAdminSearch(await json(api, "/api/admin/search", { body: { ...patch, expectedVersion: current.policy.version }, method: "PATCH" })) ??
    fail("search_catalog_invalid");
  for (const [key, value] of Object.entries(patch) as [keyof PolicyPatch, unknown][]) {
    if (updated.policy[key] !== value) fail("search_policy_not_applied");
  }
  return updated;
}

/** Puts the engine, backup and in-answer switch back as they were; true when the server's answer holds them. */
async function restorePolicy(api: Api, original: AdminSearchPolicy, fields: readonly (keyof PolicyPatch)[]): Promise<boolean> {
  try {
    const current = await readSearch(api);
    const patch = Object.fromEntries(fields.filter((field) => current.policy[field] !== original[field]).map((field) => [field, original[field]])) as PolicyPatch;
    if (Object.keys(patch).length > 0) await setPolicy(api, patch);
    return true;
  } catch {
    return false;
  }
}

const labelOf = (catalog: AdminSearchCatalog, optionId: string | null): string | null => {
  const integration = optionId === null ? undefined : catalog.integrations.find((entry) => entry.optionId === optionId);
  return integration ? engineLabel(integration) : null;
};

// Setup ----------------------------------------------------------------------------------

async function connections(api: Api): Promise<JourneyConnection[]> {
  return readConnections(await json(api, "/api/admin/providers")) ?? fail("providers_response_invalid");
}

/**
 * The DeepSeek answer model: the stand's DeepSeek connection, or Quick Setup with DEEPSEEK_API_KEY (DeepSeek's own two
 * models and its Search API, whose source it turns on). Without either: a code, and C and D report `not_configured`.
 */
async function deepSeekSetup(api: Api, key: string | null, upstreamModelId: string): Promise<DeepSeekSetup | Readonly<{ code: string }>> {
  const existing = (await connections(api)).some((connection) => connection.family === "deepseek" && connection.active);
  if (!existing && key === null) return { code: "deepseek_key_missing" };
  try {
    const connectionId = await ensureFamilyConnection(api, "deepseek", key ?? "");
    const connection = (await connections(api)).find((entry) => entry.id === connectionId) ?? fail("deepseek_connection_missing");
    const added = modelInConnection(connection, upstreamModelId);
    if (!added || !added.enabled || added.activeConfig === null) return { code: "deepseek_model_missing" };
    return { model: await catalogModel(api, { connectionId, providerModelId: added.id }), providerModelId: added.id, upstreamModelId };
  } catch (error) {
    return { code: harnessCode(error).replace(/^browser_scenarios_/u, "deepseek_") };
  }
}

const sweepApproved = (name: string) => process.env[name] === "approved";

/**
 * The ready source an engine step sets as the engine, set up where the rules allow: the DeepSeek Search API on the DeepSeek
 * connection, OpenRouter and Gemini only reused unless their sweep is approved. A reason code when there is none.
 */
async function prepareEngineSource(ctx: Context, step: EngineStep): Promise<Readonly<{ optionId: string }> | Readonly<{ reason: string }>> {
  const found = async () => engineSourceFor(step, (await readSearch(ctx.api)).integrations);
  let source = await found();
  if (source.status !== "ready" && step.label === "deepseek") {
    if ("code" in ctx.deepseek) return { reason: ctx.deepseek.code };
    try {
      await ensureSearchSource(ctx.api, { kind: "deepseek_search_api", provider: "deepseek", secret: process.env.DEEPSEEK_API_KEY?.trim() ?? "" });
    } catch (error) {
      return { reason: harnessCode(error).replace(/^browser_scenarios_/u, "deepseek_") };
    }
    source = await found();
  }
  if (source.status !== "ready" && (step.label === "openrouter_perplexity" || step.label === "gemini")) {
    const family = step.label === "gemini" ? "gemini" : "openrouter";
    const approval = family === "gemini" ? "AIQSA_SEARCH_GEMINI_SETUP" : "AIQSA_SEARCH_OPENROUTER_SETUP";
    const key = (family === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENROUTER_API_KEY)?.trim();
    if (!sweepApproved(approval)) return { reason: `${family}_setup_not_approved` };
    if (!key) return { reason: `${family}_key_missing` };
    try {
      await ensureFamilyConnection(ctx.api, family, key);
      source = await poll(SETUP_TIMEOUT_MS / 3, async () => { const next = await found(); return next.status === "ready" ? next : null; },
        `${family}_source_missing`, 5_000);
    } catch (error) {
      return { reason: harnessCode(error).replace(/^browser_scenarios_/u, "") };
    }
  }
  if (source.status !== "ready") return { reason: `${step.label}_${source.reason}` };
  const { integration } = source;
  if (step.label === "openrouter_perplexity") {
    // OpenRouter only for its search technical model: a source on any other OpenRouter model is never called.
    const model = (await connections(ctx.api)).flatMap((connection) => connection.models).find((entry) => entry.id === integration.providerModelId);
    const upstream = (model?.activeConfig ?? model?.draftConfig)?.upstreamModelId;
    if (!upstream || !OPENROUTER_ALLOWED_SEARCH_MODELS.includes(upstream)) return { reason: "openrouter_technical_model_other" };
  }
  return { optionId: integration.optionId };
}

// Chats and runs -------------------------------------------------------------------------

/** One send as the composer makes it, Search on; resolves the admitted main-agent run's id. */
async function sendOnce(ctx: Context, scenario: Scenario, model: CatalogModel, text: string,
  extra: Readonly<Record<string, unknown>> = {}): Promise<Readonly<{ chatId: string; runId: string }> | Readonly<{ code: string }>> {
  const chat = await createScenarioChat(ctx.api, `Search scenario ${String(scenario.line.scenario)}`);
  scenario.chats.push(chat.id);
  const controls: Record<string, unknown> = { ...runControls(model) };
  // Users only switch Search on or off; the server binds the installation's engine.
  delete controls.searchPlan;
  delete controls.searchStrategy;
  const abort = new AbortController();
  const response = await request(ctx.api, `/api/chats/${encodeURIComponent(chat.id)}/messages`, { body: {
    content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId, ...controls, searchEnabled: true, ...extra
  }, method: "POST", signal: abort.signal });
  if (!response.ok) return { code: await errorCode(response) };
  scenario.streams.push({ abort, drained: discard(response) });
  const runId = await poll(120_000, async () => (await ctx.db.query<{ id: string }>(`SELECT "id" FROM "ModelRun"
    WHERE "chatId" = $1 AND "subagentTurnId" IS NULL ORDER BY "createdAt" LIMIT 1`, [chat.id])).rows[0]?.id ?? null, "run_not_admitted");
  return { chatId: chat.id, runId };
}

/** Waits for the run's terminal state; past the wait it is cancelled and reported as `harness_timeout`. */
async function waitRun(ctx: Context, runId: string, timeoutMs: number): Promise<void> {
  try {
    await poll(timeoutMs, async () => {
      const { rows } = await ctx.db.query<{ status: string }>(`SELECT "status"::text AS "status" FROM "ModelRun" WHERE "id" = $1`, [runId]);
      return rows[0] && TERMINAL_RUN_STATES.has(rows[0].status) ? true : null;
    }, "harness_timeout", 3_000);
  } catch (error) {
    if (!(error instanceof BrowserScenarioError)) throw error;
    await request(ctx.api, `/api/model-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, method: "POST" }).catch(() => undefined);
    fail("harness_timeout");
  }
}

/**
 * The chat's evidence, matched inside SQL: the main run's frozen Search plan (options by use and protocol), every
 * `web_search` call of the chat's runs with its engine calls (`rawPreview.searchExecutions`: option, status, source
 * count, failure code), hosted search items with sources in the main transcript, whether the answer's text holds a link,
 * research starts and the sub-agent threads and turns (those on `$3`, the model D asks for). Option ids stay in memory.
 */
async function evidence(db: PostgresClient, chatId: string, runId: string, subagentModelId: string | null): Promise<SearchRunEvidence> {
  const { rows } = await db.query(`WITH main AS (
      SELECT r."id", r."status"::text AS "status", r."errorPayload"->>'code' AS "errorCode", r."normalizedRequest"->'searchPlan' AS "plan",
        r."assistantMessageId", r."createdAt", r."answerCompletedAt"
      FROM "ModelRun" r WHERE r."id" = $2 AND r."chatId" = $1
    ), calls AS (
      SELECT c."subagentThreadId" IS NOT NULL AS "subagent", c."toolName", c."result"
      FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1
    )
    SELECT m."status", m."errorCode", m."plan"->>'mode' AS "planMode", m."plan"->>'unavailable' AS "planUnavailable",
      coalesce((SELECT jsonb_agg(jsonb_build_object('optionId', o->>'optionId', 'use', o->>'use', 'protocol', o->>'protocol',
          'adapterKind', o->>'adapterKind', 'openRouterEngine', o->'config'->'openRouterWebSearch'->>'engine'))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."plan"->'options') = 'array' THEN m."plan"->'options' ELSE '[]'::jsonb END) o),
        '[]'::jsonb) AS "options",
      (SELECT count(*)::int FROM calls WHERE NOT calls."subagent" AND calls."toolName" = 'web_search') AS "mainCalls",
      (SELECT count(*)::int FROM calls WHERE calls."subagent" AND calls."toolName" = 'web_search') AS "subagentCalls",
      (SELECT count(*)::int FROM calls WHERE calls."toolName" = 'start_research') AS "researchStarts",
      coalesce((SELECT jsonb_agg(jsonb_build_object('subagent', calls."subagent", 'optionId', e->>'optionId', 'status', e->>'status',
          'sources', CASE WHEN jsonb_typeof(e->'sources') = 'array' THEN jsonb_array_length(e->'sources') ELSE 0 END,
          'failureCode', e->'failure'->>'code'))
        FROM calls, jsonb_array_elements(CASE WHEN jsonb_typeof(calls."result"->'rawPreview'->'searchExecutions') = 'array'
          THEN calls."result"->'rawPreview'->'searchExecutions' ELSE '[]'::jsonb END) e
        WHERE calls."toolName" = 'web_search'), '[]'::jsonb) AS "executions",
      (SELECT count(*)::int FROM "RunTranscriptItem" t WHERE t."modelRunId" = m."id" AND t."subagentThreadId" IS NULL
        AND jsonb_typeof(t."body"->'hostedSearch'->'sources') = 'array' AND jsonb_array_length(t."body"->'hostedSearch'->'sources') > 0) AS "hostedSourceItems",
      EXISTS (SELECT 1 FROM "Message" msg, jsonb_array_elements(CASE WHEN jsonb_typeof(msg."content"->'blocks') = 'array'
          THEN msg."content"->'blocks' ELSE '[]'::jsonb END) b
        WHERE msg."chatId" = $1 AND msg."id" = m."assistantMessageId" AND b->>'type' = 'text' AND b->>'text' ~ 'https?://') AS "answerLink",
      CASE WHEN m."answerCompletedAt" IS NULL THEN NULL
        ELSE round(extract(epoch FROM (m."answerCompletedAt" - m."createdAt"))::numeric, 1)::float8 END AS "runSeconds",
      (SELECT count(*)::int FROM "SubagentThread" th WHERE th."chatId" = $1) AS "subagentThreads",
      (SELECT count(*)::int FROM "SubagentTurn" st WHERE st."chatId" = $1) AS "subagentTurns",
      (SELECT count(*)::int FROM "SubagentTurn" st WHERE st."chatId" = $1 AND $3::text IS NOT NULL AND st."providerModelId" = $3::text) AS "subagentTurnsOnModel"
    FROM main m`, [chatId, runId, subagentModelId]);
  return decodeSearchEvidence(rows[0]) ?? fail("evidence_invalid");
}

/** Sends, waits and reads the chat's evidence; a refused send is `send_<code>`. */
async function runChat(ctx: Context, scenario: Scenario, input: Readonly<{ extra?: Readonly<Record<string, unknown>>; model: CatalogModel;
  subagentModelId?: string | null; text: string; waitMs?: number }>): Promise<SearchRunEvidence> {
  const sent = await sendOnce(ctx, scenario, input.model, input.text, input.extra);
  if ("code" in sent) return fail(`send_${safeCode(sent.code) ?? "refused"}`);
  try {
    await waitRun(ctx, sent.runId, input.waitMs ?? TURN_WAIT_MS);
  } finally {
    stopStreams(scenario);
  }
  return evidence(ctx.db, sent.chatId, sent.runId, input.subagentModelId ?? null);
}

function stopStreams(scenario: Scenario): void {
  for (const stream of scenario.streams) stream.abort.abort();
}

// Scenarios ------------------------------------------------------------------------------

/** The in-answer switch as the scenario needs it; the original is restored at the end. */
async function inAnswer(ctx: Context, on: boolean): Promise<AdminSearchCatalog> {
  const current = await readSearch(ctx.api);
  return current.policy.inAnswerSearch === on ? current : setPolicy(ctx.api, { inAnswerSearch: on });
}

async function scenarioA(ctx: Context, scenario: Scenario): Promise<boolean> {
  await inAnswer(ctx, true);
  const found = await runChat(ctx, scenario, { model: ctx.gpt, text: SEARCH_PROMPTS.direct() });
  const failed = oracleInAnswer(found);
  Object.assign(scenario.line, evidenceLine(found), { checksFailed: failed });
  return failed.length === 0;
}

async function scenarioB(ctx: Context, scenario: Scenario): Promise<boolean> {
  const catalog = await inAnswer(ctx, false);
  const resolved = catalog.policy.resolved.engineOptionId;
  scenario.line.resolvedEngine = labelOf(catalog, resolved);
  if (resolved === null) {
    Object.assign(scenario.line, { checksFailed: ["engine_not_configured"], resolvedReason: safeCode(catalog.policy.resolved.reason) });
    return false;
  }
  const found = await runChat(ctx, scenario, { model: ctx.gpt, text: SEARCH_PROMPTS.direct() });
  const failed = oracleClientEngine(found, { engineOptionId: resolved, label: null });
  Object.assign(scenario.line, evidenceLine(found), { checksFailed: failed, exactlyOneSearch: found.mainCalls === 1 });
  return failed.length === 0;
}

async function engineStep(ctx: Context, scenario: Scenario, step: EngineStep, deepseek: DeepSeekSetup): Promise<Record<string, unknown>> {
  const started = Date.now();
  const line: Record<string, unknown> = { engine: step.label };
  try {
    let expected: { engineOptionId: string; label: string | null };
    const failed: string[] = [];
    if (step.label === "automatic") {
      const catalog = await setPolicy(ctx.api, { backupOptionId: null, engineOptionId: null });
      const resolved = catalog.policy.resolved.engineOptionId;
      const expectedDefault = expectedDefaultEngine(catalog.integrations);
      Object.assign(line, { automatic: catalog.policy.resolved.automatic, expectedDefault, resolvedEngine: labelOf(catalog, resolved) });
      if (resolved === null) return { ...line, reason: safeCode(catalog.policy.resolved.reason) ?? "search_engine_not_configured", status: "not_configured" };
      if (!catalog.policy.resolved.automatic) failed.push("not_automatic");
      if (labelOf(catalog, resolved) !== expectedDefault) failed.push("default_engine_unexpected");
      expected = { engineOptionId: resolved, label: null };
    } else {
      const source = await prepareEngineSource(ctx, step);
      if ("reason" in source) return { ...line, reason: safeCode(source.reason) ?? "source_unavailable", status: "not_configured" };
      const catalog = await setPolicy(ctx.api, { backupOptionId: null, engineOptionId: source.optionId });
      if (catalog.policy.resolved.engineOptionId !== source.optionId) failed.push("engine_not_applied");
      line.resolvedReason = safeCode(catalog.policy.resolved.reason);
      expected = { engineOptionId: source.optionId, label: step.label };
    }
    const found = await runChat(ctx, scenario, { model: deepseek.model, text: SEARCH_PROMPTS.direct() });
    failed.push(...oracleClientEngine(found, expected));
    Object.assign(line, evidenceLine(found), { checksFailed: failed, exactlyOneSearch: found.mainCalls === 1, status: failed.length === 0 ? "ok" : "failed" });
  } catch (error) {
    Object.assign(line, { harnessError: harnessCode(error), status: "failed" });
  }
  line.wallSeconds = seconds(started);
  return line;
}

async function scenarioC(ctx: Context, scenario: Scenario, original: AdminSearchPolicy): Promise<boolean> {
  if ("code" in ctx.deepseek) {
    Object.assign(scenario.line, { reason: safeCode(ctx.deepseek.code), status: "not_configured" });
    return true;
  }
  const steps: Record<string, unknown>[] = [];
  try {
    for (const step of ctx.engines) steps.push(await engineStep(ctx, scenario, step, ctx.deepseek));
  } finally {
    scenario.line.engines = steps;
    scenario.line.policyRestored = await restorePolicy(ctx.api, original, ["engineOptionId", "backupOptionId"]);
  }
  return steps.every((step) => step.status === "ok" || step.status === "not_configured") && scenario.line.policyRestored === true;
}

async function scenarioD(ctx: Context, scenario: Scenario): Promise<boolean> {
  if ("code" in ctx.deepseek) {
    Object.assign(scenario.line, { reason: safeCode(ctx.deepseek.code), status: "not_configured" });
    return true;
  }
  await inAnswer(ctx, true);
  const found = await runChat(ctx, scenario, { model: ctx.gpt, subagentModelId: ctx.deepseek.providerModelId,
    text: SEARCH_PROMPTS.subagent(ctx.deepseek.upstreamModelId) });
  const failed = oracleSubagent(found);
  Object.assign(scenario.line, evidenceLine(found), { checksFailed: failed, subagentTurns: found.subagentTurns,
    subagentTurnsOnModel: found.subagentTurnsOnModel });
  return failed.length === 0;
}

async function scenarioE(ctx: Context, scenario: Scenario): Promise<boolean> {
  await inAnswer(ctx, true);
  const found = await runChat(ctx, scenario, { extra: { [DEEP_RESEARCH_SEND_FIELD]: true }, model: ctx.gpt, text: SEARCH_PROMPTS.research(),
    waitMs: RESEARCH_WAIT_MS });
  const failed = oracleResearch(found);
  Object.assign(scenario.line, evidenceLine(found), { checksFailed: failed, researchStarts: found.researchStarts, researcherThreads: found.subagentThreads });
  return failed.length === 0;
}

async function runScenario(ctx: Context, id: SearchScenarioId, original: AdminSearchPolicy): Promise<Readonly<{ cleaned: boolean; success: boolean }>> {
  const scenario: Scenario = { chats: [], line: { scenario: id }, streams: [] };
  const started = Date.now();
  let success = false;
  stage = `scenario_${id}`;
  try {
    switch (id) {
      case "A": success = await scenarioA(ctx, scenario); break;
      case "B": success = await scenarioB(ctx, scenario); break;
      case "C": success = await scenarioC(ctx, scenario, original); break;
      case "D": success = await scenarioD(ctx, scenario); break;
      case "E": success = await scenarioE(ctx, scenario); break;
    }
  } catch (error) {
    Object.assign(scenario.line, { harnessError: harnessCode(error), harnessStage: stage });
    success = false;
  }
  stopStreams(scenario);
  await Promise.all(scenario.streams.map((stream) => stream.drained));
  let cleaned = true;
  if (!ctx.keepChats) {
    for (const chatId of scenario.chats) cleaned = await deleteChat(ctx.api, ctx.db, chatId) && cleaned;
  }
  Object.assign(scenario.line, { chats: scenario.chats.length, chatsDeleted: !ctx.keepChats && cleaned, success, wallSeconds: seconds(started) });
  emit(scenario.line);
  return { cleaned, success };
}

// Main -----------------------------------------------------------------------------------

async function main() {
  const composeFile = process.env.AIQSA_SEARCH_COMPOSE_FILE ?? fail("compose_required");
  const target = requireBrowserScenarioStand(process.env.AIQSA_SEARCH_E2E, JSON.parse(readFileSync(composeFile, "utf8")) as BrowserScenarioStand);
  const scenarios = stable(() => selectedSearchScenarios(process.env.AIQSA_SEARCH_SELECT));
  if (!scenarios.includes("C") && process.env.AIQSA_SEARCH_C_ENGINES?.trim()) fail("c_engines_require_c");
  const engines = stable(() => selectedEngineSteps(process.env.AIQSA_SEARCH_C_ENGINES));
  const apiRoot = stable(() => codexLbApiRoot(process.env.CODEX_LB_ROOT));
  const gptModel = stable(() => modelIdSetting(process.env.AIQSA_SEARCH_GPT_MODEL, "gpt-6.2-sol", "gpt_model_invalid"));
  const deepseekModel = stable(() => modelIdSetting(process.env.AIQSA_SEARCH_DEEPSEEK_MODEL, "deepseek-flash", "deepseek_model_invalid"));
  const label = process.env.AIQSA_SEARCH_LABEL?.trim() || "unlabelled";
  if (!/^[A-Za-z0-9._/-]{1,80}$/u.test(label)) fail("label_invalid");
  const secret = process.env.CODEX_LB_API_KEY?.trim() || fail("codex_lb_key_required");
  const db = standDatabase(target.databaseUrl);
  await db.connect();
  const started = Date.now();
  let exitCode = 0;
  try {
    stage = "preflight";
    await requireIdleStand(db);
    const api = await authenticate(target);
    stage = "setup";
    const gpt = await ensureModel(api, { apiRoot, model: gptModel }, secret, GPT_DISPLAY_NAME, { nativeSearch: true, vision: false });
    // Its setup created the connection's web_search source (hosted and client routes); it must be on.
    await ensureSearchSource(api, { connectionId: gpt.connectionId, kind: "web_search" });
    const gptCatalog = await catalogModel(api, gpt);
    const deepseek = scenarios.some((id) => id === "C" || id === "D")
      ? await deepSeekSetup(api, process.env.DEEPSEEK_API_KEY?.trim() || null, deepseekModel) : { code: "not_needed" };
    const original = await readSearch(api);
    emit({ stage: "ready", label, project: target.project, gptModel, gptReused: gpt.reused, deepseek: "code" in deepseek ? safeCode(deepseek.code) : "ready",
      scenarios, engines: scenarios.includes("C") ? engines.map((step) => step.label) : [], defaultOrder: DEFAULT_ENGINE_ORDER_LABELS,
      policy: { engineChosen: original.policy.engineOptionId !== null, backupChosen: original.policy.backupOptionId !== null,
        inAnswerSearch: original.policy.inAnswerSearch, resolvedEngine: labelOf(original, original.policy.resolved.engineOptionId) },
      openrouterSetupApproved: sweepApproved("AIQSA_SEARCH_OPENROUTER_SETUP"), geminiSetupApproved: sweepApproved("AIQSA_SEARCH_GEMINI_SETUP") });
    const ctx: Context = { api, db, deepseek, engines, gpt: gptCatalog, keepChats: process.env.AIQSA_SEARCH_KEEP_CHATS === "1" };
    const results: { cleaned: boolean; id: SearchScenarioId; success: boolean }[] = [];
    let policyRestored = false;
    try {
      for (const id of scenarios) {
        const result = await runScenario(ctx, id, original.policy);
        results.push({ id, ...result });
        if (!result.cleaned) fail("cleanup_failed");
      }
    } finally {
      stage = "restore";
      policyRestored = await restorePolicy(api, original.policy, ["engineOptionId", "backupOptionId", "inAnswerSearch"]);
      if (!policyRestored) exitCode = 1;
    }
    emit({ status: "finished", label, scenarios: results.length, successes: results.filter((entry) => entry.success).length,
      failed: results.filter((entry) => !entry.success).map((entry) => entry.id), policyRestored, elapsedSeconds: seconds(started) });
  } finally {
    await db.end().catch(() => undefined);
  }
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  emit({ status: "failed", stage, code: error instanceof BrowserScenarioError ? error.message : "search_scenarios_check_failed" });
  process.exitCode = 1;
});
