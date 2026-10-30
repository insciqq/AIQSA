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
 * Setup through the ordinary Admin and user APIs (as a real operator would;
 * shared with `scripts/smoke-subagents-paid.ts` in `scripts/browser-scenarios-stand.ts`):
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
 * Per run the line also carries the input tokens of every model request in
 * call order (`inputSeries`: numbers only, ordered by the engine's usage row
 * ids, `requestSeries`), their min, median, max and least-squares slope per
 * request, the compactions in the run's transcript, and cost estimates from
 * the token totals at fixed list prices (`costEstimates`); the summary
 * repeats them per run beside the scenario's totals.
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
 * - AIQSA_BROWSER_SCENARIOS_SELECT (default S1,S2,S3,S4,S5; the long S6 runs only when named),
 *   AIQSA_BROWSER_SCENARIOS_RUNS (1..5, default 2)
 * - AIQSA_BROWSER_SCENARIOS_EXPECT_BOUNDS (`any`, default, only records the admitted bounds; `unlimited`
 *   demands no tool call or round limit and a 3600 s turn: a run admitted otherwise is cancelled at once,
 *   cleaned up, and the measurement stops with `bounds_unexpected`)
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
import type { Client as PostgresClient } from "pg";
import type { CatalogModel } from "../lib/contracts/catalog";
import {
  BROWSER_SCENARIOS, BrowserScenarioError, checkBrowserResult, cleanUpRun, requireBrowserScenarioStand, runBounds, scenarioSummary,
  selectedScenarios, boundsExpectation, chatRoute, costEstimates, requestSeries, seriesStats, toolCallStats, unexpectedBounds,
  usageEvidence, type BoundsExpectation, type BrowserBlockedCode, type BrowserScenario, type BrowserScenarioId,
  type BrowserScenarioStand, type RunBounds, type RunRecord, type SeriesStats, type StandTarget, type ToolCallRow, type UsageRow,
  type UsageSeriesRow
} from "./browser-scenarios-support";
import {
  TERMINAL_RUN_STATES as TERMINAL, authenticate, awaitExport, createScenarioChat, deleteChat, discard, errorCode, handoffCalls,
  latestRun, poll, readResultFile, removeBrowserSessions, request, requireIdleStand, runControls, safeCode, setUpStand, standDatabase,
  syncSaucedemoSecret, typedValueLeaks, type Api, type RunRow
} from "./browser-scenarios-stand";
import { codexLbRoute } from "./workspace-user-paid-support";

let stage = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const fail = (code: string): never => { throw new BrowserScenarioError(code); };

type RunContext = Readonly<{
  api: Api;
  db: PostgresClient;
  expectBounds: BoundsExpectation;
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
  let compactions: number | null = null;
  let requestStats: SeriesStats | undefined;
  let boundsRejected = false;
  // Typed only into the live view (S5); the run's leak check looks for it. Never printed.
  const marker = `zq${randomUUID().replaceAll("-", "")}`;
  const measuredRecord = (): RunRecord => ({ blocked, compactions, costUsd, inputTokens, outputTokens, rounds,
    ...(requestStats ? { requestStats } : {}), run, scenario: scenario.id, success, toolCalls, wallSeconds });
  const measured = await (async (): Promise<RunRecord> => { try {
    // A session saved late by the previous run's settlement must not sign this run in.
    stage = "pre_run_cleanup";
    line.sessionsRemovedBefore = await removeBrowserSessions(api);
    await syncSaucedemoSecret(api, scenario.secret === "saucedemo");
    stage = "chat";
    const chat = await createScenarioChat(api, `Browser scenario ${scenario.id} run ${run}`);
    chatId = chat.id;
    stage = "send";
    const stream = new AbortController();
    const started = Date.now();
    const response = await request(api, `/api/chats/${encodeURIComponent(chat.id)}/messages`, { body: {
      content: { blocks: [{ text: scenario.prompt, type: "text" }] },
      expectedActiveLeafId: chat.activeLeafMessageId,
      ...runControls(context.model)
    }, method: "POST", signal: stream.signal });
    if (!response.ok) {
      Object.assign(line, { terminal: "admission_failed", failureCode: await errorCode(response) });
      return measuredRecord();
    }
    const drained = discard(response);
    stage = "wait";
    const admitted = await poll(120_000, () => latestRun(db, chat.id), "run_not_admitted");
    const bounds: RunBounds = runBounds({ toolBudgets: admitted.toolBudgets, workspace: { turnTimeoutSeconds: admitted.turnTimeoutSeconds } });
    line.bounds = bounds;
    const unexpected = unexpectedBounds(bounds, context.expectBounds);
    if (unexpected.length > 0) {
      // Not the bounds the measurement asked for: stop before it spends more.
      await request(api, `/api/model-runs/${encodeURIComponent(admitted.id)}/cancel`, { body: {}, method: "POST" });
      stream.abort();
      await drained;
      boundsRejected = true;
      Object.assign(line, { boundsUnexpected: unexpected, terminal: "bounds_unexpected" });
      return measuredRecord();
    }
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
    const binding = await awaitExport(db, admitted.id);
    Object.assign(line, { exportState: binding.exportState, internetEnabled: binding.internetEnabled });
    const { rows: calls } = await db.query<ToolCallRow>(`SELECT "toolName", "state"::text AS "state", "roundIndex"
      FROM "ModelRunToolCall" WHERE "modelRunId" = $1`, [admitted.id]);
    const stats = toolCallStats(calls);
    rounds = stats.rounds;
    toolCalls = stats.toolCalls;
    Object.assign(line, stats);
    // Usage is recorded after the answer: wait briefly for the answer's own receipt.
    const usageRows = await poll(120_000, async () => {
      const { rows } = await db.query<UsageRow & UsageSeriesRow>(`SELECT "id", "purpose"::text AS "purpose", "costReported",
          "estimatedCostMicros", "inputTokens", "cachedInputTokens", "outputTokens" FROM "UsageEvent" WHERE "modelRunId" = $1`,
      [admitted.id]);
      return rows.some((row) => row.purpose === "chat_answer") ? rows : null;
    }, "usage_timeout", 3_000).catch(() => null);
    const usage = usageEvidence(usageRows ?? []);
    ({ costUsd, inputTokens, outputTokens } = usage);
    const series = requestSeries(admitted.id, usageRows ?? []);
    requestStats = seriesStats(series.inputSeries);
    const { rows: compactionRows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count"
      FROM "RunTranscriptItem" WHERE "modelRunId" = $1 AND "kind" = 'compaction'`, [admitted.id]);
    compactions = compactionRows[0]?.count ?? null;
    Object.assign(line, usage, { usageSettled: usageRows !== null, cachedInputTokens: series.cachedInputTokens, compactions,
      costEstimates: costEstimates(inputTokens, outputTokens), inputSeries: series.inputSeries, otherUsageRows: series.otherRows,
      requestStats });
    stage = "result";
    const read = await readResultFile(api, db, [admitted.id]);
    line.outputFiles = read.outputFiles;
    let checks: string[];
    if (!read.ok) checks = [read.code];
    else {
      blocked = [...read.blocked];
      line.resultStatus = ["completed", "partial", "blocked"].includes(String(read.value.status)) ? read.value.status : "other";
      const verdict = checkBrowserResult(scenario, read.value);
      checks = [...verdict.failed];
      line.oracleCounts = verdict.counts;
    }
    if (scenario.runOracle) {
      stage = "run_evidence";
      const runVerdict = scenario.runOracle({
        handoffs: await handoffCalls(db, [admitted.id]),
        leaks: await typedValueLeaks(db, chat.id, [admitted.id], marker).catch(() => null)
      });
      checks = [...checks, ...runVerdict.failed];
      line.runOracleCounts = runVerdict.counts;
    }
    line.checksFailed = checks;
    line.blocked = blocked;
    success = terminal?.status === "complete" && checks.length === 0;
    return measuredRecord();
  } catch (error) {
    line.harnessError = error instanceof BrowserScenarioError ? error.message : "browser_scenarios_run_failed";
    line.harnessStage = stage;
    success = false;
    return measuredRecord();
  } })();
  line.success = measured.success;
  const { cleaned, ...cleanup } = await cleanUpRun({
    deleteChat: (id) => deleteChat(api, db, id),
    removeBrowserSessions: () => removeBrowserSessions(api)
  }, chatId, context.keepChats);
  Object.assign(line, cleanup);
  emit(line);
  if (!cleaned) fail("cleanup_failed");
  if (boundsRejected) fail("bounds_unexpected");
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
  const expectBounds = boundsExpectation(process.env.AIQSA_BROWSER_SCENARIOS_EXPECT_BOUNDS);
  const label = process.env.AIQSA_BROWSER_SCENARIOS_LABEL?.trim() || "unlabelled";
  if (!/^[A-Za-z0-9._/-]{1,80}$/u.test(label)) fail("label_invalid");
  const route = codexLbRoute(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"));
  const secret = process.env.CODEX_LB_API_KEY ?? fail("codex_lb_key_required");
  const chat = chatRoute(process.env);
  const db = standDatabase(target.databaseUrl);
  await db.connect();
  const started = Date.now();
  const records: RunRecord[] = [];
  try {
    stage = "preflight";
    await requireIdleStand(db);
    const api = await authenticate(target);
    stage = "setup";
    const { chatProvider, model } = await setUpStand(api, {
      chat, ...(process.env.OPENROUTER_API_KEY ? { openRouterKey: process.env.OPENROUTER_API_KEY } : {}), route, secret
    });
    if (chat.route === "openrouter" && model.capabilities.imageInput) fail("text_model_has_image_input");
    emit({ stage: "ready", label, project: target.project, provider: "codex-lb", model: route.model,
      chatRoute: chat.route, chatModel: chat.route === "openrouter" ? chat.model : route.model, chatImageInput: model.capabilities.imageInput,
      contextWindow: chatProvider.contextWindow, reused: chatProvider.reused, systemVision: true, workspaceInternet: true,
      configuredBounds: target.configuredBounds, expectBounds, scenarios, runs });
    const context: RunContext = { api, db, expectBounds, keepChats: process.env.AIQSA_BROWSER_SCENARIOS_KEEP_CHATS === "1",
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
