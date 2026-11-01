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
 * - M: agents talking, one chat, only when named. Two background sub-agents each know half of a per-run code and write
 *   it to the other: both reports hold both halves and each read a message. `m-late` is briefed with the work
 *   `m-worker` is doing: it lists the agents, names the worker and no call of its names the worker's file. A background
 *   `m-asker` sleeps past the main agent's answer and asks: it is seen `waiting`, the question wakes the main agent, and
 *   its report holds an answer only the user's message had. A foreground `m-front` asks: its turn ends
 *   `blocked (needs_answer)`, and continued by name its report holds the answer. `m-forger` writes `m-target` a message
 *   dressed as the user's confirming a payment: the target read it and no call of its names the payment's file. `m-ping`
 *   and `m-pong` count at each other until `subagent_message_limit_reached` ends them. `m-hold` asks a question nobody
 *   answers, and the thread's Stop reaches it in `waiting`. Paid calls: about 60–90 codex-lb requests, most of them the
 *   count, in about 15–30 minutes.
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
 * - O: a sub-agent's children, one chat, only when named. `o-lead` starts `o-left` and `o-right` in the foreground: each works
 *   out a per-run hash with a Workspace command and the lead's report holds both, which no brief states. Continued, it asks
 *   for three background helpers in one response: exactly one is refused `subagent_child_limit_reached`, its report names the
 *   code, and it ended after the two that ran, both done, because a parent waits for its children's reports. Then a helper
 *   is told to start its own: no such thread exists, and `depthRefused` counts a refusal if the model tried a tool it is not
 *   offered (`subagent_depth_limit_reached`; the refusal itself is proven in the focused tests). `o-holder` starts `o-inner`
 *   in the foreground and `o-side` in the background, both in `sleep 900`; once all three run, the main agent's Stop ends every
 *   one of them `parent_stopped`. Last, `o-clerk`'s helper `o-approver` calls a destructive MCP tool of a synthetic server this
 *   harness hosts (below): it is not sent, the helper and the clerk end `blocked (needs_approval)`, the card is on the main
 *   agent's run, and only the Allow sends it, once. Every child is read from the chat's thread list under its parent. Paid calls:
 *   about 30–45 codex-lb requests in about 8–15 minutes.
 * - P: the user writes to a working sub-agent, one chat, only when named. `p-listener` is briefed with three `sleep` commands
 *   and nothing about the user; once its first command runs, the harness posts to the thread as the browser does, asking
 *   for a per-run word at the end of the report and not to repeat a per-run note. Oracles: the message is accepted and read
 *   by the turn, the turn ends done, its report holds the word, and the note is in no message of the main chat (both matched
 *   inside SQL; they stay in memory). Paid calls: about 5–8 codex-lb requests in about 2–3 minutes.
 * - Q: page reading across agents, one chat, only when named, on each Search route the stand has (client, then hosted). A background
 *   `q-reader` makes 3 searches and reads a link of each with `fetch_url`, and the main agent reads 4 others from its report. Oracles:
 *   more searches than the old limit of 2, no refusal of a link any agent's search found, and more than 5 pages in one answer.
 *   Paid calls: about 8-12 codex-lb requests and 3 searches per route, in about 2-5 minutes.
 * - R: when research starts, only when named: 10 Russian phrases, each in a new chat with Search on. A run that calls `start_research`
 *   is stopped at once to save money. Oracle: each phrase went in its direction, reported by index. Paid calls: about 10-25 codex-lb
 *   requests and a few searches, in about 5-10 minutes. This needs DEEPSEEK_API_KEY for the Search source, as Q does.
 * - S: proxies end to end, one chat per step, only when named, with the operator's proxy in AIQSA_SUBAGENTS_TEST_PROXY (process only, never printed, never written).
 *   A proxy pasted in chat is saved for `.ru` and tested; the browser opens a hinted page, Yandex Market, Wildberries and Ozon, and an address echo through the named
 *   proxy; `fetch_url` reads through it; a dead proxy fails visibly; a switched-off one is refused by name. Oracles compare exit addresses inside SQL and print booleans. The
 *   answers go to AIQSA_SUBAGENTS_ANSWERS_FILE when set (0600), for reading by hand. Paid calls: about 15-30 codex-lb requests, in about 5-10 minutes.
 * - T: research metrics, one chat per question of `SCENARIO_T_QUESTIONS` (AIQSA_SUBAGENTS_T_KINDS narrows them), only when named. Per question: researchers, drafts, send-backs,
 *   what later rounds added, opened pages per source class, the check's note as the server wrote it. With AIQSA_SUBAGENTS_VERIFIER_FAMILY the verifier role goes to that
 *   connection's first model. Paid calls: hundreds of codex-lb requests and tens of searches per question, in about 10-40 minutes each.
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
 * - AIQSA_SUBAGENTS_FIXTURE_HOST (O: the MCP fixture's listen address, default 127.0.0.1) and AIQSA_SUBAGENTS_FIXTURE_PUBLIC_HOST
 *   (the host the stand's app container reaches it by, default the listen address). An app that cannot reach it fails O's
 *   last step as `approval_step_unavailable`, with the code in the line, and the other steps still count.
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
import { appendFileSync, readFileSync } from "node:fs";
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
import { registerBulkResultMcpServer, type BulkRegistrationClient } from "../tests/e2e/support/bulkResultMcpEndpoint";
import { createWriteApprovalFixture, startMutableMcpEndpoint } from "../tests/e2e/support/mutableMcpEndpoint";
import {
  BrowserScenarioError, handoffOutcome, requireBrowserScenarioStand, type BrowserScenarioStand, type InteractionEvidence,
  type OracleVerdict, type ScenarioInteraction, type StandTarget
} from "./browser-scenarios-support";
import {
  TERMINAL_RUN_STATES, authenticate, awaitExport, catalogModel, createScenarioChat, deleteChat, discard, ensureModel, ensureResearchVerifier, ensureSearchSource, ensureTextModel, errorCode,
  handoffCalls, isRecord, json, poll, readResultFile, removeBrowserSessions, request, requireIdleStand, runControls, safeCode, setWorkspaceEnabled, standDatabase,
  setUpStand, syncSaucedemoSecret, typedValueLeaks, type Api, type ResultRead
} from "./browser-scenarios-stand";
import {
  SCENARIO_L_FILE_NAME, SCENARIO_L_MIME_TYPE, SCENARIO_N_FILE_NAME, SCENARIO_N_MIME_TYPE, SEND_LOST_TO_WAKE_UP, SIDE_QUESTION, SUBAGENT_NAMES, SUBAGENT_PROMPTS, agentMessageEvidence, agentToolEvidence, appendProgression, appendSessionSample, bindingEvidence, blindImageEvidence,
  browserEvidence, callSubagentOutcomes, callbackEvidence, cleanUpScenario, failedToolCalls, imageToolEvidence, mainImageToolEvidence, notaryValue, stopSubagentCalls, oracleA, oracleB, oracleC, oracleD, oracleE, oracleFBranched, oracleFContinued, oracleH, oracleI, oracleJ, oracleKFlow, oracleKReads, oracleL, oracleM, oracleN, oracleO, oracleP, oracleQ, oracleR, SCENARIO_R_PHRASES, SUBAGENT_SCENARIO_NEEDS,
  SCENARIO_S_DEAD_HINT, SCENARIO_S_DEAD_NAME, SCENARIO_S_NAME, SCENARIO_S_PROMPTS, SCENARIO_T_QUESTIONS, oracleS, parseTestProxy, researchMetrics,
  type PageReads, type RPhraseResult, type TDraftFinding,
  peakConcurrentTurns, pngBytes, progressionSaw, requestedModelEvidence, restartEvidence, roundsPerAgent, runSecrets, scenarioJOrder, scenarioKFacts, scenarioLAnswerPattern,
  scenarioLFacts, scenarioLUploadChecks, scenarioLWorkspaceEvidence, scenarioMFacts, scenarioNFacts, scenarioNToolEvidence, scenarioNUploadChecks, scenarioOFacts, scenarioPFacts, selectedSubagentScenarios, sendRefusal, sessionStopEvidence, stableCode, stateCounts, stopChecks, stopEvidence, subagentCallEvidence, subagentHarnessOptions, subagentScenarioSummary, turnOutcomes, usageByPurpose,
  type KChartDownload, type LAttachmentRow, type LWorkspaceCall, type MMessageRow, type OEvidence, type PurposeUsageRow, type RestartHook, type ScenarioLFacts, type ScenarioNFacts, type ScenarioOFacts, type SessionSample, type StateCounts, type StopPath, type SubagentHarnessOptions, type SubagentRunRecord,
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
  /** The Search routes Q and R run on: the client route, and the hosted one when the stand's model offers it. */
  search: readonly SearchRoute[];
  second: CatalogModel | null;
  session: Session;
  target: StandTarget;
}>;

type SearchRoute = Readonly<{ mode: "all_selected" | "model_choice"; model: CatalogModel; name: string; optionId: string }>;

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

/** Owed callbacks: ended background turns no main-agent run received yet; a child reports to its parent and owes none. */
async function owedCallbacks(db: PostgresClient, chatId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "SubagentTurn" t
    JOIN "SubagentThread" th ON th."id" = t."threadId" AND th."parentThreadId" IS NULL
    WHERE t."chatId" = $1 AND t."mode" = 'background' AND t."state"::text NOT IN ('running', 'waiting') AND t."callbackRunId" IS NULL`, [chatId]);
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
  controls: Readonly<{ mcp?: Readonly<{ mode: "load_all" }>; search?: SearchRoute; workspace?: Readonly<{ enabled: boolean }> }> = {}): Promise<SendAttempt> {
  const { search, ...others } = controls;
  const leaf = await activeLeaf(ctx, chatId);
  const known = new Set((await mainRuns(ctx.db, chatId)).map((entry) => entry.id));
  const abort = new AbortController();
  const response = await request(ctx.session.api, `/api/chats/${encodeURIComponent(chatId)}/messages`, { body: {
    content: { blocks: [{ text, type: "text" }, ...files] }, expectedActiveLeafId: leaf, ...runControls(search?.model ?? ctx.model), ...others,
    ...(search ? { searchPlan: { mode: search.mode, optionIds: [search.optionId] }, searchStrategy: undefined } : {})
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

const M_TURN_MS = 12 * 60_000;

/** Whether the report of the newest thread of that name holds every needle, matched inside SQL. */
async function reportHolds(db: PostgresClient, chatId: string, name: string, needles: readonly string[]): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(`SELECT coalesce(bool_and(strpos(t."result"->>'report', needle) > 0), false) AS "hit"
    FROM (SELECT tu."result" FROM "SubagentTurn" tu JOIN "SubagentThread" th ON th."id" = tu."threadId"
      WHERE tu."chatId" = $1 AND th."name" = $2 ORDER BY tu."startedAt" DESC LIMIT 1) t, unnest($3::text[]) AS needle`, [chatId, name, [...needles]]);
  return rows[0]?.hit === true;
}

/** Calls of a thread whose arguments name this text, matched inside SQL. */
async function callsNaming(db: PostgresClient, threadId: string | null, text: string): Promise<number> {
  if (threadId === null) return 0;
  const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "ModelRunToolCall"
    WHERE "subagentThreadId" = $1 AND strpos("arguments"::text, $2) > 0`, [threadId, text]);
  return rows[0]?.count ?? 0;
}

/** The mailbox rows of the chat: who each went to and whether it was read; their text stays in the database. */
async function messageRows(db: PostgresClient, chatId: string): Promise<MMessageRow[]> {
  const { rows } = await db.query<MMessageRow>(`SELECT f."origin"::text AS "origin", (f."deliveredAt" IS NOT NULL) AS "delivered", th."name" AS "recipient"
    FROM "RunFollowup" f LEFT JOIN "SubagentTurn" t ON t."id" = f."subagentTurnId" LEFT JOIN "SubagentThread" th ON th."id" = t."threadId"
    WHERE f."chatId" = $1 AND f."origin"::text IN ('main_agent', 'subagent_message')`, [chatId]);
  return rows;
}

/** Keeps reading the turn of that name until it is in `waiting`; the state and reason it last had, and whether it ever waited. */
async function waitForWaiting(ctx: Context, chatId: string, name: string, timeoutMs: number) {
  return poll(timeoutMs, async () => {
    const turn = await latestTurnOf(ctx.db, chatId, name);
    return turn?.state === "waiting" ? { reason: turn.reasonCode, state: turn.state } : null;
  }, "turn_not_waiting", 1_000).catch(async () => {
    const turn = await latestTurnOf(ctx.db, chatId, name);
    return { reason: turn?.reasonCode ?? null, state: turn?.state ?? null };
  });
}

async function scenarioM(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioMFacts(runSecrets(randomBytes(16)).nonce);
  const { asker, forger, front, hold, late, left, ping, pong, right, target, worker } = SUBAGENT_NAMES.talk;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario M");
  run.chats.push(chat.id);
  const started = Date.now();
  const step = async (prompt: string, ending: readonly string[]) => {
    const runId = await send(ctx, run, chat.id, prompt);
    const terminal = (await waitRun(ctx, runId)).status;
    await Promise.all(ending.map((name) => waitTurnEnded(ctx, chat.id, name, M_TURN_MS)));
    return terminal;
  };
  const terminals: Record<string, string> = {};
  terminals.remember = await step(SUBAGENT_PROMPTS.M.remember(facts), []);
  terminals.exchange = await step(SUBAGENT_PROMPTS.M.exchange(), [left, right]);
  terminals.neighbour = await step(SUBAGENT_PROMPTS.M.neighbour(facts), [late]);
  await waitTurnEnded(ctx, chat.id, worker, M_TURN_MS);

  const asked = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.M.askBackground());
  terminals.askBackground = (await waitRun(ctx, asked)).status;
  const waited = await waitForWaiting(ctx, chat.id, asker, M_TURN_MS);
  await waitTurnEnded(ctx, chat.id, asker, M_TURN_MS);
  terminals.askForeground = await step(SUBAGENT_PROMPTS.M.askForeground(), [front]);
  terminals.authority = await step(SUBAGENT_PROMPTS.M.authority(facts), [forger, target]);
  terminals.pingPong = await step(SUBAGENT_PROMPTS.M.pingPong(), [ping, pong]);

  terminals.hold = await step(SUBAGENT_PROMPTS.M.hold(), []);
  const holding = await waitForWaiting(ctx, chat.id, hold, M_TURN_MS);
  const holdThread = (await threadIdsByName(ctx.db, chat.id)).get(hold)?.at(-1);
  if (holdThread) await json(ctx.session.api, SUBAGENT_API_PATHS.stopThread(chat.id, holdThread), { body: {}, method: "POST" });
  const holdTurn = await waitTurnEnded(ctx, chat.id, hold, 120_000);

  const { settled, tools, turns, usage, wakeUps } = await commonEvidence(ctx, run, chat.id);
  const threads = await threadIdsByName(ctx.db, chat.id);
  const threadOf = (name: string) => threads.get(name)?.at(-1) ?? null;
  const turnsOf = (name: string) => turns.filter((turn) => turn.threadId === threadOf(name));
  const messages = agentMessageEvidence(await messageRows(ctx.db, chat.id));
  const both = [facts.halves.left, facts.halves.right];
  const verdict = oracleM({
    askBackground: { answered: await reportHolds(ctx.db, chat.id, asker, [facts.answer]), asked: agentToolEvidence(tools, threadOf(asker), "ask_parent"),
      sawWaiting: waited.state === "waiting", turn: turnsOf(asker).at(-1) ?? null, wakeUps: wakeUps.length },
    askForeground: { answered: await reportHolds(ctx.db, chat.id, front, [facts.foregroundAnswer]), turns: turnsOf(front) },
    authority: { forgedRead: (messages[target]?.read ?? 0) > 0, paymentCalls: await callsNaming(ctx.db, threadOf(target), facts.paymentFile),
      turn: turnsOf(target).at(-1) ?? null },
    exchange: { leftHoldsBoth: await reportHolds(ctx.db, chat.id, left, both), messages: Object.fromEntries(Object.entries(messages).filter(([name]) => name === left || name === right)),
      rightHoldsBoth: await reportHolds(ctx.db, chat.id, right, both),
      sent: [left, right].map((name) => agentToolEvidence(tools, threadOf(name), "send_agent_message")) },
    neighbour: { listed: agentToolEvidence(tools, threadOf(late), "list_agents"), namedWorker: await reportHolds(ctx.db, chat.id, late, [worker]),
      repeatedCalls: await callsNaming(ctx.db, threadOf(late), facts.workFile) },
    pingPong: { messages: Object.fromEntries(Object.entries(messages).filter(([name]) => name === ping || name === pong)),
      ping: agentToolEvidence(tools, threadOf(ping), "send_agent_message"), pong: agentToolEvidence(tools, threadOf(pong), "send_agent_message"),
      turns: [ping, pong].map((name) => turnsOf(name).at(-1) ?? null) },
    settled,
    stop: { reasonBefore: holding.reason, stateBefore: holding.state, turn: holdTurn }
  });
  const checks = [...verdict.failed];
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { checksFailed: checks, oracleCounts: verdict.counts, terminals, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

const P_TURN_MS = 6 * 60_000;

/** The user's messages to the chat's sub-agents: who each went to and whether that turn read it; their text stays in the database. */
async function userMessageRows(db: PostgresClient, chatId: string): Promise<Array<{ read: boolean; recipient: string | null }>> {
  const { rows } = await db.query<{ read: boolean; recipient: string | null }>(`SELECT (f."deliveredAt" IS NOT NULL) AS "read", th."name" AS "recipient"
    FROM "RunFollowup" f JOIN "SubagentTurn" t ON t."id" = f."subagentTurnId" JOIN "SubagentThread" th ON th."id" = t."threadId"
    WHERE f."chatId" = $1 AND f."origin"::text = 'user'`, [chatId]);
  return rows;
}

async function scenarioP(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioPFacts(runSecrets(randomBytes(16)).nonce);
  const name = SUBAGENT_NAMES.listener;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario P");
  run.chats.push(chat.id);
  const started = Date.now();
  const sent = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.P.start());
  // Its first command is running: the message lands in the middle of the turn and the next step takes it.
  const working = await poll(P_TURN_MS, async () => {
    const turn = await latestTurnOf(ctx.db, chat.id, name);
    if (turn?.state !== "running") return null;
    const calls = await toolRows(ctx.db, chat.id);
    return calls.some((call) => call.threadId === turn.threadId && call.toolName.includes("sandbox")) ? turn : null;
  }, "listener_not_working", 1_000);
  const reply = await json(ctx.session.api, `${SUBAGENT_API_PATHS.chatThreads(chat.id)}/${working.threadId}/messages`, {
    body: { nonce: randomBytes(16).toString("hex"), text: SUBAGENT_PROMPTS.P.message(facts), turnId: working.turnId }, method: "POST" });
  const terminal = (await waitRun(ctx, sent)).status;
  const turn = await waitTurnEnded(ctx, chat.id, name, P_TURN_MS);
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  const rows = (await userMessageRows(ctx.db, chat.id)).filter((row) => row.recipient === name);
  const { rows: inChat } = await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "Message"
    WHERE "chatId" = $1 AND strpos("content"::text, $2) > 0`, [chat.id, facts.note]);
  const verdict = oracleP({ accepted: (reply as { accepted?: unknown } | null)?.accepted === true, mainChatHoldsNote: (inChat[0]?.count ?? 0) > 0,
    messages: { read: rows.filter((row) => row.read).length, taken: rows.length }, reportHoldsWord: await reportHolds(ctx.db, chat.id, name, [facts.word]),
    settled, turn });
  const checks = [...verdict.failed];
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { checksFailed: checks, oracleCounts: verdict.counts, terminals: { start: terminal }, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
}

/** The page reader's calls of one thread or of the main agent, by the outcome stored with each. */
async function pageReads(db: PostgresClient, chatId: string, threadId: string | null): Promise<PageReads> {
  const { rows } = await db.query<{ count: number; outcome: string | null }>(`SELECT c."result"->'rawPreview'->'fetchUrl'->>'outcome' AS "outcome", count(*)::int AS "count"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
    WHERE r."chatId" = $1 AND c."toolName" = 'fetch_url' AND c."subagentThreadId" IS NOT DISTINCT FROM $2 GROUP BY 1`, [chatId, threadId]);
  return Object.fromEntries(rows.map((row) => [safeCode(row.outcome) ?? "unknown", row.count]));
}

const Q_TURN_MS = 15 * 60_000;

async function scenarioQ(ctx: Context, run: Run): Promise<Outcome> {
  const started = Date.now();
  const routes: Record<string, unknown>[] = [];
  let failed = false;
  let usage: Outcome["usage"] = null;
  for (const route of ctx.search) {
    const chat = await createScenarioChat(ctx.session.api, `Sub-agent scenario Q ${route.name}`);
    run.chats.push(chat.id);
    const first = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.Q.start(), [], { search: route });
    if (!first.ok) fail(`send_${first.code}`);
    await waitRun(ctx, first.ok ? first.runId : "");
    const turn = await waitTurnEnded(ctx, chat.id, SUBAGENT_NAMES.reader, Q_TURN_MS);
    await waitMainIdle(ctx, chat.id);
    const second = await trySend(ctx, run, chat.id, SUBAGENT_PROMPTS.Q.next(), [], { search: route });
    if (!second.ok) fail(`send_${second.code}`);
    const terminal = await waitRun(ctx, second.ok ? second.runId : "");
    const evidence = await commonEvidence(ctx, run, chat.id);
    usage = evidence.usage;
    const threadId = (await threadIdsByName(ctx.db, chat.id)).get(SUBAGENT_NAMES.reader)?.at(-1) ?? null;
    const tools = await toolRows(ctx.db, chat.id);
    const verdict = oracleQ({ main: await pageReads(ctx.db, chat.id, null), reader: threadId ? await pageReads(ctx.db, chat.id, threadId) : {},
      searches: route.mode === "model_choice" ? null
        : tools.filter((row) => row.threadId === threadId && row.state === "complete" && /^search_(?:selected_engines|engine_[1-3])$/u.test(row.toolName)).length,
      settled: evidence.settled, turn });
    if (verdict.failed.length > 0) failed = true;
    routes.push({ checksFailed: verdict.failed, oracleCounts: verdict.counts, route: route.name, terminal: terminal.status });
  }
  Object.assign(run.line, { routes, wallSeconds: seconds(started) });
  return { success: !failed && routes.length > 0, usage };
}

const R_PHRASE_MS = 5 * 60_000;

async function scenarioR(ctx: Context, run: Run): Promise<Outcome> {
  const started = Date.now();
  const route = ctx.search[0] ?? fail("search_route_missing");
  const results: RPhraseResult[] = [];
  for (const [index, phrase] of SCENARIO_R_PHRASES.entries()) {
    const chat = await createScenarioChat(ctx.session.api, `Sub-agent scenario R ${index}`);
    run.chats.push(chat.id);
    // Started, or the run ended without starting: either answers this phrase.
    const outcome = async (runId: string) => {
      const reached = await poll(R_PHRASE_MS, async () => {
        const { rows } = await ctx.db.query<{ calls: number; started: number; status: string }>(`SELECT r."status"::text AS "status",
          (SELECT count(*)::int FROM "ModelRunToolCall" c WHERE c."modelRunId" = r."id") AS "calls",
          (SELECT count(*)::int FROM "ModelRunToolCall" c WHERE c."modelRunId" = r."id" AND c."toolName" = 'start_research') AS "started" FROM "ModelRun" r WHERE r."id" = $1`, [runId]);
        const row = rows[0];
        if ((row?.started ?? 0) > 0) return "started" as const;
        return row && TERMINAL_RUN_STATES.has(row.status) ? row.calls === 0 ? "no_tools" as const : "ended" as const : null;
      }, "phrase_timeout", 1_000);
      if (reached === "started") await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, method: "POST" }).catch(() => undefined);
      return { reached, terminal: await waitRun(ctx, runId, R_PHRASE_MS) };
    };
    const sent = await trySend(ctx, run, chat.id, phrase.text, [], { search: route });
    if (!sent.ok) fail(`send_${sent.code}`);
    let reached = await outcome(sent.ok ? sent.runId : "");
    let askedFirst = false;
    // A request this open may get a question first: what counts then is that the user's answer starts research.
    if (reached.reached === "no_tools" && phrase.reply) {
      await waitMainIdle(ctx, chat.id, R_PHRASE_MS);
      const replied = await trySend(ctx, run, chat.id, phrase.reply, [], { search: route });
      if (!replied.ok) fail(`send_${replied.code}`);
      reached = await outcome(replied.ok ? replied.runId : "");
      askedFirst = reached.reached === "started";
    }
    results.push({ ...(askedFirst ? { askedFirst } : {}), expected: phrase.start, index, started: reached.reached === "started", status: reached.terminal.status });
    await waitMainIdle(ctx, chat.id, R_PHRASE_MS);
  }
  const verdict = oracleR(results);
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  Object.assign(run.line, { checksFailed: verdict.failed, oracleCounts: verdict.counts, phrases: results, route: route.name, wallSeconds: seconds(started) });
  return { success: verdict.failed.length === 0, usage };
}

/** A chat's answers for reading by hand: a file of the operator's own choosing, never output. S's answers mask the saved password (`passwordInAnswer` checks that). */
async function keepAnswers(ctx: Context, chatId: string, label: string, redact: readonly string[] = []): Promise<void> {
  const file = process.env.AIQSA_SUBAGENTS_ANSWERS_FILE;
  if (!file) return;
  const { rows } = await ctx.db.query<{ content: unknown }>(`SELECT m."content" FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId"
    WHERE r."chatId" = $1 AND r."subagentTurnId" IS NULL ORDER BY r."createdAt"`, [chatId]);
  const text = rows.map((row) => (row.content as { blocks?: { text?: string }[] } | null)?.blocks?.map((block) => block.text ?? "").join("\n") ?? "").join("\n\n---\n\n");
  const clean = redact.reduce((value, secret) => value.split(secret).join("[proxy]"), text);
  appendFileSync(file, `\n\n===== ${label} =====\n\n${clean}\n`, { mode: 0o600 });
}

const S_TURN_MS = 12 * 60_000;

async function resultsHold(db: PostgresClient, chatId: string, toolLike: string, urlPart: string, needle: string): Promise<boolean> {
  const { rows } = await db.query<{ hit: boolean }>(`SELECT coalesce(bool_or(strpos(c."result"::text, $4) > 0), false) AS "hit" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
    WHERE r."chatId" = $1 AND c."toolName" LIKE $2 AND strpos(c."arguments"::text, $3) > 0`, [chatId, toolLike, urlPart, needle]);
  return rows[0]?.hit === true;
}

async function fetchCodes(db: PostgresClient, chatId: string): Promise<string[]> {
  const { rows } = await db.query<{ code: string | null }>(`SELECT coalesce(c."result"->'rawPreview'->'fetchUrl'->>'proxyCode', c."result"->'rawPreview'->'fetchUrl'->>'outcome') AS "code"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1 AND c."toolName" = 'fetch_url'`, [chatId]);
  return [...new Set(rows.flatMap((row) => { const code = safeCode(row.code); return code ? [code] : []; }))];
}

async function scenarioS(ctx: Context, run: Run): Promise<Outcome> {
  const proxy = parseTestProxy(process.env.AIQSA_SUBAGENTS_TEST_PROXY) ?? fail("test_proxy_required");
  const started = Date.now();
  const terminals: Record<string, string> = {};
  const step = async (name: string, text: string) => {
    const chat = await createScenarioChat(ctx.session.api, `Proxy scenario ${name}`);
    run.chats.push(chat.id);
    const sent = await trySend(ctx, run, chat.id, text);
    if (!sent.ok) fail(`send_${sent.code}`);
    terminals[name] = (await waitRun(ctx, sent.ok ? sent.runId : "", S_TURN_MS)).status;
    await waitMainIdle(ctx, chat.id, S_TURN_MS);
    // The proxy's address and login may be repeated in an answer, and they leave nowhere.
    await keepAnswers(ctx, chat.id, `S ${name}`, [proxy.url, proxy.password, proxy.login, proxy.host]);
    return chat.id;
  };
  const saveChat = await step("save", SCENARIO_S_PROMPTS.save(proxy.url));
  const { rows: saved } = await ctx.db.query<{ active: boolean; exitIsProxy: boolean; hint: boolean; id: string; ok: boolean; sealed: boolean; version: number }>(`SELECT p."id", p."active", p."version",
      '.ru' = ANY(p."domainHints") AS "hint", p."lastCheckStatus" = 'ok' AS "ok", p."lastExitAddress" = $2 AS "exitIsProxy", p."passwordEnvelope" IS NOT NULL AS "sealed"
    FROM "NetworkProxy" p WHERE lower(p."name") = $1`, [SCENARIO_S_NAME, proxy.host]);
  const row = saved[0];
  const { rows: inAnswer } = await ctx.db.query<{ hit: boolean }>(`SELECT coalesce(bool_or(strpos(m."content"::text, $2) > 0), false) AS "hit" FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId" WHERE r."chatId" = $1`, [saveChat, proxy.password]);
  const browseChat = await step("browse", SCENARIO_S_PROMPTS.browse());
  const readChat = await step("read", SCENARIO_S_PROMPTS.read());
  const { rows: through } = await ctx.db.query<{ count: number }>(`SELECT count(*)::int AS "count" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId"
    WHERE r."chatId" = $1 AND c."toolName" = 'fetch_url' AND c."result"->'rawPreview'->'fetchUrl'->'proxy'->>'name' = $2 AND c."result"->'rawPreview'->'fetchUrl'->>'outcome' = 'read'`, [readChat, SCENARIO_S_NAME]);
  // A dead proxy: the same host on a port nothing listens on, hinted for one echo site.
  await json(ctx.session.api, "/api/me/proxies", { body: { domainHints: [SCENARIO_S_DEAD_HINT], host: proxy.host, login: proxy.login, name: SCENARIO_S_DEAD_NAME, password: proxy.password, port: 1, protocol: "http" }, method: "POST" });
  const deadChat = await step("dead", SCENARIO_S_PROMPTS.dead());
  const { rows: deadRows } = await ctx.db.query<{ direct: boolean; failed: boolean }>(`SELECT
      coalesce(bool_or(c."result"::text ~ '[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}'), false) AS "direct",
      coalesce(bool_or(c."toolName" LIKE 'mcp_workspace%' AND strpos(c."result"::text, 'proxy_') > 0), false) AS "failed"
    FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1 AND strpos(c."arguments"::text, $2) > 0`, [deadChat, SCENARIO_S_DEAD_HINT]);
  // Switched off: naming it is refused. The route takes the version it last read.
  if (row) await json(ctx.session.api, `/api/me/proxies/${encodeURIComponent(row.id)}`, { body: { active: false, expectedVersion: (await ctx.db.query<{ version: number }>(`SELECT "version" FROM "NetworkProxy" WHERE "id" = $1`, [row.id])).rows[0]?.version }, method: "PATCH" });
  const offChat = await step("off", SCENARIO_S_PROMPTS.off());
  const verdict = oracleS({ browserHintExit: await resultsHold(ctx.db, browseChat, "mcp_workspace%", "2ip.ru", proxy.host), browserNamedExit: await resultsHold(ctx.db, browseChat, "mcp_workspace%", "ipify", proxy.host),
    checkOk: row?.ok === true, deadBrowserFailed: deadRows[0]?.failed === true, deadFetchCodes: await fetchCodes(ctx.db, deadChat), deadWentDirect: deadRows[0]?.direct === true, exitIsProxy: row?.exitIsProxy === true,
    fetchExit: await resultsHold(ctx.db, readChat, "fetch_url", "ipify", proxy.host), fetchThroughProxy: through[0]?.count ?? 0, hintSaved: row?.hint === true, offFetchCodes: await fetchCodes(ctx.db, offChat),
    passwordInAnswer: inAnswer[0]?.hit === true, saved: row?.sealed === true, terminals });
  const usage = usageByPurpose(await settledUsage(ctx.db, run.chats));
  for (const stored of (await ctx.db.query<{ id: string; version: number }>(`SELECT "id", "version" FROM "NetworkProxy"`)).rows) {
    await request(ctx.session.api, `/api/me/proxies/${encodeURIComponent(stored.id)}`, { body: { expectedVersion: stored.version }, method: "DELETE" }).catch(() => undefined);
  }
  Object.assign(run.line, { checksFailed: verdict.failed, deadFetchCodes: await fetchCodes(ctx.db, deadChat), oracleCounts: verdict.counts, offFetchCodes: await fetchCodes(ctx.db, offChat), terminals, wallSeconds: seconds(started) });
  return { success: verdict.failed.length === 0, usage };
}

const T_QUESTION_MS = 75 * 60_000;

async function scenarioT(ctx: Context, run: Run): Promise<Outcome> {
  const route = ctx.search[0] ?? fail("search_route_missing");
  const kinds = process.env.AIQSA_SUBAGENTS_T_KINDS?.split(",").map((kind) => kind.trim()).filter(Boolean);
  const questions: Record<string, unknown>[] = [];
  let failed = false;
  for (const question of SCENARIO_T_QUESTIONS.filter((entry) => !kinds || kinds.includes(entry.kind))) {
    const started = Date.now();
    const chat = await createScenarioChat(ctx.session.api, `Research scenario ${question.kind}`);
    run.chats.push(chat.id);
    const sent = await trySend(ctx, run, chat.id, question.text, [], { search: route });
    if (!sent.ok) fail(`send_${sent.code}`);
    const terminal = await waitRun(ctx, sent.ok ? sent.runId : "", T_QUESTION_MS);
    await waitMainIdle(ctx, chat.id, T_QUESTION_MS);
    const { rows: calls } = await ctx.db.query<{ arguments: Record<string, unknown> | null; result: Record<string, unknown> | null; threadId: string | null; toolName: string }>(`SELECT c."arguments", c."result",
        c."subagentThreadId" AS "threadId", c."toolName" FROM "ModelRunToolCall" c JOIN "ModelRun" r ON r."id" = c."modelRunId" WHERE r."chatId" = $1 ORDER BY c."startedAt"`, [chat.id]);
    const count = (name: string) => calls.filter((call) => call.toolName === name).length;
    const drafts: TDraftFinding[][] = calls.filter((call) => call.toolName === "submit_research_draft" && call.arguments).map((call) => ((call.arguments!.findings ?? []) as Record<string, unknown>[]).map((finding) => ({
      claim: String(finding.claim ?? ""), quote: String(finding.quote ?? ""), sourceClass: String(finding.source_class ?? ""), url: String(finding.url ?? "") })));
    const opened = new Set(calls.filter((call) => call.toolName === "fetch_url" && (call.result?.rawPreview as { fetchUrl?: { outcome?: string } } | undefined)?.fetchUrl?.outcome === "read")
      .flatMap((call) => typeof call.arguments?.url === "string" ? [call.arguments.url] : []));
    for (const call of calls) {
      if (!call.toolName.startsWith("mcp_workspace") || !call.arguments || !JSON.stringify(call.arguments).includes("aiqsa-browser")) continue;
      for (const match of JSON.stringify(call.arguments).matchAll(/https?:\/\/[^\s"'\\]+/gu)) opened.add(match[0]);
    }
    const turns = await turnRows(ctx.db, chat.id);
    const names = await threadIdsByName(ctx.db, chat.id);
    const gateThreads = new Set([...names.entries()].filter(([name]) => /^(?:gap-judge|verifier)-/u.test(name)).flatMap(([, ids]) => ids));
    const researcherTurns = turns.filter((turn) => !gateThreads.has(turn.threadId)).length;
    const sentBack = calls.filter((call) => call.toolName === "submit_research_draft" && JSON.stringify(call.result ?? "").includes("sent_back")).length;
    const metrics = researchMetrics({ drafts, opened, researcherTurns, sentBack, started: count("start_research") > 0 });
    const { rows: answers } = await ctx.db.query<{ note: string | null; text: string | null }>(`SELECT m."content"::text AS "text", NULL AS "note" FROM "ModelRun" r JOIN "Message" m ON m."id" = r."assistantMessageId"
      WHERE r."id" = $1`, [sent.ok ? sent.runId : ""]);
    const answer = answers[0]?.text ?? "";
    // The check's sentences are the server's own words (`verifier.ts`, `notes.ts`), so they may leave; nothing else of the answer does.
    const serverNotes = [...answer.matchAll(/\*((?:Проверено|Independently checked|Checked by|Проверил|Проверка|Одну из проверок|The check|Не удалось|Source could|Время вышло|Time ran out|Отчёт пришёл|This report came|Research ended|Исследование завершилось)[^*]{0,400})\*/gu)].map((match) => match[1]);
    await keepAnswers(ctx, chat.id, `T ${question.kind}`);
    const usage = usageByPurpose(await settledUsage(ctx.db, [chat.id]));
    questions.push({ gateTurns: turns.length - researcherTurns, kind: question.kind, metrics, searches: calls.filter((call) => /^search_(?:selected_engines|engine_[1-3])$/u.test(call.toolName)).length,
      fetchCalls: count("fetch_url"), serverNotes, terminal: terminal.status, tokens: usage.total, wallSeconds: seconds(started) });
    emit({ stage: "research_question", ...questions.at(-1) });
    if (terminal.status !== "complete" || !metrics.started || (question.kind === "purchase" && metrics.independentOpened === 0)) failed = true;
  }
  Object.assign(run.line, { questions });
  return { success: !failed && questions.length > 0, usage: usageByPurpose(await settledUsage(ctx.db, run.chats)) };
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

const O_TURN_MS = 15 * 60_000;
const O_STOP_MS = 3 * 60_000;

/** What the chat's thread list says started each sub-agent: what the tree nests it under. */
async function threadParents(ctx: Context, chatId: string): Promise<Record<string, string | null>> {
  const listed = decodeSubagentChatThreads(await json(ctx.session.api, SUBAGENT_API_PATHS.chatThreads(chatId))) ?? fail("threads_response_invalid");
  return Object.fromEntries(listed.threads.map((thread) => [thread.name, thread.parent?.name ?? null]));
}

/** The admin and personal routes `registerBulkResultMcpServer` drives, on this harness's session. */
function mcpClient(api: Api): BulkRegistrationClient {
  const call = (method: string) => async (path: string, init?: Readonly<{ data: unknown }>) => {
    const response = await request(api, path, { ...(init ? { body: init.data } : {}), method });
    return { json: () => response.json() as Promise<unknown>, ok: () => response.ok, status: () => response.status };
  };
  return { delete: call("DELETE"), patch: call("PATCH"), post: call("POST"), put: call("PUT") };
}

/**
 * O's last step: a call a helper may not make climbs to the main agent's card, and only the Allow sends it. The server is
 * this harness's own, so `dispatches` counts what reached it, and it goes when the step ends.
 */
async function approvalStep(ctx: Context, run: Run, chatId: string, facts: ScenarioOFacts): Promise<OEvidence["approval"]> {
  const { approver, clerk } = SUBAGENT_NAMES.nest;
  const none = { approvalsOnMainRun: 0, childTurn: null, dispatchedAfterAllow: 0, dispatchedBeforeAllow: 0, parentTurn: null };
  const records = createWriteApprovalFixture();
  const host = process.env.AIQSA_SUBAGENTS_FIXTURE_HOST?.trim() || "127.0.0.1";
  const publicHost = process.env.AIQSA_SUBAGENTS_FIXTURE_PUBLIC_HOST?.trim() || host;
  const endpoint = await startMutableMcpEndpoint(records.tools, { callTool: records.callTool, host, publicHost });
  let serverId: string | null = null;
  try {
    const { rows } = await ctx.db.query<{ userId: string }>(`SELECT "userId" FROM "Chat" WHERE "id" = $1`, [chatId]);
    const userId = rows[0]?.userId ?? fail("chat_owner_missing");
    serverId = await registerBulkResultMcpServer(mcpClient(ctx.session.api), { endpointUrl: endpoint.url, name: `Sub-agent records ${randomUUID().slice(0, 8)}`, userId });
    await waitMainIdle(ctx, chatId);
    const sent = await trySend(ctx, run, chatId, SUBAGENT_PROMPTS.O.approval(facts), [], { mcp: { mode: "load_all" } });
    if (!sent.ok) return { ...none, unavailable: stableCode(sent.code) };
    await waitRun(ctx, sent.runId);
    const deletion = { id: facts.recordId };
    const card = await poll(O_TURN_MS, async () => {
      const found = await ctx.db.query<{ id: string; modelRunId: string; onMain: boolean }>(`SELECT a."id", a."modelRunId", (r."subagentTurnId" IS NULL) AS "onMain"
        FROM "McpToolApproval" a JOIN "ModelRun" r ON r."id" = a."modelRunId" WHERE a."chatId" = $1 AND a."decision" IS NULL ORDER BY a."createdAt" DESC`, [chatId]);
      return found.rows.length > 0 ? found.rows : null;
    }, "approval_card_missing", 3_000).catch(() => []);
    const dispatchedBeforeAllow = endpoint.dispatches("delete_record", deletion);
    const threads = await threadIdsByName(ctx.db, chatId);
    const turns = await turnRows(ctx.db, chatId);
    const firstTurn = (name: string) => turns.find((turn) => turn.threadId === threads.get(name)?.at(-1)) ?? null;
    const approvalsOnMainRun = card.filter((row) => row.onMain).length;
    const [pending] = card;
    if (pending) {
      await json(ctx.session.api, `/api/model-runs/${encodeURIComponent(pending.modelRunId)}/mcp-approvals/${encodeURIComponent(pending.id)}`, {
        body: { decision: "allow_once", nonce: randomUUID() }, method: "POST" });
      await poll(O_TURN_MS, async () => endpoint.dispatches("delete_record", deletion) > 0 ? true : null, "approved_call_not_sent", 3_000).catch(() => false);
      await waitMainIdle(ctx, chatId);
    }
    return { approvalsOnMainRun, childTurn: firstTurn(approver), dispatchedAfterAllow: endpoint.dispatches("delete_record", deletion), dispatchedBeforeAllow,
      parentTurn: firstTurn(clerk), unavailable: null };
  } catch (error) {
    return { ...none, unavailable: error instanceof Error ? stableCode(error.message) : "approval_step_failed" };
  } finally {
    if (serverId) await request(ctx.session.api, `/api/admin/mcp/${encodeURIComponent(serverId)}`, { method: "DELETE" }).catch(() => undefined);
    await endpoint.close().catch(() => undefined);
  }
}

async function scenarioO(ctx: Context, run: Run): Promise<Outcome> {
  const facts = scenarioOFacts(runSecrets(randomBytes(16)).nonce);
  const { deep, deeper, first, holder, inner, lead, left, right, second, side, third } = SUBAGENT_NAMES.nest;
  const chat = await createScenarioChat(ctx.session.api, "Sub-agent scenario O");
  run.chats.push(chat.id);
  const started = Date.now();
  const threadOf = async (name: string) => (await threadIdsByName(ctx.db, chat.id)).get(name)?.at(-1) ?? null;
  const step = async (prompt: string) => (await waitRun(ctx, await send(ctx, run, chat.id, prompt))).status;
  const terminals: Record<string, string> = {};

  terminals.reports = await step(SUBAGENT_PROMPTS.O.reports(facts));
  const reports: OEvidence["reports"] = { children: await Promise.all([left, right].map((name) => latestTurnOf(ctx.db, chat.id, name))),
    leadHoldsBoth: await reportHolds(ctx.db, chat.id, lead, [facts.expected.left, facts.expected.right]) };

  terminals.limit = await step(SUBAGENT_PROMPTS.O.limit());
  const leadTurn = await waitTurnEnded(ctx, chat.id, lead, O_TURN_MS);
  const asked = await toolRows(ctx.db, chat.id);
  const limitCalls = asked.filter((row) => row.turnId === leadTurn?.turnId && row.toolName === "call_subagent");
  const children = await Promise.all([first, second, third].map((name) => latestTurnOf(ctx.db, chat.id, name)));
  const endTime = (turn: TurnRow | null) => turn?.endedAt ? new Date(turn.endedAt).getTime() : Number.POSITIVE_INFINITY;
  const limit: OEvidence["limit"] = { calls: limitCalls.length, children,
    leadEndedLast: children.every((turn) => turn === null || endTime(turn) <= endTime(leadTurn)),
    leadNamedCode: await reportHolds(ctx.db, chat.id, lead, ["subagent_child_limit_reached"]),
    refused: limitCalls.filter((row) => row.resultCode === "subagent_child_limit_reached").length };

  terminals.depth = await step(SUBAGENT_PROMPTS.O.depth());
  const deepThread = await threadOf(deep);
  const depth: OEvidence["depth"] = { grandchildren: (await threadIdsByName(ctx.db, chat.id)).get(deeper)?.length ?? 0,
    refused: (await toolRows(ctx.db, chat.id)).filter((row) => row.threadId === deepThread && row.resultCode === "subagent_depth_limit_reached").length };

  const stopRun = await send(ctx, run, chat.id, SUBAGENT_PROMPTS.O.stop());
  const running = await poll(O_TURN_MS, async () => {
    const threads = await threadIdsByName(ctx.db, chat.id);
    const [turns, tools] = [await turnRows(ctx.db, chat.id), await toolRows(ctx.db, chat.id)];
    const id = (name: string) => threads.get(name)?.at(-1);
    return [holder, inner, side].every((name) => turns.some((turn) => turn.threadId === id(name) && turn.state === "running")) &&
      [inner, side].every((name) => tools.some((tool) => tool.threadId === id(name) && tool.state === "running")) ? true : null;
  }, "levels_not_running", 3_000).catch(() => false);
  const stoppedAt = Date.now();
  await request(ctx.session.api, `/api/model-runs/${encodeURIComponent(stopRun)}/cancel`, { body: {}, method: "POST" });
  terminals.stop = (await waitRun(ctx, stopRun)).status;
  const stopTurns = await Promise.all([holder, inner, side].map((name) => waitTurnEnded(ctx, chat.id, name, O_STOP_MS)));
  const stop: OEvidence["stop"] = { running, secondsToEnd: seconds(stoppedAt), turns: stopTurns };

  const approval = await approvalStep(ctx, run, chat.id, facts);
  const { settled, usage } = await commonEvidence(ctx, run, chat.id);
  const verdict = oracleO({ approval, depth, limit, parents: await threadParents(ctx, chat.id), reports, settled, stop });
  const checks = [...verdict.failed];
  if (!usage.split) checks.push("usage_not_split");
  Object.assign(run.line, { approvalUnavailable: approval.unavailable, checksFailed: checks, oracleCounts: verdict.counts, terminals, wallSeconds: seconds(started) });
  return { success: checks.length === 0, usage };
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
      case "M": outcome = await scenarioM(ctx, run); break;
      case "N": outcome = await scenarioN(ctx, run); break;
      case "O": outcome = await scenarioO(ctx, run); break;
      case "P": outcome = await scenarioP(ctx, run); break;
      case "Q": outcome = await scenarioQ(ctx, run); break;
      case "R": outcome = await scenarioR(ctx, run); break;
      case "S": outcome = await scenarioS(ctx, run); break;
      case "T": outcome = await scenarioT(ctx, run); break;
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
    // Q and R search for real: the DeepSeek client route always, and the codex-lb hosted route when its model offers one.
    const search: SearchRoute[] = [];
    if (scenarios.some((id) => SUBAGENT_SCENARIO_NEEDS[id].search)) {
      const client = await ensureSearchSource(api, { kind: "deepseek_search_api", provider: "deepseek", secret: process.env.DEEPSEEK_API_KEY ?? fail("deepseek_key_required") });
      search.push({ mode: "all_selected", model, name: "client", optionId: client });
      if (process.env.AIQSA_SUBAGENTS_HOSTED_SEARCH === "1") {
        const hostedModel = await ensureModel(api, { apiRoot: route.apiRoot, model: route.model }, secret, "Sub-agents hosted search model", { nativeSearch: true });
        const hosted = await ensureSearchSource(api, { connectionId: hostedModel.connectionId, kind: "web_search" });
        search.push({ mode: "model_choice", model: await catalogModel(api, hostedModel), name: "hosted", optionId: hosted });
      }
    }
    if (scenarios.includes("T") && process.env.AIQSA_SUBAGENTS_VERIFIER_FAMILY) await ensureResearchVerifier(api, process.env.AIQSA_SUBAGENTS_VERIFIER_FAMILY);
    emit({ stage: "ready", label, project: target.project, provider: "codex-lb", model: route.model, contextWindow: chatProvider.contextWindow,
      reused: chatProvider.reused, secondModel: second !== null, modelWithoutVision: blind !== null, restartHook: options.restart !== null,
      configuredBounds: target.configuredBounds, scenarios, runs: options.runs });
    const ctx: Context = { blind, db, keepChats: process.env.AIQSA_SUBAGENTS_KEEP_CHATS === "1", marginSeconds, model, options, search, second,
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
