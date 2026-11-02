import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RESEARCH_APP_LOG_TIMEOUT_MS, createResearchArchive, decodeResearchExpectations, emptyEval, readResearchQuestionSet, researchAcceptanceMetrics,
  researchAcceptanceObserved, researchEngineLatency, researchEvalOptions, researchEvaluationSummary, researchExpectationCounts, researchExpectationResults,
  researchJobLabel, researchMatchText, researchNameKey, researchPercentiles, researchSetJobs,
  type ResearchAcceptanceCall, type ResearchAcceptanceEvidence, type ResearchAcceptanceInput, type ResearchAcceptanceTurn, type ResearchGrade, type ResearchResponse,
  type StructuredResearchAnswer
} from "./research-eval-support";

const temporary: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "research-acceptance-set-")); temporary.push(path); return path; };
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true }); });
const file = (directory: string, name: string, text: string, mode = 0o600) => {
  const path = join(directory, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};

describe("question set options", () => {
  const env = { AIQSA_SUBAGENTS_ANSWERS_DIR: "/private/research" };
  const set = { ...env, AIQSA_SUBAGENTS_T_QUESTION_SET: "/private/questions" };

  it("replaces the kinds with the set's questions, one after another, and keeps the single question file as it was", () => {
    expect(researchEvalOptions(set)).toMatchObject({ concurrency: 1, jobs: [], questionFile: null, questionSet: "/private/questions", setRepeats: 1 });
    expect(researchEvalOptions({ ...set, AIQSA_SUBAGENTS_T_REPEATS: "2", AIQSA_SUBAGENTS_T_CONCURRENCY: "1" })).toMatchObject({ concurrency: 1, setRepeats: 2 });
    const single = researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_QUESTION_FILE: "/private/q" });
    expect(single).toMatchObject({ questionFile: "/private/q", questionSet: null, concurrency: 3 });
    expect(single.jobs.some((job) => job.kind === "purchase")).toBe(true);
  });

  it("refuses what has no meaning beside a set, by code", () => {
    expect(() => researchEvalOptions({ ...set, AIQSA_SUBAGENTS_T_QUESTION_FILE: "/private/q" })).toThrow("research_question_set_with_file");
    expect(() => researchEvalOptions({ ...set, AIQSA_SUBAGENTS_T_KINDS: "purchase" })).toThrow("research_question_set_with_kinds");
    expect(() => researchEvalOptions({ ...set, AIQSA_SUBAGENTS_T_ACTS: "purchase=start" })).toThrow("research_question_set_with_acts");
    expect(() => researchEvalOptions({ ...set, AIQSA_SUBAGENTS_T_REPEATS: "purchase=2" })).toThrow("research_repeats_invalid");
    expect(() => researchEvalOptions({ ...set, AIQSA_SUBAGENTS_T_CONCURRENCY: "3" })).toThrow("research_question_set_sequential");
  });

  it("takes an app log command of one line and refuses one with a line break", () => {
    expect(researchEvalOptions(env).appLog).toBeNull();
    expect(researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_APP_LOG_COMMAND: " ssh stand 'docker compose logs app' " }).appLog)
      .toEqual({ command: "ssh stand 'docker compose logs app'", timeoutMs: RESEARCH_APP_LOG_TIMEOUT_MS });
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_APP_LOG_COMMAND: "one\ntwo" })).toThrow("research_app_log_command_invalid");
  });

  it("picks production Search sources, asking only for what the picked ones search with", () => {
    const production = { ...env, AIQSA_SUBAGENTS_T_SEARCH: "production" };
    expect(researchEvalOptions({ ...production, AIQSA_SUBAGENTS_SEARCH_MODEL: "search-model-1", DEEPSEEK_API_KEY: "k" }).search?.sources)
      .toEqual(["openai", "perplexity", "deepseek"]);
    expect(researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "openai", AIQSA_SUBAGENTS_SEARCH_MODEL: "search-model-1" }).search)
      .toEqual({ model: "search-model-1", plan: "production", sources: ["openai"] });
    expect(researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "deepseek", DEEPSEEK_API_KEY: "k" }).search)
      .toEqual({ model: null, plan: "production", sources: ["deepseek"] });
    expect(researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: " perplexity , openai ", AIQSA_SUBAGENTS_SEARCH_MODEL: "m" }).search?.sources)
      .toEqual(["openai", "perplexity"]);
    expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "perplexity" })).not.toThrow();
    expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "deepseek" })).toThrow("deepseek_key_required");
    expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "openai" })).toThrow("research_search_model_required");
    expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "deepseek", DEEPSEEK_API_KEY: "k", AIQSA_SUBAGENTS_SEARCH_MODEL: "m" }))
      .toThrow("research_search_model_unused");
    for (const raw of ["bing", "openai,openai", ",", "openai,"]) {
      expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: raw, AIQSA_SUBAGENTS_SEARCH_MODEL: "m" })).toThrow("research_search_sources_invalid");
    }
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_SEARCH_SOURCES: "openai" })).toThrow("research_search_sources_requires_production");
  });
});

describe("question set files", () => {
  it("loads each question in name order, with its expectation or none, and ignores other files", () => {
    const directory = scratch();
    file(directory, "b-storage.txt", "  Synthetic storage question.\n");
    file(directory, "a-mattress.txt", "Synthetic purchase question.");
    file(directory, "a-mattress.expect.json", JSON.stringify({ names: ["Synthetic Model One"], minCandidates: 5, maxMinutes: 25 }));
    file(directory, "README.md", "notes", 0o644);
    const questions = readResearchQuestionSet(directory);
    expect(questions).toEqual([
      { name: "a-mattress", text: "Synthetic purchase question.", expect: { names: ["Synthetic Model One"], minCandidates: 5, maxMinutes: 25 } },
      { name: "b-storage", text: "Synthetic storage question.", expect: null }
    ]);
    const jobs = researchSetJobs(questions, 2);
    expect(jobs.map((job) => [researchJobLabel(job), job.repeat])).toEqual([["set-a-mattress", 1], ["set-a-mattress", 2], ["set-b-storage", 1], ["set-b-storage", 2]]);
  });

  it("refuses an orphan expectation, a bad name, an empty or linked directory, an exposed file and a bad expectation, by code", () => {
    const orphan = scratch();
    file(orphan, "one.txt", "q");
    file(orphan, "two.expect.json", "{}");
    expect(() => readResearchQuestionSet(orphan)).toThrow("research_question_set_expect_orphan");
    const named = scratch();
    file(named, "Bad Name.txt", "q");
    expect(() => readResearchQuestionSet(named)).toThrow("research_question_set_name_invalid");
    expect(() => readResearchQuestionSet(scratch())).toThrow("research_question_set_empty");
    expect(() => readResearchQuestionSet(join(scratch(), "absent"))).toThrow("research_question_set_invalid");
    const real = scratch();
    file(real, "one.txt", "q");
    const link = join(scratch(), "link");
    symlinkSync(real, link);
    expect(() => readResearchQuestionSet(link)).toThrow("research_question_set_invalid");
    const exposed = scratch();
    file(exposed, "one.txt", "q", 0o644);
    expect(() => readResearchQuestionSet(exposed)).toThrow("research_question_set_file_mode");
    const wrong = scratch();
    file(wrong, "one.txt", "q");
    file(wrong, "one.expect.json", JSON.stringify({ names: ["x"], other: 1 }));
    expect(() => readResearchQuestionSet(wrong)).toThrow("research_question_expect_invalid");
    const many = scratch();
    for (let index = 0; index < 21; index += 1) file(many, `q${index}.txt`, "q");
    expect(() => readResearchQuestionSet(many)).toThrow("research_question_set_too_large");
  });

  it("accepts any subset of the expectation's keys and refuses what cannot be checked", () => {
    expect(decodeResearchExpectations("{}")).toEqual({});
    expect(decodeResearchExpectations(JSON.stringify({ names: ["490,5", "425-ФЗ"], minNames: 1, namesIn: "answer", minSupportedShare: 0.8 })))
      .toEqual({ names: ["490,5", "425-ФЗ"], minNames: 1, namesIn: "answer", minSupportedShare: 0.8 });
    for (const value of [[], "x", { names: [] }, { names: ["a", "A"] }, { names: ["490,5", "490.5"] }, { names: ["a"], minNames: 2 }, { minNames: 1 },
      { namesIn: "rows" }, { names: ["a"], namesIn: "table" }, { minOffers: -1 }, { minOffers: 1.5 }, { minSupportedShare: 1.2 }, { maxMinutes: 0 }, { names: ["--"] }]) {
      expect(() => decodeResearchExpectations(JSON.stringify(value))).toThrow("research_question_expect_invalid");
    }
    expect(() => decodeResearchExpectations("not json")).toThrow("research_question_expect_invalid");
  });

  it("names a set question's archive files and summary by its name", () => {
    const root = scratch();
    const archive = createResearchArchive(root);
    const job = { kind: "set" as const, name: "a-mattress", repeat: 1 };
    archive.write(job, "chat-one", "acceptance", { rows: 7 });
    expect(readdirSync(root)[0]).toMatch(/^set-a-mattress-1-chat-one-/u);
    expect(() => archive.write({ ...job, name: "../up" }, "chat-one", "acceptance", {})).toThrow("research_archive_key_invalid");
    expect(researchEvaluationSummary({ job, answerCount: 1, gateReportCount: 0, grade: emptyEval<ResearchGrade>("no_answer"), extraction: emptyEval<StructuredResearchAnswer>("no_answer"),
      failed: false, wallSeconds: 1 })).toMatchObject({ kind: "set", question: "a-mattress", repeat: 1 });
  });
});

describe("expectation checks", () => {
  const observed = { rowLabels: ["Nordline DeepRest Medium S2000", "nordline-deeprest-medium-s2000", "Велора Balance Forma", "row-b"],
    answer: "The pick is Velora Balance Forma; Nordline Duo-3 S2000 was considered.", candidates: 7, offers: 2, supportedShare: 0.6, minutes: 21.5 };

  it("finds a name as a row by normalized match, apart from the answer, and counts the found ones against minNames", () => {
    const results = researchExpectationResults({ names: ["Nordline Deep Rest Medium S-2000", "Velora Balance Forma", "Synthetic Missing"], minNames: 2 }, observed);
    expect(results.names).toEqual([
      { name: "Nordline Deep Rest Medium S-2000", row: true, answer: false, found: true },
      { name: "Velora Balance Forma", row: true, answer: true, found: true },
      { name: "Synthetic Missing", row: false, answer: false, found: false }
    ]);
    expect(results).toMatchObject({ namesIn: "either", namesFound: { expected: 2, value: 2, pass: true }, passed: true });
    expect(researchExpectationResults({ names: ["Synthetic Missing", "Velora Balance Forma"] }, observed).namesFound).toEqual({ expected: 2, value: 1, pass: false });
    // A name inside a longer one is not that name.
    expect(researchExpectationResults({ names: ["Nordline Duo-3 S200"] }, observed).names[0]).toMatchObject({ row: false, answer: false });
  });

  it("looks only where namesIn says", () => {
    expect(researchExpectationResults({ names: ["Velora Balance Forma", "Nordline DeepRest Medium S2000"], namesIn: "answer" }, observed).names.map((name) => name.found))
      .toEqual([true, false]);
    expect(researchExpectationResults({ names: ["Nordline Duo-3 S2000"], namesIn: "rows" }, observed).names[0]).toMatchObject({ row: false, answer: true, found: false });
  });

  it("reads a knowledge answer's key facts with one reading of a number's separators, never inside a longer number", () => {
    const answer = "Ставка 490.5 тыс.; закон 425\u2011ФЗ; лимит 1\u2009000\u00a0000 руб.; итог 1490,7.";
    const check = (name: string) => researchExpectationResults({ names: [name], namesIn: "answer" }, { ...observed, answer, rowLabels: [] }).names[0]!.found;
    expect(["490,5", "490.5", "490 5", "425-ФЗ", "425-фз", "1 000 000", "1,000,000"].map(check)).toEqual([true, true, true, true, true, true, true]);
    expect(["90,5", "490", "1490,5", "490,55", "1000000"].map(check)).toEqual([false, false, false, false, false]);
    expect(researchMatchText("  Ставка   490 , 5 ")).toBe("ставка 490 , 5");
    expect(researchNameKey("Sleep Dream")).toBe(researchNameKey("SleepDream"));
  });

  it("gives each bound its value, fails an unmeasured one, and keeps names out of stdout", () => {
    const results = researchExpectationResults({ names: ["Velora Balance Forma"], minCandidates: 5, minOffers: 3, minSupportedShare: 0.5, maxMinutes: 25 },
      { ...observed, supportedShare: null });
    expect(results).toMatchObject({ minCandidates: { expected: 5, value: 7, pass: true }, minOffers: { expected: 3, value: 2, pass: false },
      minSupportedShare: { expected: 0.5, value: null, pass: false }, maxMinutes: { expected: 25, value: 21.5, pass: true }, passed: false });
    expect(researchExpectationResults({ maxMinutes: 20 }, observed)).toEqual({ names: [], maxMinutes: { expected: 20, value: 21.5, pass: false }, passed: false });
    const counts = researchExpectationCounts(results);
    expect(counts.names).toEqual([{ index: 1, row: true, answer: true, found: true }]);
    expect(JSON.stringify(counts)).not.toContain("Velora");
  });
});

describe("acceptance metrics from stand rows", () => {
  const origin = Date.UTC(2026, 10, 3, 10, 0, 0);
  const at = (seconds: number) => new Date(origin + seconds * 1_000);
  const call = (id: string, toolName: string, start: number, end: number, extra: Partial<ResearchAcceptanceCall> = {}): ResearchAcceptanceCall => ({
    id, runId: "run-main", toolName, threadId: null, turnId: null, startedAt: at(start), completedAt: at(end), errorCode: null, budgetMarker: false,
    endReason: null, draftStatus: null, draftGate: null, recordIds: null, frameChange: null, ...extra });
  const inTurn = (thread: string, turn: string) => ({ threadId: thread, turnId: turn });
  const turn = (id: string, threadId: string, name: string, state: string, parent: string, start: number, end: number, report: string | null = null,
    reasonCode: string | null = null): ResearchAcceptanceTurn => ({ id, threadId, name, state, reasonCode, parentToolCallId: parent, startedAt: at(start), endedAt: at(end), report });
  const calls: ResearchAcceptanceCall[] = [
    call("start", "start_research", 1, 1.1), call("propose", "propose_research_plan", 60, 120),
    call("r1", "call_subagent", 135, 900, { endReason: "deadline" }), call("r2", "call_subagent", 135.5, 600), call("r3", "call_subagent", 930, 960),
    call("d1", "submit_research_draft", 1000, 1001, { draftStatus: "sent_back", draftGate: "report_check", recordIds: ["o1"] }),
    call("d2", "submit_research_draft", 1060, 1100, { draftStatus: "sent_back", draftGate: "verifier", recordIds: ["o1"] }),
    call("g1", "call_subagent", 1061, 1070), call("g2", "call_subagent", 1071, 1080), call("g3", "call_subagent", 1071, 1085),
    call("r4", "call_subagent", 1110, 1150),
    call("d3", "submit_research_draft", 1200, 1260, { draftStatus: "accepted", recordIds: ["o1", "o1s", "o2", "o3", "o4"] }),
    call("g4", "call_subagent", 1201, 1205), call("g5", "call_subagent", 1206, 1250),
    // Researcher A: time ended its turn; the stand shows no per-task budget on it.
    call("a1", "search_selected_engines", 140, 160, inTurn("ta", "A1")), call("a2", "search_selected_engines", 170, 210, inTurn("ta", "A1")),
    call("a3", "fetch_url", 220, 221, inTurn("ta", "A1")), call("a4", "record_evidence", 230, 230.1, inTurn("ta", "A1")), call("a5", "record_evidence", 240, 240.1, inTurn("ta", "A1")),
    // Researcher B: reported after a budget refusal.
    call("b1", "search_selected_engines", 140, 150, { ...inTurn("tb", "B1"), budgetMarker: true }), call("b2", "record_evidence", 151, 151.1, inTurn("tb", "B1")),
    call("b3", "fetch_url", 152, 152.1, { ...inTurn("tb", "B1"), errorCode: "research_task_call_budget_exhausted" }),
    // Researcher C: the budget's footer, no refusal.
    call("c1", "search_selected_engines", 931, 936, { ...inTurn("tc", "C1"), budgetMarker: true }), call("c2", "change_research_frame", 940, 940.1, { ...inTurn("tc", "C1"), frameChange: "add_row" }),
    call("b4", "record_evidence", 1120, 1120.1, inTurn("tb", "B2"))
  ];
  const turns: ResearchAcceptanceTurn[] = [
    turn("A1", "ta", "brands", "stopped", "r1", 135, 900, null, "parent_stopped"), turn("B1", "tb", "materials", "done", "r2", 135.5, 600),
    turn("C1", "tc", "offers", "done", "r3", 930, 960), turn("B2", "tb", "materials", "done", "r4", 1110, 1150),
    turn("G1", "tg1", "gap-judge-2", "done", "g1", 1061, 1070),
    turn("V1", "tv1", "verifier-2", "done", "g2", 1071, 1080, "C1 | supported | ok\nC2 | partly | detail\nnot a verdict\nC3 | **supported** | ok"),
    turn("V2", "tv2", "verifier-2-2", "done", "g3", 1071, 1085, "C1 | unsupported | no\nC2 | supported | ok\nC2 | partly | twice"),
    turn("V3", "tv3", "verifier-3", "done", "g4", 1201, 1205, "- C1 | supported | ok"), turn("S1", "ts1", "skeptic-3", "done", "g5", 1206, 1250)
  ];
  const responses: ResearchResponse[] = [
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000].map((inputTokens) => ({ runId: "run-main", threadId: "ta", turnId: "A1", inputTokens, outputTokens: 10 })),
    { runId: "run-main", threadId: "tb", turnId: "B1", inputTokens: 5_000, outputTokens: 10 }, { runId: "run-main", threadId: "tb", turnId: "B1", inputTokens: null, outputTokens: 10 },
    { runId: "run-main", threadId: "tb", turnId: "B2", inputTokens: 7_000, outputTokens: 10 }, { runId: "run-main", threadId: "tv1", turnId: "V1", inputTokens: 99_000, outputTokens: 10 },
    { runId: "run-main", threadId: null, turnId: null, inputTokens: 50_000, outputTokens: 10 }
  ];
  const evidence: ResearchAcceptanceEvidence[] = [
    { id: "o1", kind: "finding", sourceClass: "action_channel", quoteCheck: "found", rowKey: "row-a", supersedesId: null, url: "https://shop.example.test/a" },
    // The same shop page as o1: its specification, not a second offer.
    { id: "o1s", kind: "finding", sourceClass: "action_channel", quoteCheck: "found", rowKey: "row-a", supersedesId: null, url: "https://shop.example.test/a#specs" },
    { id: "o2", kind: "finding", sourceClass: "action_channel", quoteCheck: "found", rowKey: "row-b", supersedesId: null, url: "https://shop.example.test/b" },
    { id: "o3", kind: "finding", sourceClass: "action_channel", quoteCheck: "found", rowKey: "row-a", supersedesId: null, url: "https://shop.example.test/c" },
    { id: "o3b", kind: "finding", sourceClass: "action_channel", quoteCheck: "not_verbatim", rowKey: "row-a", supersedesId: "o3", url: "https://shop.example.test/c" },
    { id: "o4", kind: "finding", sourceClass: "independent_tests", quoteCheck: "found", rowKey: "row-a", supersedesId: null, url: "https://review.example.test/a" },
    { id: "o5", kind: "finding", sourceClass: "action_channel", quoteCheck: "found", rowKey: "row-b", supersedesId: null, url: "https://shop.example.test/d" }
  ];
  const rows = [{ key: "nordline-deeprest-medium-s2000", label: "Nordline DeepRest Medium S2000" }, { key: "row-b", label: "Велора Balance Forma" }];
  const input: ResearchAcceptanceInput = {
    runId: "run-main", runs: [{ id: "run-main", createdAt: at(0), answerCompletedAt: at(1270) }],
    frame: { createdAt: at(60), releasedAt: at(120), frame: { rows, criteria: [], changes: [], branches: [] } },
    calls, turns, responses, evidence,
    searches: [{ strategyId: "opt-openai", status: "complete" }, { strategyId: "opt-openai", status: "complete" }, { strategyId: "opt-deepseek", status: "complete" },
      { strategyId: "opt-deepseek", status: "error" }],
    searchLabels: new Map([["opt-openai", "openai"], ["opt-deepseek", "deepseek"]]), engineLatency: null
  };

  it("takes nearest-rank percentiles and none of nothing", () => {
    expect(researchPercentiles([300, 100, 200])).toEqual({ p50: 200, p90: 300, max: 300 });
    expect(researchPercentiles([])).toEqual({ p50: null, p90: null, max: null });
  });

  it("splits the run into scoping, plan window, rounds, drafting, each draft's gates and publishing", () => {
    const { phases, wallMinutes } = researchAcceptanceMetrics(input);
    expect(wallMinutes).toBe(21.17);
    expect(phases.scoping).toEqual({ start: 0, end: 60, minutes: 1 });
    expect(phases.planWindow).toEqual({ start: 60, end: 120, minutes: 1 });
    expect(phases.dispatch).toEqual({ start: 120, end: 135, minutes: 0.25 });
    expect(phases.rounds).toEqual([
      { start: 135, end: 900, minutes: 12.75, researchers: 2, parallel: 2, afterDraft: false },
      { start: 930, end: 960, minutes: 0.5, researchers: 1, parallel: 1, afterDraft: false },
      { start: 1110, end: 1150, minutes: 0.67, researchers: 1, parallel: 1, afterDraft: true }
    ]);
    expect(phases.drafting).toEqual({ start: 960, end: 1000, minutes: 0.67 });
    expect(phases.attempts.map(({ attempt, status, gate, sentBack, researchersAfter }) => ({ attempt, status, gate, sentBack, researchersAfter }))).toEqual([
      { attempt: 1, status: "sent_back", gate: "report_check", sentBack: true, researchersAfter: 0 },
      { attempt: 2, status: "sent_back", gate: "verifier", sentBack: true, researchersAfter: 1 },
      { attempt: 3, status: "accepted", gate: null, sentBack: false, researchersAfter: 0 }
    ]);
    expect(phases.attempts[0]!.revision).toEqual({ start: 1001, end: 1060, minutes: 0.98 });
    expect(phases.attempts[1]!.gates).toEqual({ gap_judge: { turns: 1, minutes: 0.15 }, verifier: { turns: 2, minutes: 0.23 }, skeptic: { turns: 0, minutes: null } });
    expect(phases.attempts[2]!.gates).toEqual({ gap_judge: { turns: 0, minutes: null }, verifier: { turns: 1, minutes: 0.07 }, skeptic: { turns: 1, minutes: 0.73 } });
    expect(phases.publish).toEqual({ start: 1260, end: 1270, minutes: 0.17 });
  });

  it("reads each researcher turn's calls, ending and input, with the budget absent where the stand shows none", () => {
    const metrics = researchAcceptanceMetrics(input);
    expect(metrics.researcherTurns.map(({ researcher, turn: ordinal, calls: all, countedCalls, ending, budgetRefusals }) =>
      ({ researcher, turn: ordinal, calls: all, countedCalls, ending, budgetRefusals }))).toEqual([
      { researcher: 1, turn: 1, calls: 5, countedCalls: 3, ending: "time_limit", budgetRefusals: null },
      { researcher: 2, turn: 1, calls: 3, countedCalls: 2, ending: "budget", budgetRefusals: 1 },
      { researcher: 3, turn: 1, calls: 2, countedCalls: 1, ending: "report", budgetRefusals: 0 },
      { researcher: 2, turn: 2, calls: 1, countedCalls: 0, ending: "report", budgetRefusals: null }
    ]);
    expect(metrics.researcherTurns[0]!.input).toEqual({ responses: 10, missing: 0, p50: 500, p90: 900, max: 1_000 });
    expect(metrics.researcherTurns[1]!.input).toEqual({ responses: 2, missing: 1, p50: 5_000, p90: 5_000, max: 5_000 });
    expect(metrics.researcherTurns[2]!.input).toEqual({ responses: 0, missing: 0, p50: null, p90: null, max: null });
    expect(metrics.researchers).toEqual({ researchers: 3, turns: 4, endings: { time_limit: 1, budget: 1, report: 2 }, budgetRefusals: 1,
      input: { responses: 13, missing: 1, p50: 600, p90: 5_000, max: 7_000 } });
    const unbudgeted = researchAcceptanceMetrics({ ...input, calls: calls.map((entry) => ({ ...entry, budgetMarker: false, errorCode: null })) });
    expect(unbudgeted.researchers.budgetRefusals).toBeNull();
    expect(unbudgeted.researcherTurns.every((entry) => entry.budgetRefusals === null)).toBe(true);
  });

  it("counts searches, rows, offers the final draft cites and the verifier's verdicts over every draft", () => {
    const metrics = researchAcceptanceMetrics(input);
    expect(metrics.searches).toEqual({ calls: 4, callSeconds: { p50: 10, p90: 40, max: 40 }, engines: { openai: { rows: 2, errors: 0 }, deepseek: { rows: 2, errors: 1 } },
      latency: null });
    expect(metrics.rows).toBe(2);
    expect(metrics.offers).toEqual({ recorded: 5, live: 4, citedRecords: 3, cited: 2, citedRows: 2 });
    expect(metrics.verifier).toEqual({ turns: 3, claims: 5, supported: 3, partly: 1, unsupported: 1, contradicted: 0, couldNotCheck: 0, supportedShare: 0.6,
      attempts: [{ attempt: 2, claims: 4, supported: 2, partly: 1, unsupported: 1, contradicted: 0, couldNotCheck: 0, supportedShare: 0.5 },
        { attempt: 3, claims: 1, supported: 1, partly: 0, unsupported: 0, contradicted: 0, couldNotCheck: 0, supportedShare: 1 }] });
    const text = JSON.stringify(metrics);
    for (const word of ["brands", "materials", "Nordline", "Велора", "verifier-2", "row-a", "example.test"]) expect(text).not.toContain(word);
  });

  it("reads candidate notes as absent without the feature, and as noted, made rows, set aside and open with it", () => {
    expect(researchAcceptanceMetrics(input).candidateNotes).toBeNull();
    expect(researchAcceptanceMetrics({ ...input, frame: null })).toMatchObject({ rows: null, candidateNotes: null, phases: { planWindow: null } });
    const noted = researchAcceptanceMetrics({ ...input, frame: { ...input.frame!, frame: { rows,
      candidates: [{ key: "synthetic-optima", label: "Synthetic Optima" }, { key: "deep-rest", label: "Nordline Deep Rest Medium S2000" }, { key: "kalmo", label: "Kalmo" }],
      setAside: [{ key: "kalmo", reason: "out of budget" }] } } });
    expect(noted.candidateNotes).toEqual({ noted: 3, madeRows: 1, setAside: 1, open: 1, noteCalls: 0, setAsideCalls: 0 });
    const called = researchAcceptanceMetrics({ ...input, calls: [...calls, call("n1", "change_research_frame", 300, 300.1, { ...inTurn("ta", "A1"), frameChange: "note_candidate" })] });
    expect(called.candidateNotes).toEqual({ noted: 0, madeRows: 0, setAside: 0, open: 0, noteCalls: 1, setAsideCalls: 0 });
  });

  it("measures each source's latency from the app's log lines of these runs only", () => {
    const latency = researchEngineLatency(new Set(["run-main"]), ["openai", "perplexity", "deepseek"]);
    const line = (fields: Record<string, unknown>) => JSON.stringify({ event: "tool_execution", tool_kind: "search", stage: "execution", run_id: "run-main", ...fields });
    for (const entry of [
      `app-1  | ${line({ engine_index: 1, outcome: "completed", duration_ms: 21_000 })}`, line({ engine_index: 1, outcome: "completed", duration_ms: 32_000 }),
      line({ engine_index: 2, outcome: "failed", code: "timeout" }), line({ engine_index: 3, outcome: "completed", duration_ms: 800 }),
      line({ engine_index: 3, outcome: "started" }), line({ engine_index: 3, outcome: "completed", duration_ms: 900, run_id: "another-run" }),
      line({ engine_index: 3, outcome: "completed", duration_ms: 900, stage: "result" }), line({ engine_index: 4, outcome: "completed", duration_ms: 5 }),
      "not json", "{broken", ""
    ]) latency.add(entry);
    expect(latency.result()).toEqual({
      deepseek: { completed: 1, failed: 0, p50Ms: 800, p90Ms: 800, maxMs: 800 }, engine_4: { completed: 1, failed: 0, p50Ms: 5, p90Ms: 5, maxMs: 5 },
      openai: { completed: 2, failed: 0, p50Ms: 21_000, p90Ms: 32_000, maxMs: 32_000 }, perplexity: { completed: 0, failed: 1, p50Ms: null, p90Ms: null, maxMs: null }
    });
  });

  it("checks expectations against the metrics, the rows' names and the answer", () => {
    const metrics = researchAcceptanceMetrics(input);
    const observed = researchAcceptanceObserved(metrics, input.frame!.frame, "We pick Velora Balance Forma.");
    expect(observed).toMatchObject({ candidates: 2, offers: 2, supportedShare: 0.6, minutes: 21.17 });
    const results = researchExpectationResults({ names: ["Nordline DeepRest Medium S2000", "Velora Balance Forma"], namesIn: "rows", minCandidates: 5, minOffers: 2 }, observed);
    expect(results).toMatchObject({ namesFound: { expected: 2, value: 2, pass: true }, minCandidates: { expected: 5, value: 2, pass: false },
      minOffers: { expected: 2, value: 2, pass: true }, passed: false });
  });
});

describe("question set fixture directory", () => {
  it("reads a nested directory only at its top level", () => {
    const directory = scratch();
    mkdirSync(join(directory, "nested.txt"));
    file(directory, "one.txt", "q");
    expect(() => readResearchQuestionSet(directory)).toThrow("research_question_set_file_invalid");
  });
});
