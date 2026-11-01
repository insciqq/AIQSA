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
 * - J: the capture and retire defects, one chat and two sends, only when named. The main agent
 *   writes a small PNG, starts `viewer` (views it with its image tool) and `quiet` (no tool, a long
 *   written answer, so it ends last) and answers at once; the second message goes as soon as the
 *   main run and both turns ended. Oracles: the image call succeeded and no capture identity or
 *   internal vision failure exists; the second message was accepted (a refusal only because the
 *   server's wake-up took the turn first is sent again once and recorded); no callback stays owed;
 *   the session left `RUNNING` to `STOPPED` or `PENDING` by the ordinary path (`secondsToLeaveRunning`
 *   from the last turn's end, signed, zero or less when healthy). `order_not_reached: true` records
 *   that the model did not produce the defect's order, and is not a failure. Paid calls: about 8–11
 *   codex-lb requests (main 3–4, viewer 2–3 and at most one System Vision call, quiet 1 long answer,
 *   wake-up and second message 1–2 each) in about 3–6 minutes.
 * - K: files and images across agents, one chat, only when named. The main agent and two background
 *   sub-agents each write a text file only its writer's command makes and a coloured PNG in one
 *   `/workspace/project/` folder and read the main agent's. Then `file-left` is continued by name in
 *   the foreground and `file-right` in the background: each reads its own earlier files and the
 *   others', the main agent reads both, and the result file reports every read. Then "a chart in the
 *   background" with no path in the message: the chart's turn ended, the main agent's image tool
 *   succeeded on an answer after it, and a PNG exported by those answers opens through the user's
 *   attachment route. Last, with a model without vision (below), `blind` on that model finishes with
 *   System Vision and never calls direct view; without one, `blind: "not_configured"` records that
 *   the step did not run. Paid calls: about 40–60 codex-lb requests and at most 3 System Vision calls,
 *   plus 2–4 OpenRouter text requests with the last step, in about 10–20 minutes.
 * - L: a document the parser refuses, one chat and one send, only when named, no sub-agents. An XLSX
 *   over `SPREADSHEET_MAX_POPULATED_CELLS` whose second column comes from a per-run nonce goes up through
 *   `/api/uploads` as the composer sends it; before anything paid, read-only SQL requires `failed`,
 *   `parser_output_too_large` and no extracted text (`checksFailed` says otherwise, and that upload stays
 *   on the stand: no route deletes an unsent attachment). The message asks for the exact sum, computed
 *   with Python in the Workspace; a refusal at admission (`attachment_not_ready`, `attachment_needs_workspace`,
 *   any other) lands in `admissionRefusal`. Oracles: the run completes, the answer holds the exact sum
 *   (matched inside SQL, separators allowed; the nonce and the sum stay in memory), a Workspace command
 *   ran, a Workspace call named `/workspace/inbox`, and no Workspace call has an unknown outcome. Paid
 *   calls: about 2–4 codex-lb requests, no System Vision, in about 2–5 minutes.
 * - N: an earlier file read without a Workspace, one chat and two sends, only when named, no sub-agents.
 *   The Workspace goes off for the installation through `/api/admin/workspace` and comes back on in a
 *   `finally`; when it cannot, the line says `workspaceRestored: false` and the harness stops, because
 *   later scenarios need it. A DOCX of three headed sections, with a per-run word only in section 3, goes
 *   up through `/api/uploads` as the composer sends a document; before anything paid, read-only SQL requires
 *   `ready`, extracted text and the word in that text (`checksFailed` says otherwise, and that upload stays
 *   on the stand: no route deletes an unsent attachment). The first send attaches it and asks only for the
 *   title; the second, attaching nothing, asks what section 3 says and for the word, through `read_chat_file`.
 *   A first run that does not complete ends the scenario before the second send; a refusal at admission
 *   lands in `admissionRefusal`. Oracles: both runs complete, the chat has no Workspace session and no
 *   Workspace tool call, the word is in the second answer and not in the first (matched inside SQL; the word
 *   stays in memory), and the second run has a `read_chat_file` call that succeeded. Paid calls: about 3–5
 *   codex-lb requests (first turn 1, second turn 2–3, possibly a title), no System Vision, in about 1–3 minutes.
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
 * - AIQSA_SUBAGENTS_SECOND_NO_VISION=1: add the second model with vision declared off, so K's last step has a model
 *   the product treats as having no vision when no text-only model is reachable;
 * - AIQSA_SUBAGENTS_SECOND_MODEL (C2): an upstream model id on the same codex-lb route, not the parent's;
 *   the harness adds it as "Sub-agents second model" and requires it in the user's catalog
 * - AIQSA_SUBAGENTS_TEXT_MODEL (K's last step) with OPENROUTER_API_KEY: a text-only OpenRouter chat model, added by
 *   `ensureTextModel`, whose public listing proves it takes no images. Without it, K uses AIQSA_SUBAGENTS_SECOND_MODEL
 *   only when the catalog says that model has no image input; `ensureModel` declares vision on what it adds.
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
import type { Client as PostgresClient } from "pg";
import type { CatalogModel } from "../lib/contracts/catalog";
import { decodeSubagentDefinitionListResponse } from "../lib/contracts/subagentDefinitions";
import {
  SUBAGENT_API_PATHS, decodeSubagentChatThreads, decodeSubagentStopAllResponse, decodeSubagentStopResponse,
  decodeSubagentSummaryResponse, decodeSubagentThreadView
} from "../lib/contracts/subagentViews";
import { decodeUploadAttachmentResponse } from "../lib/contracts/uploads";
import {
  BrowserScenarioError, handoffOutcome, requireBrowserScenarioStand, type BrowserScenarioStand, type InteractionEvidence,
  type OracleVerdict, type ScenarioInteraction, type StandTarget
} from "./browser-scenarios-support";
import {
  TERMINAL_RUN_STATES, authenticate, awaitExport, catalogModel, createScenarioChat, deleteChat, discard, ensureModel, ensureTextModel, errorCode,
  handoffCalls, isRecord, json, poll, readResultFile, removeBrowserSessions, request, requireIdleStand, runControls, safeCode, setWorkspaceEnabled, standDatabase,
  setUpStand, syncSaucedemoSecret, typedValueLeaks, type Api, type ResultRead
} from "./browser-scenarios-stand";
import {
  SCENARIO_L_FILE_NAME, SCENARIO_L_MIME_TYPE, SCENARIO_N_FILE_NAME, SCENARIO_N_MIME_TYPE, SEND_LOST_TO_WAKE_UP, SIDE_QUESTION, SUBAGENT_NAMES, SUBAGENT_PROMPTS, appendProgression, appendSessionSample, bindingEvidence, blindImageEvidence,
  browserEvidence, callSubagentOutcomes, callbackEvidence, cleanUpScenario, failedToolCalls, imageToolEvidence, mainImageToolEvidence, notaryValue, stopSubagentCalls, oracleA, oracleB, oracleC, oracleD, oracleE, oracleFBranched, oracleFContinued, oracleH, oracleI, oracleJ, oracleKFlow, oracleKReads, oracleL, oracleN,
  peakConcurrentTurns, pngBytes, progressionSaw, requestedModelEvidence, restartEvidence, roundsPerAgent, runSecrets, scenarioJOrder, scenarioKFacts, scenarioLAnswerPattern,
  scenarioLFacts, scenarioLUploadChecks, scenarioLWorkspaceEvidence, scenarioNFacts, scenarioNToolEvidence, scenarioNUploadChecks, selectedSubagentScenarios, sendRefusal, sessionStopEvidence, stableCode, stateCounts, stopChecks, stopEvidence, subagentCallEvidence, subagentHarnessOptions, subagentScenarioSummary, turnOutcomes, usageByPurpose,
  type KChartDownload, type LAttachmentRow, type LWorkspaceCall, type PurposeUsageRow, type RestartHook, type ScenarioLFacts, type ScenarioNFacts, type SessionSample, type StateCounts, type StopPath, type SubagentHarnessOptions, type SubagentRunRecord,
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
  /** K's model without vision and the id its prompt names; null when none is configured. */
  blind: Readonly<{ id: string; model: CatalogModel }> | null;
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

type SendAttempt = Readonly<{ code: string; ok: false } | { ok: true; runId: string }>;

/** One send as the composer would make it, now: a refusal comes back, an accepted send gives the admitted run's id. */
async function trySend(ctx: Context, run: Run, chatId: string, text: string,
  files: readonly Readonly<{ attachmentId: string; fileName: string; type: "file" }>[] = [],
  controls: Readonly<{ workspace?: Readonly<{ enabled: boolean }> }> = {}): Promise<SendAttempt> {
  const leaf = await activeLeaf(ctx, chatId);
  const known = new Set((await mainRuns(ctx.db, chatId)).map((entry) => entry.id));
  const abort = new AbortController();
  const response = await request(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}/messages`, { body: {
    content: { blocks: [{ text, type: "text" }, ...files] }, expectedActiveLeafId: leaf, ...runControls(ctx.model), ...controls
  }, method: "POST", signal: abort.signal });
  if (!response.ok) return { code: await errorCode(response), ok: false };
  run.streams.push({ abort, drained: discard(response) });
  return { ok: true, runId: await poll(120_000, async () => (await mainRuns(ctx.db, chatId))
    .find((entry) => !known.has(entry.id) && !entry.systemTurn)?.id ?? null, "run_not_admitted") };
}

/** Sends one user message as the composer would, once the main agent is idle; resolves the admitted run's id. */
async function send(ctx: Context, run: Run, chatId: string, text: string): Promise<string> {
  await waitMainIdle(ctx, chatId);
  const sent = await trySend(ctx, run, chatId, text);
  return sent.ok ? sent.runId : fail(`send_${sent.code}`);
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
      -- The parent's answer connection: the same kind of id as the turn's provider (ModelRun.provider is the adapter kind).
      (SELECT b."connectionId" FROM "ProviderRunBinding" b WHERE b."modelRunId" = p."id" AND b."role"::text = 'answer'
        ORDER BY b."bindingKey" LIMIT 1) AS "parentProvider",
      p."modelId" AS "parentModelId", p."normalizedRequest"->>'reasoningEffort' AS "parentEffort",
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

/** The state the thread view shows for the newest thread of that name (as the user sees it), or null. */
async function threadViewState(ctx: Context, chatId: string, name: string): Promise<string | null> {
  const threadId = (await threadIdsByName(ctx.db, chatId)).get(name)?.at(-1);
  if (!threadId) return null;
  const threads = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chatId)));
  return threads?.threads.find((thread) => thread.id === threadId)?.state ?? null;
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
        AS "backgroundRefused",
      -- Stable codes only: the first content block's code fields, never its text.
      CASE WHEN c."result"->'content'->0->>'type' = 'json' THEN coalesce(
          CASE WHEN jsonb_typeof(c."result"->'content'->0->'value'->'error') = 'string'
            THEN c."result"->'content'->0->'value'->>'error' END,
          c."result"->'content'->0->'value'->'error'->>'code',
          c."result"->'content'->0->'value'->>'code',
          CASE WHEN c."result"->'content'->0->'value'->>'kind' = 'ended'
            THEN 'ended_' || (c."result"->'content'->0->'value'->>'state') END)
        WHEN c."result"->'content'->0->>'type' = 'text'
          THEN substring(c."result"->'content'->0->>'text' from '"error":\\{"code":"([a-z][a-z0-9_]{0,63})"')
      END AS "resultCode",
      CASE WHEN c."result"->'content'->0->>'type' = 'json' AND c."result"->'content'->0->'value'->>'kind' = 'ended'
        THEN c."result"->'content'->0->'value'->>'reason' END AS "resultReason",
      CASE WHEN c."toolName" <> 'stop_subagent' OR c."subagentThreadId" IS NOT NULL THEN NULL
        ELSE coalesce((SELECT t."mode"::text FROM "SubagentThread" th JOIN "SubagentTurn" t ON t."threadId" = th."id"
          WHERE th."chatId" = r."chatId" AND th."name" = lower(trim(c."arguments"->>'name'))
            AND t."startedAt" <= coalesce(c."startedAt", c."createdAt")
            AND (t."endedAt" IS NULL OR t."endedAt" >= coalesce(c."startedAt", c."createdAt"))
          ORDER BY t."startedAt" DESC LIMIT 1), 'none') END AS "stopTarget"
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

/** Attachments of the chat's runs to its shared Workspace, of the given runs when named. */
async function attachmentCount(db: PostgresClient, chatId: string, runIds?: readonly string[]): Promise<number> {
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "WorkspaceRunAttachment"
    WHERE "chatId" = $1 AND ($2::text[] IS NULL OR "modelRunId" = ANY($2::text[]))`, [chatId, runIds ? [...runIds] : null]);
  return rows[0]?.count ?? 0;
}

/**
 * Waits, within a bound, until no ended background turn of the chat owes its
 * callback and every wake-up turn has a terminal run: the server starts a
 * wake-up after its coalescing window, so evidence read earlier misses it.
 * With `wakeUpAfter` (G: the restart), a wake-up created at or after that
 * time must exist too, allowing a few seconds of clock skew between the
 * harness host and the database. False when the bound passed
 * (`callbacks_still_owed`).
 */
async function settleCallbacks(ctx: Context, chatId: string, timeoutMs = 120_000, wakeUpAfter: number | null = null): Promise<boolean> {
  let quiet = 0;
  return poll(timeoutMs, async () => {
    const owed = await owedCallbacks(ctx.db, chatId);
    const wakeUps = await wakeUpRows(ctx.db, chatId);
    const open = wakeUps.some((wakeUp) => wakeUp.runId === null || !TERMINAL_RUN_STATES.has(wakeUp.runStatus ?? ""));
    const awaited = wakeUpAfter === null ||
      wakeUps.some((wakeUp) => new Date(wakeUp.createdAt).getTime() >= wakeUpAfter - 5_000);
    quiet = owed === 0 && !open && awaited ? quiet + 1 : 0;
    return quiet >= 2 ? true : null;
  }, "callbacks_still_owed", 3_000).catch(() => false);
}

/** The chat's Workspace session as it stands, on the stand's clock; the owner's kind is computed here and the owner never leaves SQL. */
async function sessionSample(db: PostgresClient, chatId: string): Promise<SessionSample | null> {
  const { rows } = await db.query<SessionSample>(`SELECT "state"::text AS "state", ("operationExpiresAt" IS NOT NULL) AS "closing",
      CASE WHEN "operationOwner" IS NULL THEN 'none' WHEN "operationOwner" LIKE 'maintenance:%' THEN 'maintenance' ELSE 'other' END AS "owner",
      clock_timestamp() AT TIME ZONE 'UTC' AS "at"
    FROM "WorkspaceSession" WHERE "chatId" = $1`, [chatId]);
  return rows[0] ?? null;
}

/** Keeps the session's changes, read once a second. */
function watchSession(ctx: Context, chatId: string): Readonly<{ stop(): Promise<SessionSample[]> }> {
  let stopped = false;
  let samples: SessionSample[] = [];
  const loop = (async () => {
    while (!stopped) {
      const sample = await sessionSample(ctx.db, chatId).catch(() => null);
      if (sample) samples = appendSessionSample(samples, sample);
      await sleep(1_000);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return samples;
    }
  };
}

/** The defects' failures anywhere in the chat's runs, matched inside SQL: tool results, run errors and turn end reasons. */
async function captureFailures(db: PostgresClient, chatId: string) {
  const { rows } = await db.query<{ captureIdentity: number; visionInternal: number }>(`SELECT
      count(*) FILTER (WHERE strpos(f."text", 'WorkspaceSelectedCapture_identity_check') > 0)::int AS "captureIdentity",
      count(*) FILTER (WHERE strpos(f."text", 'vision_analysis_internal_failed') > 0)::int AS "visionInternal"
    FROM (
      SELECT coalesce(c."result"::text, '') AS "text" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1
      UNION ALL SELECT coalesce("errorPayload"::text, '') FROM "ModelRun" WHERE "chatId" = $1
      UNION ALL SELECT coalesce("reasonCode", '') FROM "SubagentTurn" WHERE "chatId" = $1
    ) f`, [chatId]);
  return rows[0] ?? { captureIdentity: 0, visionInternal: 0 };
}

/** The scenario's common evidence, assigned into its line, once owed callbacks have settled. */
async function commonEvidence(ctx: Context, run: Run, chatId: string) {
  const settled = await settleCallbacks(ctx, chatId);
  run.line.callbacksSettled = settled;
  const now = Date.now();
  const turns = await turnRows(ctx.db, chatId);
  const tools = await toolRows(ctx.db, chatId);
  const wakeUps = await wakeUpRows(ctx.db, chatId);
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  Object.assign(run.line, {
    binding: bindingEvidence(turns),
    browser: browserEvidence(tools, now),
    callbacks: callbackEvidence(turns, wakeUps),
    callSubagentOutcomes: callSubagentOutcomes(tools),
    calls: subagentCallEvidence(tools),
    failedToolCalls: failedToolCalls(tools),
    stopSubagentCalls: stopSubagentCalls(tools),
    peakConcurrentTurns: peakConcurrentTurns(turns, now),
    rounds: roundsPerAgent(tools),
    turnOutcomes: turnOutcomes(turns),
    usage
  });
  return { settled, tools, turns, usage, wakeUps };
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
  const { settled, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const callbacks = callbackEvidence(turns, wakeUps);
  run.line.wallSeconds = seconds(started);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleB(read.value));
  if (callbacks.backgroundTurns !== SUBAGENT_NAMES.background.length) checks.push("background_turns_not_5");
  if (activeAtSecond === 0) checks.push("none_running_at_second_message");
  if (secondTerminal.status !== "complete" || run.line.secondAnswerRight !== true) checks.push("second_message_not_answered");
  if (!settled) checks.push("callbacks_still_owed");
  else if (callbacks.callbacksOwed > 0) checks.push("callbacks_owed");
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
    // The turn's `modelId` is the upstream id the call names; the catalog's model id is accepted too.
    const modelIds = [input.requested.upstreamModelId, ctx.options.secondModel, input.requested.modelId]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const requested = requestedModelEvidence(turns, { modelIds, provider: input.requested.provider });
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
  // Each stop is judged only on agents the thread view still shows running right before it.
  const stateBeforeStop: Record<StopPath, string | null> = { stopAll: null, stopRoute: null, stopTool: null };
  // Stop all first, in its own step: two background agents that hold, stopped as soon as both run.
  const holds = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.holds());
  run.line.holdsTerminal = (await waitRun(ctx, holds)).status;
  const holdStates = async () => Promise.all(SUBAGENT_NAMES.hold.map((name) => threadViewState(ctx, chat.id, name)));
  const bothRunning = await poll(3 * 60_000, async () => (await holdStates()).every((state) => state === "running") ? true : null,
    "holds_not_running", 2_000).catch(() => false);
  const beforeAll = await holdStates();
  stateBeforeStop.stopAll = bothRunning ? "running" : beforeAll.find((state) => state !== "running") ?? null;
  const stoppedAll = decodeSubagentStopAllResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.stopAll(chat.id),
    { body: {}, method: "POST" }));
  run.line.stopAllStopped = stoppedAll ? stoppedAll.stopped : null;
  const stopAllAt = Date.now();
  const stopAll = await poll(30_000, async () => {
    const turns = await Promise.all(SUBAGENT_NAMES.hold.map((name) => latestTurnOf(ctx.db, chat.id, name)));
    return turns.every((turn) => turn !== null && turn.state !== "running" && turn.state !== "waiting")
      ? turns.filter((turn): turn is TurnRow => turn !== null) : null;
  }, "stop_all_timeout", 1_000).catch(async () => (await Promise.all(SUBAGENT_NAMES.hold.map((name) => latestTurnOf(ctx.db, chat.id, name))))
    .filter((turn): turn is TurnRow => turn !== null));
  run.line.stopAllSeconds = seconds(stopAllAt);
  // No stopped hold may keep its run attached to the shared Workspace.
  const holdRuns = stopAll.flatMap((turn) => turn.executionRunId ? [turn.executionRunId] : []);
  const attachmentsAfterStopAll = await poll(30_000, async () => await attachmentCount(ctx.db, chat.id, holdRuns) === 0 ? 0 : null,
    "attachments_left", 1_000).catch(() => attachmentCount(ctx.db, chat.id, holdRuns));
  run.line.attachmentsAfterStopAll = attachmentsAfterStopAll;
  // Then the correction to a running sub-agent, `stop_subagent` and the thread view's Stop.
  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.start(secrets));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  const correction = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.correction(secrets));
  run.line.correctionTerminal = (await waitRun(ctx, correction)).status;
  const [idleTool, idleRoute] = SUBAGENT_NAMES.idle;
  await waitMainIdle(ctx, chat.id);
  stateBeforeStop.stopTool = await threadViewState(ctx, chat.id, idleTool);
  const byTool = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.E.stopByTool());
  run.line.stopToolTerminal = (await waitRun(ctx, byTool)).status;
  const stopTool = await waitTurnEnded(ctx, chat.id, idleTool, 120_000);
  // The thread view's Stop, as the user presses it.
  const routeThread = (await threadIdsByName(ctx.db, chat.id)).get(idleRoute)?.at(-1);
  stateBeforeStop.stopRoute = await threadViewState(ctx, chat.id, idleRoute);
  if (routeThread) {
    const stopped = decodeSubagentStopResponse(await json(ctx.session.api, SUBAGENT_API_PATHS.stopThread(chat.id, routeThread),
      { body: {}, method: "POST" }));
    run.line.stopRouteResponse = stopped ? stopped.thread.state : "invalid";
  }
  const stopRoute = await waitTurnEnded(ctx, chat.id, idleRoute, 120_000);
  // The correction's sub-agent ends on its own and its wake-up answer writes the file.
  const counter = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.counter, 30 * 60_000);
  run.line.counterState = counter?.state ?? null;
  await waitMainIdle(ctx, chat.id);
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
  Object.assign(run.line, { correctionFollowups: rows[0] ?? null, stateBeforeStop, stops, threadViewDeliveries: deliveries,
    threadViewRead: view !== null, wallSeconds: seconds(started) });
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  run.line.threadViews = await watch.stop();
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleE(read.value, secrets));
  if ((rows[0]?.delivered ?? 0) === 0) checks.push("correction_not_delivered");
  checks.push(...stopChecks(stops, { stopAll: stateBeforeStop.stopAll === "running",
    stopRoute: stateBeforeStop.stopRoute === "running", stopTool: stateBeforeStop.stopTool === "running" }));
  if (attachmentsAfterStopAll !== 0) checks.push("attachments_left_after_stop_all");
  if (!settled) checks.push("callbacks_still_owed");
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
  // The interrupted callbacks reach one wake-up after the server's coalescing window, not at once.
  const restartSettled = await settleCallbacks(ctx, chat.id, 120_000, restartedAt);
  run.line.attachmentsLeft = await attachmentCount(ctx.db, chat.id);
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
  if (!restartSettled) checks.push("callbacks_still_owed");
  else if (!evidence.oneCoalescedWakeUp) checks.push("wake_up_not_one_coalesced");
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
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  const checks = judge(run, await resultOf(ctx, chat.id), (read) => oracleH(read.value, { handoffs, leaks }));
  if (!settled) checks.push("callbacks_still_owed");
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

/** Sends J's second message at once; a send the server's wake-up beat goes again once the main agent is idle. */
async function sendAtOnce(ctx: Context, run: Run, chatId: string, text: string) {
  const refusals: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sent = await trySend(ctx, run, chatId, text);
    if (sent.ok) return { refusals, runId: sent.runId };
    const mainRunActive = (await mainRuns(ctx.db, chatId)).some((entry) => !TERMINAL_RUN_STATES.has(entry.status));
    refusals.push(sendRefusal(sent.code, { mainRunActive, session: await sessionSample(ctx.db, chatId) }));
    if (refusals.at(-1) !== SEND_LOST_TO_WAKE_UP) break;
    await waitMainIdle(ctx, chatId, 10 * 60_000).catch(() => undefined);
  }
  return { refusals, runId: null };
}

async function scenarioJ(ctx: Context, run: Run): Promise<Outcome> {
  const imageName = `subagent-j-${runSecrets(randomBytes(16)).nonce}.png`;
  const { quiet, viewer } = SUBAGENT_NAMES.capture;
  const { question } = SUBAGENT_PROMPTS.J;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario J");
  run.chats.push(chat.id);
  const session = watchSession(ctx, chat.id);
  try {
    const started = Date.now();
    const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.J.start(imageName));
    run.line.firstTerminal = (await waitRun(ctx, first)).status;
    // A tight poll: the second message races the wake-up, whose coalescing window is 1.5 s.
    await poll(15 * 60_000, async () => {
      const turns = await Promise.all([viewer, quiet].map((name) => latestTurnOf(ctx.db, chat.id, name)));
      return turns.every((turn) => turn !== null && turn.state !== "running" && turn.state !== "waiting") ? true : null;
    }, "background_end_timeout", 500).catch(() => { run.line.backgroundEndTimeout = true; });
    const mainRunsActive = (await mainRuns(ctx.db, chat.id)).filter((entry) => !TERMINAL_RUN_STATES.has(entry.status)).length;
    const second = await sendAtOnce(ctx, run, chat.id, question.text);
    const secondTerminal = second.runId === null ? null : await waitRun(ctx, second.runId);
    const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT strpos(m."content"::text, $2) > 0 AS "hit"
      FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [second.runId, question.answer]);
    const secondAnswered = secondTerminal?.status === "complete" && rows[0]?.hit === true;
    // A refused message leaves the callbacks to the wake-up, which the defect holds back until the backstop.
    await waitMainIdle(ctx, chat.id, 10 * 60_000).catch(() => { run.line.mainIdleTimeout = true; });
    const { settled, tools, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
    const threads = await threadIdsByName(ctx.db, chat.id);
    const threadOf = (name: string) => threads.get(name)?.at(-1) ?? null;
    const turnOf = (name: string) => turns.filter((turn) => turn.threadId === threadOf(name)).at(-1) ?? null;
    const order = scenarioJOrder({ mainRunsActive, quiet: turnOf(quiet), viewer: turnOf(viewer),
      quietToolCalls: tools.filter((row) => row.threadId === threadOf(quiet)).length });
    const samples = await session.stop();
    const stop = sessionStopEvidence(samples, order.lastTurnEnd);
    const image = imageToolEvidence(tools, threadOf(viewer));
    const failures = await captureFailures(ctx.db, chat.id);
    const verdict = oracleJ({ callbacks: callbackEvidence(turns, wakeUps), failures, image, order, secondAccepted: second.runId !== null,
      secondAnswered, secondRefusals: second.refusals, session: stop, settled, wakeUps });
    const { lastTurnEnd: _lastTurnEnd, ...orderLine } = order;
    Object.assign(run.line, orderLine, { captureFailures: failures, image, oracleCounts: verdict.counts,
      secondAccepted: second.runId !== null, secondAnswered, secondRefusals: second.refusals, secondTerminal: secondTerminal?.status ?? null,
      sessionStates: samples.map((sample) => sample.state), sessionStop: stop, wallSeconds: seconds(started) });
    const checks = [...verdict.failed];
    if (!usage.split) checks.push("usage_not_split");
    run.line.checksFailed = checks;
    return { success: checks.length === 0, usage };
  } finally {
    await session.stop();
  }
}

/** The PNGs the given main-agent runs exported, as the user's attachment route serves them. */
async function exportedPngs(ctx: Context, runIds: readonly string[]): Promise<KChartDownload[]> {
  const downloads: KChartDownload[] = [];
  for (const runId of runIds) {
    await awaitExport(ctx.db, runId);
    const { rows } = await ctx.db.query<{ attachmentId: string; relativePath: string }>(
      `SELECT "attachmentId", "relativePath" FROM "WorkspaceRunOutput" WHERE "workspaceRunBindingId" = $1`, [runId]);
    for (const output of rows.filter((row) => /\.png$/iu.test(row.relativePath))) {
      const content = await request(ctx.session.api, `/api/attachments/${encodeURIComponent(output.attachmentId)}/content`);
      const bytes = content.ok ? new Uint8Array(await content.arrayBuffer()) : new Uint8Array();
      downloads.push({ bytes: bytes.byteLength, png: pngBytes(bytes) });
    }
  }
  return downloads;
}

const K_TURN_MS = 15 * 60_000;

async function scenarioK(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioKFacts(runSecrets(randomBytes(16)).nonce);
  const { blind, chart, left, right } = SUBAGENT_NAMES.files;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario K");
  run.chats.push(chat.id);
  const started = Date.now();
  const mainRunIds = async () => (await mainRuns(ctx.db, chat.id)).map((entry) => entry.id);

  const first = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.start(facts));
  run.line.firstTerminal = (await waitRun(ctx, first)).status;
  await Promise.all([left, right].map((name) => waitTurnEnded(ctx, chat.id, name, K_TURN_MS)));

  const reads = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.reads(facts));
  run.line.readsTerminal = (await waitRun(ctx, reads)).status;
  await waitTurnEnded(ctx, chat.id, right, K_TURN_MS);
  await waitMainIdle(ctx, chat.id, K_TURN_MS);
  const readRuns = await mainRunIds();
  const checks = judge(run, await resultOf(ctx, chat.id, readRuns), (read) => oracleKReads(read.value, facts.texts));

  const charted = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.chart());
  run.line.chartTerminal = (await waitRun(ctx, charted)).status;
  await waitTurnEnded(ctx, chat.id, chart, K_TURN_MS);
  await waitMainIdle(ctx, chat.id, K_TURN_MS);
  const chartRuns = (await mainRunIds()).filter((id) => !readRuns.includes(id));
  const downloads = await exportedPngs(ctx, chartRuns);

  let blindAnswered = false;
  if (ctx.blind) {
    const blindRun = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.K.blind(facts, ctx.blind.model.modelId));
    const terminal = await waitRun(ctx, blindRun);
    const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT m."content"::text ~* '\\mred\\M' AS "hit"
      FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [blindRun]);
    blindAnswered = terminal.status === "complete" && rows[0]?.hit === true;
  }

  const { settled, tools, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const threads = await threadIdsByName(ctx.db, chat.id);
  const threadOf = (name: string) => threads.get(name)?.at(-1) ?? null;
  const turnsOf = (name: string) => turns.filter((turn) => turn.threadId === threadOf(name));
  const blindEvidence = ctx.blind ? { answered: blindAnswered, image: blindImageEvidence(tools, threadOf(blind)),
    turn: turnsOf(blind).at(-1) ?? null } : null;
  const images = { left: imageToolEvidence(tools, threadOf(left)), main: mainImageToolEvidence(tools, readRuns),
    right: imageToolEvidence(tools, threadOf(right)) };
  const mainImage = mainImageToolEvidence(tools, chartRuns);
  const verdict = oracleKFlow({ blind: blindEvidence, callbacks: callbackEvidence(turns, wakeUps),
    chart: { downloads, mainImage, turn: turnsOf(chart).at(-1) ?? null }, images, left: turnsOf(left), right: turnsOf(right), settled });
  checks.push(...verdict.failed);
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { blind: blindEvidence ? { answered: blindEvidence.answered, image: blindEvidence.image,
    turnState: blindEvidence.turn?.state ?? null } : "not_configured", chart: { downloads, mainImage }, flowCounts: verdict.counts, images,
  checksFailed: checks, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

const L_PARSE_MS = 3 * 60_000;

/** Uploads the workbook as the composer does with a Workspace on; resolves the attachment's id. */
async function uploadWorkbook(ctx: Context, facts: ScenarioLFacts): Promise<string> {
  const form = new FormData();
  form.append("file", new File([Uint8Array.from(facts.workbook)], SCENARIO_L_FILE_NAME, { type: SCENARIO_L_MIME_TYPE }));
  form.append("scope", "workspace");
  const uploaded = decodeUploadAttachmentResponse(await json(ctx.session.api, "/api/uploads", { form, method: "POST", timeoutMs: L_PARSE_MS }));
  return uploaded?.attachment.id ?? fail("upload_response_invalid");
}

/** The attachment once the parser settled it, or null past the wait. */
async function settledAttachment(db: PostgresClient, attachmentId: string): Promise<LAttachmentRow | null> {
  return poll(L_PARSE_MS, async () => {
    const { rows } = await db.query<LAttachmentRow>(`SELECT "status"::text AS "status", "processingErrorCode",
        ("extractedText" IS NULL) AS "extractedTextNull" FROM "Attachment" WHERE "id" = $1`, [attachmentId]);
    return rows[0] && rows[0].status !== "processing" ? rows[0] : null;
  }, "upload_not_settled", 2_000).catch(() => null);
}

/** The run's Workspace tool calls; arguments and results stay inside SQL (`toolBatch.ts` and `runEndedToolCallResult` write the unknown outcome). */
async function workspaceCalls(db: PostgresClient, runId: string): Promise<LWorkspaceCall[]> {
  const { rows } = await db.query<LWorkspaceCall>(`SELECT c."toolName", c."state"::text AS "state",
      strpos(c."arguments"::text, '/workspace/inbox') > 0 AS "namesInbox",
      coalesce(c."state"::text = 'error' AND 'unknown' IN (c."result"->>'outcome', c."result"->'content'->0->'value'->>'outcome'), false)
        AS "unknownOutcome"
    FROM "ModelRunToolCall" c WHERE c."modelRunId" = $1 AND strpos(c."toolName", 'mcp_workspace_') = 1`, [runId]);
  return rows;
}

async function scenarioL(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioLFacts(runSecrets(randomBytes(16)).nonce);
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario L");
  run.chats.push(chat.id);
  const started = Date.now();
  const attachmentId = await uploadWorkbook(ctx, facts);
  const stored = await settledAttachment(ctx.db, attachmentId);
  const uploadFailures = scenarioLUploadChecks(stored);
  run.line.upload = { bytes: facts.workbook.byteLength, extractedTextNull: stored?.extractedTextNull ?? null, populatedCells: facts.populatedCells,
    processingErrorCode: stableCode(stored?.processingErrorCode), status: stableCode(stored?.status) };
  if (uploadFailures.length > 0) {
    run.line.checksFailed = uploadFailures;
    return { success: false, usage: null };
  }
  const sent = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.L(), [{ attachmentId, fileName: SCENARIO_L_FILE_NAME, type: "file" }]);
  if (!sent.ok) {
    Object.assign(run.line, { admissionRefusal: stableCode(sent.code), checksFailed: ["admission_refused"] });
    return { success: false, usage: null };
  }
  const terminal = await waitRun(ctx, sent.runId);
  Object.assign(run.line, { failureCode: terminal.errorCode, terminal: terminal.status, wallSeconds: seconds(started) });
  const { usage } = await commonEvidence(ctx, run, chat.id);
  const { rows } = await ctx.db.query<{ hit: boolean }>(`SELECT m."content"::text ~ $2 AS "hit"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [sent.runId, scenarioLAnswerPattern(facts.expectedSum)]);
  const workspace = scenarioLWorkspaceEvidence(await workspaceCalls(ctx.db, sent.runId));
  const verdict = oracleL({ answerHasSum: rows[0]?.hit === true, terminal: terminal.status, workspace });
  Object.assign(run.line, { checksFailed: verdict.failed, oracleCounts: verdict.counts });
  return { success: verdict.failed.length === 0, usage };
}

const N_TURN_MS = 10 * 60_000;

/** Uploads the document as the composer does without a Workspace: no scope. */
async function uploadDocument(ctx: Context, facts: ScenarioNFacts): Promise<string> {
  const form = new FormData();
  form.append("file", new File([Uint8Array.from(facts.document)], SCENARIO_N_FILE_NAME, { type: SCENARIO_N_MIME_TYPE }));
  const uploaded = decodeUploadAttachmentResponse(await json(ctx.session.api, "/api/uploads", { form, method: "POST", timeoutMs: L_PARSE_MS }));
  return uploaded?.attachment.id ?? fail("upload_response_invalid");
}

/** Whether the run's answer holds the word, matched inside SQL so neither leaves it. */
async function answerHolds(db: PostgresClient, runId: string, word: string): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(`SELECT strpos(lower(m."content"::text), $2) > 0 AS "hit"
    FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."id" = $1`, [runId, word]);
  return rows[0]?.hit === true;
}

/** N's two turns, with the Workspace already off for the installation. */
async function noWorkspaceTurns(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioNFacts(runSecrets(randomBytes(16)).nonce);
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario N");
  run.chats.push(chat.id);
  const started = Date.now();
  const attachmentId = await uploadDocument(ctx, facts);
  const stored = await settledAttachment(ctx.db, attachmentId);
  const { rows: parsed } = await ctx.db.query<{ hit: boolean }>(`SELECT coalesce(strpos(lower("extractedText"), $2) > 0, false) AS "hit"
    FROM "Attachment" WHERE "id" = $1`, [attachmentId, facts.codeWord]);
  const textHasCodeWord = parsed[0]?.hit === true;
  const uploadFailures = scenarioNUploadChecks(stored, textHasCodeWord);
  run.line.upload = { bytes: facts.document.byteLength, extractedTextNull: stored?.extractedTextNull ?? null,
    processingErrorCode: stableCode(stored?.processingErrorCode), status: stableCode(stored?.status), textHasCodeWord };
  if (uploadFailures.length > 0) {
    run.line.checksFailed = uploadFailures;
    return { success: false, usage: null };
  }

  const noWorkspace = { workspace: { enabled: false } };
  const refused = (code: string): Outcome => {
    Object.assign(run.line, { admissionRefusal: stableCode(code), checksFailed: ["admission_refused"] });
    return { success: false, usage: null };
  };
  const first = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.N.first(), [{ attachmentId, fileName: SCENARIO_N_FILE_NAME, type: "file" }], noWorkspace);
  if (!first.ok) return refused(first.code);
  const firstTerminal = await waitRun(ctx, first.runId, N_TURN_MS);
  Object.assign(run.line, { firstFailureCode: firstTerminal.errorCode, firstTerminal: firstTerminal.status });
  if (firstTerminal.status !== "complete") {
    run.line.checksFailed = ["first_run_not_complete"];
    return { success: false, usage: null };
  }
  await waitMainIdle(ctx, chat.id, N_TURN_MS);
  const second = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.N.second(), [], noWorkspace);
  if (!second.ok) return refused(second.code);
  const secondTerminal = await waitRun(ctx, second.runId, N_TURN_MS);
  Object.assign(run.line, { secondFailureCode: secondTerminal.errorCode, secondTerminal: secondTerminal.status, wallSeconds: seconds(started) });

  const { tools, usage } = await commonEvidence(ctx, run, chat.id);
  const verdict = oracleN({
    answerHasCodeWord: await answerHolds(ctx.db, second.runId, facts.codeWord),
    firstAnswerHasCodeWord: await answerHolds(ctx.db, first.runId, facts.codeWord),
    firstTerminal: firstTerminal.status, secondTerminal: secondTerminal.status,
    sessionStarted: await sessionSample(ctx.db, chat.id) !== null,
    tools: scenarioNToolEvidence(tools, { first: first.runId, second: second.runId })
  });
  Object.assign(run.line, { checksFailed: verdict.failed, oracleCounts: verdict.counts });
  return { success: verdict.failed.length === 0, usage };
}

/** Later scenarios need the Workspace, so it comes back on whatever happened; `runScenario` stops the harness when it could not. */
async function scenarioN(ctx: Context, run: Run): Promise<Outcome> {
  try {
    await setWorkspaceEnabled(ctx.session.api, false);
    return await noWorkspaceTurns(ctx, run);
  } finally {
    run.line.workspaceRestored = await setWorkspaceEnabled(ctx.session.api, true).then(() => true, () => false);
  }
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
      case "J": outcome = await scenarioJ(ctx, run); break;
      case "K": outcome = await scenarioK(ctx, run); break;
      case "L": outcome = await scenarioL(ctx, run); break;
      case "N": outcome = await scenarioN(ctx, run); break;
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
  if (run.line.workspaceRestored === false) fail("workspace_not_restored");
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
  const db = standDatabase(target.databaseUrl);
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
      const added = await ensureModel(api, { apiRoot: route.apiRoot, model: options.secondModel }, secret, SECOND_MODEL_DISPLAY_NAME,
        process.env.AIQSA_SUBAGENTS_SECOND_NO_VISION === "1" ? { vision: false } : {});
      second = await catalogModel(api, added);
    }
    let blind: Context["blind"] = null;
    if (scenarios.includes("K")) {
      if (options.textModel !== null) {
        const added = await ensureTextModel(api, options.textModel, process.env.OPENROUTER_API_KEY ?? fail("openrouter_key_required"));
        blind = { id: options.textModel, model: await catalogModel(api, added) };
      } else if (second && options.secondModel !== null && !second.capabilities.imageInput) {
        blind = { id: options.secondModel, model: second };
      }
      if (blind?.model.capabilities.imageInput) fail("text_model_has_image_input");
    }
    emit({ stage: "ready", label, project: target.project, provider: "codex-lb", model: route.model, contextWindow: chatProvider.contextWindow,
      reused: chatProvider.reused, secondModel: second !== null, modelWithoutVision: blind !== null, restartHook: options.restart !== null,
      configuredBounds: target.configuredBounds, scenarios, runs: options.runs });
    const ctx: Context = { blind, db, keepChats: process.env.AIQSA_SUBAGENTS_KEEP_CHATS === "1", marginSeconds, model, options, second,
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
