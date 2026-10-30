/**
 * Opt-in, paid sub-agent scenarios against a DISPOSABLE real-KVM AIQSA stand
 * (the acceptance task's scenarios 1–9). Never a default lane and never a
 * persistent installation. It drives the product as a user would, through its
 * own HTTP APIs: messages, edits and regenerations, the sub-agent thread
 * routes (list, summary, Stop, Stop all), scheduled tasks, and the live
 * Browser panel through Playwright (`scripts/browser-scenarios-handoff.ts`).
 * Evidence comes from read-only `pg` queries; arguments, results and
 * messages are matched inside SQL and only booleans and counts leave it.
 *
 * Scenarios (`scripts/subagent-scenarios-support.ts`), selected with
 * AIQSA_SUBAGENTS_SELECT (default A,B,E,F; the others only when named):
 * - A: no-setup sub-agents, "find and compare 10 options" (scenario 1).
 * - B: 5 background sub-agents, a second message while they run, the wake-up (2).
 * - C1, C2: S6 with one sub-agent per category, on the default sub-agent and
 *   with a one-off `model` override to AIQSA_SUBAGENTS_SECOND_MODEL (3).
 * - D5, D1: "the 5 best headphones on amazon.es" with 5 sub-agents browsing at
 *   once, and by one agent for the wall-time reference (3a).
 * - E: a correction sent to a running sub-agent, then `stop_subagent`, the
 *   thread Stop route and Stop all (4).
 * - F: a thread continued by name, then an edit of the first message whose
 *   branch must not see the abandoned branch's sub-agent (5).
 * - G: a restart of the app container during background work (6), through
 *   AIQSA_SUBAGENTS_RESTART_COMMAND.
 * - H: a background sub-agent's saucedemo sign-in through `browser_handoff`
 *   while another agent browses; Playwright signs in through the live card (8).
 * - I: a scheduled task's Run now with sub-agents in waiting mode (9). Telegram
 *   is not covered: its only update hook (`/api/test/telegram/updates`) exists
 *   in test mode, which the stand guard refuses, and a real bot needs a token
 *   and a linked Telegram account.
 * Scenario 7 (the MCP guard) is not part of this harness.
 *
 * Each run prints ONE content-free JSON line (codes, counts, booleans,
 * timings, token numbers), then one summary line per scenario and a final
 * line. The exit code is 0 whenever the measurement completes: a failed
 * oracle is data. Cleanup is not: when a chat, a scheduled task or a saved
 * browser session cannot be removed and proven gone, the harness stops before
 * the next run and exits 1. Chromium's resident memory is not recorded: the
 * stand exposes no reading of the guest's processes.
 *
 * Setup is the browser-scenario harness's (`scripts/browser-scenarios-stand.ts`):
 * the codex-lb route from ~/.codex/config.toml, System Vision on it, Workspace
 * with internet, Memory off, signed in as the bootstrap administrator, whose
 * custom sub-agent count is printed (A expects none: "no setup").
 *
 * Environment (process only; no .env loading):
 * - AIQSA_SUBAGENTS_E2E=DISPOSABLE (required acknowledgement)
 * - AIQSA_SUBAGENTS_COMPOSE_FILE: the stand's `docker compose config --format json`
 * - CODEX_LB_API_KEY
 * - AIQSA_SUBAGENTS_SELECT, AIQSA_SUBAGENTS_RUNS (1..3, default 1), AIQSA_SUBAGENTS_LABEL,
 *   AIQSA_SUBAGENTS_MARGIN_SECONDS (60..3600, default 600), AIQSA_SUBAGENTS_KEEP_CHATS=1
 * - AIQSA_SUBAGENTS_SECOND_MODEL (C2): an upstream model id on the same codex-lb route, not the parent's;
 *   the harness adds it as "Sub-agents second model" and requires it in the user's catalog
 * - AIQSA_SUBAGENTS_RESTART_COMMAND (G), AIQSA_SUBAGENTS_RESTART_TIMEOUT_SECONDS (30..900, default 300):
 *   one shell line run on the harness host with /bin/sh -c, output discarded and only its exit code kept,
 *   that restarts the stand's app container on the server through the SSH connection that forwards the
 *   stand's ports, for example `ssh <the stand host> 'docker compose -p aiqsa-sa-kvm restart app'`. Its
 *   environment is PATH, HOME, USER, LOGNAME and SSH_AUTH_SOCK only.
 * - AIQSA_BROWSER_SCENARIOS_BROWSER_CHANNEL, AIQSA_BROWSER_SCENARIOS_SHOTS_DIR: as for S5 (C, D, H drive the
 *   live panel; the harness host needs a Chromium for Playwright).
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client as PostgresClient } from "pg";
import type { CatalogModel } from "../lib/contracts/catalog";
import { decodeSubagentDefinitionListResponse } from "../lib/contracts/subagentDefinitions";
import {
  SUBAGENT_API_PATHS, decodeSubagentChatThreads, decodeSubagentStopAllResponse, decodeSubagentStopResponse,
  decodeSubagentSummaryResponse, decodeSubagentThreadView
} from "../lib/contracts/subagentViews";
import {
  BrowserScenarioError, handoffOutcome, requireBrowserScenarioStand, type BrowserScenarioStand, type InteractionEvidence,
  type OracleVerdict, type ScenarioInteraction, type StandTarget
} from "./browser-scenarios-support";
import {
  TERMINAL_RUN_STATES, authenticate, awaitExport, catalogModel, createScenarioChat, deleteChat, discard, ensureModel, errorCode,
  handoffCalls, isRecord, json, poll, readResultFile, removeBrowserSessions, request, requireIdleStand, runControls, safeCode,
  setUpStand, syncSaucedemoSecret, typedValueLeaks, type Api, type ResultRead
} from "./browser-scenarios-stand";
import {
  SIDE_QUESTION, SUBAGENT_NAMES, SUBAGENT_PROMPTS, appendProgression, bindingEvidence, browserEvidence, callbackEvidence,
  cleanUpScenario, notaryValue, oracleA, oracleB, oracleC, oracleD, oracleE, oracleFBranched, oracleFContinued, oracleH, oracleI,
  peakConcurrentTurns, progressionSaw, requestedModelEvidence, restartEvidence, roundsPerAgent, runSecrets, selectedSubagentScenarios,
  stateCounts, stopEvidence, subagentCallEvidence, subagentHarnessOptions, subagentScenarioSummary, turnOutcomes, usageByPurpose,
  type PurposeUsageRow, type RestartHook, type StateCounts, type SubagentHarnessOptions, type SubagentRunRecord,
  type SubagentScenarioId, type ToolRow, type TurnRow, type WakeUpRow
} from "./subagent-scenarios-support";
import { codexLbRoute } from "./workspace-user-paid-support";

const SECOND_MODEL_DISPLAY_NAME = "Sub-agents second model";
/** A main-agent run's wait: the shipped 3600 s turn plus the margin. */
const TURN_SECONDS = 3_600;

let stage = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const fail = (code: string): never => { throw new BrowserScenarioError(code); };
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;

type Session = { api: Api };
type Context = Readonly<{
  db: PostgresClient;
  keepChats: boolean;
  marginSeconds: number;
  model: CatalogModel;
  options: SubagentHarnessOptions;
  second: CatalogModel | null;
  session: Session;
  target: StandTarget;
}>;

/** What one scenario run created and started, for cleanup and for stopping its streams. */
type Run = {
  chats: string[];
  interactions: Promise<void>[];
  line: Record<string, unknown>;
  streams: { abort: AbortController; drained: Promise<void> }[];
  tasks: string[];
};

// Runs and chats ---------------------------------------------------------------------

type MainRun = { createdAt: Date; errorCode: string | null; id: string; status: string; systemTurn: boolean; userMessageId: string };

async function mainRuns(db: PostgresClient, chatId: string): Promise<MainRun[]> {
  const { rows } = await db.query<MainRun>(`SELECT r."id", r."status"::text AS "status", r."errorPayload"->>'code' AS "errorCode",
      r."createdAt", r."userMessageId", (m."systemTurnKind" IS NOT NULL) AS "systemTurn"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."userMessageId"
    WHERE r."chatId" = $1 AND r."subagentTurnId" IS NULL ORDER BY r."createdAt"`, [chatId]);
  return rows;
}

async function activeLeaf(ctx: Context, chatId: string): Promise<string | null> {
  const value = await json(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}`);
  const leaf = isRecord(value) && isRecord(value.chat) ? value.chat.activeLeafMessageId : undefined;
  if (leaf !== null && typeof leaf !== "string") fail("chat_detail_invalid");
  return leaf as string | null;
}

/** Owed callbacks: ended background turns no main-agent run received yet. */
async function owedCallbacks(db: PostgresClient, chatId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "SubagentTurn"
    WHERE "chatId" = $1 AND "mode" = 'background' AND "state"::text NOT IN ('running', 'waiting') AND "callbackRunId" IS NULL`, [chatId]);
  return rows[0]?.count ?? 0;
}

/** Waits until the main agent is idle with nothing owed to it (a wake-up turn would start), twice in a row. */
async function waitMainIdle(ctx: Context, chatId: string, timeoutMs = (TURN_SECONDS + ctx.marginSeconds) * 1_000): Promise<void> {
  let quiet = 0;
  await poll(timeoutMs, async () => {
    const active = (await mainRuns(ctx.db, chatId)).filter((run) => !TERMINAL_RUN_STATES.has(run.status)).length;
    quiet = active === 0 && await owedCallbacks(ctx.db, chatId) === 0 ? quiet + 1 : 0;
    return quiet >= 2 ? true : null;
  }, "main_not_idle", 3_000);
}

/** Sends one user message as the composer would, once the main agent is idle; resolves the admitted run's id. */
async function send(ctx: Context, run: Run, chatId: string, text: string): Promise<string> {
  await waitMainIdle(ctx, chatId);
  const leaf = await activeLeaf(ctx, chatId);
  const known = new Set((await mainRuns(ctx.db, chatId)).map((entry) => entry.id));
  const abort = new AbortController();
  const response = await request(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}/messages`, { body: {
    content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: leaf, ...runControls(ctx.model)
  }, method: "POST", signal: abort.signal });
  if (!response.ok) fail(`send_${await errorCode(response)}`);
  run.streams.push({ abort, drained: discard(response) });
  return poll(120_000, async () => (await mainRuns(ctx.db, chatId))
    .find((entry) => !known.has(entry.id) && !entry.systemTurn)?.id ?? null, "run_not_admitted");
}

type Terminal = Readonly<{ errorCode: string | null; status: string }>;

/** Waits for the run's terminal state; past the wait it is cancelled and reported as `harness_timeout`. */
async function waitRun(ctx: Context, runId: string, timeoutMs = (TURN_SECONDS + ctx.marginSeconds) * 1_000): Promise<Terminal> {
  try {
    return await poll(timeoutMs, async () => {
      const { rows } = await ctx.db.query<Terminal>(`SELECT "status"::text AS "status", "errorPayload"->>'code' AS "errorCode"
        FROM "ModelRun" WHERE "id" = $1`, [runId]);
      const row = rows[0];
      return row && TERMINAL_RUN_STATES.has(row.status) ? { errorCode: safeCode(row.errorCode), status: row.status } : null;
    }, "harness_timeout", 3_000);
  } catch (error) {
    if (!(error instanceof BrowserScenarioError)) throw error;
    await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, method: "POST" }).catch(() => undefined);
    return { errorCode: "harness_timeout", status: "harness_timeout" };
  }
}

function stopStreams(run: Run): Promise<unknown> {
  for (const stream of run.streams) stream.abort.abort();
  return Promise.all(run.streams.map((stream) => stream.drained));
}

// Evidence ---------------------------------------------------------------------------

async function turnRows(db: PostgresClient, chatId: string): Promise<TurnRow[]> {
  const { rows } = await db.query<TurnRow>(`SELECT t."id" AS "turnId", t."threadId", t."mode"::text AS "mode",
      t."state"::text AS "state", t."outcome"::text AS "outcome", t."reasonCode", t."provider", t."modelId", t."providerModelId", t."reasoningEffort",
      t."modelSource"::text AS "modelSource", t."effortSource"::text AS "effortSource", t."parentRunId",
      p."provider" AS "parentProvider", p."modelId" AS "parentModelId", p."normalizedRequest"->>'reasoningEffort' AS "parentEffort",
      t."startedAt", t."endedAt", t."callbackRunId", e."id" AS "executionRunId"
    FROM "SubagentTurn" t JOIN "ModelRun" p ON p."id" = t."parentRunId"
      LEFT JOIN "ModelRun" e ON e."subagentTurnId" = t."id"
    WHERE t."chatId" = $1 ORDER BY t."startedAt", t."id"`, [chatId]);
  return rows;
}

/** The chat's threads by the names the prompts fixed: kept in memory only, never printed. */
async function threadIdsByName(db: PostgresClient, chatId: string): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT "id", "name" FROM "SubagentThread"
    WHERE "chatId" = $1 ORDER BY "createdAt"`, [chatId]);
  const byName = new Map<string, string[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.id]);
  return byName;
}

/** The latest turn of the thread of that name (the newest thread of the name). */
async function latestTurnOf(db: PostgresClient, chatId: string, name: string): Promise<TurnRow | null> {
  const threadId = (await threadIdsByName(db, chatId)).get(name)?.at(-1);
  if (!threadId) return null;
  return (await turnRows(db, chatId)).filter((turn) => turn.threadId === threadId).at(-1) ?? null;
}

async function waitTurnEnded(ctx: Context, chatId: string, name: string, timeoutMs: number): Promise<TurnRow | null> {
  return poll(timeoutMs, async () => {
    const turn = await latestTurnOf(ctx.db, chatId, name);
    return turn && turn.state !== "running" && turn.state !== "waiting" ? turn : null;
  }, "turn_end_timeout", 3_000).catch(() => latestTurnOf(ctx.db, chatId, name));
}

async function toolRows(db: PostgresClient, chatId: string): Promise<ToolRow[]> {
  const { rows } = await db.query<ToolRow>(`SELECT c."modelRunId" AS "runId", c."subagentThreadId" AS "threadId",
      c."subagentTurnId" AS "turnId", c."toolName", c."state"::text AS "state", c."roundIndex", c."startedAt", c."completedAt",
      (c."toolName" NOT IN ('call_subagent', 'stop_subagent') AND (strpos(c."arguments"::text, 'aiqsa-browser') > 0
        OR strpos(c."arguments"::text, 'aiqsa import browser') > 0)) AS "browser",
      strpos(coalesce(c."result"::text, ''), 'browser_busy') > 0 AS "busy",
      strpos(coalesce(c."result"::text, ''), 'browser_memory_low') > 0 AS "memoryLow",
      (c."toolName" = 'call_subagent' AND strpos(coalesce(c."result"::text, ''), 'subagent_background_unavailable') > 0)
        AS "backgroundRefused"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1`, [chatId]);
  return rows;
}

async function wakeUpRows(db: PostgresClient, chatId: string): Promise<WakeUpRow[]> {
  const { rows } = await db.query<WakeUpRow>(`SELECT m."createdAt", r."id" AS "runId", r."status"::text AS "runStatus"
    FROM "Message" m LEFT JOIN "ModelRun" r ON r."userMessageId" = m."id" AND r."subagentTurnId" IS NULL
    WHERE m."chatId" = $1 AND m."systemTurnKind"::text = 'subagent_callback' ORDER BY m."createdAt"`, [chatId]);
  return rows;
}

/** The chat's usage rows once they stop changing: usage is written after each answer. */
async function settledUsage(db: PostgresClient, chatIds: readonly string[]): Promise<PurposeUsageRow[]> {
  const read = async () => (await db.query<PurposeUsageRow>(`SELECT "purpose"::text AS "purpose", "inputTokens", "cachedInputTokens",
      "outputTokens" FROM "UsageEvent" WHERE "modelRunId" IN (SELECT "id" FROM "ModelRun" WHERE "chatId" = ANY($1::text[]))`,
  [[...chatIds]])).rows;
  let last = await read();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(5_000);
    const next = await read();
    if (next.length === last.length && next.some((row) => row.purpose === "chat_answer")) return next;
    last = next;
  }
  return last;
}

/** Bot walls, CAPTCHAs and sign-in walls the run reported: handoff reasons, sub-agent blocked reasons and the file's list. */
async function wallCodes(db: PostgresClient, chatId: string, turns: readonly TurnRow[], result: ResultRead | null) {
  const runIds = (await db.query<{ id: string }>(`SELECT "id" FROM "ModelRun" WHERE "chatId" = $1`, [chatId])).rows.map((row) => row.id);
  const handoffReasons: Record<string, number> = {};
  for (const call of await handoffCalls(db, runIds)) {
    const reason = isRecord(call.arguments) ? safeCode(call.arguments.reason) ?? "other" : "other";
    handoffReasons[reason] = (handoffReasons[reason] ?? 0) + 1;
  }
  const walls = new Set(["bot_wall", "captcha", "code_required", "sign_in_required"]);
  const turnWalls: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.reasonCode && walls.has(turn.reasonCode)) turnWalls[turn.reasonCode] = (turnWalls[turn.reasonCode] ?? 0) + 1;
  }
  return { handoffReasons, resultBlocked: result?.ok ? [...result.blocked] : [], turnWalls };
}

/** The scenario's common evidence, assigned into its line. */
async function commonEvidence(ctx: Context, run: Run, chatId: string) {
  const now = Date.now();
  const turns = await turnRows(ctx.db, chatId);
  const tools = await toolRows(ctx.db, chatId);
  const wakeUps = await wakeUpRows(ctx.db, chatId);
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  Object.assign(run.line, {
    binding: bindingEvidence(turns),
    browser: browserEvidence(tools, now),
    callbacks: callbackEvidence(turns, wakeUps),
    calls: subagentCallEvidence(tools),
    peakConcurrentTurns: peakConcurrentTurns(turns, now),
    rounds: roundsPerAgent(tools),
    turnOutcomes: turnOutcomes(turns),
    usage
  });
  return { tools, turns, usage, wakeUps };
}

/** Waits for the exports of the chat's main-agent runs, then reads the newest result file among them. */
async function resultOf(ctx: Context, chatId: string, runIds?: readonly string[]): Promise<ResultRead> {
  const ids = runIds ?? (await mainRuns(ctx.db, chatId)).map((entry) => entry.id);
  for (const id of ids) await awaitExport(ctx.db, id);
  return readResultFile(ctx.session.api, ctx.db, [...ids].reverse());
}

/** The verdict of a result file into the line; the checks failed, or the read's failure code. */
type ResultFound = Extract<ResultRead, { ok: true }>;

function judge(run: Run, read: ResultRead, oracle: (value: ResultFound) => OracleVerdict): string[] {
  run.line.outputFiles = read.outputFiles;
  if (!read.ok) return [read.code];
  run.line.resultStatus = ["completed", "partial", "blocked"].includes(String(read.value.status)) ? read.value.status : "other";
  const verdict = oracle(read);
  run.line.oracleCounts = verdict.counts;
  return [...verdict.failed];
}

// Thread views polled as the chat list and the chat poll them -----------------------

type Watch = Readonly<{ stop(): Promise<Record<string, unknown> & { progression: StateCounts[] }> }>;

/** Polls the chat's thread list and the chat list's summary every 3 s; keeps state counts as they change. */
function watchThreads(ctx: Context, chatId: string): Watch {
  let stopped = false;
  let progression: StateCounts[] = [];
  let polls = 0;
  let failures = 0;
  let summaryMismatches = 0;
  let maxRunning = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const threads = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chatId)));
        const summary = decodeSubagentSummaryResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.summary([chatId])));
        if (!threads || !summary) failures += 1;
        else {
          polls += 1;
          progression = appendProgression(progression, stateCounts(threads.threads.map((thread) => thread.state)));
          maxRunning = Math.max(maxRunning, threads.running);
          const listed = summary.chats.find((entry) => entry.chatId === chatId)?.running ?? 0;
          if (listed !== threads.running) summaryMismatches += 1;
        }
      } catch {
        failures += 1;
      }
      await sleep(3_000);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { failures, maxRunning, polls, progression, summaryMismatches };
    }
  };
}

/** Starts a live-panel interaction for the chat; its evidence lands in the line when it ends. */
function interact(ctx: Context, run: Run, interaction: ScenarioInteraction, chatId: string, runId: string, marker: string): AbortController {
  const abort = new AbortController();
  run.interactions.push(interaction({ baseUrl: ctx.session.api.baseUrl.origin, chatId, cookie: ctx.session.api.cookie, marker, runId,
    signal: abort.signal }).then((evidence: InteractionEvidence) => { run.line.interaction = evidence; }, (error: unknown) => {
    run.line.interactionFailed = error instanceof BrowserScenarioError ? error.message : "interaction_failed";
  }));
  return abort;
}

async function handoffModule() {
  return import("./browser-scenarios-handoff");
}

// Scenarios ---------------------------------------------------------------------------

type Outcome = Readonly<{ success: boolean; usage: ReturnType<typeof usageByPurpose> | null }>;

async function scenarioA(ctx: Context, run: Run): Promise<Outcome> {
  const definitions = decodeSubagentDefinitionListResponse(await json(ctx.session.api, "/api/me/subagents"));
  run.line.customSubagents = definitions ? definitions.definitions.length : null;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario A");
  run.chats.push(chat.id);
  const runId = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.A());
  const terminal = await waitRun(ctx, runId);
  run.line.terminal = terminal.status;
  run.line.failureCode = terminal.errorCode;
  const { turns, usage } = await commonEvidence(ctx, run, chat.id);
  const checks = judge(run, await resultOf(ctx, chat.id, [runId]), (read) => oracleA(read.value));
  const binding = bindingEvidence(turns);
  if (binding.turns === 0) checks.push("no_subagents");
  else if (!binding.allOnParentBinding) checks.push("binding_not_parent");
  if (!usage.split) checks.push("usage_not_split");
  if (run.line.customSubagents !== 0) checks.push("custom_subagents_present");
  run.line.checksFailed = checks;
  return { success: terminal.status === "complete" && checks.length === 0, usage };
}

async function scenarioB(ctx: Context, run: Run): Promise<Outcome> {
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario B");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const started = Date.now();
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.B());
  const firstTerminal = await waitRun(ctx, first);
  run.line.firstTerminal = firstTerminal.status;
  run.line.firstAnswerSeconds = seconds(started);
  const activeAtSecond = (await turnRows(ctx.db, chat.id)).filter((turn) => turn.mode === "background" &&
    (turn.state === "running" || turn.state === "waiting")).length;
  const second = await send(ctx, run, chat.id, SIDE_QUESTION.text);
  const secondTerminal = await waitRun(ctx, second);
  const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT strpos(m."content"::text, $2) > 0 AS "hit"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [second, SIDE_QUESTION.answer]);
  Object.assign(run.line, { backgroundActiveAtSecondMessage: activeAtSecond, secondAnswerRight: rows[0]?.hit === true,
    secondTerminal: secondTerminal.status });
  // Every background turn ends and its callback reaches the main agent.
  await poll(30 * 60_000, async () => {
    const turns = await turnRows(ctx.db, chat.id);
    return turns.length > 0 && turns.every((turn) => turn.state !== "running" && turn.state !== "waiting") ? true : null;
  }, "background_end_timeout", 5_000).catch(() => { run.line.backgroundEndTimeout = true; });
  await waitMainIdle(ctx, chat.id);
  const watched = await watch.stop();
  run.line.threadViews = watched;
  const { turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const callbacks = callbackEvidence(turns, wakeUps);
  run.line.wallSeconds = seconds(started);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleB(read.value));
  if (callbacks.backgroundTurns !== SUBAGENT_NAMES.background.length) checks.push("background_turns_not_5");
  if (activeAtSecond === 0) checks.push("none_running_at_second_message");
  if (secondTerminal.status !== "complete" || run.line.secondAnswerRight !== true) checks.push("second_message_not_answered");
  if (callbacks.callbacksOwed > 0) checks.push("callbacks_owed");
  if (callbacks.wakeUpTurns === 0) checks.push("no_wake_up");
  if (!usage.split) checks.push("usage_not_split");
  if (watched.progression.length < 2) checks.push("states_not_progressing");
  run.line.checksFailed = checks;
  return { success: firstTerminal.status === "complete" && checks.length === 0, usage };
}

/** C1, C2, D5 and D1: one long browsing turn; the live panel declines every handoff (the agent never solves a check). */
async function browsingScenario(ctx: Context, run: Run, input: Readonly<{
  oracle: (value: ResultFound) => OracleVerdict; prompt: string; requested: CatalogModel | null; title: string;
}>): Promise<Outcome> {
  const chat = await createScenarioChat(ctx.session.api, input.title);
  run.chats.push(chat.id);
  const started = Date.now();
  const runId = await send(ctx, run, chat.id, input.prompt);
  const panel = interact(ctx, run, (await handoffModule()).cancelEveryHandoff, chat.id, runId, `zq${randomUUID().replaceAll("-", "")}`);
  const terminal = await waitRun(ctx, runId);
  run.line.wallSeconds = seconds(started);
  panel.abort();
  await Promise.all(run.interactions);
  Object.assign(run.line, { failureCode: terminal.errorCode, terminal: terminal.status });
  const { turns, usage } = await commonEvidence(ctx, run, chat.id);
  const read = await resultOf(ctx, chat.id, [runId]);
  const checks = judge(run, read, input.oracle);
  run.line.walls = await wallCodes(ctx.db, chat.id, turns, read);
  if (input.requested) {
    const requested = requestedModelEvidence(turns, { modelId: input.requested.modelId, provider: input.requested.provider });
    run.line.requestedModel = requested;
    if (!requested.allOnRequestedModel) checks.push("turns_not_on_requested_model");
  }
  run.line.checksFailed = checks;
  return { success: terminal.status === "complete" && checks.length === 0, usage };
}

async function scenarioE(ctx: Context, run: Run): Promise<Outcome> {
  const secrets = runSecrets(randomBytes(16));
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario E");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const started = Date.now();
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.start(secrets));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const correction = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.correction(secrets));
  run.line.correctionTerminal = (await waitRun(ctx, correction)).status;
  const byTool = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.stopByTool());
  run.line.stopToolTerminal = (await waitRun(ctx, byTool)).status;
  const [idleTool, idleRoute, idleAll] = SUBAGENT_NAMES.idle;
  const stopTool = await waitTurnEnded(ctx, chat.id, idleTool, 120_000);
  // The thread view's Stop, as the user presses it.
  const routeThread = (await threadIdsByName(ctx.db, chat.id)).get(idleRoute)?.at(-1);
  if (routeThread) {
    const stopped = decodeSubagentStopResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.stopThread(chat.id, routeThread),
      { body: {}, method: "POST" }));
    run.line.stopRouteResponse = stopped ? stopped.thread.state : "invalid";
  }
  const stopRoute = await waitTurnEnded(ctx, chat.id, idleRoute, 120_000);
  // The correction's sub-agent ends on its own and its wake-up answer writes the file, before "Stop all" could reach it.
  const counter = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.counter, 30 * 60_000);
  run.line.counterState = counter?.state ?? null;
  await waitMainIdle(ctx, chat.id);
  const stoppedAll = decodeSubagentStopAllResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.stopAll(chat.id),
    { body: {}, method: "POST" }));
  run.line.stopAllStopped = stoppedAll ? stoppedAll.stopped : null;
  const stopAll = await waitTurnEnded(ctx, chat.id, idleAll, 120_000);
  await waitMainIdle(ctx, chat.id);
  run.line.threadViews = await watch.stop();
  const { rows } = await ctx.db.query<{ delivered: number; total: number }>(`SELECT count(*)::int AS "total",
      count(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int AS "delivered"
    FROM "RunFollowup" WHERE "chatId" = $1 AND "origin"::text = 'main_agent'`, [chat.id]);
  const counterThread = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.counter)?.at(-1);
  const view = counterThread
    ? decodeSubagentThreadView(await json(ctx.session.api, SUBAGENT_API_PATHS.thread(chat.id, counterThread))) : null;
  const deliveries: Record<string, number> = {};
  for (const message of view?.turns.flatMap((turn) => turn.messages) ?? []) {
    deliveries[message.delivery] = (deliveries[message.delivery] ?? 0) + 1;
  }
  const stops = stopEvidence({ stopAll, stopRoute, stopTool });
  Object.assign(run.line, { correctionFollowups: rows[0] ?? null, stops, threadViewDeliveries: deliveries, threadViewRead: view !== null,
    wallSeconds: seconds(started) });
  const { usage } = await commonEvidence(ctx, run, chat.id);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleE(read.value, secrets));
  if ((rows[0]?.delivered ?? 0) === 0) checks.push("correction_not_delivered");
  if (!stops.stopToolStopped) checks.push("stop_subagent_failed");
  if (!stops.stopRouteStopped) checks.push("stop_route_failed");
  if (!stops.stopAllStopped) checks.push("stop_all_failed");
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

async function scenarioF(ctx: Context, run: Run): Promise<Outcome> {
  const secrets = runSecrets(randomBytes(16));
  const expected = notaryValue(secrets.nonce);
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario F");
  run.chats.push(chat.id);
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.F.start(secrets));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const notary = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.notary)?.at(-1) ?? null;
  // Where the main agent could have read the value before the continuation: its messages and its own tool results.
  const { rows: leaks } = await ctx.db.query<{ count: number }>(`SELECT (
      (SELECT count(*) FROM "Message" WHERE "chatId" = $1 AND strpos("content"::text, $2) > 0) +
      (SELECT count(*) FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
        WHERE r."chatId" = $1 AND c."subagentThreadId" IS NULL AND strpos(coalesce(c."result"::text, ''), $2) > 0))::int AS "count"`,
  [chat.id, expected]);
  run.line.valueVisibleToMainBefore = leaks[0]?.count ?? null;
  const continued = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.F.continuation());
  run.line.continuationTerminal = (await waitRun(ctx, continued)).status;
  const turns = (await turnRows(ctx.db, chat.id)).filter((turn) => turn.threadId === notary);
  const second = turns.find((turn) => turn.parentRunId === continued) ?? null;
  const secondCalls = second ? (await toolRows(ctx.db, chat.id)).filter((row) => row.turnId === second.turnId).length : null;
  Object.assign(run.line, { continuationOnSameThread: second !== null, notaryTurns: turns.length, secondTurnToolCalls: secondCalls });
  const checks = judge(run, await resultOf(ctx, chat.id, [continued]), (read) => oracleFContinued(read.value, expected));
  if (second === null) checks.push("thread_not_continued");
  // The edit: the first message changes and is answered again, as the composer's Edit does.
  const { rows: firstMessage } = await ctx.db.query<{ userMessageId: string }>(`SELECT "userMessageId" FROM "ModelRun" WHERE "id" = $1`,
    [first]);
  await waitMainIdle(ctx, chat.id);
  const edited = await json(ctx.session.api, `/api/messages/${encodeURIComponent(firstMessage[0]?.userMessageId ?? "")}`, {
    body: { content: { blocks: [{ text: SUBAGENT_PROMPTS.F.edited(), type: "text" }] } }, method: "PATCH" });
  const editedId = isRecord(edited) && isRecord(edited.message) && typeof edited.message.id === "string"
    ? edited.message.id : fail("edit_response_invalid");
  const abort = new AbortController();
  const regenerated = await request(ctx.session.api, `/api/messages/${encodeURIComponent(editedId)}/regenerate`, { body: {
    admissionId: randomUUID(), ...runControls(ctx.model) }, method: "POST", signal: abort.signal });
  if (!regenerated.ok) fail(`regenerate_${await errorCode(regenerated)}`);
  run.streams.push({ abort, drained: discard(regenerated) });
  const editedRun = await poll(120_000, async () => (await mainRuns(ctx.db, chat.id))
    .find((entry) => entry.userMessageId === editedId)?.id ?? null, "edited_run_not_admitted");
  run.line.editedTerminal = (await waitRun(ctx, editedRun)).status;
  const visible = async () => {
    const threads = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chat.id)));
    return threads ? threads.threads.some((thread) => thread.id === notary) : null;
  };
  const visibleAfterEdit = await visible();
  const branched = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.F.newBranch());
  run.line.newBranchTerminal = (await waitRun(ctx, branched)).status;
  const visibleOnNewBranch = await visible();
  Object.assign(run.line, { abandonedThreadVisibleAfterEdit: visibleAfterEdit, abandonedThreadVisibleOnNewBranch: visibleOnNewBranch });
  const branchRead = await resultOf(ctx, chat.id, [branched]);
  const branchVerdict = branchRead.ok ? oracleFBranched(branchRead.value, expected) : { counts: {}, failed: [branchRead.code] };
  run.line.branchOracleCounts = branchVerdict.counts;
  checks.push(...branchVerdict.failed.map((code) => `branch_${code}`));
  if (visibleAfterEdit !== false || visibleOnNewBranch !== false) checks.push("abandoned_thread_visible");
  if ((run.line.valueVisibleToMainBefore ?? 0) !== 0) checks.push("value_visible_to_main_before_continuation");
  const { usage } = await commonEvidence(ctx, run, chat.id);
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

/** The restart hook, with a minimal environment and its output discarded. */
function runRestartHook(hook: RestartHook): Promise<Readonly<{ exitCode: number | null; seconds: number; timedOut: boolean }>> {
  const started = Date.now();
  const picked: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value) picked[key] = value;
  }
  // Next's global types make `NODE_ENV` required on `ProcessEnv`; the hook's shell needs none, so none is passed.
  const env = picked as NodeJS.ProcessEnv;
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn("/bin/sh", ["-c", hook.command], { env, stdio: "ignore" });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, hook.timeoutMs);
    const done = (exitCode: number | null) => { clearTimeout(timer); resolve({ exitCode, seconds: seconds(started), timedOut }); };
    child.once("error", () => done(null));
    child.once("exit", (code) => done(code));
  });
}

async function scenarioG(ctx: Context, run: Run): Promise<Outcome> {
  const hook = ctx.options.restart ?? fail("restart_command_required");
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario G");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.G.start());
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  // Restart only once all three run and both browsing agents have browsed.
  const ready = await poll(10 * 60_000, async () => {
    const turns = await turnRows(ctx.db, chat.id);
    const running = turns.filter((turn) => turn.mode === "background" && turn.state === "running").length;
    const browsing = browserEvidence(await toolRows(ctx.db, chat.id), Date.now()).browsingAgents;
    return running >= 3 && browsing >= 2 ? { browsing, running } : null;
  }, "restart_precondition_timeout", 5_000).catch(() => null);
  run.line.beforeRestart = ready;
  await stopStreams(run);
  const restartedAt = Date.now();
  const restart = await runRestartHook(hook);
  run.line.restart = restart;
  const back = Date.now();
  const readyAgain = await poll(10 * 60_000, async () => {
    const response = await request(ctx.session.api, "/api/health/ready").catch(() => null);
    return response?.ok ? true : null;
  }, "app_not_ready", 3_000).catch(() => false);
  run.line.appReadySeconds = readyAgain ? seconds(back) : null;
  // Sessions live in the database; sign in again only when the restart ended this one.
  const me = await request(ctx.session.api, "/api/me").catch(() => null);
  if (!me || me.status === 401) ctx.session.api = await authenticate(ctx.target);
  // Opening the chat, as the user would, while recovery ends what the restart cut off.
  await poll(20 * 60_000, async () => {
    await request(ctx.session.api, `/api/chats/${encodeURIComponent(chat.id)}`).catch(() => null);
    const turns = await turnRows(ctx.db, chat.id);
    return turns.length > 0 && turns.every((turn) => turn.state !== "running" && turn.state !== "waiting") ? true : null;
  }, "interrupted_timeout", 5_000).catch(() => { run.line.interruptedTimeout = true; });
  await waitMainIdle(ctx, chat.id);
  const { rows: attached } = await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "WorkspaceRunAttachment"
    WHERE "chatId" = $1`, [chat.id]);
  run.line.attachmentsLeft = attached[0]?.count ?? null;
  const evidence = restartEvidence(await turnRows(ctx.db, chat.id), await wakeUpRows(ctx.db, chat.id), restartedAt);
  run.line.restartEvidence = evidence;
  const sleeperBefore = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.restart.sleeper)?.at(-1) ?? null;
  const continued = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.G.continuation());
  run.line.continuationTerminal = (await waitRun(ctx, continued)).status;
  const resumed = (await turnRows(ctx.db, chat.id)).find((turn) => turn.threadId === sleeperBefore && turn.parentRunId === continued);
  run.line.continuedByName = resumed ? resumed.state : null;
  run.line.threadViews = await watch.stop();
  const { usage } = await commonEvidence(ctx, run, chat.id);
  const checks: string[] = [];
  if (!ready) checks.push("restart_precondition_timeout");
  if (restart.exitCode !== 0) checks.push(restart.timedOut ? "restart_timeout" : "restart_failed");
  if (!readyAgain) checks.push("app_not_ready");
  if (!evidence.allInterrupted) checks.push("not_all_interrupted");
  if (!evidence.oneCoalescedWakeUp) checks.push("wake_up_not_one_coalesced");
  if (run.line.attachmentsLeft !== 0) checks.push("attachments_left");
  if (!resumed || resumed.state !== "done") checks.push("not_continued_by_name");
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

async function scenarioH(ctx: Context, run: Run): Promise<Outcome> {
  // The user signs in through the live view, so no saved login may be there to use.
  await syncSaucedemoSecret(ctx.session.api, false);
  const marker = `zq${randomUUID().replaceAll("-", "")}`;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario H");
  run.chats.push(chat.id);
  const watch = watchThreads(ctx, chat.id);
  const started = Date.now();
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.H());
  const panel = interact(ctx, run, (await handoffModule()).signInThroughHandoff, chat.id, first, marker);
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const sauce = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.handoff.sauce, (TURN_SECONDS + ctx.marginSeconds) * 1_000);
  run.line.sauceState = sauce?.state ?? null;
  run.line.sauceOutcome = sauce?.outcome ?? null;
  await sleep(2_000);
  panel.abort();
  await Promise.all(run.interactions);
  await waitMainIdle(ctx, chat.id);
  const watched = await watch.stop();
  run.line.threadViews = watched;
  run.line.wallSeconds = seconds(started);
  const runIds = (await ctx.db.query<{ id: string }>(`SELECT "id" FROM "ModelRun" WHERE "chatId" = $1`, [chat.id])).rows.map((row) => row.id);
  const handoffs = await handoffCalls(ctx.db, runIds, true);
  const leaks = await typedValueLeaks(ctx.db, chat.id, runIds, marker).catch(() => null);
  run.line.subagentHandoffOutcomes = handoffs.map((call) => handoffOutcome(call.result) ?? "none");
  const { usage } = await commonEvidence(ctx, run, chat.id);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleH(read.value, { handoffs, leaks }));
  const interaction = isRecord(run.line.interaction) ? run.line.interaction : {};
  const count = (key: string): number => {
    const value = interaction[key];
    return typeof value === "number" ? value : 0;
  };
  if (!progressionSaw(watched.progression, "waiting")) checks.push("waiting_not_observed");
  if (count("subagentHandoffs") === 0) checks.push("handoff_not_from_subagent");
  if (count("handoffsNamingAgent") === 0) checks.push("handoff_not_naming_agent");
  if (count("agentTabShown") + count("agentSwitches") === 0) checks.push("agent_switch_not_used");
  const browser = run.line.browser as ReturnType<typeof browserEvidence>;
  if (browser.peakBrowsingAgents < 2) checks.push("other_agent_not_browsing_at_once");
  run.line.checksFailed = checks;
  return { success: checks.length === 0, usage };
}

/** A date a year ahead in the task's zone, so the task's own schedule never fires during the run. */
function farDate(): string {
  return new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
}

async function deleteTask(api: Api, taskId: string): Promise<boolean> {
  const path = `/api/me/scheduled-tasks/${encodeURIComponent(taskId)}`;
  const removed = await request(api, path, { method: "DELETE" });
  if (removed.status !== 204 && removed.status !== 404) return false;
  return (await request(api, path)).status === 404;
}

async function scenarioI(ctx: Context, run: Run): Promise<Outcome> {
  run.line.telegram = "not_covered";
  const created = await json(ctx.session.api, "/api/me/scheduled-tasks", { body: {
    chatMode: "new", emailNotify: false, historyRetentionDays: 30, kind: "standard", memoryEnabled: false,
    modelId: ctx.model.modelId, pinnedSkillIds: [], prompt: SUBAGENT_PROMPTS.I(), provider: ctx.model.provider,
    schedule: { date: farDate(), kind: "once", time: "09:00" }, scheduleEnabled: true, searchEnabled: false, telegramNotify: false,
    timeZone: "Europe/Madrid", title: "Sub-agent scenario I", toolsEnabled: true, webhookEnabled: false, workspaceEnabled: true
  }, method: "POST" });
  const taskId = isRecord(created) && isRecord(created.task) && typeof created.task.id === "string"
    ? created.task.id : fail("task_response_invalid");
  run.tasks.push(taskId);
  const started = Date.now();
  await json(ctx.session.api, `/api/me/scheduled-tasks/${encodeURIComponent(taskId)}/run`, { body: {}, method: "POST" });
  const admitted = await poll(5 * 60_000, async () => {
    const { rows } = await ctx.db.query<{ chatId: string; id: string }>(`SELECT "id", "chatId" FROM "ModelRun"
      WHERE "scheduledTaskId" = $1 AND "subagentTurnId" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, [taskId]);
    return rows[0] ?? null;
  }, "scheduled_run_not_admitted", 3_000);
  run.chats.push(admitted.chatId);
  const terminal = await waitRun(ctx, admitted.id);
  Object.assign(run.line, { failureCode: terminal.errorCode, terminal: terminal.status, wallSeconds: seconds(started) });
  await waitMainIdle(ctx, admitted.chatId);
  const { tools, turns, usage } = await commonEvidence(ctx, run, admitted.chatId);
  const checks = judge(run, await resultOf(ctx, admitted.chatId, [admitted.id]), (read) => oracleI(read.value));
  const binding = bindingEvidence(turns);
  if (binding.foregroundTurns === 0) checks.push("no_waiting_subagent");
  if (binding.backgroundTurns > 0) checks.push("background_ran_in_scheduled_task");
  run.line.backgroundRefusedInTask = subagentCallEvidence(tools).backgroundRefusals;
  run.line.checksFailed = checks;
  return { success: terminal.status === "complete" && checks.length === 0, usage };
}

async function runScenario(ctx: Context, id: SubagentScenarioId, index: number): Promise<SubagentRunRecord> {
  const run: Run = { chats: [], interactions: [], line: { run: index, scenario: id }, streams: [], tasks: [] };
  const started = Date.now();
  let outcome: Outcome = { success: false, usage: null };
  try {
    stage = `pre_run_cleanup_${id}`;
    run.line.sessionsRemovedBefore = await removeBrowserSessions(ctx.session.api);
    await syncSaucedemoSecret(ctx.session.api, false);
    stage = `scenario_${id}`;
    switch (id) {
      case "A": outcome = await scenarioA(ctx, run); break;
      case "B": outcome = await scenarioB(ctx, run); break;
      case "C1":
      case "C2": {
        const requested = id === "C2" ? ctx.second ?? fail("second_model_required") : null;
        outcome = await browsingScenario(ctx, run, { oracle: (read) => oracleC(read.value), requested,
          prompt: SUBAGENT_PROMPTS.C(requested ? ctx.options.secondModel : null), title: `Sub-agent scenario ${id}` });
        break;
      }
      case "D5":
      case "D1":
        outcome = await browsingScenario(ctx, run, { oracle: (read) => oracleD(read.value), prompt: SUBAGENT_PROMPTS.D(id === "D5"),
          requested: null, title: `Sub-agent scenario ${id}` });
        break;
      case "E": outcome = await scenarioE(ctx, run); break;
      case "F": outcome = await scenarioF(ctx, run); break;
      case "G": outcome = await scenarioG(ctx, run); break;
      case "H": outcome = await scenarioH(ctx, run); break;
      case "I": outcome = await scenarioI(ctx, run); break;
    }
  } catch (error) {
    run.line.harnessError = error instanceof BrowserScenarioError ? error.message : "subagent_scenarios_run_failed";
    run.line.harnessStage = stage;
    outcome = { success: false, usage: outcome.usage };
  }
  await stopStreams(run);
  await Promise.all(run.interactions);
  run.line.success = outcome.success;
  run.line.elapsedSeconds = seconds(started);
  const { cleaned, ...cleanup } = await cleanUpScenario({
    deleteChat: (chatId) => deleteChat(ctx.session.api, ctx.db, chatId),
    deleteTask: (taskId) => deleteTask(ctx.session.api, taskId),
    removeBrowserSessions: () => removeBrowserSessions(ctx.session.api)
  }, { chatIds: run.chats, keepChats: ctx.keepChats, taskIds: run.tasks });
  Object.assign(run.line, cleanup);
  emit(run.line);
  if (!cleaned) fail("cleanup_failed");
  return { run: index, scenario: id, success: outcome.success, usage: outcome.usage,
    wallSeconds: typeof run.line.wallSeconds === "number" ? run.line.wallSeconds : seconds(started) };
}

// Main -------------------------------------------------------------------------------

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(code);
}

async function main() {
  const composeFile = process.env.AIQSA_SUBAGENTS_COMPOSE_FILE ?? fail("compose_required");
  const target = requireBrowserScenarioStand(process.env.AIQSA_SUBAGENTS_E2E,
    JSON.parse(readFileSync(composeFile, "utf8")) as BrowserScenarioStand);
  const scenarios = selectedSubagentScenarios(process.env.AIQSA_SUBAGENTS_SELECT);
  const route = codexLbRoute(readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"));
  const options = subagentHarnessOptions(process.env, scenarios, route.model);
  const marginSeconds = boundedInteger(process.env.AIQSA_SUBAGENTS_MARGIN_SECONDS, 600, 60, 3_600, "margin_invalid");
  const label = process.env.AIQSA_SUBAGENTS_LABEL?.trim() || "unlabelled";
  if (!/^[A-Za-z0-9._/-]{1,80}$/u.test(label)) fail("label_invalid");
  const secret = process.env.CODEX_LB_API_KEY ?? fail("codex_lb_key_required");
  const db = new PostgresClient({ connectionString: target.databaseUrl });
  await db.connect();
  const started = Date.now();
  const records: SubagentRunRecord[] = [];
  try {
    stage = "preflight";
    await requireIdleStand(db);
    const api = await authenticate(target);
    stage = "setup";
    const { chatProvider, model } = await setUpStand(api, { chat: { route: "codex-lb" }, route, secret });
    let second: CatalogModel | null = null;
    if (options.secondModel !== null) {
      const added = await ensureModel(api, { apiRoot: route.apiRoot, model: options.secondModel }, secret, SECOND_MODEL_DISPLAY_NAME);
      second = await catalogModel(api, added);
    }
    emit({ stage: "ready", label, project: target.project, provider: "codex-lb", model: route.model, contextWindow: chatProvider.contextWindow,
      reused: chatProvider.reused, secondModel: second !== null, restartHook: options.restart !== null, configuredBounds: target.configuredBounds,
      scenarios, runs: options.runs });
    const ctx: Context = { db, keepChats: process.env.AIQSA_SUBAGENTS_KEEP_CHATS === "1", marginSeconds, model, options, second,
      session: { api }, target };
    for (let index = 1; index <= options.runs; index += 1) {
      for (const id of scenarios) records.push(await runScenario(ctx, id, index));
    }
    for (const id of scenarios) emit({ stage: "summary", ...subagentScenarioSummary(id, records) });
    emit({ status: "finished", label, model: route.model, runs: records.length, successes: records.filter((entry) => entry.success).length,
      elapsedSeconds: Math.round((Date.now() - started) / 1000) });
  } finally {
    await db.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof BrowserScenarioError ? error.message : "subagent_scenarios_check_failed";
  emit({ status: "failed", stage, code });
  process.exitCode = 1;
});
