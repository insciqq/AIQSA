import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BROWSER_RESULT_FILE, BROWSER_SCENARIOS, SAUCEDEMO_LOGIN_VALUES, checkBrowserResult } from "./browser-scenarios-support";
import {
  DEFAULT_SUBAGENT_SCENARIO_IDS, S6_BASELINE, SCENARIO_J_PNG_BASE64, SCENARIO_J_STOP_SECONDS, SCENARIO_K_PNG_SCRIPT, SEND_LOST_TO_WAKE_UP, SIDE_QUESTION,
  SUBAGENT_NAMES, SUBAGENT_PROMPTS, SUBAGENT_SCENARIO_IDS, appendProgression, appendSessionSample,
  bindingEvidence, blindImageEvidence, browserEvidence, callSubagentOutcomes, callbackEvidence, cleanUpScenario, failedToolCalls, imageToolEvidence,
  mainImageToolEvidence, notaryValue, stableCode,
  stopSubagentCalls, oracleA, oracleB, oracleC, oracleD, oracleE,
  oracleFBranched, oracleFContinued, oracleH, oracleI, oracleJ, oracleKFlow, oracleKReads, peakConcurrency, peakConcurrentTurns, pngBytes, progressionSaw, requestedModelEvidence,
  restartEvidence, roundsPerAgent, runSecrets, s6BaselineRows, scenarioJOrder, scenarioKFacts, selectedSubagentScenarios, sendRefusal, sessionStopEvidence,
  stateCounts, stopChecks, stopEvidence,
  subagentCallEvidence, subagentHarnessOptions, subagentScenarioSummary, turnOutcomes, usageByPurpose,
  type SessionSample, type ToolRow, type TurnRow, type WakeUpRow
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
    expect(SUBAGENT_SCENARIO_IDS).toHaveLength(13);
    expect(DEFAULT_SUBAGENT_SCENARIO_IDS).not.toContain("J");
    expect(selectedSubagentScenarios("J")).toEqual(["J"]);
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
      restart: { command: "ssh stand restart", timeoutMs: 60_000 }, runs: 1, secondModel: "gpt-6-luna", textModel: null });
  });

  it("takes K's text-only model only with its key, and runs K only when named", () => {
    expect(selectedSubagentScenarios(undefined)).not.toContain("K");
    expect(selectedSubagentScenarios("k")).toEqual(["K"]);
    expect(() => subagentHarnessOptions({ AIQSA_SUBAGENTS_TEXT_MODEL: "deepseek/deepseek-v3.2" }, ["K"], "m")).toThrow("openrouter_key_required");
    expect(() => subagentHarnessOptions({ AIQSA_SUBAGENTS_TEXT_MODEL: "bad model", OPENROUTER_API_KEY: "k" }, ["K"], "m")).toThrow("text_model_invalid");
    expect(subagentHarnessOptions({ AIQSA_SUBAGENTS_TEXT_MODEL: "deepseek/deepseek-v3.2", OPENROUTER_API_KEY: "k" }, ["K"], "m").textModel)
      .toBe("deepseek/deepseek-v3.2");
    expect(subagentHarnessOptions({}, ["K"], "m").textModel).toBeNull();
  });
});

describe("files and images across agents (K)", () => {
  const facts = scenarioKFacts("0123456789abcdef");
  const { texts } = facts;
  const reads = (reader: "left" | "main" | "right") => ({
    left_color: "blue", left_text: texts.left, right_color: "green", right_text: texts.right,
    ...(reader === "main" ? {} : { main_color: "red", main_text: texts.main })
  });
  const result = { ...base, left: reads("left"), main: reads("main"), right: reads("right") };

  it("gives each writer its own value and every prompt the exact commands, with a chart request that names no folder", () => {
    expect(new Set(Object.values(texts)).size).toBe(3);
    const start = SUBAGENT_PROMPTS.K.start(facts);
    expect(start).toContain(SCENARIO_K_PNG_SCRIPT);
    expect(start).toContain(`python3 ${facts.directory}/png.py ${facts.directory}/left.png 0 0 255`);
    expect(start).toContain(`printf '%s' ${facts.nonce}-right | sha256sum | cut -c1-12 > ${facts.directory}/right.txt`);
    for (const value of Object.values(texts)) expect(`${start}${SUBAGENT_PROMPTS.K.reads(facts)}`).not.toContain(value);
    expect(SUBAGENT_PROMPTS.K.reads(facts)).toContain("background: true");
    expect(SUBAGENT_PROMPTS.K.chart()).not.toContain("/workspace");
    expect(SUBAGENT_PROMPTS.K.blind(facts, "deepseek/deepseek-v3.2")).toContain("модель deepseek/deepseek-v3.2");
  });

  it("holds every read to the file's exact value and the picture's colour", () => {
    expect(oracleKReads(result, texts)).toEqual({ counts: { reads: 16 }, failed: [] });
    expect(oracleKReads({ ...result, left: { ...reads("left"), right_color: "blue", main_text: "0" } }, texts).failed)
      .toEqual(["left_read_main_text", "left_read_right_color"]);
    expect(oracleKReads({ ...base }, texts).failed).toContain("main_read_left_text");
  });

  const left = [turn({ mode: "background", threadId: "left" }), turn({ threadId: "left", turnId: "turn-2" })];
  const right = [turn({ mode: "background", threadId: "right" }), turn({ mode: "background", threadId: "right", turnId: "turn-2" })];
  const viewed = (threadId: string | null, count: number, runId = "run-1") => Array.from({ length: count }, () => tool({ runId, threadId, toolName: "view_workspace_image" }));
  const rows = [...viewed("left", 4), ...viewed("right", 4), ...viewed(null, 2), ...viewed(null, 1, "wake-up")];
  const flow = { blind: null, callbacks: callbackEvidence([], []),
    chart: { downloads: [{ bytes: 90, png: true }], mainImage: mainImageToolEvidence(rows, ["wake-up"]), turn: turn({ mode: "background" }) },
    images: { left: imageToolEvidence(rows, "left"), main: mainImageToolEvidence(rows, ["run-1"]), right: imageToolEvidence(rows, "right") },
    left, right, settled: true };

  it("passes the flow with a continued thread each way, the main agent's look at the chart and a real download", () => {
    expect(oracleKFlow(flow).failed).toEqual([]);
    expect(oracleKFlow(flow).counts).toMatchObject({ chartDownloads: 1, mainChartViews: 1, mainImages: 2 });
  });

  it("fails a sub-agent that was not continued or started over, a chart nobody can get, and images nobody read", () => {
    expect(oracleKFlow({ ...flow, left: left.slice(0, 1), right: [right[0]!, turn({ threadId: "right" })] }).failed)
      .toEqual(["left_not_continued_in_foreground", "right_not_continued_in_background"]);
    expect(oracleKFlow({ ...flow, chart: { downloads: [{ bytes: 90, png: false }], mainImage: mainImageToolEvidence([], []), turn: turn() } }).failed)
      .toEqual(["chart_turn_not_done_in_background", "chart_not_viewed_by_main", "chart_not_downloadable"]);
    expect(oracleKFlow({ ...flow, images: { left: imageToolEvidence([], "left"), main: mainImageToolEvidence([], []), right: imageToolEvidence([], "right") } }).failed)
      .toEqual(["left_images_not_read", "right_images_not_read", "main_images_not_read"]);
  });

  it("holds a sub-agent without vision to System Vision and never to direct view", () => {
    const analyzed = [tool({ threadId: "blind", toolName: "analyze_image" })];
    const blind = { answered: true, image: blindImageEvidence(analyzed, "blind"), turn: turn({ threadId: "blind" }) };
    expect(blind.image).toMatchObject({ succeeded: 1, viewCalls: 0 });
    expect(oracleKFlow({ ...flow, blind }).failed).toEqual([]);
    const refused = [...analyzed, tool({ resultCode: "unknown_tool", state: "error", threadId: "blind", toolName: "view_workspace_image" })];
    expect(oracleKFlow({ ...flow, blind: { answered: false, image: blindImageEvidence(refused, "blind"), turn: turn({ state: "failed", threadId: "blind" }) } }).failed)
      .toEqual(["blind_turn_not_done", "blind_called_direct_view", "blind_color_not_answered"]);
  });

  it("recognizes a PNG by its signature", () => {
    expect(pngBytes(Buffer.from(SCENARIO_J_PNG_BASE64, "base64"))).toBe(true);
    expect(pngBytes(new Uint8Array([1, 2, 3]))).toBe(false);
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

describe("scenario J: the capture and retire defects", () => {
  const sample = (seconds: number, state: string, owner: SessionSample["owner"] = "other", closing = false): SessionSample =>
    ({ at: at(seconds), closing, owner, state });
  const viewerTurn = turn({ endedAt: at(30), mode: "background", threadId: "viewer", turnId: "turn-viewer" });
  const quietTurn = turn({ endedAt: at(90), mode: "background", threadId: "quiet", turnId: "turn-quiet" });
  const wakeUp: WakeUpRow = { createdAt: at(32), runId: "wake-1", runStatus: "complete" };
  const delivered = [{ ...viewerTurn, callbackRunId: "wake-1" }, { ...quietTurn, callbackRunId: "run-2" }];
  const order = scenarioJOrder({ mainRunsActive: 0, quiet: quietTurn, quietToolCalls: 0, viewer: viewerTurn });
  const healthy = {
    callbacks: callbackEvidence(delivered, [wakeUp]),
    failures: { captureIdentity: 0, visionInternal: 0 },
    image: imageToolEvidence([tool({ threadId: "viewer", toolName: "view_workspace_image" })], "viewer"),
    order,
    secondAccepted: true,
    secondAnswered: true,
    secondRefusals: [] as string[],
    session: sessionStopEvidence([sample(5, "RUNNING"), sample(89, "STOPPED", "none")], order.lastTurnEnd),
    settled: true,
    wakeUps: [wakeUp]
  };

  it("names the two agents, the per-run file and the exact fan-out, and writes an image the product can decode", async () => {
    const prompt = SUBAGENT_PROMPTS.J.start("subagent-j-1.png");
    expect(prompt).toContain(`printf '%s' '${SCENARIO_J_PNG_BASE64}' | base64 -d > /workspace/project/subagent-j-1.png`);
    for (const name of Object.values(SUBAGENT_NAMES.capture)) expect(prompt).toContain(`суб-агента ${name}.`);
    expect(prompt).toContain("Суб-агентов ровно два, вызовов call_subagent ровно два");
    expect(SUBAGENT_PROMPTS.J.question.answer).toBe(String(12 * 12));
    const image = sharp(Buffer.from(SCENARIO_J_PNG_BASE64, "base64"));
    expect(await image.metadata()).toMatchObject({ format: "png", height: 64, width: 64 });
  });

  it("counts an image call as succeeded only when it completed without a code, on the viewer's own thread", () => {
    const rows = [tool({ threadId: "viewer", toolName: "analyze_image" }),
      tool({ resultCode: "vision_analysis_internal_failed", state: "error", threadId: "viewer", toolName: "analyze_image" }),
      tool({ threadId: "quiet", toolName: "view_workspace_image" }), tool({ threadId: "viewer", toolName: "sandbox_shell" })];
    expect(imageToolEvidence(rows, "viewer")).toEqual({ calls: 2, failureCodes: { vision_analysis_internal_failed: 1 }, succeeded: 1 });
    expect(imageToolEvidence(rows, null)).toEqual({ calls: 0, failureCodes: {}, succeeded: 0 });
  });

  it("records the order the model decided instead of failing it", () => {
    expect(order).toMatchObject({ lastTurnEnd: ms(90), order_not_reached: false });
    expect(scenarioJOrder({ mainRunsActive: 0, quiet: viewerTurn, quietToolCalls: 0, viewer: quietTurn }).order_not_reached).toBe(true);
    expect(scenarioJOrder({ mainRunsActive: 1, quiet: quietTurn, quietToolCalls: 0, viewer: viewerTurn }).order_not_reached).toBe(true);
    expect(scenarioJOrder({ mainRunsActive: 0, quiet: quietTurn, quietToolCalls: 1, viewer: viewerTurn }).order_not_reached).toBe(true);
    expect(scenarioJOrder({ mainRunsActive: 0, quiet: null, quietToolCalls: 0, viewer: viewerTurn }))
      .toMatchObject({ lastTurnEnd: null, order_not_reached: true });
    const reversed = scenarioJOrder({ mainRunsActive: 0, quiet: viewerTurn, quietToolCalls: 0, viewer: quietTurn });
    expect(oracleJ({ ...healthy, order: reversed, session: sessionStopEvidence([sample(5, "RUNNING"), sample(120, "STOPPED", "none")], ms(90)) }).failed)
      .toEqual([]);
  });

  it("keeps the session's changes and measures the signed time out of RUNNING around the last turn's end", () => {
    let series: SessionSample[] = [];
    for (const next of [sample(1, "PENDING"), sample(2, "PENDING"), sample(5, "RUNNING"), sample(6, "RUNNING")]) {
      series = appendSessionSample(series, next);
    }
    expect(series.map((entry) => entry.state)).toEqual(["PENDING", "RUNNING"]);
    expect(appendSessionSample(series, sample(7, "RUNNING", "none"))).toHaveLength(3);
    expect(appendSessionSample(series, sample(7, "RUNNING", "other", true))).toHaveLength(3);
    expect(appendSessionSample([sample(1, "A"), sample(2, "B")], sample(3, "C"), 2).map((entry) => entry.state)).toEqual(["A", "C"]);
    // Healthy: the VM stops before the turn's end is written.
    expect(sessionStopEvidence([sample(5, "RUNNING"), sample(89, "STOPPED", "none")], ms(90))).toEqual({ finalState: "STOPPED",
      leftRunningTo: "STOPPED", maintenanceHeld: false, runningSeen: true, secondsToLeaveRunning: -1 });
    // A later run's VM does not hide the stop that counted.
    expect(sessionStopEvidence([sample(5, "RUNNING"), sample(92, "STOPPED", "none"), sample(120, "RUNNING")], ms(90)))
      .toMatchObject({ finalState: "RUNNING", leftRunningTo: "STOPPED", secondsToLeaveRunning: 2 });
    expect(sessionStopEvidence([sample(1, "PENDING")], ms(90))).toMatchObject({ leftRunningTo: null, runningSeen: false });
    expect(sessionStopEvidence([sample(5, "RUNNING")], ms(90))).toMatchObject({ leftRunningTo: null, runningSeen: true,
      secondsToLeaveRunning: null });
  });

  it("tells the defect's busy refusal from a send the wake-up simply beat", () => {
    const stuck = sample(91, "RUNNING", "none");
    expect(sendRefusal("workspace_busy", { mainRunActive: false, session: stuck })).toBe("workspace_busy_session_state");
    expect(sendRefusal("workspace_busy", { mainRunActive: true, session: stuck })).toBe("workspace_busy_session_state");
    expect(sendRefusal("workspace_busy", { mainRunActive: false, session: sample(91, "RUNNING", "other", true) })).toBe("workspace_busy_join_closing");
    expect(sendRefusal("workspace_busy", { mainRunActive: false, session: null })).toBe("workspace_busy_other");
    expect(sendRefusal("workspace_busy", { mainRunActive: true, session: sample(91, "RUNNING") })).toBe(SEND_LOST_TO_WAKE_UP);
    expect(sendRefusal("active_run_in_progress", { mainRunActive: false, session: null })).toBe(SEND_LOST_TO_WAKE_UP);
    expect(sendRefusal("active_leaf_changed", { mainRunActive: false, session: null })).toBe(SEND_LOST_TO_WAKE_UP);
    expect(sendRefusal("Not a code", { mainRunActive: false, session: null })).toBe("other");
  });

  it("passes the healthy run and fails each defect by its own code", () => {
    expect(oracleJ(healthy)).toEqual({ counts: { imageCalls: 1, imageSucceeded: 1, secondRefusals: 0, wakeUps: 1 }, failed: [] });
    // The capture defect: the image tool's failure and the stored constraint name.
    expect(oracleJ({ ...healthy, failures: { captureIdentity: 1, visionInternal: 1 }, image: imageToolEvidence([], "viewer") }).failed)
      .toEqual(["image_tool_not_succeeded", "capture_identity_failure", "vision_internal_failure"]);
    // The retire defect: refused, the wake-up held back, the VM left to the backstop.
    const stuck = sessionStopEvidence([sample(5, "RUNNING"), sample(90, "RUNNING", "none"), sample(150, "RUNNING", "maintenance"),
      sample(160, "STOPPED", "none")], order.lastTurnEnd);
    expect(oracleJ({ ...healthy, callbacks: callbackEvidence([delivered[0]!, quietTurn], [wakeUp]), secondAccepted: false, secondRefusals: ["workspace_busy_session_state"],
      session: stuck, settled: false }).failed).toEqual(["workspace_busy_session_state", "second_send_not_accepted", "callbacks_still_owed",
      "session_stopped_by_backstop", "session_stop_slow"]);
  });

  it("accepts a send retried after the wake-up, and a run whose callbacks all went into running answers", () => {
    expect(oracleJ({ ...healthy, secondRefusals: [SEND_LOST_TO_WAKE_UP] }).failed).toEqual([]);
    const intoAnswers = [{ ...viewerTurn, callbackRunId: "run-1" }, { ...quietTurn, callbackRunId: "run-2" }];
    expect(oracleJ({ ...healthy, callbacks: callbackEvidence(intoAnswers, []), wakeUps: [] }).failed).toEqual([]);
    expect(oracleJ({ ...healthy, callbacks: callbackEvidence([viewerTurn, quietTurn], []), wakeUps: [] }).failed).toEqual(["callbacks_owed"]);
    expect(oracleJ({ ...healthy, wakeUps: [{ ...wakeUp, runStatus: "error" }] }).failed).toEqual(["wake_up_not_complete"]);
  });

  it("judges where the session went and how long it took", () => {
    const after = (state: string, seconds: number) => sessionStopEvidence([sample(5, "RUNNING"), sample(seconds, state, "none")], order.lastTurnEnd);
    expect(oracleJ({ ...healthy, session: after("PENDING", 91) }).failed).toEqual([]);
    expect(oracleJ({ ...healthy, session: after("READY", 91) }).failed).toEqual(["session_left_to_other_state"]);
    expect(oracleJ({ ...healthy, session: after("STOPPED", 90 + SCENARIO_J_STOP_SECONDS) }).failed).toEqual([]);
    expect(oracleJ({ ...healthy, session: after("STOPPED", 91 + SCENARIO_J_STOP_SECONDS) }).failed).toEqual(["session_stop_slow"]);
    expect(oracleJ({ ...healthy, session: sessionStopEvidence([], order.lastTurnEnd) }).failed).toEqual(["session_never_running"]);
    expect(oracleJ({ ...healthy, session: sessionStopEvidence([sample(5, "RUNNING")], order.lastTurnEnd) }).failed).toEqual(["session_still_running"]);
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
