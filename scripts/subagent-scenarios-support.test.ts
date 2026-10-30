import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_RESULT_FILE, BROWSER_SCENARIOS, SAUCEDEMO_LOGIN_VALUES, checkBrowserResult } from "./browser-scenarios-support";
import {
  DEFAULT_SUBAGENT_SCENARIO_IDS, S6_BASELINE, SIDE_QUESTION, SUBAGENT_NAMES, SUBAGENT_PROMPTS, SUBAGENT_SCENARIO_IDS, appendProgression,
  bindingEvidence, browserEvidence, callSubagentOutcomes, callbackEvidence, cleanUpScenario, failedToolCalls, notaryValue, stableCode,
  stopSubagentCalls, oracleA, oracleB, oracleC, oracleD, oracleE,
  oracleFBranched, oracleFContinued, oracleH, oracleI, peakConcurrency, peakConcurrentTurns, progressionSaw, requestedModelEvidence,
  restartEvidence, roundsPerAgent, runSecrets, s6BaselineRows, selectedSubagentScenarios, stateCounts, stopChecks, stopEvidence,
  subagentCallEvidence, subagentHarnessOptions, subagentScenarioSummary, turnOutcomes, usageByPurpose,
  type ToolRow, type TurnRow, type WakeUpRow
} from "./subagent-scenarios-support";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 30, 12, 0, seconds));
const ms = (seconds: number) => at(seconds).getTime();

function turn(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    callbackRunId: null, effortSource: "parent", endedAt: at(60), executionRunId: null, mode: "foreground", modelId: "gpt-upstream",
    modelSource: "parent", outcome: "done", parentEffort: "medium", parentModelId: "gpt-upstream", parentProvider: "connection-1",
    parentRunId: "run-1", provider: "connection-1", providerModelId: "catalog-model", reasonCode: null, reasoningEffort: "medium",
    startedAt: at(0), state: "done", threadId: "thread-1", turnId: "turn-1", ...overrides
  };
}

function tool(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    backgroundRefused: false, browser: false, busy: false, completedAt: at(10), memoryLow: false, resultCode: null, resultReason: null,
    roundIndex: 1, runId: "run-1", startedAt: at(0), state: "complete", stopTarget: null, threadId: null, toolName: "call_subagent",
    turnId: null, ...overrides
  };
}

const base = { blocked: [], status: "completed" };
const secrets = runSecrets(new Uint8Array(Array.from({ length: 16 }, (_, index) => index * 17)));

describe("sub-agent scenario selection and options", () => {
  it("runs the cheap scenarios by default and names the others explicitly", () => {
    expect(selectedSubagentScenarios(undefined)).toEqual([...DEFAULT_SUBAGENT_SCENARIO_IDS]);
    expect(selectedSubagentScenarios(" g, c2 ,A")).toEqual(["A", "C2", "G"]);
    for (const raw of ["Z", "A,A", ","]) expect(() => selectedSubagentScenarios(raw)).toThrow("browser_scenarios_scenarios_invalid");
    expect(SUBAGENT_SCENARIO_IDS).toHaveLength(11);
  });

  it("refuses a selected scenario whose second model or restart hook is missing before any setup", () => {
    expect(() => subagentHarnessOptions({}, ["C2"], "gpt-6-astra")).toThrow("second_model_required");
    expect(() => subagentHarnessOptions({}, ["G"], "gpt-6-astra")).toThrow("restart_command_required");
    expect(() => subagentHarnessOptions({ AIQSA_SUBAGENTS_SECOND_MODEL: "gpt-6-astra" }, ["C2"], "gpt-6-astra"))
      .toThrow("second_model_is_parent");
    expect(() => subagentHarnessOptions({ AIQSA_SUBAGENTS_SECOND_MODEL: "bad model" }, ["A"], "gpt-6-astra")).toThrow("second_model_invalid");
    expect(() => subagentHarnessOptions({ AIQSA_SUBAGENTS_RESTART_COMMAND: "a\nb" }, ["A"], "m")).toThrow("restart_command_invalid");
    expect(() => subagentHarnessOptions({ AIQSA_SUBAGENTS_RUNS: "4" }, ["A"], "m")).toThrow("runs_invalid");
    expect(subagentHarnessOptions({ AIQSA_SUBAGENTS_RESTART_COMMAND: " ssh stand restart ", AIQSA_SUBAGENTS_RESTART_TIMEOUT_SECONDS: "60",
      AIQSA_SUBAGENTS_SECOND_MODEL: "gpt-6-luna" }, ["C2", "G"], "gpt-6-astra")).toEqual({
      restart: { command: "ssh stand restart", timeoutMs: 60_000 }, runs: 1, secondModel: "gpt-6-luna" });
  });
});

describe("per-run secrets and prompts", () => {
  it("derives two distinct correction words and a nonce, and the value only the sub-agent computes", () => {
    expect(secrets.correctionFrom).not.toBe(secrets.correctionTo);
    expect(secrets.correctionFrom).toMatch(/^[A-Z]+-[0-9A-F]{4}$/u);
    expect(secrets.nonce).toMatch(/^[0-9a-f]{16}$/u);
    for (let first = 0; first < 8; first += 1) {
      for (let second = 0; second < 8; second += 1) {
        const bytes = new Uint8Array(16);
        bytes[0] = first;
        bytes[1] = second;
        const words = runSecrets(bytes);
        expect(words.correctionFrom.split("-")[0]).not.toBe(words.correctionTo.split("-")[0]);
      }
    }
    expect(() => runSecrets(new Uint8Array(8))).toThrow("secrets_bytes_short");
    expect(notaryValue("abc")).toBe(createHash("sha256").update("abc").digest("hex").slice(0, 12));
  });

  it("fixes the sub-agent names the later steps address and asks every answer for the result file", () => {
    expect(SUBAGENT_PROMPTS.B()).toContain(SUBAGENT_NAMES.background.join(", "));
    expect(SUBAGENT_PROMPTS.E.start(secrets)).toContain(secrets.correctionFrom);
    expect(SUBAGENT_PROMPTS.E.correction(secrets)).toContain(secrets.correctionTo);
    // Long work as many short commands: one long command hits the Workspace tool's timeout.
    expect(SUBAGENT_PROMPTS.E.start(secrets)).toContain("15 минут подряд выполняет в Workspace команду `sleep 60`");
    expect(SUBAGENT_PROMPTS.E.start(secrets)).not.toContain("sleep 900");
    expect(SUBAGENT_PROMPTS.E.holds()).toContain(SUBAGENT_NAMES.hold.join(" и "));
    expect(SUBAGENT_PROMPTS.E.holds()).toContain("10 минут подряд");
    expect(SUBAGENT_PROMPTS.F.start(secrets)).toContain(secrets.nonce);
    expect(SUBAGENT_PROMPTS.F.start(secrets)).not.toContain(notaryValue(secrets.nonce));
    expect(SUBAGENT_PROMPTS.C("gpt-6-luna")).toContain("gpt-6-luna");
    expect(SUBAGENT_PROMPTS.C(null)).toContain(BROWSER_SCENARIOS.S6.prompt);
    expect(SUBAGENT_PROMPTS.D(false)).toContain("без суб-агентов");
    for (const prompt of [SUBAGENT_PROMPTS.A(), SUBAGENT_PROMPTS.B(), SUBAGENT_PROMPTS.D(true), SUBAGENT_PROMPTS.E.start(secrets),
      SUBAGENT_PROMPTS.F.continuation(), SUBAGENT_PROMPTS.F.newBranch(), SUBAGENT_PROMPTS.H(), SUBAGENT_PROMPTS.I()]) {
      expect(prompt).toContain(BROWSER_RESULT_FILE);
    }
    // The user signs in through the live view: the handoff prompt never carries the demo login.
    for (const value of SAUCEDEMO_LOGIN_VALUES) expect(SUBAGENT_PROMPTS.H()).not.toContain(value);
    expect(SIDE_QUESTION.answer).toBe(String(17 * 23));
  });
});

describe("result-file oracles", () => {
  it("A needs ten distinct options with pages of their own", () => {
    const options = Array.from({ length: 10 }, (_, index) => ({ name: `Option ${index}`, url: `https://example.org/p/${index}` }));
    expect(oracleA({ ...base, options }).failed).toEqual([]);
    expect(oracleA({ ...base, options: [...options.slice(0, 9), { name: "option 0", url: "https://example.org/other" }] }).failed)
      .toEqual(["options_lt_10"]);
    expect(oracleA({ ...base, options: options.map((option) => ({ ...option, url: "ftp://example.org/x" })) }).counts.distinctOptions).toBe(0);
    expect(oracleA({ options }).failed).toEqual(["result_status_invalid", "result_blocked_invalid"]);
  });

  it("B needs the five background names", () => {
    const agents = SUBAGENT_NAMES.background.map((name) => ({ name, state: "done" }));
    expect(oracleB({ ...base, agents }).failed).toEqual([]);
    expect(oracleB({ ...base, agents: [...agents.slice(0, 4), { name: "other" }] }).failed).toEqual(["agents_lt_5"]);
  });

  it("C is the S6 oracle unchanged", () => {
    expect(oracleC({ ...base })).toEqual(checkBrowserResult(BROWSER_SCENARIOS.S6, { ...base }));
    expect(oracleC({ ...base }).failed).toContain("result_categories_invalid");
  });

  it("D needs five distinct amazon.es products with price, rating and reviews, and no reported block", () => {
    const products = Array.from({ length: 5 }, (_, index) => ({ name: `Headphones ${index}`, price: "29,99 €", rating: "4,4",
      reviews: "1.234", url: `https://www.amazon.es/dp/B0000000${index}0` }));
    expect(oracleD({ ...base, products }).failed).toEqual([]);
    expect(oracleD({ ...base, products: [...products.slice(0, 4), { ...products[0] }] }).failed).toEqual(["products_lt_5"]);
    expect(oracleD({ ...base, blocked: ["captcha"], products }).failed).toEqual(["blocked_reported"]);
    expect(oracleD({ ...base, products: products.map((product) => ({ ...product, rating: 7 })) }).counts.distinctProducts).toBe(0);
  });

  it("E accepts a log that switched to the new word and stayed there", () => {
    const line = (step: number, word: string) => ({ step, word });
    const from = secrets.correctionFrom;
    const to = secrets.correctionTo;
    expect(oracleE({ ...base, lines: [1, 2, 3].map((step) => line(step, from)).concat([4, 5, 6, 7, 8].map((step) => line(step, to))) },
      secrets).failed).toEqual([]);
    expect(oracleE({ ...base, lines: [1, 2, 3, 4, 5, 6].map((step) => line(step, from.toLowerCase())) }, secrets).failed)
      .toEqual(["correction_not_followed"]);
    expect(oracleE({ ...base, lines: [line(1, from), line(2, to), line(3, from), line(4, to), line(5, to), line(6, to)] }, secrets).failed)
      .toEqual(["correction_reverted"]);
    expect(oracleE({ ...base, lines: [line(1, to), line(2, "OTHER")] }, secrets).failed)
      .toEqual(["lines_lt_6", "last_line_not_corrected", "unknown_word"]);
  });

  it("F recalls the value before the edit and never sees it on the new branch", () => {
    const value = notaryValue(secrets.nonce);
    expect(oracleFContinued({ ...base, value: value.toUpperCase() }, value).failed).toEqual([]);
    expect(oracleFContinued({ ...base, value: "000000000000" }, value).failed).toEqual(["value_not_recalled"]);
    expect(oracleFBranched({ ...base, value: null }, value)).toEqual({ counts: { abandonedValueSeen: 0, valueNull: 1 }, failed: [] });
    expect(oracleFBranched({ ...base, value }, value).failed).toEqual(["abandoned_branch_value_seen"]);
  });

  it("H joins S5's checkout oracle and its handoff and leak check", () => {
    const checkout = { finished: false, item_total: 29.99, tax: 2.4, total: 32.39, url: "https://www.saucedemo.com/checkout-step-two.html" };
    const handoff = { arguments: { reason: "sign_in" }, result: { content: [{ type: "json", value: { outcome: "completed" } }] },
      state: "complete" };
    const clean = { credentialsAfterHandoff: 0, credentialsInToolArguments: 0, marker: 0 };
    expect(oracleH({ ...base, checkout }, { handoffs: [handoff], leaks: clean }).failed).toEqual([]);
    expect(oracleH({ ...base, checkout }, { handoffs: [], leaks: { ...clean, marker: 1 } }).failed)
      .toEqual(["handoff_missing", "marker_leaked"]);
  });

  it("I needs the number", () => {
    expect(oracleI({ ...base, value: 42 }).failed).toEqual([]);
    expect(oracleI({ ...base, value: " 42 " }).failed).toEqual([]);
    expect(oracleI({ ...base, value: 41 }).failed).toEqual(["value_wrong"]);
  });
});

describe("evidence from stored rows", () => {
  it("counts turns on the parent's binding by the run's model id and effort, not the catalog row id", () => {
    expect(bindingEvidence([turn(), turn({ mode: "background", threadId: "thread-2", turnId: "turn-2" })])).toEqual({
      allOnParentBinding: true, backgroundTurns: 1, foregroundTurns: 1, onParentEffort: 2, onParentModel: 2, parentSourced: 2, threads: 2,
      turns: 2 });
    // The catalog row id differs from the run's model id and is not what is compared.
    expect(bindingEvidence([turn({ providerModelId: "catalog-row" })]).onParentModel).toBe(1);
    // The parent's provider is its answer binding's connection; without one nothing matches.
    expect(bindingEvidence([turn({ parentProvider: null })]).onParentModel).toBe(0);
    expect(bindingEvidence([turn({ parentProvider: "openai_compatible" })]).allOnParentBinding).toBe(false);
    const overridden = bindingEvidence([turn({ modelId: "other", modelSource: "call" }), turn({ reasoningEffort: "high" })]);
    expect(overridden).toMatchObject({ allOnParentBinding: false, onParentEffort: 1, onParentModel: 1, parentSourced: 1 });
    expect(bindingEvidence([]).allOnParentBinding).toBe(false);
    expect(requestedModelEvidence([turn({ modelId: "gpt-second", modelSource: "call", provider: "c2" }), turn()],
      { modelIds: ["gpt-second", "row-2"], provider: "c2" })).toEqual({ allOnRequestedModel: false, callSourced: 1, onRequestedModel: 1 });
    expect(requestedModelEvidence([turn({ modelId: "gpt-second", provider: "c1" })], { modelIds: ["gpt-second"], provider: "c2" })
      .onRequestedModel).toBe(0);
    expect(turnOutcomes([turn(), turn({ mode: "background", reasonCode: "stop_subagent", state: "stopped" }),
      turn({ reasonCode: "user_stop", state: "stopped" }), turn({ reasonCode: "Not A Code", state: "failed" })])).toEqual({
      reasons: { other: 1, stop_subagent: 1, user_stop: 1 },
      reasonsByMode: { background: { stop_subagent: 1 }, foreground: { other: 1, user_stop: 1 } },
      states: { done: 1, failed: 1, stopped: 2 } });
  });

  it("finds the most keys open at once, back-to-back intervals not overlapping", () => {
    expect(peakConcurrency([], 0)).toBe(0);
    expect(peakConcurrency([{ end: 10, key: "a", start: 0 }, { end: 20, key: "b", start: 10 }], 30)).toBe(1);
    expect(peakConcurrency([{ end: 10, key: "a", start: 0 }, { end: 12, key: "b", start: 5 }, { end: null, key: "c", start: 8 }], 30)).toBe(3);
    // Two overlapping calls of one agent count once.
    expect(peakConcurrency([{ end: 10, key: "a", start: 0 }, { end: 9, key: "a", start: 1 }, { end: 5, key: "b", start: 4 }], 30)).toBe(2);
    expect(peakConcurrentTurns([turn({ endedAt: null }), turn({ startedAt: at(30), turnId: "turn-2" })], ms(100))).toBe(2);
  });

  it("measures browser use, rounds and the main agent's sub-agent calls from the timeline", () => {
    const rows = [
      tool({ browser: true, completedAt: at(20), startedAt: at(0), threadId: "t1", toolName: "workspace_exec", roundIndex: 3 }),
      tool({ browser: true, busy: true, completedAt: at(25), startedAt: at(5), threadId: "t2", toolName: "workspace_exec" }),
      tool({ browser: true, completedAt: at(40), memoryLow: true, startedAt: at(30), toolName: "workspace_exec", roundIndex: 2 }),
      tool({ roundIndex: 1 }), tool({ backgroundRefused: true, roundIndex: 1 }), tool({ roundIndex: 2, runId: "run-2" }),
      tool({ roundIndex: 4, state: "error", threadId: "t2", toolName: "stop_subagent" }), tool({ toolName: "stop_subagent" })
    ];
    expect(browserEvidence(rows, ms(60))).toEqual({ browserBusyResults: 1, browserCalls: 3, browserMemoryLowResults: 1, browsingAgents: 3,
      mainAgentBrowserCalls: 1, peakBrowsingAgents: 2 });
    expect(roundsPerAgent(rows)).toEqual({ failedToolCalls: 1, mainRounds: 4, subagentRounds: [4, 3], toolCalls: 8 });
    expect(subagentCallEvidence(rows)).toEqual({ backgroundRefusals: 1, callSubagentCalls: 3, maxCallSubagentPerRound: 2,
      stopSubagentCalls: 1 });
  });

  it("breaks failed tool calls down by agent, tool and stable code only", () => {
    const rows = [
      tool({ resultCode: "subagent_busy", state: "error" }),
      tool({ resultCode: "subagent_busy", state: "error" }),
      tool({ resultCode: "ended_failed", resultReason: "deadline", state: "error" }),
      tool({ resultCode: "ended_stopped", resultReason: "stop_subagent", state: "error", stopTarget: "background",
        toolName: "stop_subagent" }),
      tool({ resultCode: "ended_done", resultReason: null, state: "error", stopTarget: "none", toolName: "stop_subagent" }),
      tool({ resultCode: "subagent_not_found", state: "error", stopTarget: "foreground", toolName: "stop_subagent" }),
      tool({ resultCode: "workspace_command_failed", state: "error", threadId: "t1", toolName: "workspace__sandbox_exec" }),
      tool({ resultCode: "Some page text", state: "error", threadId: "t1", toolName: "fetch_url" }),
      tool({ resultCode: null, state: "error", threadId: "t1", toolName: "a tool with spaces" }),
      tool({ resultCode: "subagent_busy", state: "complete" })
    ];
    expect(failedToolCalls(rows)).toEqual({
      main: { call_subagent: { ended_failed: 1, subagent_busy: 2 },
        stop_subagent: { ended_done: 1, ended_stopped: 1, subagent_not_found: 1 } },
      subagent: { fetch_url: { other: 1 }, other: { none: 1 }, workspace__sandbox_exec: { workspace_command_failed: 1 } }
    });
    expect(stopSubagentCalls(rows)).toEqual({ calls: 3, resultCodes: { ended_done: 1, ended_stopped: 1, subagent_not_found: 1 },
      stoppedRunningTurn: 1, targetedActiveBackground: 1, targetedActiveForeground: 1, targetedNothingActive: 1 });
    expect(callSubagentOutcomes(rows)).toEqual({ endedNotDone: { ended_failed: 1 }, refusals: { subagent_busy: 2 } });
    expect([stableCode(null), stableCode(""), stableCode("bot_wall"), stableCode("Bot wall!")]).toEqual(["none", "none", "bot_wall", "other"]);
  });

  it("splits usage by purpose and keeps unknown sums unknown", () => {
    const usage = usageByPurpose([
      { cachedInputTokens: 10, inputTokens: 1_000, outputTokens: 50, purpose: "chat_answer" },
      { cachedInputTokens: null, inputTokens: 2_000, outputTokens: 70, purpose: "subagent" },
      { cachedInputTokens: 5, inputTokens: 500, outputTokens: 30, purpose: "subagent" }
    ]);
    expect(usage.split).toBe(true);
    expect(usage.byPurpose.subagent).toMatchObject({ cachedInputTokens: null, inputTokens: 2_500, outputTokens: 100, rows: 2 });
    expect(usage.total).toMatchObject({ inputTokens: 3_500, outputTokens: 150, rows: 3 });
    expect(usage.byPurpose.chat_answer?.costEstimates?.frontier.noCache).toBe(0.005);
    expect(usageByPurpose([{ cachedInputTokens: 0, inputTokens: null, outputTokens: 1, purpose: "chat_answer" }]).total.inputTokens).toBeNull();
    expect(usageByPurpose([]).split).toBe(false);
  });

  it("tells wake-up callbacks, coalescing and callbacks into a running answer apart", () => {
    const wakeUps: WakeUpRow[] = [{ createdAt: at(100), runId: "wake-1", runStatus: "complete" }];
    const turns = [
      turn({ callbackRunId: "wake-1", endedAt: at(90), mode: "background", turnId: "b1" }),
      turn({ callbackRunId: "wake-1", endedAt: at(95), mode: "background", turnId: "b2" }),
      turn({ callbackRunId: "answer-2", endedAt: at(50), mode: "background", turnId: "b3" }),
      turn({ callbackRunId: null, endedAt: at(99), mode: "background", turnId: "b4" }),
      turn({ endedAt: null, mode: "background", state: "running", turnId: "b5" }),
      turn({ turnId: "f1" })
    ];
    expect(callbackEvidence(turns, wakeUps)).toEqual({ backgroundTurns: 5, callbacksByWakeUp: [2], callbacksDelivered: 3,
      callbacksIntoRunningAnswer: 1, callbacksOwed: 1, coalesced: true, endedBackgroundTurns: 4, secondsToWakeUp: 50, wakeUpTurns: 1 });
    expect(callbackEvidence(turns, wakeUps, ms(60)).secondsToWakeUp).toBe(10);
    expect(callbackEvidence([], []).secondsToWakeUp).toBeNull();
  });

  it("records thread states only when they change, bounded", () => {
    expect(stateCounts(["done", "running", "running", "weird"])).toEqual({ done: 1, other: 1, running: 2 });
    let series = appendProgression([], stateCounts(["running", "running"]));
    series = appendProgression(series, stateCounts(["running", "running"]));
    series = appendProgression(series, stateCounts(["waiting", "running"]));
    series = appendProgression(series, stateCounts(["done", "done"]));
    expect(series).toEqual([{ running: 2 }, { running: 1, waiting: 1 }, { done: 2 }]);
    expect(progressionSaw(series, "waiting")).toBe(true);
    expect(progressionSaw(series, "interrupted")).toBe(false);
    let long: ReturnType<typeof appendProgression> = [];
    for (let index = 0; index < 10; index += 1) long = appendProgression(long, { running: index }, 4);
    expect(long).toEqual([{ running: 0 }, { running: 1 }, { running: 2 }, { running: 9 }]);
  });

  it("checks each stop path against its own end reason", () => {
    expect(stopEvidence({ stopAll: [turn({ reasonCode: "stop_all", state: "stopped" }), turn({ reasonCode: "stop_all", state: "stopped" })],
      stopRoute: turn({ reasonCode: "user_stop", state: "stopped" }), stopTool: turn({ reasonCode: "stop_subagent", state: "stopped" }) }))
      .toEqual({ stopAllStopped: true, stopRouteStopped: true, stopToolStopped: true });
    const failed = stopEvidence({ stopAll: [], stopRoute: turn({ reasonCode: "stop_all", state: "stopped" }), stopTool: turn() });
    // Stop all must reach every hold: one that ended otherwise fails it.
    expect(stopEvidence({ stopAll: [turn({ reasonCode: "stop_all", state: "stopped" }), turn()], stopRoute: null, stopTool: null })
      .stopAllStopped).toBe(false);
    expect(failed).toEqual({ stopAllStopped: false, stopRouteStopped: false, stopToolStopped: false });
    const running = { stopAll: true, stopRoute: true, stopTool: true };
    expect(stopChecks(failed, running)).toEqual(["stop_subagent_failed", "stop_route_failed", "stop_all_failed"]);
    // An idle agent that ended on its own before its stop is a model shortcut, not a failed stop.
    expect(stopChecks(failed, { ...running, stopAll: false })).toEqual(["stop_subagent_failed", "stop_route_failed", "idle_agent_ended_early"]);
    expect(stopChecks(failed, { stopAll: false, stopRoute: false, stopTool: true })).toEqual(["stop_subagent_failed", "idle_agent_ended_early"]);
    expect(stopChecks({ stopAllStopped: true, stopRouteStopped: true, stopToolStopped: true }, running)).toEqual([]);
  });

  it("proves a restart interrupted every background turn into one coalesced wake-up", () => {
    const cut = (turnId: string, callbackRunId: string | null) => turn({ callbackRunId, endedAt: at(200), mode: "background",
      reasonCode: "restart", startedAt: at(10), state: "interrupted", turnId });
    const wake: WakeUpRow[] = [{ createdAt: at(150), runId: "wake-1", runStatus: "complete" }];
    expect(restartEvidence([cut("a", "wake-1"), cut("b", "wake-1"), cut("c", "wake-1"), turn({ startedAt: at(300) })], wake, ms(100)))
      .toEqual({ allInterrupted: true, backgroundTurnsCut: 3, interruptedCallbacksInWakeUps: 3, interruptedTurns: 3,
        oneCoalescedWakeUp: true, wakeUpsAfterRestart: 1 });
    const two: WakeUpRow[] = [...wake, { createdAt: at(160), runId: "wake-2", runStatus: "complete" }];
    expect(restartEvidence([cut("a", "wake-1"), cut("b", "wake-2")], two, ms(100)).oneCoalescedWakeUp).toBe(false);
    expect(restartEvidence([cut("a", "wake-1"), turn({ mode: "background", startedAt: at(10), state: "done", turnId: "d" })], wake, ms(100)))
      .toMatchObject({ allInterrupted: false, interruptedTurns: 1 });
    // A wake-up from before the restart is not the restart's.
    expect(restartEvidence([cut("a", "wake-0")], [{ createdAt: at(50), runId: "wake-0", runStatus: "complete" }], ms(100)))
      .toMatchObject({ oneCoalescedWakeUp: false, wakeUpsAfterRestart: 0 });
  });
});

describe("scenario cleanup", () => {
  const ports = (overrides: Partial<Parameters<typeof cleanUpScenario>[0]> = {}) => {
    const calls: string[] = [];
    return { calls, ports: {
      deleteChat: async (id: string) => { calls.push(`chat:${id}`); return true; },
      deleteTask: async (id: string) => { calls.push(`task:${id}`); return true; },
      removeBrowserSessions: async () => { calls.push("sessions"); return 2; },
      ...overrides
    } };
  };

  it("deletes tasks, then chats, then saved sessions, once each", async () => {
    const { calls, ports: cleanup } = ports();
    expect(await cleanUpScenario(cleanup, { chatIds: ["c1", "c2", "c1"], keepChats: false, taskIds: ["t1"] })).toEqual({
      browserSessionsRemoved: 2, chatsDeleted: 2, chatsKept: 0, chatsNotDeleted: 0, cleaned: true, tasksDeleted: 1, tasksNotDeleted: 0 });
    expect(calls).toEqual(["task:t1", "chat:c1", "chat:c2", "sessions"]);
  });

  it("is not clean when anything could not be proven gone", async () => {
    const failingChat = ports({ deleteChat: async () => { throw new Error("down"); } });
    expect((await cleanUpScenario(failingChat.ports, { chatIds: ["c1"], keepChats: false, taskIds: [] })).cleaned).toBe(false);
    const failingTask = ports({ deleteTask: async () => false });
    expect((await cleanUpScenario(failingTask.ports, { chatIds: [], keepChats: false, taskIds: ["t1"] })).cleaned).toBe(false);
    const failingSessions = ports({ removeBrowserSessions: async () => { throw new Error("left"); } });
    expect(await cleanUpScenario(failingSessions.ports, { chatIds: [], keepChats: false, taskIds: [] }))
      .toMatchObject({ browserSessionsRemoved: null, cleaned: false });
    const kept = ports();
    expect(await cleanUpScenario(kept.ports, { chatIds: ["c1"], keepChats: true, taskIds: [] })).toMatchObject({ chatsKept: 1, cleaned: true });
    expect(kept.calls).toEqual(["sessions"]);
  });
});

describe("summary", () => {
  it("puts tokens per purpose per run and, for C, the S6 baseline beside them", () => {
    const usage = usageByPurpose([{ cachedInputTokens: 0, inputTokens: 1_000_000, outputTokens: 1_000, purpose: "subagent" }]);
    const summary = subagentScenarioSummary("C1", [{ run: 1, scenario: "C1", success: true, usage, wallSeconds: 300 },
      { run: 1, scenario: "A", success: false, usage: null, wallSeconds: 10 }]);
    expect(summary).toMatchObject({ runs: 1, scenario: "C1", successes: 1 });
    expect(summary.runsDetail[0]?.tokensByPurpose?.subagent?.inputTokens).toBe(1_000_000);
    expect(summary.baseline).toEqual(s6BaselineRows());
    expect(s6BaselineRows()[0]?.costEstimates?.frontier.noCache).toBe(13.8424);
    expect(S6_BASELINE).toHaveLength(2);
    expect(subagentScenarioSummary("A", []).baseline).toBeUndefined();
  });
});
